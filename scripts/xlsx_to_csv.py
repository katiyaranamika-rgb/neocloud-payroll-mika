#!/usr/bin/env python3
"""Convert the NeoCloud 'Worker File dataset' workbook into the clean CSVs the app ingests.

Usage:  python3 scripts/xlsx_to_csv.py "Worker File dataset.xlsx" data/

Only needed when the source workbook changes. The CSVs in /data are committed, so the app
itself never needs Python. What this script does:
  * strips non-breaking spaces from headers and values
  * converts salaries stored as text ("285,000", "45,00,000") to numbers
  * writes dates as ISO YYYY-MM-DD and times as HH:MM
  * drops helper/summary columns that live beside the tables in the workbook
  * adds a stable event_id to each event and a seq to each roster row (last row wins)
  * adds the meal_attestation column agreed in the Module 3 decisions
"""
import re
import sys
import datetime as dt
import pandas as pd

SRC = sys.argv[1] if len(sys.argv) > 1 else "Worker File dataset.xlsx"
OUT = (sys.argv[2] if len(sys.argv) > 2 else "data").rstrip("/")

# Planted meal attestations (Module 3 decision 3b). Key = (worker, work date).
MEAL_ATTESTATIONS = {
    ("E0021", "2026-10-07"): "Missed",
    ("E0074", "2026-10-08"): "Waived",
    ("E0307", "2026-10-13"): "Missed",
    ("E0333", "2026-10-16"): "Waived",
}


def clean_str(v):
    if isinstance(v, str):
        v = v.replace("\xa0", " ").strip()
        return v if v not in ("", "—", "-", "nan") else None
    return v


def clean(df):
    df = df.copy()
    df.columns = [str(c).replace("\xa0", " ").strip() for c in df.columns]
    for c in df.columns:
        if df[c].dtype == object:
            df[c] = df[c].map(clean_str)
    return df


def d(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v is pd.NaT:
        return ""
    if isinstance(v, (pd.Timestamp, dt.datetime, dt.date)):
        return pd.Timestamp(v).strftime("%Y-%m-%d")
    return str(v)


def t(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    if isinstance(v, dt.time):
        return v.strftime("%H:%M")
    if isinstance(v, (dt.datetime, pd.Timestamp)):
        return v.strftime("%H:%M")
    s = str(v)
    m = re.match(r"^(\d{1,2}):(\d{2})", s)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def num(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    if isinstance(v, (int, float)):
        return f"{v:g}" if float(v) != int(v) else str(int(v))
    s = re.sub(r"[^0-9.\-]", "", str(v))
    return s


def s(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    return str(v)


x = {k: clean(v) for k, v in pd.read_excel(SRC, sheet_name=None).items()}

# ---------- workers ----------
w = x["worker file"]
workers = pd.DataFrame({
    "id": w["ID"].map(s), "dept": w["Dept"].map(s), "location": w["Location"].map(s),
    "state": w["State"].map(s), "country": w["Country"].map(s), "level": w["Level"].map(s),
    "flsa": w["FLSA"].map(s), "pay_rate_type": w["Pay Rate type"].map(s),
    "annual_salary": w["Salary"].map(num), "hourly_rate": w["Hourly rate"].map(num),
    "currency": w["Currency"].map(s), "pay_group": w["Pay Group"].map(s),
    "hire_date": w["Hire Date"].map(d), "term_date": w["Term Date"].map(d),
    "leave_start_date": w["Leave Start Date"].map(d), "manager_id": w["Mgr"].map(s),
    "status": w["Status"].map(s), "worker_type": w["Worker Type"].map(s),
    "weekly_hours": w["scheduled weekly hours"].map(num), "time_type": w["time type"].map(s),
    "time_entry_template": w["time entry template"].map(s),
    "time_calc_group": w["time calculation group"].map(s),
    "work_schedule": w["work schedule"].map(s), "default_shift": w["Default Shift Code"].map(s),
    "notes": w["Notes"].map(s),
})
workers.to_csv(f"{OUT}/workers.csv", index=False)

# ---------- absence balances ----------
a = x["absence balance"]
bal = a["Balance (hours or days)"]
absence = pd.DataFrame({
    "worker_id": a["Employee ID"].map(s), "plan": a["Plan"].map(s),
    "balance": bal.map(lambda v: "" if isinstance(v, str) else num(v)),
    "unlimited": bal.map(lambda v: "Y" if isinstance(v, str) and "unlimited" in v else ""),
    "unit": a["Unit"].map(s), "last_accrual_date": a["Last Accrual Date"].map(d),
    "notes": a["Notes"].map(s),
})
absence = absence[absence.worker_id != ""]
absence.to_csv(f"{OUT}/absence_balances.csv", index=False)

# ---------- payroll inputs (table starts at the header row 'Employee ID') ----------
raw = x["Payroll inputs"]
hdr_row = raw.index[raw.iloc[:, 0] == "Employee ID"][0]
p = raw.iloc[hdr_row + 1:].copy()
p.columns = [str(c).strip() for c in raw.iloc[hdr_row].tolist()]
p = p.dropna(how="all")
inputs = pd.DataFrame({
    "worker_id": p["Employee ID"].map(s), "code": p["Deduction Code"].map(s),
    "description": p["Description"].map(s), "tax_treatment": p["Tax Treatment"].map(s),
    "calc_method": p["Calc Method"].map(s), "rate": p["Rate (%)"].map(num),
    "amount": p["Flat Amount"].map(num), "effective_start": p["Effective Start"].map(d),
    "effective_end": p["Effective End"].map(d), "notes": p["Notes"].map(s),
})
inputs.to_csv(f"{OUT}/payroll_inputs.csv", index=False)

# ---------- events ----------
e = x["employee events"]
e = e[e["Employee ID"].notna()].reset_index(drop=True)
events = pd.DataFrame({
    "event_id": [f"EV{i + 1:03d}" for i in range(len(e))],
    "worker_id": e["Employee ID"].map(s), "event_type": e["Event Type"].map(s),
    "effective_start": e["Effective Start"].map(d), "effective_end": e["Effective End"].map(d),
    "time_off_plan": e["Time Off Plan"].map(s), "quantity": e["Quantity"].map(num),
    "unit": e["Unit"].map(s), "status": e["Status"].map(s), "notes": e["Notes"].map(s),
    "change_field": e["Change Field"].map(s), "old_value": e["Old Value"].map(s),
    "new_value": e["New Value"].map(s),
})
events.to_csv(f"{OUT}/events.csv", index=False)

# ---------- timesheets ----------
ts = x["timesheet data"]
ts = ts[ts["Employee ID"].notna()].reset_index(drop=True)
rows = []
for _, r in ts.iterrows():
    wid, wd = s(r["Employee ID"]), d(r["Work Date"])
    rows.append({
        "worker_id": wid, "work_date": wd, "time_in": t(r["In"]), "time_out": t(r["Out"]),
        "meal_start": t(r["Meal Start"]), "meal_end": t(r["Meal End"]),
        "shift_code": s(r["Shift Code"]), "entry_type": s(r["Entry Type"]),
        "entered_on": d(r["Entered On"]), "pay_period": s(r["Pay Period"]), "state": s(r["State"]),
        "notes": s(r["Notes"]), "meal_attestation": MEAL_ATTESTATIONS.get((wid, wd), ""),
    })
pd.DataFrame(rows).to_csv(f"{OUT}/timesheets.csv", index=False)

# ---------- pay schedule ----------
ps = x["pay group & schedule"]
pd.DataFrame({
    "pay_group": ps["Pay Group"].map(s), "country": ps["Country"].map(s),
    "frequency": ps["Frequency"].map(s), "period_start": ps["Period Start Date"].map(d),
    "period_end": ps["Period End Date"].map(d), "pay_date_original": ps["Pay Date"].map(d),
}).to_csv(f"{OUT}/pay_schedule.csv", index=False)

# ---------- shift codes ----------
sc = x["Shift Codes"]
sc = sc[sc["Code"].notna() & sc["Shift Name"].notna()]
pd.DataFrame({
    "code": sc["Code"].map(s), "name": sc["Shift Name"].map(s),
    "work_schedule": sc["Work Schedule"].map(s), "days": sc["Days"].map(s),
    "start": sc["Start"].map(t), "end": sc["End"].map(t), "meal_min": sc["Meal (min)"].map(num),
    "paid_hours": sc["Paid Hours"].map(num), "crosses_midnight": sc["Crosses Midnight"].map(s),
}).to_csv(f"{OUT}/shift_codes.csv", index=False)

# ---------- shift roster ----------
ro = x["Shift Roster"]
ro = ro[ro["Employee ID"].notna()].reset_index(drop=True)
pd.DataFrame({
    "seq": range(1, len(ro) + 1), "worker_id": ro["Employee ID"].map(s), "date": ro["Date"].map(d),
    "shift_code": ro["Shift Code"].map(s), "source": ro["Source"].map(s),
    "reason": ro["Reason"].map(s), "updated_on": ro["Updated On"].map(d),
    "updated_by": ro["Updated By"].map(s),
}).to_csv(f"{OUT}/shift_roster.csv", index=False)

print("wrote CSVs to", OUT)
