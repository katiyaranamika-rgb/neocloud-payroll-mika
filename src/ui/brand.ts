// NeoCloud brand: logo, company details, menu icons, derived worker names.

export const COMPANY = {
  name: 'NeoCloud Inc.',
  address1: '123 Main Street',
  address2: 'San Jose, CA 95032',
  product: 'NeoCloud Payroll',
};

/** Original NeoCloud mark: a cloud outline with an "N", indigo tile. */
export function logo(size = 36): HTMLElement {
  const span = document.createElement('span');
  span.className = 'brand-logo';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="NeoCloud logo"><rect width="40" height="40" rx="9" fill="#26215C"/><path d="M11 27h17a6 6 0 0 0 .6-11.97A8 8 0 0 0 13.3 17 5 5 0 0 0 11 27z" fill="none" stroke="#5DCAA5" stroke-width="2"/><path d="M16 24v-7l6 7v-7" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return span;
}

/** Derived display name: E0001 → "Employee 001", C0012 → "Contractor 012". */
export function displayName(id: string): string {
  const m = id.match(/^([EC])0*(\d+)$/);
  if (!m) return id;
  return `${m[1] === 'E' ? 'Employee' : 'Contractor'} ${m[2].padStart(3, '0')}`;
}

// Simple stroke icons (24×24 grid), drawn for this app.
const ICONS: Record<string, string> = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  payruns: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18.5 14.8c1.6.8 2.6 2.5 3 5.2"/>',
  register: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  results: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  payslip: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h6M9 16h4"/>',
  timecards: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  absence: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  intl: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  recon: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
  gl: '<path d="M4 4h16v16H4z"/><path d="M4 10h16M10 4v16"/>',
  audit: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/><path d="M8.5 11l1.8 1.8 3.2-3.6"/>',
  controls: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.4 2.4 4.6-4.8"/>',
  export: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 15v5h16v-5"/>',
  import: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  mapping: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5"/><path d="M6 8.5V14a4 4 0 0 0 4 4h5.5"/>',
  data: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  rules: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};

export function icon(name: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'nav-icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return span;
}
