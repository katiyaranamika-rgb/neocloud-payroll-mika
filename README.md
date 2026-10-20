# NeoCloud Payroll — one period, calculated and reconciled

A web app that runs one pay period of payroll, time and absence for NeoCloud (375 employees, 30 contractors, 5 pay groups). It calculates US payroll, ingests and reconciles the international vendor registers, reconciles headcount and the legacy Rippling register, and produces a validated NetSuite journal.

- **Live app:** `https://neocloud-payroll-mika.vercel.app/` 
- **Architecture decisions:** [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md)
- **Design document and reconciliation memo:** submitted separately (PDF)

| What it does | Where in the app |
| --- | --- |
| Payroll status grid: every pay group × 7 stages (preparing inputs → processing → audits → sign-off → complete → settlement → closed), with sign-off and close actions; period totals and burdened cost by department and location | Dashboard |
| Pay runs per pay group: paid full / prorated / active-not-paid, plus special instructions | Pay runs & headcount |
| US gross-to-net for both US pay groups, per employee and per pay component; branded, printable payslip | Payroll register, Payslip |
| Enter a worker ID: earnings / deductions / taxes, employer costs, **Time results** (regular, OT, DT, 7th day, night/shift differential, meal penalty with the day-by-day CA rule trace), **Time cards** (punches exactly as captured, no calculation), pay inputs and the debit/credit accounting for that worker | Payroll results |
| Non-exempt time for all workers: raw time cards (every punch as captured, several per day where they exist, nothing calculated), every time exception and how it was handled, and the time entry template validations; click a row to open that worker's Time cards and Time results | Time cards |
| Absence balances for every country, accruals, payouts, leave liability | Absence & payouts |
| UK / India / Canada: vendor results reconciled to what Workday sent, employer cost in local currency and USD | International |
| **Headcount roll-forward** per US pay run (last run + joiners − leavers = this run; less unpaid leave and no time = to be paid, tied to the register), deterministic checks vs the prior period, and **AI commentary with guardrails** | Pre-payroll audit (AI) |
| Clean-close tie-outs and the payroll control matrix | Controls & clean close |
| Close step, two routes: **US** posts the company's combined payroll results directly; **international** uploads the vendor register (one row per worker), validates, transposes to worker × pay code and applies the mapping. Both block on unmapped codes or missing posting fields, then Generate NetSuite CSV → preview → Download CSV or Transmit to NetSuite (simulated) | Export payroll journal |
| One-period parallel vs the Rippling register: every variance classified with root cause and disposition | Payroll parallel test |
| Edit events, timecards, roster, payroll inputs, pay codes and GL posting rules, then re-run | Edit data & re-run |
| One GL mapping: posting rules by country, with the companies of that country each applies to | GL mapping |
| Read-only rules, pay code catalog, chart of accounts | Rules & pay codes |

Rollups on every screen filter by pay group, department and location (top bar).

## Run it locally (under 10 minutes)

Requirements: **Node.js 22.18 or newer** (`node -v`). The build uses Node's built-in TypeScript type stripping, so there are **no npm dependencies** — nothing to install.

```bash
git clone https://github.com/<you>/neocloud-payroll.git
cd neocloud-payroll
cp .env.example .env        # optional: only needed for live AI commentary
npm run dev                 # builds to dist/ and serves http://localhost:3000
```

Older Node, or no Node at all? Open `dist/standalone.html` (attached to the repository release) in any browser: it is the whole app in one file, data included. Only the live AI call needs the server; without it the commentary falls back to the deterministic template.

`.env` settings (all optional):

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables live AI commentary on the pre-payroll audit. Server-side only. |
| `ANTHROPIC_MODEL` | Model for the commentary (default `claude-sonnet-5-5`) |
| `PORT` | Local server port (default 3000) |

## Run the tests

```bash
npm test                                   # all test files
node --test tests/second-meal.test.ts      # one file
```

| Test file | What it covers |
| --- | --- |
| `tests/engine.test.ts` | The whole engine end to end on the dataset (52 tests, listed below) |
| `tests/second-meal.test.ts` | CA second meal period: a shift over 12 hours pays a meal premium that can't be waived (E0049, E0228); still max one premium a day (E0021); no premium at 12 hours or less, or outside CA (4 tests) |

56 tests in total (Node's built-in test runner, no dependencies) cover:

- **Overtime:** CA daily OT and double time, 7th consecutive day, weekly OT without pyramiding, TX weekly-only, OT at base + 0.5 × weighted regular rate, overnight shifts, differentials not stacking, meal penalties (late, missed/waived attestation, no second meal over 12 hours), punch cleaning, retro time.
- **Proration:** mid-period hire, termination, unpaid leave, late-entered comp change (retro), state-to-state split, and an edit-and-re-run case.
- **Termination payouts:** US hourly vacation payout, international daily-rate payout, sick forfeiture.
- Taxes and wage bases, 401(k) and Section 125, garnishment limits, benefit arrears.
- GL: every journal balances, ties hold, an unmapped code blocks the export; export payroll journal routing, transposing and every blocking rule; US journals from payroll results.
- Reconciliations: legacy register (12 planted variances, all explained), vendor registers, headcount buckets.
- Pre-payroll audit (AI): roll-forward ties for both pay runs, a missing timecard moves to "no time entered", the payload is allow-listed and pseudonymized, verification flags invented workers and numbers.
- Payroll status stages.

## How the data loads

**Source files** (in [`source/`](source/), as provided with the exercise):

- `Worker File dataset.xlsx` – workers, absence balances, payroll inputs, employee events, timesheets, pay groups and schedule, shift codes, shift roster
- `Overtime rules.xlsx` – time calculation groups (CA / non-CA), differentials, meal penalty, duplicate punches
- `Supplemental Tax rate and Benefit ded.xlsx` – employer tax rates, international employer costs, FX rates, benefits load

`npm run data` exports the worker file's sheets to the CSVs below. The two rules workbooks are captured in `data/rules.json`.

All inputs are CSV files in [`data/`](data/). The app loads them at start-up (the build also embeds them in `data.bundle.js` so the single-file version works offline). Editable files can be changed on **Edit data & re-run**; changes stay in that browser and can be reset.

| File | Source |
| --- | --- |
| `workers.csv`, `events.csv`, `timesheets.csv`, `shift_roster.csv`, `shift_codes.csv`, `absence_balances.csv`, `payroll_inputs.csv`, `pay_schedule.csv` | Exported from `source/Worker File dataset.xlsx` by `npm run data` (Python 3 + pandas; only needed if the workbook changes) |
| `rules.json` | Overtime rules and Supplemental Tax & Benefit files plus the agreed module decisions (read-only) |
| `pay_codes.csv`, `gl_posting_rules.csv`, `gl_accounts.csv`, `subsidiaries.csv`, `departments.csv` | Pay component catalog, the one GL mapping (rules by country and company), chart of accounts, companies, departments |
| `prior_register.csv`, `legacy_register.csv`, `legacy_variance_notes.csv`, `vendor_register_uk.csv`, `vendor_register_in.csv`, `vendor_register_ca.csv`, `vendor_variance_notes.csv` | Generated by `npm run generate` (below) |

**Generated registers.** `npm run generate` (`scripts/generate-registers.ts`) builds, deterministically:

- the **prior-period register** from this period's data with standard time at straight pay, no bonuses or time off, same 401(k)/health elections;
- the **legacy Rippling register** by re-running the engine with 12 planted differences (3 each: legacy error, configuration difference, timing, data; across both US pay groups), each with a root cause and disposition;
- the **UK / India / Canada vendor registers**, standing in for the vendor's file: one row per worker, a company column, one column per pay code. They carry every result the vendor calculates (earnings, employee taxes and deductions, net pay, employer statutory cost, employer-paid benefits at 5%) with the brief's rules applied and illustrative employee rates, plus 6 planted variances.

### Test files for the international journal upload

[`test-files/provider-registers/`](test-files/provider-registers/) holds the provider registers to upload on **Close → Export payroll journal → International**:

| File | Use it to test | Expected result |
| --- | --- | --- |
| `UK payroll register Oct 2026.csv` | One country, clean | Validates, transposes and maps; the NetSuite preview balances for NeoCloud UK Ltd (GBP) |
| `Canada payroll register Oct 2026.csv`, `India payroll register Oct 2026.csv` | The other two countries | Same, for NeoCloud Canada Inc. (CAD) and NeoCloud India Pvt Ltd (INR) |
| `All companies payroll register Oct 2026.csv` | One file for all three countries | Rows are routed by the `company` column; one journal per subsidiary |
| `UK payroll register Oct 2026 - with unmapped code.csv` | A pay code with no posting rule (`CAR_ALLOW`) | Export blocked and the unmapped code flagged; no journal is produced until a rule is added in Setup → GL mapping |

## Project layout

```
src/engine/   Pure TypeScript calculation engine (no DOM). Runs in the browser and in the tests.
  model.ts      effective-dated worker model (rate and location histories rebuilt from events)
  employment.ts employment windows, unpaid leave dates
  time.ts       non-exempt time rules (CA / non-CA), differentials, meal penalties, retro
  absence.ts    accrual plans, usage, payouts, leave liability
  payroll.ts    US gross-to-net, taxes, deductions, garnishments, headcount buckets
  intl.ts       expected international results, vendor register reconciliation
  prism.ts      GL mapping (rules by country), vendor register import/transpose, US journals, NetSuite rows
  gl.ts         internal journals for tie-outs, accruals, bank tie-out
  recon.ts      legacy reconciliation, headcount by pay run
  audit.ts      pre-payroll audit checks and headcount roll-forward
  ai-guard.ts   AI guardrails: allow-listed payload, pseudonyms, reply verification, template
  status.ts     7-stage payroll status per pay group
  run.ts        runAll(dataset): model → time → absence → US payroll → intl → GL → recon → audit
src/ui/       Screens (plain DOM, no framework)
api/explain.js  Vercel function: AI commentary (server-side key, schema check)
scripts/      build (type-strip + bundle), dev server, data export, register generator
tests/        node:test suite
data/         input CSVs and rules
source/       the workbooks provided with the exercise
```

## Deploy to Vercel

The repo deploys as-is: `vercel.json` sets the build command (`npm run build`), the output directory (`dist`) and no install step; `package.json` pins Node ≥ 22.18. `api/explain.js` becomes a serverless function. Optionally add `ANTHROPIC_API_KEY` under **Project → Settings → Environment Variables** to enable live AI commentary.

## AI in payroll operations for audits

**One feature, in depth: the pre-payroll audit.** Before a US pay run is approved, the Payroll Specialist needs to know two things: are the right people being paid, and is anything unusual about what they are paid.

1. **Headcount roll-forward (deterministic).** For each pay run: last period's headcount, plus new hires, transfers in and returns, less terminations and transfers out, equals this run's headcount. Less active workers on unpaid leave for the whole period and non-exempt workers with no time entered, that gives the number to be paid, which must equal the paid count on the register. A watch list shows people who are paid but need a look (prorated new hires, final pay, partial unpaid leave, state or location moves). Every line opens to the workers behind it.
2. **Exception checks (deterministic).** 16 checks against the prior-period register (first pay, $0 pay, gross and net swings, new earning types, deduction and state changes, garnishments, arrears, time exceptions, no time, wage base, leave over balance, premium hours, California final pay timing, low net). Each finding has a plain-English explanation and must be resolved with a note by a person.
3. **AI commentary (advisory).** Claude turns the roll-forward and the findings into a short summary for the Payroll Manager and Controller: does the headcount tie, what needs action, what is expected, and a recommendation.

**Guardrails for HR and payroll data:**

- **Minimum data, allow-listed.** The payload is built field by field from a fixed schema: check, rule, severity, pay group, amounts and headcount counts. No names, birth dates, addresses, bank or tax IDs, and no free-text notes. The screen shows exactly what is sent.
- **Pseudonymized.** Worker IDs become tokens (W001…) before sending; the map stays in the browser and the reply is re-identified locally.
- **Checked on the server.** `api/explain.js` rejects any field outside the schema and any real worker ID. The API key lives only on the server.
- **Verified on return.** Every worker token and number in the reply must exist in the payload; anything else is flagged "Unverified content — review before use".
- **Advisory only.** The AI cannot change amounts or clear findings. A Payroll Partner resolves each finding; the Payroll Manager approves the run.
- **Logged.** Every prompt and reply is logged on screen for audit. In production: a zero-data-retention API agreement with no training on customer data, the feature restricted to the payroll security group, and the log retained with the payroll records.

Without an API key the same pipeline runs with a deterministic template, so the feature is fully demonstrable offline.

## How I used the AI coding tool

I built this with Claude (Anthropic) in the Claude desktop app (Cowork). I worked from the brief and a requirements pack: a Phase 0 profile and assumptions, then nine module decisions agreed one by one before any code. After an early rejected screen, the rule was: agree the design first, then build.

**What the AI generated:** the CSV export script, the calculation engine, the UI, the build and dev-server scripts, the register generator, the tests, and first drafts of this README, the decision log, the design document and the memo.

**How I reviewed and verified the calculation logic:**

1. Every rule was agreed in writing before code (time rules and their order, tax approximations, proration method, payout formula, YTD method, benefits). The engine cites the decisions in comments.
2. I checked worked examples by hand against the trace output for the planted cases: 7th day, double time and meal penalties, TX weekly OT with differentials in the regular rate, retro on a late comp change, the state split, termination payouts, unpaid leave, garnishment.
3. The 52 automated tests encode those cases with independently computed expected values.
4. Structural checks run on every period run: journals balance, register gross = wage expense + payouts relieved, register net = net pay payable = bank file, vendor clearing nets to zero, headcount buckets add back to the worker file, and the roll-forward ties to the register.
5. The legacy register is generated with known planted differences, so the reconciliation must find exactly 12, no more.

**Where the AI was wrong (and fixed):**

- Treated non-CA workers as California: it tested whether the time group name *contains* "California", and "US Non-California Non-Exempt" does.
- Put UK, India and Canada leave-liability lines in one journal across currencies; it balanced in total but mixed subsidiaries. Split per company.
- Counted workers on full unpaid leave as "paid" in the legacy headcount. Changed to net earnings > 0.
- Left terminated workers' sick balances on the books instead of forfeiting them.
- Read only the first row's columns when importing a register, so a combined all-companies file lost pay codes.
- Listed a removed duplicate punch twice (as the exception and again as "dropped"), so counts were doubled.
- One test priced a retro OT half-hour at base rate instead of the regular rate (the engine was right, the test was wrong).
- A UI helper appended `null` into the page on two screens; caught by a headless render of every screen.
- Table search boxes typed backwards: each keystroke re-rendered the table and put the cursor back at the start. Fixed by restoring the cursor position after each re-render.
- The CA meal rule missed the second meal period: a shift over 12 hours with one meal paid no premium. Added (it can't be waived), with its own test file.

**What I changed from what the AI first produced:**

- **International payroll.** The AI added the employer benefits load inside the app and used 10%. I corrected it: the vendor calculates all non-US results, including employer-paid benefits (5% per the brief), and the app only ingests, reconciles and posts them.
- **Payroll results.** The first version showed combined results; I required them by worker, looked up by worker ID.
- **Payroll status.** I rejected a separate status page and specified one grid on the dashboard with my seven stages.
- **Journal export.** The AI built one export per country plus separate GL export and register import screens. I redesigned it as one close task: vendor rows routed by a company column, US posted straight from payroll results, one GL mapping file by country with company selection, and a preview before Download or Transmit.
- **Data.** The AI worked from an older copy of the worker file (Canada showed one employee); I pointed it to the latest.
- **Pre-payroll audit.** I extended it into the headcount roll-forward a payroll specialist uses to confirm who is paid, and renamed it.
- **Parallel run.** I separated the one-period reconciliation in the app (Payroll parallel test) from the four-run parallel plan, which belongs in the design document.
- **Time screens.** I split time into what was captured and what was calculated: a **Time cards** screen with every worker's raw punches, exceptions and template validations; and, per worker under Payroll results, a **Time results** tab (rule trace, no pay amounts) and a **Time cards** tab (punches as captured).
- **Swing shift.** The dataset lists a $1.50 swing differential; I decided swing earns no extra pay.
- **Framework.** The AI planned Next.js; the build environment could not reach the npm registry, so it switched to a zero-dependency TypeScript build. I reviewed and accepted that trade-off.

The full list of decisions, and who made each, is in [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md).

## Assumptions and limitations

Tax rates are the exercise's flat approximations, not statutory tables. YTD is derived (pay × prior 2026 periods), not loaded. International gross-to-net is the vendor's; the app reconciles and posts it, and the vendor registers here are generated stand-ins with illustrative employee deductions. Edits, resolutions, sign-offs and transmissions are saved only in the viewer's browser. Transmit to NetSuite is simulated. See the design document for the full list.
