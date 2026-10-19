# Notes for the design document and reconciliation memo

Agreed with Mika; apply when writing the documents.

## Tone and content
- Focus on approach and design choices, not on the synthetic data. No headcounts, dollar totals or worker examples.
- The reconciliation memo explains what we chose to reconcile (headcount, legacy register, provider results, GL and bank), why, how each works, how variances are classified and dispositioned, and the parallel pass criteria.

## Who calculates what
- US payroll is calculated in Workday (in this app). International payroll (UK, India, Canada) is calculated by the vendor and received as a payroll register; the app never calculates it. The register carries every result: earnings, employee taxes and deductions, net pay, employer statutory cost and the 5% employer-paid benefits (ER_BENEFITS, no employee share, so net pay is unchanged).
- The app recomputes international expectations from Workday data only to reconcile the vendor register (what PECI sent vs what the vendor paid).

## US parallel run
- Before go-live the US payroll is run in parallel with Rippling (test tenant built from Rippling production, four parallels). Each parallel compares Workday results to the Rippling register by worker and pay component, classifies every variance (legacy error, configuration difference, timing, data) and records a disposition.
- The app's Payroll parallel test runs this comparison for one period against a Rippling register we generated with 12 planted differences; the full multi-run plan, pass criteria, sign-offs and cutover are in the design document.

## Payroll journal export (US and international)
- One close task, two routes, one NetSuite format.
- **US:** payroll results are already worker × pay code with company, department and location, so there is no upload or transpose. The company's combined results are posted with its rules (one journal per pay group, since each has its own pay date). The same lines appear per worker on Payroll results → Payroll accounting.
- **International:** the vendor register arrives with one row per worker, a `company` column (Workday company) and one column per pay code, no GL. In production it lands in Workday Prism. Rows are routed by company, validated, transposed to one row per worker per pay code, then Apply mapping.
- **GL mapping is one file.** Rules are by country; each country's rules list the companies of that country they apply to (multi-select on the GL mapping page). A company must be under exactly one country; none or more than one is a configuration error.
- Posting rules give every pay code an account and a debit or credit side; employer costs carry two rows (debit expense, credit liability).
- Mapping must fail, producing no journal, when:
  - (international) the register has no company column, a worker cannot be found in Workday, or a worker's net pay does not foot;
  - the company has no rules;
  - a pay code has no posting rule for the company's country;
  - a worker is missing a required posting field: company, department (cost center with a NetSuite department) or location.
- Generate NetSuite CSV shows a preview (summarized by subsidiary × account × department × location × class). From the preview: **Download CSV** or **Transmit to NetSuite** (simulated in the app; the Workday payroll journal connector in production). A transmitted journal can't be sent again until it is reversed in NetSuite.
- Month-end accruals (biweekly wage accrual, leave liability true-up) are a separate optional journal file.

## Pre-payroll audit (AI) — requirement 9
- Headcount roll-forward per US pay run: last run + joiners − leavers = this run; less unpaid leave for the whole period and no time entered = to be paid; must equal the register's paid count. Watch list: prorated hires, final pay, partial unpaid leave, location moves.
- Deterministic checks find the issues; AI only writes the summary.
- Guardrails: allow-listed payload, pseudonymized worker IDs, server-side schema check, reply verified against the payload, advisory only, logged.
