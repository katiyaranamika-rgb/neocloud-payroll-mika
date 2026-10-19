// App state: baseline data (as shipped), viewer edits (browser only), and run results.

import type { DataSet, RegisterRow } from '../engine/types.ts';
import type { RunResult } from '../engine/run.ts';
import type { StageActions } from '../engine/status.ts';
import { runAll } from '../engine/run.ts';
import { parseCsv } from '../engine/csv.ts';
import type { Row } from '../engine/csv.ts';
import { DATA_FILES, EDITABLE_FILES } from '../engine/files.ts';

export type EditableFile = typeof EDITABLE_FILES[number];

export interface AppState {
  baseline: DataSet;
  current: DataSet;
  base: RunResult;
  result: RunResult;
  filters: { dept: string; location: string; payGroup: string };
  editedFiles: EditableFile[];
  uploadedFiles: string[];
  ranAt: string;
  runMs: number;
}

const KEY = 'neocloud-payroll.edits.v1';

function safeGet(): Record<string, Row[]> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function safeSet(v: Record<string, Row[]>) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable: edits live for this session only */ }
}

let memEdits: Record<string, Row[]> = {};
let baseMs = 0;

export async function loadBaseline(): Promise<DataSet> {
  const ds: Record<string, unknown> = {};
  // The build embeds the /data CSVs into data.bundle.js so the app also works offline / from
  // a single file. Without it, the CSVs are fetched from /data.
  const embedded = (globalThis as unknown as { __NEOCLOUD_DATA__?: Record<string, string> }).__NEOCLOUD_DATA__;
  if (embedded) {
    for (const name of DATA_FILES) ds[name] = embedded[name] ? parseCsv(embedded[name]) : [];
    ds.rules = JSON.parse(embedded.rules);
    return ds as unknown as DataSet;
  }
  await Promise.all(DATA_FILES.map(async name => {
    const res = await fetch(`data/${name}.csv`);
    ds[name] = res.ok ? parseCsv(await res.text()) : [];
  }));
  ds.rules = await (await fetch('data/rules.json')).json();
  return ds as unknown as DataSet;
}

export const state = {} as AppState;

export function initState(baseline: DataSet) {
  memEdits = safeGet();
  state.baseline = baseline;
  state.filters = { dept: '', location: '', payGroup: '' };
  state.uploadedFiles = [];
  const t0 = performance.now();
  state.base = runAll(baseline);
  baseMs = performance.now() - t0;
  rerun();
}

export function currentDataSet(): DataSet {
  const ds: DataSet = { ...state.baseline };
  for (const [k, rows] of Object.entries(memEdits)) (ds as unknown as Record<string, Row[]>)[k] = rows;
  return ds;
}

export function rerun() {
  state.current = currentDataSet();
  const t0 = performance.now();
  state.result = Object.keys(memEdits).length ? runAll(state.current) : state.base;
  state.runMs = Object.keys(memEdits).length ? performance.now() - t0 : baseMs;
  state.editedFiles = Object.keys(memEdits).filter(k => (EDITABLE_FILES as readonly string[]).includes(k)) as EditableFile[];
  state.ranAt = new Date().toLocaleTimeString();
}

export function saveEdits(file: string, rows: Row[]) {
  memEdits[file] = rows;
  safeSet(memEdits);
  rerun();
}

/** Replace any data file with an uploaded CSV (session only; not persisted). */
export function uploadFile(file: string, text: string) {
  memEdits[file] = parseCsv(text);
  if ((EDITABLE_FILES as readonly string[]).includes(file)) safeSet(memEdits);
  if (!state.uploadedFiles.includes(file)) state.uploadedFiles.push(file);
  rerun();
}

export function resetEdits(file?: string) {
  if (file) delete memEdits[file]; else memEdits = {};
  safeSet(memEdits);
  state.uploadedFiles = file ? state.uploadedFiles.filter(f => f !== file) : [];
  rerun();
}

export function hasEdits(): boolean { return Object.keys(memEdits).length > 0; }

export function rowsFor(file: string): Row[] {
  return (state.current as unknown as Record<string, Row[]>)[file] ?? [];
}

/** Global department / location filter for rollups. */
export function passes(r: { costCenter?: string; dept?: string; location?: string; payGroup?: string }): boolean {
  const f = state.filters;
  if (f.payGroup && r.payGroup !== undefined && r.payGroup !== f.payGroup) return false;
  if (f.dept && (r.costCenter ?? r.dept) !== f.dept) return false;
  if (f.location && r.location !== f.location) return false;
  return true;
}

export function filteredRegister(): RegisterRow[] {
  return state.result.register.filter(passes);
}

// ---- Workflow actions (resolve finding, sign off, close period) — saved in this browser ----

const ACT_KEY = 'neocloud-payroll.actions.v1';
let actions: StageActions = (() => {
  try { return { resolved: {}, signoff: {}, close: {}, ...JSON.parse(localStorage.getItem(ACT_KEY) || '{}') }; } catch { return { resolved: {}, signoff: {}, close: {} }; }
})();
const saveActions = () => { try { localStorage.setItem(ACT_KEY, JSON.stringify(actions)); } catch { /* session only */ } };
const stamp = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function getActions(): StageActions { return actions; }
export function resolveItem(key: string, note: string) { actions.resolved[key] = { note, at: stamp() }; saveActions(); }
export function reopenItem(key: string) { delete actions.resolved[key]; saveActions(); }
export function signOff(payGroup: string, by: string) { actions.signoff[payGroup] = { by, at: stamp() }; saveActions(); }
export function closePeriod(payGroup: string, by: string) { actions.close[payGroup] = { by, at: stamp() }; saveActions(); }
export function resetActions() { actions = { resolved: {}, signoff: {}, close: {} }; saveActions(); resetTransmissions(); }
export function hasActions(): boolean { return Object.keys(actions.resolved).length + Object.keys(actions.signoff).length + Object.keys(actions.close).length + transmissions.length > 0; }

// ---- NetSuite transmissions (simulated; saved in this browser) ----
export interface Transmission { journalIds: string[]; at: string; ref: string; lines: number; debit: number; credit: number }
const TX_KEY = 'neocloud-payroll.netsuite.v1';
let transmissions: Transmission[] = (() => { try { return JSON.parse(localStorage.getItem(TX_KEY) || '[]'); } catch { return []; } })();
export function getTransmissions(): Transmission[] { return transmissions; }
export function transmitted(journalId: string): Transmission | undefined { return transmissions.find(t => t.journalIds.includes(journalId)); }
export function recordTransmission(t: Omit<Transmission, 'at' | 'ref'>): Transmission {
  const rec = { ...t, at: stamp(), ref: `NS-JE-${String(Date.now()).slice(-6)}` };
  transmissions = [...transmissions, rec];
  try { localStorage.setItem(TX_KEY, JSON.stringify(transmissions)); } catch { /* session only */ }
  return rec;
}
export function resetTransmissions() { transmissions = []; try { localStorage.removeItem(TX_KEY); } catch { /* ignore */ } }
