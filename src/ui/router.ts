// Navigation helpers shared by views (kept separate from app.ts to avoid an import cycle).

let refreshFn: () => void = () => {};

export function setRefresh(fn: () => void) { refreshFn = fn; }

export function refresh() { refreshFn(); }

export function go(id: string, arg?: string) {
  location.hash = arg ? `#/${id}/${encodeURIComponent(arg)}` : `#/${id}`;
}
