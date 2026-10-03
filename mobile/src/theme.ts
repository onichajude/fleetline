import { useColorScheme } from "react-native";

const light = {
  bg: "#eef1f5", panel: "#ffffff", panel2: "#f3f5f8", fg: "#141c26", muted: "#5a6778", line: "#d6dde6",
  accent: "#e0601a", accentInk: "#ffffff", ok: "#1f8a52", warn: "#a87500", crit: "#cc3434", info: "#2c68bd", idle: "#8693a3",
};
const dark: typeof light = {
  bg: "#0c1117", panel: "#151c25", panel2: "#1c2531", fg: "#e8edf2", muted: "#93a0b0", line: "#2a3544",
  accent: "#f47c35", accentInk: "#1a0d04", ok: "#3fbd7b", warn: "#e2b23a", crit: "#f2605e", info: "#5f9ef0", idle: "#6f7d8e",
};
export type Palette = typeof light;
export const useTheme = (): Palette => (useColorScheme() === "dark" ? dark : light);

export const mono = { fontFamily: "monospace", fontVariant: ["tabular-nums" as const] };
