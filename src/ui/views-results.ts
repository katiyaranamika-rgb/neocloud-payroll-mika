// Payroll results for ONE worker: enter a worker ID and the tabs populate with that worker's
// earnings / deductions / taxes, employer costs, time cards, pay inputs and payroll accounting.

import { h, kpi, card, section, table, fmtMoney, fmtNum, badge, tabs } from './dom.ts';
import { state, passes } from './state.ts';
import { go } from './router.ts';
import type { RegisterRow, PayLine } from '../engine/types.ts';
import { round2 } from '../engine/dates.ts';
import { displayName } from './brand.ts';
import { workerCompany, rulesForCompany, resultLines } from '../engine/prism.ts';


let workerSel = '';

interface Flat extends PayLine { workerId: string; payGroup: string; costCenter: string; location: string }

const pc = (code: string) => state.result.model.payCodes.get(code);
const cat = (code: string) => pc(code)?.category ?? '';
const nm = (code: string) => pc(code)?.name ?? code;

function rows(): RegisterRow[] {
  return state.result.register.filter(r => r.workerId === workerSel);
}

function flat(rs: RegisterRow[], pred: (l: PayLine) => boolean): Flat[] {
  return rs.flatMap(r => r.lines.filter(pred).map(l => ({ ...l, workerId: r.workerId, payGroup: r.payGroup, costCenter: r.costCenter, location: r.location })));
}

/** The worker's lines for one category, with a total. */
// YTD: this app runs the first Workday payroll, so YTD = this period's amount. When prior
// Workday periods exist, add their amounts per code here.
const ytdFor = (l: Flat) => l.amount;

function codeBlock(title: string, lines: Flat[], showHours: boolean, showYtd = false): HTMLElement {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return card(null,
    h('div', { class: 'subhead' }, h('h3', null, title), h('strong', null, `Total ${fmtMoney(total)}${showYtd ? ` · YTD ${fmtMoney(lines.reduce((s, l) => s + ytdFor(l), 0))}` : ''}`)),
    table(lines, [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Description', value: l => nm(l.code) },
      ...(showHours ? [
        { key: 'hours', label: 'Hours', align: 'right' as const, render: (l: Flat) => (l.hours !== undefined ? fmtNum(l.hours) : '') },
        { key: 'rate', label: 'Rate', align: 'right' as const, render: (l: Flat) => (l.rate !== undefined && l.code !== '401K_EE' ? fmtNum(l.rate, 4) : '') },
      ] : []),
      { key: 'amount', label: 'Amount', align: 'right', render: l => fmtMoney(l.amount) },
      ...(showYtd ? [{ key: 'ytd', label: 'YTD', align: 'right' as const, value: (l: Flat) => ytdFor(l), render: (l: Flat) => fmtMoney(ytdFor(l)) }] : []),
      { key: 'detail', label: 'Detail', render: l => h('span', { class: 'small muted' }, l.detail ?? '') },
    ], { search: false, pageSize: 40, empty: 'None this period' }),
  );
}

function tabEarnings(): HTMLElement {
  const rs = rows();
  const earnings = flat(rs, l => cat(l.code) === 'Earning' && l.code !== 'PTO_FLEX' && Math.abs(l.amount) > 0.004);
  const deductions = flat(rs, l => cat(l.code) === 'Deduction' && l.code !== 'BEN_ARR_NEW' && l.amount > 0.004);
  const taxes = flat(rs, l => cat(l.code) === 'EE Tax' && l.amount > 0.004);
  const gross = rs.reduce((s, r) => s + r.gross, 0);
  const ded = deductions.reduce((s, l) => s + l.amount, 0);
  const tax = taxes.reduce((s, l) => s + l.amount, 0);
  const net = rs.reduce((s, r) => s + r.net, 0);
  const arrears = rs.reduce((s, r) => s + r.arrearsCreated, 0);
  return h('div', null,
    h('div', { class: 'kpis' },
      kpi('Gross pay', fmtMoney(gross), rs[0]?.bucket ?? ''),
      kpi('Total deductions', fmtMoney(ded), 'Pre-tax 401(k) + Section 125 + garnishments'),
      kpi('Total employee taxes', fmtMoney(tax), 'Federal, state, SDI, Social Security, Medicare'),
      kpi('Net pay', fmtMoney(net), Math.abs(gross - ded - tax - net) < 0.05 ? 'Gross − deductions − taxes ✓' : 'Does not tie', Math.abs(gross - ded - tax - net) < 0.05 ? '' : 'warn'),
      arrears > 0 ? kpi('Benefit arrears (not withheld)', fmtMoney(arrears), 'Booked as employee receivable') : null,
    ),
    codeBlock('Earnings', earnings, true, true),
    codeBlock('Deductions', deductions, false, true),
    codeBlock('Employee taxes', taxes, false, true),
  );
}

function tabEmployer(): HTMLElement {
  const rs = rows();
  const erTaxCodes = ['OASDI_ER', 'MEDI_ER', 'FUTA_ER', 'SUI_ER'];
  const erBenCodes = ['401K_ER', 'BEN_ER'];
  const taxes = flat(rs, l => erTaxCodes.includes(l.code) && l.amount > 0.004);
  const bens = flat(rs, l => erBenCodes.includes(l.code) && l.amount > 0.004);
  const t = taxes.reduce((s, l) => s + l.amount, 0);
  const b = bens.reduce((s, l) => s + l.amount, 0);
  const gross = rs.reduce((s, r) => s + r.gross, 0);
  return h('div', null,
    h('div', { class: 'kpis' },
      kpi('Employer taxes', fmtMoney(t), 'Social Security, Medicare, FUTA, SUI'),
      kpi('Employer-paid benefits', fmtMoney(b), '401(k) match + 10% benefits load'),
      kpi('Total employer cost', fmtMoney(t + b), `${gross ? ((t + b) / gross * 100).toFixed(1) : '0'}% of gross`),
      kpi('Total burdened cost', fmtMoney(gross + t + b), 'Gross + employer cost'),
    ),
    codeBlock('Employer taxes', taxes, false),
    codeBlock('Employer-paid benefits', bens, false),
  );
}

function tabTimecards(): HTMLElement {
  const R = state.result;
  const ps = R.model.schedules.get('US Biweekly')!;
  if (state.result.model.workerById.get(workerSel)?.payGroup !== 'US Biweekly') return card(null, h('p', null, `${workerSel} is exempt and salaried (US Semi-monthly): no time cards. Time off is listed under Pay inputs.`));
  // Re-apply the cleaning rules to label every entry (paid, duplicate, after termination, retro).
  const seen = new Set<string>();
  const list = R.model.timesheets.filter(t => t.workerId === workerSel).map(t => {
    const w = R.model.workerById.get(t.workerId)!;
    const key = [t.workerId, t.date, t.timeIn, t.timeOut, t.mealStart, t.mealEnd].join('|');
    let status = 'Paid';
    if (t.payPeriod === 'Prior period') status = 'Retro (prior period)';
    else if (seen.has(key)) status = 'Duplicate – not paid';
    else if (w.termDate && t.date > w.termDate) status = 'After termination – not paid';
    else if (t.date < ps.start || t.date > ps.end) status = 'Outside period';
    seen.add(key);
    const day = R.time.get(t.workerId)?.days.find(d => d.date === t.date);
    return { ...t, status, hours: day && status === 'Paid' ? day.hours : null, ot: day && status === 'Paid' ? day.ot + day.dt + day.svd15 + day.svd20 : null, flags: day && status === 'Paid' ? day.flags.join('; ') : '' };
  });
  const paidHours = list.reduce((s, t) => s + (t.hours ?? 0), 0);
  return h('div', null,
    h('div', { class: 'kpis' },
      kpi('Time entries', String(list.length), `${ps.start} to ${ps.end} (+ retro rows)`),
      kpi('Paid hours', fmtNum(paidHours)),
      kpi('Not paid', String(list.filter(t => /not paid/.test(t.status)).length), 'Duplicates, after termination'),
      kpi('Retro rows', String(list.filter(t => t.status.startsWith('Retro')).length)),
    ),
    card('Time cards in the period', table(list, [
      { key: 'workerId', label: 'Worker' }, { key: 'date', label: 'Date' }, { key: 'shiftCode', label: 'Shift' },
      { key: 'timeIn', label: 'In' }, { key: 'timeOut', label: 'Out' },
      { key: 'meal', label: 'Meal', value: t => (t.mealStart ? `${t.mealStart}–${t.mealEnd}` : t.mealAttestation ? `none (${t.mealAttestation})` : 'none') },
      { key: 'hours', label: 'Hours', align: 'right', render: t => (t.hours !== null ? fmtNum(t.hours) : '') },
      { key: 'ot', label: 'Premium hrs', align: 'right', render: t => (t.ot ? fmtNum(t.ot) : '') },
      { key: 'entryType', label: 'Entry type' },
      { key: 'status', label: 'Status', render: t => badge(t.status, t.status === 'Paid' ? 'ok' : t.status.startsWith('Retro') ? 'info' : 'warn') },
      { key: 'flags', label: 'Rule notes', render: t => h('span', { class: 'small' }, t.flags || t.notes) },
    ], { csvName: 'time-cards.csv', pageSize: 60, onRow: t => go('time', t.workerId) })),
  );
}

function tabInputs(): HTMLElement {
  const R = state.result;
  const inGroup = (id: string) => id === workerSel;
  const psFor = (id: string) => R.model.schedules.get(R.model.workerById.get(id)!.payGroup)!;
  const evs = R.model.events.filter(e => inGroup(e.workerId)).filter(e => { const ps = psFor(e.workerId); return e.start <= ps.end && (e.end || e.start) >= ps.start || (e.type === 'Garnishment' && e.start <= ps.end && !e.end); });
  const bonuses = evs.filter(e => e.type === 'Bonus');
  const other = evs.filter(e => e.type !== 'Bonus');
  const ded = R.model.inputs.filter(p => inGroup(p.workerId)).filter(p => { const ps = psFor(p.workerId); return p.start <= ps.end && (!p.end || p.end >= ps.start); });
  const applied = (id: string, code: string) => R.register.find(r => r.workerId === id)?.lines.find(l => l.code === code)?.amount;
  return h('div', null,
    h('div', { class: 'kpis' },
      kpi('One-time payments', String(bonuses.length), fmtMoney(bonuses.reduce((s, e) => s + Number(e.newValue || 0), 0))),
      kpi('Deduction inputs active', String(ded.length), `${new Set(ded.map(d => d.workerId)).size} workers`),
      kpi('Other events in period', String(other.length), 'Comp, location, leave, garnishment, time off'),
    ),
    card('One-time payments (bonuses)', table(bonuses, [
      { key: 'id', label: 'Event' }, { key: 'workerId', label: 'Worker' }, { key: 'field', label: 'Type' },
      { key: 'start', label: 'Effective' }, { key: 'newValue', label: 'Amount', align: 'right', value: e => Number(e.newValue), render: e => fmtMoney(Number(e.newValue)) },
      { key: 'applied', label: 'Paid as', value: e => (/sign-on/i.test(e.field) ? 'BON_SIGN' : 'BON_SPOT') },
      { key: 'notes', label: 'Notes', render: e => h('span', { class: 'small' }, e.notes) },
    ], { search: false, csvName: 'one-time-payments.csv', onRow: e => go('payslip', e.workerId) })),
    card('Deduction inputs (payroll inputs sheet)', table(ded, [
      { key: 'workerId', label: 'Worker' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Description', value: p => nm(p.code) },
      { key: 'elected', label: 'Election', align: 'right', value: p => (p.code === '401K_EE' ? `${(p.rate * 100).toFixed(0)}%` : fmtMoney(p.amount)) },
      { key: 'start', label: 'Start' }, { key: 'end', label: 'End' },
      { key: 'applied', label: 'Applied this period', align: 'right', value: p => applied(p.workerId, p.code) ?? 0, render: p => { const a = applied(p.workerId, p.code); return a !== undefined ? fmtMoney(a) : badge('not taken', 'warn'); } },
      { key: 'notes', label: 'Notes', render: p => h('span', { class: 'small' }, p.notes) },
    ], { csvName: 'deduction-inputs.csv', pageSize: 50, onRow: p => go('payslip', p.workerId) })),
    card('Other events affecting this period', table(other, [
      { key: 'id', label: 'Event' }, { key: 'workerId', label: 'Worker' }, { key: 'type', label: 'Type' },
      { key: 'start', label: 'Start' }, { key: 'end', label: 'End' },
      { key: 'what', label: 'Change', value: e => (e.field ? `${e.field}: ${e.oldValue ? e.oldValue + ' → ' : ''}${e.newValue}` : `${e.plan} ${e.qty} ${e.unit}`) },
      { key: 'notes', label: 'Notes', render: e => h('span', { class: 'small' }, e.notes) },
    ], { csvName: 'events-in-period.csv', pageSize: 40, onRow: e => go('payslip', e.workerId) })),
  );
}

function tabAccounting(): HTMLElement {
  const R = state.result;
  const M = R.model;
  const w = M.workerById.get(workerSel)!;
  const company = workerCompany(M, w);
  const { set, rules } = rulesForCompany(M, company);
  const { lines: entries, unmapped } = resultLines(M, rows(), rules);
  const byAcct = new Map<string, { account: string; name: string; debit: number; credit: number }>();
  for (const e of entries) {
    const x = byAcct.get(e.account) ?? { account: e.account, name: e.accountName, debit: 0, credit: 0 };
    x.debit += e.debit; x.credit += e.credit;
    byAcct.set(e.account, x);
  }
  const accts = [...byAcct.values()].sort((a, b) => a.account.localeCompare(b.account));
  const td = round2(accts.reduce((s, a) => s + a.debit, 0)); const tc = round2(accts.reduce((s, a) => s + a.credit, 0));
  return h('div', null,
    h('p', { class: 'muted small' }, `Company ${company || '(none)'} → `, set ? h('a', { href: `#/mapping/${set.id}` }, set.name) : badge('No GL rules for this company', 'bad'),
      '. The company\'s combined results feed ', h('a', { href: '#/export/us' }, 'Export payroll journal'), '.'),
    h('div', { class: 'kpis' },
      kpi('Journal lines', String(entries.length), 'one per pay code per rule row'),
      kpi('Total debits', fmtMoney(td)), kpi('Total credits', fmtMoney(tc)),
      kpi('Balanced', Math.abs(td - tc) < 0.05 ? 'Yes' : 'No', `difference ${fmtMoney(td - tc)}`, Math.abs(td - tc) < 0.05 ? '' : 'warn'),
      kpi('Unmapped', String(unmapped.length), unmapped.length ? unmapped.join(', ') : 'All codes mapped', unmapped.length ? 'warn' : ''),
    ),
    card('Totals by account', table(accts, [
      { key: 'account', label: 'Account', value: a => `${a.account} ${a.name}` },
      { key: 'debit', label: 'Debit', align: 'right', render: a => (a.debit ? fmtMoney(a.debit) : '') },
      { key: 'credit', label: 'Credit', align: 'right', render: a => (a.credit ? fmtMoney(a.credit) : '') },
      { key: 'net', label: 'Net (Dr − Cr)', align: 'right', value: a => round2(a.debit - a.credit), render: a => fmtMoney(round2(a.debit - a.credit) || 0) },
    ], { search: false, pageSize: 40, csvName: 'accounting-by-account.csv' })),
    card('Accounting entries by pay component', table(entries, [
      { key: 'payCode', label: 'Code' }, { key: 'description', label: 'Description' },
      { key: 'side', label: 'Dr/Cr', render: e => badge(e.side === 'DR' ? 'Debit' : 'Credit', e.side === 'DR' ? 'info' : 'muted') },
      { key: 'account', label: 'Account', value: e => `${e.account} ${e.accountName}` },
      { key: 'debit', label: 'Debit', align: 'right', render: e => (e.debit ? fmtMoney(e.debit) : '') },
      { key: 'credit', label: 'Credit', align: 'right', render: e => (e.credit ? fmtMoney(e.credit) : '') },
      { key: 'department', label: 'Department' }, { key: 'location', label: 'Location' }, { key: 'cls', label: 'Class' },
    ], { csvName: `payroll-accounting-${workerSel}.csv`, pageSize: 60 })),
    unmapped.length ? h('p', null, badge('Unmapped', 'bad'), ` ${unmapped.join(', ')} — add a rule in Setup → GL mapping.`) : null,
    h('p', { class: 'muted small' }, 'Negative amounts (e.g. unpaid leave dock) reverse the side. Expense accounts carry department, location and class; liability accounts post at company (subsidiary) level.'),
  );
}

export function viewResults(arg?: string): HTMLElement {
  const R = state.result;
  const us = R.register.filter(r => r.bucket !== 'Excluded' && passes(r));
  if (arg !== undefined) workerSel = arg.toUpperCase();
  const valid = us.some(r => r.workerId === workerSel);
  const open = (v: string) => { const id = v.trim().toUpperCase(); if (id) go('results', id); };
  const input = h('input', { type: 'search', list: 'worker-ids', placeholder: 'Enter worker ID, e.g. E0017', value: workerSel, onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') open((e.target as HTMLInputElement).value); }, onChange: (e: Event) => open((e.target as HTMLInputElement).value) });
  const picker = h('div', { class: 'row' },
    h('label', { class: 'filter' }, h('span', null, 'Worker'), input),
    h('datalist', { id: 'worker-ids' }, us.map(r => h('option', { value: r.workerId }, `${displayName(r.workerId)} · ${r.payGroup} · ${r.costCenter}`))),
    h('button', { class: 'btn', onClick: () => open((input as HTMLInputElement).value) }, 'Show results'),
    h('span', { class: 'muted small' }, 'Try: ', ...['E0017', 'E0021', 'E0002', 'E0028', 'E0149'].filter(id => us.some(r => r.workerId === id)).flatMap((id, i) => [i ? ', ' : '', h('a', { href: `#/results/${id}` }, id)])));
  const head = section('Payroll results by worker', 'Enter a worker ID to see everything applied to that worker this period: earnings, deductions and taxes; employer costs; time cards; pay inputs; and the debit/credit accounting.');
  if (state.filters.payGroup && !state.filters.payGroup.startsWith('US')) return h('div', null, head, card(null, h('p', null, `${state.filters.payGroup} is paid by the in-country provider; worker results are on the `, h('a', { href: '#/intl' }, 'International'), ' screen. Clear the pay group filter or pick a US pay group.')));
  if (!workerSel) return h('div', null, head, picker, card(null, h('p', { class: 'muted' }, `No worker selected yet. ${us.length} workers available${state.filters.payGroup ? ' in ' + state.filters.payGroup : ''}.`)));
  if (!valid) return h('div', null, head, picker, card(null, h('p', null, badge('Not found', 'warn'), ` ${workerSel} is not in a US pay run this period${state.filters.payGroup || state.filters.dept || state.filters.location ? ' (or is hidden by the pay group, department or location filter)' : ''}. International workers are on the International screen; contractors are not paid through payroll.`)));
  const r = us.find(x => x.workerId === workerSel)!;
  const w = R.model.workerById.get(workerSel)!;
  const ps = R.model.schedules.get(r.payGroup)!;
  return h('div', null, head, picker,
    card(null, h('div', { class: 'subhead' },
      h('div', null, h('h3', null, `${displayName(w.id)} · ${w.id} · ${w.payGroup}`), h('div', { class: 'muted small' }, `${w.dept} · ${r.location}, ${Object.keys(r.states).join(' → ')} · ${w.flsa} ${w.payRateType} · ${w.payRateType === 'Salary' ? fmtMoney(w.annualSalary) + '/yr' : fmtMoney(w.hourlyRate) + '/hr'} · period ${ps.start} to ${ps.end}, pay ${ps.payDate}`)),
      h('div', null, badge(r.bucket, r.bucket === 'Paid full period' ? 'ok' : r.bucket === 'Paid prorated' ? 'info' : 'warn'), ' ', h('a', { href: `#/payslip/${w.id}` }, 'Payslip →')))),
    tabs([
      { id: 'earn', label: 'Earnings, deductions & taxes', render: tabEarnings },
      { id: 'er', label: 'Other: employer costs', render: tabEmployer },
      { id: 'time', label: 'Time cards', render: tabTimecards },
      { id: 'inputs', label: 'Pay inputs', render: tabInputs },
      { id: 'acct', label: 'Payroll accounting', render: tabAccounting },
    ]),
  );
}
