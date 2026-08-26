# Sequence - HRMS

Cloud-based Human Resource Management System for Sequence Surface, tailored for the
Indian market. It spans the full employee lifecycle — hiring, onboarding, attendance,
leave, payroll, learning, and exit — across a web portal and a companion Android app.

## Stack

- **Frontend:** React (Vite) + Tailwind CSS + React Router + Zustand + Axios
- **Mobile:** React Native (Expo) Android app with push notifications
- **Backend:** Node.js + Express + JWT auth
- **Database:** MongoDB (Mongoose)
- **Integrations:** Cloudinary (photos, selfies, course video), Nodemailer (transactional
  email), Firebase Admin / Expo (mobile push), ExcelJS & PDFKit (report/document export),
  Leaflet + OpenStreetMap (punch-location maps)

## Structure

```
HRMS/
├── backend/     Node + Express API (controllers, routes, models, services, scripts)
├── frontend/    React + Vite web SPA (admin + employee portals)
├── docs/        Project docs
└── uploads/     Local file storage (fallback when Cloudinary is unconfigured)
```

## Getting started

### Backend

```bash
cd backend
npm install
npm run dev            # nodemon server.js  (npm start for production)
```

Seed helpers:

```bash
npm run seed:superadmin         # create the first SuperAdmin login
npm run seed:accounts-manager   # create a cashbook-only Accounts Manager
npm run seed:holidays           # load the holiday calendar
npm run seed:departments        # load default departments
```

### Frontend

```bash
cd frontend
npm install
npm run dev      # Vite dev server on :5173  (npm run build to produce a bundle)
```

### Mobile (Expo)

The Android app lives in its **own repository** — `Yash-SSLLP/HRMS-mobile`. It was
moved out of this one so that this repo stays the web halves, and so ~70 MB APKs
never enter this history again (nine of them already did, which is most of why a
clone is as big as it is).

What stays here is the **update channel** the app asks. Because the app is
sideloaded, nothing tells a phone that a new build exists; it calls this API:

| Route | Who | What |
|---|---|---|
| `GET /api/app/latest` | public | the newest published build |
| `GET /api/app/download` | public | the APK (streamed, or a redirect) |
| `POST /api/app/publish` | CI key or SuperAdmin | make a build current — replaces the previous one, file included |

The read routes are public deliberately: the app checks on open, which can happen
before login, and a 401 travelling back through its auth interceptor would sign
the user out for checking for updates.

**Where the APK is stored** is one environment variable, and the app never
notices the difference:

```
APP_RELEASE_STORE=disk            # a folder on this server — the VPS end state
APP_RELEASE_DIR=/var/www/hrms-releases   # keep it OUTSIDE the checkout, or a deploy wipes it

APP_RELEASE_STORE=github          # a release asset on the mobile repo — works on Render,
APP_RELEASE_GITHUB_REPO=Yash-SSLLP/HRMS-mobile   # whose disk is wiped on every deploy
APP_RELEASE_GITHUB_TOKEN=...      # Contents write; needed for a private repo

APP_PUBLISH_KEY=...               # what CI sends as X-API-Key to publish
```

On the `github` store the ~70 MB never passes through this API — CI puts the file
on GitHub itself and sends only a pointer, which is what keeps a small web
instance out of the upload path. SuperAdmins see the current build, and can
publish one by hand where the store accepts uploads, at **Admin → App Release**.

## Roles

`SuperAdmin`, `HRManager` (with per-HR granular permissions), `CEO` / `MD`
(read-only executives), `Manager` (approves + views their direct reports),
`LDManager` ("HR L&D", LMS-only admin), `AccountsManager` (cashbook-only), and
`Employee`. The web app splits into an **Admin portal** (`/admin`) and an
**Employee portal** (`/employee`); leave and resignation approvals climb the
reporting-manager chain defined in the Org Chart.

## Modules

- **Employees & Org** — profiles, documents, org chart with reporting managers, work
  locations.
- **Attendance & Time** — geofenced selfie check-in/out (web + mobile), per-employee
  work-location geofences, monthly view, GPS punch-location map, regularization, and
  **Excel export** (day-wise, month-wise, and per-employee; admins/HR export everyone,
  managers export their own team).
- **Leave** — applications with a hierarchy-based approval chain, balances, comp-off.
- **Payroll** — salary structures, monthly payroll run, payslips, loans/EMI recovery,
  statutory components, attendance-linked pay policy (paid leaves + late penalties), and
  Excel/PDF export.
- **Recruitment** — jobs, candidates, multi-round interviews, interviewer self-service,
  and offer/appointment emails with public (no-login) document links.
- **Learning (LMS)** — courses with Cloudinary-hosted video, assignments & self-enrolment,
  accurate anti-cheat watch tracking, and deadlines.
- **Chat** — web dock + mobile screens, group photos/admins, and Jitsi video-call links.
- **Cashbook** — cash accounts and in/out ledger with running balance, employee
  vouchers → approval, transfers, and day-book/summary/CSV reports.
- **Assets, Onboarding & Exit** — asset assignment, onboarding checklists, and a
  resignation → notice-period → clearance → auto-inactivation workflow.
- **Notifications & Audit** — in-app + mobile push notifications (portal-scoped) and a
  portal-wide status-change audit log.

## Indian HR scope

The data model bakes in India-specific concerns:

- **Identity:** PAN, Aadhaar, UAN (EPFO), ESIC number
- **Payroll components:** Basic, HRA, Special Allowance
- **Statutory deductions:** EPF, ESIC, Professional Tax, TDS
- **Leave types:** Earned Leave (EL), Casual Leave (CL), Sick Leave (SL), Maternity Leave
- **Time & currency:** IST-anchored attendance days and 12-hour (AM/PM) time display; ₹ amounts
