import { useState } from "react";
import { Linking, Platform, Pressable, Text, TextInput, View } from "react-native";
import type { DriverState, GpsPoint, Stop } from "../types";
import { Button, Card } from "../ui";
import { mono, useTheme, type Palette } from "../theme";
import { distanceM, fmtDistance, hm } from "../format";

const SKIP_REASONS = ["Customer closed", "No one to receive", "Access blocked", "Wrong address", "Out of time", "Damaged goods"];

const stopColor = (c: Palette, s: Stop) => ({ pending: c.info, arrived: c.accent, completed: c.ok, skipped: c.idle })[s.status];
const stopLabel = (s: Stop) => ({ pending: "", arrived: "On site", completed: "Delivered", skipped: "Skipped" })[s.status];

function openNavigation(s: Stop) {
  const url = Platform.OS === "ios"
    ? `http://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d`
    : `google.navigation:q=${s.lat},${s.lng}`;
  Linking.openURL(url).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`));
}

export function RouteScreen({ state, fix, act }: {
  state: DriverState;
  fix: GpsPoint | null;
  act: (path: string, body?: unknown, success?: string) => Promise<void>;
}) {
  const c = useTheme();
  const [note, setNote] = useState("");
  const [skipFor, setSkipFor] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } finally { setBusy(null); } };

  const r = state.route;
  if (!r) {
    const f = state.finished;
    if (f) {
      const n = (k: Stop["status"]) => f.stops.filter((s) => s.status === k).length;
      return (
        <Card>
          <Text style={{ color: c.muted, fontWeight: "600" }}>{f.code} · {f.status === "cancelled" ? "cancelled by dispatch" : "complete"}</Text>
          <Text style={{ color: c.fg, fontSize: 28, fontWeight: "700" }}>{f.status === "cancelled" ? "Route cancelled" : "All stops done"}</Text>
          <Text style={{ color: c.muted, fontSize: 15 }}>
            {n("completed")} delivered{n("skipped") ? `, ${n("skipped")} skipped` : ""}. {f.depot_name ? `Head back to ${f.depot_name}. ` : ""}
            You'll get a notification when the next route arrives.
          </Text>
        </Card>
      );
    }
    return (
      <Card>
        <Text style={{ color: c.muted, fontWeight: "600" }}>{state.vehicle?.code}</Text>
        <Text style={{ color: c.fg, fontSize: 28, fontWeight: "700" }}>No route yet</Text>
        <Text style={{ color: c.muted, fontSize: 15 }}>You can lock the phone. You'll get a notification as soon as dispatch sends your stops.</Text>
      </Card>
    );
  }

  const list = (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.muted, fontWeight: "700", letterSpacing: 1, fontSize: 13 }}>{r.code} · {r.name.toUpperCase()}</Text>
      <Card style={{ paddingVertical: 4 }}>
        {r.stops.map((s, i) => (
          <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: stopColor(c, s), alignItems: "center", justifyContent: "center" }}>
              <Text style={[{ color: "#fff", fontWeight: "700", fontSize: 12 }, mono]}>{s.seq}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: ["completed", "skipped"].includes(s.status) ? c.muted : c.fg, fontWeight: "500", fontSize: 15 }}>{s.name}</Text>
              <Text style={[{ color: c.muted, fontSize: 13 }, mono]}>{s.arrived_at ? `Arrived ${hm(s.arrived_at)}` : `Due ${hm(s.planned_at)}`}</Text>
            </View>
            <Text style={{ color: stopColor(c, s), fontWeight: "600", fontSize: 13 }}>{stopLabel(s)}</Text>
          </View>
        ))}
      </Card>
    </View>
  );

  if (r.status === "dispatched") {
    return (
      <View style={{ gap: 14 }}>
        <Card accent>
          <Text style={{ color: c.accent, fontWeight: "700", letterSpacing: 1, fontSize: 12 }}>NEW ROUTE · {r.code}</Text>
          <Text style={{ color: c.fg, fontSize: 28, fontWeight: "700" }}>{r.name}</Text>
          <Text style={{ color: c.muted, fontSize: 15 }}>
            {r.stops.length} stops{r.geometry?.meters ? ` · ${(r.geometry.meters / 1000).toFixed(1)} km` : ""} · first stop {r.stops[0]?.name}
          </Text>
          <Button title="Start route" kind="primary" busy={busy === "start"} onPress={() => run("start", () => act(`/api/driver/route/${r.id}/start`, {}, "Route started. Drive safe."))} />
        </Card>
        {list}
      </View>
    );
  }

  const cur = r.stops.find((s) => s.status === "arrived") || r.stops.find((s) => s.status === "pending");
  const lateBy = cur?.planned_at ? Math.round((Date.now() - cur.planned_at) / 60e3) : 0;
  return (
    <View style={{ gap: 14 }}>
      {cur ? (
        <Card accent>
          <Text style={{ color: c.accent, fontWeight: "700", letterSpacing: 1, fontSize: 12 }}>
            STOP {cur.seq} OF {r.stops.length}{cur.status === "arrived" ? " · ON SITE" : ""}
          </Text>
          <Text style={{ color: c.fg, fontSize: 28, fontWeight: "700" }}>{cur.name}</Text>
          {cur.address ? <Text style={{ color: c.muted }}>{cur.address}</Text> : null}
          <Text style={{ color: c.muted, fontSize: 15 }}>
            Due <Text style={[{ color: c.fg, fontWeight: "600" }, mono]}>{hm(cur.planned_at)}</Text>
            {lateBy > 0 && cur.status === "pending" ? <Text style={{ color: c.warn }}>{`  (${lateBy} min behind)`}</Text> : null}
            {fix ? `   ·   ${fmtDistance(distanceM(fix, cur))} away` : ""}
          </Text>
          {cur.status === "pending" ? (
            <>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Button title="Navigate" onPress={() => openNavigation(cur)} style={{ flex: 1 }} />
                <Button title="I've arrived" kind="go" style={{ flex: 1 }} busy={busy === "arrive"}
                  onPress={() => run("arrive", () => act(`/api/driver/stops/${cur.id}/arrive`))} />
              </View>
              <Text style={{ color: c.muted, fontSize: 13 }}>Arrival is marked automatically within {state.config.geofenceM} m of the stop.</Text>
            </>
          ) : (
            <>
              <TextInput value={note} onChangeText={setNote} multiline placeholder="Delivery note (optional): who signed, where you left it…"
                placeholderTextColor={c.idle} accessibilityLabel="Delivery note"
                style={{ minHeight: 76, borderWidth: 1.5, borderColor: c.line, borderRadius: 12, padding: 12, color: c.fg, fontSize: 16, textAlignVertical: "top" }} />
              <Button title="Delivered" kind="go" busy={busy === "complete"}
                onPress={() => run("complete", async () => { await act(`/api/driver/stops/${cur.id}/complete`, { note }, "Delivery saved"); setNote(""); })} />
            </>
          )}
          {skipFor === cur.id ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: c.fg, fontWeight: "600" }}>Why can't you deliver?</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {SKIP_REASONS.map((x) => (
                  <Pressable key={x} onPress={() => setReason(x)} accessibilityRole="radio" accessibilityState={{ checked: reason === x }}
                    style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999, borderWidth: 1.5, borderColor: reason === x ? c.crit : c.line, backgroundColor: reason === x ? c.crit : c.panel }}>
                    <Text style={{ color: reason === x ? "#fff" : c.fg, fontSize: 14 }}>{x}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Button title="Keep stop" style={{ flex: 1 }} onPress={() => { setSkipFor(null); setReason(""); }} />
                <Button title="Skip stop" kind="armed" style={{ flex: 1 }} disabled={!reason} busy={busy === "skip"}
                  onPress={() => run("skip", async () => { await act(`/api/driver/stops/${cur.id}/skip`, { reason }, "Stop skipped. Dispatch has been told."); setSkipFor(null); setReason(""); })} />
              </View>
            </View>
          ) : (
            <Button title="Can't deliver? Skip stop" kind="danger" small onPress={() => { setSkipFor(cur.id); setReason(""); }} />
          )}
        </Card>
      ) : (
        <Card><Text style={{ color: c.fg, fontSize: 26, fontWeight: "700" }}>All stops done</Text><Text style={{ color: c.muted }}>Head back to {r.depot_name || "the depot"}.</Text></Card>
      )}
      {list}
    </View>
  );
}
