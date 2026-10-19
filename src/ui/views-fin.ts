// Reconciliation, GL & NetSuite export, International, Controls & clean close.

import { h, kpi, card, section, table, fmtMoney, fmtNum, badge, tabs, download } from './dom.ts';
import { state, passes, getActions, resolveItem, reopenItem } from './state.ts';
import { vendorKey } from '../engine/status.ts';
import { refresh } from './router.ts';
import { go } from './router.ts';
import { toCsv } from '../engine/csv.ts';
import { JOURNAL_CSV_COLUMNS } from '../engine/gl.ts';
import type { LegacyWorker } from '../engine/recon.ts';

const clsTone = (c: string) => (c === 'Unexplained' ? 'bad' : c === 'Timing' ? 'info' : c === 'Data' ? 'warn' : c === 'Provider error' || c === 'Legacy error' ? 'bad' : 'muted');

export function viewRecon(): HTMLElement {
  const R = state.result;
  const L = R.legacy;
  return h('div', null,
    section('Payroll parallel test', 'Headcount (active vs paid) by pay run, and an employee-level comparison of both US pay groups to the legacy Rippling register. Every variance carries a class, a root cause and what we would do in a real parallel run.'),
    tabs([
      { id: 'legacy', label: 'Legacy register (Rippling)', render: () => !L.available ? card(null, 'No legacy register loaded.') : h('div', null,
        h('div', { class: 'kpis' },
          kpi('Employees compared', String(L.workers.length + L.matched)), kpi('Matched exactly', String(L.matched)),
          kpi('With variances', String(L.workers.length), `${L.workers.filter(w => w.explained).length} explained`, L.workers.every(w => w.explained) ? '' : 'warn'),
          ...L.byClass.map(c => kpi(c.cls, String(c.workers), `net impact ${fmtMoney(c.netImpact)}`)),
        ),
        card('Totals by pay group (Workday vs Rippling)', table(L.totals, [
          { key: 'payGroup', label: 'Pay group' },
          { key: 'oursGross', label: 'Workday gross', align: 'right', render: r => fmtMoney(r.oursGross) },
          { key: 'legacyGross', label: 'Rippling gross', align: 'right', render: r => fmtMoney(r.legacyGross) },
          { key: 'dg', label: 'Δ gross', align: 'right', value: r => r.legacyGross - r.oursGross, render: r => fmtMoney(r.legacyGross - r.oursGross) },
          { key: 'oursNet', label: 'Workday net', align: 'right', render: r => fmtMoney(r.oursNet) },
          { key: 'legacyNet', label: 'Rippling net', align: 'right', render: r => fmtMoney(r.legacyNet) },
          { key: 'dn', label: 'Δ net', align: 'right', value: r => r.legacyNet - r.oursNet, render: r => fmtMoney(r.legacyNet - r.oursNet) },
          { key: 'der', label: 'Δ employer', align: 'right', value: r => r.legacyEr - r.oursEr, render: r => fmtMoney(r.legacyEr - r.oursEr) },
        ], { search: false })),
        card('Variances by employee', table(L.workers, [
          { key: 'workerId', label: 'Worker' }, { key: 'payGroup', label: 'Pay group' },
          { key: 'cls', label: 'Class', render: w => badge(w.cls, clsTone(w.cls)) },
          { key: 'oursNet', label: 'Workday net', align: 'right', render: w => fmtMoney(w.oursNet) },
          { key: 'legacyNet', label: 'Rippling net', align: 'right', render: w => fmtMoney(w.legacyNet) },
          { key: 'd', label: 'Δ net', align: 'right', value: w => w.legacyNet - w.oursNet, render: w => fmtMoney(w.legacyNet - w.oursNet) },
          { key: 'codes', label: 'Components that differ', value: w => w.diffs.map(d => d.code).join(' '), render: w => h('span', { class: 'small' }, w.diffs.filter(d => d.code !== 'NET_PAY').map(d => `${d.code} ${fmtMoney(d.diff)}`).join(' · ')) },
          { key: 'rootCause', label: 'Root cause', render: w => h('span', { class: 'small' }, w.rootCause) },
          { key: 'disposition', label: 'Disposition (real parallel)', render: w => h('span', { class: 'small' }, w.disposition) },
        ], { csvName: 'legacy-variances.csv', onRow: (w: LegacyWorker) => go('payslip', w.workerId) })),
      ) },
      { id: 'headcount', label: 'Headcount: active vs paid', render: () => h('div', null,
        card('Active vs paid by pay run', table(R.headcount, [
          { key: 'payGroup', label: 'Pay run' }, { key: 'workerFile', label: 'Active in worker file', align: 'right' },
          ...['Paid full period', 'Paid prorated', 'Active, not paid', 'Excluded'].map(b => ({ key: b, label: b, align: 'right' as const, value: (r: typeof R.headcount[number]) => r.buckets.find(x => x.bucket === b)?.count ?? 0 })),
          { key: 'paid', label: 'Paid', align: 'right', value: r => r.buckets.filter(b => b.bucket.startsWith('Paid')).reduce((s, b) => s + b.count, 0) },
          { key: 'tie', label: 'Ties', render: r => (r.buckets.reduce((s, b) => s + b.count, 0) === r.workerFile ? badge('✓', 'ok') : badge('✗', 'bad')) },
        ], { search: false, onRow: r => go('payruns', r.payGroup) })),
        card('Workday vs Rippling paid headcount', table(L.headcount, [
          { key: 'payGroup', label: 'Pay group' }, { key: 'oursPaid', label: 'Paid in Workday', align: 'right' }, { key: 'legacyPaid', label: 'Paid in Rippling', align: 'right' },
          { key: 'onlyOurs', label: 'Only in Workday', value: r => r.onlyOurs.join(', ') }, { key: 'onlyLegacy', label: 'Only in Rippling', value: r => r.onlyLegacy.join(', ') },
        ], { search: false })),
        card('Every delta explained', table(R.headcount.flatMap(run => run.buckets.filter(b => b.bucket !== 'Paid full period').flatMap(b => b.workers.map(w => ({ run: run.payGroup, bucket: b.bucket, ...w })))), [
          { key: 'run', label: 'Pay run' }, { key: 'bucket', label: 'Bucket' }, { key: 'id', label: 'Worker' }, { key: 'reason', label: 'Reason' },
        ], { csvName: 'headcount-deltas.csv' })),
        card(null, h('p', null, `Contractors: ${R.model.workers.filter(w => w.workerType === 'Contractor').length} in the worker file, excluded from every pay run (paid through AP).`)),
      ) },
    ]),
  );
}

export function viewIntl(arg?: string): HTMLElement {
  const R = state.result;
  const I = R.intl;
  const exp = I.expected.filter(e => passes(e));
  const vById = new Map(I.vendor.map(v => [v.workerId, v]));
  return h('div', null,
    section('International payroll (UK, India, Canada)', 'Workday sends worker, compensation, absence and one-time payments to one PECI-based Global Payroll Connect partner. The provider runs gross-to-net; its register is imported (Workday Prism), reconciled to what Workday sent, and posted to each NetSuite subsidiary in local currency with USD at the reporting rates. Pay date moved from Sun Oct 25 to Fri Oct 23.'),
    h('div', { class: 'kpis' }, ...I.byCountry.map(c => kpi(c.payGroup, fmtMoney(c.employerCostVendorUsd, 'USD', 0), `employer cost USD · ${c.headcountVendor} paid · FX ${c.fx}`))),
    card('Monthly employer cost by country', table(I.byCountry, [
      { key: 'payGroup', label: 'Country' }, { key: 'currency', label: 'Cur' },
      { key: 'headcountExpected', label: 'Sent', align: 'right' }, { key: 'headcountVendor', label: 'Paid by provider', align: 'right' },
      { key: 'grossExpected', label: 'Gross expected', align: 'right', render: c => fmtMoney(c.grossExpected, c.currency) },
      { key: 'grossVendor', label: 'Gross provider', align: 'right', render: c => fmtMoney(c.grossVendor, c.currency) },
      { key: 'erExpected', label: 'Employer statutory (check)', align: 'right', render: c => fmtMoney(c.erExpected, c.currency) },
      { key: 'erVendor', label: 'Employer statutory (provider)', align: 'right', render: c => fmtMoney(c.erVendor, c.currency) },
      { key: 'benVendor', label: 'Employer benefits (provider)', align: 'right', render: c => fmtMoney(c.benVendor, c.currency) },
      { key: 'usd', label: 'Employer cost USD', align: 'right', render: c => fmtMoney(c.employerCostVendorUsd) },
    ], { search: false })),
    card('Provider variances (each cycle before GL posting)', table(I.variances, [
      { key: 'res', label: 'Resolution', value: v => (getActions().resolved[vendorKey(v.workerId)] ? 'Resolved' : 'Open'), render: v => {
        const r = getActions().resolved[vendorKey(v.workerId)];
        return r ? h('span', null, badge('Resolved', 'ok'), h('div', { class: 'small muted' }, `${r.note} · ${r.at}`), h('button', { class: 'btn ghost xs', onClick: () => { reopenItem(vendorKey(v.workerId)); refresh(); } }, 'Reopen'))
          : h('button', { class: 'btn ghost xs', onClick: () => { const note = prompt(`Resolution for ${v.workerId} (all fields)`, v.disposition.slice(0, 120)); if (note) { resolveItem(vendorKey(v.workerId), note); refresh(); } } }, 'Resolve');
      } },
      { key: 'workerId', label: 'Worker' }, { key: 'payGroup', label: 'Country' }, { key: 'field', label: 'Field' },
      { key: 'expected', label: 'Workday', align: 'right', render: v => (typeof v.expected === 'number' ? fmtNum(v.expected) : v.expected) },
      { key: 'vendor', label: 'Provider', align: 'right', render: v => (typeof v.vendor === 'number' ? fmtNum(v.vendor) : v.vendor) },
      { key: 'diff', label: 'Δ', align: 'right', render: v => fmtNum(v.diff) }, { key: 'currency', label: 'Unit' },
      { key: 'cls', label: 'Class', render: v => badge(v.cls, clsTone(v.cls)) },
      { key: 'rootCause', label: 'Root cause', render: v => h('span', { class: 'small' }, v.rootCause) },
      { key: 'disposition', label: 'Disposition', render: v => h('span', { class: 'small' }, v.disposition) },
    ], { csvName: 'provider-variances.csv' })),
    card('Worker detail: sent vs provider register', table(exp, [
      { key: 'workerId', label: 'Worker' }, { key: 'payGroup', label: 'Country', value: e => e.payGroup.replace(' Monthly', '') },
      { key: 'bucket', label: 'Bucket' },
      { key: 'base', label: 'Base (sent)', align: 'right', render: e => fmtMoney(e.base, e.currency) },
      { key: 'bonus', label: 'Bonus', align: 'right', render: e => (e.bonus ? fmtMoney(e.bonus, e.currency) : '') },
      { key: 'payout', label: 'Payout', align: 'right', render: e => (e.payout ? fmtMoney(e.payout, e.currency) : '') },
      { key: 'gross', label: 'Gross (sent)', align: 'right', render: e => fmtMoney(e.gross, e.currency) },
      { key: 'vg', label: 'Gross (provider)', align: 'right', value: e => vById.get(e.workerId)?.gross ?? 0, render: e => { const v = vById.get(e.workerId); return v ? (Math.abs(v.gross - e.gross) > 1 ? h('span', { class: 'delta' }, fmtMoney(v.gross, e.currency)) : fmtMoney(v.gross, e.currency)) : badge('missing', 'bad'); } },
      { key: 'vn', label: 'Net (provider)', align: 'right', value: e => vById.get(e.workerId)?.net ?? 0, render: e => fmtMoney(vById.get(e.workerId)?.net, e.currency) },
      { key: 'er', label: e0Label(), align: 'right', render: e => fmtMoney(e.erStatutory, e.currency) },
      { key: 'employerCostUsd', label: 'Employer cost USD', align: 'right', render: e => fmtMoney(e.employerCostUsd) },
      { key: 'abs', label: 'Leave bal. WD / provider', value: e => `${e.absenceEnding ?? '–'} / ${vById.get(e.workerId)?.absenceBalance ?? '–'}` },
    ], { csvName: 'intl-workers.csv', pageSize: 70, rowClass: e => (e.workerId === arg ? 'hl' : '') })),
    card('UK data mapping (PECI out, results in)', table(UK_MAPPING, [
      { key: 'dir', label: 'Direction' }, { key: 'area', label: 'Area' }, { key: 'workday', label: 'Workday source' }, { key: 'provider', label: 'Provider field' }, { key: 'note', label: 'Notes' },
    ], { search: false, pageSize: 40 })),
    card('Monthly calendar (October)', table(CALENDAR, [{ key: 'date', label: 'Date' }, { key: 'step', label: 'Step' }, { key: 'owner', label: 'Owner' }], { search: false })),
  );
}
const e0Label = () => 'Employer statutory (check)';

const UK_MAPPING = [
  { dir: 'Out (PECI)', area: 'Worker', workday: 'Employee ID, legal name, NI number, address, hire/term dates', provider: 'Employee record', note: 'Effective-dated changes only (PECI)' },
  { dir: 'Out (PECI)', area: 'Worker', workday: 'Tax code, student loan plan, starter declaration', provider: 'HMRC tax fields', note: 'From UK payroll tax election' },
  { dir: 'Out (PECI)', area: 'Compensation', workday: 'Annual salary + effective date', provider: 'Salary', note: 'Provider prorates (E0084 Oct 12 change)' },
  { dir: 'Out (PECI)', area: 'Compensation', workday: 'Pension scheme + contribution %', provider: 'Pension (auto-enrolment)', note: '' },
  { dir: 'Out (PECI)', area: 'Absence', workday: 'Time off entries, unpaid leave, ending balances', provider: 'Absence / holiday', note: 'Balances print on payslip; Workday is source of truth' },
  { dir: 'Out (PECI)', area: 'One-time payment', workday: 'Sign-on, spot bonus', provider: 'Additional payments', note: 'Late changes go in a supplementary file' },
  { dir: 'Out (PECI)', area: 'Termination', workday: 'Term date, reason, holiday payout days', provider: 'Leaver + P45', note: '' },
  { dir: 'In (results)', area: 'Gross-to-net', workday: 'Prism: payroll results dataset', provider: 'Gross, PAYE, EE NI, pension, net', note: 'Imported each cycle' },
  { dir: 'In (results)', area: 'Employer costs', workday: 'Prism: employer cost', provider: 'ER NI, ER pension', note: 'Checked against 13.8% above £758' },
  { dir: 'In (results)', area: 'GL', workday: 'Posting rules → NetSuite CSV', provider: 'Pay element totals', note: 'Posts to NeoCloud UK Ltd in GBP' },
];
const CALENDAR = [
  { date: 'Mon Oct 12', step: 'Change cutoff (hires, terms, comp, absence, one-time payments)', owner: 'HR / People Tech' },
  { date: 'Tue Oct 13', step: 'PECI file sent to provider', owner: 'Integration (automated)' },
  { date: 'Oct 14–16', step: 'Provider processes payroll', owner: 'Provider' },
  { date: 'Mon Oct 19', step: 'Results returned (gross-to-net, employer costs, GL)', owner: 'Provider' },
  { date: 'Tue Oct 20', step: 'Review, reconcile and approve', owner: 'Payroll Manager' },
  { date: 'Wed Oct 21', step: 'Funding sent', owner: 'Treasury' },
  { date: 'Fri Oct 23', step: 'Pay date (moved from Sun Oct 25)', owner: 'Provider' },
  { date: 'Mon Oct 26', step: 'GL posted to NetSuite', owner: 'Accounting' },
];

export function viewControls(): HTMLElement {
  const R = state.result;
  const J = R.journal;
  const leaveRoll = R.absence.every(a => a.ending === null || Math.abs((a.opening ?? 0) + a.accrued - a.used - a.payoutQty - a.ending) < 0.01 || a.flags.some(f => /forfeited/.test(f)));
  const auto = [
    { item: 'Register = Workday journal = NetSuite (by account, to the cent)', ok: J.ties.filter(t => /gross|2101/.test(t.label)).every(t => t.ok) },
    { item: 'Every journal balances', ok: J.journals.every(j => j.balanced) },
    { item: 'No unmapped lines', ok: !J.issues.some(i => /mapping|chart/.test(i.message)) },
    { item: 'Gross pay clearing (2100) and provider clearing (2170) net to zero', ok: J.ties.filter(t => /2100|2170/.test(t.label)).every(t => t.ok) },
    { item: 'Accrual posted and auto-reversal scheduled', ok: J.journals.some(j => j.journalId.startsWith('JE-ACCR-2')) && J.journals.some(j => j.journalId.startsWith('JE-ACCR-REV')) },
    { item: 'Bank file + checks = register net (US); provider funding = provider net (intl)', ok: J.bank.every(b => Math.abs(b.difference) < 0.01) },
    { item: 'Leave liability roll-forward ties to absence balances', ok: leaveRoll },
    { item: 'Prism import complete (provider rows = workers sent)', ok: R.intl.byCountry.every(c => c.headcountVendor === c.headcountExpected) },
    { item: 'Every legacy variance explained', ok: R.legacy.workers.every(w => w.explained) },
    { item: 'Every provider variance explained', ok: R.intl.variances.every(v => v.explained) },
    { item: 'Headcount buckets tie to the worker file', ok: R.headcount.every(r => r.buckets.reduce((s, b) => s + b.count, 0) === r.workerFile) },
    { item: 'Flux review: changes >10% vs prior period have an explanation', ok: R.audit.priorAvailable },
  ];
  const manual = [
    'Tax remittance: withholding and employer tax liabilities = amounts remitted (IRS, states); tie to Form 941 and state returns',
    '401(k) deferrals + match = recordkeeper deposit within the DOL window; 401(k) funding complete',
    'Benefit deductions = carrier invoices; garnishments = agency payments (incl. E0017 termination notice)',
    'Net pay clearing at zero after the bank clears; uncashed checks aged for escheatment',
    'International funding = provider register; FX difference posted to FX gain/loss',
    'Off-cycle and manual payments since the last run are in the journal (e.g. CA final checks)',
    'All outbound integration runs (PECI, bank, benefits, 401(k), GL) completed successfully',
    'No manual journal entries to payroll accounts without Controller approval',
    'Controller sign-off within 2 business days of pay date',
  ];
  return h('div', null,
    section('Controls and clean close', 'A clean payroll close means every check below is green and every manual item has evidence attached. Automated checks are re-evaluated on every run.'),
    h('div', { class: 'kpis' }, kpi('Automated checks passing', `${auto.filter(a => a.ok).length} / ${auto.length}`, '', auto.every(a => a.ok) ? '' : 'warn'), kpi('Manual items', String(manual.length), 'evidence required')),
    card('Automated clean-close checks', table(auto, [{ key: 'item', label: 'Check' }, { key: 'ok', label: 'Status', render: a => (a.ok ? badge('Pass', 'ok') : badge('Fail', 'bad')) }], { search: false })),
    card('Manual clean-close checklist', h('ul', { class: 'checklist' }, manual.map(m => h('li', null, h('input', { type: 'checkbox' }), ' ', m)))),
    card('Tie-outs', table(J.ties, [
      { key: 'label', label: 'Check' }, { key: 'left', label: 'Left', align: 'right', render: t => fmtNum(t.left) }, { key: 'right', label: 'Right', align: 'right', render: t => fmtNum(t.right) },
      { key: 'difference', label: 'Difference', align: 'right', render: t => fmtNum(t.difference) }, { key: 'ok', label: 'OK', render: t => (t.ok ? badge('✓', 'ok') : badge('✗', 'bad')) },
    ], { search: false })),
    card('Bank tie-out (payment file vs register)', table(J.bank, [
      { key: 'payGroup', label: 'Pay group' }, { key: 'source', label: 'Payment source' },
      { key: 'registerNet', label: 'Register net', align: 'right', render: b => fmtNum(b.registerNet) },
      { key: 'directDeposit', label: 'Direct deposit / funding', align: 'right', render: b => fmtNum(b.directDeposit) },
      { key: 'checks', label: 'Checks', align: 'right', render: b => fmtNum(b.checks) },
      { key: 'difference', label: 'Difference', align: 'right', render: b => (Math.abs(b.difference) < 0.01 ? badge('0.00', 'ok') : badge(fmtNum(b.difference), 'bad')) },
    ], { search: false })),
    card('Payroll control matrix', table(CONTROLS, [
      { key: 'id', label: '#' }, { key: 'area', label: 'Area' }, { key: 'control', label: 'Control' }, { key: 'owner', label: 'Owner' },
      { key: 'freq', label: 'Frequency' }, { key: 'evidence', label: 'Workday evidence' }, { key: 'sod', label: 'Segregation of duties (security group)' },
    ], { search: false, csvName: 'control-matrix.csv' })),
  );
}

const CONTROLS = [
  { id: 'C1', area: 'Input', control: 'Hire, termination and comp changes approved by HR before cutoff', owner: 'HR Partner', freq: 'Each cycle', evidence: 'Business process history (approvals) report', sod: 'HR Partner initiates; HR Manager approves; Payroll has view-only' },
  { id: 'C2', area: 'Input', control: 'Time approved by managers by Monday 15:00; pending routes to Time Admin', owner: 'Managers / Time Admin', freq: 'Weekly', evidence: 'Time Blocks pending approval report', sod: 'Workers cannot approve own time; Time Admin cannot run payroll' },
  { id: 'C3', area: 'Input', control: 'One-time payments (bonuses) dual approval', owner: 'Comp Partner', freq: 'Each cycle', evidence: 'Request One-Time Payment BP history', sod: 'Requester ≠ approver; Payroll Partner cannot initiate' },
  { id: 'C4', area: 'Calculation', control: 'Pre-payroll audit run and exceptions cleared', owner: 'Payroll Partner', freq: 'Each cycle', evidence: 'Audit results with resolution notes', sod: 'Payroll Partner clears; Payroll Manager reviews' },
  { id: 'C5', area: 'Calculation', control: 'Register flux vs prior period with explanations', owner: 'Payroll Manager', freq: 'Each cycle', evidence: 'Payroll Results Comparison report', sod: 'Reviewer is not the preparer' },
  { id: 'C6', area: 'Approval', control: 'Payroll Partner completes the run; Payroll Manager approves', owner: 'Payroll Manager', freq: 'Each cycle', evidence: 'Complete Pay Calculation event approval', sod: 'Payroll Administrator vs Payroll Approver security groups' },
  { id: 'C7', area: 'Funding', control: 'Funding amount = register net, approved by Treasury', owner: 'Treasury', freq: 'Each cycle', evidence: 'Funding report + bank confirmation', sod: 'Treasury releases funds; Payroll cannot release' },
  { id: 'C8', area: 'Output', control: 'Bank file total = register net (incl. checks)', owner: 'Payroll Partner', freq: 'Each cycle', evidence: 'Settlement run report vs NACHA control totals', sod: 'File generated by integration; no manual edit rights' },
  { id: 'C9', area: 'Output', control: 'GL journal ties and balances before export', owner: 'Accounting', freq: 'Each cycle', evidence: 'Payroll accounting journal + NetSuite import log', sod: 'Accounting posts; Payroll cannot post to NetSuite' },
  { id: 'C10', area: 'Security', control: 'Quarterly review of payroll security group membership', owner: 'People Tech', freq: 'Quarterly', evidence: 'Security group membership audit report', sod: 'Reviewed by Controller, not by group members' },
];
