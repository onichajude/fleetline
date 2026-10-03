import { useEffect, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import type { DriverState } from "../types";
import { Button, Card, Notice } from "../ui";
import { mono, useTheme } from "../theme";
import type { PermissionResult } from "../tracking";

export function ShiftScreen({ state, onStart, onSignOut, perms }: {
  state: DriverState;
  onStart: (vehicleId: number) => Promise<void>;
  onSignOut: () => void;
  perms: PermissionResult | null;
}) {
  const c = useTheme();
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (picked == null && state.vehicles.length) setPicked((state.vehicles.find((v) => v.mine) || state.vehicles[0]).id);
  }, [state.vehicles, picked]);

  return (
    <View style={{ gap: 14 }}>
      <Card>
        <Text style={{ color: c.fg, fontSize: 30, fontWeight: "700" }}>Start your shift</Text>
        <Text style={{ color: c.muted, fontSize: 15, lineHeight: 21 }}>
          Choose the vehicle you're driving. While you're on shift, Fleetline shares your location with dispatch, even when the
          phone is locked. It stops when you end the shift.
        </Text>
        {state.vehicles.length ? (
          <View style={{ gap: 8 }} accessibilityRole="radiogroup">
            {state.vehicles.map((v) => {
              const on = picked === v.id;
              return (
                <Pressable key={v.id} onPress={() => setPicked(v.id)} accessibilityRole="radio" accessibilityState={{ checked: on }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, borderWidth: on ? 2 : 1.5, borderColor: on ? c.accent : c.line, backgroundColor: c.panel }}>
                  <Text style={[{ color: c.fg, fontSize: 17, fontWeight: "700" }, mono]}>{v.code}</Text>
                  <Text style={{ color: c.muted, flexShrink: 1 }} numberOfLines={1}>{v.type}{v.plate ? ` · ${v.plate}` : ""}</Text>
                  {v.mine ? <Text style={{ marginLeft: "auto", color: c.accent, fontWeight: "600", fontSize: 12 }}>Your usual</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Notice>No vehicles are free right now. Ask dispatch to release one.</Notice>
        )}
        <Button title="Start shift & share location" kind="primary" disabled={picked == null} busy={busy}
          onPress={async () => { setBusy(true); try { await onStart(picked!); } finally { setBusy(false); } }} />
      </Card>
      {perms && perms.foreground && !perms.background ? (
        <Notice>
          Location is set to "While using the app", so tracking stops when you lock the phone.{" "}
          {Platform.OS === "android" ? 'In Settings, set Location to "Allow all the time".' : 'In Settings, set Location to "Always".'}
        </Notice>
      ) : null}
      {perms && !perms.foreground ? <Notice tone="crit">Fleetline can't see your location. Allow location access in Settings to start a shift.</Notice> : null}
      {perms && (!perms.background || !perms.foreground) ? <Button title="Open Settings" small onPress={() => Linking.openSettings()} /> : null}
      <Button title="Sign out" small onPress={onSignOut} />
    </View>
  );
}
