import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { GpsPoint, Session } from "./types";

const SESSION_KEY = "fleetline.session";
const QUEUE_KEY = "fleetline.queue";
const LAST_FIX_KEY = "fleetline.lastFix";
const LAST_SENT_KEY = "fleetline.lastSent";
const ROUTE_SIG_KEY = "fleetline.routeSig";
const LAST_SERVER_KEY = "fleetline.lastServer";
const MAX_QUEUE = 5000;

// The background task runs while the phone is locked, so the token must stay readable after first unlock.
const secureOpts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

let cached: Session | null | undefined;

export async function loadSession(): Promise<Session | null> {
  if (cached !== undefined) return cached;
  const raw = await SecureStore.getItemAsync(SESSION_KEY, secureOpts);
  cached = raw ? (JSON.parse(raw) as Session) : null;
  return cached;
}
export async function saveSession(s: Session) {
  cached = s;
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s), secureOpts);
  await AsyncStorage.setItem(LAST_SERVER_KEY, s.server);
}
export async function clearSession() {
  cached = null;
  await SecureStore.deleteItemAsync(SESSION_KEY, secureOpts);
  await AsyncStorage.multiRemove([QUEUE_KEY, LAST_FIX_KEY, LAST_SENT_KEY, ROUTE_SIG_KEY]);
}
export const lastServer = () => AsyncStorage.getItem(LAST_SERVER_KEY);

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const readQueue = () => readJson<GpsPoint[]>(QUEUE_KEY, []);
export async function appendQueue(points: GpsPoint[]) {
  if (!points.length) return;
  const q = await readQueue();
  q.push(...points);
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE)));
  await AsyncStorage.setItem(LAST_FIX_KEY, JSON.stringify(points[points.length - 1]));
}
/** Removes points that were uploaded, matched by timestamp, so fixes queued during the upload survive. */
export async function dropFromQueue(sent: GpsPoint[]) {
  const done = new Set(sent.map((p) => `${p.t}:${p.lat}:${p.lng}`));
  const q = await readQueue();
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q.filter((p) => !done.has(`${p.t}:${p.lat}:${p.lng}`))));
  await AsyncStorage.setItem(LAST_SENT_KEY, String(Date.now()));
}
export const clearQueue = () => AsyncStorage.removeItem(QUEUE_KEY);
export const lastFix = () => readJson<GpsPoint | null>(LAST_FIX_KEY, null);
export const lastSent = async () => Number((await AsyncStorage.getItem(LAST_SENT_KEY)) || 0) || null;
export const getRouteSig = () => AsyncStorage.getItem(ROUTE_SIG_KEY);
export const setRouteSig = (s: string) => AsyncStorage.setItem(ROUTE_SIG_KEY, s);
