// Edit data & re-run (Module 8 decision 8.1) and the read-only rules / pay code reference.
// Editable: events, timesheets, shift roster, payroll inputs, pay codes (name/active), GL mapping.
// Read-only: worker list, overtime rules, tax rules, benefit rates.
// Edits are saved in this browser only; the shared app always starts from the original data.

import { h, card, section, table, badge, clear, download } from './dom.ts';
import { state, saveEdits, resetEdits, rowsFor, uploadFile } from './state.ts';
import { refresh } from './router.ts';
import { toCsv } from '../engine/csv.ts';
import type { Row } from '../engine/csv.ts';
import { EDITABLE_FILES, DATA_FILES } from '../engine/files.ts';
import { rulesForCompany } from '../engine/prism.ts';

const LABELS: Record<string, string> = {
  events: 'Employee events (hires, terms, comp, bonus, leave, garnishment, time off)',
  timesheets: 'Timecards (punches, meal attestation)',
  shift_roster: 'Shift roster (overrides, swaps)',
  payroll_inputs: 'Payroll inputs (401(k) %, benefits, effective dates)',
  pay_codes: 'Earning & deduction codes',
  gl_posting_rules: 'GL mapping: posting rules by country (country, companies separated by |, pay code → account, debit/credit)',
};
const LOCKED: Record<string, string[]> = {
  pay_codes: ['code', 'category', 'calc_basis', 'fed_by', 'taxability', 'in_regular_rate', 'k401_eligible'],
  events: ['event_id'],
};
const KEY_COL: Record<string, string> = { events: 'worker_id', timesheets: 'worker_id', shift_roster: 'worker_id', payroll_inputs: 'worker_id', pay_codes: 'code', gl_posting_rules: 'pay_code' };

let activeFile: string = 'events';
let working: Row[] | null = null;
let workingFile = '';
let filter = '';
let dirty = false;

export function viewData(): HTMLElement {
  if (workingFile !== activeFile || !working) { working = rowsFor(activeFile).map(r => ({ ...r, __new: '' })); workingFile = activeFile; dirty = false; }
  const baseRows = (state.baseline as unknown as Record<string, Row[]>)[activeFile] ?? [];
  const cols = Object.keys(baseRows[0] ?? working[0] ?? {}).filter(c => c !== '__new');
  const locked = new Set(LOCKED[activeFile] ?? []);
  const gridBox = h('div');
  const status = h('span', { class: 'muted' });

  const drawGrid = () => {
    const rows = working!.map((r, i) => ({ r, i })).filter(({ r }) => !filter || Object.values(r).some(v => String(v).toLowerCase().includes(filter.toLowerCase())));
    const shown = rows.slice(0, 150);
    const t = h('table', { class: 'grid edit' },
      h('thead', null, h('tr', null, h('th', null, ''), cols.map(c => h('th', null, c, locked.has(c) ? ' 🔒' : '')))),
      h('tbody', null, shown.map(({ r, i }) => h('tr', { class: r.__new ? 'newrow' : '' },
        h('td', null, h('button', { class: 'btn ghost xs', title: 'Delete row', onClick: () => { working!.splice(i, 1); dirty = true; drawGrid(); } }, '✕')),
        cols.map(c => h('td', null, (locked.has(c) && !r.__new)
          ? h('span', { class: 'locked' }, r[c] ?? '')
          : h('input', { value: r[c] ?? '', size: Math.max(4, Math.min(28, String(r[c] ?? '').length + 1)), onInput: (e: Event) => { r[c] = (e.target as HTMLInputElement).value; dirty = true; status.textContent = 'Unsaved changes'; } })))))));
    clear(gridBox).append(h('div', null, h('div', { class: 'table-scroll tall' }, t), rows.length > 150 ? h('p', { class: 'muted' }, `Showing 150 of ${rows.length} rows — narrow with the search box.`) : null));
  };

  const save = () => {
    const clean = working!.map(r => { const { __new: _n, ...rest } = r; void _n; return rest; });
    const bad = clean.flatMap((r, i) => Object.entries(r).filter(([k, v]) => /date|effective_|^date$/.test(k) && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)).map(([k, v]) => `row ${i + 1} ${k}="${v}"`));
    if (bad.length) { alert(`Dates must be YYYY-MM-DD:\n${bad.slice(0, 10).join('\n')}`); return; }
    saveEdits(activeFile, clean);
    working = null; dirty = false;
    refresh();
  };

  const fileTabs = h('div', { class: 'tabs' }, EDITABLE_FILES.map(f => h('button', { class: `tab ${f === activeFile ? 'active' : ''}`, onClick: () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    activeFile = f; working = null; filter = ''; refresh();
  } }, f.replace('_', ' '), state.editedFiles.includes(f) ? ' •' : '')));

  drawGrid();
  return h('div', null,
    section('Edit data and re-run', 'Change event dates, punches, roster rows, deduction elections, code names or GL accounts, then re-run. Every screen recalculates and the dashboard shows the difference vs the original run. Edits are saved only in your browser; the worker list, overtime rules, tax rules and benefit rates are read-only.'),
    fileTabs,
    card(LABELS[activeFile],
      h('div', { class: 'row' },
        h('input', { type: 'search', placeholder: `Filter (e.g. ${KEY_COL[activeFile] === 'code' ? 'OT_15' : 'E0017'})`, value: filter, onInput: (e: Event) => { filter = (e.target as HTMLInputElement).value; drawGrid(); } }),
        h('button', { class: 'btn ghost sm', onClick: () => { const blank: Row = { __new: '1' }; cols.forEach(c => (blank[c] = '')); if (activeFile === 'events') blank.event_id = `EV${String(working!.length + 1).padStart(3, '0')}X`; if (activeFile === 'shift_roster') blank.seq = String(Math.max(0, ...working!.map(r => Number(r.seq) || 0)) + 1); working!.unshift(blank); dirty = true; drawGrid(); } }, '+ Add row'),
        h('button', { class: 'btn', onClick: save }, 'Save & re-run'),
        state.editedFiles.includes(activeFile as never) ? h('button', { class: 'btn ghost sm', onClick: () => { resetEdits(activeFile); working = null; refresh(); } }, 'Reset this file') : null,
        h('button', { class: 'btn ghost sm', onClick: () => download(`${activeFile}.csv`, toCsv(rowsFor(activeFile))) }, 'Download CSV'),
        status,
        state.editedFiles.includes(activeFile as never) ? badge('Edited', 'warn') : badge('Original', 'ok')),
      gridBox),
    card('Replace a whole file (CSV upload)',
      h('p', { class: 'muted' }, 'Upload a CSV with the same columns to replace any input file and re-run. Uploads of read-only files last for this session only.'),
      h('div', { class: 'row' },
        h('select', { id: 'upfile' }, DATA_FILES.map(f => h('option', { value: f }, f))),
        h('input', { type: 'file', accept: '.csv', onChange: async (e: Event) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          const target = (document.getElementById('upfile') as HTMLSelectElement).value;
          if (!file) return;
          uploadFile(target, await file.text());
          working = null; refresh();
        } }))),
  );
}

export function viewRules(): HTMLElement {
  const M = state.result.model;
  const r = M.rules;
  const usRules = rulesForCompany(M, 'NC-US').rules;
  return h('div', null,
    section('Rules, pay codes and mapping', 'Read-only rule parameters from the Overtime rules and Supplemental Tax & Benefits files and the module decisions. Pay code names and GL mapping are editable on the Edit data screen.'),
    h('div', { class: 'grid2' },
      card('Time rules', table([
        { k: 'Workweek', v: 'Sunday–Saturday' },
        { k: 'CA (US California Non-Exempt)', v: '1.5x over 8/day or 40/week; 2x over 12/day; 7th consecutive day 1.5x first 8, 2x after' },
        { k: 'Non-CA', v: '1.5x over 40/week' },
        { k: 'Night differential', v: `$${r.time.nightWindow.ratePerHour.toFixed(2)}/hr ${r.time.nightWindow.start}–${r.time.nightWindow.end}` },
        { k: 'Shift differentials', v: Object.entries(r.time.shiftDifferentials).filter(([, v]) => v).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ') + ' (no stacking: higher applies)' },
        { k: 'Regular rate', v: 'Weekly (straight pay + differentials) ÷ hours; used for OT and meal penalty' },
        { k: 'Meal penalty (CA)', v: '1 hr at regular rate; missed (per attestation) or started after hour 5; max 1/day; none ≤5 hrs' },
        { k: 'Punches', v: 'Duplicates removed; time after term excluded; overnight credited to start day' },
      ], [{ key: 'k', label: 'Rule' }, { key: 'v', label: 'Setting' }], { search: false })),
      card('Taxes, benefits, FX', table([
        { k: 'Federal income tax', v: `${r.usTax.fitFlatRate * 100}% flat` },
        { k: 'State income tax', v: Object.entries(r.usTax.sitRates).map(([s, v]) => `${s} ${(v * 100).toFixed(2)}%`).join(', ') },
        { k: 'CA SDI', v: `${r.usTax.caSdiRate * 100}%` },
        { k: 'FICA', v: `OASDI ${r.usTax.oasdiRate * 100}% to $${r.usTax.oasdiWageBase.toLocaleString()} YTD; Medicare ${r.usTax.medicareRate * 100}% (EE and ER)` },
        { k: 'FUTA / SUI', v: `${r.usTax.futaRate * 100}% / ${r.usTax.suiRate * 100}% on first $7,000 YTD` },
        { k: 'YTD', v: 'Derived: pay × 2026 periods worked before this period' },
        { k: 'Benefits (employee)', v: 'Payroll inputs: medical $200, dental $44, vision $30 per period (Section 125); 401(k) % of gross incl. bonus' },
        { k: 'Employer', v: `US benefits load ${r.benefits.employerLoadPctOfGross * 100}% of gross; 401(k) match 100% up to 4%. International employer-paid benefits ${r.intl.employerBenefitsLoadPctOfGross * 100}% of gross (on the vendor register)` },
        { k: 'UK / Canada / India employer', v: `NI 13.8% above £758/mo · CPP+EI 7.5% · PF 12% of 50% basic, cap ₹15,000` },
        { k: 'FX to USD', v: Object.entries(r.intl.fxToUsd).map(([c, v]) => `${c} ${v}`).join(', ') },
      ], [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Setting' }], { search: false })),
    ),
    card('Absence plans', table(Object.entries(r.absence).map(([plan, p]) => ({ plan, ...p })), [
      { key: 'plan', label: 'Plan' }, { key: 'unit', label: 'Unit' }, { key: 'method', label: 'Accrual method' },
      { key: 'rate', label: 'Rate', value: p => p.rate ?? p.perMonth ?? '' }, { key: 'cap', label: 'Cap', value: p => p.cap ?? '' },
      { key: 'payout', label: 'Payout at term', value: p => (p.payout ? 'Yes' : 'No') },
    ], { search: false })),
    card('Pay codes and GL mapping', table([...M.payCodes.values()], [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'category', label: 'Type' }, { key: 'calcBasis', label: 'Basis' },
      { key: 'fedBy', label: 'Fed by' }, { key: 'taxability', label: 'Taxability' },
      { key: 'rr', label: 'In reg. rate', value: p => (p.inRegularRate ? 'Y' : '') }, { key: 'k', label: '401(k)', value: p => (p.k401Eligible ? 'Y' : '') },
      { key: 'post', label: 'Posting (US rules)', value: p => usRules.filter(r => r.payCode === p.code).map(r => `${r.side} ${r.account}`).join(' / ') },
      { key: 'active', label: 'Active', render: p => (p.active ? badge('Active', 'ok') : badge('Inactive', 'muted')) },
    ], { pageSize: 80, csvName: 'pay-codes-mapping.csv' })),
    card('Chart of accounts', table([...M.glAccounts.values()], [{ key: 'account', label: 'Account' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'segmentLevel', label: 'Segments' }], { search: false, pageSize: 60 })),
  );
}
