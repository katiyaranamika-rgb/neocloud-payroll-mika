// Builds the effective-dated model from the raw CSV rows.
//
// Effective dating: the worker file holds each worker's CURRENT (post-change) rate and
// location. Comp Change and Location Change events carry the old value and the effective
// date, so we rebuild a history: [{from: beginning, value: old}, {from: effective, value: new}].
// Every calculation asks "what was true on this date?" through valueOn().

import type {
  DataSet, Model, Worker, Event, TimeEntry, RosterRow, PayInput, Balance, PaySchedule,
  PayCode, GlAccount, DatedValue, Issue,
} from './types.ts';
import type { Row } from './csv.ts';
import { adjustToBusinessDay } from './dates.ts';

const BEGINNING = '0000-01-01';

const num = (v: string | undefined): number => {
  if (v === undefined || v === null || v === '') return NaN;
  return Number(String(v).replace(/[^0-9.\-]/g, ''));
};
const numOr = (v: string | undefined, d: number): number => {
  const n = num(v);
  return Number.isFinite(n) ? n : d;
};

export function valueOn<T>(hist: DatedValue<T>[], date: string): T {
  let v = hist[0].value;
  for (const h of hist) if (h.from <= date) v = h.value;
  return v;
}

function parseStateFromLocation(v: string): { state: string; location: string } {
  const m = v.match(/^(.*),\s*([A-Z]{2})$/);
  return m ? { location: m[1].trim(), state: m[2] } : { location: v.trim(), state: '' };
}

export function buildModel(ds: DataSet): Model {
  const issues: Issue[] = [];

  const events: Event[] = ds.events.map((r: Row) => ({
    id: r.event_id, workerId: r.worker_id, type: r.event_type, start: r.effective_start,
    end: r.effective_end, plan: r.time_off_plan, qty: numOr(r.quantity, 0), unit: r.unit,
    status: r.status, notes: r.notes, field: r.change_field, oldValue: r.old_value, newValue: r.new_value,
  })).filter(e => e.workerId);

  const workers: Worker[] = ds.workers.map((r: Row) => {
    const annual = num(r.annual_salary);
    const hourly = num(r.hourly_rate);
    const isSalary = r.pay_rate_type === 'Salary';
    const current = isSalary ? annual : hourly;
    const w: Worker = {
      id: r.id, dept: r.dept, location: r.location, state: r.state, country: r.country,
      level: r.level, flsa: r.flsa, payRateType: r.pay_rate_type,
      annualSalary: Number.isFinite(annual) ? annual : null,
      hourlyRate: Number.isFinite(hourly) ? hourly : null, currency: r.currency,
      payGroup: r.pay_group, hireDate: r.hire_date, termDate: r.term_date,
      leaveStartDate: r.leave_start_date, managerId: r.manager_id, status: r.status,
      workerType: r.worker_type, weeklyHours: numOr(r.weekly_hours, 40), timeType: r.time_type,
      timeCalcGroup: r.time_calc_group, defaultShift: r.default_shift, notes: r.notes,
      rateHistory: [{ from: BEGINNING, value: Number.isFinite(current) ? current : 0, source: 'worker file' }],
      locationHistory: [{ from: BEGINNING, value: { state: r.state, location: r.location }, source: 'worker file' }],
      supOrg: '', costCenter: r.dept,
    };
    return w;
  });
  const workerById = new Map(workers.map(w => [w.id, w]));

  // Effective-dated history from events.
  for (const e of events) {
    const w = workerById.get(e.workerId);
    if (!w) {
      issues.push({ workerId: e.workerId, code: 'EVENT_UNKNOWN_WORKER', severity: 'error', message: `Event ${e.id} references unknown worker`, ref: e.id });
      continue;
    }
    if (e.type === 'Comp Change') {
      const oldV = num(e.oldValue); const newV = num(e.newValue);
      if (Number.isFinite(oldV) && Number.isFinite(newV)) {
        w.rateHistory = [
          { from: BEGINNING, value: oldV, source: `${e.id} old value` },
          { from: e.start, value: newV, source: `${e.id} effective ${e.start}` },
        ];
        const current = w.payRateType === 'Salary' ? w.annualSalary : w.hourlyRate;
        if (current !== null && Math.abs(current - newV) > 0.001) {
          issues.push({ workerId: w.id, code: 'COMP_MISMATCH', severity: 'warning', message: `Worker file rate ${current} differs from event new value ${newV}`, ref: e.id });
        }
      }
    }
    if (e.type === 'Location Change') {
      const oldL = parseStateFromLocation(e.oldValue);
      const newL = parseStateFromLocation(e.newValue);
      w.locationHistory = [
        { from: BEGINNING, value: { state: oldL.state || w.state, location: oldL.location }, source: `${e.id} old value` },
        { from: e.start, value: { state: newL.state || w.state, location: newL.location }, source: `${e.id} effective ${e.start}` },
      ];
      if (newL.state && newL.state !== w.state) {
        issues.push({ workerId: w.id, code: 'LOCATION_MISMATCH', severity: 'warning', message: `Worker file state ${w.state} differs from event new state ${newL.state}`, ref: e.id });
      }
    }
  }

  // Supervisory orgs from the manager chain. Each manager leads "SO-<manager id>".
  // A worker belongs to their manager's org and inherits its default cost center (the
  // leader's dept). Leaders charge to the org they lead (so a department head who reports
  // to the CEO is charged to their own department, not G&A).
  const leaders = new Set(workers.map(w => w.managerId).filter(Boolean));
  for (const w of workers) {
    w.supOrg = w.managerId ? `SO-${w.managerId}` : 'SO-ROOT';
    if (leaders.has(w.id)) {
      w.costCenter = w.dept;
    } else {
      const mgr = workerById.get(w.managerId);
      w.costCenter = mgr ? mgr.dept : w.dept;
    }
    if (w.costCenter !== w.dept) {
      issues.push({ workerId: w.id, code: 'COST_CENTER_MISMATCH', severity: 'warning', message: `Derived cost center ${w.costCenter} differs from worker dept ${w.dept}` });
    }
  }

  const timesheets: TimeEntry[] = ds.timesheets.map((r: Row, idx: number) => ({
    idx, workerId: r.worker_id, date: r.work_date, timeIn: r.time_in, timeOut: r.time_out,
    mealStart: r.meal_start, mealEnd: r.meal_end, shiftCode: r.shift_code, entryType: r.entry_type,
    enteredOn: r.entered_on, payPeriod: r.pay_period, state: r.state, notes: r.notes,
    mealAttestation: r.meal_attestation ?? '',
  })).filter(t => t.workerId && t.date);

  const roster: RosterRow[] = ds.shift_roster.map((r: Row, i: number) => ({
    seq: numOr(r.seq, i + 1), workerId: r.worker_id, date: r.date, shiftCode: r.shift_code,
    source: r.source, reason: r.reason,
  })).filter(r => r.workerId);

  const inputs: PayInput[] = ds.payroll_inputs.map((r: Row) => ({
    workerId: r.worker_id, code: r.code, rate: numOr(r.rate, 0), amount: numOr(r.amount, 0),
    start: r.effective_start, end: r.effective_end, notes: r.notes,
  })).filter(p => p.workerId && p.code);

  const balances: Balance[] = ds.absence_balances.map((r: Row) => ({
    workerId: r.worker_id, plan: r.plan,
    balance: r.balance === '' || r.balance === undefined ? null : num(r.balance),
    unlimited: r.unlimited === 'Y', unit: r.unit, lastAccrual: r.last_accrual_date, notes: r.notes,
  })).filter(b => b.workerId);

  const schedules = new Map<string, PaySchedule>();
  for (const r of ds.pay_schedule) {
    const freq = r.frequency;
    const ppy = freq === 'Semi-monthly' ? 24 : freq === 'Bi-weekly' ? 26 : 12;
    schedules.set(r.pay_group, {
      payGroup: r.pay_group, country: r.country, frequency: freq, start: r.period_start,
      end: r.period_end, payDateOriginal: r.pay_date_original,
      payDate: adjustToBusinessDay(r.pay_date_original), periodsPerYear: ppy,
    });
  }

  const shiftCodes = new Map(ds.shift_codes.map((r: Row) => [r.code, {
    code: r.code, start: r.start, end: r.end, paidHours: numOr(r.paid_hours, 8),
  }]));

  const payCodes = new Map<string, PayCode>(ds.pay_codes.map((r: Row) => [r.code, {
    code: r.code, name: r.name, category: r.category, calcBasis: r.calc_basis, fedBy: r.fed_by,
    taxability: r.taxability, inRegularRate: r.in_regular_rate === 'Y',
    k401Eligible: r.k401_eligible === 'Y', active: r.active !== 'N',
  }]));
  const glAccounts = new Map<string, GlAccount>(ds.gl_accounts.map((r: Row) => [r.account, { account: r.account, name: r.name, type: r.type, segmentLevel: r.segment_level }]));
  const departments = new Map(ds.departments.map((r: Row) => [r.dept, { netsuite: r.netsuite_department, plFunction: r.pl_function }]));
  const subsidiaries = ds.subsidiaries.map((r: Row) => ({ subsidiary: r.subsidiary, currency: r.currency, payGroups: r.pay_groups.split('|') }));

  return {
    rules: ds.rules, workers, workerById, events, timesheets, roster, inputs, balances, schedules,
    shiftCodes, payCodes, glAccounts, departments, subsidiaries, issues, raw: ds,
  };
}

export function rateOn(w: Worker, date: string): number {
  return valueOn(w.rateHistory, date);
}

export function stateOn(w: Worker, date: string): string {
  return valueOn(w.locationHistory, date).state;
}

export function locationOn(w: Worker, date: string): string {
  return valueOn(w.locationHistory, date).location;
}
