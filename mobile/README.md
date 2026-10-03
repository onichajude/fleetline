# Fleetline Driver (native app)

iOS and Android driver app built with Expo (SDK 57) and React Native. It talks to the same API as the web
driver app, but keeps tracking **in the background** with the phone locked.

## What it does

- Sign in with the server address, username and password the dispatcher gives you.
- Start a shift in a vehicle. The app asks for location **Always / Allow all the time**, then tracks in the background:
  - **Android:** a foreground service with a persistent "Fleetline is sharing your location" notification.
  - **iOS:** background location mode, with the blue location indicator in the status bar.
- Fixes are recorded every 10 m (at most every 10 s on Android), queued on the device and uploaded in batches.
  With no signal, they upload when the phone reconnects (up to 5,000 fixes are kept).
- When dispatch sends a new route while the app is in the background, the phone shows a notification.
- Next-stop card with **Navigate** (Google Maps / Apple Maps), **I've arrived**, **Delivered** with a note, and
  **Skip** with a reason. Arrival is also detected automatically by the server's geofence.
- **End shift** stops tracking. Location is never sent outside a shift.

## Project layout

```
index.ts            Entry point; loads the background task before the UI
App.tsx             Session, live updates, GPS status, shift control
src/tracking.ts     Background location task, upload queue, route-change notifications
src/storage.ts      Session in the secure keychain/keystore; GPS queue in AsyncStorage
src/api.ts          API client
src/screens/        Sign-in, start-shift and route screens
app.config.ts       Permissions, background modes, config plugins
eas.json            Cloud build profiles
```

## Build and install

Background location doesn't work in Expo Go, so you need a build of the app. You don't need Android Studio or
Xcode: Expo's EAS service builds in the cloud (free tier available).

1. Install dependencies:

   ```bash
   npm install
   ```

2. Sign in to Expo (create a free account at expo.dev first) and link the project:

   ```bash
   npx eas-cli@latest login
   ```

   ```bash
   npx eas-cli@latest init
   ```

3. **Android test build:** produces an `.apk` you can install directly on any Android phone:

   ```bash
   npx eas-cli@latest build -p android --profile preview
   ```

   Open the link EAS prints on the phone and install the APK.

4. **iOS test build:** requires an Apple Developer account ($99/year). Register test devices, then build:

   ```bash
   npx eas-cli@latest device:create
   ```

   ```bash
   npx eas-cli@latest build -p ios --profile preview
   ```

5. **Development build** (live-reload while you change the code):

   ```bash
   npx eas-cli@latest build -p android --profile development
   ```

   ```bash
   npx expo start --dev-client
   ```

### Pointing the app at your server

On the sign-in screen, enter the backend address:

- **Production:** your HTTPS address, e.g. `https://fleet.yourcompany.com`.
- **Testing on your network:** the `development` and `preview` builds allow plain HTTP, so you can use your computer's
  LAN address, e.g. `http://192.168.1.20:4000` (phone and computer on the same Wi-Fi; allow port 4000 through the firewall).
  Production builds require HTTPS.

To pre-fill the address, set `FLEETLINE_SERVER_URL` when building, e.g. in the `env` block of a profile in `eas.json`.

### Before publishing to the stores

- Set your own bundle ID / package name: `FLEETLINE_BUNDLE_ID=com.yourcompany.fleetline` (or edit `app.config.ts`).
- Replace the placeholder icons in `assets/`.
- Both stores review background-location apps. Google Play requires a background-location declaration form and a
  short video showing the feature; Apple requires a clear reason in the permission text (already set in `app.config.ts`).
- Build with `npx eas-cli@latest build --profile production` and submit with `npx eas-cli@latest submit`.

## Known limits

- If the driver **force-quits** the app (swipes it away), the OS stops background location. The server shows the vehicle
  as "No signal" after 3 minutes, and tracking resumes when the app is opened again.
- Some Android manufacturers (Xiaomi, Huawei, Samsung power saving) stop background services aggressively. Drivers may
  need to set Fleetline's battery usage to "Unrestricted".

## Checks

```bash
npm run typecheck
```

```bash
npx expo-doctor
```
