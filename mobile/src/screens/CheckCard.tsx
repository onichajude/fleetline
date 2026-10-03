import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { DriverState } from "../types";
import { Button, Card } from "../ui";
import { useTheme } from "../theme";

/** Pre-trip vehicle check shown at the start of a shift. Problems alert dispatch. */
export function CheckCard({ state, onSubmit, onLater }: {
  state: DriverState;
  onSubmit: (items: Record<string, "ok" | "issue">, notes: string) => Promise<void>;
  onLater: () => void;
}) {
  const c = useTheme();
  const [items, setItems] = useState<Record<string, "ok" | "issue">>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const all = state.inspection_items.every(([k]) => items[k]);
  const anyIssue = Object.values(items).includes("issue");

  return (
    <Card style={{ borderColor: c.warn, borderWidth: 2 }}>
      <Text style={{ color: c.fg, fontSize: 20, fontWeight: "700" }}>Pre-trip check · {state.vehicle?.code}</Text>
      <Text style={{ color: c.muted, fontSize: 14 }}>Walk around the vehicle before you drive. Problems go straight to dispatch.</Text>
      {state.inspection_items.map(([k, label], i) => (
        <View key={k} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
          <Text style={{ color: c.fg, fontSize: 15, flexShrink: 1 }}>{label}</Text>
          <View style={{ flexDirection: "row", gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
            {(["ok", "issue"] as const).map((v) => {
              const on = items[k] === v, col = v === "ok" ? c.ok : c.crit;
              return (
                <Pressable key={v} onPress={() => setItems((x) => ({ ...x, [k]: v }))} accessibilityRole="radio" accessibilityState={{ checked: on }}
                  style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, borderWidth: 1.5, borderColor: on ? col : c.line, backgroundColor: on ? col : c.panel }}>
                  <Text style={{ color: on ? "#fff" : c.fg, fontWeight: "600" }}>{v === "ok" ? "OK" : "Problem"}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      {anyIssue ? (
        <TextInput value={notes} onChangeText={setNotes} multiline placeholder="What's wrong? e.g. front left tyre low" placeholderTextColor={c.idle}
          accessibilityLabel="Describe the problem"
          style={{ minHeight: 70, borderWidth: 1.5, borderColor: c.line, borderRadius: 12, padding: 12, color: c.fg, fontSize: 16, textAlignVertical: "top" }} />
      ) : null}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button title="Later" onPress={onLater} style={{ flex: 1 }} />
        <Button title="Submit check" kind="primary" style={{ flex: 1 }} busy={busy} disabled={!all || (anyIssue && !notes.trim())}
          onPress={async () => { setBusy(true); try { await onSubmit(items, notes.trim()); } finally { setBusy(false); } }} />
      </View>
    </Card>
  );
}
