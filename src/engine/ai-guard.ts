// Guardrails for the AI commentary on the pre-payroll audit (requirement 9).
//
// 1. Allow-list: the payload is BUILT field by field from a fixed schema (check, rule, severity,
//    pay group, amounts, headcount counts). Nothing else from the worker record can reach it:
//    no names, dates of birth, addresses, bank or tax IDs, and no free text.
// 2. Pseudonymize: worker IDs are replaced with tokens (W001, W002…) before sending; the map
//    stays in the browser, and the reply is re-identified locally.
// 3. Verify: every worker token and every number in the reply must exist in the payload.
//    Anything else is flagged "unverified" and the commentary is not presented as final.
// The model never changes amounts or clears findings; a person does.

import type { AuditResult } from './audit.ts';
import { CHECKS } from './audit.ts';

export interface AiFinding { ref: string; check: string; rule: string; severity: string; worker: string; payGroup: string; current: number | null; prior: number | null }
export interface AiHeadcount {
  payGroup: string; opening: number; hires: number; transfersIn: number; returns: number; terms: number; transfersOut: number;
  current: number; unpaidLeave: number; noTime: number; expectedPaid: number; registerPaid: number; ties: boolean;
  watch: { item: string; count: number }[];
}
export interface AiPayload {
  period: string;
  headcount: AiHeadcount[];
  findings: AiFinding[];
  parallel: { cls: string; workers: number }[];
}
export interface Pseudonyms { toToken: Map<string, string>; toId: Map<string, string> }

/** Fields allowed in the payload, checked again on the server. */
export const ALLOWED = {
  top: ['period', 'headcount', 'findings', 'parallel'],
  finding: ['ref', 'check', 'rule', 'severity', 'worker', 'payGroup', 'current', 'prior'],
};

export function buildPayload(audit: AuditResult, parallel: { cls: string; workers: number }[], period: string): { payload: AiPayload; map: Pseudonyms } {
  const toToken = new Map<string, string>(); const toId = new Map<string, string>();
  const token = (id: string) => {
    if (!toToken.has(id)) { const t = `W${String(toToken.size + 1).padStart(3, '0')}`; toToken.set(id, t); toId.set(t, id); }
    return toToken.get(id)!;
  };
  const count = (rf: AuditResult['rollForward'][number], key: string) => rf.lines.find(l => l.key === key)?.count ?? 0;
  const headcount: AiHeadcount[] = audit.rollForward.map(rf => ({
    payGroup: rf.payGroup, opening: count(rf, 'opening'), hires: count(rf, 'hires'), transfersIn: count(rf, 'xfer-in'), returns: count(rf, 'returns'),
    terms: count(rf, 'terms'), transfersOut: count(rf, 'xfer-out'), current: count(rf, 'current'), unpaidLeave: count(rf, 'unpaid-leave'),
    noTime: count(rf, 'no-time'), expectedPaid: rf.expectedPaid, registerPaid: rf.registerPaid, ties: rf.ties,
    watch: rf.watch.map(w => ({ item: w.label, count: w.count })),
  }));
  const findings: AiFinding[] = audit.findings.map(f => ({
    ref: f.id, check: f.check, rule: CHECKS[f.check] ?? f.check, severity: f.severity, worker: token(f.workerId), payGroup: f.payGroup,
    current: f.current, prior: f.prior,
  }));
  return { payload: { period, headcount, findings, parallel: parallel.map(p => ({ cls: p.cls, workers: p.workers })) }, map: { toToken, toId } };
}

/** Replace tokens in the reply with the real worker IDs (done in the browser only). */
export function reidentify(text: string, map: Pseudonyms): string {
  return text.replace(/\bW\d{3}\b/g, t => map.toId.get(t) ?? t);
}

export interface Verification {
  status: 'verified' | 'unverified';
  tokens: { known: string[]; unknown: string[] };
  realIds: string[];
  numbers: { verified: number; unverified: string[] };
}

/** Every worker token and number in the reply must come from the payload. */
export function verify(text: string, payload: AiPayload): Verification {
  const known = new Set(payload.findings.map(f => f.worker));
  const tokens = [...new Set(text.match(/\bW\d{3}\b/g) ?? [])];
  const realIds = [...new Set(text.match(/\bE\d{4}\b/g) ?? [])];
  // Allowed numbers: anything in the payload, plus counts a reader would expect (findings by
  // check, severity and pay group; workers with findings).
  const allowed = new Set<number>();
  const add = (v: number | null | undefined) => { if (typeof v === 'number' && Number.isFinite(v)) { allowed.add(Math.round(v * 100) / 100); allowed.add(Math.round(v)); allowed.add(Math.abs(Math.round(v * 100) / 100)); } };
  for (const m of JSON.stringify(payload).match(/-?\d+(\.\d+)?/g) ?? []) add(Number(m));
  const F = payload.findings;
  add(F.length); add(new Set(F.map(f => f.worker)).size);
  for (const k of new Set(F.map(f => f.check))) add(F.filter(f => f.check === k).length);
  for (const k of ['High', 'Medium', 'Low']) add(F.filter(f => f.severity === k).length);
  for (const k of new Set(F.map(f => f.payGroup))) add(F.filter(f => f.payGroup === k).length);
  // Numbers in the reply, ignoring digits inside codes and tokens (A11, W003, F012, 401(k)).
  const found = [...text.matchAll(/(?<![A-Za-z0-9.])\$?-?\d[\d,]*(\.\d+)?%?(?![A-Za-z0-9(])/g)].map(m => m[0]);
  const unverified: string[] = [];
  let ok = 0;
  for (const raw of found) {
    const v = Number(raw.replace(/[$,%]/g, ''));
    if (!Number.isFinite(v)) continue;
    if (allowed.has(Math.round(v * 100) / 100) || allowed.has(Math.abs(v))) ok++;
    else unverified.push(raw);
  }
  const unknown = tokens.filter(t => !known.has(t));
  return {
    status: unknown.length || realIds.length || unverified.length ? 'unverified' : 'verified',
    tokens: { known: tokens.filter(t => known.has(t)), unknown }, realIds, numbers: { verified: ok, unverified: [...new Set(unverified)] },
  };
}

/** Deterministic commentary written ONLY from the payload (used when no API key is set). */
export function templateFromPayload(p: AiPayload): string {
  const by = (c: string) => p.findings.filter(f => f.check === c);
  const ids = (c: string) => [...new Set(by(c).map(f => f.worker))].join(', ');
  const high = p.findings.filter(f => f.severity === 'High');
  const out: string[] = [`Pre-payroll audit, US pay runs, ${p.period}.`, ''];
  out.push('Headcount:');
  for (const h of p.headcount) {
    out.push(`• ${h.payGroup}: ${h.opening} on last period's run, +${h.hires} new hires, +${h.transfersIn} transfers in, -${h.terms} terms, -${h.transfersOut} transfers out = ${h.current} on this run. Less ${h.unpaidLeave} on unpaid leave and ${h.noTime} with no time = ${h.expectedPaid} to be paid; register shows ${h.registerPaid} paid${h.ties ? ' (ties)' : ' (DOES NOT TIE)'}.`);
  }
  out.push('', `Findings: ${p.findings.length}, of which ${high.length} high.`, '', 'Action before approval:');
  if (by('A15').length) out.push(`• CA final pay due before the pay date: ${ids('A15')}. Issue off-cycle final checks.`);
  if (by('A11').length) out.push(`• No time entered (check A11): ${by('A11').length} non-exempt workers (${ids('A11')}), including any paid only a final payout. Managers to confirm before time locks.`);
  if (by('A08').length) out.push(`• State change: ${ids('A08')}. Confirm state registrations and the wage split.`);
  if (by('A02').length) out.push(`• Paid last period, nothing now: ${ids('A02')}. Confirm leave or termination with HR.`);
  out.push('', 'Expected movements:');
  out.push(`• ${by('A01').length} first-time payees; ${by('A03').length} gross changes over the threshold; ${by('A05').length} workers with new earning types.`);
  if (p.parallel.length) out.push('', `Parallel vs Rippling: ${p.parallel.map(c => `${c.cls} ${c.workers}`).join(', ')}.`);
  return out.join('\n');
}
