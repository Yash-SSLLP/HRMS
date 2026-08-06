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

## 2. Reports & Audit

### Dashboard
The admin home page. Shows org-wide cards: **total employees, present today, on leave today, absent today, pending leaves, open complaints, departments, documents incomplete**, plus **headcount by department**, the latest **pending leave requests**, and the **next holidays**. (The Rewards & Recognition banner shows here too.)

### Analytics *(permission: analytics.view)*
Read-only workforce analytics from employee data: headcount by **department** and **employment type**, **gender diversity**, **tenure buckets**, **confirmation** breakdown, **exits by month** and **attrition rate**, and **new hires** trend.

### Audit Log *(Backend only)*
A history of **status changes** across the system (e.g. payroll approvals, interview-round changes). Filter by entity, person, text, and date. ⚠️ **Only the Backend (Super Admin) can open this** - it is not available to HR, and executives cannot view it either.

### Chat Export *(Backend only)*
The Backend can export full chat transcripts - including after chat has been switched off, since the conversations are kept.

### ⭐ Chat on/off *(Backend only, on the Permissions page)*
**Chat is an org-wide switch and is OFF by default.** While it is off, the chat button disappears from both web portals, the mobile **Chat** tab disappears, and the chat API refuses requests - so an old link or deep link cannot get back in. Nothing is deleted: switch it on and every conversation returns exactly as it was.
- The **Complaints** people-picker keeps working either way (it reads the staff directory, not chat).
- Shift assignments and birthday wishes stop posting their chat copy while it's off; the notification and email still go out.

---

## 3. People & Organization

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

### Permissions *(Backend only)*
One page for every grant the Backend controls:
- **Modules** - the org-wide **Chat on/off** switch (§2).
- **Cashbook** - standalone access for anyone, whatever their role.
- ⭐ **Work from home** - per employee. Granting it makes the WFH tick appear at punch time and exempts those punches from the geofence check. Accounts with no employee profile (CEO/MD) show a dash, since there is nothing to grant.
- **HR Permissions** - the fine-grained capability list for each HR Manager.

### Employees *(employees.manage)*
The master employee records.
- Create a profile (needs the linked user account, an **employee code**, and **date of joining**), edit details, and (Backend only) delete.
- **Bulk tools:** export to Excel, download an import template, **import from Excel**, export a ZIP of documents (per employee or all), and a **documents-status** report (verified/complete/missing against the required set).
- **Document collection link:** generate a **tokenised public upload link** so a person (even without a login) can submit their documents.
- Reassigning an employee's **HR partner** or **reporting manager** is **Backend-only**.
- ⭐ **The reporting manager must be in the same department.** Pick the department first; the manager list then offers only people from that department, plus an **Executive** group (CEO / MD / Backend) so a department head still has someone to report to. Changing the department clears a manager who no longer qualifies. This is enforced on the server too, so the **Excel import** rejects a cross-department manager with a readable error rather than importing it silently. An employee whose manager was set before this rule keeps them - they stay listed as "currently assigned" so editing the record doesn't wipe them.

---

## 4. Hiring & Onboarding

### Recruitment *(recruitment.jobs / .candidates / .interviews)*
The hiring pipeline, from job post to a converted employee.
- **Jobs:** create/edit/delete postings; status **Open / On Hold / Closed**. Each Open job has a **public application link** to share.
- **Public apply:** candidates apply with a résumé (PDF/DOC, ≤5 MB) - no login, one application per email per job, only while the job is Open.
- **Candidate stages:** **Applied → Shortlisted → Screening → Interview → Offer → Onboarding → New Joinee → Hired** (or Rejected).
- **Interview rounds:** shortlist first, then schedule rounds - set status (Pending/Scheduled/Cleared/Rejected), assign an **interviewer** (they get it in "My Interviews"), add feedback, times, and a meeting link. You can create a real **Google Meet** link and email a branded invite (résumé attached).
- ⭐ **Choosing the interviewer:** the picker is **scoped to the job's department** - it lists everyone in that department (managers and team members alike, with their designation) rather than the whole company. **Type to search** by name or designation, and use **"Show all employees"** when the interviewer sits outside the department. A job with no department set simply lists everyone. Anyone already assigned stays visible even if they're from another department, so re-opening a round never silently clears them.
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

## 5. Attendance & Shifts *(all: attendance.manage; CEO/MD read-only)*

- **Who's In / On Leave (Presence):** one row per active employee, split into **present / on leave / absent** for today, with selfie flags, how late each person was, WFH, and hours.
- **Attendance:** view any employee's month (with per-punch geofence distance), **manually add/edit/delete** records, and view punch selfies. **Settings** define the office location and geofence threshold.
  - Employee punches capture GPS but are **never blocked** - out-of-geofence punches are only **flagged**. WFH is exempt. "Late" = check-in after **10:00 AM**, shown as hours and minutes (e.g. `1h 15m`).
  - ⭐ **WFH is a per-employee permission** granted by the Backend on the **Permissions** page. Employees without it never see the WFH tick, and the server ignores the flag even if it is sent - so nobody can clear their own geofence violation.
- ⭐ **Automatic half days.** A day worth **under 6 hours** is recorded as **Half Day**. When someone forgets to punch out, the day is counted from their check-in to **7:00 PM** and the same rule applies (10 AM check-in → full day; 3 PM check-in → half day), with the reason written into the record's remarks. Approving a **Regularization** recalculates the day from the corrected times, so a day that now reaches 6 hours goes back to **Present**. HR setting a status by hand always wins. This flows straight into payroll, where each half day counts as 0.5 paid days.
- **Attendance Report:** per-day present counts + average hours, and an org-wide attendance heatmap.
- **Monthly View:** one employee's full month with lateness, geofence distance, and no-punch-out flags, plus a summary bar (working days, on-time, late, leave, half-day, absent, holiday, etc.). **This is the same data the Payroll Run calendar uses.**
- **Shifts & Roster:** define shifts and assign them per employee/day.
- **Regularization:** review employee correction requests; **Approving applies the corrected times to that day's attendance** (creating the record if needed, clearing "no punch-out," flipping Absent→Present, and re-deriving Present vs Half Day from the hours). HR can also regularize directly.

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
Maintain the company holiday calendar (type: Public / Restricted / Company / **Comp Off**). Holidays are respected by attendance, payroll, and the Rewards & Recognition banner window.
- **Comp Off** is a company-wide day off (e.g. the office closes on a Friday because everyone worked the Saturday). It is non-working like any holiday, and it is one of the two days that pay **double** when actually worked - see *Sunday & comp-off duty* below.
- **Bulk upload:** *Template* downloads one workbook with three sheets - **Holidays**, **Comp Offs** and **Celebrations** - and *Import Excel* uploads it back. Fill in only the sheets you need; the example row in each sheet is ignored, and entries already on the calendar (same name, same day) are skipped, so a corrected file can be re-uploaded safely. Celebrations become company events and need the events permission. The whole upload sends **one** notification, not one per row.

### Sunday & comp-off duty *(attendance.manage)*
Pay is spread over calendar days, so Sundays and holidays are already paid inside the monthly salary. When someone **works** a Sunday or a **Comp Off** day, that day can be paid **double** - but only after it is approved.
- Attendance shows a **Sunday & comp-off duty** panel listing every such day that was worked, with Approve 2x / Reject. A reporting manager sees their own team's under **My Team**.
- Approving adds **one extra day's salary** for that day (half a day for a half day), which is what makes it 2x. It shows on the payslip under **Other Pay** and in the payroll register's own **DUTY PAY** column (with the day count in LNT + EXTRA DAYS).
- A day left pending, or rejected, pays exactly as normal. Working an ordinary Public/Restricted/Company holiday also pays normally - file the day as **Comp Off** if it should pay double.

---

## 7. ⭐ Payroll & Salary *(payroll.manage unless noted)*

### Payroll (payslip records)
- Payslip **status: Draft → Approved → Paid** (or **On Hold**). One payslip per employee per month; gross/deductions/net auto-compute.
- Actions: create/edit, **Approve**, **Mark Paid** (stamps payment date/reference), **delete** (Draft only), **PDF**, **share a public link**, and **email** the payslip (with PDF attached) after previewing the message. **Export the whole month to the payroll register (.xlsx).**
- Earnings include a **Leave Incentive** line; deductions include **LOP / unpaid days** and a **Late coming** line (all explained below). These appear in the payslip editor, the register export, and the PDF.
- ⭐ **Salary-setup alert.** If any active employee has **no salary structure or no annual CTC**, an amber banner appears on the **Dashboard** and at the top of the **Payroll** page naming them. Payroll cannot compute anything for those people - they come out of a run with a **₹0 payslip**, and even the late-coming penalty is ₹0 because its ₹200/₹400 rate is based on monthly Basic. **Click a name in the banner** to jump straight to **Salary Structures** with the assign modal already open for that person - if they already have a structure it opens that one so you only type the CTC, otherwise it starts a new structure. Save, then re-run the month. The banner disappears once everyone is set up, and only people with the payroll permission ever see it. **You also get a notification** the moment an employee is added without salary details - one per employee from the Add Profile form, and a single combined one for a bulk Excel import, sent to everyone who holds the payroll permission. Opening it lands on **Salary Structures**, on the assign modal for that person when the notification is about a single employee.
- ⭐ **Basic pay is never reduced.** Every earning is the full monthly amount whatever the attendance — days not worked and late coming are taken off on the **deductions** side instead.

### The salary slip (PDF)
The generated slip follows the company's own format: letterhead + GSTIN, an identity block (Employee ID, UAN, PF No., ESIC No., DOJ, Aadhar, PAN, bank name & account, Salary Per Month / Per Annum), a day block (Total Working Days, LOP Days, Payable Days, Half Days, Additional Paid Days, Late Days), the Earnings / Deductions tables, **Net Billing Amount**, the amount in words, and the authorised signature.
- The slip's **Other Deductions** line is the total of **LOP + late coming + emergency-leave double cut + any other deduction** — as its printed note says.
- **Special Allowance** on the slip also absorbs Medical and LTA (the format has no row for those); **TA** is Conveyance; **Incentives** is Leave Incentive + Bonus; **Variable Pay** is Overtime.

### ⭐ Hikes (salary basis & increments)
This is where an employee's **salary structure** and **annual CTC** are set, and where **increments** are given. The pay policy below is what those figures then drive when payroll runs.

**How you use it:**
1. Pick an **employee** and **month**.
2. Set their **Salary Structure** and **Annual CTC**, then **Save**.
3. **Give hike** to record an increment (percent / amount / set-to), effective from a chosen month. Future-dated hikes only apply from that month onward.
4. The **CTC revisions** list underneath is the history of who changed what, when, and why.

⚠️ **Generating, approving and holding payslips is on the Payroll page**, not here — use **▶ Run Payroll** there for everyone at once, or open a payslip to edit it. Per-day attendance is edited on **Attendance → Monthly View**. This screen shows the month's attendance roll-up (paid/LOP days, leave, lateness) purely as context for the increment decision.

**What the system computes automatically when payroll runs:**
- **Base salary:** each component = its % of (Annual CTC ÷ 12), **at full value** — attendance never shrinks Basic or any other head.
- **Paid days** = days in month − Absent − ½ × Half-days − **excess leave**. Anything unpaid becomes **LOP days**.
- ⭐ **LOP deduction:** every unpaid day — LOP plus any day before joining / after exit — is charged back at **one day's pay** (monthly gross ÷ days in month) into the **LOP / unpaid days** deduction. Net pay works out the same as prorating would; it just reads correctly on the slip.
- ⭐ **2-paid-leave policy:**
  - **Excess leave** (On-Leave days beyond **2**/month) → added to **LOP** (unpaid).
  - **Unused leave** (fewer than 2 taken) → paid out as a **Leave Incentive** earning = unused days × one day's pay. **Settled monthly, never carried forward.**
- ⭐ **Late-arrival penalty:** late days (check-in after **10:00 AM**) beyond **5**/month are deducted at **₹200/day** if the employee's **monthly Basic < ₹25,000**, else **₹400/day** → written to the **Late Penalty** deduction.
- **Loans:** active **EMIs** are summed into **Loan Recovery**, except **Salary Advance** loans which get their own **Salary Advance** deduction (the slip prints them as separate lines).

**What HR sees on the Hikes page:** the salary-setup controls and CTC revision history, an **"Attendance policy" panel** (Leave used of 2, Late arrivals of 5, excess late, excess leave, with a plain-language caption) and a **working-hours** roll-up (days present, average hours, comp-off earned for worked weekends/holidays).

**Worked examples of the policy:**
- Employee takes **0 leaves** → **+2 days' pay** (Leave Incentive).
- Takes **3 leaves** → 2 paid, **1 day LOP** → that day's pay comes off as the LOP deduction.
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

## 8. Expenses & Travel

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

## 10. Projects & Resources

### Projects *(projects.manage)*
Maintain projects (Planning/Active/On Hold/Completed/Cancelled).

### Tasks *(tasks.manage)*
Create and assign tasks; employees update status (Todo/In Progress/Review/Done).

### Assets *(assets.manage)*
Asset register (status Available/Assigned/In Repair/Retired). **Assign** an asset to a person (→ Assigned) and record the **return** (→ Available). A full **allocation register** keeps the history. Asset tags are unique.

### Documents *(documents.manage)*
Manage employee documents: view, **upload on behalf**, and set status **Submitted → Verified / Rejected**. Some categories are **HR-only**; sensitive **PII** documents (PAN, Aadhaar, address proof) are download-restricted to HR. A **required set** drives the "documents complete" indicator.

---

## 11. Communication & Culture

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

## 12. My Account & Requests

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

- ✅ **New pay policy** (auto-applied when payroll runs): **2 paid leaves/month** (unused → **Leave Incentive** pay; excess → **LOP**) and a **late-arrival penalty** (₹200/₹400 per late day beyond 5, by monthly Basic). Employees also see a **"Lateness & leave"** card on their attendance screen.
- ✅ **Leave approval now auto-stamps the attendance calendar** (On Leave / Absent for LOP; skips weekends & holidays; reverses on cancel).
- ✅ **Rewards & Recognition** is a **new HR-curated** monthly program (web + mobile), replacing the old peer kudos feature.
- ❌ **Removed:** the **Comp-off request** module, the **Knowledge Base**, and the old **peer Recognition/Kudos**. *(The comp-off concept still appears only as a legend on the attendance heatmap and as "comp-off earned" for worked weekends/holidays in payroll - there's no comp-off request workflow anymore.)*

---

*That's the whole Admin Portal. Keep the permission model in mind (Backend > HR Manager with caps > CEO/MD read-only), and remember the two big automated rules - the pay policy in payroll and the leave auto-stamp - because they quietly drive a lot of the numbers.*
