# HR and Admin Guide

*A complete walkthrough of the Admin Portal: every module HR, managers and leadership use, together with the rules, statuses and permissions behind each one. Written for someone taking over the running of the HRMS. Two automated rules — the monthly pay policy and the leave auto-stamp — quietly drive a great many of the numbers, so they are worth reading closely.*

---

## 1. Roles and permissions

The system has two portals. **My Portal** is employee self-service, covered in the Employee Handbook. The **Admin Portal** is the subject of this guide.

### The roles

- **Super Admin** — full control, including creating other admins and setting their permissions.
- **HR Manager** — the main HR operator, who can be given granular permissions. If none have ever been set, they hold all of them, so an existing HR account never loses access when the catalogue changes.
- **CEO and MD** — read-only across the admin portal. They can view and export anything, but cannot save changes. One deliberate exception is described below.
- **Manager** — approves their own team's requests and sees their team's attendance, mostly from inside the employee portal.
- **L&D Manager** — a courses-only admin who sees the learning platform and nothing else.
- **Accounts Manager** — a cashbook-only admin.
- **Employee** — no admin access.

### How access is controlled

Each admin screen is gated by a **capability**, such as `payroll.manage`, `leave.manage` or `announcements.manage`. Super Admin always passes; an HR Manager passes if they hold that capability.

[!IMPORTANT] The approvals inbox is the one place a read-only executive can act. Because every action there is scoped to "you are the current approver", a CEO or MD — or any manager, or any ordinary employee who happens to sit in someone's chain — can decide their own rung despite being read-only everywhere else.

Some actions are reserved for the Super Admin alone: creating or editing admin-role accounts, setting HR permissions and organisation settings, deleting departments and employee profiles, and reassigning an employee's HR partner or reporting manager.

[!NOTE] Throughout this guide, "HR" means the Super Admin or an HR Manager holding the relevant capability, unless stated otherwise.

---

## 2. Reports and audit

### Dashboard

The admin home page, showing organisation-wide figures: total employees, present today, on leave today, absent today, pending leaves, open complaints, departments, and incomplete documents. Below that sit headcount by department, the latest pending leave requests, and the next holidays.

[!NOTE] Every figure here counts **active, not-yet-exited** employees only, and the three attendance figures are resolved as disjoint sets — nobody is counted as both present and on leave, so present, on leave and absent always add up to the headcount.

### Analytics

Read-only workforce analytics built from employee records: headcount by department and employment type, gender diversity, tenure bands, confirmation status, exits by month with an attrition rate, and a new-hires trend.

### Audit log

A history of status changes across the system — payroll approvals, interview-round changes, leave decisions, and more. Filter by entity, person, text or date.

[!WARNING] The audit log is **Super Admin only**. It is not available to HR Managers, and executives cannot open it either.

### Chat export and the chat switch

The Super Admin can export full chat transcripts, including after chat has been switched off, because conversations are retained rather than deleted.

Chat itself is an organisation-wide switch, off by default. While it is off the chat button disappears from both web portals, the mobile tab disappears, and the API refuses requests, so an old deep link cannot get back in. Switching it on restores every conversation untouched.

---

## 3. People and organisation

### Org masters

Reference lists for designations, grades and locations used across the forms. Adding one generates a short unique code automatically.

### Departments

Create and rename departments, which appear as dropdowns throughout the system. Only the Super Admin can delete one.

### Work locations

Named, geofenced work sites, each with a latitude, longitude, radius in metres, and an active flag. Assigning an employee to a location means their attendance is measured against that site rather than the global office.

[!WARNING] A location cannot be deleted while employees are still assigned to it.

### Org chart

A read-only reporting tree built from each person's reporting manager. CEO and MD appear as top nodes even though they are not employees. To change who reports to whom, edit the employee record — a Super Admin field.

### Users

Login accounts, HR permissions, and organisation settings. Create, edit, deactivate, reactivate and delete accounts; HR Managers can manage Employee accounts only, while admin-role accounts are Super Admin territory. Creating an HR Manager or L&D Manager creates their employee profile automatically. CEO and MD are not employees and have no profile. You cannot deactivate or delete your own account.

### Permissions

One page for every grant the Super Admin controls: the organisation-wide chat switch, standalone cashbook and expense access for anyone regardless of role, per-employee **work from home**, and the fine-grained capability list for each HR Manager.

[!IMPORTANT] Work from home is a permission, not a preference. Granting it makes the WFH tick appear at punch time and exempts those punches from the geofence check. The server ignores the flag from anyone who has not been granted it, so nobody can clear their own geofence violation by sending it anyway.

### Employees

The master employee records. Create a profile — which needs a linked user account, an employee code, and a date of joining — edit details, and (Super Admin only) delete.

Bulk tools cover export to Excel, an import template, import from Excel, a ZIP export of documents, and a documents-status report measured against the required set. You can also generate a tokenised public upload link so somebody without a login can submit their documents.

[!IMPORTANT] A reporting manager must be in the same department. Choose the department first and the manager list offers only that department's people, plus an executive group so a department head still has someone to report to. This is enforced on the server as well, so an Excel import rejects a cross-department manager with a readable error rather than importing it silently. Anyone assigned before this rule stays assigned.

This is also where the **approval hierarchies** are configured, each independently of the org chart:

- **Leave approvers** — an ordered ladder of up to four people. Leave climbs it one rung at a time. Left empty, leave falls back to walking the reporting-manager chain.
- **Regularization approvers** — one or two people. Left empty, the request stays on the flat HR-review path.
- **Final HR recipients** — who is told in detail when a leave is fully approved.

---

## 4. Hiring and onboarding

### Recruitment

The pipeline from job post to converted employee.

**Jobs** are created with a status of Open, On Hold or Closed, and each open job carries a public application link to share. Candidates apply with a résumé without logging in — one application per email per job, and only while the job is open.

**Candidates** move through Applied, Shortlisted, Screening, Interview, Offer, Onboarding, New Joinee and Hired, or are rejected.

**Interview rounds** are scheduled after shortlisting. Each round carries a status, an assigned interviewer who then sees it under My Interviews, feedback, timings and a meeting link. You can generate a real meeting link and email a branded invitation with the résumé attached.

[!TIP] The interviewer picker is scoped to the job's department and lists everyone in it, not just managers. Type to search by name or designation, and use "show all employees" when the interviewer sits outside the department. Anyone already assigned stays visible even if they are from elsewhere, so re-opening a round never silently clears them.

**Before an offer**, when every round is cleared, a document-submission link is generated. The candidate uploads their documents and HR must confirm them before an offer can be created.

**From offer to employee**: generate the offer letter, move to onboarding, set the joining date and notice period, release the appointment letter, then convert to an employee — which creates the login and the employee profile and marks the candidate as hired.

### Onboarding tasks

Checklist tasks assigned to a person with a category and a due date. The employee moves each one from Pending to In Progress to Done.

### Confirmations

The probation lifecycle. The due date is the date of joining plus the probation period unless set explicitly. You can confirm, extend, or reset to probation, each with a note.

---

## 5. Attendance

### Presence and records

The presence board gives one row per active employee, split into present, on leave and absent for today, with selfie flags, lateness, WFH tags and hours. The attendance screen shows any employee's month with per-punch geofence distance, lets you add, edit and delete records by hand, and shows the punch selfies. Settings define the office location, the geofence threshold and when a check-in starts counting as late.

Punches capture GPS but are never blocked; an out-of-range punch is flagged, not refused, and WFH punches are exempt.

### When a check-in counts as late

Attendance, then Settings, holds a **Late marking** block: the time the workday starts and a **grace window** in minutes. Out of the box it is 10:00 AM with no grace, which is the rule the company ran on before it became a setting.

The grace window is forgiveness, not a later start time. With a start of 10:00 AM and a ten-minute window, arriving at 10:08 is on time; arriving at 10:12 is late by twelve minutes, not two — the "late by" figure always counts from the start time, so it answers how late someone actually was.

[!IMPORTANT] Only a **Super Admin** can change this. Everyone else with attendance access sees the block but cannot edit it, because the rule applies to the whole company and decides money — payroll charges ₹200 or ₹400 for every late day past the monthly allowance of five.

A change applies to how days are judged from that moment, including days already recorded: lateness is worked out from the punch time whenever it is displayed or paid, not frozen into the record. So a payroll run for a past month after a change uses the new rule for that month too. Move the cut-off between the month ending and payroll being run and the late counts for that month will move with it.

[!IMPORTANT] A day worth under six hours is recorded as a half day. When someone forgets to punch out, the day is counted from their check-in to 7:00 PM and the same rule applies, with the reason written into the record's remarks. Approving a regularization recalculates the day from the corrected times. A status you set by hand always wins. Each half day counts as half a paid day in payroll.

### Work on a leave day

When an employee punches in on a day they are already on approved leave, the punch is recorded but the day keeps its leave status and a claim is raised for the **top rung of that employee's leave hierarchy** to decide.

Approving it returns the leave day to the employee and turns the day into a normal worked day. Rejecting it keeps the punches on the record for reference while the day stays leave. HR is notified of the outcome either way.

[!NOTE] The claim is decided by the top of the leave ladder — the last configured leave approver, or the highest manager the reporting walk reaches. If you expect a particular manager to handle these, make sure they are the **final** step of that employee's leave hierarchy.

Half-day leave is excluded, since the employee is expected to work the other half, as are Sundays and holidays, which are covered by the double-pay rule instead.

### Reports

The attendance report gives per-day present counts and average hours, plus an organisation-wide heatmap. The monthly view shows one employee's full month with lateness, geofence distance and no-punch-out flags, alongside a summary bar — and it is the same data the payroll run uses. There is also a punch-location map and a three-mode export.

### Shifts and regularization

Define shifts and assign them per employee and day. Regularization requests are reviewed here; approving one applies the corrected times to that day's attendance, creating the record if needed, clearing the no-punch-out mark, flipping Absent to Present, and re-deriving the status from the hours. HR can also regularize directly.

---

## 6. Leave

### Managing requests

View every request, filtered by employee, status or date. HR can override-approve or reject regardless of where a request sits in its chain; the override is recorded as such in the approval history.

The four leave types are **Paid Leave**, **Unpaid Leave**, **Emergency Leave** and **Maternity Leave**. Only maternity draws a banked balance; the rest are governed by the monthly quota.

[!IMPORTANT] Emergency leave is granted the moment it is filed, with no approval step — the hierarchy and HR are informed instead. From the second one in a calendar month it is flagged as a repeat, and a manager or HR can then charge that day at double the usual deduction.

### The approval inbox

This is where whoever is the current approver acts. It is deliberately not admin-gated, and every action is scoped to the current approver, which is why executives can decide their own rung here despite being read-only elsewhere.

A leave request climbs the configured leave hierarchy if the employee has one, and otherwise walks the reporting-manager chain, stopping at the first CEO or MD. Inactive managers are skipped and cycles are guarded. With no manager at all, it falls to HR.

The same inbox also carries attendance regularizations, work-on-leave claims, resignations, and no-dues clearance sections assigned to you.

[!IMPORTANT] On final approval, each covered day is written to the attendance calendar — On Leave for paid types, Absent for unpaid — skipping Sundays and holidays, and never overwriting a day the employee actually worked. Cancelling an approved leave removes those marks again. These stamped days are what feed the two-paid-leave rule in payroll.

### Holidays

Maintain the company calendar, with each entry typed as Public, Restricted, Company or Comp Off. Holidays are respected by attendance, by payroll, and by the Rewards and Recognition banner window.

A Comp Off is a company-wide day off, and it is one of the two kinds of day that pay double when actually worked. Bulk upload provides one workbook with sheets for holidays, comp offs and celebrations; entries already on the calendar are skipped, so a corrected file can be re-uploaded safely, and the whole upload sends a single notification rather than one per row.

### Sunday and comp-off duty

Pay is spread across calendar days, so Sundays and holidays are already paid within the monthly salary. When somebody actually **works** a Sunday or a Comp Off day, that day can be paid double — but only once approved.

The attendance screen lists every such day with approve and reject actions, and a manager sees their own team's under My Team. Approving adds one extra day's salary, which is what makes it double; it appears on the payslip under Other Pay. A day left pending, or rejected, pays exactly as normal. Working an ordinary public holiday also pays normally — file the day as a Comp Off if it is meant to pay double.

---

## 7. Payroll and salary

### Payslips

Payslips move through Draft, Approved and Paid, with On Hold available. There is one per employee per month, and gross, deductions and net compute automatically.

You can create and edit, approve, mark paid with a payment date and reference, delete while still in draft, generate the PDF, share a public link, email the slip after previewing the message, and export the whole month to the payroll register.

[!IMPORTANT] Employees cannot download a payslip until it is released. They request it, HR checks and corrects it, previews, and finalises. Editing a payslip after release withdraws the download until it is released again, which stops an outdated slip circulating.

[!WARNING] If any active employee has no salary structure or no annual CTC, an amber banner names them on the dashboard and at the top of the payroll page. Payroll cannot compute anything for those people — they come out of a run with a zero payslip, and even the late-coming penalty is zero because its rate depends on monthly Basic. Clicking a name jumps straight to their salary setup. You are also notified the moment an employee is added without salary details.

### What payroll computes

- **Base salary** — each component is its percentage of the annual CTC divided by twelve, at full value. Attendance never shrinks Basic or any other head.
- **Paid days** — days in the month, less absences, less half of each half day, less excess leave. Anything unpaid becomes a Loss of Pay day.
- **Loss of Pay** — every unpaid day, including any day before joining or after exit, is charged back at one day's pay into the Loss of Pay deduction. The net works out the same as prorating would; it simply reads correctly on the slip.
- **The two-paid-leave policy** — On-Leave days beyond two in a month are added to Loss of Pay, while unused days are paid out as a Leave Incentive earning of one day's pay each. Settled monthly, never carried forward.
- **Late-arrival penalty** — late days beyond five in a month are deducted at ₹200 a day where monthly Basic is below ₹25,000, otherwise ₹400 a day.
- **Loans** — active EMIs are summed into Loan Recovery, except salary advances, which get their own deduction line.

[!IMPORTANT] Basic pay is never reduced. Every earning is the full monthly amount whatever the attendance; days not worked and late arrivals come off on the deductions side instead, so the slip always shows what was taken and why.

Worked examples: no leave taken earns two extra days' pay; three days taken means two paid and one unpaid; eight late days on a Basic of ₹20,000 costs ₹600; six late days on a Basic of ₹30,000 costs ₹400.

### Salary structures, hikes and the rest

**Salary structures** are CTC templates expressed as component percentages, which cannot sum to more than one hundred. A preview shows the monthly and annual figures for a given CTC.

**Hikes** is where an employee's structure and annual CTC are set and where increments are recorded, by percentage, by amount, or by setting a new figure, effective from a chosen month. The revision list beneath is the history of who changed what, when and why. Generating and approving payslips happens on the payroll page, not here.

**Loans and advances** — approve requests, set the EMI, tenure and disbursement, and record repayments until the balance closes.

**Tax declarations** — review each Form 12BB and verify or reject it with a note.

**Compliance** — read-only summaries built from processed payslips for PF, ESI, professional tax and TDS, plus an annual Form 16 summary. These are summaries, not official return files.

---

## 8. Money out

### Expenses

Review claims by category, amount, date and receipt, then set them to Approved, Rejected or Reimbursed.

[!NOTE] A receipt is mandatory on the employee's side, and marking a claim reimbursed posts a matching cash-out entry to the cashbook against the account you choose, carrying the receipt across for verification.

### Travel

Approve travel requests and handle reimbursements separately, including the uploaded bills.

### Cashbook

Cash accounts with an in-and-out ledger and a running balance, employee vouchers routed for approval, transfers between accounts, and a day book, summary and export. Access can be granted to anyone regardless of role, and there is a dedicated Accounts Manager role for people who need the cashbook and nothing else.

---

## 9. Performance and learning

**Goals** are created and assigned by managers and HR; employees update their own progress.

**Review cycles** run as Draft, Active or Closed. Assign self, manager and peer reviews built from competencies, then read the submissions.

[!WARNING] Reviews about an employee are shown to them anonymously. Protect that confidentiality — it is what makes the feedback honest.

**Training** maintains programmes through their lifecycle. **Courses** is the learning platform: create internal or external courses with video or text modules, assign them, approve enrolment requests, view rosters, and moderate comments and issue reports. Video is hosted with signed upload and signed playback, and watch progress is measured on genuine viewing rather than on skipping ahead. L&D Managers see this page and nothing else.

---

## 10. Work and resources

**Projects** and **tasks** are maintained here, with employees updating task status.

**Assets** is a register with statuses of Available, Assigned, In Repair and Retired. Assign an asset to a person and record its return; a full allocation register keeps the history, and asset tags are unique.

**Documents** manages employee documents: view, upload on behalf, and set each to Verified or Rejected. Some categories are HR-only, and sensitive identity documents are download-restricted to HR. A required set drives the documents-complete indicator.

---

## 11. Communication and culture

**Announcements** are posted with a category, an optional pin, and a display window; publishing notifies every active user.

**Surveys** support single-choice, multi-choice and text questions, with aggregated results that respect anonymity. One response per user.

**Events** feed the shared **calendar** alongside holidays, birthdays, anniversaries and interviews.

**Email and letter templates** are editable centrally, so offer letters, appointment letters and payslip emails can be reworded without a code change.

### Rewards and Recognition

The monthly recognition programme, curated by HR.

1. Pick the month, then choose one Employee of the Month for the organisation and one Key Achiever per department.
2. **Save draft** — the selection is secret and employees see nothing yet.
3. **Announce** when ready. This notifies every active employee, shows a celebration banner with the winners' photographs on every dashboard, keeps it visible for two working days with Sundays and holidays skipped, and locks the month.

[!NOTE] Winner details are snapshotted when you announce, so the banner stays correct even if somebody's profile changes afterwards. A draft can be prepared well in advance.

[!WARNING] Announcing is final. Once announced, a month cannot be edited or deleted.

---

## 12. Requests and cases

**Complaints** are visible to the Super Admin, HR Managers and the CEO, each seeing everything except complaints against themselves. A complaint about an admin, or about the complainant's own HR partner, escalates to the Super Admin; otherwise it goes to their HR partner. The CEO can view but not action them. Notifications are deliberately vague and are never sent to the person the complaint concerns.

**Change requests** are how employees alter profile fields and credentials they cannot self-edit. Approving one applies the value to the record, with validation; declining one closes it with a note.

**Password resets** arrive from the login page. HR Managers can reset Employee accounts only; admin-account resets are Super Admin territory. A reset signs the user out of every device.

---

## 13. Exits

An exit can be initiated by HR — as a resignation, termination or retirement — or by the employee themselves, who cannot open a second one while one is in progress.

An employee's resignation climbs the same reporting hierarchy for approval. Once approved it enters the **notice period**, during which their login stays active and they keep working normally, while the assigned managers complete their **no-dues clearance** sections. The account is deactivated automatically only once clearance is complete and the last working day has passed — never before.

Completing an exit generates a feedback token for a public, no-login feedback form, sets the date of exit, and hands you an editable feedback email to review and send. Nothing is emailed automatically.

[!NOTE] The notice period and the last working day stay in step: changing one updates the other, so the two can never disagree.

---

## 14. The mobile app

HR and managers get an admin surface in the Android app as well:

- **Admin Hub** — organisation statistics, today's split, trend charts, the attendance heatmap, headcount by department, pending leave and upcoming holidays. Executives see a read-only badge.
- **My Approvals** — the same chain inbox as the web, covering leave, regularizations, work-on-leave claims, resignations and clearance.
- **My Team**, **today's and monthly attendance**, **directory**, **employee detail**, **add employee**, and **work locations**.
- **Payroll** — list, approve, mark paid, and PDF.
- **Recruitment** — jobs, candidates and interview rounds.
- **Rewards and Recognition** — pick the winners, save a draft, and announce.

Role gating mirrors the web: HR can write, executives are read-only, and managers get team features.

---

## 15. The things that catch people out

- **Two automated rules drive most of the numbers.** The monthly pay policy — two paid leaves, five free late arrivals — and the leave auto-stamp onto the attendance calendar. Neither needs any action from you, and both are applied when payroll runs.
- **Approval hierarchies are separate from the org chart.** Leave and regularization each have their own configurable ladder per employee. If a request reaches someone unexpected, check that ladder before checking the reporting manager.
- **Work-on-leave claims go to the top of the leave ladder**, which is not necessarily the manager who normally approves that person's leave.
- **A payslip is not visible to the employee until it is released**, and editing it after release withdraws it again.
- **An exit does not deactivate anyone early.** The account stays live through the whole notice period.
- **Removed modules.** The comp-off request workflow, the knowledge base, and the old peer recognition feature are gone. Comp-off survives only as a holiday type and as earned days in payroll.

---

*That is the whole Admin Portal. Keep the permission model in mind — Super Admin, then HR Manager with capabilities, then read-only executives — and remember that the pay policy and the leave auto-stamp are working quietly in the background behind a great many of the figures you will be asked about.*
