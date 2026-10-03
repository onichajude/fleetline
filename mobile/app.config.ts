import type { ExpoConfig } from "expo/config";

// Development and preview builds may talk to a plain-http server on your LAN for testing.
// Production builds require https.
const allowHttp = process.env.FLEETLINE_ALLOW_HTTP === "1";

// Change these to identifiers you own before publishing to the stores.
const bundleId = process.env.FLEETLINE_BUNDLE_ID || "com.example.fleetline.driver";

const config: ExpoConfig = {
  name: "Fleetline Driver",
  slug: "fleetline-driver",
  scheme: "fleetline",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: bundleId,
    supportsTablet: false,
    infoPlist: {
      UIBackgroundModes: ["location", "fetch"],
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    },
  },
  android: {
    package: bundleId,
    adaptiveIcon: {
      backgroundColor: "#17202B",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    permissions: [
      "ACCESS_FINE_LOCATION",
      "ACCESS_COARSE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "POST_NOTIFICATIONS",
    ],
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    [
      "expo-location",
      {
        locationWhenInUsePermission: "Fleetline shares your location with dispatch while you're on shift.",
        locationAlwaysAndWhenInUsePermission:
          "Fleetline keeps sharing your location while you're on shift, even with the phone locked, so dispatch can track deliveries. It stops when you end your shift.",
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    ["expo-notifications", { color: "#E0601A" }],
    ["expo-build-properties", { android: { usesCleartextTraffic: allowHttp } }],
    "expo-secure-store",
  ],
  extra: {
    // Pre-fills the server field on the sign-in screen.
    defaultServer: process.env.FLEETLINE_SERVER_URL || "",
  },
};

export default config;
