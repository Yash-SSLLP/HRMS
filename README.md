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
├── mobile/      React Native (Expo) Android app
├── docs/        Project docs
└── uploads/     Local file storage (fallback when Cloudinary is unconfigured)
```

## Getting started

### Backend

```bash
cd backend
npm install
cp .env.example .env   # MONGO_URI, JWT_SECRET, CLOUDINARY_*, mail + push config, etc.
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

```bash
cd mobile
npm install
npm start                 # Expo dev server
npm run android           # build & run on a device/emulator
```

The mobile app needs a **restricted** Google Maps Android API key in
`mobile/app.json` → `android.config.googleMaps.apiKey` for the punch-location map.

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
