// Node-only helper: load /data into a DataSet (used by tests and generator scripts).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/engine/csv.ts';
import type { DataSet } from '../src/engine/types.ts';
import { DATA_FILES } from '../src/engine/files.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');

export function loadDataSet(dir: string = DATA_DIR): DataSet {
  const ds: Record<string, unknown> = {};
  for (const name of DATA_FILES) {
    const p = join(dir, `${name}.csv`);
    ds[name] = existsSync(p) ? parseCsv(readFileSync(p, 'utf8')) : [];
  }
  ds.rules = JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8'));
  return ds as unknown as DataSet;
}
