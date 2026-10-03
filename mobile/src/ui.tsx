import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { useTheme } from "./theme";

type BtnKind = "default" | "primary" | "go" | "danger" | "armed";
export function Button({ title, onPress, kind = "default", disabled, busy, small, style }: {
  title: string; onPress: () => void; kind?: BtnKind; disabled?: boolean; busy?: boolean; small?: boolean; style?: ViewStyle;
}) {
  const c = useTheme();
  const bg = { default: c.panel, primary: c.accent, go: c.ok, danger: c.panel, armed: c.crit }[kind];
  const fg = { default: c.fg, primary: c.accentInk, go: "#fff", danger: c.crit, armed: "#fff" }[kind];
  const border = kind === "default" ? c.line : kind === "danger" ? c.crit : bg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, small && s.btnSm, { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, small && { fontSize: 14 }, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style, accent }: { children: React.ReactNode; style?: ViewStyle; accent?: boolean }) {
  const c = useTheme();
  return <View style={[s.card, { backgroundColor: c.panel, borderColor: accent ? c.accent : c.line, borderWidth: accent ? 2 : 1 }, style]}>{children}</View>;
}

export function Field(props: TextInputProps & { label: string }) {
  const c = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.muted, fontSize: 14 }}>{label}</Text>
      <TextInput placeholderTextColor={c.idle} {...rest} style={[s.input, { borderColor: c.line, backgroundColor: c.panel, color: c.fg }, style]} />
    </View>
  );
}

export function Notice({ children, tone = "warn" }: { children: React.ReactNode; tone?: "warn" | "crit" | "info" }) {
  const c = useTheme();
  const col = c[tone];
  return (
    <View style={[s.notice, { borderColor: col, backgroundColor: c.panel }]}>
      <Text style={{ color: c.fg, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  btn: { minHeight: 52, borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 18, alignItems: "center", justifyContent: "center" },
  btnSm: { minHeight: 40, paddingHorizontal: 14, alignSelf: "flex-start" },
  btnText: { fontSize: 16, fontWeight: "600" },
  card: { borderRadius: 14, padding: 16, gap: 10 },
  input: { borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 17 },
  notice: { borderWidth: 1.5, borderRadius: 12, padding: 12 },
});
