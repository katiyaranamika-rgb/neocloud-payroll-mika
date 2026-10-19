// Data file catalog shared by the browser app and Node scripts.

/** CSV files (without extension) the app loads from /data. */
export const DATA_FILES = [
  'workers', 'absence_balances', 'payroll_inputs', 'events', 'timesheets', 'pay_schedule',
  'shift_codes', 'shift_roster', 'pay_codes', 'gl_accounts', 'subsidiaries',
  'departments', 'prior_register', 'legacy_register', 'legacy_variance_notes',
  'vendor_register_uk', 'vendor_register_in', 'vendor_register_ca', 'vendor_variance_notes', 'gl_posting_rules',
] as const;

/** Files the viewer may edit in the browser (Module 8 decision 8.1). */
export const EDITABLE_FILES = ['events', 'timesheets', 'shift_roster', 'payroll_inputs', 'pay_codes', 'gl_posting_rules'] as const;

/** Provider payroll registers imported per country (Workday Prism in production). */
export const VENDOR_FILES: Record<string, string> = { 'UK Monthly': 'vendor_register_uk', 'India Monthly': 'vendor_register_in', 'Canada Monthly': 'vendor_register_ca' };
