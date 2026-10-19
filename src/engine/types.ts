// Shared types for the calculation engine. Type-only module: always import with `import type`.

import type { Row } from './csv.ts';

export interface Rules {
  time: {
    workweekStartsOn: string;
    nightWindow: { start: string; end: string; ratePerHour: number };
    shiftDifferentials: Record<string, number>;
    differentialsStack: boolean;
    groups: Record<string, {
      dailyOtAfter?: number; dailyDtAfter?: number; weeklyOtAfter: number;
      seventhDay?: { otFirstHours: number };
      mealPenalty?: { minShiftHours: number; lateAfterHours: number; maxPerDay: number };
    }>;
    offScheduleToleranceMinutes: number;
  };
  usTax: {
    fitFlatRate: number; sitRates: Record<string, number>; caSdiRate: number;
    oasdiRate: number; oasdiWageBase: number; medicareRate: number;
    futaRate: number; futaWageBase: number; suiRate: number; suiWageBase: number;
  };
  garnishment: {
    childSupportMaxPctOfDisposable: number; creditorMaxPctOfDisposable: number;
    creditorExcessPct: number; caMinimumWage: number; creditorWeeklyMinWageMultiple: number;
  };
  benefits: { employerLoadPctOfGross: number; k401MatchPct: number; k401MatchCapPctOfGross: number };
  intl: {
    fxToUsd: Record<string, number>;
    ukEmployerNi: { rate: number; monthlySecondaryThreshold: number };
    caEmployerCppEi: { rate: number };
    employerBenefitsLoadPctOfGross: number;
    inEmployerPf: { rate: number; basicPctOfGross: number; basicCap: number };
  };
  absence: Record<string, AbsencePlanRule>;
}

export interface AbsencePlanRule {
  unit: 'hrs' | 'days';
  method: 'per_hour_worked' | 'monthly' | 'frontloaded' | 'none';
  rate?: number; perMonth?: number; cap?: number; payout: boolean;
  exemptWeeklyHours?: number; unlimited?: boolean;
}

export interface DatedValue<T> { from: string; value: T; source: string }

export interface Worker {
  id: string; dept: string; location: string; state: string; country: string; level: string;
  flsa: string; payRateType: string; annualSalary: number | null; hourlyRate: number | null;
  currency: string; payGroup: string; hireDate: string; termDate: string; leaveStartDate: string;
  managerId: string; status: string; workerType: string; weeklyHours: number; timeType: string;
  timeCalcGroup: string; defaultShift: string; notes: string;
  /** Effective-dated pay rate (annual for salaried, hourly for hourly). Sorted by `from`. */
  rateHistory: DatedValue<number>[];
  /** Effective-dated work state and location. Sorted by `from`. */
  locationHistory: DatedValue<{ state: string; location: string }>[];
  supOrg: string;
  costCenter: string;
}

export interface Event {
  id: string; workerId: string; type: string; start: string; end: string; plan: string;
  qty: number; unit: string; status: string; notes: string; field: string;
  oldValue: string; newValue: string;
}

export interface TimeEntry {
  idx: number; workerId: string; date: string; timeIn: string; timeOut: string;
  mealStart: string; mealEnd: string; shiftCode: string; entryType: string; enteredOn: string;
  payPeriod: string; state: string; notes: string; mealAttestation: string;
}

export interface RosterRow { seq: number; workerId: string; date: string; shiftCode: string; source: string; reason: string }

export interface PayInput {
  workerId: string; code: string; rate: number; amount: number; start: string; end: string; notes: string;
}

export interface Balance {
  workerId: string; plan: string; balance: number | null; unlimited: boolean; unit: string;
  lastAccrual: string; notes: string;
}

export interface PaySchedule {
  payGroup: string; country: string; frequency: string; start: string; end: string;
  payDateOriginal: string; payDate: string; periodsPerYear: number;
}

export interface PayCode {
  code: string; name: string; category: string; calcBasis: string; fedBy: string;
  taxability: string; inRegularRate: boolean; k401Eligible: boolean; active: boolean;
}

export interface GlAccount { account: string; name: string; type: string; segmentLevel: string }

export interface DataSet {
  workers: Row[]; absence_balances: Row[]; payroll_inputs: Row[]; events: Row[];
  timesheets: Row[]; pay_schedule: Row[]; shift_codes: Row[]; shift_roster: Row[];
  pay_codes: Row[]; gl_accounts: Row[]; subsidiaries: Row[]; departments: Row[];
  prior_register: Row[]; legacy_register: Row[]; legacy_variance_notes: Row[];
  vendor_register_uk: Row[]; vendor_register_in: Row[]; vendor_register_ca: Row[]; vendor_variance_notes: Row[];
  gl_posting_rules: Row[];
  rules: Rules;
}

export interface Model {
  rules: Rules;
  workers: Worker[];
  workerById: Map<string, Worker>;
  events: Event[];
  timesheets: TimeEntry[];
  roster: RosterRow[];
  inputs: PayInput[];
  balances: Balance[];
  schedules: Map<string, PaySchedule>;
  shiftCodes: Map<string, { code: string; start: string; end: string; paidHours: number }>;
  payCodes: Map<string, PayCode>;
  glAccounts: Map<string, GlAccount>;
  departments: Map<string, { netsuite: string; plFunction: string }>;
  subsidiaries: { subsidiary: string; currency: string; payGroups: string[] }[];
  issues: Issue[];
  raw: DataSet;
}

export interface Issue {
  workerId: string; code: string; severity: 'info' | 'warning' | 'error'; message: string; ref?: string;
}

export interface PayLine {
  code: string; amount: number; hours?: number; rate?: number; detail?: string; state?: string;
}

export interface DayTrace {
  date: string; day: string; shift: string; timeIn: string; timeOut: string; hours: number;
  nightHours: number; reg: number; ot: number; dt: number; svd15: number; svd20: number;
  mealPenalty: boolean; baseRate: number; flags: string[]; week: string;
}

export interface TimeResult {
  workerId: string; group: string; days: DayTrace[];
  weeks: { weekStart: string; hours: number; straightPay: number; diffPay: number; regularRate: number }[];
  lines: PayLine[]; hoursWorked: number; leaveHours: Record<string, number>;
  dropped: { date: string; reason: string }[]; issues: Issue[];
}

export interface AbsenceRow {
  workerId: string; plan: string; unit: string; asOf: string; windowEnd: string;
  opening: number | null; accrued: number; used: number; payoutQty: number; payoutAmount: number;
  ending: number | null; currency: string; rate: number; liabilityOpening: number;
  liabilityEnding: number; usedYtdNote: string; flags: string[];
  /** How the accrual was worked out, e.g. "62.5 hrs worked × 0.0462" or "2.3333 days × 18/22 working days". */
  accrualBasis: string;
}

export interface RegisterRow {
  workerId: string; payGroup: string; dept: string; costCenter: string; location: string;
  state: string; lines: PayLine[]; gross: number; pretax: number; eeTaxes: number;
  postTax: number; net: number; erCost: number; burdened: number; arrearsCreated: number;
  bucket: 'Paid full period' | 'Paid prorated' | 'Active, not paid' | 'Excluded';
  bucketReason: string; tags: string[]; ytdPriorFica: number; states: Record<string, number>;
  issues: Issue[];
}
