// International payroll (UK, India, Canada). The app does NOT run gross-to-net here: the
// in-country provider does (Module 8 decision 8.3). What the app does:
//   1. builds the "sent to provider" expectation from Workday data (what PECI would carry):
//      prorated base, one-time payments, termination payouts, absence balances;
//   2. recomputes employer statutory and benefits cost from the rules as an independent check
//      (the provider calculates and reports them; the app never pays or posts its own figure);
//   3. imports the provider's register and reconciles it field by field;
//   4. the GL posts from the provider register (source of truth for results), in local
//      currency to each subsidiary, with USD shown at the reporting FX rates.

import type { Model, AbsenceRow, Worker } from './types.ts';
import { eachDay, isWeekday, round2, workingDays } from './dates.ts';
import { employmentWindow, unpaidLeaveDates, isEmployee } from './employment.ts';
import { rateOn } from './model.ts';
import { vendorRoleTotals } from './prism.ts';
import { VENDOR_FILES } from './files.ts';
import type { Row } from './csv.ts';

export const INTL_GROUPS = ['UK Monthly', 'India Monthly', 'Canada Monthly'];
export const PRIMARY_PLAN: Record<string, string> = {
  'UK Monthly': 'UK Annual Leave', 'India Monthly': 'India Earned Leave', 'Canada Monthly': 'Canada Vacation',
};

export interface IntlExpected {
  workerId: string; payGroup: string; country: string; currency: string; dept: string; costCenter: string;
  location: string; paidDays: number; periodDays: number; base: number; bonus: number; payout: number;
  gross: number; erStatutory: number; erStatutoryLabel: string; benefitLoad: number; employerCost: number;
  fx: number; grossUsd: number; employerCostUsd: number; absencePlan: string; absenceEnding: number | null;
  bucket: string; bucketReason: string; tags: string[];
}

export interface VendorRow {
  workerId: string; country: string; currency: string; base: number; bonus: number; payout: number;
  gross: number; eeTax: number; eeSocial: number; eePension: number; net: number; erSocial: number; erBenefits: number;
  absencePlan: string; absenceBalance: number | null;
}

export interface IntlVariance {
  workerId: string; payGroup: string; field: string; expected: number | string; vendor: number | string;
  diff: number; currency: string; cls: string; rootCause: string; disposition: string; explained: boolean;
}

export interface IntlResult {
  expected: IntlExpected[]; vendor: VendorRow[]; variances: IntlVariance[];
  byCountry: { payGroup: string; currency: string; headcountExpected: number; headcountVendor: number;
    grossExpected: number; grossVendor: number; erExpected: number; erVendor: number; benVendor: number; netVendor: number;
    employerCostVendorUsd: number; fx: number }[];
}

export function erStatutory(model: Model, payGroup: string, gross: number): { amount: number; label: string } {
  const r = model.rules.intl;
  if (payGroup === 'UK Monthly') return { amount: round2(r.ukEmployerNi.rate * Math.max(0, gross - r.ukEmployerNi.monthlySecondaryThreshold)), label: 'UK employer NI' };
  if (payGroup === 'Canada Monthly') return { amount: round2(r.caEmployerCppEi.rate * gross), label: 'CPP + EI employer' };
  if (payGroup === 'India Monthly') return { amount: round2(r.inEmployerPf.rate * Math.min(r.inEmployerPf.basicPctOfGross * gross, r.inEmployerPf.basicCap)), label: 'India employer PF' };
  return { amount: 0, label: '' };
}

export function expectedForWorker(model: Model, w: Worker, absence: AbsenceRow[]): IntlExpected | null {
  const ps = model.schedules.get(w.payGroup);
  if (!ps) return null;
  const periodDays = workingDays(ps.start, ps.end);
  const win = employmentWindow(w, ps.start, ps.end);
  const unpaid = unpaidLeaveDates(model, w, ps.start, ps.end);
  const tags: string[] = [];
  let base = 0; let paidDays = 0;
  if (win) {
    for (const d of eachDay(win[0], win[1])) {
      if (!isWeekday(d) || unpaid.has(d)) continue;
      // Hourly workers paid by the provider: monthly equivalent of scheduled hours (no time data).
      const monthly = w.payRateType === 'Hourly' ? rateOn(w, d) * w.weeklyHours * 52 / 12 : rateOn(w, d) / 12;
      base += monthly / periodDays;
      paidDays++;
    }
  }
  const cur = `(${w.currency})`;
  let bonus = 0;
  for (const e of model.events.filter(e => e.workerId === w.id && e.type === 'Bonus' && e.start >= ps.start && e.start <= ps.end && e.field.includes(cur))) {
    bonus += Number(e.newValue);
    tags.push(/sign-on/i.test(e.field) ? 'Event: sign-on bonus' : 'Event: spot bonus');
  }
  const payout = absence.filter(a => a.workerId === w.id && a.payoutAmount > 0).reduce((s, a) => s + a.payoutAmount, 0);
  if (payout > 0) tags.push('Termination payout');
  for (const e of model.events.filter(e => e.workerId === w.id && e.start <= ps.end && (e.end || e.start) >= ps.start)) {
    if (e.type === 'Comp Change') tags.push('Event: comp change (prorated)');
    if (e.type === 'Unpaid Leave') tags.push('Event: unpaid leave');
    if (e.type === 'Time Off') tags.push('Event: time off');
  }
  const gross = round2(base + bonus + payout);
  const er = erStatutory(model, w.payGroup, gross);
  const benefitLoad = round2(gross * model.rules.intl.employerBenefitsLoadPctOfGross);
  const fx = model.rules.intl.fxToUsd[w.currency] ?? 1;
  const plan = PRIMARY_PLAN[w.payGroup];
  const abs = absence.find(a => a.workerId === w.id && a.plan === plan);
  let bucket = 'Paid full period'; let reason = '';
  if (!win) { bucket = 'Excluded'; reason = 'Not employed in period'; }
  else if (gross <= 0) { bucket = 'Active, not paid'; reason = 'Unpaid leave for the whole period'; }
  else if (paidDays < periodDays) {
    bucket = 'Paid prorated';
    reason = w.hireDate > ps.start ? `New hire ${w.hireDate}` : w.termDate && w.termDate < ps.end ? `Termination ${w.termDate}` : `Unpaid leave ${periodDays - paidDays}/${periodDays} days`;
  }
  return {
    workerId: w.id, payGroup: w.payGroup, country: w.country, currency: w.currency, dept: w.dept,
    costCenter: w.costCenter, location: w.location, paidDays, periodDays, base: round2(base), bonus: round2(bonus),
    payout: round2(payout), gross, erStatutory: er.amount, erStatutoryLabel: er.label, benefitLoad,
    employerCost: round2(gross + er.amount + benefitLoad), fx, grossUsd: round2(gross * fx),
    employerCostUsd: round2((gross + er.amount + benefitLoad) * fx), absencePlan: plan,
    absenceEnding: abs ? abs.ending : null, bucket, bucketReason: reason, tags: [...new Set(tags)],
  };
}


export function calcInternational(model: Model, absence: AbsenceRow[]): IntlResult {
  const expected: IntlExpected[] = [];
  for (const w of model.workers) {
    if (!isEmployee(w) || !INTL_GROUPS.includes(w.payGroup)) continue;
    const e = expectedForWorker(model, w, absence);
    if (e) expected.push(e);
  }
  const vendor: VendorRow[] = [];
  for (const pg of INTL_GROUPS) {
    for (const r of (model.raw as unknown as Record<string, Row[]>)[VENDOR_FILES[pg]] ?? []) {
      const t = vendorRoleTotals(r);
      vendor.push({
        workerId: r.employee_id, country: r.country, currency: r.currency, base: round2(t.base), bonus: round2(t.bonus),
        payout: round2(t.payout), gross: round2(t.base + t.bonus + t.payout), eeTax: round2(t.eeTax), eeSocial: round2(t.eeSocial),
        eePension: round2(t.eePension), net: round2(t.net), erSocial: round2(t.erSocial), erBenefits: round2(t.erBenefits), absencePlan: PRIMARY_PLAN[pg],
        absenceBalance: r.leave_balance_days === '' || r.leave_balance_days === undefined ? null : Number(r.leave_balance_days),
      });
    }
  }
  const notes = model.raw.vendor_variance_notes;
  const noteFor = (id: string, field: string) => notes.find(x => x.worker_id === id && (x.field === field || x.field === '*'));
  const variances: IntlVariance[] = [];
  const vById = new Map(vendor.map(v => [v.workerId, v]));
  const eById = new Map(expected.map(e => [e.workerId, e]));
  const push = (id: string, pg: string, field: string, exp: number | string, ven: number | string, cur: string) => {
    const note = noteFor(id, field);
    const diff = typeof exp === 'number' && typeof ven === 'number' ? round2(ven - exp) : 0;
    variances.push({
      workerId: id, payGroup: pg, field, expected: exp, vendor: ven, diff, currency: cur,
      cls: note?.class ?? 'Unexplained', rootCause: note?.root_cause ?? 'Not yet investigated',
      disposition: note?.disposition ?? 'Investigate before GL posting', explained: !!note,
    });
  };
  for (const e of expected) {
    if (e.bucket === 'Excluded') continue;
    const v = vById.get(e.workerId);
    if (!v) { push(e.workerId, e.payGroup, 'headcount', 'Sent to provider', 'Missing from provider register', e.currency); continue; }
    const fields: [string, number, number][] = [
      ['base', e.base, v.base], ['bonus', e.bonus, v.bonus], ['payout', e.payout, v.payout],
      ['gross', e.gross, v.gross], ['employer_social', e.erStatutory, v.erSocial], ['employer_benefits', e.benefitLoad, v.erBenefits],
    ];
    for (const [f, a, b] of fields) if (Math.abs(a - b) > 1) push(e.workerId, e.payGroup, f, a, b, e.currency);
    if (e.absenceEnding !== null && v.absenceBalance !== null && Math.abs(e.absenceEnding - v.absenceBalance) > 0.01) {
      push(e.workerId, e.payGroup, 'absence_balance', round2(e.absenceEnding), v.absenceBalance, 'days');
    }
    if (Math.abs(v.gross - v.eeTax - v.eeSocial - v.eePension - v.net) > 0.05) {
      push(e.workerId, e.payGroup, 'net_check', round2(v.gross - v.eeTax - v.eeSocial - v.eePension), v.net, e.currency);
    }
  }
  for (const v of vendor) {
    if (!eById.has(v.workerId)) {
      const w = model.workerById.get(v.workerId);
      push(v.workerId, w?.payGroup ?? '', 'headcount', 'Not sent', 'Paid by provider', v.currency);
    }
  }
  const byCountry = INTL_GROUPS.map(pg => {
    const ex = expected.filter(e => e.payGroup === pg && e.bucket !== 'Excluded');
    const ve = vendor.filter(v => model.workerById.get(v.workerId)?.payGroup === pg);
    const cur = ex[0]?.currency ?? ve[0]?.currency ?? '';
    const fx = model.rules.intl.fxToUsd[cur] ?? 1;
    const grossV = ve.reduce((s, v) => s + v.gross, 0);
    const erV = ve.reduce((s, v) => s + v.erSocial, 0);
    return {
      payGroup: pg, currency: cur, headcountExpected: ex.length, headcountVendor: ve.length,
      grossExpected: round2(ex.reduce((s, e) => s + e.gross, 0)), grossVendor: round2(grossV),
      erExpected: round2(ex.reduce((s, e) => s + e.erStatutory, 0)), erVendor: round2(erV), benVendor: round2(ve.reduce((s, v) => s + v.erBenefits, 0)),
      netVendor: round2(ve.reduce((s, v) => s + v.net, 0)),
      employerCostVendorUsd: round2((grossV + erV + ve.reduce((s, v) => s + v.erBenefits, 0)) * fx), fx,
    };
  });
  return { expected, vendor, variances, byCountry };
}
