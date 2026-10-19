// Payroll status grid for the dashboard: one row per pay group, one column per stage.
// Clicking a stage shows a stage-level note (no employee detail) and, where it applies,
// the action that completes it (sign off, close period) or a link to resolve items.

import { h, badge, clear } from './dom.ts';
import { state, getActions, signOff, closePeriod, resetActions, hasActions } from './state.ts';
import { refresh } from './router.ts';
import { payrollStatus, STAGES } from '../engine/status.ts';
import type { PayGroupStatus, Stage } from '../engine/status.ts';

const today = () => new Date().toISOString().slice(0, 10);
let asOf = (() => { const t = today(); return t < '2026-10-01' || t > '2026-11-06' ? '2026-10-18' : t; })();
let selected: { pg: string; i: number } | null = null;

const short = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const long = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const stateClass = (s: Stage) => ({ Done: 'done', 'In progress': 'prog', 'At risk': 'risk', Late: 'late', 'Not started': 'todo' }[s.state]);
const overallTone = (o: string) => (o === 'Closed' ? 'ok' : o === 'On track' ? 'info' : o === 'At risk' ? 'warn' : 'bad');

export function statusAsOf(): string { return asOf; }

export function statusGrid(): HTMLElement {
  const wrap = h('section', { class: 'card status-panel' });
  const draw = () => {
    const rows = payrollStatus(state.result, asOf, getActions());
    const sel = selected ? rows.find(r => r.payGroup === selected!.pg) : undefined;
    clear(wrap).append(h('div', null,
      h('div', { class: 'subhead' },
        h('div', null, h('h3', null, 'Payroll status by pay group'), h('div', { class: 'muted small' }, `As of ${long(asOf)} · click a stage for details`)),
        h('div', { class: 'row tight' },
          h('label', { class: 'filter' }, h('span', null, 'Status as of'),
            h('input', { type: 'date', value: asOf, min: '2026-10-01', max: '2026-11-06', onChange: (e: Event) => { asOf = (e.target as HTMLInputElement).value || asOf; draw(); } })),
          h('button', { class: 'btn ghost sm', onClick: () => { asOf = today(); draw(); } }, 'Today'),
          hasActions() ? h('button', { class: 'btn ghost sm', title: 'Clears resolved items, sign-offs, closes and NetSuite transmissions saved in this browser', onClick: () => { if (confirm('Clear all resolved items, sign-offs and period closes?')) { resetActions(); selected = null; refresh(); } } }, 'Reset workflow') : null)),
      h('div', { class: 'table-scroll' }, h('table', { class: 'grid status-grid-table' },
        h('thead', null, h('tr', null, h('th', null, 'Pay group'), STAGES.map((s, i) => h('th', { class: 'center' }, h('span', { class: 'stage-no' }, String(i + 1)), ' ', s.replace('Payroll ', '').replace(/^./, c => c.toUpperCase()))), h('th', { class: 'center' }, 'Overall'))),
        h('tbody', null, rows.map(r => h('tr', null,
          h('td', { class: 'pg-cell' }, h('div', { class: 'pg-name' }, r.payGroup), h('div', { class: 'muted small' }, `${short(r.period.slice(0, 10))}–${short(r.period.slice(-10))} · pay ${short(r.payDate)} · ${r.headcount} worker${r.headcount === 1 ? '' : 's'}`)),
          r.stages.map(s => h('td', { class: 'center' },
            h('button', { class: `stage-cell ${stateClass(s)} ${selected && selected.pg === r.payGroup && selected.i === s.index ? 'sel' : ''}`, title: `${s.name}: ${s.state}`, onClick: () => { selected = selected && selected.pg === r.payGroup && selected.i === s.index ? null : { pg: r.payGroup, i: s.index }; draw(); } },
              h('span', { class: 'stage-dot' }, s.state === 'Done' ? '✓' : s.state === 'Late' || s.state === 'At risk' ? '!' : String(s.index + 1)),
              h('span', { class: 'stage-date' }, short(s.due))))),
          h('td', { class: 'center' }, badge(r.overall, overallTone(r.overall)))))))),
      h('div', { class: 'legend small' },
        ...(['done', 'prog', 'risk', 'late', 'todo'] as const).map((c, i) => h('span', null, h('span', { class: `legend-dot ${c}` }), ['Done', 'In progress', 'At risk', 'Late', 'Not started'][i])),
        h('span', { class: 'muted' }, 'Date = stage due date')),
      sel ? detail(sel, sel.stages[selected!.i], draw) : null,
    ));
  };
  draw();
  return wrap;
}

function detail(r: PayGroupStatus, s: Stage, redraw: () => void): HTMLElement {
  const isUs = r.payGroup.startsWith('US');
  const act = getActions();
  let action: HTMLElement | null = null;
  if (s.action === 'signoff') {
    const done = act.signoff[r.payGroup];
    action = done ? h('p', null, badge('Signed off', 'ok'), ` by ${done.by} · ${done.at}`)
      : h('div', null, h('button', { class: 'btn', disabled: !s.actionEnabled, onClick: () => { const by = prompt('Signed off by', 'Payroll Manager'); if (by) { signOff(r.payGroup, by); refresh(); } } }, 'Sign off payroll'),
        s.actionEnabled ? null : h('span', { class: 'muted small' }, ' Available once payroll audits are complete.'));
  } else if (s.action === 'close') {
    const done = act.close[r.payGroup];
    action = done ? h('p', null, badge('Closed', 'ok'), ` by ${done.by} · ${done.at}`)
      : h('div', null, h('button', { class: 'btn', disabled: !s.actionEnabled, onClick: () => { const by = prompt('Closed by', 'Controller'); if (by) { closePeriod(r.payGroup, by); refresh(); } } }, 'Close period'),
        s.actionEnabled ? null : h('span', { class: 'muted small' }, ' Available once settlement is done and the GL checks pass.'));
  } else if (s.action === 'resolve' && s.items.length) {
    action = h('p', null, h('a', { href: isUs ? '#/audit' : '#/intl' }, isUs ? 'Resolve findings on the Pre-payroll audit (AI) screen →' : 'Resolve provider variances on the International screen →'));
  } else if (r.payGroup === 'US Biweekly' && s.index === 0 && s.items.length) {
    action = h('p', null, h('a', { href: '#/time' }, 'Review time on the Time results screen →'));
  }
  return h('div', { class: 'stage-detail' },
    h('div', { class: 'subhead' },
      h('div', null, h('div', { class: 'muted small' }, r.payGroup), h('h3', null, `${s.index + 1} · ${s.name}`)),
      h('span', { class: `state-pill ${stateClass(s)}` }, s.state)),
    h('div', { class: 'detail-grid small' },
      h('div', null, h('span', { class: 'muted' }, 'Due '), long(s.due)),
      h('div', null, h('span', { class: 'muted' }, 'Owner '), s.owner),
      h('div', null, h('span', { class: 'muted' }, 'Rule '), s.passes ? 'met' : 'not met yet')),
    h('p', { class: 'small' }, s.note),
    s.items.length ? h('ul', { class: 'issues small' }, s.items.map(i => h('li', null, i))) : h('p', { class: 'small muted' }, 'No open items.'),
    action,
    h('button', { class: 'btn ghost xs', onClick: () => { selected = null; redraw(); } }, 'Close details'),
  );
}
