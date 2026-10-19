// Absence: roll each plan balance forward from its as-of date to the end of the worker's
// current pay period. ending = opening + accrued − used − paid out.
//
// Accrual methods (data/rules.json):
//   per_hour_worked – hourly: hours worked from the time engine; exempt: assumed
//                     40 hrs/week on paid working days. State sick plans accrue only on
//                     days the worker works in that state (movers freeze on the move date).
//   monthly         – perMonth × share of the month's working days employed and paid.
//   frontloaded     – granted at the start of the year, no accrual in the period.
//   none            – Flexible PTO: no balance; hours used are tracked for the payslip.
// Payout on termination: days × (annual / 52 / 5) or hours × base rate (US hourly).

import type { Model, Worker, AbsenceRow, TimeResult, Balance } from './types.ts';
import { addDays, eachDay, isWeekday, round2, round4, workingDays } from './dates.ts';
import { employmentWindow, unpaidLeaveDates, isEmployee } from './employment.ts';
import { rateOn, stateOn } from './model.ts';

const STATE_PLANS: Record<string, string> = {
  'CA Paid Sick Leave': 'CA', 'NY Paid Sick Leave': 'NY', 'MA Earned Sick Time': 'MA',
  'IL Paid Leave for All Workers': 'IL', 'CO Paid Sick Leave': 'CO',
};

const DEFAULT_ASOF: Record<string, string> = {
  'US Biweekly': '2026-10-03', 'US Semi-monthly': '2026-09-30', 'UK Monthly': '2026-09-30',
  'India Monthly': '2026-09-30', 'Canada Monthly': '2026-09-30',
};

export function payoutRate(w: Worker, unit: string, date: string): number {
  const rate = rateOn(w, date);
  if (w.payRateType === 'Hourly') return unit === 'days' ? rate * 8 : rate;
  const daily = rate / 52 / 5; // (annual / 52 weeks) / 5 working days per week
  return unit === 'days' ? daily : daily / 8;
}

/** Plans that should exist but are missing in the balance file get added at 0 and flagged. */
function withMissingPlans(model: Model): (Balance & { added?: string })[] {
  const rows: (Balance & { added?: string })[] = model.balances.map(b => ({ ...b }));
  const has = (id: string, plan: string) => rows.some(r => r.workerId === id && r.plan === plan);
  for (const w of model.workers) {
    if (!isEmployee(w)) continue;
    const ps = model.schedules.get(w.payGroup);
    if (!ps) continue;
    if (w.country === 'US') {
      const caDuring = eachDay(ps.start, ps.end).some(d => stateOn(w, d) === 'CA');
      if (caDuring && !has(w.id, 'CA Paid Sick Leave')) {
        rows.push({ workerId: w.id, plan: 'CA Paid Sick Leave', balance: 0, unlimited: false, unit: 'hrs', lastAccrual: '', notes: '', added: 'Plan missing in balance file – added at 0 (works in CA this period)' });
      }
    }
    if (w.country === 'IN' && !has(w.id, 'India Sick/Casual Leave')) {
      rows.push({ workerId: w.id, plan: 'India Sick/Casual Leave', balance: 0, unlimited: false, unit: 'days', lastAccrual: '', notes: '', added: 'Plan missing in balance file – added at 0' });
    }
  }
  return rows;
}

export function calcAbsence(model: Model, time: Map<string, TimeResult>): AbsenceRow[] {
  const out: AbsenceRow[] = [];
  for (const b of withMissingPlans(model)) {
    const w = model.workerById.get(b.workerId);
    if (!w || !isEmployee(w)) continue;
    const ps = model.schedules.get(w.payGroup);
    if (!ps) continue;
    const rule = model.rules.absence[b.plan];
    const flags: string[] = [];
    if (b.added) flags.push(b.added);
    if (!rule) flags.push('No accrual rule configured for this plan');
    const unit = rule?.unit ?? (b.unit === 'days' ? 'days' : 'hrs');
    const asOf = b.lastAccrual || DEFAULT_ASOF[w.payGroup] || addDays(ps.start, -1);
    const winStart = addDays(asOf, 1);
    const winEnd = ps.end;
    const emp = employmentWindow(w, winStart, winEnd);
    const unpaid = unpaidLeaveDates(model, w, winStart, winEnd);
    const unlimited = b.unlimited || !!rule?.unlimited;
    let opening: number | null = unlimited ? null : (b.balance ?? 0);
    if (!unlimited && b.balance === null && !b.added) {
      flags.push('Balance blank in source – treated as 0');
      opening = 0;
    }
    if (b.workerId && w.state === 'Telangana' && /Karnataka/i.test(b.notes)) {
      flags.push('Statute label says Karnataka; worker is in Telangana – relabel (same accrual)');
    }
    const stateReq = STATE_PLANS[b.plan];

    // ---- accrual ----
    let accrued = 0;
    let basis = unlimited ? 'Unlimited plan; no accrual' : !rule ? 'No rule' : !emp ? 'Not employed in the window' : rule.method === 'frontloaded' ? 'Front-loaded annually; no accrual this period' : rule.method === 'none' ? 'No accrual' : '';
    const fmtN = (n: number, d = 2) => String(Math.round(n * 10 ** d) / 10 ** d);
    const why = () => {
      const parts: string[] = [];
      if (w.hireDate >= winStart && w.hireDate <= winEnd) parts.push(`hired ${w.hireDate}`);
      if (w.termDate && w.termDate >= winStart && w.termDate <= winEnd) parts.push(`terminated ${w.termDate}`);
      if (unpaid.size) parts.push(`${unpaid.size} unpaid leave day${unpaid.size > 1 ? 's' : ''}`);
      return parts.join(', ');
    };
    if (rule && emp && !unlimited) {
      if (rule.method === 'per_hour_worked') {
        const tr = time.get(w.id);
        if (w.payRateType === 'Hourly') {
          const hours = tr ? tr.days.filter(d => d.date >= winStart && d.date <= winEnd && (!stateReq || stateOn(w, d.date) === stateReq)).reduce((s, d) => s + d.hours, 0) : 0;
          accrued = hours * (rule.rate ?? 0);
          basis = `${fmtN(hours)} hrs worked × ${rule.rate}`;
        } else {
          const perDay = (rule.exemptWeeklyHours ?? 40) / 5;
          const days = eachDay(emp[0], emp[1]).filter(d => isWeekday(d) && !unpaid.has(d) && (!stateReq || stateOn(w, d) === stateReq));
          accrued = days.length * perDay * (rule.rate ?? 0);
          const allWd = eachDay(winStart, winEnd).filter(isWeekday).length;
          basis = `${days.length}/${allWd} working days × ${perDay} hrs × ${rule.rate}`;
          if (days.length < allWd && why()) flags.push(`Prorated: ${why()} (${days.length}/${allWd} working days)`);
          if (stateReq && days.length < eachDay(emp[0], emp[1]).filter(isWeekday).length - unpaid.size) {
            flags.push(`Accrual only on days worked in ${stateReq} (location change)`);
          }
        }
      } else if (rule.method === 'monthly') {
        const mStart = winStart;
        const totalWd = workingDays(mStart, winEnd);
        const paidWd = eachDay(emp[0], emp[1]).filter(d => isWeekday(d) && !unpaid.has(d)).length;
        accrued = (rule.perMonth ?? 0) * (totalWd ? paidWd / totalWd : 0);
        basis = `${rule.perMonth} days × ${paidWd}/${totalWd} working days`;
        if (paidWd < totalWd && why()) flags.push(`Prorated: ${why()} (${paidWd}/${totalWd} working days)`);
      }
      if (unpaid.size && !flags.some(f => f.startsWith('Prorated:'))) flags.push('Accrual paused on unpaid leave days');
      if (rule.cap !== undefined && opening !== null) {
        const room = Math.max(0, rule.cap - opening);
        if (accrued > room) {
          flags.push(opening >= rule.cap ? `At ${rule.cap} cap – no accrual` : `Accrual limited by ${rule.cap} cap`);
          accrued = room;
          basis += ` → capped at ${rule.cap}`;
        }
      }
    }

    // ---- usage ----
    let used = 0;
    const usedEvents = model.events.filter(e => e.workerId === w.id && e.type === 'Time Off' && e.plan === b.plan && e.start >= winStart && e.start <= winEnd && e.status !== 'Cancelled' && (!w.termDate || e.start <= w.termDate));
    for (const e of usedEvents) used += e.qty;
    const future = model.events.filter(e => e.workerId === w.id && e.type === 'Time Off' && e.plan === b.plan && e.start > winEnd);
    if (future.length) flags.push(`${future.length} future-dated request(s) excluded (next period)`);
    if (opening !== null && used > opening + accrued + 1e-9) {
      flags.push(`Requested ${used} exceeds available ${round2(opening + accrued)} – usage capped`);
      used = Math.max(0, opening + accrued);
    }

    // ---- payout ----
    let payoutQty = 0;
    let payoutAmount = 0;
    const terminated = !!w.termDate && w.termDate <= winEnd && w.termDate >= winStart;
    const rate = payoutRate(w, unit, w.termDate && w.termDate <= winEnd ? w.termDate : winEnd);
    let ending: number | null = opening === null ? null : opening + accrued - used;
    if (terminated && rule?.payout && ending !== null) {
      payoutQty = Math.max(0, ending);
      payoutAmount = payoutQty * rate;
      ending = 0;
      flags.push('Terminated – balance paid out');
    } else if (terminated && opening !== null && ending !== null) {
      flags.push(`Terminated – plan has no payout; ${round2(ending)} ${unit} forfeited`);
      ending = 0;
    }

    const liab = (q: number | null) => (rule?.payout && q !== null ? q * rate : 0);
    out.push({
      workerId: w.id, plan: b.plan, unit, asOf, windowEnd: winEnd,
      opening: opening === null ? null : round4(opening), accrued: round4(accrued), used: round4(used),
      payoutQty: round4(payoutQty), payoutAmount: round2(payoutAmount),
      ending: ending === null ? null : round4(ending), currency: w.currency, rate: round4(rate),
      liabilityOpening: round2(liab(opening)), liabilityEnding: round2(liab(ending)),
      usedYtdNote: unlimited ? `${used} hrs used this period (unlimited plan)` : '', flags, accrualBasis: basis,
    });
  }
  return out;
}
