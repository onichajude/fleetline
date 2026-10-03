import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { normalizeServer, request } from "../api";
import { Button, Card, Field } from "../ui";
import { useTheme } from "../theme";

const TYPES = [["either", "Truck or van"], ["truck", "Truck"], ["van", "Van"]] as const;

/** Self sign-up. The account stays pending until an admin approves it and assigns a vehicle. */
export function SignupScreen({ server: initialServer, onDone }: { server: string; onDone: () => void }) {
  const c = useTheme();
  const [f, setF] = useState({ server: initialServer, name: "", phone: "", license_no: "", vehicle_type: "either", username: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  async function submit() {
    setError("");
    const base = normalizeServer(f.server);
    if (!base) return setError("Enter your company's Fleetline server address.");
    setBusy(true);
    try {
      const { server, ...body } = f;
      void server;
      const r = await request<{ message: string }>(base, null, "POST", "/api/auth/register", { ...body, username: f.username.trim().toLowerCase() });
      setSent(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <View style={{ padding: 20, paddingTop: 60, gap: 16 }}>
        <Card>
          <Text style={{ color: c.fg, fontSize: 28, fontWeight: "700" }}>Request sent</Text>
          <Text style={{ color: c.fg, fontSize: 16 }}>{sent}</Text>
          <Text style={{ color: c.muted }}>Your username is {f.username.trim().toLowerCase()}. Sign in once your dispatcher approves you.</Text>
          <Button title="Back to sign in" kind="primary" onPress={onDone} />
        </Card>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 40, gap: 14 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.fg, fontSize: 30, fontWeight: "700" }}>Request an account</Text>
        <Text style={{ color: c.muted, fontSize: 15 }}>Your dispatcher reviews new drivers and assigns your vehicle.</Text>
        <Field label="Server address" value={f.server} onChangeText={set("server")} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://fleet.yourcompany.com" />
        <Field label="Full name" value={f.name} onChangeText={set("name")} autoComplete="name" textContentType="name" />
        <Field label="Phone" value={f.phone} onChangeText={set("phone")} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" />
        <Field label="Driver's licence number (optional)" value={f.license_no} onChangeText={set("license_no")} autoCapitalize="characters" />
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.muted, fontSize: 14 }}>I'll mainly drive</Text>
          <View style={{ flexDirection: "row", gap: 8 }} accessibilityRole="radiogroup">
            {TYPES.map(([k, label]) => (
              <Pressable key={k} onPress={() => set("vehicle_type")(k)} accessibilityRole="radio" accessibilityState={{ checked: f.vehicle_type === k }}
                style={{ flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, alignItems: "center", borderColor: f.vehicle_type === k ? c.accent : c.line, backgroundColor: f.vehicle_type === k ? c.accent : c.panel }}>
                <Text style={{ color: f.vehicle_type === k ? c.accentInk : c.fg, fontWeight: "600" }}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <Field label="Choose a username" value={f.username} onChangeText={set("username")} autoCapitalize="none" autoCorrect={false} textContentType="username" />
        <Field label="Choose a password (8+ characters)" value={f.password} onChangeText={set("password")} secureTextEntry textContentType="newPassword" autoComplete="new-password" />
        {error ? <Text style={{ color: c.crit, fontSize: 15 }} accessibilityLiveRegion="polite">{error}</Text> : null}
        <Button title="Send request" kind="primary" onPress={submit} busy={busy} disabled={!f.name || !f.phone || !f.username || f.password.length < 8} />
        <Button title="Back to sign in" onPress={onDone} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
