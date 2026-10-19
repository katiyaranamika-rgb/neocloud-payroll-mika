// Pre-payroll audit (AI) — requirement 9. Three parts:
//   1. Headcount roll-forward per US pay run: last run → joiners and leavers → this run →
//      who will not be paid → expected paid, tied to the register.
//   2. Deterministic checks vs the prior-period register, each with an explanation.
//   3. AI commentary with guardrails (src/engine/ai-guard.ts): allow-listed payload, worker IDs
//      pseudonymized, server-side schema check, reply verified against the payload, advisory
//      only, every call logged.

import { h, kpi, card, section, table, badge, fmtMoney, clear, collapsible } from './dom.ts';
import { state, getActions, resolveItem, reopenItem } from './state.ts';
import { findingKey } from '../engine/status.ts';
import { displayName } from './brand.ts';
import { go } from './router.ts';
import type { Finding, RollForward, RollLine } from '../engine/audit.ts';
import { buildPayload, reidentify, verify, templateFromPayload } from '../engine/ai-guard.ts';
import type { Verification } from '../engine/ai-guard.ts';

interface LogEntry { at: string; mode: string; prompt: string; response: string; check?: string }
const LOG_KEY = 'neocloud-payroll.ai-log.v1';
let log: LogEntry[] = (() => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } })();
const saveLog = () => { try { localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 20))); } catch { /* ignore */ } };

const sevTone = (s: string) => (s === 'High' ? 'bad' : s === 'Medium' ? 'warn' : 'info');

export function viewAudit(): HTMLElement {
  const A = state.result.audit;
  let sev = '';
  let check = '';
  const out = h('div', { class: 'ai-out' });
  const logBox = h('div');
  const drawLog = () => {
    clear(logBox).append(log.length ? table(log, [
      { key: 'at', label: 'When' }, { key: 'mode', label: 'Mode' },
      { key: 'prompt', label: 'Prompt (sanitized)', render: l => h('details', null, h('summary', null, `${l.prompt.length.toLocaleString()} chars`), h('pre', { class: 'small' }, l.prompt)) },
      { key: 'response', label: 'Response (as received, pseudonymized)', render: l => h('details', null, h('summary', null, l.response.slice(0, 80) + '…'), h('pre', { class: 'small' }, l.response)) },
      { key: 'check', label: 'Verification', render: l => (l.check ? badge(l.check === 'verified' ? 'Verified' : 'Unverified', l.check === 'verified' ? 'ok' : 'warn') : '') },
    ], { search: false, pageSize: 10 }) : h('p', { class: 'muted' }, 'No AI calls yet.'));
  };
  drawLog();
  const period = 'October 2026 (semi-monthly Oct 16–31, biweekly Oct 4–17)';
  const built = buildPayload(A, state.result.legacy.byClass, period);
  const generate = async () => {
    clear(out).append(h('p', { class: 'muted' }, 'Generating…'));
    const prompt = JSON.stringify(built.payload);
    let raw = ''; let mode = '';
    try {
      const res = await fetch('api/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: prompt });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j.text) throw new Error(j.error || 'empty');
      raw = j.text; mode = `AI (${j.model})`;
    } catch (e) {
      raw = templateFromPayload(built.payload);
      mode = `Template fallback (${(e as Error).message}; set ANTHROPIC_API_KEY to enable AI)`;
    }
    const v = verify(raw, built.payload);
    const text = reidentify(raw, built.map);
    log.unshift({ at: new Date().toLocaleString(), mode, prompt, response: raw, check: v.status });
    saveLog(); drawLog();
    clear(out).append(
      h('div', { class: 'row' }, badge(mode.startsWith('AI') ? 'AI-generated · advisory' : 'Template', mode.startsWith('AI') ? 'info' : 'muted'), verifyBadge(v), h('span', { class: 'small muted' }, mode)),
      verifyDetail(v),
      h('pre', { class: 'commentary' }, text));
  };
  const listBox = h('div');
  let resFilter = '';
  const countBox = h('span', { class: 'small' });
  const refreshCounts = () => {
    const act = getActions();
    const openHigh = A.findings.filter(f => f.severity === 'High' && !act.resolved[findingKey(f)]).length;
    const res = A.findings.filter(f => act.resolved[findingKey(f)]).length;
    countBox.textContent = `${res} resolved · ${openHigh} high still open (payroll audits stage completes when 0)`;
  };
  refreshCounts();
  const drawList = () => {
    const act = getActions();
    const isRes = (f: Finding) => !!act.resolved[findingKey(f)];
    const rows = A.findings.filter(f => (!sev || f.severity === sev) && (!check || f.check === check) && (!resFilter || (resFilter === 'Open' ? !isRes(f) : isRes(f))));
    const resolveBtn = (f: Finding) => {
      const r = act.resolved[findingKey(f)];
      if (r) return h('span', null, badge('Resolved', 'ok'), h('div', { class: 'small muted' }, `${r.note} · ${r.at}`),
        h('button', { class: 'btn ghost xs', onClick: (e: Event) => { e.stopPropagation(); reopenItem(findingKey(f)); refreshCounts(); drawList(); } }, 'Reopen'));
      return h('button', { class: 'btn ghost xs', onClick: (e: Event) => { e.stopPropagation(); const note = prompt(`Resolution note for ${f.workerId} – ${f.title}`, f.explanation.slice(0, 120)); if (note) { resolveItem(findingKey(f), note); refreshCounts(); drawList(); } } }, 'Resolve');
    };
    clear(listBox).append(table(rows, [
      { key: 'res', label: 'Resolution', value: f => (isRes(f) ? 'Resolved' : 'Open'), render: resolveBtn },
      { key: 'id', label: 'ID' }, { key: 'severity', label: 'Severity', render: f => badge(f.severity, sevTone(f.severity)) },
      { key: 'check', label: 'Check' }, { key: 'workerId', label: 'Worker' }, { key: 'name', label: 'Name', value: f => displayName(f.workerId) }, { key: 'payGroup', label: 'Pay group' },
      { key: 'title', label: 'Finding' }, { key: 'detail', label: 'Detail', render: f => h('span', { class: 'small' }, f.detail) },
      { key: 'explanation', label: 'Explanation', render: f => h('span', { class: 'small' }, f.explanation) },
      { key: 'current', label: 'Current', align: 'right', render: f => (f.current !== null ? fmtMoney(f.current) : '') },
      { key: 'prior', label: 'Prior', align: 'right', render: f => (f.prior !== null ? fmtMoney(f.prior) : '') },
    ], { csvName: 'pre-payroll-audit.csv', pageSize: 50, onRow: f => go('payslip', f.workerId) }));
  };
  drawList();
  // Workers with no findings: prior and current gross match (no change since last period).
  const R = state.result;
  const cat = (c: string) => R.model.payCodes.get(c)?.category ?? '';
  const prior = new Map<string, { gross: number; net: number; oasdi: number }>();
  for (const p of R.model.raw.prior_register) {
    const x = prior.get(p.worker_id) ?? { gross: 0, net: 0, oasdi: 0 };
    if (cat(p.code) === 'Earning') x.gross += Number(p.amount || 0);
    if (p.code === 'NET_PAY') x.net += Number(p.amount || 0);
    if (p.code === 'OASDI_EE') x.oasdi += Number(p.amount || 0);
    prior.set(p.worker_id, x);
  }
  const usWorkers = R.register.filter(r => r.bucket !== 'Excluded');
  const flagged = new Set(A.findings.map(f => f.workerId));
  const unflagged = usWorkers.filter(r => !flagged.has(r.workerId)).map(r => {
    const p = prior.get(r.workerId);
    const oasdiNow = r.lines.find(l => l.code === 'OASDI_EE')?.amount ?? 0;
    const reason = p && p.oasdi > 0.004 && oasdiNow < p.oasdi - 0.004 ? `Social Security wage base met in the prior period (OASDI ${fmtMoney(p.oasdi)} → ${fmtMoney(oasdiNow)})` : 'Below audit thresholds';
    return { id: r.workerId, payGroup: r.payGroup, costCenter: r.costCenter, priorGross: p?.gross ?? 0, gross: r.gross, priorNet: p?.net ?? 0, net: r.net, reason };
  });
  const same = (x: { priorGross: number; gross: number; priorNet: number; net: number }) => Math.abs(x.priorGross - x.gross) < 0.01 && Math.abs(x.priorNet - x.net) < 0.01;
  const noChange = unflagged.filter(same);
  const minor = unflagged.filter(x => !same(x));
  return h('div', null,
    section('Pre-payroll audit (AI)', 'Before approving a US pay run: roll the headcount forward from last period and confirm who is paid, review every exception against the prior period, then generate commentary with AI under strict guardrails. Rules find the issues; AI only writes the summary; a person clears each finding.'),
    rollForwardCard(A.rollForward),
    h('div', { class: 'kpis' },
      kpi('Total workers', String(usWorkers.length), `US Semi-monthly ${usWorkers.filter(r => r.payGroup === 'US Semi-monthly').length} · US Biweekly ${usWorkers.filter(r => r.payGroup === 'US Biweekly').length}`),
      kpi('Workers with findings', String(flagged.size), `${A.findings.length} findings in total`),
      kpi('No change', String(noChange.length), 'Same gross and net as prior period, no findings'),
      minor.length ? kpi('Change below thresholds', String(minor.length), 'Net moved, explained, under audit thresholds') : null,
      kpi('Findings', String(A.findings.length), A.summary),
      kpi('High', String(A.findings.filter(f => f.severity === 'High').length), '', 'warn'),
      kpi('Medium', String(A.findings.filter(f => f.severity === 'Medium').length)),
      kpi('Low', String(A.findings.filter(f => f.severity === 'Low').length)),
    ),
    h('details', { class: 'card collapsible' }, h('summary', null, h('h3', null, `No change (${noChange.length} workers)`)),
      h('div', { class: 'collapsible-body' }, h('p', { class: 'muted' }, 'No findings: gross and net pay are the same as the prior period.'),
        table(noChange, [
          { key: 'id', label: 'Worker' }, { key: 'payGroup', label: 'Pay group' }, { key: 'costCenter', label: 'Cost center' },
          { key: 'priorGross', label: 'Prior gross', align: 'right', render: x => fmtMoney(x.priorGross) },
          { key: 'gross', label: 'Current gross', align: 'right', render: x => fmtMoney(x.gross) },
          { key: 'diff', label: 'Difference', align: 'right', value: x => x.gross - x.priorGross, render: x => (Math.abs(x.gross - x.priorGross) < 0.01 ? badge('Same', 'ok') : fmtMoney(x.gross - x.priorGross)) },
          { key: 'priorNet', label: 'Prior net', align: 'right', render: x => fmtMoney(x.priorNet) },
          { key: 'net', label: 'Current net', align: 'right', render: x => fmtMoney(x.net) },
        ], { csvName: 'audit-no-change.csv', pageSize: 50, onRow: x => go('payslip', x.id) }))),
    minor.length ? h('details', { class: 'card collapsible' }, h('summary', null, h('h3', null, `Change below thresholds (${minor.length} workers)`)),
      h('div', { class: 'collapsible-body' }, table(minor, [
        { key: 'id', label: 'Worker' }, { key: 'payGroup', label: 'Pay group' },
        { key: 'priorGross', label: 'Prior gross', align: 'right', render: x => fmtMoney(x.priorGross) },
        { key: 'gross', label: 'Current gross', align: 'right', render: x => fmtMoney(x.gross) },
        { key: 'priorNet', label: 'Prior net', align: 'right', render: x => fmtMoney(x.priorNet) },
        { key: 'net', label: 'Current net', align: 'right', render: x => fmtMoney(x.net) },
        { key: 'reason', label: 'Why', render: x => h('span', { class: 'small' }, x.reason) },
      ], { search: false, pageSize: 30, onRow: x => go('payslip', x.id) }))) : null,
    card('Checks', table(A.checks, [{ key: 'check', label: 'Check' }, { key: 'name', label: 'Rule' }, { key: 'count', label: 'Findings', align: 'right' }], { search: false, pageSize: 20, onRow: c => { check = check === c.check ? '' : c.check; drawList(); } })),
    card('Findings',
      h('div', { class: 'row' },
        h('label', { class: 'filter' }, h('span', null, 'Severity'), h('select', { onChange: (e: Event) => { sev = (e.target as HTMLSelectElement).value; drawList(); } }, ['', 'High', 'Medium', 'Low'].map(s => h('option', { value: s }, s || 'All')))),
        h('label', { class: 'filter' }, h('span', null, 'Resolution'), h('select', { onChange: (e: Event) => { resFilter = (e.target as HTMLSelectElement).value; drawList(); } }, ['', 'Open', 'Resolved'].map(s => h('option', { value: s }, s || 'All')))),
        countBox,
        h('span', { class: 'muted small' }, 'Click a check above to filter by it.')),
      listBox),
    card('AI commentary for the Payroll Manager and Controller',
      h('p', null, 'Summarizes the headcount roll-forward and the findings. With ANTHROPIC_API_KEY set on the server it uses Claude; otherwise a deterministic template runs through the same guardrails.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onClick: generate }, 'Generate commentary')),
      out,
      collapsible(`What is sent to the model (${built.payload.findings.length} findings, ${built.map.toToken.size} workers as tokens)`, false,
        h('p', { class: 'small muted' }, 'Built field by field from an allow-list. Worker IDs are replaced with tokens; the token map never leaves this browser. The server rejects any other field and any real worker ID.'),
        h('pre', { class: 'small' }, JSON.stringify({ ...built.payload, findings: built.payload.findings.slice(0, 5), '…': `${Math.max(0, built.payload.findings.length - 5)} more findings` }, null, 2))),
      h('details', null, h('summary', null, 'Guardrails for HR and payroll data'), h('ul', null,
        h('li', null, h('strong', null, 'Minimum data, allow-listed: '), 'only check, rule, severity, pay group, amounts and headcount counts are sent. No names, birth dates, addresses, bank or tax IDs, and no free-text notes.'),
        h('li', null, h('strong', null, 'Pseudonymized: '), 'worker IDs become tokens (W001…) before sending and are mapped back only in the browser.'),
        h('li', null, h('strong', null, 'Checked on the server: '), 'api/explain rejects any field outside the schema and any real worker ID; the API key stays on the server.'),
        h('li', null, h('strong', null, 'Verified on return: '), 'every worker token and number in the reply must exist in the payload; anything else is flagged Unverified.'),
        h('li', null, h('strong', null, 'Advisory only: '), 'the AI cannot change amounts or clear findings. A Payroll Partner resolves each finding; the Payroll Manager approves the run.'),
        h('li', null, h('strong', null, 'Logged and retained safely: '), 'every prompt and reply is logged for audit; in production use a zero-data-retention API agreement with no training on customer data, and restrict the feature to the payroll security group.'),
      ))),
    card('AI prompt and response log', logBox),
  );
}

// ------------------------------------------------------------------ headcount roll-forward

function rollForwardCard(rfs: RollForward[]): HTMLElement {
  const open = new Set<string>();
  const body = h('div');
  const draw = () => {
    clear(body).append(h('div', { class: 'grid2' }, ...rfs.map(rf => {
      const row = (l: RollLine, pg: string) => {
        const key = `${pg}|${l.key}`;
        const total = l.sign === '' && l.key === 'opening' || l.sign === '=';
        const clickable = l.workers.length > 0;
        const tr = h('tr', { class: total ? 'rf-total' : '', style: { cursor: clickable ? 'pointer' : 'default' }, onClick: () => { if (!clickable) return; if (open.has(key)) open.delete(key); else open.add(key); draw(); } },
          h('td', { class: 'rf-sign' }, l.sign === '=' ? '' : l.sign),
          h('td', null, l.label, clickable ? h('span', { class: 'muted small' }, open.has(key) ? '  ▾' : '  ▸') : null),
          h('td', { class: 'num' }, String(l.count)));
        const detail = open.has(key) ? h('tr', null, h('td', null), h('td', { colSpan: 2 }, h('div', { class: 'rf-workers' }, ...l.workers.map(w => h('div', null, h('a', { href: `#/payslip/${w.id}` }, w.id), ` ${displayName(w.id)} · `, h('span', { class: 'muted' }, w.reason)))))) : null;
        return [tr, detail];
      };
      return h('div', { class: 'card' },
        h('div', { class: 'subhead' }, h('h3', null, rf.payGroup), rf.ties ? badge(`Ties to register · ${rf.registerPaid} paid`, 'ok') : badge(`Does not tie: expected ${rf.expectedPaid}, register ${rf.registerPaid}`, 'bad')),
        h('table', { class: 'rf' }, h('tbody', null, ...rf.lines.flatMap(l => row(l, rf.payGroup)))),
        rf.watch.length ? h('div', null, h('h4', null, 'Paid, but check'),
          h('table', { class: 'rf' }, h('tbody', null, ...rf.watch.flatMap(l => row(l, rf.payGroup))))) : null);
    })));
  };
  draw();
  return card('Headcount roll-forward: who should be paid on this run', h('p', { class: 'muted small' }, "Last period's pay run, plus joiners, less leavers, gives this run's headcount; less active workers who are not paid gives the number to pay, which must equal the paid count on the register. Click a line to see the workers."), body);
}

function verifyBadge(v: Verification): HTMLElement {
  return v.status === 'verified' ? badge('Verified against the data', 'ok') : badge('Unverified content — review before use', 'warn');
}
function verifyDetail(v: Verification): HTMLElement {
  const items = [
    `${v.tokens.known.length} worker references matched the payload${v.tokens.unknown.length ? `; unknown: ${v.tokens.unknown.join(', ')}` : ''}`,
    `${v.numbers.verified} numbers matched the payload${v.numbers.unverified.length ? `; not in the data: ${v.numbers.unverified.join(', ')}` : ''}`,
    v.realIds.length ? `Real worker IDs in the reply: ${v.realIds.join(', ')} (should never happen)` : 'No real worker IDs in the reply',
  ];
  return h('ul', { class: 'small verify' }, items.map(i => h('li', null, i)));
}
