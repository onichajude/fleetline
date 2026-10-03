import { useState } from "react";
import { Text, View } from "react-native";
import { api } from "../api";
import { saveSession } from "../storage";
import type { Session } from "../types";
import { Button, Card, Field } from "../ui";
import { useTheme } from "../theme";

/** Collapsible "Change password" form. Calls onChanged with the session's new token. */
export function ChangePassword({ session, onChanged }: { session: Session; onChanged: (s: Session) => void }) {
  const c = useTheme();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => { setOpen(false); setCurrent(""); setNext(""); setRepeat(""); setError(""); };

  async function save() {
    setError("");
    if (next !== repeat) return setError("The two new passwords don't match.");
    setBusy(true);
    try {
      const r = await api<{ token: string }>(session, "POST", "/api/me/password", { current_password: current, new_password: next });
      const s = { ...session, token: r.token };
      await saveSession(s);
      close();
      onChanged(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <Button title="Change password" small onPress={() => setOpen(true)} />;
  return (
    <Card>
      <Text style={{ color: c.fg, fontSize: 20, fontWeight: "700" }}>Change password</Text>
      <Text style={{ color: c.muted, fontSize: 13 }}>This signs you out on your other devices.</Text>
      <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password" textContentType="password" />
      <Field label="New password (8+ characters)" value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Field label="Repeat new password" value={repeat} onChangeText={setRepeat} secureTextEntry autoComplete="new-password" textContentType="newPassword" onSubmitEditing={save} />
      {error ? <Text style={{ color: c.crit }} accessibilityLiveRegion="polite">{error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button title="Cancel" onPress={close} style={{ flex: 1 }} />
        <Button title="Save" kind="primary" onPress={save} busy={busy} disabled={!current || next.length < 8 || !repeat} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}
