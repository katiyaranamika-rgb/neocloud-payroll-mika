// Entry point: load data, run the period, render the shell and route between views.

import { h, clear, badge } from './dom.ts';
import { state, loadBaseline, initState, hasEdits, resetEdits } from './state.ts';
import { viewDashboard, viewPayRuns, viewRegister, viewPayslip } from './views-pay.ts';
import { viewTime, viewAbsence } from './views-time.ts';
import { viewRecon, viewIntl, viewControls } from './views-fin.ts';
import { viewAudit } from './views-audit.ts';
import { viewData, viewRules } from './views-data.ts';
import { viewResults } from './views-results.ts';
import { logo, icon } from './brand.ts';
import { viewExport, viewMapping } from './views-prism.ts';
import { setRefresh } from './router.ts';

export interface Route { id: string; label: string; group: string; render: (arg?: string) => HTMLElement; hidden?: boolean }

export const ROUTES: Route[] = [
  { id: 'dashboard', label: 'Dashboard', group: 'Run', render: viewDashboard },
  { id: 'payruns', label: 'Pay runs & headcount', group: 'Run', render: viewPayRuns },
  { id: 'register', label: 'Payroll register', group: 'US payroll', render: viewRegister },
  { id: 'results', label: 'Payroll results', group: 'US payroll', render: viewResults },
  { id: 'payslip', label: 'Payslip', group: 'US payroll', render: viewPayslip },
  { id: 'timecards', label: 'Time cards', group: 'US payroll', render: viewTime },
  // Time results now live under Payroll results (tab). Old #/time/<id> links still work.
  { id: 'time', label: 'Time results', group: 'US payroll', render: (arg?: string) => viewResults(arg, 'timeres'), hidden: true },
  { id: 'punches', label: 'Time cards (worker)', group: 'US payroll', render: (arg?: string) => viewResults(arg, 'cards'), hidden: true },
  { id: 'absence', label: 'Absence & payouts', group: 'All countries', render: viewAbsence },
  { id: 'intl', label: 'International', group: 'All countries', render: viewIntl },
  { id: 'audit', label: 'Pre-payroll audit (AI)', group: 'Close', render: viewAudit },
  { id: 'controls', label: 'Controls & clean close', group: 'Close', render: viewControls },
  { id: 'export', label: 'Export payroll journal', group: 'Close', render: viewExport },
  { id: 'recon', label: 'Payroll parallel test', group: 'Test', render: viewRecon },
  { id: 'data', label: 'Edit data & re-run', group: 'Setup', render: viewData },
  { id: 'mapping', label: 'GL mapping', group: 'Setup', render: viewMapping },
  { id: 'rules', label: 'Rules & pay codes', group: 'Setup', render: viewRules },
];

let main: HTMLElement;
let topbar: HTMLElement;
let nav: HTMLElement;

function refresh() {
  renderTopbar();
  renderRoute();
}

function parseHash(): [string, string | undefined] {
  const m = location.hash.match(/^#\/([^/]+)(?:\/(.+))?/);
  return m ? [m[1], m[2] ? decodeURIComponent(m[2]) : undefined] : ['dashboard', undefined];
}

function renderRoute() {
  const [id, arg] = parseHash();
  const route = ROUTES.find(r => r.id === id) ?? ROUTES[0];
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a.getAttribute('data-id') === (route.hidden ? 'results' : route.id));
  clear(main);
  try {
    main.append(route.render(arg));
  } catch (e) {
    console.error(e);
    main.append(h('div', { class: 'card error' }, h('h3', null, 'This view failed to render'), h('pre', null, String((e as Error).stack ?? e))));
  }
  main.scrollTop = 0;
}

function renderTopbar() {
  clear(topbar);
  const depts = [...new Set(state.result.model.workers.map(w => w.costCenter).filter(Boolean))].sort();
  const locs = [...new Set(state.result.model.workers.map(w => w.location).filter(Boolean))].sort();
  const sel = (label: string, value: string, options: string[], onChange: (v: string) => void) =>
    h('label', { class: 'filter' }, h('span', null, label), h('select', { onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
      h('option', { value: '' }, 'All'), options.map(o => h('option', { value: o, selected: o === value }, o))));
  topbar.append(
    h('div', { class: 'period' }, h('strong', null, 'Period'), ' US Semi-monthly Oct 16–31 · US Biweekly Oct 4–17 · UK/IN/CA Oct 1–31'),
    h('div', { class: 'filters' },
      sel('Pay group', state.filters.payGroup, [...state.result.model.schedules.keys()], v => { state.filters.payGroup = v; refresh(); }),
      sel('Department', state.filters.dept, depts, v => { state.filters.dept = v; refresh(); }),
      sel('Location', state.filters.location, locs, v => { state.filters.location = v; refresh(); }),
    ),
    h('div', { class: 'runinfo' },
      hasEdits() ? badge(`What-if: ${state.editedFiles.length + state.uploadedFiles.filter(f => !state.editedFiles.includes(f as never)).length} file(s) edited`, 'warn') : badge('Original data', 'ok'),
      h('span', { class: 'muted' }, ` Ran ${state.ranAt} in ${state.runMs.toFixed(0)} ms `),
      hasEdits() ? h('button', { class: 'btn ghost sm', onClick: () => { if (confirm('Discard all edits and return to the original data?')) { resetEdits(); refresh(); } } }, 'Reset to original') : null,
    ),
  );
}

async function boot() {
  const root = document.getElementById('app')!;
  root.append(h('div', { class: 'loading' }, 'Loading data and running the period…'));
  try {
    const ds = await loadBaseline();
    initState(ds);
  } catch (e) {
    clear(root).append(h('div', { class: 'card error' }, h('h3', null, 'Could not load data'), h('pre', null, String(e))));
    return;
  }
  clear(root);
  nav = h('nav', { class: 'sidebar' },
    h('div', { class: 'brand' }, logo(34), h('div', null, h('div', { class: 'brand-name' }, 'NeoCloud'), h('div', { class: 'brand-sub' }, 'Payroll · Oct 2026'))),
    ...[...new Set(ROUTES.filter(r => !r.hidden).map(r => r.group))].map(g => h('div', { class: 'nav-group' }, h('div', { class: 'nav-title' }, g),
      ROUTES.filter(r => r.group === g && !r.hidden).map(r => h('a', { href: `#/${r.id}`, 'data-id': r.id }, icon(r.id), h('span', null, r.label))))),
    h('div', { class: 'nav-foot muted' }, 'Synthetic data · calculations run in your browser'),
  );
  topbar = h('header', { class: 'topbar' });
  main = h('main', { class: 'main' });
  root.append(nav, h('div', { class: 'content' }, topbar, main));
  window.addEventListener('hashchange', renderRoute);
  setRefresh(refresh);
  refresh();
}

boot();
