// Payroll status by pay group — 7 stages per period, shown as one grid on the dashboard.
//
//   1 Preparing payroll inputs · 2 Payroll processing · 3 Payroll audits · 4 Payroll sign-off
//   5 Payroll complete · 6 Settlement · 7 Closed
//
// Each stage has a due date and a completion rule. Stages complete in order. A stage is
// Done only when its rule passes; the first stage that is not Done is the current stage:
//   past its due date → Late · open items → At risk · otherwise In progress.
// Later stages are Not started (or Late if their due date has already passed).
// Rules use the run's own checks plus three recorded actions (Module decision: automatic
// checks + actions): resolved audit findings / provider variances, payroll sign-off, and
// period close. Actions are passed in; the UI stores them in the viewer's browser.

import type { RunResult } from './run.ts';

export const STAGES = [
  'Preparing payroll inputs', 'Payroll processing', 'Payroll audits', 'Payroll sign-off',
  'Payroll complete', 'Settlement', 'Closed',
] as const;

export type StageState = 'Done' | 'In progress' | 'At risk' | 'Late' | 'Not started';

export interface StageActions {
  resolved: Record<string, { note: string; at: string }>;
  signoff: Record<string, { by: string; at: string }>;
  close: Record<string, { by: string; at: string }>;
}

export interface Stage {
  index: number; name: string; due: string; owner: string; state: StageState;
  passes: boolean; items: string[]; note: string; action: 'signoff' | 'close' | 'resolve' | null; actionEnabled: boolean;
}

export interface PayGroupStatus {
  payGroup: string; period: string; payDate: string; headcount: number;
  overall: 'On track' | 'At risk' | 'Late' | 'Closed'; currentIndex: number; stages: Stage[];
}

/** Stage due dates (end of each stage) per pay group. */
const CALENDAR: Record<string, { due: string; owner: string }[]> = {
  'US Biweekly': [
    { due: '2026-10-19', owner: 'Workers / Managers' }, { due: '2026-10-20', owner: 'Payroll Partner' },
    { due: '2026-10-20', owner: 'Payroll Partner' }, { due: '2026-10-21', owner: 'Payroll Manager' },
    { due: '2026-10-21', owner: 'Payroll Partner' }, { due: '2026-10-23', owner: 'Treasury' },
    { due: '2026-10-27', owner: 'Controller' },
  ],
  'US Semi-monthly': [
    { due: '2026-10-21', owner: 'HR / Payroll Partner' }, { due: '2026-10-21', owner: 'Payroll Partner' },
    { due: '2026-10-22', owner: 'Payroll Partner' }, { due: '2026-10-22', owner: 'Payroll Manager' },
    { due: '2026-10-23', owner: 'Payroll Partner' }, { due: '2026-10-27', owner: 'Treasury' },
    { due: '2026-10-30', owner: 'Controller' },
  ],
  intl: [
    { due: '2026-10-13', owner: 'HR / People Tech' }, { due: '2026-10-19', owner: 'Provider' },
    { due: '2026-10-20', owner: 'Payroll Manager' }, { due: '2026-10-20', owner: 'Payroll Manager' },
    { due: '2026-10-21', owner: 'Provider' }, { due: '2026-10-23', owner: 'Treasury' },
    { due: '2026-10-28', owner: 'Controller' },
  ],
};

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

export function findingKey(f: { check: string; workerId: string; title: string }): string {
  return `${f.check}|${f.workerId}|${f.title}`;
}
export function vendorKey(workerId: string): string { return `VENDOR|${workerId}`; }

export function payrollStatus(R: RunResult, asOf: string, actions: StageActions): PayGroupStatus[] {
  const out: PayGroupStatus[] = [];
  const order = ['US Biweekly', 'US Semi-monthly', 'UK Monthly', 'India Monthly', 'Canada Monthly'];
  for (const pg of order) {
    const ps = R.model.schedules.get(pg);
    if (!ps) continue;
    const isUs = pg.startsWith('US');
    const cal = CALENDAR[isUs ? pg : 'intl'];
    const reg = R.register.filter(r => r.payGroup === pg && r.bucket !== 'Excluded');
    const findings = R.audit.findings.filter(f => f.payGroup === pg);
    const openHigh = findings.filter(f => f.severity === 'High' && !actions.resolved[findingKey(f)]);
    const legacy = R.legacy.workers.filter(w => w.payGroup === pg);
    const vend = R.intl.variances.filter(v => v.payGroup === pg);
    const vendWorkers = [...new Set(vend.map(v => v.workerId))];
    const vendOpen = vendWorkers.filter(id => !actions.resolved[vendorKey(id)]);
    const byC = R.intl.byCountry.find(c => c.payGroup === pg);
    const bank = R.journal.bank.find(b => b.payGroup === pg);
    const bankOk = !!bank && Math.abs(bank.difference) < 0.01;
    const jPrefix = pg === 'US Semi-monthly' ? 'JE-US-SM' : pg === 'US Biweekly' ? 'JE-US-BW' : `JE-${ps.country}`;
    const journals = R.journal.journals.filter(j => j.journalId.startsWith(jPrefix));
    const glOk = journals.length > 0 && journals.every(j => j.balanced) && R.journal.exportable && R.journal.ties.every(t => t.ok);
    const signed = actions.signoff[pg];
    const closed = actions.close[pg];

    type Rule = { passes: boolean; items: string[]; note: string; action?: Stage['action'] };
    const rules: Rule[] = [];
    // 1 Preparing payroll inputs
    if (pg === 'US Biweekly') {
      const noTime = findings.filter(f => f.check === 'A11');
      const timeEx = findings.filter(f => f.check === 'A10' && f.severity !== 'Low' && !actions.resolved[findingKey(f)]);
      const items = [...(noTime.length ? [`${plural(noTime.length, 'worker')} with no time submitted`] : []), ...(timeEx.length ? [`${plural(timeEx.length, 'time exception')} to review`] : [])];
      rules.push({ passes: asOf >= cal[0].due && items.length === 0, items, note: asOf < cal[0].due ? `Time due Mon Oct 19 09:00, approval 15:00` : 'Time entry window closed' });
    } else if (isUs) {
      rules.push({ passes: asOf >= cal[0].due, items: [], note: `HR changes and pay inputs open until ${cal[0].due}` });
    } else {
      rules.push({ passes: asOf >= cal[0].due, items: [], note: `Changes cutoff Oct 12; PECI file sent Oct 13 (${byC?.headcountExpected ?? 0} workers)` });
    }
    // 2 Payroll processing
    if (isUs) {
      rules.push({ passes: reg.length > 0 && asOf >= cal[0].due, items: reg.length ? [] : ['Payroll not calculated'], note: `${plural(reg.length, 'worker')} calculated` });
    } else {
      const same = !!byC && byC.headcountVendor === byC.headcountExpected;
      rules.push({ passes: same && asOf >= cal[1].due, items: same ? [] : [`Provider returned ${byC?.headcountVendor ?? 0} of ${byC?.headcountExpected ?? 0} workers`], note: asOf >= cal[1].due ? `${byC?.headcountVendor ?? 0} provider rows imported` : 'Provider processing; results due Oct 19' });
    }
    // 3 Payroll audits
    if (isUs) {
      const unexplained = legacy.filter(w => !w.explained);
      const items = [...(openHigh.length ? [`${plural(openHigh.length, 'open high-severity finding')}`] : []), ...(unexplained.length ? [`${plural(unexplained.length, 'unexplained Rippling variance')}`] : [])];
      rules.push({ passes: items.length === 0, items, note: `${plural(findings.length, 'audit finding')}, ${plural(legacy.length, 'Rippling variance')}`, action: 'resolve' });
    } else {
      const unexplained = vend.filter(v => !v.explained);
      const items = [...(vendOpen.length ? [`${plural(vendOpen.length, 'provider variance')} to resolve`] : []), ...(unexplained.length ? [`${plural(unexplained.length, 'unexplained field')}`] : [])];
      rules.push({ passes: items.length === 0, items, note: `${plural(vend.length, 'field variance')} across ${plural(vendWorkers.length, 'worker')}`, action: 'resolve' });
    }
    // 4 Payroll sign-off
    rules.push({ passes: !!signed, items: signed ? [] : ['Awaiting Payroll Manager sign-off'], note: signed ? `Signed off by ${signed.by} · ${signed.at}` : 'Payroll Manager approves the results', action: 'signoff' });
    // 5 Payroll complete
    rules.push({ passes: !!signed && bankOk, items: bankOk ? [] : ['Bank file does not tie to register net'], note: bank ? `${isUs ? 'Bank file + checks' : 'Provider final register'} ties to net pay` : '' });
    // 6 Settlement
    rules.push({ passes: asOf >= ps.payDate && bankOk, items: bankOk ? [] : ['Funding differs from net pay'], note: `Funding ${isUs ? 'released' : 'to provider'}; pay date ${ps.payDate}` });
    // 7 Closed
    rules.push({ passes: glOk && !!closed, items: [...(glOk ? [] : ['GL journal not ready to post']), ...(closed ? [] : ['Awaiting Controller close'])], note: closed ? `Closed by ${closed.by} · ${closed.at}` : 'GL posted to NetSuite, clean-close checks, Controller close', action: 'close' });

    // Sequential evaluation
    const stages: Stage[] = [];
    let current = -1;
    for (let i = 0; i < 7; i++) {
      const r = rules[i];
      const priorDone = current === -1;
      const done = priorDone && r.passes;
      let st: StageState;
      if (done) st = 'Done';
      else if (current === -1) {
        current = i;
        st = asOf > cal[i].due ? 'Late' : r.items.length ? 'At risk' : 'In progress';
      } else st = asOf > cal[i].due ? 'Late' : 'Not started';
      const actionEnabled = r.action === 'signoff' ? current === i && !signed
        : r.action === 'close' ? current === i && glOk && !closed
        : r.action === 'resolve' ? r.items.length > 0 : false;
      stages.push({ index: i, name: STAGES[i], due: cal[i].due, owner: cal[i].owner, state: st, passes: r.passes, items: r.items, note: r.note, action: r.action ?? null, actionEnabled });
    }
    const overall = current === -1 ? 'Closed' : stages.some(s => s.state === 'Late') ? 'Late' : stages[current].state === 'At risk' ? 'At risk' : 'On track';
    out.push({
      payGroup: pg, period: `${ps.start} to ${ps.end}`, payDate: ps.payDate,
      headcount: isUs ? reg.length : (byC?.headcountExpected ?? 0), overall, currentIndex: current, stages,
    });
  }
  return out;
}
