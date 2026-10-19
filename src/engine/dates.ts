// Date helpers. All dates are ISO 'YYYY-MM-DD' strings handled in UTC so results never
// depend on the viewer's time zone.

const DAY = 86400000;

export function toMs(d: string): number {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
}

export function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  return fromMs(toMs(d) + n * DAY);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toMs(b) - toMs(a)) / DAY);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(d: string): number {
  return new Date(toMs(d)).getUTCDay();
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isWeekday(d: string): boolean {
  const w = weekday(d);
  return w >= 1 && w <= 5;
}

/** Inclusive list of dates from a to b. */
export function eachDay(a: string, b: string): string[] {
  const out: string[] = [];
  if (!a || !b || a > b) return out;
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Mon–Fri working days between a and b inclusive. */
export function workingDays(a: string, b: string): number {
  return eachDay(a, b).filter(isWeekday).length;
}

export function maxDate(a: string, b: string): string { return a > b ? a : b; }
export function minDate(a: string, b: string): string { return a < b ? a : b; }

/** Overlap [a1,b1] ∩ [a2,b2] as [start,end] or null. Empty end = open-ended. */
export function overlap(a1: string, b1: string, a2: string, b2: string): [string, string] | null {
  const s = maxDate(a1 || '0000-01-01', a2 || '0000-01-01');
  const e = minDate(b1 || '9999-12-31', b2 || '9999-12-31');
  return s <= e ? [s, e] : null;
}

/** Sunday that starts the workweek containing d. */
export function weekStart(d: string): string {
  return addDays(d, -weekday(d));
}

/** Previous business day if d falls on a weekend. */
export function adjustToBusinessDay(d: string): string {
  let x = d;
  while (!isWeekday(x)) x = addDays(x, -1);
  return x;
}

/** 'HH:MM' -> minutes after midnight. */
export function hm(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
