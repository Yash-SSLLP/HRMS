# Sequence Surface HRMS

Cloud-based Human Resource Management System for Sequence Surface, tailored for the Indian market.

## Stack

- **Frontend:** React (Vite) + TailwindCSS + React Router + Zustand
- **Backend:** Node.js + Express + JWT auth
- **Database:** MongoDB (Mongoose)

## Structure

```
indian-hrms/
├── backend/        Node + Express API
└── frontend/       React + Vite SPA
```

## Getting started

### Backend

```bash
cd backend
npm install
cp .env.example .env   # fill in MONGO_URI, JWT_SECRET, etc.
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Indian HR scope

The data model bakes in India-specific concerns:

- **Identity:** PAN, Aadhaar, UAN (EPFO), ESIC number
- **Payroll components:** Basic, HRA, Special Allowance
- **Statutory deductions:** EPF, ESIC, Professional Tax, TDS
- **Leave types:** Earned Leave (EL), Casual Leave (CL), Sick Leave (SL), Maternity Leave
