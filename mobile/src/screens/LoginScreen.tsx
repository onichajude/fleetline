import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import Constants from "expo-constants";
import { normalizeServer, request } from "../api";
import { lastServer, saveSession } from "../storage";
import type { Session, User } from "../types";
import { Button, Field } from "../ui";
import { useTheme } from "../theme";

export function LoginScreen({ onSignedIn, onSignup }: { onSignedIn: (s: Session) => void; onSignup: (server: string) => void }) {
  const c = useTheme();
  const defaultServer = (Constants.expoConfig?.extra?.defaultServer as string | undefined) || "";
  const [server, setServer] = useState(defaultServer);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { lastServer().then((s) => s && setServer(s)); }, []);

  async function submit() {
    setError("");
    const base = normalizeServer(server);
    if (!base) return setError("Enter your company's Fleetline server address.");
    setBusy(true);
    try {
      const res = await request<{ token: string; user: User }>(base, null, "POST", "/api/auth/login", { username: username.trim(), password, app: "driver" });
      const s = { server: base, token: res.token, user: res.user };
      await saveSession(s);
      onSignedIn(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 60, gap: 16 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.accent, fontWeight: "700", fontSize: 15, letterSpacing: 1 }}>FLEETLINE DRIVER</Text>
        <Text style={{ color: c.fg, fontSize: 32, fontWeight: "700" }}>Sign in</Text>
        <Field label="Server address" value={server} onChangeText={setServer} placeholder="https://fleet.yourcompany.com"
          autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" />
        <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" autoComplete="username" />
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="password" onSubmitEditing={submit} returnKeyType="go" />
        {error ? <Text style={{ color: c.crit, fontSize: 15 }} accessibilityLiveRegion="polite">{error}</Text> : null}
        <Button title="Sign in" kind="primary" onPress={submit} busy={busy} disabled={!username || !password} />
        <Button title="New driver? Request an account" onPress={() => onSignup(server)} />
        <View style={{ marginTop: 8 }}>
          <Text style={{ color: c.muted, fontSize: 13, lineHeight: 19 }}>
            Your dispatcher gives you the server address and your username. Location is shared only while you are on shift.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
