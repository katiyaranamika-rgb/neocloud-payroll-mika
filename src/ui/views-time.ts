// Time results (non-exempt) and absence balances / payouts / leave liability.

import { h, kpi, card, section, table, fmtMoney, fmtNum, badge, tabs, withTip } from './dom.ts';
import { state, passes } from './state.ts';
import { go, refresh } from './router.ts';
import type { TimeResult, AbsenceRow } from '../engine/types.ts';
import { displayName } from './brand.ts';

/** One entry per exception: issues, plus dropped entries not already explained by an issue on the same date. */
function exceptions(t: TimeResult): { code: string; msg: string }[] {
  const out = t.issues.map(i => ({ code: i.code, msg: i.message }));
  for (const d of t.dropped) if (!t.issues.some(i => i.message.includes(d.date))) out.push({ code: 'DROPPED', msg: `${d.date}: ${d.reason}` });
  return out;
}

export function viewTime(arg?: string): HTMLElement {
  const R = state.result;
  const list = [...R.time.values()].filter(t => passes(R.model.workerById.get(t.workerId)!));
  const sum = (t: TimeResult, k: 'reg' | 'ot' | 'dt' | 'svd15' | 'svd20' | 'nightHours') => t.days.reduce((s, d) => s + d[k], 0);
  const amt = (t: TimeResult) => t.lines.reduce((s, l) => s + l.amount, 0);
  const tot = (k: 'reg' | 'ot' | 'dt' | 'svd15' | 'svd20' | 'nightHours') => list.reduce((s, t) => s + sum(t, k), 0);
  const detail = arg ? R.time.get(arg) : undefined;

  return h('div', null,
    section('Time results (non-exempt, US Biweekly Oct 4–17)', 'Hours by category for every timesheet, with the California rule trace. Order: clean punches → daily hours → CA daily OT/DT → 7th day → weekly OT → differentials → meal penalties → regular rate → premiums.'),
    h('div', { class: 'kpis' },
      kpi('Workers', String(list.length), `${list.filter(t => t.group === 'US California Non-Exempt').length} CA · ${list.filter(t => t.group !== 'US California Non-Exempt').length} non-CA`),
      kpi('Regular hrs', fmtNum(tot('reg'))), kpi('OT 1.5x hrs', fmtNum(tot('ot'))), kpi('DT 2x hrs', fmtNum(tot('dt'))),
      kpi('7th-day hrs', fmtNum(tot('svd15') + tot('svd20'))), kpi('Night hrs', fmtNum(tot('nightHours'))),
      kpi('Meal penalties', String(list.reduce((s, t) => s + t.days.filter(d => d.mealPenalty).length, 0))),
    ),
    detail ? traceCard(detail) : null,
    card('Hours by category → pay components', table(list, [
      { key: 'workerId', label: 'Worker' }, { key: 'name', label: 'Name', value: t => displayName(t.workerId) }, { key: 'group', label: 'Time calc group', value: t => t.group.replace(' Non-Exempt', '') },
      { key: 'days', label: 'Days', align: 'right', value: t => t.days.length },
      { key: 'reg', label: 'REG_HRS', align: 'right', value: t => sum(t, 'reg'), render: t => fmtNum(sum(t, 'reg')) },
      { key: 'ot', label: 'OT_15', align: 'right', value: t => sum(t, 'ot'), render: t => fmtNum(sum(t, 'ot')) },
      { key: 'dt', label: 'DT_20', align: 'right', value: t => sum(t, 'dt'), render: t => fmtNum(sum(t, 'dt')) },
      { key: 's7', label: 'SVD_15/20', align: 'right', value: t => sum(t, 'svd15') + sum(t, 'svd20'), render: t => fmtNum(sum(t, 'svd15') + sum(t, 'svd20')) },
      { key: 'night', label: 'Night hrs', align: 'right', value: t => sum(t, 'nightHours'), render: t => fmtNum(sum(t, 'nightHours')) },
      { key: 'meal', label: 'MEAL_PEN', align: 'right', value: t => t.days.filter(d => d.mealPenalty).length },
      { key: 'rr', label: 'Reg. rate wk1 / wk2', value: t => t.weeks.map(w => fmtNum(w.regularRate, 2)).join(' / ') },
      { key: 'amt', label: 'Time pay', align: 'right', value: amt, render: t => fmtMoney(amt(t)) },
      { key: 'flags', label: 'Exceptions', value: t => exceptions(t).length, render: t => { const items = exceptions(t).map(x => `${x.code}: ${x.msg}`); return items.length ? withTip(badge(String(items.length), 'warn'), `${t.workerId} · ${items.length} exception${items.length > 1 ? 's' : ''}`, items) : ''; } },
    ], { onRow: t => go('time', t.workerId), csvName: 'time-results.csv', pageSize: 60 })),
    card('Time exceptions and how they are handled', table(list.flatMap(t => exceptions(t).map(x => ({ worker: t.workerId, ...x }))), [
      { key: 'worker', label: 'Worker' }, { key: 'code', label: 'Exception' }, { key: 'msg', label: 'Handling' },
    ], { pageSize: 30, onRow: r => go('time', r.worker) })),
    card('Template validations that would prevent these (Workday time entry template)', h('ul', null,
      h('li', null, 'Block duplicate or overlapping punches (E0078, E0251 were removed here).'),
      h('li', null, 'Block entries before hire or after termination (E0028 Oct 14 excluded).'),
      h('li', null, 'Warn when punch-in is more than 30 minutes from the rostered shift start; route to manager.'),
      h('li', null, 'Require a meal punch on shifts over 5 hours, or a missed/waived attestation (E0021, E0074, E0307, E0333).'),
      h('li', null, 'Edits to a closed period go to approval and pay as retro (E0071, E0112).'),
      h('li', null, 'Shifts crossing midnight are credited to the start date (all NGHT shifts).'),
    )),
  );
}

function traceCard(t: TimeResult): HTMLElement {
  const R = state.result;
  const w = R.model.workerById.get(t.workerId)!;
  return card(`Rule trace · ${displayName(t.workerId)} · ${t.workerId} (${t.group})`,
    h('p', { class: 'muted' }, `${w.location}, ${w.state} · default shift ${w.defaultShift} · ${w.weeklyHours} hrs/wk · `, h('a', { href: `#/payslip/${t.workerId}` }, 'open payslip')),
    table(t.days, [
      { key: 'date', label: 'Date' }, { key: 'day', label: 'Day' }, { key: 'shift', label: 'Shift' },
      { key: 'punch', label: 'In–Out', value: d => `${d.timeIn}–${d.timeOut}` },
      { key: 'hours', label: 'Hours', align: 'right', render: d => fmtNum(d.hours) },
      { key: 'reg', label: 'Reg', align: 'right', render: d => fmtNum(d.reg) },
      { key: 'ot', label: 'OT', align: 'right', render: d => (d.ot ? fmtNum(d.ot) : '') },
      { key: 'dt', label: 'DT', align: 'right', render: d => (d.dt ? fmtNum(d.dt) : '') },
      { key: 's7', label: '7th day', align: 'right', render: d => (d.svd15 + d.svd20 ? `${fmtNum(d.svd15)} / ${fmtNum(d.svd20)}` : '') },
      { key: 'night', label: 'Night', align: 'right', render: d => (d.nightHours ? fmtNum(d.nightHours) : '') },
      { key: 'rate', label: 'Base', align: 'right', render: d => fmtMoney(d.baseRate) },
      { key: 'meal', label: 'Meal pen.', render: d => (d.mealPenalty ? badge('1 hr', 'warn') : '') },
      { key: 'flags', label: 'Rule notes', render: d => h('span', { class: 'small' }, d.flags.join('; ')) },
    ], { search: false, pageSize: 20 }),
    h('div', { class: 'grid2' },
      table(t.weeks, [
        { key: 'weekStart', label: 'Workweek (Sun)' }, { key: 'hours', label: 'Hours', align: 'right', render: x => fmtNum(x.hours) },
        { key: 'straightPay', label: 'Straight pay', align: 'right', render: x => fmtMoney(x.straightPay) },
        { key: 'diffPay', label: 'Differentials', align: 'right', render: x => fmtMoney(x.diffPay) },
        { key: 'regularRate', label: 'Regular rate', align: 'right', render: x => fmtMoney(x.regularRate, 'USD', 4) },
      ], { search: false }),
      table(t.lines, [
        { key: 'code', label: 'Pay component' }, { key: 'hours', label: 'Hours', align: 'right', render: l => fmtNum(l.hours ?? 0) },
        { key: 'amount', label: 'Amount', align: 'right', render: l => fmtMoney(l.amount) },
        { key: 'detail', label: 'Detail', render: l => h('span', { class: 'small' }, l.detail ?? '') },
      ], { search: false }),
    ),
    t.dropped.length ? h('p', null, badge('Excluded', 'warn'), ' ', t.dropped.map(d => `${d.date}: ${d.reason}`).join(' · ')) : null,
  );
}

// Flag categories for absence rows: colour = the most serious one; hover lists every reason.
const FLAG_KINDS: { kind: string; label: string; tone: 'bad' | 'warn' | 'info' | 'muted'; test: RegExp }[] = [
  { kind: 'data', label: 'Data issue', tone: 'bad', test: /missing in balance file|blank in source|Statute label|No accrual rule/ },
  { kind: 'cap', label: 'Cap or balance limit', tone: 'warn', test: /cap|exceeds available/i },
  { kind: 'term', label: 'Termination', tone: 'muted', test: /Terminated/ },
  { kind: 'prorated', label: 'Prorated', tone: 'info', test: /Prorated|paused|only on days worked/ },
  { kind: 'other', label: 'Other', tone: 'muted', test: /./ },
];
const flagKinds = (a: AbsenceRow) => FLAG_KINDS.filter(k => a.flags.some(f => FLAG_KINDS.find(x => x.test.test(f)) === k));
let absPlan = '';
let absFilter = '';

function viewBalances(rows: AbsenceRow[]): HTMLElement {
  const R = state.result;
  const plans = [...new Set(rows.map(a => a.plan))].sort();
  if (!plans.includes(absPlan)) absPlan = plans.includes('US Hourly Vacation') ? 'US Hourly Vacation' : plans[0] ?? '';
  const rule = R.model.rules.absence[absPlan];
  const inPlan = rows.filter(a => a.plan === absPlan);
  const shown = inPlan.filter(a => !absFilter || flagKinds(a).some(k => k.kind === absFilter));
  const unit = rule?.unit ?? inPlan[0]?.unit ?? '';
  const sum = (f: (a: AbsenceRow) => number) => inPlan.reduce((s, a) => s + f(a), 0);
  const ruleLine = !rule ? 'No rule configured' : [
    rule.unlimited ? 'Unlimited; no accrual' : rule.method === 'per_hour_worked' ? `Accrues ${rule.rate} ${unit} per hour worked${rule.exemptWeeklyHours ? ` (exempt: ${rule.exemptWeeklyHours} hrs/week assumed)` : ''}` : rule.method === 'monthly' ? `Accrues ${rule.perMonth} ${unit} a month, prorated by working days` : rule.method === 'frontloaded' ? 'Front-loaded annually' : 'No accrual',
    rule.cap !== undefined ? `cap ${rule.cap} ${unit}` : '',
    rule.payout ? 'paid out at termination' : 'no payout at termination (forfeited)',
  ].filter(Boolean).join(' · ');
  const cur = inPlan[0]?.currency ?? 'USD';
  const flagCell = (a: AbsenceRow) => {
    const ks = flagKinds(a);
    if (!ks.length) return '';
    const top = ks[0];
    return withTip(badge(ks.length > 1 ? `${top.label} +${ks.length - 1}` : top.label, top.tone), `${a.workerId} · ${a.plan}`, a.flags);
  };
  const status = (a: AbsenceRow) => (a.flags.some(f => /balance paid out/.test(f)) ? 'Terminated – paid out' : a.flags.some(f => /forfeited/.test(f)) ? 'Terminated – forfeited' : 'Active');
  const w = (id: string) => R.model.workerById.get(id)!;
  const kinds = FLAG_KINDS.filter(k => k.kind !== 'other' && inPlan.some(a => flagKinds(a).includes(k)));
  return h('div', null,
    h('div', { class: 'row' },
      h('label', { class: 'filter' }, h('span', null, 'Time off plan'),
        h('select', { onChange: (e: Event) => { absPlan = (e.target as HTMLSelectElement).value; absFilter = ''; refresh(); } }, plans.map(p => h('option', { value: p, selected: p === absPlan }, `${p} (${rows.filter(a => a.plan === p).length})`)))),
      h('span', { class: 'muted small' }, ruleLine)),
    h('div', { class: 'kpis' },
      kpi('Workers', String(inPlan.length), absPlan),
      rule?.unlimited ? kpi('Hours used', fmtNum(sum(a => a.used))) : kpi('Opening', `${fmtNum(sum(a => a.opening ?? 0))} ${unit}`),
      rule?.unlimited ? null : kpi('Accrued', `${fmtNum(sum(a => a.accrued))} ${unit}`),
      rule?.unlimited ? null : kpi('Used', `${fmtNum(sum(a => a.used))} ${unit}`),
      rule?.payout ? kpi('Paid out', `${fmtNum(sum(a => a.payoutQty))} ${unit}`, fmtMoney(sum(a => a.payoutAmount), cur)) : null,
      rule?.unlimited ? null : kpi('Ending', `${fmtNum(sum(a => a.ending ?? 0))} ${unit}`, rule?.payout ? `liability ${fmtMoney(sum(a => a.liabilityEnding), cur)}` : ''),
    ),
    h('div', { class: 'row small' },
      h('span', { class: 'muted' }, 'Show: '),
      h('button', { class: `btn ${absFilter ? 'ghost' : ''} xs`, onClick: () => { absFilter = ''; refresh(); } }, `All (${inPlan.length})`),
      ...kinds.map(k => h('button', { class: `btn ${absFilter === k.kind ? '' : 'ghost'} xs`, onClick: () => { absFilter = absFilter === k.kind ? '' : k.kind; refresh(); } }, `${k.label} (${inPlan.filter(a => flagKinds(a).includes(k)).length})`)),
      h('span', { class: 'muted' }, ' · Flag colours: '), ...FLAG_KINDS.filter(k => k.kind !== 'other').map(k => h('span', null, badge(k.label, k.tone), ' ')),
      h('span', { class: 'muted' }, 'Hover a flag for the reason.')),
    table(shown, [
      { key: 'workerId', label: 'Worker' }, { key: 'name', label: 'Name', value: a => displayName(a.workerId) },
      { key: 'location', label: 'Location', value: a => w(a.workerId).location },
      ...(rule?.unlimited ? [] : [{ key: 'opening', label: `Opening (${unit})`, align: 'right' as const, render: (a: AbsenceRow) => fmtNum(a.opening ?? 0) }]),
      ...(rule?.unlimited ? [] : [{ key: 'accrued', label: '+ Accrued', align: 'right' as const, render: (a: AbsenceRow) => fmtNum(a.accrued) }]),
      { key: 'accrualBasis', label: 'Accrual basis', render: a => h('span', { class: 'small' }, a.accrualBasis) },
      { key: 'used', label: '− Used', align: 'right', render: a => fmtNum(a.used) },
      ...(rule?.payout ? [{ key: 'payoutQty', label: '− Paid out', align: 'right' as const, render: (a: AbsenceRow) => (a.payoutQty ? fmtNum(a.payoutQty) : '') }] : []),
      ...(rule?.unlimited ? [] : [{ key: 'ending', label: '= Ending', align: 'right' as const, render: (a: AbsenceRow) => h('strong', null, fmtNum(a.ending ?? 0)) }]),
      { key: 'status', label: 'Status', value: status },
      { key: 'flag', label: 'Flag', value: a => flagKinds(a).map(k => k.label).join(', '), render: flagCell },
    ], { csvName: `time-off-balances-${absPlan.replace(/\W+/g, '-').toLowerCase()}.csv`, pageSize: 50, onRow: a => go(w(a.workerId).country === 'US' ? 'payslip' : 'intl', a.workerId) }));
}

export function viewAbsence(): HTMLElement {
  const R = state.result;
  // Unlimited plans (US Flexible PTO for exempt staff) carry no balance or accrual, so they are not tracked here.
  const rows = R.absence.filter(a => passes(R.model.workerById.get(a.workerId)!) && !R.model.rules.absence[a.plan]?.unlimited);
  const plans = [...new Set(rows.map(a => a.plan))].sort();
  const payouts = rows.filter(a => a.payoutAmount > 0);
  const fx = R.model.rules.intl.fxToUsd;
  const liab = new Map<string, { cur: string; open: number; end: number }>();
  for (const a of rows) {
    if (!R.model.rules.absence[a.plan]?.payout) continue;
    const x = liab.get(a.plan) ?? { cur: a.currency, open: 0, end: 0 };
    x.open += a.liabilityOpening; x.end += a.liabilityEnding; liab.set(a.plan, x);
  }
  return h('div', null,
    section('Absence balances, payouts and leave liability', 'Every accrual plan rolled forward from its as-of date to the end of the worker\'s pay period: opening + accrued − used − paid out = ending. Workday is the source of truth; these balances print on payslips and are checked against provider payslips. US Flexible PTO (exempt) is unlimited with no balance or accrual, so it is not tracked here.'),
    h('div', { class: 'kpis' },
      kpi('Balances', String(rows.length), `${plans.length} plans`),
      kpi('Termination payouts', String(payouts.length), payouts.map(p => p.workerId).join(', ')),
      kpi('Flagged', String(rows.filter(a => a.flags.length).length), 'prorated, capped, terminated, data issues'),
    ),
    tabs([
      { id: 'balances', label: 'Time off balances', render: () => viewBalances(rows) },
      { id: 'payouts', label: 'Payouts & leave liability', render: () => h('div', null,
    card('Payouts that flow to payroll', table(payouts, [
      { key: 'workerId', label: 'Worker' }, { key: 'plan', label: 'Plan' }, { key: 'payoutQty', label: 'Qty', align: 'right', render: a => `${fmtNum(a.payoutQty)} ${a.unit}` },
      { key: 'rate', label: 'Rate', align: 'right', render: a => fmtMoney(a.rate, a.currency, 4) },
      { key: 'payoutAmount', label: 'Payout', align: 'right', render: a => fmtMoney(a.payoutAmount, a.currency) },
      { key: 'usd', label: 'USD', align: 'right', value: a => a.payoutAmount * (fx[a.currency] ?? 1), render: a => fmtMoney(a.payoutAmount * (fx[a.currency] ?? 1)) },
      { key: 'how', label: 'Formula', value: a => (a.unit === 'days' ? 'days × (annual ÷ 52 ÷ 5)' : 'hours × base rate') },
    ], { search: false })),
    card('Leave liability (plans that pay out)', table([...liab.entries()].map(([plan, x]) => ({ plan, ...x })), [
      { key: 'plan', label: 'Plan' }, { key: 'cur', label: 'Currency' },
      { key: 'open', label: 'Opening liability', align: 'right', render: r => fmtMoney(r.open, r.cur) },
      { key: 'end', label: 'Ending liability', align: 'right', render: r => fmtMoney(r.end, r.cur) },
      { key: 'chg', label: 'Change', align: 'right', value: r => r.end - r.open, render: r => fmtMoney(r.end - r.open, r.cur) },
      { key: 'usd', label: 'Ending (USD)', align: 'right', value: r => r.end * (fx[r.cur] ?? 1), render: r => fmtMoney(r.end * (fx[r.cur] ?? 1)) },
    ], { search: false }))) },
    ]),
    card('How absence interacts with time and pay', h('ul', null,
      h('li', null, 'Hourly accruals count hours worked from the time engine only — leave hours do not accrue.'),
      h('li', null, 'Time off reduces scheduled hours that day and pays at base rate (VAC_HRS / SICK_HRS); usage cannot exceed the available balance.'),
      h('li', null, 'Unpaid leave docks pay by working days (UNPD_LV) and pauses accrual; paid leave keeps accruing.'),
      h('li', null, 'State sick plans accrue only on days worked in that state, so movers freeze on the move date (E0005, E0007) and new CA workers are enrolled (E0014).'),
      h('li', null, 'On termination, plans with payout pay the ending balance; Flexible PTO and sick plans are forfeited.'),
    )),
  );
}
