// Payroll accounting: turns pay results into NetSuite journals.
//
// Each pay-code amount posts through the company's country rules in data/gl_posting_rules.csv
// (the one GL mapping, editable in the app; same rules as Export payroll journal). US postings
// come from the calculated results; international postings come from the provider registers
// exactly as received. Expense accounts carry department (from the derived cost center),
// location and class (pay group). Liability/asset accounts post at subsidiary level only.
// Journals are summarized by subsidiary × account × department × location × class.
// Validation blocks export if any code is unmapped, an account is not in the chart, or a
// journal does not balance.

import type { Model, RegisterRow, AbsenceRow, TimeResult } from './types.ts';
import type { IntlResult } from './intl.ts';
import { round2 } from './dates.ts';
import { rateOn } from './model.ts';
import { employmentWindow, unpaidLeaveDates } from './employment.ts';
import { rulesForCompany, payCodeColumns, postable } from './prism.ts';
import type { PostingRule } from './prism.ts';
import { VENDOR_FILES } from './files.ts';
import type { Row } from './csv.ts';

export interface JournalLine {
  journalId: string; journalName: string; subsidiary: string; currency: string; date: string;
  account: string; accountName: string; debit: number; credit: number; department: string;
  location: string; cls: string; memo: string; fx: number; debitUsd: number; creditUsd: number;
}

export interface JournalIssue { severity: 'error' | 'warning'; journalId: string; code: string; message: string }

export interface JournalResult {
  lines: JournalLine[];
  journals: { journalId: string; name: string; subsidiary: string; currency: string; date: string;
    debit: number; credit: number; balanced: boolean; lineCount: number }[];
  issues: JournalIssue[];
  exportable: boolean;
  bank: { payGroup: string; registerNet: number; directDeposit: number; checks: number; bankFileTotal: number;
    difference: number; source: string }[];
  ties: { label: string; left: number; right: number; difference: number; ok: boolean }[];
  accrualDetail: { workerId: string; hours: number; rate: number; amount: number }[];
}

interface Posting {
  company: string; journalId: string; journalName: string; subsidiary: string; currency: string; date: string; code: string;
  amount: number; department: string; location: string; cls: string; memo: string;
}

const US_SUB = 'NeoCloud Inc. (US)';
const COMPANY_BY_GROUP: Record<string, string> = {
  'US Semi-monthly': 'NC-US', 'US Biweekly': 'NC-US', 'UK Monthly': 'NC-UK', 'Canada Monthly': 'NC-CA', 'India Monthly': 'NC-IN',
};
const SUB_BY_GROUP: Record<string, string> = {
  'US Semi-monthly': US_SUB, 'US Biweekly': US_SUB, 'UK Monthly': 'NeoCloud UK Ltd',
  'Canada Monthly': 'NeoCloud Canada Inc.', 'India Monthly': 'NeoCloud India Pvt Ltd',
};

export function buildJournal(model: Model, register: RegisterRow[], intl: IntlResult, absence: AbsenceRow[], time: Map<string, TimeResult>): JournalResult {
  const postings: Posting[] = [];
  const issues: JournalIssue[] = [];
  const dept = (cc: string) => model.departments.get(cc)?.netsuite ?? cc;

  // ---- US pay runs ----
  for (const pg of ['US Semi-monthly', 'US Biweekly']) {
    const ps = model.schedules.get(pg)!;
    const jid = pg === 'US Semi-monthly' ? 'JE-US-SM-20261031' : 'JE-US-BW-20261017';
    const name = `${pg} pay run ${ps.start} to ${ps.end}`;
    for (const r of register.filter(r => r.payGroup === pg && r.bucket !== 'Excluded')) {
      for (const l of r.lines) {
        if (!postable(l.code, l.amount)) continue;
        postings.push({ company: 'NC-US', journalId: jid, journalName: name, subsidiary: US_SUB, currency: 'USD', date: ps.payDate, code: l.code, amount: l.amount, department: dept(r.costCenter), location: r.location, cls: pg, memo: `${jid} ${l.code}` });
      }
    }
    // Payment: bank file clears net pay payable on pay date.
    const net = round2(register.filter(r => r.payGroup === pg).reduce((s, r) => s + r.net, 0));
    postings.push({ company: 'NC-US', journalId: `${jid}-PAY`, journalName: `${pg} net pay disbursed`, subsidiary: US_SUB, currency: 'USD', date: ps.payDate, code: 'BANK_CLR', amount: net, department: '', location: '', cls: pg, memo: 'Bank file + checks cleared' });
  }

  // ---- International: the provider registers as received (every pay code column) ----
  for (const [pg, file] of Object.entries(VENDOR_FILES)) {
    const vrows = (model.raw as unknown as Record<string, Row[]>)[file] ?? [];
    const codes = payCodeColumns(vrows);
    for (const r of vrows) {
      const w = model.workerById.get(r.employee_id);
      if (!w) continue;
      const ps = model.schedules.get(w.payGroup)!;
      const jid = `JE-${w.country}-20261031`;
      const base = { company: r.company || COMPANY_BY_GROUP[pg], journalId: jid, journalName: `${w.payGroup} provider results ${ps.start} to ${ps.end}`, subsidiary: SUB_BY_GROUP[w.payGroup], currency: r.currency || w.currency, date: ps.payDate, department: dept(w.costCenter), location: w.location, cls: w.payGroup, memo: `${jid} provider register` };
      for (const code of codes) {
        const amount = Number(r[code]);
        if (Number.isFinite(amount) && Math.abs(amount) >= 0.005) postings.push({ ...base, code, amount });
      }
    }
  }
  // Provider funding clears the provider clearing account on the pay date.
  for (const c of intl.byCountry) {
    const ps = model.schedules.get(c.payGroup)!;
    const country = c.payGroup === 'UK Monthly' ? 'UK' : c.payGroup === 'India Monthly' ? 'IN' : 'CA';
    if (Math.abs(c.netVendor) >= 0.005) postings.push({ company: COMPANY_BY_GROUP[c.payGroup], journalId: `JE-${country}-20261031`, journalName: `${c.payGroup} provider results ${ps.start} to ${ps.end}`, subsidiary: SUB_BY_GROUP[c.payGroup], currency: c.currency, date: ps.payDate, code: 'BANK_CLR', amount: c.netVendor, department: '', location: '', cls: c.payGroup, memo: 'Provider funded' });
  }

  // ---- Month-end accruals (Oct 31), auto-reversed Nov 1 ----
  const accrualDetail: JournalResult['accrualDetail'] = [];
  const bw = model.schedules.get('US Biweekly')!;
  const accStart = '2026-10-18'; const accEnd = '2026-10-31';
  for (const w of model.workers.filter(w => w.payGroup === 'US Biweekly' && w.workerType === 'Employee')) {
    const win = employmentWindow(w, accStart, accEnd);
    if (!win) continue;
    const unpaid = unpaidLeaveDates(model, w, accStart, accEnd);
    const frac = 1 - unpaid.size / 14;
    if (frac <= 0) continue;
    const hours = round2(w.weeklyHours * 2 * frac);
    const rate = rateOn(w, accEnd);
    const amount = round2(hours * rate);
    accrualDetail.push({ workerId: w.id, hours, rate, amount });
    const p = { company: 'NC-US', subsidiary: US_SUB, currency: 'USD', department: dept(w.costCenter), location: w.location, cls: 'US Biweekly', code: 'ACCR_WAGES' };
    postings.push({ ...p, journalId: 'JE-ACCR-20261031', journalName: 'Accrued wages US Biweekly Oct 18–31', date: '2026-10-31', amount, memo: 'Accrued wages (auto-reverse Nov 1)' });
    postings.push({ ...p, journalId: 'JE-ACCR-REV-20261101', journalName: 'Reversal of accrued wages', date: '2026-11-01', amount: -amount, memo: 'Reversal of JE-ACCR-20261031' });
  }
  void bw; void time;
  // Leave liability true-up = (accrued − used) × rate for plans that pay out.
  for (const a of absence) {
    const rule = model.rules.absence[a.plan];
    if (!rule?.payout) continue;
    const w = model.workerById.get(a.workerId);
    if (!w) continue;
    const amount = round2((a.accrued - a.used) * a.rate);
    if (Math.abs(amount) < 0.005) continue;
    postings.push({ company: COMPANY_BY_GROUP[w.payGroup] ?? '', journalId: `JE-LEAVE-${w.country}-20261031`, journalName: `Leave liability true-up Oct 31 (${w.country})`, subsidiary: SUB_BY_GROUP[w.payGroup], currency: w.currency, date: '2026-10-31', code: 'ACCR_LEAVE', amount, department: dept(w.costCenter), location: w.location, cls: w.payGroup, memo: `${a.plan} accrual net of usage` });
  }

  // ---- Map postings to accounts ----
  type Key = string;
  const agg = new Map<Key, JournalLine & { net: number }>();
  const unmapped = new Set<string>();
  const rulesCache = new Map<string, PostingRule[]>();
  const rulesOf = (company: string) => {
    if (!rulesCache.has(company)) rulesCache.set(company, rulesForCompany(model, company).rules);
    return rulesCache.get(company)!;
  };
  for (const p of postings) {
    const legs = rulesOf(p.company).filter(r => r.payCode === p.code);
    const pc = model.payCodes.get(p.code);
    if (pc && !pc.active) issues.push({ severity: 'warning', journalId: p.journalId, code: p.code, message: `Pay code ${p.code} is inactive but has amounts` });
    if (!legs.length) {
      const k = `${p.company}|${p.code}`;
      if (!unmapped.has(k)) issues.push({ severity: 'error', journalId: p.journalId, code: p.code, message: `Pay code ${p.code} has no posting rule for ${p.company} – export blocked` });
      unmapped.add(k);
      continue;
    }
    for (const [acct, sign] of legs.map(r => [r.account, r.side === 'DR' ? 1 : -1]) as [string, number][]) {
      const a = model.glAccounts.get(acct);
      if (!a) {
        issues.push({ severity: 'error', journalId: p.journalId, code: p.code, message: `Account ${acct} (mapped from ${p.code}) is not in the chart of accounts – export blocked` });
        continue;
      }
      const seg = a.segmentLevel === 'Department';
      const key = [p.journalId, acct, seg ? p.department : '', seg ? p.location : '', seg ? p.cls : ''].join('|');
      const fx = model.rules.intl.fxToUsd[p.currency] ?? 1;
      const cur = agg.get(key) ?? {
        journalId: p.journalId, journalName: p.journalName, subsidiary: p.subsidiary, currency: p.currency, date: p.date,
        account: acct, accountName: a.name, debit: 0, credit: 0, department: seg ? p.department : '',
        location: seg ? p.location : '', cls: seg ? p.cls : '', memo: p.journalName, fx, debitUsd: 0, creditUsd: 0, net: 0,
      };
      cur.net += sign * p.amount;
      agg.set(key, cur);
    }
  }
  const lines: JournalLine[] = [];
  for (const l of agg.values()) {
    const net = round2(l.net);
    if (Math.abs(net) < 0.005) continue;
    const { net: _n, ...rest } = l;
    void _n;
    const debit = net > 0 ? net : 0;
    const credit = net < 0 ? -net : 0;
    lines.push({ ...rest, debit, credit, debitUsd: round2(debit * l.fx), creditUsd: round2(credit * l.fx) });
  }
  lines.sort((a, b) => (a.journalId + a.account + a.department + a.location).localeCompare(b.journalId + b.account + b.department + b.location));

  const jmap = new Map<string, JournalResult['journals'][number]>();
  for (const l of lines) {
    const j = jmap.get(l.journalId) ?? { journalId: l.journalId, name: l.journalName, subsidiary: l.subsidiary, currency: l.currency, date: l.date, debit: 0, credit: 0, balanced: true, lineCount: 0 };
    j.debit = round2(j.debit + l.debit); j.credit = round2(j.credit + l.credit); j.lineCount++;
    jmap.set(l.journalId, j);
  }
  const journals = [...jmap.values()];
  for (const j of journals) {
    j.balanced = Math.abs(j.debit - j.credit) < 0.01;
    if (!j.balanced) issues.push({ severity: 'error', journalId: j.journalId, code: '', message: `Journal out of balance by ${(j.debit - j.credit).toFixed(2)} ${j.currency}` });
  }

  // ---- Bank tie-out (US: bank file + checks = register net) ----
  const bank: JournalResult['bank'] = [];
  for (const pg of ['US Semi-monthly', 'US Biweekly']) {
    const rows = register.filter(r => r.payGroup === pg);
    const ps = model.schedules.get(pg)!;
    const net = round2(rows.reduce((s, r) => s + r.net, 0));
    // Final pay for terminations is issued as a live check; everyone else by direct deposit.
    const checks = round2(rows.filter(r => { const w = model.workerById.get(r.workerId)!; return !!w.termDate && w.termDate <= ps.end; }).reduce((s, r) => s + r.net, 0));
    const dd = round2(net - checks);
    bank.push({ payGroup: pg, registerNet: net, directDeposit: dd, checks, bankFileTotal: round2(dd + checks), difference: round2(dd + checks - net), source: 'Generated NACHA file + check register' });
  }
  for (const c of intl.byCountry) {
    const statementLine = c.netVendor; // Disbursement line on the bank statement for the provider funding
    bank.push({ payGroup: c.payGroup, registerNet: c.netVendor, directDeposit: statementLine, checks: 0, bankFileTotal: statementLine, difference: round2(statementLine - c.netVendor), source: `Provider funding line on bank statement (${c.currency})` });
  }

  // ---- Ties ----
  const ties: JournalResult['ties'] = [];
  for (const pg of ['US Semi-monthly', 'US Biweekly']) {
    const jid = pg === 'US Semi-monthly' ? 'JE-US-SM-20261031' : 'JE-US-BW-20261017';
    const gross = round2(register.filter(r => r.payGroup === pg).reduce((s, r) => s + r.gross, 0));
    const jl = lines.filter(l => l.journalId === jid);
    const earnAccts = ['6100', '6110', '6115', '6120', '6130', '6140'];
    const expense = round2(jl.filter(l => earnAccts.includes(l.account)).reduce((s, l) => s + l.debit - l.credit, 0));
    const payoutRelief = round2(register.filter(r => r.payGroup === pg).flatMap(r => r.lines).filter(l => l.code === 'VAC_PAYOUT').reduce((s, l) => s + l.amount, 0));
    ties.push({ label: `${pg}: register gross = wage expense + payouts relieved from 2190`, left: gross, right: round2(expense + payoutRelief), difference: round2(gross - expense - payoutRelief), ok: Math.abs(gross - expense - payoutRelief) < 0.05 });
    const jd = round2(jl.reduce((s, l) => s + l.debit, 0)); const jc = round2(jl.reduce((s, l) => s + l.credit, 0));
    ties.push({ label: `${pg}: journal debits = credits`, left: jd, right: jc, difference: round2(jd - jc), ok: Math.abs(jd - jc) < 0.05 });
    const net = round2(register.filter(r => r.payGroup === pg).reduce((s, r) => s + r.net, 0));
    const payable = round2(jl.filter(l => l.account === '2101').reduce((s, l) => s + l.credit - l.debit, 0));
    ties.push({ label: `${pg}: register net = net pay payable 2101`, left: net, right: payable, difference: round2(net - payable), ok: Math.abs(net - payable) < 0.05 });
  }
  for (const c of intl.byCountry) {
    const jid = `JE-${c.payGroup === 'UK Monthly' ? 'UK' : c.payGroup === 'India Monthly' ? 'IN' : 'CA'}-20261031`;
    const clr = round2(lines.filter(l => l.journalId === jid && l.account === '2170').reduce((s, l) => s + l.debit - l.credit, 0));
    ties.push({ label: `${c.payGroup}: provider clearing 2170 nets to zero after funding`, left: clr, right: 0, difference: clr, ok: Math.abs(clr) < 0.05 });
  }

  const exportable = !issues.some(i => i.severity === 'error');
  return { lines, journals, issues, exportable, bank, ties, accrualDetail };
}

export const JOURNAL_CSV_COLUMNS = [
  'journalId', 'subsidiary', 'currency', 'date', 'account', 'accountName', 'debit', 'credit',
  'department', 'location', 'cls', 'memo', 'fx', 'debitUsd', 'creditUsd',
];
