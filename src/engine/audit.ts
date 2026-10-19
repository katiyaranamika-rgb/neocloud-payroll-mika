// Pre-payroll audit (Module 9): deterministic checks comparing the current US run with the
// prior-period register, plus time, absence and deduction exceptions. Each finding carries a
// templated plain-English explanation. The optional AI step (api/explain.js) rewrites the
// findings into Controller commentary; it never changes amounts or clears findings.

import type { Model, RegisterRow, TimeResult, AbsenceRow } from './types.ts';
import { round2 } from './dates.ts';

export interface Finding {
  id: string; check: string; severity: 'High' | 'Medium' | 'Low'; workerId: string; payGroup: string;
  title: string; detail: string; explanation: string; current: number | null; prior: number | null;
}
export interface AuditResult {
  findings: Finding[]; checks: { check: string; name: string; count: number }[];
  priorAvailable: boolean; summary: string; rollForward: RollForward[];
}

/** One line of the headcount roll-forward, with the workers behind it and why. */
export interface RollLine { key: string; label: string; sign: '' | '+' | '-' | '='; count: number; workers: { id: string; reason: string }[] }
/** Headcount roll-forward for one pay run: last period's pay run → this pay run → who gets paid. */
export interface RollForward {
  payGroup: string; periodStart: string; periodEnd: string; priorStart: string; priorEnd: string;
  lines: RollLine[]; watch: RollLine[]; expectedPaid: number; registerPaid: number; ties: boolean;
}

/**
 * Headcount roll-forward per US pay run. Opening = workers on last period's pay run; then joiners
 * (new hires, transfers in from another pay group, returns) and leavers (terminated before this
 * period, transfers out) give this period's pay run; less active workers who will not be paid
 * (unpaid leave for the whole period, no time entered) gives the count to be paid, which must
 * equal the paid count on the register. A watch list shows who is paid but needs a look
 * (prorated, final pay, state or location change), without changing the count.
 */
export function headcountRollForward(model: Model, register: RegisterRow[]): RollForward[] {
  const priorPg = new Map<string, string>();
  const priorDates = new Map<string, [string, string]>();
  for (const r of model.raw.prior_register) {
    priorPg.set(r.worker_id, r.pay_group);
    if (!priorDates.has(r.pay_group)) priorDates.set(r.pay_group, [r.period_start, r.period_end]);
  }
  const out: RollForward[] = [];
  for (const pg of ['US Semi-monthly', 'US Biweekly']) {
    const ps = model.schedules.get(pg);
    if (!ps) continue;
    const [pStart, pEnd] = priorDates.get(pg) ?? ['', ''];
    const cur = register.filter(r => r.payGroup === pg && r.bucket !== 'Excluded');
    const curIds = new Set(cur.map(r => r.workerId));
    const opening = [...priorPg].filter(([, g]) => g === pg).map(([id]) => id);
    const openSet = new Set(opening);
    const w = (id: string) => model.workerById.get(id)!;
    const joiners = cur.filter(r => !openSet.has(r.workerId));
    const hires = joiners.filter(r => w(r.workerId).hireDate > pEnd);
    const transfersIn = joiners.filter(r => !hires.includes(r) && priorPg.has(r.workerId) && priorPg.get(r.workerId) !== pg);
    const returns = joiners.filter(r => !hires.includes(r) && !transfersIn.includes(r));
    const leavers = opening.filter(id => !curIds.has(id));
    const terms = leavers.filter(id => { const t = w(id)?.termDate; return !!t && t < ps.start; });
    const transfersOut = leavers.filter(id => !terms.includes(id) && w(id) && w(id).payGroup !== pg);
    const otherOut = leavers.filter(id => !terms.includes(id) && !transfersOut.includes(id));
    const notPaid = cur.filter(r => r.gross <= 0);
    const leave = notPaid.filter(r => /unpaid leave/i.test(r.bucketReason));
    const noTime = notPaid.filter(r => !leave.includes(r));
    const line = (key: string, label: string, sign: RollLine['sign'], ws: { id: string; reason: string }[]): RollLine => ({ key, label, sign, count: ws.length, workers: ws });
    const n = (count: number, key: string, label: string, sign: RollLine['sign']): RollLine => ({ key, label, sign, count, workers: [] });
    const current = opening.length + hires.length + transfersIn.length + returns.length - terms.length - transfersOut.length - otherOut.length;
    const lines: RollLine[] = [
      n(opening.length, 'opening', `Headcount on last period's pay run (${pStart} to ${pEnd})`, ''),
      line('hires', 'New hires', '+', hires.map(r => ({ id: r.workerId, reason: `Hired ${w(r.workerId).hireDate}` }))),
      line('xfer-in', 'Transfers in from another pay group', '+', transfersIn.map(r => ({ id: r.workerId, reason: `From ${priorPg.get(r.workerId)}` }))),
      line('returns', 'Returns and rehires', '+', returns.map(r => ({ id: r.workerId, reason: 'Not on last pay run; employed before it' }))),
      line('terms', 'Terminated before this period', '-', terms.map(id => ({ id, reason: `Terminated ${w(id).termDate}` }))),
      line('xfer-out', 'Transfers out to another pay group', '-', transfersOut.map(id => ({ id, reason: `To ${w(id).payGroup}` }))),
      ...(otherOut.length ? [line('other-out', 'Other leavers', '-', otherOut.map(id => ({ id, reason: 'On last pay run, not on this one' })))] : []),
      n(current, 'current', `Headcount on this pay run (${ps.start} to ${ps.end})`, '='),
      line('unpaid-leave', 'Active, on unpaid leave for the whole period', '-', leave.map(r => ({ id: r.workerId, reason: r.bucketReason }))),
      line('no-time', 'Active, no time entered (non-exempt)', '-', noTime.map(r => ({ id: r.workerId, reason: r.bucketReason || 'No time entered' }))),
      n(current - leave.length - noTime.length, 'to-pay', 'Expected to be paid on this run', '='),
    ];
    const moved = (id: string) => model.events.find(e => e.workerId === id && e.type === 'Location Change' && e.start >= ps.start && e.start <= ps.end);
    const watch: RollLine[] = [
      line('w-hire', 'New hires paid prorated', '', hires.filter(r => r.gross > 0).map(r => ({ id: r.workerId, reason: r.bucketReason }))),
      line('w-term', 'Terminating this period: final pay, off the next run', '', cur.filter(r => { const t = w(r.workerId).termDate; return !!t && t >= ps.start && t <= ps.end; }).map(r => ({ id: r.workerId, reason: r.bucketReason || `Terminates ${w(r.workerId).termDate}` }))),
      line('w-leave', 'Unpaid leave for part of the period (prorated)', '', cur.filter(r => r.gross > 0 && /unpaid leave/i.test(r.bucketReason)).map(r => ({ id: r.workerId, reason: r.bucketReason }))),
      line('w-move', 'Location or state transfer within the pay group', '', cur.filter(r => moved(r.workerId)).map(r => { const e = moved(r.workerId)!; return { id: r.workerId, reason: `${e.oldValue} → ${e.newValue} from ${e.start}` }; })),
    ].filter(l => l.count > 0);
    const registerPaid = cur.filter(r => r.gross > 0).length;
    const expectedPaid = current - leave.length - noTime.length;
    out.push({ payGroup: pg, periodStart: ps.start, periodEnd: ps.end, priorStart: pStart, priorEnd: pEnd, lines, watch, expectedPaid, registerPaid, ties: expectedPaid === registerPaid && current === cur.length });
  }
  return out;
}

export const CHECKS: Record<string, string> = {
  A01: 'Paid now, not paid last period',
  A02: 'Paid last period, $0 now',
  A03: 'Gross pay change > 10% and > $250',
  A04: 'Net pay change > 10% and > $250',
  A05: 'New earning types this period',
  A06: 'Deduction changes (401(k), benefits)',
  A07: 'Garnishment taken or capped',
  A08: 'State tax change vs prior period',
  A09: 'Benefit arrears created',
  A10: 'Time entry exceptions',
  A11: 'Non-exempt worker with no time',
  A12: 'Social Security wage base reached',
  A13: 'Leave request exceeds balance',
  A14: 'Overtime + double time > 10 hours',
  A15: 'CA final pay timing risk',
  A16: 'Net pay below 20% of gross',
};

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function runAudit(model: Model, register: RegisterRow[], time: Map<string, TimeResult>, absence: AbsenceRow[]): AuditResult {
  const prior = new Map<string, Map<string, number>>();
  for (const r of model.raw.prior_register) {
    const m = prior.get(r.worker_id) ?? new Map<string, number>();
    m.set(r.code, round2((m.get(r.code) ?? 0) + Number(r.amount || 0)));
    prior.set(r.worker_id, m);
  }
  const cat = (c: string) => model.payCodes.get(c)?.category ?? '';
  const findings: Finding[] = [];
  let seq = 0;
  const add = (check: string, severity: Finding['severity'], r: RegisterRow | { workerId: string; payGroup: string }, title: string, detail: string, explanation: string, current: number | null = null, priorV: number | null = null) => {
    findings.push({ id: `F${String(++seq).padStart(3, '0')}`, check, severity, workerId: r.workerId, payGroup: r.payGroup, title, detail, explanation, current, prior: priorV });
  };

  for (const r of register) {
    if (r.bucket === 'Excluded') continue;
    const p = prior.get(r.workerId);
    const pGross = p ? round2([...p.entries()].filter(([c]) => cat(c) === 'Earning').reduce((s, [, v]) => s + v, 0)) : 0;
    const pNet = p?.get('NET_PAY') ?? 0;
    const w = model.workerById.get(r.workerId)!;
    const ps = model.schedules.get(r.payGroup)!;

    if (r.gross > 0 && (!p || pGross <= 0)) {
      add('A01', 'Medium', r, 'First pay this period', `Gross ${money(r.gross)}; no pay last period`, w.hireDate >= '2026-10-01' ? `New hire on ${w.hireDate}; first paycheck${r.lines.some(l => l.code === 'BON_SIGN') ? ' includes a sign-on bonus' : ''}. Confirm I-9/W-4 and direct deposit are complete.` : 'Worker returns to pay after a period with no pay. Confirm return-to-work and any arrears to collect.', r.gross, pGross);
    }
    if (r.gross <= 0 && pGross > 0) {
      add('A02', 'High', r, 'Paid last period, $0 now', `Prior gross ${money(pGross)}; current ${r.bucketReason}`, `${r.bucketReason}. Confirm with HR/manager before approving a $0 check.`, 0, pGross);
    }
    if (p && pGross > 0 && r.gross > 0) {
      const g = r.gross - pGross;
      if (Math.abs(g) > 250 && Math.abs(g) / pGross > 0.1) {
        const drivers = r.lines.filter(l => cat(l.code) === 'Earning' && Math.abs(l.amount - (p.get(l.code) ?? 0)) > 50).map(l => `${l.code} ${money(l.amount - (p.get(l.code) ?? 0))}`);
        add('A03', Math.abs(g) / pGross > 0.5 ? 'High' : 'Medium', r, `Gross ${g > 0 ? 'up' : 'down'} ${Math.round((Math.abs(g) / pGross) * 100)}%`, `${money(pGross)} → ${money(r.gross)}; drivers: ${drivers.join(', ') || 'mix of earnings'}`, `Change is explained by ${drivers.length ? drivers.map(d => d.split(' ')[0]).join(', ') : 'earnings mix'}${r.bucketReason ? ` (${r.bucketReason})` : ''}.`, r.gross, pGross);
      }
      const nd = r.net - pNet;
      if (pNet > 0 && Math.abs(nd) > 250 && Math.abs(nd) / pNet > 0.1) {
        add('A04', 'Low', r, `Net ${nd > 0 ? 'up' : 'down'} ${Math.round((Math.abs(nd) / pNet) * 100)}%`, `${money(pNet)} → ${money(r.net)}`, 'Net movement follows the gross change and any deduction or garnishment changes listed for this worker.', r.net, pNet);
      }
      const newCodes = r.lines.filter(l => cat(l.code) === 'Earning' && l.code !== 'PTO_FLEX' && l.amount !== 0 && !p.has(l.code)).map(l => l.code);
      if (newCodes.length) add('A05', newCodes.some(c => ['VAC_PAYOUT', 'RETRO_SAL', 'RETRO_HRS', 'BON_SIGN'].includes(c)) ? 'Medium' : 'Low', r, 'New earning types', newCodes.join(', '), `New this period: ${newCodes.map(c => model.payCodes.get(c)?.name ?? c).join(', ')}. Verify supporting approval (one-time payment, time approval or retro request).`);
      const ded = (m: Map<string, number> | undefined, codes: string[]) => round2(codes.reduce((s, c) => s + (m?.get(c) ?? 0), 0));
      const curMap = new Map(r.lines.map(l => [l.code, l.amount]));
      const benNow = ded(curMap, ['MED_EE', 'DEN_EE', 'VIS_EE']); const benPrior = ded(p, ['MED_EE', 'DEN_EE', 'VIS_EE']);
      const kNow = r.gross > 0 ? (curMap.get('401K_EE') ?? 0) / r.gross : 0;
      const kPrior = pGross > 0 ? (p.get('401K_EE') ?? 0) / pGross : 0;
      if (Math.abs(benNow - benPrior) > 0.01 || Math.abs(kNow - kPrior) > 0.0051) {
        add('A06', 'Medium', r, 'Deduction change', `Benefits ${money(benPrior)} → ${money(benNow)}; 401(k) ${(kPrior * 100).toFixed(1)}% → ${(kNow * 100).toFixed(1)}%`, 'Deduction elections changed or could not be fully taken. Check the payroll inputs effective dates and any arrears.');
      }
      const sitNow = [...curMap.keys()].filter(c => c.startsWith('SIT_')).sort().join(',');
      const sitPrior = [...p.keys()].filter(c => c.startsWith('SIT_')).sort().join(',');
      if (sitNow !== sitPrior || Object.keys(r.states).length > 1) add('A08', 'High', r, 'State tax change', `${sitPrior || 'no SIT'} → ${sitNow || 'no SIT'}`, `Work state changed (${Object.keys(r.states).join(' → ')}). Wages are split by working days in each state; confirm state registrations and SUI account.`);
    }
    for (const g of r.lines.filter(l => l.code.startsWith('GARN_'))) {
      add('A07', /capped/.test(g.detail ?? '') ? 'High' : 'Low', r, `${g.code === 'GARN_CS' ? 'Child support' : 'Creditor garnishment'} ${money(g.amount)}`, g.detail ?? '', /capped/.test(g.detail ?? '') ? 'Order amount exceeds the legal limit of disposable earnings; withholding was capped. Notify the agency of the shortfall.' : `Withheld within limits${w.termDate && w.termDate <= ps.end ? '; worker terminates this period — send termination notice to the issuing agency' : ''}.`, g.amount);
    }
    if (r.arrearsCreated > 0) add('A09', 'Medium', r, `Benefit arrears ${money(r.arrearsCreated)}`, r.bucketReason || 'Pay did not cover benefit deductions', 'Benefits stay active; the uncollected amount is booked as an employee receivable and collected on return.', r.arrearsCreated);
    if (r.tags.includes('Social Security wage base reached this period')) add('A12', 'Low', r, 'Social Security wage base reached', `YTD FICA wages before this period ${money(r.ytdPriorFica)}`, 'OASDI stops at the $168,600 wage base this period; Medicare continues.');
    const otH = r.lines.filter(l => ['OT_15', 'DT_20', 'SVD_15', 'SVD_20'].includes(l.code)).reduce((s, l) => s + (l.hours ?? 0), 0);
    if (otH > 10) add('A14', 'Low', r, `${otH.toFixed(1)} premium hours`, r.lines.filter(l => ['OT_15', 'DT_20', 'SVD_15', 'SVD_20'].includes(l.code)).map(l => `${l.code} ${(l.hours ?? 0).toFixed(2)}h`).join(', '), 'High premium hours; confirm manager approval of overtime and the schedule.');
    if (w.state === 'CA' && w.termDate && w.termDate >= ps.start && w.termDate <= ps.end && w.termDate < ps.payDate) {
      add('A15', 'High', r, 'CA final pay due on last day', `Terminated ${w.termDate}; regular pay date ${ps.payDate}`, 'California requires final wages on the last day for involuntary terms (72 hours for resignations without notice). Issue an off-cycle final check to avoid waiting-time penalties.');
    }
    if (r.gross > 0 && r.net < 0.2 * r.gross) add('A16', 'Medium', r, 'Net below 20% of gross', `${money(r.net)} of ${money(r.gross)}`, 'Large deductions relative to pay (garnishment, arrears or leave proration). Confirm before release.', r.net, r.gross);
  }
  for (const [id, t] of time) {
    const r = register.find(x => x.workerId === id);
    const base = { workerId: id, payGroup: 'US Biweekly' };
    for (const i of t.issues) {
      if (['TIME_AFTER_TERM', 'DUPLICATE_PUNCH', 'OFF_SCHEDULE', 'MEAL_ATTESTATION_MISSING', 'MISSING_PUNCH', 'MEAL_EXCEPTION_NONCA'].includes(i.code)) {
        add('A10', i.code === 'TIME_AFTER_TERM' ? 'High' : i.code === 'MEAL_EXCEPTION_NONCA' ? 'Low' : 'Medium', base, i.code.replace(/_/g, ' ').toLowerCase(), i.message,
          i.code === 'TIME_AFTER_TERM' ? 'Time posted after the termination date does not flow to payroll. HR to confirm the last day worked.' :
          i.code === 'DUPLICATE_PUNCH' ? 'Identical punch removed so hours are not paid twice. Add a duplicate-punch validation to the time entry template.' :
          i.code === 'MEAL_EXCEPTION_NONCA' ? 'Outside California there is no meal penalty; flagged for policy follow-up only.' :
          'Review with the manager before time locks on Tuesday 10:00.');
      }
    }
    if (r && r.issues.some(i => i.code === 'NO_TIME')) add('A11', 'High', base, 'No time entered', `${model.workerById.get(id)?.status}; paid $0`, 'Active non-exempt worker with no hours this period. Manager to confirm whether time is missing or the worker did not work.');
  }
  for (const a of absence) {
    if (a.flags.some(f => /exceeds available/.test(f))) {
      const w = model.workerById.get(a.workerId)!;
      add('A13', 'Medium', { workerId: a.workerId, payGroup: w.payGroup }, `${a.plan} request exceeds balance`, a.flags.join('; '), 'Usage was capped at the available balance; remaining hours are unpaid unless another plan applies.');
    }
  }
  const checks = Object.entries(CHECKS).map(([check, name]) => ({ check, name, count: findings.filter(f => f.check === check).length }));
  const high = findings.filter(f => f.severity === 'High').length;
  const summary = `${findings.length} findings (${high} high) across ${new Set(findings.map(f => f.workerId)).size} workers. ` +
    `${prior.size ? `Compared with the prior-period register for ${prior.size} workers.` : 'No prior-period register loaded.'}`;
  return { findings, checks, priorAvailable: prior.size > 0, summary, rollForward: headcountRollForward(model, register) };
}
