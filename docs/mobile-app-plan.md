# HRMS Mobile App (React Native / Android) — Plan & Estimate

The existing **backend API is reused as-is** — the mobile app is a new frontend only.
No backend changes are required beyond a couple of optional additions (push tokens).

## 1. Tech stack
- **Expo (React Native)** — fastest path to an Android (and later iOS) build, OTA updates, easy camera/file APIs. Eject to bare RN only if a native module needs it.
- **expo-router** (or React Navigation) — stack + bottom-tabs navigation.
- **axios** — same API client pattern as web (`Authorization: Bearer <token>`).
- **zustand + @react-native-async-storage/async-storage** — mirror the web `authStore` (persisted token/user).
- **nativewind** (Tailwind for RN) — lets us carry over the web's utility-class styling and per-role accent theme.
- **expo-camera / expo-image-picker** — attendance selfie + document/photo uploads.
- **expo-notifications** — push (optional, phase 4).
- **react-native-svg + react-native-svg-charts (or victory-native)** — charts (attendance heatmap, login/logout, dashboards).

## 2. Project layout (`mobile/`)
```
mobile/
  app/                      # expo-router screens (or src/screens)
    (auth)/login
    (employee)/...          # tabs: Home, Attendance, Leave, Payslips, More
    (admin)/...             # optional later
  src/
    api/client.js           # axios + base URL + token interceptor (port of web)
    store/authStore.js      # zustand + AsyncStorage
    components/             # Avatar, Card, StatTile, charts, etc.
    config/                 # company, theme/accent
```

## 3. What ports directly vs. needs rework
- **Direct**: all API calls, auth flow, business logic, data shapes (the API is unchanged).
- **Rework (no HTML/DOM in RN)**: every screen's markup → RN components (`View`, `Text`, `Pressable`, `FlatList`, `TextInput`). Tables become `FlatList`/cards. Modals → RN `Modal`/bottom sheets. `<img>` + Bearer → `expo-image` with auth header or a signed URL. SVG charts → react-native-svg.
- **Native features**: camera selfie for check-in/out, file picker for documents, deep links for the tokenized public pages (offer letter / candidate docs) can stay web.

## 4. Scope — screens by phase
Focus on the **employee portal** first (highest mobile value); admin is mostly desk work.

**Phase 1 — Foundation (auth + shell)**
Login, token persistence, role-based redirect, bottom-tab navigation, API client, theme. → *~3–5 days*

**Phase 2 — Core employee self-service**
Dashboard (stats + attendance heatmap), Attendance (check-in/out **with camera selfie**, live timer, history), Leave (balance, apply, list), Payslips (list + PDF view/download), Profile (+ photo upload). → *~2–3 weeks*

**Phase 3 — Remaining employee modules**
Documents (submit + status), Regularization, Comp-off, Expenses, Travel + reimbursement, Tasks, Goals/Reviews, Announcements, Surveys, Calendar, Recognition, Complaints, Org chart, Chat. → *~3–4 weeks*

**Phase 4 — Cross-cutting + polish**
Push notifications (needs a small backend addition to store device tokens + send via Expo), offline/error states, deep links, app icon/splash, Play Store build & release. → *~1–2 weeks*

**Phase 5 — Admin/HR on mobile (optional)**
Approvals (leave/travel/reimbursement/regularization), employee directory, dashboards, document verification. Most admin CRUD is better left on web. → *~2–3 weeks if needed*

## 5. Effort estimate
- **Employee app, production-ready (Phases 1–4):** ~**6–9 weeks** for one developer.
- **+ Admin/HR on mobile (Phase 5):** +2–3 weeks.
- A usable **MVP** (Phases 1–2: login, dashboard, attendance with selfie, leave, payslips) is achievable in **~2–3 weeks**.

## 6. Minimal backend additions (only if push is wanted)
- `User.expoPushTokens: [String]` + `POST /api/notifications/register-token`.
- In the existing notification-creation paths, also send an Expo push. (Everything else already exists.)

## 7. Recommended first step
Stand up **Phase 1** (`mobile/` Expo app: login → token → employee tab shell hitting the live API) so we validate auth + connectivity end-to-end, then port Phase 2 screens one by one.
