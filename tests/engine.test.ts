// Automated tests for the calculation engine. Run with:  npm test   (node --test)
// Covers overtime, proration and termination payout (required), plus differentials, meal
// penalties, retro, taxes, garnishments, GL balancing and the reconciliations.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadDataSet } from '../scripts/node-data.ts';
import { runAll } from '../src/engine/run.ts';
import { calcDay } from '../src/engine/time.ts';
import type { DataSet } from '../src/engine/types.ts';

const ds = loadDataSet();
const R = runAll(ds);
const reg = (id: string) => R.register.find(r => r.workerId === id)!;
const line = (id: string, code: string) => reg(id).lines.find(l => l.code === code);
const amt = (id: string, code: string) => line(id, code)?.amount ?? 0;
const close = (a: number, b: number, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const clone = (): DataSet => JSON.parse(JSON.stringify(ds));

describe('time: daily hours and differentials', () => {
  test('overnight shift is credited to the start day and meal is excluded', () => {
    const d = calcDay('22:00', '06:30', '02:00', '02:30');
    assert.equal(d.workedMin, 480);
    assert.equal(d.nightMin, 450); // 22:00–02:00 + 02:30–06:00
  });
  test('late meal is detected after the 5th hour', () => {
    assert.equal(calcDay('06:00', '19:15', '11:30', '12:00').mealLate, true);
    assert.equal(calcDay('06:00', '14:30', '10:00', '10:30').mealLate, false);
  });
  test('differentials do not stack: NGHT night hours get $3.00, the tail after 06:00 gets $2.50', () => {
    const t = R.time.get('E0142')!;
    const ngt = t.lines.find(l => l.code === 'DIFF_NGT')!;
    const nght = t.lines.find(l => l.code === 'DIFF_NGHT')!;
    close(ngt.amount, ngt.hours! * 3, 0.02);
    close(nght.amount, nght.hours! * 2.5, 0.02);
  });
});

describe('time: overtime (CA and non-CA)', () => {
  test('CA daily OT over 8 and DT over 12 (E0021 Oct 6, 12.75 hrs)', () => {
    const d = R.time.get('E0021')!.days.find(d => d.date === '2026-10-06')!;
    assert.equal(d.reg, 8); assert.equal(d.ot, 4); close(d.dt, 0.75, 0.001);
  });
  test('CA 7th consecutive day: first 8 hrs at 1.5x, none at straight time (E0020 Sat Oct 10)', () => {
    const d = R.time.get('E0020')!.days.find(d => d.date === '2026-10-10')!;
    assert.equal(d.reg, 0); close(d.svd15, 7.9, 0.001); assert.equal(d.svd20, 0);
  });
  test('weekly OT applies only to straight hours not already premium (no pyramiding)', () => {
    const t = R.time.get('E0020')!;
    const wk = t.days.filter(d => d.week === '2026-10-04');
    const reg = wk.reduce((s, d) => s + d.reg, 0);
    close(reg, 40, 0.001);
  });
  test('TX has no daily OT or 7th-day rule; weekly OT over 40 only (E0142 week 2)', () => {
    const t = R.time.get('E0142')!;
    assert.ok(t.days.every(d => d.dt === 0 && d.svd15 === 0));
    const ot = t.lines.find(l => l.code === 'OT_15')!;
    close(ot.hours!, 55.3667 - 40, 0.001);
  });
  test('OT is paid at base + 0.5 × weighted regular rate (differentials included)', () => {
    const t = R.time.get('E0142')!;
    const wk = t.weeks.find(w => w.weekStart === '2026-10-11')!;
    const ot = t.lines.find(l => l.code === 'OT_15')!;
    close(ot.amount, ot.hours! * (28.5 + 0.5 * wk.regularRate), 0.05);
    assert.ok(wk.regularRate > 28.5);
  });
  test('mid-week rate change pays each day at its own rate (E0022 $38 → $40 on Oct 10)', () => {
    const t = R.time.get('E0022')!;
    assert.equal(t.days.find(d => d.date === '2026-10-09')!.baseRate, 38);
    assert.equal(t.days.find(d => d.date === '2026-10-12')!.baseRate, 40);
  });
});

describe('time: meal penalties and punch cleaning', () => {
  test('CA: late meal and attested missed meal each earn one hour; waived meal earns none', () => {
    assert.equal(line('E0021', 'MEAL_PEN')!.hours, 2);
    assert.equal(line('E0074', 'MEAL_PEN'), undefined);
  });
  test('TX meal exceptions are flagged, not paid', () => {
    assert.equal(line('E0307', 'MEAL_PEN'), undefined);
    assert.ok(R.time.get('E0307')!.issues.some(i => i.code === 'MEAL_EXCEPTION_NONCA'));
  });
  test('duplicate punches are removed and not paid', () => {
    const t = R.time.get('E0078')!;
    assert.equal(t.days.filter(d => d.date === '2026-10-08').length, 1);
    assert.ok(t.dropped.some(d => /Duplicate/.test(d.reason)));
  });
  test('time after the termination date does not flow to payroll (E0028 Oct 14)', () => {
    const t = R.time.get('E0028')!;
    assert.ok(!t.days.some(d => d.date === '2026-10-14'));
    assert.ok(t.issues.some(i => i.code === 'TIME_AFTER_TERM'));
  });
  test('prior-period corrections are paid as retro (E0071 +8h, E0112 +0.5h CA daily OT)', () => {
    close(amt('E0071', 'RETRO_HRS'), 240);
    // E0112: Out 06:30→07:00 on a NGHT shift = 8.5 hrs → 0.5 hr CA daily OT at base + 0.5 × RR,
    // plus $2.50 NGHT differential for the extra 30 minutes after 06:00.
    const rr = (8.5 * 38 + 7.5 * 3 + 1.0 * 2.5) / 8.5;
    close(amt('E0112', 'RETRO_HRS'), 0.5 * (38 + 0.5 * rr) + 0.5 * 2.5, 0.02);
  });
});

describe('payroll: proration', () => {
  test('mid-period hire is prorated by working days (E0203 hired Oct 21: 8 of 11)', () => {
    close(amt('E0203', 'REG_SAL'), 190000 / 24 * 8 / 11);
    assert.equal(reg('E0203').bucket, 'Paid prorated');
  });
  test('mid-period termination is prorated (E0017 term Oct 23: 6 of 11)', () => {
    close(amt('E0017', 'REG_SAL'), 137000 / 24 * 6 / 11);
  });
  test('unpaid leave docks working days (E0031: 8 of 11 unpaid)', () => {
    close(reg('E0031').gross, 143000 / 24 * 3 / 11);
  });
  test('full-period unpaid leave pays $0 and books benefit arrears (E0149)', () => {
    assert.equal(reg('E0149').gross, 0);
    assert.equal(reg('E0149').bucket, 'Active, not paid');
    assert.equal(reg('E0149').arrearsCreated, 274);
  });
  test('late-entered comp change is recalculated as retro (E0002)', () => {
    close(amt('E0002', 'REG_SAL'), 353000 / 24);
    close(amt('E0002', 'RETRO_SAL'), (370000 - 353000) / 24 * 10 / 11);
  });
  test('proration helper: changing a hire date changes the result (edit + re-run)', () => {
    const d = clone();
    d.workers = d.workers.map(w => w.id === 'E0203' ? { ...w, hire_date: '2026-10-26' } : w);
    const r2 = runAll(d).register.find(r => r.workerId === 'E0203')!;
    close(r2.lines.find(l => l.code === 'REG_SAL')!.amount, 190000 / 24 * 5 / 11);
  });
});

describe('payroll: termination payout', () => {
  test('CA hourly termination pays the full vacation balance (E0028: 120 hrs × $31.75)', () => {
    close(amt('E0028', 'VAC_PAYOUT'), 120 * 31.75);
  });
  test('termination with no time pays only the payout (E0148: 31 hrs × $80)', () => {
    close(reg('E0148').gross, 31 * 80);
    assert.equal(reg('E0148').bucket, 'Paid prorated');
  });
  test('payout includes the accrual earned this period (E0029)', () => {
    const a = R.absence.find(a => a.workerId === 'E0029' && a.plan === 'US Hourly Vacation')!;
    assert.ok(a.accrued > 0);
    close(a.payoutQty, (a.opening ?? 0) + a.accrued - a.used, 0.001);
    assert.equal(a.ending, 0);
  });
  test('Flexible PTO and sick plans never pay out (E0017, E0004)', () => {
    assert.equal(line('E0017', 'VAC_PAYOUT'), undefined);
    assert.equal(line('E0004', 'VAC_PAYOUT'), undefined);
  });
  test('international payout uses (annual / 52) / 5 per day (UK E0006)', () => {
    const a = R.absence.find(a => a.workerId === 'E0006' && a.plan === 'UK Annual Leave')!;
    close(a.rate, 85000 / 52 / 5, 0.001);
    close(a.payoutAmount, a.payoutQty * 85000 / 52 / 5, 0.05);
  });
});

describe('payroll: taxes, deductions, garnishments', () => {
  test('state wages split by working days for a CA→TX move (E0005: CA 5/11)', () => {
    close(reg('E0005').states.CA, 5 / 11, 0.0001);
    assert.equal(line('E0005', 'SIT_TX'), undefined);
  });
  test('Social Security stops at the wage base', () => {
    assert.equal(line('E0002', 'OASDI_EE'), undefined);
    const crossing = R.register.filter(r => r.tags.includes('Social Security wage base reached this period'));
    for (const r of crossing) close(amt(r.workerId, 'OASDI_EE'), (168600 - r.ytdPriorFica) * 0.062, 0.02);
  });
  test('401(k) applies to bonuses and the match caps at 4% of gross (E0336 7% deferral)', () => {
    close(amt('E0336', '401K_EE'), 0.07 * 10000);
    close(amt('E0336', '401K_ER'), 0.04 * 10000);
  });
  test('Section 125 reduces FICA wages; 401(k) does not', () => {
    const r = reg('E0035');
    close(amt('E0035', 'MEDI_EE'), (r.gross - 274) * 0.0145);
    close(amt('E0035', 'FIT_EE'), (r.gross - 274 - amt('E0035', '401K_EE')) * 0.22);
  });
  test('child support and creditor garnishments are taken after tax with balance tracking', () => {
    close(amt('E0017', 'GARN_CS'), 830);
    close(amt('E0035', 'GARN_CRED'), 350);
    assert.match(line('E0035', 'GARN_CRED')!.detail!, /4200\.00 → 3850\.00/);
  });
  test('contractors are never paid', () => {
    assert.ok(!R.register.some(r => r.workerId.startsWith('C')));
  });
});

describe('GL and reconciliations', () => {
  test('every journal balances and the export is allowed', () => {
    assert.ok(R.journal.journals.every(j => j.balanced));
    assert.equal(R.journal.exportable, true);
    assert.ok(R.journal.ties.every(t => t.ok));
  });
  test('an unmapped pay code blocks the export', () => {
    const d = clone();
    d.gl_posting_rules = d.gl_posting_rules.filter(m => !(m.country === 'US' && m.pay_code === 'OT_15'));
    const j = runAll(d).journal;
    assert.equal(j.exportable, false);
    assert.ok(j.issues.some(i => i.code === 'OT_15'));
  });
  test('legacy register: 12 variances, all explained, at least 2 per class across both pay groups', () => {
    assert.equal(R.legacy.workers.length, 12);
    assert.ok(R.legacy.workers.every(w => w.explained));
    for (const c of ['Legacy error', 'Configuration difference', 'Timing', 'Data']) assert.ok(R.legacy.workers.filter(w => w.cls === c).length >= 2);
    assert.ok(R.legacy.workers.some(w => w.payGroup === 'US Biweekly') && R.legacy.workers.some(w => w.payGroup === 'US Semi-monthly'));
  });
  test('headcount buckets add back to the worker file for every pay run', () => {
    for (const h of R.headcount) assert.equal(h.buckets.reduce((s, b) => s + b.count, 0), h.workerFile, h.payGroup);
  });
  test('provider variances are all explained', () => {
    assert.ok(R.intl.variances.length > 0);
    assert.ok(R.intl.variances.every(v => v.explained));
  });
});

import { payrollStatus, findingKey } from '../src/engine/status.ts';
import type { StageActions } from '../src/engine/status.ts';
const none = (): StageActions => ({ resolved: {}, signoff: {}, close: {} });
describe('payroll status by pay group (7 stages)', () => {
  test('as of Oct 18 US Biweekly is preparing inputs and at risk (missing time)', () => {
    const s = payrollStatus(R, '2026-10-18', none()).find(x => x.payGroup === 'US Biweekly')!;
    assert.equal(s.currentIndex, 0);
    assert.equal(s.stages[0].state, 'At risk');
    assert.equal(s.overall, 'At risk');
  });
  test('international inputs are done once the Oct 13 file is sent; processing in progress on Oct 18', () => {
    const s = payrollStatus(R, '2026-10-18', none()).find(x => x.payGroup === 'Canada Monthly')!;
    assert.equal(s.stages[0].state, 'Done');
    assert.equal(s.currentIndex, 1);
  });
  test('audits stage completes only when high findings are resolved; sign-off then unlocks', () => {
    const a = none();
    let s = payrollStatus(R, '2026-10-22', a).find(x => x.payGroup === 'US Semi-monthly')!;
    assert.equal(s.currentIndex, 2);
    for (const f of R.audit.findings.filter(f => f.payGroup === 'US Semi-monthly' && f.severity === 'High')) a.resolved[findingKey(f)] = { note: 'ok', at: '' };
    s = payrollStatus(R, '2026-10-22', a).find(x => x.payGroup === 'US Semi-monthly')!;
    assert.equal(s.stages[2].state, 'Done');
    assert.equal(s.currentIndex, 3);
    assert.equal(s.stages[3].actionEnabled, true);
    a.signoff['US Semi-monthly'] = { by: 'PM', at: '' };
    s = payrollStatus(R, '2026-10-22', a).find(x => x.payGroup === 'US Semi-monthly')!;
    assert.equal(s.stages[4].state, 'Done');
    assert.equal(s.currentIndex, 5);
  });
  test('a stage past its due date is late; full path to Closed after pay date', () => {
    assert.equal(payrollStatus(R, '2026-10-22', none()).find(x => x.payGroup === 'US Biweekly')!.overall, 'Late');
    const a = none();
    a.resolved['VENDOR|*'] = { note: '', at: '' };
    a.signoff['Canada Monthly'] = { by: 'PM', at: '' };
    a.close['Canada Monthly'] = { by: 'Controller', at: '' };
    const s = payrollStatus(R, '2026-10-29', a).find(x => x.payGroup === 'Canada Monthly')!;
    assert.equal(s.overall, 'Closed');
  });
});

import { importRegister, payCodeColumns, applyMapping } from '../src/engine/prism.ts';
const ALL_INTL = () => [...ds.vendor_register_uk, ...ds.vendor_register_in, ...ds.vendor_register_ca];
describe('export payroll journal: import, route by company, transpose', () => {
  test('transposes one row per worker into one row per worker per pay code', () => {
    const rows = ds.vendor_register_uk;
    const g = importRegister(R.model, rows).groups[0];
    const w = rows[0];
    const nonZero = payCodeColumns(rows).filter(c => Number(w[c]) !== 0).length;
    assert.equal(g.transposed.filter(t => t.employeeId === w.employee_id).length, nonZero);
  });
  test('one file with three companies is routed to three GL mappings and all journals balance', () => {
    const imp = importRegister(R.model, ALL_INTL());
    assert.deepEqual(imp.groups.map(g => g.company).sort(), ['NC-CA', 'NC-IN', 'NC-UK']);
    for (const g of imp.groups) {
      assert.ok(g.mappingSet, g.company);
      const m = applyMapping(R.model, g);
      assert.equal(m.ok, true, g.company);
      assert.ok(m.lines.some(l => l.payCode === 'ER_BENEFITS'));
    }
  });
  test('a file without a company column cannot be routed', () => {
    const rows = ds.vendor_register_uk.map(({ company: _c, ...r }) => { void _c; return r; });
    const imp = importRegister(R.model, rows);
    assert.equal(imp.hasCompanyColumn, false);
    assert.equal(imp.groups.length, 0);
  });
  test('a company with no GL mapping, or an unmapped pay code, fails the mapping', () => {
    const d = clone();
    d.gl_posting_rules = d.gl_posting_rules.map(m => (m.country === 'IN' ? { ...m, companies: '' } : m));
    const R2 = runAll(d);
    const g = importRegister(R2.model, ds.vendor_register_in).groups[0];
    assert.equal(applyMapping(R2.model, g).ok, false);
    const g2 = importRegister(R.model, ds.vendor_register_uk.map(r => ({ ...r, CAR_ALLOW: '100' }))).groups[0];
    const m2 = applyMapping(R.model, g2);
    assert.equal(m2.ok, false);
    assert.match(m2.blockers.map(b => b.detail).join(' '), /CAR_ALLOW/);
  });
  test('employee not in Workday, missing department/location, or wrong company fails the mapping', () => {
    const g1 = importRegister(R.model, ds.vendor_register_ca.map(r => ({ ...r, employee_id: 'E9999' }))).groups[0];
    assert.ok(applyMapping(R.model, g1).blockers.some(b => /not found in Workday/.test(b.reason)));
    const d = clone();
    d.workers = d.workers.map(w => (w.id === 'E0008' ? { ...w, location: '' } : w.id === 'E0007' ? { ...w, dept: 'Unknown Dept' } : w));
    const R2 = runAll(d);
    const m2 = applyMapping(R2.model, importRegister(R2.model, d.vendor_register_ca).groups[0]);
    assert.match(m2.blockers.find(b => /posting fields/.test(b.reason))!.detail, /E0008: .*department.*location/);
    const g3 = importRegister(R.model, ds.vendor_register_ca.map(r => ({ ...r, employee_id: 'E0006' }))).groups[0];
    assert.match(applyMapping(R.model, g3).blockers.map(b => b.detail).join(' '), /belongs to NC-UK/);
  });
});

import { usJournals, mappingSets } from '../src/engine/prism.ts';
describe('export payroll journal: US from payroll results, one GL mapping file', () => {
  test('one rules file gives one mapping per country, each with its own companies', () => {
    const sets = mappingSets(R.model);
    assert.deepEqual(sets.map(s => s.id).sort(), ['CA', 'IN', 'UK', 'US']);
    assert.deepEqual(sets.find(s => s.id === 'US')!.companies, ['NC-US']);
  });
  test('US journals come straight from payroll results: one per pay group, balanced, net pay ties', () => {
    const js = usJournals(R.model, R.register, 'NC-US');
    assert.deepEqual(js.map(j => j.payGroup).sort(), ['US Biweekly', 'US Semi-monthly']);
    for (const j of js) {
      assert.equal(j.ok, true, j.payGroup);
      const net = R.register.filter(r => r.payGroup === j.payGroup).reduce((s, r) => s + r.net, 0);
      const payable = j.summary.filter(l => l.account === '2101').reduce((s, l) => s + l.credit - l.debit, 0);
      assert.ok(Math.abs(net - payable) < 0.05, j.payGroup);
    }
  });
  test('a missing US rule blocks the US journal', () => {
    const d = clone();
    d.gl_posting_rules = d.gl_posting_rules.filter(m => !(m.country === 'US' && m.pay_code === 'OT_15'));
    const R2 = runAll(d);
    const bw = usJournals(R2.model, R2.register, 'NC-US', 'US Biweekly')[0];
    assert.equal(bw.ok, false);
    assert.match(bw.blockers.map(b => b.detail).join(' '), /OT_15/);
  });
});

import { buildPayload, verify, reidentify, templateFromPayload } from '../src/engine/ai-guard.ts';
describe('pre-payroll audit (AI): headcount roll-forward and guardrails', () => {
  test('roll-forward: last run + joiners - leavers = this run; less not paid = register paid, both pay groups', () => {
    assert.equal(R.audit.rollForward.length, 2);
    for (const rf of R.audit.rollForward) {
      const c = (k: string) => rf.lines.find(l => l.key === k)?.count ?? 0;
      assert.equal(c('opening') + c('hires') + c('xfer-in') + c('returns') - c('terms') - c('xfer-out') - c('other-out'), c('current'), rf.payGroup);
      assert.equal(c('current') - c('unpaid-leave') - c('no-time'), rf.expectedPaid);
      assert.equal(rf.ties, true, rf.payGroup);
    }
  });
  test('a missing timecard moves a worker from "to be paid" to "no time entered"', () => {
    const d = clone();
    const before = R.audit.rollForward.find(r => r.payGroup === 'US Biweekly')!;
    const victim = R.register.find(r => r.payGroup === 'US Biweekly' && r.gross > 0 && !r.workerId.match(/E0028/) && d.timesheets.some(t => t.worker_id === r.workerId))!.workerId;
    d.timesheets = d.timesheets.filter(t => t.worker_id !== victim);
    const after = runAll(d).audit.rollForward.find(r => r.payGroup === 'US Biweekly')!;
    const nt = (rf: typeof before) => rf.lines.find(l => l.key === 'no-time')!;
    assert.equal(nt(after).count, nt(before).count + 1);
    assert.ok(nt(after).workers.some(w => w.id === victim));
    assert.equal(after.ties, true);
  });
  test('payload is allow-listed and pseudonymized: no real worker IDs, only schema fields', () => {
    const { payload, map } = buildPayload(R.audit, R.legacy.byClass, 'Oct 2026');
    const json = JSON.stringify(payload);
    assert.doesNotMatch(json, /\bE\d{4}\b/);
    assert.deepEqual(Object.keys(payload).sort(), ['findings', 'headcount', 'parallel', 'period']);
    for (const f of payload.findings) assert.deepEqual(Object.keys(f).sort(), ['check', 'current', 'payGroup', 'prior', 'ref', 'rule', 'severity', 'worker']);
    assert.equal(map.toToken.size, new Set(R.audit.findings.map(f => f.workerId)).size);
  });
  test('verification passes the template and flags invented numbers or workers', () => {
    const { payload, map } = buildPayload(R.audit, R.legacy.byClass, 'Oct 2026');
    const t = templateFromPayload(payload);
    assert.equal(verify(t, payload).status, 'verified');
    assert.doesNotMatch(reidentify(t, map), /\bW\d{3}\b/);
    const bad = verify(`${t}\n• W999 owes $12,345.67 in back pay.`, payload);
    assert.equal(bad.status, 'unverified');
    assert.deepEqual(bad.tokens.unknown, ['W999']);
    assert.ok(bad.numbers.unverified.includes('$12,345.67'));
  });
});
