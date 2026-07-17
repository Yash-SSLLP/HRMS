# HRMS - HR & Admin Guide

*A complete walkthrough of the Admin Portal - every module HR, managers, and leadership use, with the rules, statuses, and permissions behind each. Written for someone new to running the HRMS.*

---

## 1. Introduction & the role/permission model

The HRMS has **two portals**:
- **My Portal** - employee self-service (covered in the Employee guide).
- **Admin Portal** - HR/leadership tools. This guide covers the Admin Portal.

### The roles
- **Backend** - full control of everything, including creating other admins and setting permissions.
- **HR Manager** - the main HR operator. Can be given **granular permissions** (or, if none are set, has **full HR access** by default).
- **CEO / MD** - **read-only** across the admin portal (they can *view* everything but not change it). *Important exception below.*
- **Manager** - sees and approves their own team's leave and attendance (mostly from within the employee portal).
- **L&D Manager (LDManager)** - a **courses-only** admin; sees just the LMS/Courses page.
- **Employee** - no admin access.

### How access is controlled
- Each admin screen is gated by a **permission** (e.g. `payroll.manage`, `leave.manage`, `announcements.manage`). The Backend always passes; an HR Manager passes if they hold that permission - **and if an HR Manager's permissions were never set, they hold ALL of them** (so legacy HRs keep full access).
- **CEO/MD are read-only**: they can open any admin page and view/read/export, but any *save/edit/delete* is blocked with a "read-only access" message.
- ⭐ **The one place CEO/MD (and everyone) can act:** the **Leave Approvals** inbox. Because it only lets you act on *your own* approval rung, a CEO/MD (or any manager) can approve the leave requests that have climbed the chain to them - even though they're read-only elsewhere.
- **Backend-only actions:** creating/editing/deleting *admin-role* users, setting HR permissions and org settings, deleting departments/employee-profiles, and reassigning an employee's HR partner or reporting manager.

💡 Throughout this guide, "HR" means "the Backend or an HR Manager with the relevant permission," unless noted.

---

## 2. Overview & reporting tools

### Dashboard
The admin home page. Shows org-wide cards: **total employees, present today, on leave today, absent today, pending leaves, open complaints, departments, documents incomplete**, plus **headcount by department**, the latest **pending leave requests**, and the **next holidays**. (The Rewards & Recognition banner shows here too.)

### Analytics *(permission: analytics.view)*
Read-only workforce analytics from employee data: headcount by **department** and **employment type**, **gender diversity**, **tenure buckets**, **confirmation** breakdown, **exits by month** and **attrition rate**, and **new hires** trend.

### Audit Log *(permission: audit.view)*
A history of **status changes** across the system (e.g. payroll approvals, interview-round changes). Filter by entity, person, text, and date. ⚠️ **Backend activity is hidden from all other viewers** - those entries are filtered out.

### Chat Export *(Backend only)*
The Backend can export full chat transcripts. (Everyday chat itself is open to all users.)

---

## 3. Organization Setup

### Org Masters *(org.manage)*
Reference lists for **Designations, Grades, and Locations** used across forms. Adding one auto-generates a short unique **code**.

### Departments *(org.manage; delete = Backend only)*
Create and rename departments (used everywhere as dropdowns). Only the Backend can delete one.

### Work Locations *(org.manage)*
Named, **geofenced** work sites: **name, latitude, longitude, radius (metres), active**. Assign employees to a location; their attendance geofence then uses that site (otherwise the global office). ⚠️ You **can't delete** a location while employees are still assigned to it.

### Org Chart
A read-only reporting tree built from each person's **reporting manager**. CEO/MD appear as top nodes even though they aren't "employees." To change who reports to whom, edit the employee (a Backend-only field).

### Users *(users.manage)*
Login accounts + HR permissions + org settings.
- Create/edit/deactivate/reactivate/delete accounts. **HR Managers can only manage Employee accounts**; only the **Backend** can create or change *admin-role* accounts.
- Creating an HR Manager or L&D Manager auto-creates their employee profile. **CEO/MD are not employees** (no profile).
- **Backend-only:** the **permission catalog** (fine-tune exactly what an HR Manager can do) and **org settings** (e.g. whether CEO/MD appear in people-pickers).
- You can't deactivate or delete your own account.

### Employees *(employees.manage)*
The master employee records.
- Create a profile (needs the linked user account, an **employee code**, and **date of joining**), edit details, and (Backend only) delete.
- **Bulk tools:** export to Excel, download an import template, **import from Excel**, export a ZIP of documents (per employee or all), and a **documents-status** report (verified/complete/missing against the required set).
- **Document collection link:** generate a **tokenised public upload link** so a person (even without a login) can submit their documents.
- Reassigning an employee's **HR partner** or **reporting manager** is **Backend-only**.

---

## 4. Recruitment & Onboarding

### Recruitment *(recruitment.jobs / .candidates / .interviews)*
The hiring pipeline, from job post to a converted employee.
- **Jobs:** create/edit/delete postings; status **Open / On Hold / Closed**. Each Open job has a **public application link** to share.
- **Public apply:** candidates apply with a résumé (PDF/DOC, ≤5 MB) - no login, one application per email per job, only while the job is Open.
- **Candidate stages:** **Applied → Shortlisted → Screening → Interview → Offer → Onboarding → New Joinee → Hired** (or Rejected).
- **Interview rounds:** shortlist first, then schedule rounds - set status (Pending/Scheduled/Cleared/Rejected), assign an **interviewer** (they get it in "My Interviews"), add feedback, times, and a meeting link. You can create a real **Google Meet** link and email a branded invite (résumé attached).
- **Pre-offer document gate:** when all rounds are **Cleared**, a document-submission link is generated; the candidate uploads docs and **HR must confirm them before an offer can be created**.
- **Offer → Appointment → Employee:** generate the **Offer Letter** (PDF), move to **Onboarding**, set joining date/notice, release the **Appointment Letter** (PDF), then **Convert to Employee** - this creates the login + employee profile (auto-suggested employee code) and moves the candidate to **Hired**.

### Onboarding (hiring) *(recruitment.candidates)*
The workspace for candidates in the **Onboarding / New Joinee** stage - set joining details and release the appointment letter.

### Onboarding Tasks *(onboarding.manage)*
Assign **checklist tasks** to a person (category: Documentation, IT Setup, HR, Finance, Training, Introduction, Other) with due dates. The employee marks each **Pending → In Progress → Done**.

### New Joinees *(recruitment.candidates)*
Lists candidates whose appointment letter is out but who aren't converted yet - the primary action is **Convert to Employee**.

### Confirmations *(lifecycle.manage)*
Probation → confirmation lifecycle. The **due date** is the date of joining + probation months (default 6) unless set explicitly. Actions: **Confirm**, **Extend** (+3 months), or **Reset** to probation, each with an optional note.

---

## 5. Attendance & Time *(all: attendance.manage; CEO/MD read-only)*

- **Who's In / On Leave (Presence):** one row per active employee, split into **present / on leave / absent** for today, with selfie flags, late minutes, WFH, and hours.
- **Attendance:** view any employee's month (with per-punch geofence distance), **manually add/edit/delete** records, and view punch selfies. **Settings** define the office location and geofence threshold.
  - Employee punches capture GPS but are **never blocked** - out-of-geofence punches are only **flagged**. WFH is exempt. "Late" = check-in after **10:00 AM**.
- **Attendance Report:** per-day present counts + average hours, and an org-wide attendance heatmap.
- **Monthly View:** one employee's full month with late minutes, geofence distance, and no-punch-out flags, plus a summary bar (working days, on-time, late, leave, half-day, absent, holiday, etc.). **This is the same data the Payroll Run calendar uses.**
- **Shifts & Roster:** define shifts and assign them per employee/day.
- **Regularization:** review employee correction requests; **Approving applies the corrected times to that day's attendance** (creating the record if needed, clearing "no punch-out," flipping Absent→Present). HR can also regularize directly.

---

## 6. Leave

### Leave *(leave.manage)*
- View all requests (filter by employee/status/date). As HR you can **override**-approve or reject **regardless of where the request sits** in the chain (recorded as an "HR override").
- **Balances:** view and **grant** balances per employee/year (balance = opening + granted − used − encashed). Leave is only deducted at **final approval** (and only for EL/CL/SL/ML).

### Leave Approvals (the hierarchy inbox) *(no permission - visible to all admin roles)*
- This is where whoever is the **current approver** acts. It's deliberately **not** admin-gated, and every action is scoped to "you are the current approver" - which is why **CEO/MD can approve their own rung** here despite being read-only elsewhere.
- **The approval chain:** built from the employee's **reporting-manager links**, one rung per active manager, **stopping at the first CEO/MD** (the top). Inactive managers are skipped; cycles are guarded. No manager at all → falls back to HR/Backend.
- ⭐ **Auto-stamp on final approval:** when a leave is fully approved, each covered day is written to the attendance calendar - **On Leave** for normal types, **Absent for LOP** - **skipping Sundays and holidays**, and never overwriting a day the employee actually worked. Cancelling an approved leave **removes** those auto-marks. These stamped days feed the **2-paid-leave / LOP** payroll rule.
- Everyone relevant is **notified** - the current approver at their turn, the applicant on decision, and HR/Backend on the final outcome.

### Holidays *(leave.manage)*
Maintain the company holiday calendar (type: Public / Restricted / Company). Holidays are respected by attendance, payroll, and the Rewards & Recognition banner window.

---

## 7. ⭐ Payroll & Compensation *(payroll.manage unless noted)*

### Payroll (payslip records)
- Payslip **status: Draft → Approved → Paid** (or **On Hold**). One payslip per employee per month; gross/deductions/net auto-compute.
- Actions: create/edit, **Approve**, **Mark Paid** (stamps payment date/reference), **delete** (Draft only), **PDF**, **share a public link**, and **email** the payslip (with PDF attached) after previewing the message. **Export the whole month to CSV.**
- Earnings include a **Leave Incentive** line; deductions include a **Late Arrival Penalty** line (both explained below). These appear in the payslip editor, the CSV export, and the PDF.

### ⭐ Monthly Payroll Run (the heart of payroll)
This is where each employee's salary is calculated from their **attendance + salary structure + CTC**, with the company pay policy applied automatically.

**How you use it:**
1. Pick an **employee** and **month**. The screen loads that month's **attendance calendar** and a computed-salary preview.
2. Adjust any day's status right on the calendar (this writes real attendance).
3. Make sure the employee has a **Salary Structure** and **Annual CTC** assigned.
4. **Generate Draft → review → Approve** (or put **On Hold**). Approved/Paid payslips can't be regenerated.

**What the system computes automatically:**
- **Base salary:** each component = its % of (Annual CTC ÷ 12), **prorated by paid days** (paid days ÷ days in month).
- **Paid days** = days in month − Absent − ½ × Half-days − **excess leave**. Anything unpaid becomes **LOP days**.
- ⭐ **2-paid-leave policy:**
  - **Excess leave** (On-Leave days beyond **2**/month) → added to **LOP** (unpaid).
  - **Unused leave** (fewer than 2 taken) → paid out as a **Leave Incentive** earning = unused days × one day's pay. **Settled monthly, never carried forward.**
- ⭐ **Late-arrival penalty:** late days (check-in after **10:00 AM**) beyond **5**/month are deducted at **₹200/day** if the employee's **monthly Basic < ₹25,000**, else **₹400/day** → written to the **Late Penalty** deduction.
- **Loans:** active loan/advance **EMIs** are summed into **Loan Recovery**.

**What HR sees:** an **"Attendance policy" panel** (Leave used of 2, Late arrivals of 5, excess late, excess leave, with a plain-language caption), a **working-hours** roll-up (days present, average hours, comp-off earned for worked weekends/holidays), and a **computed-salary breakdown** - Basic/HRA/Special/Conveyance/Medical/LTA, **+ Leave incentive**, Gross (prorated), **− Loan EMI**, **− Late penalty**, and **Estimated net**.

**Worked examples of the policy:**
- Employee takes **0 leaves** → **+2 days' pay** (Leave Incentive).
- Takes **3 leaves** → 2 paid, **1 day LOP**.
- **8 late days**, Basic ₹20,000 → 3 × ₹200 = **₹600** Late Penalty.
- **6 late days**, Basic ₹30,000 → 1 × ₹400 = **₹400** Late Penalty.

### Salary Structures *(payroll.manage)*
CTC templates as component **percentages** (Basic, HRA, Special, Conveyance, Medical, LTA). ⚠️ The percentages **can't sum to more than 100%**. A **preview** shows monthly/annual figures for a given CTC.

### Loans & Advances *(loans.manage)*
Approve requests, set **EMI/tenure/disbursement**, and record **repayments** (balance hits zero → **Closed**). Active EMIs flow into payroll's Loan Recovery.

### Tax Declarations *(declarations.manage)*
Review employees' Form 12BB declarations; **Verify** or **Reject** with a note. Statuses: Draft → Submitted → Verified/Rejected.

### Compliance *(compliance.view - read-only)*
Summary reports built from processed payslips: **PF, ESI, Professional Tax, TDS**, and an annual **Form-16** summary - each with rows and totals. *(These are summaries, not official government return files.)*

---

## 8. Expense & Travel

### Expenses *(expenses.manage)*
Review claims (category, amount, date, receipt): set **Approved / Rejected / Reimbursed**, or delete.

### Travel *(travel.manage)*
Approve travel requests (Approved/Rejected/Completed) and handle **reimbursements** separately (Approved/Rejected/Reimbursed), including viewing uploaded receipts.

---

## 9. Performance & Learning

### Performance / Goals *(performance.manage)*
Create and assign **goals** (status Draft/Active/Completed/Cancelled); employees update progress.

### Appraisals - Review Cycles *(performance.manage)*
Run appraisal cycles (Draft/Active/Closed): **assign** reviews (self/manager/peer) built from competencies, then read submissions. ⚠️ Reviews about an employee are shown to them **anonymously** - protect that confidentiality.

### Training *(training.manage)*
Maintain training programs (Planned/Ongoing/Completed/Cancelled).

### Courses / LMS *(courses.manage - also L&D Managers)*
The learning platform. Create internal/external courses (video via Cloudinary or Drive, or text modules), **assign** them, approve or reject **enrollment requests**, view **rosters**, moderate **comments** and **issue reports**, and optionally share a course publicly to capture leads. *(L&D Managers see only this page.)*

---

## 10. Work Management

### Projects *(projects.manage)*
Maintain projects (Planning/Active/On Hold/Completed/Cancelled).

### Tasks *(tasks.manage)*
Create and assign tasks; employees update status (Todo/In Progress/Review/Done).

### Assets *(assets.manage)*
Asset register (status Available/Assigned/In Repair/Retired). **Assign** an asset to a person (→ Assigned) and record the **return** (→ Available). A full **allocation register** keeps the history. Asset tags are unique.

### Documents *(documents.manage)*
Manage employee documents: view, **upload on behalf**, and set status **Submitted → Verified / Rejected**. Some categories are **HR-only**; sensitive **PII** documents (PAN, Aadhaar, address proof) are download-restricted to HR. A **required set** drives the "documents complete" indicator.

---

## 11. Engagement & Communication

### Announcements *(announcements.manage)*
Post company notices (category, pinned, start/end window). Publishing **notifies all active users**. Employees can dismiss each from their banner.

### Surveys *(surveys.manage)*
Build surveys/polls with **single-choice, multi-choice, and text** questions, then view **aggregated results** (respecting anonymity). One response per user; closed/out-of-window surveys reject responses.

### Events *(events.manage)*
Maintain company events (shown in the Calendar).

### Calendar
A shared view of holidays, events, birthdays, anniversaries, and interviews; also powers the peer **"send a wish"** feature.

### ⭐ Rewards & Recognition (RNR) *(announcements.manage)*
The monthly recognition program. **This replaced the old peer "kudos" feature** - now HR curates the winners.

**How you run it:**
1. Go to **Rewards & Recognition** and pick the **month/year**.
2. Choose **one Employee of the Month** (org-wide) and **one Key Achiever per department** from the pickers.
3. **Save Draft** - the selection is **secret**; employees see nothing yet ("Draft · N selected · hidden from employees").
4. When ready, **Announce** (with a confirmation). This:
   - **Notifies every active employee**,
   - Shows a **celebration banner** (with winners' **photos**) on everyone's dashboard,
   - Keeps it visible for **2 working days** (the announce day counts if it's a working day; **Sundays and holidays are skipped**),
   - and **locks** the month - once announced, it **can't be edited or deleted**.

💡 Winner details are **snapshotted** at announce time, so the banner stays correct even if someone's profile later changes. Employees can close the banner (it stays closed for them). You can prepare a Draft well in advance and only Announce when you're ready.

---

## 12. Requests & governance

### Complaints *(leadership inbox - no permission gate)*
- The **assigned inbox** is visible to the **Backend, HR Manager, and CEO** (each sees all complaints except ones against themselves).
- **Routing:** a complaint about an admin, or about the complainant's own HR partner, escalates to the **Backend**; otherwise it goes to the complainant's **HR partner**.
- ⚠️ **CEO can view but not action** complaints (only HR/Backend or the assignee can). Notifications are deliberately vague and **never sent to the accused**. Statuses: open / under review / resolved / dismissed.

### Change Requests *(HR/Backend inbox)*
- Employees can't self-edit most profile fields or credentials - they raise **Change Requests**. HR reviews the inbox and **Approves** (which **applies the value** to the record, with validators like email-uniqueness and password re-hash) or **Declines**. Assigned to the requester's HR partner (the Backend sees all).

### Password Resets *(users.manage)*
- Requests come in from the login page. HR can **resolve** and **reset** the password (min 8 chars). ⚠️ **HR Managers can only reset Employee accounts**; admin-account resets are **Backend-only**. A reset logs the user out of all devices.

### My Account
Every admin's own account/password page (not a tool for managing others).

---

## 13. Exit management *(exit.manage)*

- Initiate an exit (Resignation/Termination/Retirement), record **clearance items, dates, reason, and handler**, and edit until it's finalised.
- **Complete an exit** does three things: generates a **feedback token** (60-day link), sets the employee's **date of exit**, and **deactivates their login** - then hands you an editable **feedback email** to review and send (nothing is sent automatically).
- Employees can also self-initiate a **resignation** (they can't open a second one while one is open). A **public exit-feedback** form (no login) collects their feedback.

---

## 14. On the mobile app (admin surface)

HR and managers get an admin surface in the Android app too:

- **Admin Hub** - org stats, today's split, trend charts, attendance heatmap, headcount by department, pending leave, upcoming holidays (execs see a "read-only" badge).
- **Approvals** - the leave-approval hierarchy inbox.
- **My Team** - manager presence/approvals for direct reports.
- **Today's / Monthly Attendance**, **Directory / Employee detail / Add employee**, **Work Locations**.
- **Payroll** - list, approve, mark paid, PDF/CSV.
- **Recruitment** - jobs, candidates, interview rounds.
- ⭐ **Rewards & Recognition** - pick the Employee of the Month + Key Achievers per department, **Save Draft**, and **Announce** (same 2-working-day banner). Gated to HR; others see "HR only."

Role gating on mobile mirrors the web: the Backend/HR Manager can write, CEO/MD are read-only, Managers get team features.

---

## 15. What changed recently (so you're not surprised)

- ✅ **New pay policy** (auto-applied in the Monthly Payroll Run): **2 paid leaves/month** (unused → **Leave Incentive** pay; excess → **LOP**) and a **late-arrival penalty** (₹200/₹400 per late day beyond 5, by monthly Basic). Employees also see a **"Lateness & leave"** card on their attendance screen.
- ✅ **Leave approval now auto-stamps the attendance calendar** (On Leave / Absent for LOP; skips weekends & holidays; reverses on cancel).
- ✅ **Rewards & Recognition** is a **new HR-curated** monthly program (web + mobile), replacing the old peer kudos feature.
- ❌ **Removed:** the **Comp-off request** module, the **Knowledge Base**, and the old **peer Recognition/Kudos**. *(The comp-off concept still appears only as a legend on the attendance heatmap and as "comp-off earned" for worked weekends/holidays in payroll - there's no comp-off request workflow anymore.)*

---

*That's the whole Admin Portal. Keep the permission model in mind (Backend > HR Manager with caps > CEO/MD read-only), and remember the two big automated rules - the pay policy in payroll and the leave auto-stamp - because they quietly drive a lot of the numbers.*
