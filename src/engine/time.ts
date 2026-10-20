// Time calculation for the non-exempt (US Biweekly) population.
//
// Order of evaluation (Module 3 decision 3.5):
//   1. clean punches (drop duplicates, drop time outside hire/term, apply roster)
//   2. daily hours (overnight shifts credited to the start date)
//   3. CA daily OT (>8) and DT (>12)
//   4. CA 7th consecutive day in the workweek (1.5x first 8, 2x after)
//   5. weekly OT (>40) on remaining straight hours  — no hour counted twice
//   6. differentials (night $3.00 22:00–06:00, else NGHT $2.50 / WKND $1.00; no stacking)
//   7. meal penalties (CA; missed per attestation, late after hour 5, or no second meal on a shift over 12 hours; max 1/day)
//   8. weighted weekly regular rate = (straight pay + differentials) / hours worked
//   9. premiums: OT = hours x (base + 0.5 x RR); DT and 7th-day >8 = hours x (base + 1.0 x RR)

import type { Model, Worker, TimeEntry, TimeResult, DayTrace, PayLine, Issue, PaySchedule } from './types.ts';
import { hm, weekStart, weekday, DAY_NAMES, round2, round4, addDays } from './dates.ts';
import { rateOn } from './model.ts';

const NIGHT_START = 22 * 60;
const NIGHT_END = 6 * 60;

interface DayCalc {
  workedMin: number; nightMin: number; mealPresent: boolean; mealLate: boolean;
}

/** Minutes worked and minutes inside the night window for one punch set. */
export function calcDay(timeIn: string, timeOut: string, mealStart: string, mealEnd: string): DayCalc {
  const i = hm(timeIn);
  let o = hm(timeOut);
  if (o <= i) o += 1440;
  const segments: [number, number][] = [];
  let mealPresent = false;
  let mealLate = false;
  if (mealStart && mealEnd) {
    let ms = hm(mealStart);
    if (ms < i) ms += 1440;
    let me = hm(mealEnd);
    while (me < ms) me += 1440;
    mealPresent = true;
    mealLate = ms - i > 5 * 60;
    segments.push([i, ms], [me, o]);
  } else {
    segments.push([i, o]);
  }
  let worked = 0;
  let night = 0;
  for (const [a, b] of segments) {
    worked += Math.max(0, b - a);
    // Night windows: 22:00 day-1 → 06:00 day0, 22:00 day0 → 06:00 day1, 22:00 day1 → 06:00 day2
    for (const k of [-1, 0, 1]) {
      const ws = k * 1440 + NIGHT_START;
      const we = k * 1440 + 1440 + NIGHT_END;
      night += Math.max(0, Math.min(b, we) - Math.max(a, ws));
    }
  }
  return { workedMin: worked, nightMin: night, mealPresent, mealLate };
}

export function effectiveShift(model: Model, w: Worker, date: string): string {
  const rows = model.roster.filter(r => r.workerId === w.id && r.date === date);
  if (!rows.length) return w.defaultShift;
  return rows.reduce((a, b) => (b.seq >= a.seq ? b : a)).shiftCode;
}

interface DayWork {
  date: string; shift: string; entry: TimeEntry; workedH: number; nightH: number;
  base: number; diffPay: number; mealPenalty: boolean; flags: string[];
}

function dayPremiumSplit(isCa: boolean, hours: number, seventh: boolean) {
  if (!isCa) return { reg: hours, ot: 0, dt: 0, svd15: 0, svd20: 0 };
  if (seventh) return { reg: 0, ot: 0, dt: 0, svd15: Math.min(hours, 8), svd20: Math.max(0, hours - 8) };
  return { reg: Math.min(hours, 8), ot: Math.min(Math.max(hours - 8, 0), 4), dt: Math.max(hours - 12, 0), svd15: 0, svd20: 0 };
}

export function calcTimeForWorker(model: Model, w: Worker, ps: PaySchedule): TimeResult {
  const rules = model.rules.time;
  const group = w.timeCalcGroup || (w.state === 'CA' ? 'US California Non-Exempt' : 'US Non-California Non-Exempt');
  const isCa = group === 'US California Non-Exempt';
  const weeklyLimit = model.rules.time.groups[group]?.weeklyOtAfter ?? 40;
  const issues: Issue[] = [];
  const dropped: { date: string; reason: string }[] = [];

  const mine = model.timesheets.filter(t => t.workerId === w.id);
  const current = mine.filter(t => t.payPeriod !== 'Prior period' && t.date >= ps.start && t.date <= ps.end);

  // 1. Clean punches
  const seen = new Set<string>();
  const kept: TimeEntry[] = [];
  for (const t of current) {
    const key = [t.date, t.timeIn, t.timeOut, t.mealStart, t.mealEnd].join('|');
    if (seen.has(key)) {
      dropped.push({ date: t.date, reason: 'Duplicate punch removed (not paid)' });
      issues.push({ workerId: w.id, code: 'DUPLICATE_PUNCH', severity: 'warning', message: `Duplicate punch on ${t.date} removed`, ref: t.date });
      continue;
    }
    seen.add(key);
    if (w.termDate && t.date > w.termDate) {
      dropped.push({ date: t.date, reason: `Time after termination (${w.termDate}) – not paid` });
      issues.push({ workerId: w.id, code: 'TIME_AFTER_TERM', severity: 'error', message: `Time entered on ${t.date} after term date ${w.termDate}; excluded from pay`, ref: t.date });
      continue;
    }
    if (w.hireDate && t.date < w.hireDate) {
      dropped.push({ date: t.date, reason: `Time before hire (${w.hireDate}) – not paid` });
      issues.push({ workerId: w.id, code: 'TIME_BEFORE_HIRE', severity: 'error', message: `Time on ${t.date} before hire date`, ref: t.date });
      continue;
    }
    if (!t.timeIn || !t.timeOut) {
      dropped.push({ date: t.date, reason: 'Missing punch – not paid until corrected' });
      issues.push({ workerId: w.id, code: 'MISSING_PUNCH', severity: 'error', message: `Missing In/Out punch on ${t.date}`, ref: t.date });
      continue;
    }
    kept.push(t);
  }

  // 2. Daily hours + 6. differentials + 7. meal checks
  const days: DayWork[] = [];
  for (const t of kept.sort((a, b) => (a.date + a.timeIn).localeCompare(b.date + b.timeIn))) {
    const shift = effectiveShift(model, w, t.date);
    const flags: string[] = [];
    const sc = model.shiftCodes.get(shift);
    if (sc) {
      let variance = hm(t.timeIn) - hm(sc.start);
      if (variance > 720) variance -= 1440;
      if (variance < -720) variance += 1440;
      if (Math.abs(variance) > rules.offScheduleToleranceMinutes) {
        flags.push('Off-schedule');
        issues.push({ workerId: w.id, code: 'OFF_SCHEDULE', severity: 'warning', message: `${t.date}: punch-in ${t.timeIn} vs ${shift} start ${sc.start}`, ref: t.date });
      }
    }
    if (t.shiftCode && t.shiftCode !== shift) flags.push(`Entry coded ${t.shiftCode}, roster ${shift}`);
    const dc = calcDay(t.timeIn, t.timeOut, t.mealStart, t.mealEnd);
    const workedH = round4(dc.workedMin / 60);
    const nightH = round4(dc.nightMin / 60);
    const base = rateOn(w, t.date);
    const shiftRate = rules.shiftDifferentials[shift] ?? 0;
    const nightRate = rules.nightWindow.ratePerHour;
    // No stacking: each hour gets the higher applicable differential.
    const diffPay = nightH * Math.max(nightRate, shiftRate) + (workedH - nightH) * shiftRate;

    let mealPenalty = false;
    const mp = model.rules.time.groups[group]?.mealPenalty;
    if (workedH > 5) {
      if (!dc.mealPresent) {
        const att = (t.mealAttestation || '').toLowerCase();
        if (mp) {
          if (att === 'waived') {
            flags.push('No meal – worker attested meal waived (no penalty)');
          } else {
            mealPenalty = true;
            flags.push(att === 'missed' ? 'Missed meal (attested) – penalty' : 'Missed meal – no attestation, penalty applied');
            if (att !== 'missed') issues.push({ workerId: w.id, code: 'MEAL_ATTESTATION_MISSING', severity: 'warning', message: `${t.date}: no meal and no attestation; penalty applied pending worker answer`, ref: t.date });
          }
        } else {
          flags.push(`No meal recorded (${att || 'no attestation'}) – no state penalty`);
          issues.push({ workerId: w.id, code: 'MEAL_EXCEPTION_NONCA', severity: 'info', message: `${t.date}: no meal recorded; flagged only (no penalty outside CA)`, ref: t.date });
        }
      } else if (dc.mealLate) {
        if (mp) {
          mealPenalty = true;
          flags.push('Late meal (after hour 5) – penalty');
        } else {
          flags.push('Late meal – flagged only');
          issues.push({ workerId: w.id, code: 'MEAL_EXCEPTION_NONCA', severity: 'info', message: `${t.date}: meal started after hour 5; flagged only`, ref: t.date });
        }
      }
      // CA: a shift over 12 hours requires a second meal period, and it cannot be waived (Labor Code 512).
      // Punches carry at most one meal, so any CA shift over 12 hours owes the premium (still max 1 per day).
      if (mp && workedH > 12) {
        if (!mealPenalty) {
          mealPenalty = true;
          flags.push('No second meal on a shift over 12 hours – penalty (cannot be waived)');
        } else flags.push('No second meal on a shift over 12 hours (premium already owed today; max 1 per day)');
      }
    }
    if (dc.workedMin > 0 && hm(t.timeOut) <= hm(t.timeIn)) flags.push('Crosses midnight – credited to start date');
    days.push({ date: t.date, shift, entry: t, workedH, nightH, base, diffPay, mealPenalty, flags });
  }

  // Merge multiple entries on the same day (split shifts) by summing.
  const byDate = new Map<string, DayWork[]>();
  for (const d of days) byDate.set(d.date, [...(byDate.get(d.date) ?? []), d]);

  // Weeks
  const weeksMap = new Map<string, string[]>();
  for (const date of [...byDate.keys()].sort()) {
    const ws = weekStart(date);
    weeksMap.set(ws, [...(weeksMap.get(ws) ?? []), date]);
  }

  const trace: DayTrace[] = [];
  const weeks: TimeResult['weeks'] = [];
  const totals: Record<string, { hours: number; amount: number }> = {};
  const add = (code: string, hours: number, amount: number) => {
    totals[code] = totals[code] ?? { hours: 0, amount: 0 };
    totals[code].hours += hours;
    totals[code].amount += amount;
  };

  for (const [ws, dates] of [...weeksMap.entries()].sort()) {
    const workedDates = dates.filter(d => byDate.get(d)!.some(x => x.workedH > 0));
    const seventhDate = isCa && workedDates.length === 7 ? addDays(ws, 6) : '';
    let cumReg = 0;
    let hoursWeek = 0;
    let straightPay = 0;
    let diffPayWeek = 0;
    const dayRows: { date: string; split: ReturnType<typeof dayPremiumSplit>; work: DayWork[]; hours: number; base: number }[] = [];
    for (const date of dates) {
      const work = byDate.get(date)!;
      const hours = round4(work.reduce((s, x) => s + x.workedH, 0));
      const base = work[0].base;
      const split = dayPremiumSplit(isCa, hours, date === seventhDate);
      // 5. weekly OT on remaining straight hours
      const allowed = Math.max(0, weeklyLimit - cumReg);
      const regKept = Math.min(split.reg, allowed);
      split.ot += split.reg - regKept;
      split.reg = regKept;
      cumReg += regKept;
      hoursWeek += hours;
      straightPay += hours * base;
      diffPayWeek += work.reduce((s, x) => s + x.diffPay, 0);
      dayRows.push({ date, split, work, hours, base });
    }
    const rr = hoursWeek > 0 ? (straightPay + diffPayWeek) / hoursWeek : 0;
    weeks.push({ weekStart: ws, hours: round4(hoursWeek), straightPay: round2(straightPay), diffPay: round2(diffPayWeek), regularRate: round4(rr) });

    for (const d of dayRows) {
      const { split, base } = d;
      add('REG_HRS', split.reg, split.reg * base);
      add('OT_15', split.ot, split.ot * (base + 0.5 * rr));
      add('DT_20', split.dt, split.dt * (base + rr));
      add('SVD_15', split.svd15, split.svd15 * (base + 0.5 * rr));
      add('SVD_20', split.svd20, split.svd20 * (base + rr));
      const shift = d.work[0].shift;
      const nightH = d.work.reduce((s, x) => s + x.nightH, 0);
      const nonNight = d.hours - nightH;
      const shiftRate = rules.shiftDifferentials[shift] ?? 0;
      const nightRate = rules.nightWindow.ratePerHour;
      if (nightH > 0) {
        if (nightRate >= shiftRate) add('DIFF_NGT', nightH, nightH * nightRate);
        else add(shift === 'NGHT' ? 'DIFF_NGHT' : 'DIFF_WKND', nightH, nightH * shiftRate);
      }
      if (nonNight > 0 && shiftRate > 0) add(shift === 'NGHT' ? 'DIFF_NGHT' : 'DIFF_WKND', nonNight, nonNight * shiftRate);
      const meal = d.work.some(x => x.mealPenalty);
      if (meal) add('MEAL_PEN', 1, rr);
      const flags = d.work.flatMap(x => x.flags);
      if (d.date === seventhDate) flags.push('7th consecutive day in workweek');
      trace.push({
        date: d.date, day: DAY_NAMES[weekday(d.date)], shift, timeIn: d.work[0].entry.timeIn,
        timeOut: d.work[d.work.length - 1].entry.timeOut, hours: d.hours, nightHours: round4(nightH),
        reg: round4(split.reg), ot: round4(split.ot), dt: round4(split.dt), svd15: round4(split.svd15),
        svd20: round4(split.svd20), mealPenalty: meal, baseRate: base, flags, week: ws,
      });
    }
  }

  const lines: PayLine[] = [];
  for (const code of ['REG_HRS', 'OT_15', 'DT_20', 'SVD_15', 'SVD_20', 'DIFF_NGT', 'DIFF_NGHT', 'DIFF_WKND', 'MEAL_PEN']) {
    const t = totals[code];
    if (t && (t.hours > 0.00001 || Math.abs(t.amount) > 0.004)) {
      lines.push({ code, hours: round4(t.hours), amount: round2(t.amount), rate: t.hours ? round4(t.amount / t.hours) : undefined });
    }
  }

  // Time off (hourly): paid at base rate, not counted as hours worked.
  const leaveHours: Record<string, number> = {};
  const leaveEvents = model.events.filter(e => e.workerId === w.id && e.type === 'Time Off' && e.start >= ps.start && e.start <= ps.end && e.status !== 'Cancelled');
  for (const e of leaveEvents) {
    if (w.termDate && e.start > w.termDate) continue;
    leaveHours[e.plan] = (leaveHours[e.plan] ?? 0) + e.qty;
  }

  // Prior-period retro corrections (paid this period as RETRO_HRS)
  const retro = mine.filter(t => t.payPeriod === 'Prior period' && t.entryType.toLowerCase().includes('retro'));
  for (const t of retro) {
    const base = rateOn(w, t.date);
    const shift = effectiveShift(model, w, t.date);
    const payFor = (timeOut: string | null) => {
      if (!timeOut) return { hours: 0, pay: 0 };
      const dc = calcDay(t.timeIn, timeOut, t.mealStart, t.mealEnd);
      const h = dc.workedMin / 60;
      const nightH = dc.nightMin / 60;
      const shiftRate = rules.shiftDifferentials[shift] ?? 0;
      const diff = nightH * Math.max(rules.nightWindow.ratePerHour, shiftRate) + (h - nightH) * shiftRate;
      const rr = h > 0 ? (h * base + diff) / h : base;
      const s = dayPremiumSplit(isCa, h, false);
      return { hours: h, pay: s.reg * base + s.ot * (base + 0.5 * rr) + s.dt * (base + rr) + diff };
    };
    const m = t.notes.match(/Out changed\s*(\d{1,2}:\d{2})\s*[→>-]+\s*(\d{1,2}:\d{2})/);
    const prevOut = m ? m[1] : null; // "missing Out punch added" → previously paid nothing
    const now = payFor(t.timeOut);
    const before = payFor(prevOut);
    const amt = round2(now.pay - before.pay);
    if (Math.abs(amt) > 0.004) {
      lines.push({ code: 'RETRO_HRS', hours: round4(now.hours - before.hours), amount: amt, detail: `Retro for ${t.date}: ${round2(before.hours)}h paid → ${round2(now.hours)}h corrected` });
      issues.push({ workerId: w.id, code: 'RETRO_TIME', severity: 'info', message: `Prior-period correction for ${t.date} paid as retro (${amt.toFixed(2)})`, ref: t.date });
    }
  }

  const hoursWorked = round4(trace.reduce((s, d) => s + d.hours, 0));
  return { workerId: w.id, group, days: trace, weeks, lines, hoursWorked, leaveHours, dropped, issues };
}
