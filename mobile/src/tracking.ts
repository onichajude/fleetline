// Background GPS tracking. This module must be imported at app start (see index.ts) so the
// task is defined in the global scope before the OS wakes the app with location updates.
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { api, ApiError } from "./api";
import { appendQueue, clearQueue, dropFromQueue, getRouteSig, loadSession, readQueue, setRouteSig } from "./storage";
import type { GpsPoint, RouteSummary } from "./types";

export const LOCATION_TASK = "fleetline-background-location";
const BATCH = 500;

const toPoint = (l: Location.LocationObject): GpsPoint => ({
  lat: l.coords.latitude,
  lng: l.coords.longitude,
  accuracy: l.coords.accuracy != null ? Math.round(l.coords.accuracy) : null,
  // Devices report -1 or null when speed/heading are unknown; the server derives them instead.
  speed: l.coords.speed != null && l.coords.speed >= 0 ? +(l.coords.speed * 3.6).toFixed(1) : null,
  heading: l.coords.heading != null && l.coords.heading >= 0 ? Math.round(l.coords.heading) : null,
  t: l.timestamp,
});

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  await appendQueue(data.locations.map(toPoint));
  await flush();
});

let flushing: Promise<void> | null = null;

/** Uploads queued fixes. Safe to call from the background task and the UI at the same time. */
export function flush(): Promise<void> {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  const session = await loadSession();
  if (!session) return;
  for (let round = 0; round < 10; round++) {
    const queue = await readQueue();
    if (!queue.length) return;
    const batch = queue.slice(0, BATCH);
    try {
      const res = await api<{ accepted: number; route: RouteSummary }>(session, "POST", "/api/driver/positions", { points: batch });
      await dropFromQueue(batch);
      await noticeRouteChange(res.route);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The shift was ended (by the driver on another device or by an admin): stop tracking.
        await clearQueue();
        await stopTracking();
      }
      return; // offline or server error: keep the queue and retry on the next fix
    }
  }
}

/** Fires a local notification when dispatch sends a new route while the app may be in the background. */
async function noticeRouteChange(r: RouteSummary) {
  const sig = r ? `${r.id}:${r.status}` : "none";
  const prev = await getRouteSig();
  if (prev === sig) return;
  await setRouteSig(sig);
  if (r && r.status === "dispatched" && !prev?.startsWith(`${r.id}:`)) {
    await Notifications.scheduleNotificationAsync({
      content: { title: `New route ${r.code}`, body: `${r.name} · ${r.stops} stops. Open Fleetline to start.` },
      trigger: null,
    }).catch(() => {});
  }
}

export type PermissionResult = { foreground: boolean; background: boolean };

export async function requestPermissions(): Promise<PermissionResult> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return { foreground: false, background: false };
  const bg = await Location.requestBackgroundPermissionsAsync();
  await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }).catch(() => {});
  return { foreground: true, background: bg.status === "granted" };
}

export async function permissionStatus(): Promise<PermissionResult> {
  const [fg, bg] = await Promise.all([Location.getForegroundPermissionsAsync(), Location.getBackgroundPermissionsAsync()]);
  return { foreground: fg.status === "granted", background: bg.status === "granted" };
}

export async function startTracking() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    distanceInterval: 10,
    timeInterval: 10000,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "Fleetline is sharing your location",
      notificationBody: "You're on shift. Dispatch can see your vehicle until you end the shift.",
      notificationColor: "#E0601A",
      killServiceOnDestroy: false,
    },
  });
}

export async function stopTracking() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {}
}

export const isTracking = () => Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);

export async function setupNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
  });
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Route updates",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
    }).catch(() => {});
  }
}
