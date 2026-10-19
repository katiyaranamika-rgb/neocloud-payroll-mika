// Generates the three external registers the app reconciles against. Deterministic: run it
// again and you get the same files.
//
//   node scripts/generate-registers.ts
//
// 1. data/prior_register.csv       – US prior period (semi-monthly Oct 1–15, biweekly Sep 20–Oct 3),
//                                    built from THIS period's data with standard time at straight pay,
//                                    no bonuses, no time off, same 401(k)/health elections (Module 9).
// 2. data/legacy_register.csv      – the legacy Rippling register for the current period: our engine
//    data/legacy_variance_notes.csv  re-run with 12 planted differences (3 per class, both pay groups).
// 3. data/vendor_register_{uk,in,ca}.csv – UK / India / Canada provider registers (one row per worker,
//    one column per pay code, incl. employer codes and NET_PAY; no GL) with planted variances.
//    data/vendor_variance_notes.csv

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDataSet, DATA_DIR } from './node-data.ts';
import { toCsv } from '../src/engine/csv.ts';
import type { DataSet, TimeResult, RegisterRow } from '../src/engine/types.ts';
import { buildModel, rateOn } from '../src/engine/model.ts';
import { calcUsPayroll } from '../src/engine/payroll.ts';
import type { LegacyOptions } from '../src/engine/payroll.ts';
import { runTimeAndAbsence } from '../src/engine/run.ts';
import { expectedForWorker, INTL_GROUPS, PRIMARY_PLAN, erStatutory } from '../src/engine/intl.ts';
import { employmentWindow, unpaidLeaveDates, isEmployee } from '../src/engine/employment.ts';
import { eachDay, isWeekday, workingDays, round2 } from '../src/engine/dates.ts';

const ds = loadDataSet();

function registerToRows(reg: RegisterRow[], period: { [pg: string]: [string, string] }) {
  const rows: Record<string, unknown>[] = [];
  for (const r of reg) {
    if (r.bucket === 'Excluded') continue;
    for (const l of r.lines) {
      if (l.code === 'PTO_FLEX' || l.code === 'BEN_ARR_NEW') continue;
      rows.push({ worker_id: r.workerId, pay_group: r.payGroup, period_start: period[r.payGroup][0], period_end: period[r.payGroup][1], code: l.code, amount: round2(l.amount), hours: l.hours === undefined ? '' : round2(l.hours) });
    }
  }
  return rows;
}
const COLS = ['worker_id', 'pay_group', 'period_start', 'period_end', 'code', 'amount', 'hours'];

// ---------------------------------------------------------------- 1. prior period
{
  const PRIOR: Record<string, [string, string, string]> = {
    'US Semi-monthly': ['2026-10-01', '2026-10-15', '2026-10-12'],
    'US Biweekly': ['2026-09-20', '2026-10-03', '2026-10-09'],
  };
  const pds: DataSet = JSON.parse(JSON.stringify(ds));
  pds.pay_schedule = pds.pay_schedule.map(r => PRIOR[r.pay_group] ? { ...r, period_start: PRIOR[r.pay_group][0], period_end: PRIOR[r.pay_group][1], pay_date_original: PRIOR[r.pay_group][2] } : r);
  // No bonuses or time off in the prior period; comp/location/leave/garnishment events stay
  // (their effective dates decide whether they apply).
  pds.events = pds.events.filter(e => e.event_type !== 'Bonus' && e.event_type !== 'Time Off');
  // Same elections as current for anyone employed in the prior period.
  pds.payroll_inputs = pds.payroll_inputs.map(r => ({ ...r, effective_start: '2026-01-01' }));
  const model = buildModel(pds);
  // Prior-period hires (current new hires) are excluded by their hire dates.
  const time = new Map<string, TimeResult>();
  const bw = model.schedules.get('US Biweekly')!;
  for (const w of model.workers) {
    if (!isEmployee(w) || w.payGroup !== 'US Biweekly') continue;
    if (w.status === 'On Leave(paid)') continue; // paid leave → LEAVE_PAID in the engine
    const win = employmentWindow(w, bw.start, bw.end);
    if (!win) continue;
    const unpaid = unpaidLeaveDates(model, w, bw.start, bw.end);
    const paid = eachDay(win[0], win[1]).filter(d => isWeekday(d) && !unpaid.has(d)).length;
    const hours = round2(w.weeklyHours * 2 * paid / workingDays(bw.start, bw.end));
    const rate = rateOn(w, bw.start);
    time.set(w.id, { workerId: w.id, group: w.timeCalcGroup, days: [], weeks: [], lines: hours > 0 ? [{ code: 'REG_HRS', hours, rate, amount: round2(hours * rate) }] : [], hoursWorked: hours, leaveHours: {}, dropped: [], issues: [] });
  }
  const reg = calcUsPayroll(model, time, []);
  const rows = registerToRows(reg, { 'US Semi-monthly': [PRIOR['US Semi-monthly'][0], PRIOR['US Semi-monthly'][1]], 'US Biweekly': [PRIOR['US Biweekly'][0], PRIOR['US Biweekly'][1]] });
  writeFileSync(join(DATA_DIR, 'prior_register.csv'), toCsv(rows, COLS));
  console.log(`prior_register.csv: ${new Set(rows.map(r => r.worker_id)).size} workers, ${rows.length} lines`);
}

// ---------------------------------------------------------------- 2. legacy Rippling register
{
  const model = buildModel(ds);
  const { time, absence } = runTimeAndAbsence(model);
  const base = calcUsPayroll(model, time, absence);
  const crossing = base.find(r => r.payGroup === 'US Semi-monthly' && r.tags.includes('Social Security wage base reached this period') && r.workerId !== 'E0005')!.workerId;

  const PLANTED: { id: string; cls: string; root: string; disp: string; opt: (o: LegacyOptions) => void }[] = [
    // Legacy error
    { id: 'E0021', cls: 'Legacy error', root: 'Rippling does not pay CA meal-period premiums (late meal Oct 6, attested missed meal Oct 7).', disp: 'Workday is correct. Pay 2 hrs of meal premium; legacy under-payment confirms the CA compliance gap. Accept Workday result.', opt: o => { (o.dropCodes ??= new Map()).set('E0021', new Set(['MEAL_PEN'])); } },
    { id: 'E0142', cls: 'Legacy error', root: 'Rippling calculates overtime on base rate only; night and NGHT differentials are left out of the regular rate.', disp: 'Workday is correct (FLSA regular rate includes differentials). Accept; quantify back-pay exposure for prior Rippling periods.', opt: o => { (o.rrExcludesDiffFor ??= new Set()).add('E0142'); } },
    { id: 'E0001', cls: 'Legacy error', root: 'Rippling withheld federal tax on the spot bonus at 25% instead of the 22% supplemental rate.', disp: 'Workday is correct. Accept; no employee impact in Workday.', opt: o => { (o.bonusTaxOverride ??= new Map()).set('E0001', 0.25); } },
    // Configuration difference
    { id: 'E0005', cls: 'Configuration difference', root: 'CA→TX move effective Oct 23 not reflected in Rippling tax setup; CA SIT and SDI withheld for the whole period.', disp: 'Workday splits state wages by working days (CA 5 / TX 6). Accept Workday; confirm TX has no SIT and update the legacy tax profile for parallel 2.', opt: o => { (o.stateOverride ??= new Map()).set('E0005', 'CA'); } },
    { id: crossing, cls: 'Configuration difference', root: 'Rippling did not stop Social Security at the $168,600 wage base (YTD wage base tracking reset after the 2026 tenant migration).', disp: 'Workday applies the wage base using derived YTD. Accept; load verified YTD at conversion and re-test.', opt: o => { (o.noOasdiCapFor ??= new Set()).add(crossing); } },
    { id: 'E0020', cls: 'Configuration difference', root: 'Rippling 401(k) earnings definition excludes spot bonuses; NeoCloud plan document includes all gross pay.', disp: 'Workday follows the plan document (401(k) on gross incl. bonus). Accept; confirm the definition with the 401(k) recordkeeper.', opt: o => { (o.k401ExcludesBonusFor ??= new Set()).add('E0020'); } },
    // Timing
    { id: 'E0002', cls: 'Timing', root: 'Comp change effective Oct 19 was entered after the legacy cutoff; Rippling pays the retro next cycle.', disp: 'Timing only. Workday pays retro in this run; expect the reverse difference in the next parallel. No action.', opt: o => { (o.noRetroFor ??= new Set()).add('E0002'); } },
    { id: 'E0349', cls: 'Timing', root: 'New hire starting Oct 26 was keyed in Rippling after its cutoff; legacy pays an off-cycle.', disp: 'Timing only. Workday includes the hire because HR entered the hire before the Workday cutoff. Accept.', opt: o => { (o.excludeWorkers ??= new Set()).add('E0349'); } },
    { id: 'E0071', cls: 'Timing', root: 'Prior-period missing Out punch (Oct 1) was approved after the Rippling close; Rippling pays it next cycle.', disp: 'Timing only. Workday pays the retro this period. Accept; expect reverse difference next parallel.', opt: o => { (o.dropCodes ??= new Map()).set('E0071', new Set(['RETRO_HRS'])); } },
    // Data
    { id: 'E0031', cls: 'Data', root: 'Unpaid leave starting Oct 21 was not entered in Rippling; legacy paid the full salary.', disp: 'Workday is correct. Legacy overpays 8 days; in a real parallel, recover the overpayment and fix the leave feed.', opt: o => { (o.ignoreUnpaidLeaveFor ??= new Set()).add('E0031'); } },
    { id: 'E0022', cls: 'Data', root: 'Rate change $38→$40 effective Oct 10 missing in Rippling; all hours paid at $38.', disp: 'Workday is correct. Under-payment in legacy; confirm the comp feed and pay the difference if legacy were system of record.', opt: o => { (o.hourlyRateOverride ??= new Map()).set('E0022', 38); } },
    { id: 'E0148', cls: 'Data', root: 'Rippling paid out 40 vacation hours from a stale balance; Workday balance is 31 hrs as of Oct 3 (no hours worked after).', disp: 'Workday is correct (Workday is the balance system of record). Legacy overpays 9 hrs; correct the converted balance.', opt: o => { (o.payoutQtyOverride ??= new Map()).set('E0148', 40); } },
  ];
  const opts: LegacyOptions = {};
  for (const p of PLANTED) p.opt(opts);
  const legacy = calcUsPayroll(model, time, absence, opts);
  const ps = (pg: string) => { const s = model.schedules.get(pg)!; return [s.start, s.end] as [string, string]; };
  const rows = registerToRows(legacy, { 'US Semi-monthly': ps('US Semi-monthly'), 'US Biweekly': ps('US Biweekly') });
  writeFileSync(join(DATA_DIR, 'legacy_register.csv'), toCsv(rows, COLS));
  writeFileSync(join(DATA_DIR, 'legacy_variance_notes.csv'), toCsv(PLANTED.map(p => ({ worker_id: p.id, class: p.cls, root_cause: p.root, disposition: p.disp })), ['worker_id', 'class', 'root_cause', 'disposition']));
  console.log(`legacy_register.csv: ${new Set(rows.map(r => r.worker_id)).size} workers; ${PLANTED.length} planted variances (wage-base case: ${crossing})`);
}

// ---------------------------------------------------------------- 3. provider registers
{
  const model = buildModel(ds);
  const { absence } = runTimeAndAbsence(model);
  const rows: Record<string, unknown>[] = [];
  const notes: Record<string, unknown>[] = [];
  const g2n = (pg: string, gross: number) => {
    if (pg === 'UK Monthly') {
      const pa = 12570 / 12; const basicTop = 50270 / 12;
      const paye = 0.2 * Math.max(0, Math.min(gross, basicTop) - pa) + 0.4 * Math.max(0, gross - basicTop);
      const ni = 0.08 * Math.max(0, Math.min(gross, 4189) - 1048) + 0.02 * Math.max(0, gross - 4189);
      return { tax: round2(paye), social: round2(ni), pension: round2(0.05 * gross) };
    }
    if (pg === 'India Monthly') return { tax: round2((gross > 100000 ? 0.2 : 0.1) * gross), social: round2(0.12 * Math.min(0.5 * gross, 15000)), pension: 0 };
    return { tax: round2(0.25 * gross), social: round2(0.07 * gross), pension: 0 };
  };
  const PLANTED: Record<string, { cls: string; root: string; disp: string }> = {
    E0084: { cls: 'Timing', root: 'Salary increase effective Oct 12 reached the provider after the Oct 12 change cutoff; provider paid the old salary for the full month.', disp: 'Workday is correct. Provider pays the Oct 12–31 difference as arrears in November; track on the cutover issue log.' },
    E0006: { cls: 'Data', root: 'Provider paid out the Sep 30 holiday balance (14.5 days) and missed October accrual for the leaver.', disp: 'Workday balance is the system of record. Ask provider to pay the extra accrued days on a supplementary run.' },
    E0341: { cls: 'Timing', root: 'Sign-on bonus one-time payment was sent on a late PECI file and not processed this month.', disp: 'Pay in the November run (or supplementary). Confirm the PECI late-change process.' },
    E0009: { cls: 'Provider error', root: 'Provider paid the full month to a leaver terminated Oct 15 (termination event ignored).', disp: 'Overpayment of half a month. Provider to recover from final settlement; raise a service ticket.' },
    E0052: { cls: 'Data', root: 'Provider payslip shows earned leave of 14.0 days; Workday shows 15.0 after accrual and the Oct 22 half-day. Provider did not load the October absence file.', disp: 'Workday is the source of truth for balances printed on payslips. Provider to reload absence and reissue payslip.' },
    E0086: { cls: 'Configuration difference', root: 'Provider computed employer PF on full basic, without the ₹15,000 wage ceiling.', disp: 'Workday applies the ceiling (max ₹1,800). Ask provider to configure the PF wage ceiling; credit note for the overcharge.' },
  };
  for (const w of model.workers) {
    if (!isEmployee(w) || !INTL_GROUPS.includes(w.payGroup)) continue;
    const e = expectedForWorker(model, w, absence);
    if (!e || e.bucket === 'Excluded') continue;
    let { base, bonus, payout } = e;
    let absenceBal = e.absenceEnding;
    let erOverride: number | null = null;
    if (w.id === 'E0084') base = round2(w.rateHistory[0].value / 12);
    if (w.id === 'E0006') { const a = absence.find(x => x.workerId === 'E0006' && x.plan === PRIMARY_PLAN[w.payGroup])!; payout = round2((a.opening ?? 0) * a.rate); }
    if (w.id === 'E0341') bonus = 0;
    if (w.id === 'E0009') base = round2(rateOn(w, '2026-10-01') / 12);
    if (w.id === 'E0052' && absenceBal !== null) absenceBal = round2(absenceBal - 1);
    const gross = round2(base + bonus + payout);
    if (w.id === 'E0086') erOverride = round2(0.12 * 0.5 * gross);
    const er = erOverride ?? erStatutory(model, w.payGroup, gross).amount;
    const d = g2n(w.payGroup, gross);
    const ps = model.schedules.get(w.payGroup)!;
    const head = { employee_id: w.id, employee_name: `Employee ${w.id.replace(/^E0*/, '').padStart(3, '0')}`, company: `NC-${w.country}`, country: w.country, currency: w.currency, period_start: ps.start, period_end: ps.end, pay_date: ps.payDate };
    const netPay = round2(gross - d.tax - d.social - d.pension);
    // Employer-paid benefits (5% of gross for international): provider-calculated employer cost; no employee share, so net pay is unchanged.
    const erBen = round2(gross * model.rules.intl.employerBenefitsLoadPctOfGross);
    let codes: Record<string, number | string>;
    if (w.payGroup === 'UK Monthly') codes = { BASIC: base, BONUS: bonus, HOL_PAYOUT: payout, PAYE: d.tax, EE_NI: d.social, EE_PENSION: d.pension, NET_PAY: netPay, ER_NI: er, ER_BENEFITS: erBen };
    else if (w.payGroup === 'India Monthly') codes = { BASIC: base, BONUS: bonus, EL_ENCASH: payout, TDS: d.tax, EE_PF: d.social, NET_PAY: netPay, ER_PF: er, ER_BENEFITS: erBen };
    else {
      const cpp = round2(d.social * 0.85);
      // Family support order (FRO): provider withholds 50% of net pay.
      const garn = model.events.some(e => e.workerId === w.id && e.type === 'Garnishment') ? round2(netPay * 0.5) : 0;
      codes = { BASIC: base, BONUS: bonus, VAC_PAY: payout, INC_TAX: d.tax, CPP_EE: cpp, EI_EE: round2(d.social - cpp), GARN_FRO: garn, NET_PAY: round2(netPay - garn), ER_CPP_EI: er, ER_BENEFITS: erBen };
    }
    rows.push({ ...head, ...codes, leave_balance_days: absenceBal === null ? '' : round2(absenceBal), _pg: w.payGroup });
    if (PLANTED[w.id]) notes.push({ worker_id: w.id, field: '*', class: PLANTED[w.id].cls, root_cause: PLANTED[w.id].root, disposition: PLANTED[w.id].disp });
  }
  const HEAD = ['employee_id', 'employee_name', 'company', 'country', 'currency', 'period_start', 'period_end', 'pay_date'];
  const FILES: [string, string, string[]][] = [
    ['UK Monthly', 'vendor_register_uk.csv', ['BASIC', 'BONUS', 'HOL_PAYOUT', 'PAYE', 'EE_NI', 'EE_PENSION', 'NET_PAY', 'ER_NI', 'ER_BENEFITS']],
    ['India Monthly', 'vendor_register_in.csv', ['BASIC', 'BONUS', 'EL_ENCASH', 'TDS', 'EE_PF', 'NET_PAY', 'ER_PF', 'ER_BENEFITS']],
    ['Canada Monthly', 'vendor_register_ca.csv', ['BASIC', 'BONUS', 'VAC_PAY', 'INC_TAX', 'CPP_EE', 'EI_EE', 'GARN_FRO', 'NET_PAY', 'ER_CPP_EI', 'ER_BENEFITS']],
  ];
  for (const [pg, file, codes] of FILES) {
    writeFileSync(join(DATA_DIR, file), toCsv(rows.filter(r => r._pg === pg), [...HEAD, ...codes, 'leave_balance_days']));
  }
  writeFileSync(join(DATA_DIR, 'vendor_variance_notes.csv'), toCsv(notes, ['worker_id', 'field', 'class', 'root_cause', 'disposition']));
  console.log(`vendor_register_uk/in/ca.csv: ${rows.length} workers; ${notes.length} planted variances`);
}
