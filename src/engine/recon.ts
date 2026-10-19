// Reconciliations: headcount by pay run, and employee-level comparison to the legacy
// Rippling register (both US pay groups, Module 2 decision 2.1).

import type { Model, RegisterRow } from './types.ts';
import type { IntlResult } from './intl.ts';
import { round2 } from './dates.ts';

export interface LegacyDiff { code: string; ours: number; legacy: number; diff: number }
export interface LegacyWorker {
  workerId: string; payGroup: string; oursGross: number; legacyGross: number; oursNet: number;
  legacyNet: number; diffs: LegacyDiff[]; cls: string; rootCause: string; disposition: string;
  explained: boolean; inOurs: boolean; inLegacy: boolean;
}
export interface LegacyRecon {
  available: boolean;
  workers: LegacyWorker[];
  byClass: { cls: string; workers: number; netImpact: number }[];
  totals: { payGroup: string; oursGross: number; legacyGross: number; oursNet: number; legacyNet: number; oursEr: number; legacyEr: number }[];
  headcount: { payGroup: string; oursPaid: number; legacyPaid: number; onlyOurs: string[]; onlyLegacy: string[] }[];
  matched: number;
}

const SUMMARY_CODES = new Set(['NET_PAY']);

export function reconcileLegacy(model: Model, register: RegisterRow[]): LegacyRecon {
  const legacyRows = model.raw.legacy_register;
  if (!legacyRows.length) return { available: false, workers: [], byClass: [], totals: [], headcount: [], matched: 0 };
  const notes = model.raw.legacy_variance_notes;
  const legacy = new Map<string, Map<string, number>>();
  const legacyGroup = new Map<string, string>();
  for (const r of legacyRows) {
    const m = legacy.get(r.worker_id) ?? new Map<string, number>();
    m.set(r.code, round2((m.get(r.code) ?? 0) + Number(r.amount || 0)));
    legacy.set(r.worker_id, m);
    legacyGroup.set(r.worker_id, r.pay_group);
  }
  const ours = new Map<string, RegisterRow>();
  for (const r of register) if (r.bucket !== 'Excluded') ours.set(r.workerId, r);
  const ids = [...new Set([...ours.keys(), ...legacy.keys()])].sort();
  const workers: LegacyWorker[] = [];
  let matched = 0;
  const cat = (code: string) => model.payCodes.get(code)?.category ?? '';
  for (const id of ids) {
    const o = ours.get(id);
    const l = legacy.get(id) ?? new Map<string, number>();
    const oMap = new Map<string, number>();
    for (const line of o?.lines ?? []) {
      if (line.code === 'PTO_FLEX' || line.code === 'BEN_ARR_NEW') continue;
      oMap.set(line.code, round2((oMap.get(line.code) ?? 0) + line.amount));
    }
    const codes = [...new Set([...oMap.keys(), ...l.keys()])];
    const diffs: LegacyDiff[] = [];
    for (const c of codes) {
      const a = oMap.get(c) ?? 0; const b = l.get(c) ?? 0;
      if (Math.abs(a - b) > 0.01) diffs.push({ code: c, ours: a, legacy: b, diff: round2(b - a) });
    }
    const sumCat = (m: Map<string, number>, k: string) => round2([...m.entries()].filter(([c]) => cat(c) === k).reduce((s, [, v]) => s + v, 0));
    const lg = sumCat(l, 'Earning');
    const og = o?.gross ?? 0;
    const ln = l.get('NET_PAY') ?? 0;
    const on = o?.net ?? 0;
    if (!diffs.length) { matched++; continue; }
    const note = notes.find(n => n.worker_id === id);
    workers.push({
      workerId: id, payGroup: o?.payGroup ?? legacyGroup.get(id) ?? '', oursGross: og, legacyGross: lg,
      oursNet: on, legacyNet: ln, diffs: diffs.sort((a, b) => (SUMMARY_CODES.has(a.code) ? 1 : 0) - (SUMMARY_CODES.has(b.code) ? 1 : 0)),
      cls: note?.class ?? 'Unexplained', rootCause: note?.root_cause ?? 'Not yet investigated',
      disposition: note?.disposition ?? 'Investigate', explained: !!note, inOurs: !!o, inLegacy: legacy.has(id),
    });
  }
  const classes = ['Legacy error', 'Configuration difference', 'Timing', 'Data', 'Unexplained'];
  const byClass = classes.map(cls => {
    const ws = workers.filter(w => w.cls === cls);
    return { cls, workers: ws.length, netImpact: round2(ws.reduce((s, w) => s + (w.legacyNet - w.oursNet), 0)) };
  }).filter(c => c.workers > 0 || c.cls !== 'Unexplained');
  const totals = ['US Semi-monthly', 'US Biweekly'].map(pg => {
    const rs = register.filter(r => r.payGroup === pg);
    const lids = [...legacy.keys()].filter(id => legacyGroup.get(id) === pg);
    const lsum = (k: string) => round2(lids.reduce((s, id) => s + sumCatG(legacy.get(id)!, k), 0));
    function sumCatG(m: Map<string, number>, k: string) { return [...m.entries()].filter(([c]) => cat(c) === k).reduce((s, [, v]) => s + v, 0); }
    return {
      payGroup: pg, oursGross: round2(rs.reduce((s, r) => s + r.gross, 0)), legacyGross: lsum('Earning'),
      oursNet: round2(rs.reduce((s, r) => s + r.net, 0)), legacyNet: round2(lids.reduce((s, id) => s + (legacy.get(id)!.get('NET_PAY') ?? 0), 0)),
      oursEr: round2(rs.reduce((s, r) => s + r.erCost, 0)), legacyEr: lsum('ER Cost'),
    };
  });
  const headcount = ['US Semi-monthly', 'US Biweekly'].map(pg => {
    const op = register.filter(r => r.payGroup === pg && r.gross > 0).map(r => r.workerId);
    const lp = [...legacy.keys()].filter(id => legacyGroup.get(id) === pg && [...legacy.get(id)!.entries()].filter(([c]) => cat(c) === 'Earning').reduce((s, [, v]) => s + v, 0) > 0.004);
    return { payGroup: pg, oursPaid: op.length, legacyPaid: lp.length, onlyOurs: op.filter(x => !lp.includes(x)), onlyLegacy: lp.filter(x => !op.includes(x)) };
  });
  return { available: true, workers, byClass, totals, headcount, matched };
}

export interface HeadcountRun {
  payGroup: string; country: string; workerFile: number; buckets: { bucket: string; count: number; workers: { id: string; reason: string }[] }[];
  special: { tag: string; count: number; workers: string[] }[]; payDate: string; period: string;
}

export function headcount(model: Model, register: RegisterRow[], intl: IntlResult): HeadcountRun[] {
  const runs: HeadcountRun[] = [];
  const order = ['Paid full period', 'Paid prorated', 'Active, not paid', 'Excluded'];
  for (const [pg, ps] of model.schedules) {
    const inFile = model.workers.filter(w => w.payGroup === pg && w.workerType === 'Employee');
    const rows: { id: string; bucket: string; reason: string; tags: string[] }[] =
      pg.startsWith('US')
        ? register.filter(r => r.payGroup === pg).map(r => ({ id: r.workerId, bucket: r.bucket, reason: r.bucketReason, tags: r.tags }))
        : intl.expected.filter(e => e.payGroup === pg).map(e => ({ id: e.workerId, bucket: e.bucket, reason: e.bucketReason, tags: e.tags }));
    const buckets = order.map(b => ({ bucket: b, count: rows.filter(r => r.bucket === b).length, workers: rows.filter(r => r.bucket === b).map(r => ({ id: r.id, reason: r.reason })) })).filter(b => b.count > 0 || b.bucket !== 'Excluded');
    const tagMap = new Map<string, string[]>();
    for (const r of rows) for (const t of r.tags) {
      const key = t.replace(/ \d{4}-\d{2}-\d{2}.*$/, '').replace(/^Pay input: (\S+) (starts|stops).*/, 'Pay input: deduction $2');
      tagMap.set(key, [...(tagMap.get(key) ?? []), r.id]);
    }
    const special = [...tagMap.entries()].map(([tag, ws]) => ({ tag, count: new Set(ws).size, workers: [...new Set(ws)] })).sort((a, b) => a.tag.localeCompare(b.tag));
    runs.push({ payGroup: pg, country: ps.country, workerFile: inFile.length, buckets, special, payDate: ps.payDate, period: `${ps.start} to ${ps.end}` });
  }
  return runs;
}
