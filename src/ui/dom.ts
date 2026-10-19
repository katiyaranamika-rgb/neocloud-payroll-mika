// Tiny DOM toolkit: element builder, formatters, sortable/filterable table, bar chart.
// No framework: the UI re-renders a view by replacing its container's children.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

export function h(tag: string, attrs: Attrs | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement): HTMLElement {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const fmtMoney = (n: number | null | undefined, cur = 'USD', dp = 2): string => {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const sym: Record<string, string> = { USD: '$', GBP: '£', CAD: 'C$', INR: '₹' };
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${n < 0 ? '−' : ''}${sym[cur] ?? ''}${s}`;
};
export const fmtNum = (n: number | null | undefined, dp = 2): string =>
  n === null || n === undefined || Number.isNaN(n) ? '–' : n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmtCompact = (n: number, cur = 'USD'): string => {
  const sym: Record<string, string> = { USD: '$', GBP: '£', CAD: 'C$', INR: '₹' };
  const a = Math.abs(n);
  const s = a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0);
  return `${n < 0 ? '−' : ''}${sym[cur] ?? ''}${s}`;
};

export function badge(text: string, tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted' = 'info'): HTMLElement {
  return h('span', { class: `badge ${tone}` }, text);
}

export function kpi(label: string, value: string, sub?: string, tone?: string): HTMLElement {
  return h('div', { class: `kpi ${tone ?? ''}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null);
}

export function card(title: string | null, ...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, title ? h('h3', null, title) : null, ...children);
}

/** Card that collapses/expands by clicking its title (native <details>). */
export function collapsible(title: string, open: boolean, ...children: Child[]): HTMLElement {
  return h('details', { class: 'card collapsible', open }, h('summary', null, h('h3', null, title)), h('div', { class: 'collapsible-body' }, ...children));
}

export function section(title: string, lead?: string, ...children: Child[]): HTMLElement {
  return h('div', { class: 'view-head' }, h('h2', null, title), lead ? h('p', { class: 'lead' }, lead) : null, ...children);
}

export interface Col<T> {
  key: string; label: string; align?: 'right' | 'left' | 'center';
  value?: (r: T) => unknown; render?: (r: T) => Child; csv?: (r: T) => unknown; width?: string;
}

export function download(name: string, text: string, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Sortable, searchable table with paging and CSV download. */
export function table<T>(rows: T[], cols: Col<T>[], opts: { pageSize?: number; csvName?: string; onRow?: (r: T) => void; search?: boolean; empty?: string; rowClass?: (r: T) => string } = {}): HTMLElement {
  const pageSize = opts.pageSize ?? 50;
  let sortKey = '';
  let asc = true;
  let q = '';
  let showAll = false;
  const wrap = h('div', { class: 'table-wrap' });
  const val = (r: T, c: Col<T>) => (c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]);
  const render = () => {
    clear(wrap);
    let data = rows;
    if (q) {
      const ql = q.toLowerCase();
      data = data.filter(r => cols.some(c => String(val(r, c) ?? '').toLowerCase().includes(ql)));
    }
    if (sortKey) {
      const c = cols.find(c => c.key === sortKey)!;
      data = [...data].sort((a, b) => {
        const x = val(a, c); const y = val(b, c);
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
        return asc ? cmp : -cmp;
      });
    }
    const tools = h('div', { class: 'table-tools' },
      opts.search !== false ? h('input', { type: 'search', placeholder: 'Search…', value: q, onInput: (e: Event) => { q = (e.target as HTMLInputElement).value; render(); (wrap.querySelector('input[type=search]') as HTMLInputElement)?.focus(); } }) : null,
      h('span', { class: 'muted' }, `${data.length.toLocaleString()} row${data.length === 1 ? '' : 's'}`),
      opts.csvName ? h('button', { class: 'btn ghost sm', onClick: () => {
        const head = cols.map(c => csvEscape(c.label)).join(',');
        const body = data.map(r => cols.map(c => csvEscape(c.csv ? c.csv(r) : val(r, c))).join(',')).join('\n');
        download(opts.csvName!, head + '\n' + body + '\n');
      } }, 'Download CSV') : null,
    );
    const shown = showAll ? data : data.slice(0, pageSize);
    const t = h('table', { class: 'grid' },
      h('thead', null, h('tr', null, cols.map(c => h('th', { class: c.align ?? '', style: c.width ? { width: c.width } : undefined, onClick: () => { asc = sortKey === c.key ? !asc : true; sortKey = c.key; render(); } }, c.label, sortKey === c.key ? (asc ? ' ▲' : ' ▼') : '')))),
      h('tbody', null, shown.length ? shown.map(r => h('tr', { class: `${opts.onRow ? 'clickable' : ''} ${opts.rowClass ? opts.rowClass(r) : ''}`, onClick: opts.onRow ? () => opts.onRow!(r) : undefined },
        cols.map(c => {
          const v = c.render ? c.render(r) : val(r, c);
          return h('td', { class: c.align ?? '' }, v as Child);
        }))) : h('tr', null, h('td', { colspan: cols.length, class: 'muted center' }, opts.empty ?? 'No rows'))),
    );
    wrap.append(tools, h('div', { class: 'table-scroll' }, t));
    if (data.length > pageSize) {
      wrap.append(h('div', { class: 'table-more' }, h('button', { class: 'btn ghost sm', onClick: () => { showAll = !showAll; render(); } }, showAll ? `Show first ${pageSize}` : `Show all ${data.length}`)));
    }
  };
  render();
  return wrap;
}

/** Horizontal bar chart (inline SVG, themed via CSS variables). */
export function barChart(items: { label: string; value: number; sub?: string }[], fmt: (n: number) => string): HTMLElement {
  const max = Math.max(1, ...items.map(i => i.value));
  return h('div', { class: 'bars' }, items.map(i => h('div', { class: 'bar-row' },
    h('div', { class: 'bar-label', title: i.label }, i.label),
    h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${Math.max(0.5, (i.value / max) * 100)}%` } })),
    h('div', { class: 'bar-value' }, fmt(i.value), i.sub ? h('span', { class: 'muted' }, ` ${i.sub}`) : null),
  )));
}

export function tabs(items: { id: string; label: string; render: () => HTMLElement }[], initial?: string): HTMLElement {
  let active = initial ?? items[0].id;
  const wrap = h('div', { class: 'tabs-wrap' });
  const draw = () => {
    clear(wrap);
    wrap.append(
      h('div', { class: 'tabs' }, items.map(i => h('button', { class: `tab ${i.id === active ? 'active' : ''}`, onClick: () => { active = i.id; draw(); } }, i.label))),
      items.find(i => i.id === active)!.render(),
    );
  };
  draw();
  return wrap;
}

// Hover tooltip with a list (fixed position, so it is not clipped by scrolling tables).
let tipEl: HTMLElement | null = null;
export function withTip(trigger: HTMLElement, title: string, items: string[]): HTMLElement {
  const show = (e: MouseEvent) => {
    tipEl?.remove();
    tipEl = h('div', { class: 'hover-tip', role: 'tooltip' }, h('strong', null, title), h('ul', null, items.map(i => h('li', null, i))));
    document.body.appendChild(tipEl);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = tipEl.offsetWidth || 360;
    tipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    const below = r.bottom + 6; const hgt = tipEl.offsetHeight || 0;
    tipEl.style.top = `${below + hgt > window.innerHeight - 8 ? Math.max(8, r.top - hgt - 6) : below}px`;
  };
  const hide = () => { tipEl?.remove(); tipEl = null; };
  trigger.addEventListener('mouseenter', show as EventListener);
  trigger.addEventListener('mouseleave', hide);
  trigger.addEventListener('click', (e: Event) => e.stopPropagation()); // don't open the row on click
  trigger.classList.add('has-tip');
  trigger.setAttribute('aria-label', `${title}: ${items.join('; ')}`);
  trigger.tabIndex = 0;
  trigger.addEventListener('focus', () => show({ currentTarget: trigger } as unknown as MouseEvent));
  trigger.addEventListener('blur', hide);
  return trigger;
}
