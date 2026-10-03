import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { io, type Socket } from "socket.io-client";
import { api, ApiError } from "./src/api";
import { ago } from "./src/format";
import { LoginScreen } from "./src/screens/LoginScreen";
import { RouteScreen } from "./src/screens/RouteScreen";
import { ShiftScreen } from "./src/screens/ShiftScreen";
import { ChangePassword } from "./src/screens/ChangePassword";
import { CheckCard } from "./src/screens/CheckCard";
import { SignupScreen } from "./src/screens/SignupScreen";
import { StatsScreen } from "./src/screens/StatsScreen";
import { clearSession, lastFix, lastSent, loadSession, readQueue } from "./src/storage";
import { mono, useTheme } from "./src/theme";
import {
  flush, isTracking, permissionStatus, requestPermissions, setupNotifications, startTracking, stopTracking, type PermissionResult,
} from "./src/tracking";
import type { DriverProfile, DriverState, GpsPoint, Session } from "./src/types";
import { Button, Card, Notice } from "./src/ui";

type Gps = { tracking: boolean; fix: GpsPoint | null; queued: number; sentAt: number | null };

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const c = useTheme();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [state, setState] = useState<DriverState | null>(null);
  const [perms, setPerms] = useState<PermissionResult | null>(null);
  const [gps, setGps] = useState<Gps>({ tracking: false, fix: null, queued: 0, sentAt: null });
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [endArmed, setEndArmed] = useState(false);
  const [signupServer, setSignupServer] = useState<string | null>(null);
  const [view, setView] = useState<"today" | "stats">("today");
  const [profile, setProfile] = useState<DriverProfile | null>(null);
  const [checkLater, setCheckLater] = useState(false);

  async function openView(v: "today" | "stats") {
    setView(v);
    if (v === "stats" && session) {
      try { setProfile(await api<DriverProfile>(session, "GET", "/api/driver/profile")); }
      catch (e) { say((e as Error).message, true); }
    }
  }
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), err ? 5000 : 3500);
  }, []);

  const signOutLocal = useCallback(async () => {
    await stopTracking();
    await clearSession();
    setState(null);
    setSession(null);
  }, []);

  const refresh = useCallback(async (s: Session) => {
    try {
      const st = await api<DriverState>(s, "GET", "/api/driver/state");
      setState(st);
      const p = await permissionStatus();
      setPerms(p);
      // Keep the OS tracking task in step with the shift recorded on the server.
      if (st.shift && p.foreground && !(await isTracking())) await startTracking().catch((e) => say(`Couldn't start GPS: ${(e as Error).message}`, true));
      if (!st.shift && (await isTracking())) await stopTracking();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return signOutLocal();
      say((e as Error).message, true);
    }
  }, [say, signOutLocal]);

  // Boot
  useEffect(() => {
    setupNotifications();
    loadSession().then((s) => { setSession(s); if (s) refresh(s); });
  }, [refresh]);

  // Live route pushes while the app is open; background changes arrive as notifications from the tracking task.
  useEffect(() => {
    if (!session) return;
    const socket: Socket = io(session.server, { auth: { token: session.token }, transports: ["websocket"] });
    socket.on("route", () => refresh(session));
    socket.on("connect", () => refresh(session));
    socket.on("connect_error", (e) => { if (e.message === "unauthorized") signOutLocal(); });
    const sub = AppState.addEventListener("change", (a) => { if (a === "active") { refresh(session); flush(); } });
    const slow = setInterval(() => refresh(session), 60e3);
    const upload = setInterval(() => flush(), 10e3);
    return () => { socket.disconnect(); sub.remove(); clearInterval(slow); clearInterval(upload); };
  }, [session, refresh, signOutLocal]);

  // GPS status readout
  useEffect(() => {
    if (!session) return;
    const tick = async () => {
      const [tracking, fix, q, sentAt] = await Promise.all([isTracking(), lastFix(), readQueue(), lastSent()]);
      setGps({ tracking, fix, queued: q.length, sentAt });
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [session]);

  async function act(path: string, body: unknown = {}, success?: string) {
    if (!session) return;
    try {
      setState(await api<DriverState>(session, "POST", path, body));
      if (success) say(success);
    } catch (e) {
      say((e as Error).message, true);
    }
  }

  async function startShift(vehicleId: number) {
    if (!session) return;
    const p = await requestPermissions();
    setPerms(p);
    if (!p.foreground) return say("Allow location so dispatch can see your vehicle.", true);
    try {
      const st = await api<DriverState>(session, "POST", "/api/driver/shift/start", { vehicle_id: vehicleId });
      await startTracking();
      setCheckLater(false);
      setState(st);
      say(p.background ? `Shift started in ${st.vehicle?.code}. You can lock the phone.` : `Shift started. Allow location "all the time" so tracking continues when the phone is locked.`, !p.background);
    } catch (e) {
      say((e as Error).message, true);
    }
  }

  async function endShift() {
    if (!session) return;
    if (!endArmed) { setEndArmed(true); setTimeout(() => setEndArmed(false), 4000); return; }
    setEndArmed(false);
    await flush();
    try {
      setState(await api<DriverState>(session, "POST", "/api/driver/shift/end"));
      await stopTracking();
      say("Shift ended. Location sharing is off.");
    } catch (e) {
      say((e as Error).message, true);
    }
  }

  async function signOut() {
    if (session && state?.shift) {
      await flush();
      await api(session, "POST", "/api/driver/shift/end").catch(() => {});
    }
    await signOutLocal();
  }

  if (session === undefined) return <View style={{ flex: 1, backgroundColor: c.bg }} />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={["top", "bottom"]}>
      <StatusBar style="auto" />
      {!session && signupServer != null ? (
        <SignupScreen server={signupServer} onDone={() => setSignupServer(null)} />
      ) : !session ? (
        <LoginScreen onSignedIn={(s) => { setSession(s); refresh(s); }} onSignup={(server) => setSignupServer(server)} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refresh(session); await flush(); if (view === "stats") await openView("stats"); setRefreshing(false); }} />}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: c.fg, fontSize: 22, fontWeight: "800" }}>Fleetline</Text>
            <Text style={{ color: c.muted }}>{session.user.name}</Text>
          </View>
          <View style={{ flexDirection: "row", borderWidth: 1.5, borderColor: c.line, borderRadius: 12, overflow: "hidden" }} accessibilityRole="tablist">
            {(["today", "stats"] as const).map((v) => (
              <Pressable key={v} onPress={() => openView(v)} accessibilityRole="tab" accessibilityState={{ selected: view === v }}
                style={{ flex: 1, paddingVertical: 11, alignItems: "center", backgroundColor: view === v ? c.fg : c.panel }}>
                <Text style={{ color: view === v ? c.bg : c.muted, fontWeight: "700" }}>{v === "today" ? "Today" : "My stats"}</Text>
              </Pressable>
            ))}
          </View>
          {view === "stats" ? (
            <StatsScreen profile={profile} />
          ) : !state ? (
            <Text style={{ color: c.muted }}>Loading…</Text>
          ) : !state.shift ? (
            <ShiftScreen state={state} perms={perms} onStart={startShift} onSignOut={signOut} />
          ) : (
            <>
              <GpsCard gps={gps} perms={perms} onRetry={() => refresh(session)} />
              {!state.inspection_done && !checkLater ? (
                <CheckCard state={state} onLater={() => setCheckLater(true)} onSubmit={async (items, notes) => {
                  const problems = Object.values(items).filter((x) => x === "issue").length;
                  await act("/api/driver/inspection", { items, notes }, problems ? "Check saved. Dispatch has been told about the problem." : "Check saved. All OK.");
                }} />
              ) : null}
              <RouteScreen state={state} fix={gps.fix} act={act} />
              <Button title={endArmed ? "Tap again to end shift" : `End shift in ${state.vehicle?.code ?? ""}`} kind={endArmed ? "armed" : "danger"} onPress={endShift} />
            </>
          )}
          {state ? <ChangePassword session={session} onChanged={(s) => { setSession(s); say("Password changed. Other devices have been signed out."); }} /> : null}
        </ScrollView>
      )}
      {toast ? (
        <View accessibilityLiveRegion="polite" style={{ position: "absolute", left: 16, right: 16, bottom: 32, padding: 14, borderRadius: 12, backgroundColor: toast.err ? c.crit : c.fg }}>
          <Text style={{ color: toast.err ? "#fff" : c.bg, fontSize: 15, textAlign: "center" }}>{toast.msg}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function GpsCard({ gps, perms, onRetry }: { gps: Gps; perms: PermissionResult | null; onRetry: () => void }) {
  const c = useTheme();
  const fresh = gps.fix && Date.now() - gps.fix.t < 90e3;
  const [label, color] = !gps.tracking ? ["GPS tracking is off", c.crit] : fresh ? ["GPS live", c.ok] : ["Waiting for GPS…", c.warn];
  return (
    <View style={{ gap: 10 }}>
      <Card style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color }} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.fg, fontWeight: "700" }}>{label}</Text>
          <Text style={{ color: c.muted, fontSize: 13 }}>
            {gps.fix ? `±${gps.fix.accuracy ?? "?"} m · ${gps.sentAt ? `sent ${ago(gps.sentAt)}` : "not sent yet"}` : "No fix yet"}
            {gps.queued > 1 ? ` · ${gps.queued} waiting to upload` : ""}
          </Text>
        </View>
        <Text style={[{ color: c.fg, fontSize: 22, fontWeight: "700" }, mono]}>
          {gps.fix?.speed != null && fresh ? Math.round(gps.fix.speed) : "–"}
          <Text style={{ fontSize: 12, color: c.muted }}> km/h</Text>
        </Text>
      </Card>
      {!gps.tracking ? <Button title="Turn GPS back on" kind="primary" onPress={onRetry} /> : null}
      {perms && !perms.background ? (
        <Notice>Tracking pauses when the phone is locked. Set Fleetline's location permission to "Allow all the time" / "Always" in Settings.</Notice>
      ) : null}
    </View>
  );
}
