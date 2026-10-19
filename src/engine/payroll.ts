// US gross-to-net for both US pay groups (semi-monthly exempt, biweekly non-exempt).
//
// Gross: salary prorated by working days (semi-monthly) or time results (biweekly), plus
// leave pay, bonuses, retro and termination payouts.
// Pre-tax: 401(k) (% of gross incl. bonuses; reduces FIT/SIT wages, not FICA) and
//          Section 125 medical/dental/vision (flat per period; reduce FIT/SIT/FICA wages).
// Taxes:   flat approximations from data/rules.json with YTD wage bases derived from
//          salary/rate × 2026 periods worked before this period.
// Post-tax: garnishments limited by disposable earnings; benefit shortfalls become arrears.

import type { Model, Worker, PayLine, RegisterRow, TimeResult, AbsenceRow, Issue, PaySchedule } from './types.ts';
import { addDays, eachDay, isWeekday, round2, workingDays, overlap } from './dates.ts';
import { employmentWindow, unpaidLeaveDates, isUs, isEmployee } from './employment.ts';
import { rateOn, stateOn, locationOn } from './model.ts';

/** Hooks used ONLY by the legacy-register generator to simulate how Rippling differs. */
export interface LegacyOptions {
  excludeWorkers?: Set<string>;
  noRetroFor?: Set<string>;
  ignoreUnpaidLeaveFor?: Set<string>;
  stateOverride?: Map<string, string>;
  hourlyRateOverride?: Map<string, number>;
  dropCodes?: Map<string, Set<string>>;
  noOasdiCapFor?: Set<string>;
  k401ExcludesBonusFor?: Set<string>;
  uncappedGarnFor?: Set<string>;
  payoutQtyOverride?: Map<string, number>;
  rrExcludesDiffFor?: Set<string>;
  bonusTaxOverride?: Map<string, number>;
}

const SEMI = 'US Semi-monthly';

function semiPeriods2026(): [string, string][] {
  const out: [string, string][] = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = addDays(m === 12 ? '2027-01-01' : `2026-${String(m + 1).padStart(2, '0')}-01`, -1);
    out.push([`2026-${mm}-01`, `2026-${mm}-15`], [`2026-${mm}-16`, last]);
  }
  return out;
}

/** Derived 2026 YTD before the current period (decision: salary × periods worked since Jan 1 or hire). */
export function priorYtd(model: Model, w: Worker, ps: PaySchedule, s125PerPeriod: number) {
  let gross = 0;
  let fica = 0;
  let periods = 0;
  const list: [string, string][] = [];
  if (w.payGroup === SEMI) {
    for (const p of semiPeriods2026()) if (p[1] < ps.start) list.push(p);
  } else {
    for (let k = 0; k < 40; k++) {
      const end = addDays(ps.start, -1 - 14 * k);
      const start = addDays(end, -13);
      const payDate = addDays(end, 6);
      if (payDate < '2026-01-01') break;
      list.push([start, end]);
    }
  }
  for (const [s, e] of list) {
    const win = employmentWindow(w, s, e);
    if (!win) continue;
    const unpaid = unpaidLeaveDates(model, w, s, e);
    const paid = eachDay(win[0], win[1]).filter(d => isWeekday(d) && !unpaid.has(d)).length;
    const frac = paid / workingDays(s, e);
    if (frac <= 0) continue;
    const r = rateOn(w, s);
    const g = w.payGroup === SEMI ? (r / 24) * frac : r * w.weeklyHours * 2 * frac;
    gross += g;
    fica += Math.max(0, g - s125PerPeriod);
    periods++;
  }
  return { gross: round2(gross), fica: round2(fica), periods };
}

function parseMoney(s: string): number {
  const m = s.match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}

export function calcUsPayroll(
  model: Model, time: Map<string, TimeResult>, absence: AbsenceRow[], opts: LegacyOptions = {},
): RegisterRow[] {
  const rules = model.rules;
  const rows: RegisterRow[] = [];

  for (const w of model.workers) {
    if (!isEmployee(w) || !isUs(w)) continue;
    if (opts.excludeWorkers?.has(w.id)) continue;
    const ps = model.schedules.get(w.payGroup)!;
    const lines: PayLine[] = [];
    const issues: Issue[] = [];
    const tags: string[] = [];
    const win = employmentWindow(w, ps.start, ps.end);
    const base: RegisterRow = {
      workerId: w.id, payGroup: w.payGroup, dept: w.dept, costCenter: w.costCenter,
      location: locationOn(w, ps.end), state: stateOn(w, ps.end), lines, gross: 0, pretax: 0,
      eeTaxes: 0, postTax: 0, net: 0, erCost: 0, burdened: 0, arrearsCreated: 0,
      bucket: 'Paid full period', bucketReason: '', tags, ytdPriorFica: 0, states: {}, issues,
    };
    if (!win) {
      base.bucket = 'Excluded';
      base.bucketReason = w.hireDate > ps.end ? `Hire date ${w.hireDate} after period` : `Terminated ${w.termDate} before period`;
      rows.push(base);
      continue;
    }
    const unpaid = opts.ignoreUnpaidLeaveFor?.has(w.id) ? new Set<string>() : unpaidLeaveDates(model, w, ps.start, ps.end);
    const stateDays: Record<string, number> = {};
    const stateFor = (d: string) => opts.stateOverride?.get(w.id) ?? stateOn(w, d);
    let prorated = false;
    let prorateReason = '';

    // ---------------- earnings ----------------
    if (w.payRateType === 'Salary') {
      const periodWd = workingDays(ps.start, ps.end);
      const empDays = eachDay(win[0], win[1]).filter(isWeekday);
      const compEvents = model.events.filter(e => e.workerId === w.id && e.type === 'Comp Change' && e.start >= ps.start && e.start <= ps.end);
      const lateEntered = compEvents.length > 0;
      const original = (d: string) => (lateEntered ? w.rateHistory[0].value : rateOn(w, d));
      let reg = 0; let retro = 0; let dock = 0;
      for (const d of empDays) {
        const o = original(d) / 24 / periodWd;
        reg += o;
        if (unpaid.has(d)) { dock += o; continue; }
        retro += rateOn(w, d) / 24 / periodWd - o;
        const st = stateFor(d);
        stateDays[st] = (stateDays[st] ?? 0) + 1;
      }
      lines.push({ code: 'REG_SAL', amount: round2(reg), hours: empDays.length * 8, detail: `${empDays.length} of ${periodWd} working days at ${original(win[0]).toLocaleString()} / yr` });
      if (empDays.length < periodWd) {
        prorated = true;
        prorateReason = w.hireDate >= ps.start ? `New hire ${w.hireDate}: ${empDays.length}/${periodWd} days` : `Termination ${w.termDate}: ${empDays.length}/${periodWd} days`;
      }
      if (dock > 0) {
        const n = empDays.filter(d => unpaid.has(d)).length;
        lines.push({ code: 'UNPD_LV', amount: -round2(dock), hours: -n * 8, detail: `${n} unpaid working day(s)` });
        if (n < empDays.length) { prorated = true; prorateReason = `Unpaid leave ${n}/${periodWd} days`; }
        tags.push('Event: unpaid leave');
      }
      if (lateEntered && Math.abs(retro) > 0.004 && !opts.noRetroFor?.has(w.id)) {
        const e = compEvents[0];
        lines.push({ code: 'RETRO_SAL', amount: round2(retro), detail: `Late-entered comp change ${e.oldValue}→${e.newValue} eff ${e.start}; period recalculated` });
        tags.push('Retro: late-entered comp change');
        issues.push({ workerId: w.id, code: 'RETRO_SAL', severity: 'info', message: `Comp change effective ${e.start} entered after the period was paid; retro ${round2(retro).toFixed(2)}`, ref: e.id });
      }
      const flex = model.events.filter(e => e.workerId === w.id && e.type === 'Time Off' && e.plan === 'US Flexible PTO' && e.start >= ps.start && e.start <= ps.end);
      if (flex.length) {
        lines.push({ code: 'PTO_FLEX', amount: 0, hours: flex.reduce((s, e) => s + e.qty, 0), detail: 'Memo: Flexible PTO hours (no pay impact)' });
        tags.push('Event: time off');
      }
    } else {
      const tr = time.get(w.id);
      const rateOv = opts.hourlyRateOverride?.get(w.id);
      for (const l of tr?.lines ?? []) {
        if (opts.dropCodes?.get(w.id)?.has(l.code)) continue;
        let amount = l.amount;
        if (rateOv !== undefined && l.hours && ['REG_HRS', 'OT_15', 'DT_20'].includes(l.code)) {
          const mult = l.code === 'REG_HRS' ? 1 : l.code === 'OT_15' ? 1.5 : 2;
          amount = round2(l.hours * rateOv * mult);
        }
        if (opts.rrExcludesDiffFor?.has(w.id) && l.hours) {
          const r = rateOn(w, ps.end);
          if (l.code === 'OT_15') amount = round2(l.hours * 1.5 * r);
          if (l.code === 'DT_20') amount = round2(l.hours * 2 * r);
          if (l.code === 'MEAL_PEN') amount = round2(l.hours * r);
        }
        lines.push({ ...l, amount });
      }
      for (const d of tr?.days ?? []) {
        const st = stateFor(d.date);
        stateDays[st] = (stateDays[st] ?? 0) + d.hours;
      }
      // Leave pay from the absence engine (usage already capped at available balance).
      const leaveRate = rateOn(w, ps.end);
      for (const a of absence.filter(a => a.workerId === w.id && a.used > 0)) {
        const code = a.plan === 'US Hourly Vacation' ? 'VAC_HRS' : 'SICK_HRS';
        lines.push({ code, hours: a.used, rate: leaveRate, amount: round2(a.used * leaveRate), detail: a.plan });
        tags.push('Event: time off');
      }
      const hasTime = (tr?.days.length ?? 0) > 0;
      if (w.status === 'On Leave(paid)' && !hasTime) {
        const days = eachDay(win[0], win[1]).filter(isWeekday).length;
        const hours = (w.weeklyHours * days) / 5;
        lines.push({ code: 'LEAVE_PAID', hours, rate: leaveRate, amount: round2(hours * leaveRate), detail: 'Paid leave – scheduled hours at base rate' });
        tags.push('Paid leave');
      }
      if (!hasTime && w.status !== 'On Leave(paid)' && !(w.status === 'On Leave(unpaid)')) {
        issues.push({ workerId: w.id, code: 'NO_TIME', severity: 'warning', message: 'Active non-exempt worker with no time entered – paid $0 pending manager approval' });
      }
      for (const dr of tr?.dropped ?? []) tags.push(`Time: ${dr.reason}`);
      if (!hasTime && w.status !== 'On Leave(paid)' && w.termDate && w.termDate <= ps.end) {
        prorated = true;
        prorateReason = `Final pay ${w.termDate}: no time entered, payout only`;
      } else if (w.hireDate > ps.start || (w.termDate && w.termDate < ps.end)) {
        prorated = true;
        prorateReason = w.hireDate > ps.start ? `New hire ${w.hireDate}` : `Termination ${w.termDate}`;
      }
      if (unpaid.size) {
        prorated = true;
        prorateReason = `Unpaid leave from ${[...unpaid].sort()[0]}`;
        tags.push('Event: unpaid leave');
      }
      if (rateOv !== undefined) lines.forEach(l => { if (l.code === 'REG_HRS') l.detail = `Legacy rate ${rateOv}`; });
    }

    // Termination payout (from absence engine)
    for (const a of absence.filter(a => a.workerId === w.id && a.payoutAmount > 0)) {
      const qty = opts.payoutQtyOverride?.get(w.id) ?? a.payoutQty;
      lines.push({ code: 'VAC_PAYOUT', hours: qty, rate: a.rate, amount: round2(qty * a.rate), detail: `${a.plan} payout at termination` });
      tags.push('Termination payout');
    }

    // Bonuses (one-time payments)
    for (const e of model.events.filter(e => e.workerId === w.id && e.type === 'Bonus' && e.start >= ps.start && e.start <= ps.end && /\(USD\)/.test(e.field))) {
      const code = /sign-on/i.test(e.field) ? 'BON_SIGN' : 'BON_SPOT';
      lines.push({ code, amount: round2(Number(e.newValue)), detail: e.notes });
      tags.push(code === 'BON_SIGN' ? 'Event: sign-on bonus' : 'Event: spot bonus');
    }

    if (w.termDate && w.termDate >= ps.start && w.termDate <= ps.end) tags.push(`Termination ${w.termDate} – final pay`);
    // Location change tag
    if (model.events.some(e => e.workerId === w.id && e.type === 'Location Change' && e.start >= ps.start && e.start <= ps.end)) tags.push('Event: location change');

    const earningCodes = new Set(lines.filter(l => model.payCodes.get(l.code)?.category === 'Earning' && l.code !== 'PTO_FLEX').map(l => l.code));
    const gross = round2(lines.filter(l => earningCodes.has(l.code)).reduce((s, l) => s + l.amount, 0));

    // ---------------- deductions & taxes ----------------
    const active = model.inputs.filter(p => p.workerId === w.id && p.start <= ps.end && (!p.end || p.end >= ps.start));
    const k401Rate = active.find(p => p.code === '401K_EE')?.rate ?? 0;
    const s125Items = active.filter(p => ['MED_EE', 'DEN_EE', 'VIS_EE'].includes(p.code));
    const s125Full = s125Items.reduce((s, p) => s + p.amount, 0);
    for (const p of active) {
      if (p.start > ps.start) tags.push(`Pay input: ${p.code} starts ${p.start}`);
      if (p.end && p.end <= ps.end) tags.push(`Pay input: ${p.code} stops ${p.end}`);
    }
    const bonusAmt = lines.filter(l => l.code === 'BON_SIGN' || l.code === 'BON_SPOT').reduce((s, l) => s + l.amount, 0);
    const k401Base = opts.k401ExcludesBonusFor?.has(w.id) ? gross - bonusAmt : gross;
    const k401 = gross > 0 ? round2(k401Rate * k401Base) : 0;

    const ytd = priorYtd(model, w, ps, s125Full);
    base.ytdPriorFica = ytd.fica;
    const totalStateUnits = Object.values(stateDays).reduce((s, v) => s + v, 0);
    const shares: Record<string, number> = {};
    if (totalStateUnits > 0) for (const [st, v] of Object.entries(stateDays)) shares[st] = v / totalStateUnits;
    else shares[stateFor(ps.end)] = 1;
    base.states = shares;

    const tx = rules.usTax;
    const garnEvents = model.events.filter(e => e.workerId === w.id && e.type === 'Garnishment' && e.start <= ps.end && (!e.end || e.end >= ps.start));

    const compute = (s125Taken: number) => {
      const out: PayLine[] = [];
      const ficaWages = Math.max(0, gross - s125Taken);
      const incomeWages = Math.max(0, ficaWages - k401);
      const fitRate = tx.fitFlatRate;
      let fit = incomeWages * fitRate;
      const bonusOv = opts.bonusTaxOverride?.get(w.id);
      if (bonusOv !== undefined && bonusAmt > 0) fit += bonusAmt * (bonusOv - fitRate);
      out.push({ code: 'FIT_EE', amount: round2(fit) });
      for (const [st, share] of Object.entries(shares)) {
        const r = tx.sitRates[st] ?? 0;
        if (r > 0) out.push({ code: `SIT_${st}`, amount: round2(incomeWages * share * r), state: st });
        if (st === 'CA') out.push({ code: 'SDI_CA', amount: round2(ficaWages * share * tx.caSdiRate), state: st });
      }
      const oasdiTaxable = opts.noOasdiCapFor?.has(w.id) ? ficaWages : Math.max(0, Math.min(ficaWages, tx.oasdiWageBase - ytd.fica));
      out.push({ code: 'OASDI_EE', amount: round2(oasdiTaxable * tx.oasdiRate) });
      out.push({ code: 'MEDI_EE', amount: round2(ficaWages * tx.medicareRate) });
      const eeTax = out.reduce((s, l) => s + l.amount, 0);
      // Garnishments on disposable earnings (gross − mandatory taxes)
      const de = Math.max(0, gross - eeTax);
      const garn: PayLine[] = [];
      let deLeft = de;
      for (const e of [...garnEvents].sort((a) => (a.field.includes('Child') ? -1 : 1))) {
        const isCs = /child/i.test(e.field);
        const order = /%/.test(e.newValue) ? (Number((e.newValue.match(/([\d.]+)\s*%/) ?? [])[1]) / 100) * de : parseMoney(e.newValue);
        let cap: number;
        let capNote: string;
        if (isCs) {
          cap = rules.garnishment.childSupportMaxPctOfDisposable * de;
          capNote = `${rules.garnishment.childSupportMaxPctOfDisposable * 100}% of disposable`;
        } else {
          const weeks = 52 / ps.periodsPerYear;
          const threshold = rules.garnishment.creditorWeeklyMinWageMultiple * rules.garnishment.caMinimumWage * weeks;
          cap = Math.min(rules.garnishment.creditorMaxPctOfDisposable * de, rules.garnishment.creditorExcessPct * Math.max(0, de - threshold));
          capNote = 'CA creditor limit';
        }
        const balM = e.notes.match(/remaining balance \$?([\d,]+(?:\.\d+)?)/i);
        const balance = balM ? Number(balM[1].replace(/,/g, '')) : Infinity;
        let take = Math.min(order, balance, deLeft);
        if (!opts.uncappedGarnFor?.has(w.id)) take = Math.min(take, cap);
        take = Math.max(0, round2(take));
        deLeft -= take;
        const capped = take + 0.005 < Math.min(order, balance);
        garn.push({ code: isCs ? 'GARN_CS' : 'GARN_CRED', amount: take, detail: `${e.field}: order ${round2(order).toFixed(2)}${balance !== Infinity ? `, balance ${balance.toFixed(2)} → ${(balance - take).toFixed(2)}` : ''}${capped ? ` – capped at ${capNote}` : ''}` });
      }
      return { taxLines: out, eeTax, garn, de };
    };

    let s125Taken = gross > 0 ? s125Full : 0;
    let res = compute(s125Taken);
    let net = gross - k401 - s125Taken - res.eeTax - res.garn.reduce((s, l) => s + l.amount, 0);
    for (let i = 0; i < 30 && net < -0.004 && s125Taken > 0; i++) {
      s125Taken = Math.max(0, s125Taken + net);
      res = compute(s125Taken);
      net = gross - k401 - s125Taken - res.eeTax - res.garn.reduce((s, l) => s + l.amount, 0);
    }
    s125Taken = round2(s125Taken);
    const arrears = round2(s125Full - s125Taken);

    if (k401 > 0) lines.push({ code: '401K_EE', amount: k401, rate: k401Rate, detail: `${(k401Rate * 100).toFixed(0)}% of ${round2(k401Base).toFixed(2)}` });
    // Allocate the S125 amount taken across items in order (medical, dental, vision).
    let left = s125Taken;
    for (const p of s125Items) {
      const take = round2(Math.min(p.amount, left));
      left -= take;
      if (take > 0) lines.push({ code: p.code, amount: take });
    }
    if (arrears > 0) {
      lines.push({ code: 'BEN_ARR_NEW', amount: arrears, detail: 'Benefits not covered by pay – arrears receivable, collect on return' });
      tags.push('Pay input: benefits arrears created');
      issues.push({ workerId: w.id, code: 'ARREARS', severity: 'warning', message: `Benefit deductions of ${arrears.toFixed(2)} not covered by pay – tracked as arrears` });
    }
    lines.push(...res.taxLines.filter(l => Math.abs(l.amount) > 0.004 || l.code === 'FIT_EE' && gross > 0));
    for (const g of res.garn) {
      lines.push(g);
      tags.push('Event: garnishment');
      if (/capped/.test(g.detail ?? '')) issues.push({ workerId: w.id, code: 'GARN_CAPPED', severity: 'warning', message: g.detail ?? '' });
    }

    // Employer costs
    const ficaWages = Math.max(0, gross - s125Taken);
    const oasdiTaxable = opts.noOasdiCapFor?.has(w.id) ? ficaWages : Math.max(0, Math.min(ficaWages, tx.oasdiWageBase - ytd.fica));
    if (ytd.fica < tx.oasdiWageBase && ytd.fica + ficaWages > tx.oasdiWageBase) {
      tags.push('Social Security wage base reached this period');
    } else if (ytd.fica >= tx.oasdiWageBase) {
      tags.push('Social Security wage base already met');
    }
    const er: PayLine[] = [
      { code: 'OASDI_ER', amount: round2(oasdiTaxable * tx.oasdiRate) },
      { code: 'MEDI_ER', amount: round2(ficaWages * tx.medicareRate) },
      { code: 'FUTA_ER', amount: round2(Math.max(0, Math.min(ficaWages, tx.futaWageBase - ytd.fica)) * tx.futaRate) },
      { code: 'SUI_ER', amount: round2(Math.max(0, Math.min(ficaWages, tx.suiWageBase - ytd.fica)) * tx.suiRate) },
      { code: '401K_ER', amount: round2(Math.min(k401Rate, rules.benefits.k401MatchCapPctOfGross) * rules.benefits.k401MatchPct * k401Base * (gross > 0 ? 1 : 0)) },
      { code: 'BEN_ER', amount: round2(Math.max(0, gross) * rules.benefits.employerLoadPctOfGross) },
    ];
    lines.push(...er.filter(l => l.amount > 0.004));

    const amt = (cat: string) => round2(lines.filter(l => model.payCodes.get(l.code)?.category === cat).reduce((s, l) => s + l.amount, 0));
    base.gross = gross;
    base.pretax = round2(k401 + s125Taken);
    base.eeTaxes = amt('EE Tax');
    base.postTax = round2(res.garn.reduce((s, l) => s + l.amount, 0));
    base.net = round2(gross - base.pretax - base.eeTaxes - base.postTax);
    base.erCost = amt('ER Cost');
    base.burdened = round2(gross + base.erCost);
    base.arrearsCreated = arrears;
    lines.push({ code: 'NET_PAY', amount: base.net });

    // ---------------- headcount bucket ----------------
    if (gross <= 0.004) {
      base.bucket = 'Active, not paid';
      if (unpaid.size) base.bucketReason = 'Unpaid leave for the whole period';
      else if ((time.get(w.id)?.dropped.length ?? 0) > 0 && !(time.get(w.id)?.days.length)) base.bucketReason = 'Only time entered after termination (not paid)';
      else base.bucketReason = 'No time entered';
    } else if (prorated) {
      base.bucket = 'Paid prorated';
      base.bucketReason = prorateReason;
    } else {
      base.bucket = 'Paid full period';
      base.bucketReason = w.termDate && w.termDate > ps.end ? `Termination ${w.termDate} falls in a later period` : '';
    }
    if (lines.some(l => l.code === 'RETRO_HRS')) tags.push('Retro: prior-period time correction');
    if (lines.some(l => l.code === 'MEAL_PEN')) tags.push('Time: meal penalty');
    base.tags = [...new Set(tags)];
    rows.push(base);
  }
  return rows;
}

export function overlapsPeriod(start: string, end: string, ps: PaySchedule): boolean {
  return overlap(start, end, ps.start, ps.end) !== null;
}
