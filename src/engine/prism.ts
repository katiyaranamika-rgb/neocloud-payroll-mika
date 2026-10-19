// Export payroll journal (close step) and the single GL mapping (data/gl_posting_rules.csv).
//
// GL mapping: one file. Rules are by country (US, UK, IN, CA); each rule row lists the
// companies of that country it applies to. Every pay code has an account and a debit/credit
// side; employer costs have two rows.
//
// Two routes into the same NetSuite journal:
//  - US: payroll is calculated here (Workday), so results are already worker × pay code with
//    company, department and location. usJournals() applies the company's rules directly.
//  - Non-US: the vendor calculates payroll and sends a register with ONE ROW PER WORKER, a
//    `company` column and one column per pay code (no GL). importRegister() routes rows by
//    company, transposes to worker × pay code and validates; applyMapping() posts it.

import type { Row } from './csv.ts';
import type { Model, Worker, RegisterRow } from './types.ts';
import { round2 } from './dates.ts';

export const REGISTER_HEAD = ['employee_id', 'employee_name', 'company', 'country', 'currency', 'period_start', 'period_end', 'pay_date'];
export const REGISTER_INFO = ['leave_balance_days'];

export interface MappingSet { id: string; name: string; country: string; companies: string[] }
export interface PostingRule { mappingId: string; payCode: string; description: string; type: string; side: 'DR' | 'CR'; account: string; accountName: string; segments: string }
export interface CompanyInfo { company: string; subsidiary: string; currency: string; country: string; payGroups: string[] }

export interface TransposedRow {
  employeeId: string; employeeName: string; company: string; currency: string; payCode: string;
  description: string; type: string; amount: number; mapped: boolean;
}
export interface ImportCheck { level: 'error' | 'warning' | 'ok'; check: string; detail: string }
export interface MissingField { employeeId: string; missing: string[] }

export interface CompanyImport {
  company: string; info: CompanyInfo | null; mappingSet: MappingSet | null; rows: Row[]; payCodes: string[];
  transposed: TransposedRow[]; checks: ImportCheck[]; netFailures: { employeeId: string; computed: number; net: number }[];
  unknownWorkers: string[]; unmappedCodes: string[]; missingFields: MissingField[];
  payDate: string; periodStart: string; periodEnd: string; currency: string;
}
export interface RegisterImport { hasCompanyColumn: boolean; rows: number; payCodes: string[]; fileChecks: ImportCheck[]; groups: CompanyImport[] }

export const COUNTRY_NAMES: Record<string, string> = { US: 'United States', UK: 'United Kingdom', IN: 'India', CA: 'Canada' };
const splitCompanies = (v: string | undefined) => (v ?? '').split('|').map(c => c.trim()).filter(Boolean);

/** Country mappings derived from the one rules file (id = country code). */
export function mappingSets(model: Model): MappingSet[] {
  const by = new Map<string, Set<string>>();
  for (const r of model.raw.gl_posting_rules ?? []) {
    if (!r.country) continue;
    const set = by.get(r.country) ?? new Set<string>();
    for (const c of splitCompanies(r.companies)) set.add(c);
    by.set(r.country, set);
  }
  return [...by].map(([country, cs]) => ({ id: country, name: `${COUNTRY_NAMES[country] ?? country} rules`, country, companies: [...cs] }));
}

export function postingRules(model: Model): PostingRule[] {
  return (model.raw.gl_posting_rules ?? []).map(r => ({
    mappingId: r.country, payCode: r.pay_code, description: r.description, type: r.type,
    side: (r.debit_credit === 'CR' ? 'CR' : 'DR') as 'DR' | 'CR', account: r.account, accountName: r.account_name, segments: r.segments,
  })).filter(r => r.mappingId && r.payCode);
}

export function companies(model: Model): CompanyInfo[] {
  return (model.raw.subsidiaries ?? []).map(r => ({ company: r.workday_company, subsidiary: r.subsidiary, currency: r.currency, country: r.country ?? '', payGroups: (r.pay_groups ?? '').split('|') }));
}

export function workerCompany(model: Model, w: Worker): string {
  return companies(model).find(c => c.payGroups.includes(w.payGroup))?.company ?? '';
}

/** Country rules that cover a company (more than one = configuration conflict). */
export function mappingFor(model: Model, company: string): MappingSet[] {
  return mappingSets(model).filter(m => m.companies.includes(company));
}

export function payCodeColumns(rows: Row[]): string[] {
  const cols = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) cols.add(k);
  return [...cols].filter(c => !REGISTER_HEAD.includes(c) && !REGISTER_INFO.includes(c));
}

const num = (v: string | undefined) => (v === undefined || v === '' ? NaN : Number(v));

/**
 * Posting fields every worker on the journal needs from their Workday record:
 * company (must match the register's company), department (cost center with a NetSuite
 * department) and location.
 */
export function requiredFieldGaps(model: Model, ids: string[], company: string): MissingField[] {
  const out: MissingField[] = [];
  for (const id of [...new Set(ids)]) {
    const w = model.workerById.get(id);
    if (!w) continue;
    const missing: string[] = [];
    const wc = workerCompany(model, w);
    if (!wc) missing.push('company (no company on worker record)');
    else if (wc !== company) missing.push(`company (worker belongs to ${wc}, register says ${company})`);
    if (!w.costCenter || !model.departments.has(w.costCenter)) missing.push('department');
    if (!w.location) missing.push('location');
    if (missing.length) out.push({ employeeId: id, missing });
  }
  return out;
}

/** Group a register by company, route to mapping sets, transpose and validate. */
export function importRegister(model: Model, rows: Row[]): RegisterImport {
  const hasCompanyColumn = rows.length > 0 && rows.every(r => Object.prototype.hasOwnProperty.call(r, 'company'));
  const codes = payCodeColumns(rows);
  const fileChecks: ImportCheck[] = [
    { level: rows.length ? 'ok' : 'error', check: 'File loaded', detail: rows.length ? `${rows.length} worker rows, ${codes.length} pay code columns` : 'No rows' },
    { level: hasCompanyColumn ? 'ok' : 'error', check: 'Company column present', detail: hasCompanyColumn ? 'Rows will be routed to GL mappings by company' : 'Add a "company" column (Workday company, e.g. NC-UK) so each row can be routed to its GL mapping' },
  ];
  const groups: CompanyImport[] = [];
  if (!hasCompanyColumn) return { hasCompanyColumn, rows: rows.length, payCodes: codes, fileChecks, groups };
  const byCompany = new Map<string, Row[]>();
  for (const r of rows) byCompany.set(r.company || '(blank)', [...(byCompany.get(r.company || '(blank)') ?? []), r]);
  const allRules = postingRules(model);
  for (const [company, grows] of byCompany) {
    const info = companies(model).find(c => c.company === company) ?? null;
    const sets = mappingFor(model, company);
    const mappingSet = sets.length === 1 ? sets[0] : null;
    const rules = mappingSet ? allRules.filter(r => r.mappingId === mappingSet.id) : [];
    const ruleFor = (code: string) => rules.find(r => r.payCode === code);
    const transposed: TransposedRow[] = [];
    const unknownWorkers: string[] = [];
    const netFailures: CompanyImport['netFailures'] = [];
    for (const r of grows) {
      const id = r.employee_id;
      if (!model.workerById.has(id)) unknownWorkers.push(id);
      let earn = 0, ded = 0, net = NaN;
      for (const code of codes) {
        const amt = num(r[code]);
        if (!Number.isFinite(amt) || amt === 0) continue; // only pay codes the worker actually has
        const rule = ruleFor(code);
        const type = rule?.type ?? 'Unmapped';
        transposed.push({ employeeId: id, employeeName: r.employee_name ?? '', company, currency: r.currency ?? '', payCode: code, description: rule?.description ?? code, type, amount: round2(amt), mapped: !!rule });
        if (type === 'Earning') earn += amt;
        else if (type === 'Deduction' || type === 'Employee tax') ded += amt;
        else if (type === 'Net pay') net = amt;
      }
      if (Number.isFinite(net) && Math.abs(earn - ded - net) > 0.05) netFailures.push({ employeeId: id, computed: round2(earn - ded), net: round2(net) });
    }
    const usedCodes = [...new Set(transposed.map(t => t.payCode))];
    const unmappedCodes = mappingSet ? usedCodes.filter(c => !ruleFor(c)) : [];
    const missingFields = requiredFieldGaps(model, grows.map(r => r.employee_id).filter(id => model.workerById.has(id)), company);
    const checks: ImportCheck[] = [
      { level: info ? 'ok' : 'error', check: 'Company exists', detail: info ? `${company} · ${info.subsidiary} · ${info.currency}` : `${company} is not a Workday company` },
      { level: mappingSet ? 'ok' : 'error', check: 'GL mapping found for company', detail: mappingSet ? mappingSet.name : sets.length > 1 ? `${company} is assigned to more than one country: ${sets.map(s => s.name).join(', ')}` : `No GL rules apply to ${company} — tick it under its country in Setup → GL mapping` },
      { level: unmappedCodes.length ? 'error' : mappingSet ? 'ok' : 'warning', check: 'Every pay code has a posting rule', detail: unmappedCodes.length ? `No rule for: ${unmappedCodes.join(', ')}` : mappingSet ? `${usedCodes.length} of ${usedCodes.length} codes mapped` : 'Waiting on mapping' },
      { level: unknownWorkers.length ? 'error' : 'ok', check: 'Every employee exists in Workday', detail: unknownWorkers.length ? `Unknown: ${unknownWorkers.join(', ')}` : 'All employee IDs found' },
      { level: missingFields.length ? 'error' : 'ok', check: 'Every worker has company, department and location', detail: missingFields.length ? missingFields.map(m => `${m.employeeId} (${m.missing.join(', ')})`).join('; ') : 'All posting fields present on the worker records' },
      { level: netFailures.length ? 'error' : 'ok', check: 'Net pay = earnings − deductions − taxes', detail: netFailures.length ? `${netFailures.length} worker(s) do not foot` : 'Every worker foots' },
    ];
    groups.push({
      company, info, mappingSet, rows: grows, payCodes: usedCodes, transposed, checks, netFailures, unknownWorkers, unmappedCodes, missingFields,
      payDate: grows[0]?.pay_date ?? '', periodStart: grows[0]?.period_start ?? '', periodEnd: grows[0]?.period_end ?? '', currency: info?.currency ?? grows[0]?.currency ?? '',
    });
  }
  return { hasCompanyColumn, rows: rows.length, payCodes: codes, fileChecks, groups };
}

// Roles used by the provider reconciliation (International screen).
const ROLE: Record<string, string> = {
  BASIC: 'base', BONUS: 'bonus', HOL_PAYOUT: 'payout', EL_ENCASH: 'payout', VAC_PAY: 'payout',
  PAYE: 'eeTax', TDS: 'eeTax', INC_TAX: 'eeTax', EE_NI: 'eeSocial', EE_PF: 'eeSocial', CPP_EE: 'eeSocial', EI_EE: 'eeSocial',
  EE_PENSION: 'eePension', GARN_FRO: 'eePension', NET_PAY: 'net', // eePension = other employee deductions (pension, garnishment)
  ER_NI: 'erSocial', ER_PF: 'erSocial', ER_CPP_EI: 'erSocial', ER_BENEFITS: 'erBenefits',
};

export function vendorRoleTotals(r: Row): Record<string, number> {
  const t: Record<string, number> = { base: 0, bonus: 0, payout: 0, eeTax: 0, eeSocial: 0, eePension: 0, net: 0, erSocial: 0, erBenefits: 0 };
  for (const [col, role] of Object.entries(ROLE)) {
    const v = num(r[col]);
    if (Number.isFinite(v)) t[role] += v;
  }
  return t;
}

// ---------------------------------------------------------------- apply mapping → NetSuite journal

export interface MappedLine {
  employeeId: string; payCode: string; description: string; type: string; side: 'DR' | 'CR'; account: string;
  accountName: string; amount: number; debit: number; credit: number; department: string; location: string; cls: string;
}
export interface JournalSummaryLine {
  subsidiary: string; currency: string; date: string; account: string; accountName: string; debit: number; credit: number;
  department: string; location: string; cls: string; fx: number; debitUsd: number; creditUsd: number;
}
export interface MappingResult {
  company: string; ok: boolean; blockers: { reason: string; detail: string }[]; lines: MappedLine[]; summary: JournalSummaryLine[];
  totals: { debit: number; credit: number; balanced: boolean }; journalId: string; subsidiary: string; currency: string; date: string; mappingName: string;
}

/**
 * Apply the company's GL mapping. Fails (no journal) when the company has no mapping, a pay code
 * has no posting rule, an employee is not in Workday, a worker is missing company, department or
 * location, or a worker's net pay does not foot.
 */
export function applyMapping(model: Model, g: CompanyImport): MappingResult {
  const sub = g.info;
  const fx = model.rules.intl.fxToUsd[g.currency] ?? 1;
  const journalId = `JE-${g.company}-PAYROLL-${(g.payDate || '').replace(/-/g, '')}`;
  const blockers: MappingResult['blockers'] = [];
  if (!sub) blockers.push({ reason: 'Unknown company', detail: `${g.company} is not a Workday company` });
  if (!g.mappingSet) blockers.push({ reason: 'No GL mapping for company', detail: `${g.company} — assign it to a GL mapping in Setup → GL mapping` });
  if (g.unmappedCodes.length) blockers.push({ reason: 'Pay codes without a posting rule', detail: `${g.unmappedCodes.join(', ')} — add them to ${g.mappingSet?.name ?? 'the GL mapping'} and apply again` });
  if (g.unknownWorkers.length) blockers.push({ reason: 'Employees not found in Workday', detail: `${g.unknownWorkers.join(', ')} — their cost lines need a company, department and location from the worker record` });
  if (g.missingFields.length) blockers.push({ reason: 'Workers missing required posting fields', detail: `${g.missingFields.map(m => `${m.employeeId}: ${m.missing.join(', ')}`).join('; ')} — fix the worker record in Workday and apply again` });
  if (g.netFailures.length) blockers.push({ reason: 'Net pay does not foot', detail: `${g.netFailures.map(n => n.employeeId).join(', ')} — earnings − deductions − taxes ≠ NET_PAY, so the journal would not balance` });
  const base = { company: g.company, journalId, subsidiary: sub?.subsidiary ?? g.company, currency: g.currency, date: g.payDate, mappingName: g.mappingSet?.name ?? '' };
  if (blockers.length || !sub || !g.mappingSet) return { ...base, ok: false, blockers, lines: [], summary: [], totals: { debit: 0, credit: 0, balanced: false } };

  const rules = postingRules(model).filter(r => r.mappingId === g.mappingSet!.id);
  // Everything posted comes from the provider register; the app calculates nothing here.
  const lines = g.transposed.flatMap(t => postLine(model, rules, model.workerById.get(t.employeeId)!, t.payCode, t.amount));
  return finish(base, sub, fx, lines, blockers);
}

/** Post one worker × pay code amount through the rules: one line per rule row (DR and/or CR). */
export function postLine(model: Model, rules: PostingRule[], w: Worker, code: string, amount: number): MappedLine[] {
  const dept = model.departments.get(w.costCenter)?.netsuite ?? w.costCenter;
  return rules.filter(r => r.payCode === code).map(r => {
    const seg = model.glAccounts.get(r.account)?.segmentLevel === 'Department';
    const drAmt = r.side === 'DR' ? amount : -amount; // negative amounts reverse the side
    return {
      employeeId: w.id, payCode: code, description: r.description, type: r.type, side: r.side, account: r.account,
      accountName: model.glAccounts.get(r.account)?.name ?? r.accountName, amount: round2(amount),
      debit: drAmt > 0 ? round2(drAmt) : 0, credit: drAmt < 0 ? round2(-drAmt) : 0,
      department: seg ? dept : '', location: seg ? w.location : '', cls: seg ? w.payGroup : '',
    };
  });
}

/** The rules that apply to a company (via the country it is ticked under). */
export function rulesForCompany(model: Model, company: string): { set: MappingSet | null; sets: MappingSet[]; rules: PostingRule[] } {
  const sets = mappingFor(model, company);
  const set = sets.length === 1 ? sets[0] : null;
  return { set, sets, rules: set ? postingRules(model).filter(r => r.mappingId === set.id) : [] };
}

/** Pay codes on a payroll result that are posted (memo-only flexible PTO and zero lines are skipped). */
export const postable = (code: string, amount: number) => code !== 'PTO_FLEX' && Math.abs(amount) >= 0.005;

/** US payroll results → accounting lines with the company's rules (used by Payroll results → Payroll accounting). */
export function resultLines(model: Model, rows: RegisterRow[], rules: PostingRule[]): { lines: MappedLine[]; unmapped: string[] } {
  const lines: MappedLine[] = []; const unmapped = new Set<string>();
  for (const r of rows) {
    const w = model.workerById.get(r.workerId);
    if (!w) continue;
    for (const l of r.lines) {
      if (!postable(l.code, l.amount)) continue;
      const out = postLine(model, rules, w, l.code, l.amount);
      if (!out.length) unmapped.add(l.code);
      lines.push(...out);
    }
  }
  return { lines, unmapped: [...unmapped] };
}

export interface UsJournal extends MappingResult { payGroup: string; periodStart: string; periodEnd: string; workers: number; checks: ImportCheck[] }

/**
 * US route: the results are already worker × pay code with company, department and location, so
 * there is no upload or transpose. One journal per pay group (each has its own pay date).
 */
export function usJournals(model: Model, register: RegisterRow[], company: string, payGroup = ''): UsJournal[] {
  const info = companies(model).find(c => c.company === company) ?? null;
  if (!info) return [];
  const { set, sets, rules } = rulesForCompany(model, company);
  const fx = model.rules.intl.fxToUsd[info.currency] ?? 1;
  const out: UsJournal[] = [];
  for (const pg of info.payGroups.filter(p => !payGroup || p === payGroup)) {
    const ps = model.schedules.get(pg);
    const rows = register.filter(r => r.payGroup === pg && r.bucket !== 'Excluded');
    if (!ps || !rows.length) continue;
    const { lines, unmapped } = resultLines(model, rows, rules);
    const missingFields = requiredFieldGaps(model, rows.map(r => r.workerId), company);
    const blockers: MappingResult['blockers'] = [];
    if (!set) blockers.push({ reason: 'No GL mapping for company', detail: sets.length > 1 ? `${company} is ticked under more than one country` : `${company} — tick it under its country in Setup → GL mapping` });
    if (set && unmapped.length) blockers.push({ reason: 'Pay codes without a posting rule', detail: `${unmapped.join(', ')} — add them to ${set.name} and generate again` });
    if (missingFields.length) blockers.push({ reason: 'Workers missing required posting fields', detail: `${missingFields.map(m => `${m.employeeId}: ${m.missing.join(', ')}`).join('; ')} — fix the worker record in Workday` });
    const short = pg === 'US Semi-monthly' ? 'SM' : pg === 'US Biweekly' ? 'BW' : pg.replace(/\W+/g, '');
    const gross = round2(rows.reduce((s, r) => s + r.gross, 0)); const net = round2(rows.reduce((s, r) => s + r.net, 0));
    const checks: ImportCheck[] = [
      { level: 'ok', check: 'Source: payroll results (calculated in Workday)', detail: `${rows.length} workers · gross ${gross.toFixed(2)} · net ${net.toFixed(2)} ${info.currency}. Already worker × pay code with company, department and location — no upload or transpose.` },
      { level: set ? 'ok' : 'error', check: 'GL mapping found for company', detail: set ? set.name : blockers[0].detail },
      { level: unmapped.length ? 'error' : set ? 'ok' : 'warning', check: 'Every pay code has a posting rule', detail: unmapped.length ? `No rule for: ${unmapped.join(', ')}` : set ? 'All pay codes mapped' : 'Waiting on mapping' },
      { level: missingFields.length ? 'error' : 'ok', check: 'Every worker has company, department and location', detail: missingFields.length ? missingFields.map(m => `${m.employeeId} (${m.missing.join(', ')})`).join('; ') : 'All posting fields present on the worker records' },
    ];
    const base = { company, journalId: `JE-${company}-${short}-PAYROLL-${ps.payDate.replace(/-/g, '')}`, subsidiary: info.subsidiary, currency: info.currency, date: ps.payDate, mappingName: set?.name ?? '' };
    const extra = { payGroup: pg, periodStart: ps.start, periodEnd: ps.end, workers: rows.length, checks };
    if (blockers.length) { out.push({ ...base, ...extra, ok: false, blockers, lines, summary: [], totals: { debit: 0, credit: 0, balanced: false } }); continue; }
    const m = finish(base, info, fx, lines, blockers);
    if (!m.totals.balanced) checks.push({ level: 'error', check: 'Journal balances', detail: `Debits ${m.totals.debit} vs credits ${m.totals.credit}` });
    else checks.push({ level: 'ok', check: 'Journal balances', detail: `Debits = credits = ${m.totals.debit.toFixed(2)} ${info.currency}` });
    out.push({ ...m, ...extra });
  }
  return out;
}

function finish(base: Omit<MappingResult, 'ok' | 'blockers' | 'lines' | 'summary' | 'totals'>, sub: CompanyInfo, fx: number, lines: MappedLine[], blockers: MappingResult['blockers']): MappingResult {
  const g = { currency: base.currency, payDate: base.date };
  const agg = new Map<string, JournalSummaryLine>();
  for (const l of lines) {
    const key = [l.account, l.department, l.location, l.cls].join('|');
    const a = agg.get(key) ?? { subsidiary: sub.subsidiary, currency: g.currency, date: g.payDate, account: l.account, accountName: l.accountName, debit: 0, credit: 0, department: l.department, location: l.location, cls: l.cls, fx, debitUsd: 0, creditUsd: 0 };
    a.debit += l.debit; a.credit += l.credit;
    agg.set(key, a);
  }
  const summary = [...agg.values()].map(a => {
    const net = round2(a.debit - a.credit);
    const debit = net > 0 ? net : 0; const credit = net < 0 ? -net : 0;
    return { ...a, debit, credit, debitUsd: round2(debit * fx), creditUsd: round2(credit * fx) };
  }).filter(a => a.debit || a.credit).sort((a, b) => (a.account + a.department + a.location).localeCompare(b.account + b.department + b.location));
  const debit = round2(summary.reduce((s, l) => s + l.debit, 0));
  const credit = round2(summary.reduce((s, l) => s + l.credit, 0));
  const balanced = Math.abs(debit - credit) < 0.01;
  if (!balanced) blockers.push({ reason: 'Journal does not balance', detail: `Debits ${debit} vs credits ${credit}` });
  return { ...base, ok: balanced, blockers, lines, summary, totals: { debit, credit, balanced } };
}

export const NETSUITE_COLUMNS = ['journal_id', 'company', 'subsidiary', 'currency', 'date', 'account', 'account_name', 'debit', 'credit', 'department', 'location', 'class', 'memo', 'fx_rate_to_usd', 'debit_usd', 'credit_usd'];

export function netsuiteRows(m: MappingResult, memo: string): Record<string, unknown>[] {
  return m.summary.map(l => ({
    journal_id: m.journalId, company: m.company, subsidiary: l.subsidiary, currency: l.currency, date: l.date, account: l.account,
    account_name: l.accountName, debit: l.debit || '', credit: l.credit || '', department: l.department, location: l.location,
    class: l.cls, memo, fx_rate_to_usd: l.fx, debit_usd: l.debitUsd || '', credit_usd: l.creditUsd || '',
  }));
}
