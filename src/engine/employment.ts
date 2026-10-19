// Employment window and leave helpers shared by payroll, absence and international.

import type { Model, Worker } from './types.ts';
import { eachDay, isWeekday, overlap } from './dates.ts';

/** Dates (inclusive) the worker is employed within [start, end], or null if none. */
export function employmentWindow(w: Worker, start: string, end: string): [string, string] | null {
  return overlap(w.hireDate || '0000-01-01', w.termDate || '9999-12-31', start, end);
}

/** Set of dates in [start,end] on which the worker is on unpaid leave. */
export function unpaidLeaveDates(model: Model, w: Worker, start: string, end: string): Set<string> {
  const out = new Set<string>();
  const ranges: [string, string][] = [];
  for (const e of model.events) {
    if (e.workerId === w.id && e.type === 'Unpaid Leave' && e.status !== 'Cancelled') {
      ranges.push([e.start, e.end || '9999-12-31']);
    }
  }
  if (!ranges.length && w.status === 'On Leave(unpaid)' && w.leaveStartDate) {
    ranges.push([w.leaveStartDate, '9999-12-31']);
  }
  for (const [a, b] of ranges) {
    const o = overlap(a, b, start, end);
    if (o) for (const d of eachDay(o[0], o[1])) out.add(d);
  }
  return out;
}

/** Working days (Mon–Fri) employed and not on unpaid leave within [start,end]. */
export function paidWorkingDays(model: Model, w: Worker, start: string, end: string): string[] {
  const win = employmentWindow(w, start, end);
  if (!win) return [];
  const unpaid = unpaidLeaveDates(model, w, start, end);
  return eachDay(win[0], win[1]).filter(d => isWeekday(d) && !unpaid.has(d));
}

export function isUs(w: Worker): boolean {
  return w.payGroup === 'US Semi-monthly' || w.payGroup === 'US Biweekly';
}

export function isEmployee(w: Worker): boolean {
  return w.workerType === 'Employee' && !!w.payGroup;
}
