# SSLLP HRMS — Android App (React Native / Expo)

A professional native Android client for the SSLLP HRMS portal. It reuses the
existing backend REST API (`/api/*`) — no API was re-implemented — and adds
**real-time push notifications** for chat messages, events, holidays, birthdays
and work anniversaries.

## What's inside

| Area | Screen / file |
|------|----------------|
| Auth | `LoginScreen` — JWT login, token persisted in AsyncStorage |
| Home | `DashboardScreen` — greeting, attendance punch, leave balances, quick actions, today's celebrations, upcoming events, recent alerts |
| Notifications | `NotificationsScreen` — list, unread badges, mark read / mark-all-read, tap-to-navigate |
| Chat | `ChatListScreen`, `ConversationScreen`, `NewChatScreen` — 1:1 + group chat, directory, connection requests, group invites, live polling |
| Leave | `LeaveScreen` — balances, apply, history, cancel |
| Attendance | `AttendanceScreen` — selfie check-in/out (camera), monthly history |
| Payslips | `PayslipsScreen` — approved/paid payslips with breakdown |
| Calendar | `CalendarScreen` — month view of holidays, events, birthdays, anniversaries |
| Profile | `ProfileScreen` — work + personal details, avatar upload, logout |

Tech: Expo SDK 51, React Navigation (tabs + native stacks), Zustand state,
Axios, `expo-notifications`, `expo-image-picker`.

## Prerequisites

- Node 18+
- A physical Android device (push tokens don't work on emulators) with the
  **Expo Go** app *or* a custom dev build (recommended — see Push below).

## Run in development

```bash
cd mobile
npm install
npx expo start
```

The app **always** talks to the deployed (remote) backend — the URL in
`app.json` → `expo.extra.apiBaseUrl` (the Railway deployment). There is no
local/LAN override, so it works the same on any phone, debug or release. To
point the app at a different deployed backend, change that one value in
`app.json`.

## Run in Android Studio (build & test)

The native Android project is already generated under `mobile/android` (via
`expo prebuild`). To open and run it in Android Studio:

1. **Install deps** (once):
   ```bash
   cd mobile
   npm install
   ```
2. **Open the project**: Android Studio → *Open* → select the `mobile/android`
   folder. Let Gradle sync finish. Requirements: **JDK 17**, **Android SDK 34**,
   an emulator (AVD) or a USB device with USB debugging on.
3. **Start the JS bundler** in a terminal (the debug app loads JS from Metro):
   ```bash
   npx expo start --dev-client
   ```
4. **Run** the app from Android Studio (green ▶) onto the emulator/device. It
   will connect to Metro and load the app.

Or do it all from the CLI (builds, installs, and starts Metro in one step):
```bash
npx expo run:android
```

### "Unable to load script / make sure you're running Metro"

That red screen means a **debug** build couldn't reach the Metro JS bundler.
Debug builds download the JS at runtime; a physical phone can't see Metro on
your PC. Two fixes:

**A. Standalone build (recommended — no PC/Metro needed at runtime).** The
release build embeds the JS bundle, so the app just runs:
```bash
cd F:\SSLLP\HRMS\mobile
npx expo run:android --variant release
# or, from the native project:
cd android && .\gradlew assembleRelease
# → APK at android/app/build/outputs/apk/release/app-release.apk
```
Without release signing configured this falls back to the debug keystore so a
fresh checkout still builds — but **never distribute such a build**. See
*Releasing a new version* below. (First build takes a few minutes.)

**B. Keep the debug build (needs Metro running).** In one terminal:
```bash
npx expo start --dev-client
```
Then let the phone reach Metro:
- USB-connected: `adb reverse tcp:8081 tcp:8081`, then reload (R, R).
- Same Wi-Fi: shake the device → *Settings → Debug server host* → `<your-PC-IP>:8081`.

## Releasing a new version

The app updates itself: **Settings → Check for updates** reads the latest GitHub
release, compares the `versionCode` encoded in the asset filename against the
installed package, and offers the APK. So publishing a release *is* the
distribution — no more sending the file to people.

```bash
# 1. bump BOTH in mobile/app.json:  expo.version  and  expo.android.versionCode
# 2. commit and push (the release tag points at HEAD)
cd android && .\gradlew assembleRelease -x lint -x test --max-workers=2 --no-daemon
cd ..\.. && node scripts/publish-apk.js --notes "What changed"
```

Run it once with `--dry-run` first: that exercises every preflight guard —
built version matches `app.json`, APK newer than `app.json`, not a downgrade,
tag free, working tree clean and pushed — and changes nothing.

Publishing needs a **fine-grained GitHub token** (repo `Yash-SSLLP/HRMS`,
*Contents: Read and write*) in the repo-root `.env` as `GITHUB_TOKEN=…`. That
file is already gitignored.

### Signing — read this before your first release

Distributed builds must be signed with the **private release key**, not the
debug keystore. The debug keystore shipped with React Native is byte-identical
in every RN project on earth and its password is printed in `build.gradle`, so
anyone holding it can build an APK that Android accepts as a genuine upgrade of
`com.ssllp.hrms` — inheriting the signed-in session. That mattered little when
the APK was hand-delivered; it matters now that the app itself offers updates.

Create the key once:

```bash
keytool -genkeypair -v -keystore ssllp-release.jks -alias ssllp \
  -keyalg RSA -keysize 2048 -validity 9125
```

Keep the `.jks` outside the repo, back it up in a password manager, and put the
credentials in `~/.gradle/gradle.properties` (never in the repo):

```properties
SSLLP_RELEASE_STORE_FILE=C:/keys/ssllp-release.jks
SSLLP_RELEASE_STORE_PASSWORD=…
SSLLP_RELEASE_KEY_ALIAS=ssllp
SSLLP_RELEASE_KEY_PASSWORD=…
```

Every release build prints which key it used. If it says it signed with the
public debug key, do not distribute that APK.

> **Losing the keystore is unrecoverable.** Android only installs an update over
> an app signed with the *same* certificate, so a lost or changed key means every
> employee must uninstall and reinstall, losing their login and local state.

### If you ever run `expo prebuild`

`android/` is gitignored and generated, so a prebuild silently reverts several
hand-applied fixes. Adding a native module does **not** need one —
`useExpoModules()` autolinks from `node_modules` at Gradle configure time. If you
do run it, restore: the `signingConfigs.release` block and its `buildTypes`
reference, the `createExpoConfig` task at the end of `app/build.gradle`,
`org.gradle.java.home` / `workers.max` in `gradle.properties`, and
`REQUEST_INSTALL_PACKAGES` in the manifest (it is in `app.json`, so prebuild
regenerates that one correctly).

### Cloud build (no local Android SDK needed)

`eas.json` defines a `preview` profile that produces an installable standalone APK:
```bash
npm i -g eas-cli && eas login
eas build -p android --profile preview
```
EAS creates the project (and fills `extra.eas.projectId`) on first run; download
and install the resulting APK directly on the phone.

Notes:
- Out of the box the app talks to the **deployed Railway backend**, so you can
  log in with real accounts immediately — no local backend needed.
- If you change `app.json` / native config, regenerate the project with
  `npx expo prebuild --platform android --clean`.
- `android/` is git-ignored (it's regenerable from `app.json`).
- A debug run works without Firebase; push tokens just won't register until you
  add `google-services.json` + an FCM key (see below). The app handles this
  gracefully and runs normally.

## Push notifications (FCM via Expo)

Push goes out through Expo's push service, which delivers to Android via **FCM**.
The backend already does the sending (`backend/services/push.js` +
`notify.js`); the app just needs to register a token.

To enable real push you must use a **dev/EAS build** (not Expo Go) and wire up
Firebase:

1. Create an EAS project and put its id in `app.json` →
   `expo.extra.eas.projectId` (replace the all-zeros placeholder).
2. Create a Firebase project, add an Android app with package
   `com.ssllp.hrms`, download `google-services.json`, and upload the FCM
   credentials to EAS:
   ```bash
   npm i -g eas-cli
   eas login
   eas credentials      # choose Android → push notifications → upload FCM key
   ```
3. Build:
   ```bash
   eas build --platform android --profile development   # or: --profile production
   ```
4. Install the resulting APK/AAB on the device, log in, accept the notification
   permission prompt — the device registers itself via
   `POST /api/devices/register`.

> Replace the placeholder art in `assets/` (`icon.png`, `splash.png`,
> `adaptive-icon.png`, `notification-icon.png`) with real branding before a
> production build. The notification icon should be a white, transparent PNG.

## How notifications are triggered (backend)

`backend/services/notify.js` is the single dispatch path — it writes the
in-app `Notification` document **and** pushes to every registered device:

- **Chat** — `sendMessage` / `sendGroupMessage` notify the recipient(s).
- **Events** — `createEvent` fans out to all active users.
- **Holidays** — `createHoliday` announces a newly added holiday; the daily
  worker also notifies everyone on the holiday itself.
- **Birthdays / Anniversaries** — `services/celebrationWorker.js` runs daily
  (after 08:00 IST), guarded by `DigestLog` so each day fires once.

## Production build (Play Store)

```bash
eas build --platform android --profile production
eas submit --platform android
```
