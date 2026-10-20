// CA second meal period: a shift over 12 hours needs a second meal, which cannot be waived (design doc §6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDataSet } from '../scripts/node-data.ts';
import { runAll } from '../src/engine/run.ts';

const R = runAll(loadDataSet());
const day = (id: string, date: string) => R.time.get(id)!.days.find(d => d.date === date)!;

test('CA shift over 12 hours with one meal pays a meal premium (E0049, E0228)', () => {
  assert.equal(day('E0049', '2026-10-10').mealPenalty, true);
  assert.equal(day('E0228', '2026-10-15').mealPenalty, true);
});

test('still max one meal premium per day when the first meal was also late (E0021 Oct 6)', () => {
  const t = R.time.get('E0021')!;
  assert.equal(t.days.filter(d => d.date === '2026-10-06' && d.mealPenalty).length, 1);
  const r = R.register.find(x => x.workerId === 'E0021')!;
  assert.equal(r.lines.find(l => l.code === 'MEAL_PEN')!.hours, 2); // Oct 6 (late + no 2nd meal) and Oct 7 (missed)
});

test('shifts of 12 hours or less are unaffected (E0034 10.5h, E0134 11.97h)', () => {
  assert.equal(day('E0034', '2026-10-07').mealPenalty, false);
  assert.equal(day('E0134', '2026-10-04').mealPenalty, false);
});

test('non-CA shifts over 12 hours get no premium (TX group)', () => {
  for (const t of R.time.values()) if (t.group !== 'US California Non-Exempt')
    for (const d of t.days) assert.equal(d.mealPenalty, false, `${t.workerId} ${d.date}`);
});
