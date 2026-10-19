// Export payroll journal (one close task for all companies) and the GL mapping setup.
//
// Two routes, one journal format:
//  - US: payroll is calculated here, so the company's combined payroll results are already
//    worker × pay code with company, department and location. No upload, no transpose: the
//    lines are posted with the company's rules (the same lines as Payroll results → Payroll
//    accounting), then Generate NetSuite CSV.
//  - International: upload the vendor's payroll register → route rows by company → validate
//    and transpose → Apply mapping → Generate NetSuite CSV.
// Generate shows a preview; then Download CSV or Transmit to NetSuite (simulated).

import { h, kpi, card, section, table, badge, download, fmtMoney, collapsible } from './dom.ts';
import { state, saveEdits, transmitted, recordTransmission } from './state.ts';
import { refresh, go } from './router.ts';
import { toCsv, parseCsv } from '../engine/csv.ts';
import type { Row } from '../engine/csv.ts';
import { importRegister, payCodeColumns, postingRules, mappingSets, companies, applyMapping, netsuiteRows, NETSUITE_COLUMNS, usJournals, COUNTRY_NAMES } from '../engine/prism.ts';
import type { TransposedRow, MappingResult, CompanyImport, UsJournal, MappedLine } from '../engine/prism.ts';
import { JOURNAL_CSV_COLUMNS } from '../engine/gl.ts';

const typeTone = (t: string) => (t === 'Earning' ? 'ok' : t === 'Net pay' ? 'info' : t === 'Employer cost' ? 'muted' : t === 'Unmapped' ? 'bad' : 'warn');

// Session state for the export task.
let route: 'us' | 'intl' = 'us';
let usCompany = '';
let usPayGroup = '';
let loaded: { name: string; rows: Row[] } | null = null;
let applied: { rows: Row[]; results: MappingResult[] } | null = null;
let generatedKey = '';

const SAMPLES: { label: string; files: string[]; name: string }[] = [
  { label: 'UK', files: ['vendor_register_uk'], name: 'UK payroll register Oct 2026.csv' },
  { label: 'India', files: ['vendor_register_in'], name: 'India payroll register Oct 2026.csv' },
  { label: 'Canada', files: ['vendor_register_ca'], name: 'Canada payroll register Oct 2026.csv' },
  { label: 'All companies', files: ['vendor_register_uk', 'vendor_register_in', 'vendor_register_ca'], name: 'All companies payroll register Oct 2026.csv' },
];
const sampleRows = (files: string[]) => files.flatMap(f => ((state.baseline as unknown as Record<string, Row[]>)[f] ?? []));

function load(name: string, rows: Row[]) { loaded = { name, rows }; applied = null; refresh(); }

const step = (n: number, label: string, done: boolean, active: boolean) => h('div', { class: `xstep ${done ? 'done' : active ? 'active' : ''}` }, h('span', { class: 'xstep-n' }, done ? '✓' : String(n)), h('span', null, label));

export function viewExport(arg?: string): HTMLElement {
  if (arg === 'us' || arg === 'intl') route = arg;
  return h('div', null,
    section('Export payroll journal', 'Close task for every company. US payroll is calculated in Workday, so its journal comes straight from the combined payroll results for the company. International payroll is calculated by the vendor, so its journal comes from the vendor\'s payroll register. Both use the same GL mapping and produce the same NetSuite file.'),
    h('div', { class: 'tabs' },
      h('button', { class: `tab ${route === 'us' ? 'active' : ''}`, onClick: () => go('export', 'us') }, 'US · from payroll results'),
      h('button', { class: `tab ${route === 'intl' ? 'active' : ''}`, onClick: () => go('export', 'intl') }, 'International · vendor register')),
    route === 'us' ? viewUs() : viewIntl());
}

// ------------------------------------------------------------------ US route

function viewUs(): HTMLElement {
  const R = state.result;
  const M = R.model;
  const usCos = companies(M).filter(c => c.country === 'US');
  if (!usCos.some(c => c.company === usCompany)) usCompany = usCos[0]?.company ?? '';
  const info = usCos.find(c => c.company === usCompany);
  if (usPayGroup && !info?.payGroups.includes(usPayGroup)) usPayGroup = '';
  const results: UsJournal[] = usCompany ? usJournals(M, R.register, usCompany, usPayGroup) : [];
  const allOk = results.length > 0 && results.every(r => r.ok);
  const sel = (label: string, value: string, options: [string, string][], on: (v: string) => void) => h('label', { class: 'filter' }, h('span', null, label),
    h('select', { onChange: (e: Event) => { on((e.target as HTMLSelectElement).value); refresh(); } }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));
  return h('div', null,
    h('div', { class: 'xsteps' },
      step(1, 'Select company', !!usCompany, !usCompany),
      step(2, 'Journal lines from payroll results', allOk, results.length > 0 && !allOk),
      step(3, 'Generate NetSuite CSV', false, allOk)),
    card(null,
      h('div', { class: 'subhead' }, h('div', null, h('h3', null, '1 · Select company'), h('div', { class: 'muted small' }, 'Uses the combined payroll results for every US pay group of the company. No upload: results are already calculated here.'))),
      h('div', { class: 'row' },
        sel('Company', usCompany, usCos.map(c => [c.company, `${c.company} · ${c.subsidiary}`]), v => { usCompany = v; }),
        sel('Pay group', usPayGroup, [['', 'All pay groups'], ...(info?.payGroups ?? []).map(p => [p, p] as [string, string])], v => { usPayGroup = v; }))),
    results.length ? card(null,
      h('div', { class: 'subhead' }, h('h3', null, '2 · Journal lines from payroll results'),
        h('button', { class: 'btn ghost sm', onClick: () => download(`${usCompany}-payroll-journal-lines.csv`, toCsv(results.flatMap(r => detailRows(r, r.lines)))) }, 'Download journal lines CSV')),
      h('p', { class: 'muted small' }, 'Worker × pay code from the payroll results, with company, department, location and class from the worker record, posted with the ', h('a', { href: '#/mapping/US' }, 'US rules'), '. These are the same lines shown per worker on Payroll results → Payroll accounting. One journal per pay group (each has its own pay date).'),
      !allOk ? h('div', { class: 'error-box' }, h('strong', null, 'Journal blocked — no NetSuite file can be generated'),
        h('ul', null, results.filter(r => !r.ok).flatMap(r => r.blockers.map(b => h('li', null, h('strong', null, `${r.payGroup}: ${b.reason}`), ` — ${b.detail}`)))),
        h('a', { href: '#/mapping/US' }, 'Open GL mapping →')) : null,
      journalTable(results.map(r => ({ ...r, label: r.payGroup, extra: `${r.periodStart} to ${r.periodEnd} · ${r.workers} workers` }))),
      ...results.map(r => collapsible(`${r.payGroup} · ${r.journalId} — checks and ${r.lines.length} journal lines`, !r.ok,
        table(r.checks, checkCols(), { search: false }),
        r.ok ? summaryTable(r) : null,
        collapsible('Detail: worker × pay code → account', false, linesTable(r.lines, r.currency))))) : card(null, h('p', { class: 'muted' }, 'No US payroll results for this selection.')),
    allOk ? netsuiteStep(3, results, r => { const u = r as UsJournal; return `${u.company} ${u.payGroup} payroll ${u.periodStart} to ${u.periodEnd}`; }) : null,
    accrualsCard(['JE-ACCR-20261031', 'JE-ACCR-REV-20261101', 'JE-LEAVE-US-20261031'], 'Accrued wages for US Biweekly (Oct 18–31, auto-reverses Nov 1) and the leave liability true-up at Oct 31. Posted as their own journals.'),
  );
}

// ------------------------------------------------------------------ International route

function viewIntl(): HTMLElement {
  const M = state.result.model;
  const imp = loaded ? importRegister(M, loaded.rows) : null;
  const errors = imp ? imp.fileChecks.filter(c => c.level === 'error').length + imp.groups.reduce((s, g) => s + g.checks.filter(c => c.level === 'error').length, 0) : 0;
  const results = applied && loaded && applied.rows === loaded.rows ? applied.results : null;
  const allOk = !!results && results.length > 0 && results.every(r => r.ok);
  const upload = h('input', { type: 'file', accept: '.csv', style: { display: 'none' }, onChange: async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) load(f.name, parseCsv(await f.text()));
  } });

  return h('div', null,
    h('p', { class: 'muted small' }, 'Upload the vendor\'s payroll register (one row per worker, a company column, a column per pay code, no GL). Each row is routed by its company to the rules for that company\'s country, validated and transposed to one row per worker per pay code. Apply mapping posts every pay code to its account; if every company maps, generate the NetSuite file.'),
    h('div', { class: 'xsteps' },
      step(1, 'Upload register', !!loaded, !loaded),
      step(2, 'Route, validate and transpose', !!imp && errors === 0, !!imp && errors > 0),
      step(3, 'Apply mapping', allOk, !!imp && !allOk),
      step(4, 'Generate NetSuite CSV', false, allOk)),
    card(null,
      h('div', { class: 'subhead' },
        h('div', null, h('h3', null, '1 · Upload payroll register'), h('div', { class: 'muted small' }, loaded ? `${loaded.name} · ${loaded.rows.length} rows` : 'No file loaded yet')),
        h('div', { class: 'row tight' }, upload, h('button', { class: 'btn', onClick: () => upload.click() }, 'Upload register (CSV)'),
          loaded ? h('button', { class: 'btn ghost sm', onClick: () => { loaded = null; applied = null; refresh(); } }, 'Clear') : null)),
      h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'Demo files: '),
        ...SAMPLES.map(sm => h('span', { class: 'sample' },
          h('button', { class: 'btn ghost xs', onClick: () => load(sm.name, sampleRows(sm.files)) }, `Load ${sm.label}`),
          h('button', { class: 'btn ghost xs', title: 'Download this sample CSV', onClick: () => download(sm.name, toCsv(sampleRows(sm.files), headerUnion(sampleRows(sm.files)))) }, '⤓')))),
      h('p', { class: 'muted small' }, 'Required columns: employee_id, company (Workday company, e.g. NC-UK), then one column per pay code. Optional: employee_name, country, currency, period_start, period_end, pay_date, leave_balance_days.')),
    imp ? card(null,
      h('div', { class: 'subhead' }, h('h3', null, '2 · Route by company, validate and transpose'),
        h('button', { class: 'btn ghost sm', onClick: () => download('register-transposed.csv', toCsv(imp.groups.flatMap(g => g.transposed).map(t => ({ employee_id: t.employeeId, employee_name: t.employeeName, company: t.company, currency: t.currency, pay_code: t.payCode, description: t.description, type: t.type, amount: t.amount })))) }, 'Download transposed CSV')),
      table(imp.fileChecks, checkCols(), { search: false }),
      imp.groups.length ? table(imp.groups, [
        { key: 'company', label: 'Company' }, { key: 'sub', label: 'Subsidiary', value: g => g.info?.subsidiary ?? '—' },
        { key: 'map', label: 'Routed to GL mapping', render: g => (g.mappingSet ? h('a', { href: `#/mapping/${g.mappingSet.id}` }, g.mappingSet.name) : badge('No mapping', 'bad')) },
        { key: 'workers', label: 'Workers', align: 'right', value: g => g.rows.length },
        { key: 'codes', label: 'Pay codes', value: g => g.payCodes.join(', '), render: g => h('span', { class: 'small' }, g.payCodes.join(', ')) },
        { key: 'tx', label: 'Transposed rows', align: 'right', value: g => g.transposed.length },
        { key: 'st', label: 'Validation', render: g => { const e = g.checks.filter(c => c.level === 'error').length; return e ? badge(`${e} error${e > 1 ? 's' : ''}`, 'bad') : badge('Passed', 'ok'); } },
      ], { search: false }) : null,
      ...imp.groups.map(g => collapsible(`${g.company} · ${g.info?.subsidiary ?? 'unknown company'} — checks and transposed rows (${g.transposed.length})`, g.checks.some(c => c.level === 'error'),
        table(g.checks, checkCols(), { search: false }),
        h('p', { class: 'small muted' }, footing(g)),
        table(g.transposed, [
          { key: 'employeeId', label: 'Employee' }, { key: 'employeeName', label: 'Name' }, { key: 'payCode', label: 'Pay code' },
          { key: 'description', label: 'Description' },
          { key: 'type', label: 'Type', render: (t: TransposedRow) => badge(t.type, typeTone(t.type)) },
          { key: 'amount', label: `Amount (${g.currency})`, align: 'right', render: (t: TransposedRow) => fmtMoney(t.amount, g.currency) },
          { key: 'mapped', label: 'Posting rule', render: (t: TransposedRow) => (t.mapped ? badge('Mapped', 'ok') : badge('No rule', 'bad')) },
        ], { pageSize: 40 })))) : null,
    imp && imp.groups.length ? card(null,
      h('div', { class: 'subhead' }, h('h3', null, '3 · Apply mapping'),
        h('button', { class: 'btn', onClick: () => { applied = { rows: loaded!.rows, results: imp.groups.map(g => applyMapping(M, g)) }; refresh(); } }, results ? 'Re-apply mapping' : 'Apply mapping')),
      !results ? h('p', { class: 'muted small' }, 'Each company uses the GL mapping it is assigned to. Mapping fails if a company has no mapping, a pay code has no posting rule, an employee is not in Workday, a worker is missing company, department or location, or net pay does not foot.')
        : h('div', null,
          !allOk ? h('div', { class: 'error-box' }, h('strong', null, 'Mapping failed — no NetSuite file can be generated'),
            h('ul', null, results.filter(r => !r.ok).flatMap(r => r.blockers.map(b => h('li', null, h('strong', null, `${r.company}: ${b.reason}`), ` — ${b.detail}`)))),
            h('a', { href: '#/mapping' }, 'Open GL mapping →')) : null,
          table(results, [
            { key: 'company', label: 'Company' }, { key: 'subsidiary', label: 'Subsidiary' }, { key: 'mappingName', label: 'GL mapping' },
            { key: 'journalId', label: 'Journal' }, { key: 'currency', label: 'Cur' },
            { key: 'debit', label: 'Debits', align: 'right', render: r => (r.ok ? fmtMoney(r.totals.debit, r.currency) : '') },
            { key: 'credit', label: 'Credits', align: 'right', render: r => (r.ok ? fmtMoney(r.totals.credit, r.currency) : '') },
            { key: 'ok', label: 'Result', render: r => (r.ok ? badge('Mapped · balanced', 'ok') : badge('Failed', 'bad')) },
          ], { search: false }),
          ...results.filter(r => r.ok).map(r => collapsible(`${r.company} journal: ${r.summary.length} summarized lines from ${r.lines.length} detail lines`, false,
            table(r.summary, [
              { key: 'account', label: 'Account' }, { key: 'accountName', label: 'Account name' },
              { key: 'department', label: 'Department' }, { key: 'location', label: 'Location' }, { key: 'cls', label: 'Class' },
              { key: 'debit', label: `Debit (${r.currency})`, align: 'right', render: l => (l.debit ? fmtMoney(l.debit, r.currency) : '') },
              { key: 'credit', label: `Credit (${r.currency})`, align: 'right', render: l => (l.credit ? fmtMoney(l.credit, r.currency) : '') },
              { key: 'usd', label: 'USD (Dr − Cr)', align: 'right', value: l => l.debitUsd - l.creditUsd, render: l => fmtMoney(l.debitUsd - l.creditUsd) },
            ], { search: false, pageSize: 40 }),
            collapsible('Detail: worker × pay code → account', false, table(r.lines, [
              { key: 'employeeId', label: 'Employee' }, { key: 'payCode', label: 'Pay code' }, { key: 'type', label: 'Type' },
              { key: 'account', label: 'Account', value: l => `${l.account} ${l.accountName}` },
              { key: 'side', label: 'Dr/Cr', render: l => badge(l.side === 'DR' ? 'Debit' : 'Credit', l.side === 'DR' ? 'info' : 'muted') },
              { key: 'debit', label: 'Debit', align: 'right', render: l => (l.debit ? fmtMoney(l.debit, r.currency) : '') },
              { key: 'credit', label: 'Credit', align: 'right', render: l => (l.credit ? fmtMoney(l.credit, r.currency) : '') },
              { key: 'department', label: 'Department' }, { key: 'location', label: 'Location' },
            ], { pageSize: 50 })))))) : null,
    allOk ? netsuiteStep(4, results!, r => { const g = imp!.groups.find(x => x.company === r.company); return `${r.company} payroll ${g?.periodStart ?? ''} to ${g?.periodEnd ?? ''}`; }) : null,
    imp ? accrualsCard(imp.groups.map(g => `JE-LEAVE-${g.company.replace('NC-', '')}-20261031`), 'Leave liability true-up at Oct 31 for plans that pay out, for the companies in this register. Posted as its own journal.') : null,
  );
}

// ------------------------------------------------------------------ shared pieces

function journalTable(rows: (MappingResult & { label: string; extra: string })[]): HTMLElement {
  return table(rows, [
    { key: 'label', label: 'Journal for' }, { key: 'extra', label: 'Source' }, { key: 'journalId', label: 'Journal ID' },
    { key: 'date', label: 'Date' }, { key: 'currency', label: 'Cur' },
    { key: 'debit', label: 'Debits', align: 'right', render: r => (r.ok ? fmtMoney(r.totals.debit, r.currency) : '') },
    { key: 'credit', label: 'Credits', align: 'right', render: r => (r.ok ? fmtMoney(r.totals.credit, r.currency) : '') },
    { key: 'ok', label: 'Result', render: r => (r.ok ? badge('Mapped · balanced', 'ok') : badge('Blocked', 'bad')) },
  ], { search: false });
}

function summaryTable(r: MappingResult): HTMLElement {
  return table(r.summary, [
    { key: 'account', label: 'Account' }, { key: 'accountName', label: 'Account name' },
    { key: 'department', label: 'Department' }, { key: 'location', label: 'Location' }, { key: 'cls', label: 'Class' },
    { key: 'debit', label: `Debit (${r.currency})`, align: 'right', render: l => (l.debit ? fmtMoney(l.debit, r.currency) : '') },
    { key: 'credit', label: `Credit (${r.currency})`, align: 'right', render: l => (l.credit ? fmtMoney(l.credit, r.currency) : '') },
  ], { search: false, pageSize: 40 });
}

function linesTable(lines: MappedLine[], currency: string): HTMLElement {
  return table(lines, [
    { key: 'employeeId', label: 'Employee' }, { key: 'payCode', label: 'Pay code' }, { key: 'description', label: 'Description' },
    { key: 'type', label: 'Type', render: l => badge(l.type, typeTone(l.type)) },
    { key: 'account', label: 'Account', value: l => `${l.account} ${l.accountName}` },
    { key: 'side', label: 'Dr/Cr', render: l => badge(l.side === 'DR' ? 'Debit' : 'Credit', l.side === 'DR' ? 'info' : 'muted') },
    { key: 'debit', label: 'Debit', align: 'right', render: l => (l.debit ? fmtMoney(l.debit, currency) : '') },
    { key: 'credit', label: 'Credit', align: 'right', render: l => (l.credit ? fmtMoney(l.credit, currency) : '') },
    { key: 'department', label: 'Department' }, { key: 'location', label: 'Location' }, { key: 'cls', label: 'Class' },
  ], { pageSize: 50 });
}

const detailRows = (r: MappingResult, lines: MappedLine[]) => lines.map(l => ({
  journal_id: r.journalId, company: r.company, subsidiary: r.subsidiary, currency: r.currency, date: r.date, employee_id: l.employeeId,
  pay_code: l.payCode, description: l.description, type: l.type, debit_credit: l.side, account: l.account, account_name: l.accountName,
  debit: l.debit || '', credit: l.credit || '', department: l.department, location: l.location, class: l.cls,
}));

/** Generate NetSuite CSV → preview → Download CSV / Transmit to NetSuite (simulated). */
function netsuiteStep(n: number, results: MappingResult[], memo: (r: MappingResult) => string): HTMLElement {
  const key = results.map(r => `${r.journalId}:${r.totals.debit}`).join('|');
  const rows = results.flatMap(r => netsuiteRows(r, memo(r)));
  const debit = results.reduce((s, r) => s + r.totals.debit, 0);
  const credit = results.reduce((s, r) => s + r.totals.credit, 0);
  const multiCur = new Set(results.map(r => r.currency)).size > 1;
  const file = `netsuite-payroll-journal-${results.map(r => r.company).filter((c, i, a) => a.indexOf(c) === i).join('-')}-${results[0].date.replace(/-/g, '')}.csv`;
  const sent = results.map(r => transmitted(r.journalId)).filter(Boolean);
  const allSent = sent.length === results.length;
  const head = h('div', { class: 'subhead' }, h('h3', null, `${n} · Generate NetSuite CSV`),
    h('span', { class: 'muted small' }, `${results.length} journal${results.length === 1 ? '' : 's'} · summarized by subsidiary × account × department × location × class`));
  if (generatedKey !== key) {
    return card(null, head,
      h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => { generatedKey = key; refresh(); } }, 'Generate NetSuite CSV')),
      h('p', { class: 'muted small' }, 'Shows a preview of the file. From the preview you can download the CSV or transmit it to NetSuite.'));
  }
  const transmit = () => {
    if (!confirm(`Transmit ${results.length} journal${results.length === 1 ? '' : 's'} (${rows.length} lines) to NetSuite?\n\nSimulation: nothing leaves this browser.`)) return;
    recordTransmission({ journalIds: results.map(r => r.journalId), lines: rows.length, debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100 });
    refresh();
  };
  const last = sent[sent.length - 1];
  return card(null, head,
    h('div', { class: 'kpis' },
      kpi('Journals', String(results.length), results.map(r => r.journalId).join(', ')),
      kpi('Lines', String(rows.length), 'summarized'),
      multiCur ? kpi('Currencies', [...new Set(results.map(r => r.currency))].join(', '), 'one journal per company') : kpi('Total debits', fmtMoney(debit, results[0].currency)),
      multiCur ? kpi('Balanced', results.every(r => r.totals.balanced) ? 'Yes' : 'No', 'every journal') : kpi('Total credits', fmtMoney(credit, results[0].currency), Math.abs(debit - credit) < 0.01 ? 'balanced' : 'NOT balanced')),
    h('h4', null, 'Preview'),
    table(rows, [
      { key: 'journal_id', label: 'Journal' }, { key: 'subsidiary', label: 'Subsidiary' }, { key: 'date', label: 'Date' },
      { key: 'account', label: 'Account' }, { key: 'account_name', label: 'Account name' },
      { key: 'department', label: 'Department' }, { key: 'location', label: 'Location' }, { key: 'class', label: 'Class' },
      { key: 'currency', label: 'Cur' },
      { key: 'debit', label: 'Debit', align: 'right', render: r => (r.debit !== '' ? fmtMoney(Number(r.debit), String(r.currency)) : '') },
      { key: 'credit', label: 'Credit', align: 'right', render: r => (r.credit !== '' ? fmtMoney(Number(r.credit), String(r.currency)) : '') },
    ], { pageSize: 25 }),
    h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { class: 'btn', onClick: () => download(file, toCsv(rows, NETSUITE_COLUMNS)) }, 'Download CSV'),
      allSent ? h('button', { class: 'btn', disabled: true, title: 'Already transmitted. Reverse the journal in NetSuite before sending again.' }, 'Transmitted ✓')
        : h('button', { class: 'btn transmit', onClick: transmit }, 'Transmit to NetSuite'),
      allSent && last ? h('span', null, badge('Transmitted to NetSuite', 'ok'), h('span', { class: 'small muted' }, ` ${last.ref} · ${last.at} · ${last.lines} lines (simulated)`)) : null),
    h('p', { class: 'muted small' }, `File columns: ${NETSUITE_COLUMNS.join(', ')}. Transmit is a simulation; in production the Workday payroll journal connector sends the journal to NetSuite.`));
}

function accrualsCard(ids: string[], note: string): HTMLElement {
  const J = state.result.journal;
  const lines = J.lines.filter(l => ids.includes(l.journalId));
  if (!lines.length) return h('div');
  return collapsible('Month-end accruals (optional separate file)', false,
    h('p', { class: 'small muted' }, note),
    table(lines, [
      { key: 'journalId', label: 'Journal' }, { key: 'account', label: 'Account', value: l => `${l.account} ${l.accountName}` }, { key: 'department', label: 'Department' }, { key: 'location', label: 'Location' },
      { key: 'debit', label: 'Debit', align: 'right', render: l => (l.debit ? fmtMoney(l.debit, l.currency) : '') },
      { key: 'credit', label: 'Credit', align: 'right', render: l => (l.credit ? fmtMoney(l.credit, l.currency) : '') },
    ], { search: false, pageSize: 20 }),
    h('button', { class: 'btn ghost sm', onClick: () => download('netsuite-accruals-20261031.csv', toCsv(lines as unknown as Record<string, unknown>[], JOURNAL_CSV_COLUMNS)) }, 'Download accrual CSV'));
}

const checkCols = () => [
  { key: 'level', label: 'Result', render: (x: { level: string }) => badge(x.level === 'ok' ? 'Pass' : x.level === 'warning' ? 'Warning' : 'Error', x.level === 'ok' ? 'ok' : x.level === 'warning' ? 'warn' : 'bad') },
  { key: 'check', label: 'Check' }, { key: 'detail', label: 'Detail' },
];

function footing(g: CompanyImport): string {
  const by = (t: string) => g.transposed.filter(x => x.type === t).reduce((s, x) => s + x.amount, 0);
  return `Earnings ${fmtMoney(by('Earning'), g.currency)} − deductions ${fmtMoney(by('Deduction'), g.currency)} − employee taxes ${fmtMoney(by('Employee tax'), g.currency)} = net pay ${fmtMoney(by('Net pay'), g.currency)} · employer costs ${fmtMoney(by('Employer cost'), g.currency)}. Zero-value pay codes are not transposed.`;
}

function headerUnion(rows: Row[]): string[] {
  const head = ['employee_id', 'employee_name', 'company', 'country', 'currency', 'period_start', 'period_end', 'pay_date'];
  return [...head, ...payCodeColumns(rows), 'leave_balance_days'];
}

// ------------------------------------------------------------------ GL mapping setup
// One rules file (data/gl_posting_rules.csv). Rules are by country; each country lists the
// companies (of that country) it applies to.

let mapSel = '';

export function viewMapping(arg?: string): HTMLElement {
  const M = state.result.model;
  const sets = mappingSets(M);
  if (arg && sets.some(s => s.id === arg)) mapSel = arg;
  if (!sets.some(s => s.id === mapSel)) mapSel = sets[0]?.id ?? '';
  const set = sets.find(s => s.id === mapSel);
  const rules = postingRules(M).filter(r => r.mappingId === mapSel);
  const allCompanies = companies(M);
  const countryCompanies = allCompanies.filter(c => c.country === mapSel);
  const owners = (c: string) => sets.filter(s => s.companies.includes(c));
  const unassigned = allCompanies.filter(c => !owners(c.company).length);
  const conflicts = allCompanies.filter(c => owners(c.company).length > 1);
  const badAcct = rules.filter(r => !M.glAccounts.has(r.account));

  const toggle = (company: string, on: boolean) => {
    const rows = (state.current.gl_posting_rules ?? []).map(r => {
      if (r.country !== mapSel) return r;
      const cs = new Set((r.companies ?? '').split('|').filter(Boolean));
      if (on) cs.add(company); else cs.delete(company);
      return { ...r, companies: [...cs].join('|') };
    });
    saveEdits('gl_posting_rules', rows);
    refresh();
  };

  return h('div', null,
    section('GL mapping', 'One set of posting rules, organized by country. Pick the companies each country\'s rules apply to. Every pay code has a ledger account and a debit or credit side; employer costs have two rows (debit expense, credit liability). US payroll results and international vendor registers both post with these rules.'),
    conflicts.length || unassigned.length ? h('div', { class: 'error-box', style: { marginBottom: '14px' } },
      conflicts.length ? h('div', null, h('strong', null, 'Company under more than one country: '), conflicts.map(c => `${c.company} (${owners(c.company).map(s => s.name).join(', ')})`).join('; ')) : null,
      unassigned.length ? h('div', null, h('strong', null, 'Companies without rules: '), unassigned.map(c => c.company).join(', '), ' — their journals will fail to map.') : null) : null,
    h('div', { class: 'tabs' }, sets.map(s => h('button', { class: `tab ${s.id === mapSel ? 'active' : ''}`, onClick: () => go('mapping', s.id) }, COUNTRY_NAMES[s.country] ?? s.country))),
    set ? card(null,
      h('div', { class: 'subhead' },
        h('div', null, h('h3', null, set.name), h('div', { class: 'muted small' }, `Country ${set.country} · ${new Set(rules.map(r => r.payCode)).size} pay codes · ${rules.length} posting rows`)),
        badAcct.length ? badge(`${badAcct.length} account(s) not in chart`, 'bad') : badge('All accounts valid', 'ok')),
      h('h4', null, `Applies to companies in ${COUNTRY_NAMES[set.country] ?? set.country}`),
      countryCompanies.length ? h('div', { class: 'company-picks' }, countryCompanies.map(c =>
        h('label', { class: `company-pick ${set.companies.includes(c.company) ? 'on' : ''}` },
          h('input', { type: 'checkbox', checked: set.companies.includes(c.company), onChange: (e: Event) => toggle(c.company, (e.target as HTMLInputElement).checked) }),
          h('span', null, h('strong', null, c.company), h('span', { class: 'muted small' }, ` ${c.subsidiary} · ${c.currency} · ${c.payGroups.join(', ')}`)))))
        : h('p', { class: 'muted small' }, 'No Workday companies in this country.'),
      h('p', { class: 'muted small' }, 'Changes are saved in this browser and apply on the next export. Edit rule rows on Edit data & re-run → "gl posting rules".')) : null,
    set ? card(null, table(rules, [
      { key: 'payCode', label: 'Pay code' }, { key: 'description', label: 'Description' },
      { key: 'type', label: 'Type', render: r => badge(r.type, typeTone(r.type)) },
      { key: 'side', label: 'Debit / credit', render: r => badge(r.side === 'DR' ? 'Debit' : 'Credit', r.side === 'DR' ? 'info' : 'muted') },
      { key: 'account', label: 'Account' },
      { key: 'accountName', label: 'Account name', render: r => (M.glAccounts.has(r.account) ? r.accountName || M.glAccounts.get(r.account)!.name : badge('Not in chart', 'bad')) },
      { key: 'segments', label: 'Segments' },
    ], { pageSize: 80, csvName: `gl-posting-rules-${mapSel}.csv` })) : null,
  );
}
