// Orchestrates one full period run: model → time → absence → US payroll → international →
// GL → reconciliations → pre-payroll audit. Pure function of the DataSet: same input, same output.

import type { DataSet, Model, TimeResult, AbsenceRow, RegisterRow } from './types.ts';
import { buildModel } from './model.ts';
import { calcTimeForWorker } from './time.ts';
import { calcAbsence } from './absence.ts';
import { calcUsPayroll } from './payroll.ts';
import type { LegacyOptions } from './payroll.ts';
import { calcInternational } from './intl.ts';
import type { IntlResult } from './intl.ts';
import { buildJournal } from './gl.ts';
import type { JournalResult } from './gl.ts';
import { reconcileLegacy, headcount } from './recon.ts';
import type { LegacyRecon, HeadcountRun } from './recon.ts';
import { runAudit } from './audit.ts';
import type { AuditResult } from './audit.ts';

export { DATA_FILES, EDITABLE_FILES } from './files.ts';

export interface RunResult {
  model: Model;
  time: Map<string, TimeResult>;
  absence: AbsenceRow[];
  register: RegisterRow[];
  intl: IntlResult;
  journal: JournalResult;
  legacy: LegacyRecon;
  headcount: HeadcountRun[];
  audit: AuditResult;
}

export function runTimeAndAbsence(model: Model) {
  const time = new Map<string, TimeResult>();
  const bw = model.schedules.get('US Biweekly');
  for (const w of model.workers) {
    if (w.workerType === 'Employee' && w.payGroup === 'US Biweekly' && bw) {
      time.set(w.id, calcTimeForWorker(model, w, bw));
    }
  }
  const absence = calcAbsence(model, time);
  return { time, absence };
}

export function runUsRegister(ds: DataSet, opts: LegacyOptions = {}) {
  const model = buildModel(ds);
  const { time, absence } = runTimeAndAbsence(model);
  const register = calcUsPayroll(model, time, absence, opts);
  return { model, time, absence, register };
}

export function runAll(ds: DataSet): RunResult {
  const { model, time, absence, register } = runUsRegister(ds);
  const intl = calcInternational(model, absence);
  const journal = buildJournal(model, register, intl, absence, time);
  const legacy = reconcileLegacy(model, register);
  const hc = headcount(model, register, intl);
  const audit = runAudit(model, register, time, absence);
  return { model, time, absence, register, intl, journal, legacy, headcount: hc, audit };
}
