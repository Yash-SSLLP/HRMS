# Mobile App — the released Android build

The APK in this folder **is** the release. There is no upload step, no API key
and no dashboard: the backend serves whatever build is sitting here, so
publishing an update to every phone is a commit and a deploy.

```
build the APK  ->  copy it here  ->  commit + push  ->  deploy on the VPS  ->  phones see it
```

## How the app finds it

The Android app is sideloaded, so nothing tells a phone that a new build exists —
it asks. **Settings → Check for updates** calls two public endpoints:

| Route | Answers |
|---|---|
| `GET /api/app/latest` | the newest build here: version, versionCode, size, notes |
| `GET /api/app/download` | the APK itself |

The app compares the `versionCode` against its own installed package and offers
the download only when this one is **higher**. Android refuses to install a lower
versionCode over a higher one, so a downgrade could only ever fail on the phone.

Both routes are public on purpose: the check runs when the app opens, which can
be before anyone has logged in, and a 401 travelling back through the app's auth
interceptor would sign the user out for checking for updates.

## The filename is the contract

```
hrms-<versionName>-<versionCode>.apk      e.g. hrms-2.2.4-50.apk
```

A folder carries no metadata, so the version has to travel in the name — the
backend parses it (`services/appReleaseStore.js`), and so do the mobile build
scripts. A file named anything else is invisible to the update channel.

`release.json` is optional and supplies the "what changed" text the app shows:

```json
{ "versionName": "2.2.4", "versionCode": 50, "notes": "…" }
```

Its `versionCode` must match the APK's, or the notes are ignored rather than
shown against the wrong build.

## Keep exactly one build here

Replace the APK, never accumulate. Two reasons:

1. **Git never forgets.** Every APK ever committed stays in history at ~69 MB,
   on every clone, forever — deleting the file later frees nothing. This repo
   already carries several from before this folder existed.
2. If several are present the backend serves the **highest versionCode**, so an
   old one is dead weight rather than a fallback.

## Publishing a build

From `mobile/`, with the release keystore configured:

```bash
npm run bump                 # 2.2.4 -> 2.2.5, both version files at once
cd android && ./gradlew assembleRelease
cd .. && npm run release     # dry run: checks the APK, then stages it here
npm run release -- --publish
```

Then commit and deploy:

```bash
git add "Mobile App" && git commit -m "release 2.2.5" && git push
ssh root@YOUR_VPS_IP '/var/www/deploy-hrms.sh'
```

Two things that silently break a release, both checked by `npm run release`:

- **The version must be bumped in two files** — `mobile/app.json` and
  `mobile/android/app/build.gradle`. Bump only the first and the APK reports the
  new version on its own settings screen while Android still stamps the old
  `versionCode`; the updater compares versionCode, sees no change, and offers
  nobody the update.
- **Every build machine needs the same signing key.** An APK signed with a
  different key — including the stock debug key on a PC with no keystore —
  cannot install over the existing app. Android refuses with "App not installed"
  and the only way out is uninstall/reinstall, which loses the login.

## Server side

One environment variable in `backend/.env`:

```
APP_RELEASE_STORE=repo
```

It defaults to this folder inside the checkout, so nothing else is needed.
`APP_RELEASE_DIR` overrides the location if you ever move it.
