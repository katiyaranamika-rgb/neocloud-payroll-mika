// Dashboard, pay runs & headcount, payroll register, payslip.

import { h, kpi, card, collapsible, section, table, fmtMoney, fmtNum, fmtCompact, barChart, badge, tabs } from './dom.ts';
import type { Col } from './dom.ts';
import { state, passes, filteredRegister, hasEdits } from './state.ts';
import { go } from './router.ts';
import { statusGrid } from './views-status.ts';
import { logo, displayName, COMPANY } from './brand.ts';
import type { RegisterRow, PayLine } from '../engine/types.ts';
import { round2 } from '../engine/dates.ts';

const name = (code: string) => state.result.model.payCodes.get(code)?.name ?? code;
const cat = (code: string) => state.result.model.payCodes.get(code)?.category ?? '';
const tone = (b: string) => (b === 'Paid full period' ? 'ok' : b === 'Paid prorated' ? 'info' : b === 'Active, not paid' ? 'warn' : 'muted');

export function viewDashboard(): HTMLElement {
  const R = state.result;
  const reg = filteredRegister();
  const intl = R.intl.vendor.map(v => ({ v, w: R.model.workerById.get(v.workerId)! })).filter(x => x.w && passes(x.w));
  const fx = R.model.rules.intl.fxToUsd;
  const usGross = reg.reduce((s, r) => s + r.gross, 0);
  const usNet = reg.reduce((s, r) => s + r.net, 0);
  const usEr = reg.reduce((s, r) => s + r.erCost, 0);
  const intlGrossUsd = intl.reduce((s, x) => s + x.v.gross * (fx[x.v.currency] ?? 1), 0);
  const intlErUsd = intl.reduce((s, x) => s + (x.v.erSocial + x.v.erBenefits) * (fx[x.v.currency] ?? 1), 0);
  const burdened = usGross + usEr + intlGrossUsd + intlErUsd;
  const paid = reg.filter(r => r.gross > 0).length + intl.filter(x => x.v.gross > 0).length;
  const high = R.audit.findings.filter(f => f.severity === 'High').length;

  // Burdened cost by department and location (US register + provider registers, in USD)
  const byDept = new Map<string, number>(); const byLoc = new Map<string, number>();
  for (const r of reg) { byDept.set(r.costCenter, (byDept.get(r.costCenter) ?? 0) + r.burdened); byLoc.set(r.location, (byLoc.get(r.location) ?? 0) + r.burdened); }
  for (const x of intl) {
    const b = (x.v.gross + x.v.erBenefits + x.v.erSocial) * (fx[x.v.currency] ?? 1);
    byDept.set(x.w.costCenter, (byDept.get(x.w.costCenter) ?? 0) + b); byLoc.set(x.w.location, (byLoc.get(x.w.location) ?? 0) + b);
  }
  const toItems = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));

  const groups = ['US Semi-monthly', 'US Biweekly'].map(pg => {
    const rs = reg.filter(r => r.payGroup === pg);
    const ps = R.model.schedules.get(pg)!;
    return { pg, period: `${ps.start} → ${ps.end}`, payDate: ps.payDate, paid: rs.filter(r => r.gross > 0).length, gross: rs.reduce((s, r) => s + r.gross, 0), net: rs.reduce((s, r) => s + r.net, 0), er: rs.reduce((s, r) => s + r.erCost, 0), cur: 'USD', usd: rs.reduce((s, r) => s + r.burdened, 0) };
  });
  for (const c of R.intl.byCountry) {
    const ps = R.model.schedules.get(c.payGroup)!;
    const vs = intl.filter(x => x.w.payGroup === c.payGroup);
    const g = vs.reduce((s, x) => s + x.v.gross, 0); const e = vs.reduce((s, x) => s + x.v.erSocial + x.v.erBenefits, 0);
    groups.push({ pg: c.payGroup, period: `${ps.start} → ${ps.end}`, payDate: ps.payDate === ps.payDateOriginal ? ps.payDate : `${ps.payDate} (moved from ${ps.payDateOriginal})`, paid: vs.filter(x => x.v.gross > 0).length, gross: g, net: vs.reduce((s, x) => s + x.v.net, 0), er: e, cur: c.currency, usd: (g + e) * c.fx });
  }

  const legacyOk = R.legacy.workers.every(w => w.explained);
  const glOk = R.journal.exportable && R.journal.journals.every(j => j.balanced);

  const diffPanel = hasEdits() ? (() => {
    const B = state.base;
    const changed = R.register.map(r => { const b = B.register.find(x => x.workerId === r.workerId); return { id: r.workerId, pg: r.payGroup, baseNet: b?.net ?? 0, net: r.net, baseGross: b?.gross ?? 0, gross: r.gross }; })
      .filter(x => Math.abs(x.net - x.baseNet) > 0.004 || Math.abs(x.gross - x.baseGross) > 0.004);
    return card('What-if: changes vs the original run',
      h('p', { class: 'muted' }, `${changed.length} worker(s) changed because of your edits. Gross ${fmtMoney(R.register.reduce((s, r) => s + r.gross, 0) - B.register.reduce((s, r) => s + r.gross, 0))}, net ${fmtMoney(R.register.reduce((s, r) => s + r.net, 0) - B.register.reduce((s, r) => s + r.net, 0))} vs original.`),
      table(changed, [
        { key: 'id', label: 'Worker' }, { key: 'pg', label: 'Pay group' },
        { key: 'baseGross', label: 'Original gross', align: 'right', render: r => fmtMoney(r.baseGross) },
        { key: 'gross', label: 'New gross', align: 'right', render: r => fmtMoney(r.gross) },
        { key: 'baseNet', label: 'Original net', align: 'right', render: r => fmtMoney(r.baseNet) },
        { key: 'net', label: 'New net', align: 'right', render: r => fmtMoney(r.net) },
        { key: 'd', label: 'Δ net', align: 'right', value: r => round2(r.net - r.baseNet), render: r => fmtMoney(r.net - r.baseNet) },
      ], { onRow: r => go('payslip', r.id), csvName: 'what-if-diff.csv', pageSize: 20 }));
  })() : null;

  return h('div', null,
    h('div', { class: 'hero' },
      logo(52),
      h('div', { class: 'hero-text' },
        h('div', { class: 'hero-title' }, 'NeoCloud ', h('span', null, 'Payroll')),
        h('div', { class: 'hero-sub' }, `October 2026 period · 5 pay groups across US, UK, India and Canada${state.filters.payGroup || state.filters.dept || state.filters.location ? ' · filtered: ' + [state.filters.payGroup, state.filters.dept, state.filters.location].filter(Boolean).join(' · ') : ''}`)),
      h('div', { class: 'hero-meta' }, h('div', { class: 'small' }, COMPANY.name), h('div', { class: 'small' }, `${COMPANY.address1}, ${COMPANY.address2}`))),
    statusGrid(),
    h('div', { class: 'kpis' },
      kpi('Total burdened cost (USD)', fmtCompact(burdened), 'Gross + employer taxes + benefits load + 401(k) match'),
      kpi('US gross pay', fmtCompact(usGross), `${reg.filter(r => r.gross > 0).length} US workers paid`),
      kpi('US net pay', fmtCompact(usNet), 'Bank file + checks'),
      kpi('International employer cost (USD)', fmtCompact(intlGrossUsd + intlErUsd), `${intl.length} workers via provider`),
      kpi('Workers paid', fmtNum(paid, 0), `of ${R.model.workers.filter(w => w.workerType === 'Employee').length} employees · 30 contractors excluded`),
      kpi('Audit findings', fmtNum(R.audit.findings.length, 0), `${high} high severity`, high ? 'warn' : ''),
    ),
    diffPanel,
    h('div', { class: 'grid2' },
      card('Burdened cost by department (USD)', barChart(toItems(byDept), n => fmtCompact(n))),
      card('Burdened cost by location (USD)', barChart(toItems(byLoc), n => fmtCompact(n))),
    ),
    card('Pay groups',
      table(groups, [
        { key: 'pg', label: 'Pay group' }, { key: 'period', label: 'Period' }, { key: 'payDate', label: 'Pay date' },
        { key: 'paid', label: 'Paid', align: 'right' },
        { key: 'gross', label: 'Gross (local)', align: 'right', render: r => fmtMoney(r.gross, r.cur) },
        { key: 'net', label: 'Net (local)', align: 'right', render: r => fmtMoney(r.net, r.cur) },
        { key: 'er', label: 'Employer cost (local)', align: 'right', render: r => fmtMoney(r.er, r.cur) },
        { key: 'usd', label: 'Burdened (USD)', align: 'right', render: r => fmtMoney(r.usd) },
      ], { search: false, onRow: r => go('payruns', r.pg) })),
    h('div', { class: 'grid3' },
      card('Payroll parallel test', h('p', null, R.legacy.available ? `${R.legacy.workers.length} employees with variances vs Rippling, ${R.legacy.matched} matched exactly.` : 'Legacy register not loaded.'), legacyOk ? badge('All variances explained', 'ok') : badge('Unexplained variances', 'bad'), h('p', null, h('a', { href: '#/recon' }, 'Open payroll parallel test →'))),
      card('GL journal', h('p', null, `${R.journal.journals.length} journals, ${R.journal.lines.length} lines.`), glOk ? badge('Balanced · export ready', 'ok') : badge('Export blocked', 'bad'), h('p', null, h('a', { href: '#/export' }, 'Export payroll journal →'))),
      card('Provider results', h('p', null, `${R.intl.variances.length} field variances across ${new Set(R.intl.variances.map(v => v.workerId)).size} workers.`), R.intl.variances.every(v => v.explained) ? badge('All explained', 'ok') : badge('Unexplained', 'bad'), h('p', null, h('a', { href: '#/intl' }, 'Open international →'))),
    ),
  );
}

export function viewPayRuns(arg?: string): HTMLElement {
  const R = state.result;
  const runs = R.headcount;
  const pgNote = state.filters.payGroup ? `Showing ${state.filters.payGroup} only (pay group filter at the top).` : 'Use the pay group filter at the top to focus on one run.';
  const contractors = R.model.workers.filter(w => w.workerType === 'Contractor');
  return h('div', null,
    section('Pay runs and headcount', 'Each pay group is its own run. Headcount splits into buckets that add back to the worker file; special instructions (events and pay inputs) are tagged on top, so one worker can be paid in full and also have a bonus or a garnishment.'),
    h('p', { class: 'muted small' }, pgNote),
    tabs(runs.filter(run => !state.filters.payGroup || run.payGroup === state.filters.payGroup).map(run => ({
      id: run.payGroup, label: run.payGroup, render: () => {
        const total = run.buckets.reduce((s, b) => s + b.count, 0);
        return h('div', null,
          h('div', { class: 'kpis' },
            kpi('Worker file', String(run.workerFile), `${run.period} · pay ${run.payDate}`),
            ...run.buckets.map(b => kpi(b.bucket, String(b.count), b.bucket === 'Active, not paid' ? 'Unpaid leave or no time' : b.bucket === 'Paid prorated' ? 'Hire, term or partial leave' : '')),
            kpi('Tie-out', total === run.workerFile ? '✓' : '✗', `${run.buckets.map(b => b.count).join(' + ')} = ${total}`, total === run.workerFile ? '' : 'warn'),
          ),
          h('div', { class: 'grid2' },
            collapsible('Headcount buckets', true, ...run.buckets.filter(b => b.bucket !== 'Paid full period').map(b => h('div', null, h('h4', null, b.bucket, ' ', badge(String(b.count), tone(b.bucket))),
              table(b.workers, [{ key: 'id', label: 'Worker' }, { key: 'reason', label: 'Reason' }], { search: false, pageSize: 15, onRow: r => go(run.payGroup.startsWith('US') ? 'payslip' : 'intl', r.id) })))),
            collapsible('Special instructions this run', true,
              table(run.special, [
                { key: 'tag', label: 'Instruction' }, { key: 'count', label: 'Workers', align: 'right' },
                { key: 'workers', label: 'Who', value: r => r.workers.join(', '), render: r => h('span', { class: 'small' }, r.workers.slice(0, 12).join(', ') + (r.workers.length > 12 ? ` +${r.workers.length - 12}` : '')) },
              ], { search: false, pageSize: 30 })),
          ),
        );
      },
    })), state.filters.payGroup || arg),
    card(null, h('p', null, 'See every earning, deduction, tax, employer cost, time card, pay input and accounting entry for the US runs on ', h('a', { href: '#/results' }, 'Payroll results →'))),
    card('Excluded from all payroll runs', h('p', null, `${contractors.length} contractors are paid through Accounts Payable, not payroll. ${contractors.filter(c => !c.status).length} have no status or hire date and are flagged for the AP vendor master.`)),
  );
}

export function viewRegister(): HTMLElement {
  const reg = filteredRegister();
  const base = new Map(state.base.register.map(r => [r.workerId, r]));
  const sumCodes = (r: RegisterRow, codes: string[]) => r.lines.filter(l => codes.includes(l.code)).reduce((s, l) => s + l.amount, 0);
  const cols: Col<RegisterRow>[] = [
    { key: 'workerId', label: 'Worker' }, { key: 'name', label: 'Name', value: r => displayName(r.workerId) }, { key: 'payGroup', label: 'Pay group' }, { key: 'costCenter', label: 'Cost center' },
    { key: 'location', label: 'Location' }, { key: 'state', label: 'State' },
    { key: 'bucket', label: 'Bucket', render: r => badge(r.bucket, tone(r.bucket)) },
    { key: 'regular', label: 'Regular', align: 'right', value: r => round2(sumCodes(r, ['REG_SAL', 'REG_HRS', 'UNPD_LV'])), render: r => fmtMoney(sumCodes(r, ['REG_SAL', 'REG_HRS', 'UNPD_LV'])) },
    { key: 'premium', label: 'OT/DT/diff/meal', align: 'right', value: r => round2(sumCodes(r, ['OT_15', 'DT_20', 'SVD_15', 'SVD_20', 'DIFF_NGT', 'DIFF_NGHT', 'DIFF_WKND', 'MEAL_PEN'])), render: r => fmtMoney(sumCodes(r, ['OT_15', 'DT_20', 'SVD_15', 'SVD_20', 'DIFF_NGT', 'DIFF_NGHT', 'DIFF_WKND', 'MEAL_PEN'])) },
    { key: 'other', label: 'Leave/bonus/retro/payout', align: 'right', value: r => round2(sumCodes(r, ['VAC_HRS', 'SICK_HRS', 'LEAVE_PAID', 'BON_SIGN', 'BON_SPOT', 'RETRO_SAL', 'RETRO_HRS', 'VAC_PAYOUT'])), render: r => fmtMoney(sumCodes(r, ['VAC_HRS', 'SICK_HRS', 'LEAVE_PAID', 'BON_SIGN', 'BON_SPOT', 'RETRO_SAL', 'RETRO_HRS', 'VAC_PAYOUT'])) },
    { key: 'gross', label: 'Gross', align: 'right', render: r => fmtMoney(r.gross) },
    { key: 'pretax', label: 'Pre-tax', align: 'right', render: r => fmtMoney(r.pretax) },
    { key: 'eeTaxes', label: 'EE taxes', align: 'right', render: r => fmtMoney(r.eeTaxes) },
    { key: 'postTax', label: 'Garnish.', align: 'right', render: r => fmtMoney(r.postTax) },
    { key: 'net', label: 'Net', align: 'right', render: r => h('strong', null, fmtMoney(r.net)) },
    { key: 'erCost', label: 'ER cost', align: 'right', render: r => fmtMoney(r.erCost) },
    { key: 'burdened', label: 'Burdened', align: 'right', render: r => fmtMoney(r.burdened) },
  ];
  if (hasEdits()) cols.push({ key: 'dnet', label: 'Δ net vs original', align: 'right', value: r => round2(r.net - (base.get(r.workerId)?.net ?? 0)), render: r => { const d = r.net - (base.get(r.workerId)?.net ?? 0); return Math.abs(d) > 0.004 ? h('span', { class: 'delta' }, fmtMoney(d)) : ''; } });
  const tot = (f: (r: RegisterRow) => number) => fmtMoney(reg.reduce((s, r) => s + f(r), 0));
  return h('div', null,
    section('Payroll register (US)', 'Gross-to-net for every eligible US worker in both US pay groups. Click a row for the payslip with every pay component.'),
    state.filters.payGroup && !state.filters.payGroup.startsWith('US') ? card(null, h('p', null, `${state.filters.payGroup} is paid by the in-country provider, so it has no US register. See `, h('a', { href: '#/intl' }, 'International'), ' or clear the pay group filter.')) : null,
    h('div', { class: 'kpis' },
      kpi('Employees', String(reg.length)), kpi('Gross', tot(r => r.gross)), kpi('Pre-tax deductions', tot(r => r.pretax)),
      kpi('Employee taxes', tot(r => r.eeTaxes)), kpi('Net pay', tot(r => r.net)), kpi('Employer cost', tot(r => r.erCost)),
    ),
    card(null, table(reg, cols, { onRow: r => go('payslip', r.workerId), csvName: 'us-payroll-register.csv', pageSize: 100 })),
    card('Register by pay component', componentSummary(reg)),
  );
}

function componentSummary(reg: RegisterRow[]): HTMLElement {
  const m = new Map<string, { code: string; amount: number; hours: number; workers: number }>();
  for (const r of reg) for (const l of r.lines) {
    if (l.code === 'NET_PAY') continue;
    const x = m.get(l.code) ?? { code: l.code, amount: 0, hours: 0, workers: 0 };
    x.amount += l.amount; x.hours += l.hours ?? 0; x.workers++;
    m.set(l.code, x);
  }
  const order = ['Earning', 'Deduction', 'EE Tax', 'ER Cost'];
  const rows = [...m.values()].sort((a, b) => order.indexOf(cat(a.code)) - order.indexOf(cat(b.code)));
  return table(rows, [
    { key: 'code', label: 'Code' }, { key: 'name', label: 'Pay component', value: r => name(r.code) },
    { key: 'cat', label: 'Type', value: r => cat(r.code) },
    { key: 'workers', label: 'Workers', align: 'right' },
    { key: 'hours', label: 'Hours', align: 'right', render: r => (r.hours ? fmtNum(r.hours) : '') },
    { key: 'amount', label: 'Amount', align: 'right', render: r => fmtMoney(r.amount) },
    { key: 'gl', label: 'Posting (US rules)', value: r => { const rs = (state.result.model.raw.gl_posting_rules ?? []).filter(x => x.mapping_id === 'US-PAYROLL' && x.pay_code === r.code); return rs.length ? rs.map(x => `${x.debit_credit} ${x.account}`).join(' / ') : (r.code === 'PTO_FLEX' ? 'memo' : 'UNMAPPED'); } },
  ], { search: false, pageSize: 60, csvName: 'register-by-component.csv' });
}

export function viewPayslip(arg?: string): HTMLElement {
  const R = state.result;
  const all = R.register.filter(r => r.bucket !== 'Excluded').sort((a, b) => a.workerId.localeCompare(b.workerId));
  const id = arg && all.some(r => r.workerId === arg) ? arg : all[0].workerId;
  const r = all.find(x => x.workerId === id)!;
  const w = R.model.workerById.get(id)!;
  const ps = R.model.schedules.get(r.payGroup)!;
  const lines = (c: string) => r.lines.filter(l => cat(l.code) === c && l.code !== 'NET_PAY' && l.code !== 'BEN_ARR_NEW' && (Math.abs(l.amount) > 0.004 || l.code === 'PTO_FLEX'));
  const earnings = lines('Earning');
  const deductions = lines('Deduction');
  const taxes = lines('EE Tax');
  const employer = lines('ER Cost');
  // YTD: first Workday payroll, so YTD = this period.
  const money = (n: number) => fmtMoney(n);
  const sum = (ls: PayLine[]) => ls.reduce((s, l) => s + l.amount, 0);
  const pretax = deductions.filter(l => ['401K_EE', 'MED_EE', 'DEN_EE', 'VIS_EE'].includes(l.code));
  const posttax = deductions.filter(l => !pretax.includes(l));
  const paidByCheck = !!w.termDate && w.termDate <= ps.end;
  const stmt = (title: string, ls: PayLine[], hours: boolean) => h('div', { class: 'ps-block' },
    h('table', { class: 'ps-table' },
      h('thead', null, h('tr', null, h('th', null, title), hours ? h('th', { class: 'right' }, 'Hours') : null, hours ? h('th', { class: 'right' }, 'Rate') : null, h('th', { class: 'right' }, 'Current'), h('th', { class: 'right' }, 'YTD'))),
      h('tbody', null, ls.length ? ls.map(l => h('tr', null,
        h('td', null, name(l.code), l.code === 'PTO_FLEX' ? h('span', { class: 'muted small' }, ' (memo)') : null),
        hours ? h('td', { class: 'right' }, l.hours !== undefined ? fmtNum(l.hours) : '') : null,
        hours ? h('td', { class: 'right' }, l.rate !== undefined && l.code !== '401K_EE' ? fmtNum(l.rate, 4) : '') : null,
        h('td', { class: 'right' }, money(l.amount)), h('td', { class: 'right' }, money(l.amount)))) : h('tr', null, h('td', { colspan: hours ? 5 : 3, class: 'muted' }, 'None this period'))),
      ls.length ? h('tfoot', null, h('tr', null, h('td', null, 'Total'), hours ? h('td', null) : null, hours ? h('td', null) : null, h('td', { class: 'right' }, money(sum(ls))), h('td', { class: 'right' }, money(sum(ls))))) : null));
  const balances = R.absence.filter(a => a.workerId === id);
  const doc = h('article', { class: 'payslip' },
    h('header', { class: 'ps-head' },
      h('div', { class: 'ps-company' }, logo(44), h('div', null, h('div', { class: 'ps-co-name' }, COMPANY.name), h('div', { class: 'small muted' }, COMPANY.address1), h('div', { class: 'small muted' }, COMPANY.address2))),
      h('div', { class: 'ps-title' }, h('div', { class: 'ps-doc' }, 'Earnings statement'), h('div', { class: 'small' }, `Pay date ${ps.payDate}`), h('div', { class: 'small muted' }, `Period ${ps.start} to ${ps.end}`), h('div', { class: 'small muted' }, `Advice no. ${ps.payDate.replace(/-/g, '')}-${id}`))),
    h('section', { class: 'ps-emp' },
      ...([['Employee', displayName(id)], ['Worker ID', id], ['Department', w.dept], ['Cost center', `${w.costCenter} (${w.supOrg})`],
        ['Location / work state', `${r.location} / ${Object.keys(r.states).join(' → ')}`], ['Pay group', r.payGroup],
        ['Pay rate', w.payRateType === 'Salary' ? `${money(w.annualSalary ?? 0)} per year` : `${money(w.hourlyRate ?? 0)} per hour`],
        ['Status', `${w.flsa} · ${w.status}`]] as [string, string][]).map(([k, v]) => h('div', null, h('div', { class: 'ps-k' }, k), h('div', { class: 'ps-v' }, v)))),
    h('section', { class: 'ps-summary' },
      h('div', null, h('div', { class: 'ps-k' }, 'Gross pay'), h('div', { class: 'ps-n' }, money(r.gross))),
      h('div', null, h('div', { class: 'ps-k' }, 'Pre-tax deductions'), h('div', { class: 'ps-n' }, money(sum(pretax)))),
      h('div', null, h('div', { class: 'ps-k' }, 'Employee taxes'), h('div', { class: 'ps-n' }, money(sum(taxes)))),
      h('div', null, h('div', { class: 'ps-k' }, 'Post-tax deductions'), h('div', { class: 'ps-n' }, money(sum(posttax)))),
      h('div', { class: 'ps-net' }, h('div', { class: 'ps-k' }, 'Net pay'), h('div', { class: 'ps-n' }, money(r.net)))),
    stmt('Earnings', earnings, true),
    h('div', { class: 'ps-two' }, stmt('Deductions', deductions, false), stmt('Employee taxes', taxes, false)),
    h('div', { class: 'ps-two' },
      stmt('Employer contributions (not deducted)', employer, false),
      h('div', { class: 'ps-block' }, h('table', { class: 'ps-table' },
        h('thead', null, h('tr', null, h('th', null, 'Time off'), h('th', { class: 'right' }, 'Start'), h('th', { class: 'right' }, 'Accrued'), h('th', { class: 'right' }, 'Used'), h('th', { class: 'right' }, 'Balance'))),
        h('tbody', null, balances.length ? balances.map(a => h('tr', null,
          h('td', null, a.plan, h('span', { class: 'muted small' }, ` (${a.unit})`)),
          h('td', { class: 'right' }, a.opening === null ? '—' : fmtNum(a.opening)),
          h('td', { class: 'right' }, fmtNum(a.accrued)),
          h('td', { class: 'right' }, fmtNum(a.used + a.payoutQty)),
          h('td', { class: 'right' }, a.ending === null ? 'Unlimited' : h('strong', null, fmtNum(a.ending))))) : h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'No plans')))))),
    h('section', { class: 'ps-dist' },
      h('div', null, h('div', { class: 'ps-k' }, 'Net pay distribution'), h('div', null, paidByCheck ? `Final pay by live check: ${money(r.net)}` : `Direct deposit: ${money(r.net)}`)),
      r.arrearsCreated > 0 ? h('div', null, h('div', { class: 'ps-k' }, 'Benefit arrears'), h('div', null, `${money(r.arrearsCreated)} to be collected on return`)) : null),
    h('footer', { class: 'ps-foot small muted' }, `${COMPANY.name} · ${COMPANY.address1}, ${COMPANY.address2} · This statement covers the pay period shown. YTD reflects payroll processed in Workday. Questions: contact People Operations.`),
  );
  return h('div', null,
    h('div', { class: 'row no-print' },
      h('label', { class: 'filter' }, h('span', null, 'Worker'), h('select', { onChange: (e: Event) => go('payslip', (e.target as HTMLSelectElement).value) },
        all.map(x => h('option', { value: x.workerId, selected: x.workerId === id }, `${displayName(x.workerId)} · ${x.workerId} · ${x.payGroup.replace('US ', '')}`)))),
      h('button', { class: 'btn ghost sm', onClick: () => window.print() }, 'Print payslip'),
      r.payGroup === 'US Biweekly' ? h('a', { href: `#/time/${id}`, class: 'small' }, 'Time calculation trace →') : null,
      h('a', { href: `#/results/${id}`, class: 'small' }, 'Payroll results →')),
    doc,
    r.tags.length || r.issues.length ? card('Special instructions and exceptions (not printed)', h('ul', null, r.tags.map(t => h('li', null, t)), r.issues.map(i => h('li', null, badge(i.severity, i.severity === 'error' ? 'bad' : i.severity === 'warning' ? 'warn' : 'info'), ' ', i.message)))) : null,
  );
}
