import { Platform } from "react-native";

// Shared design tokens so every screen uses one palette, type scale, and touch size.
export const colors = {
  bg: "#0e1116",
  surface: "#161a22",
  surfaceRaised: "#1d222c",
  surfaceSunken: "#0a0d12",
  border: "#262c38",
  borderStrong: "#343b4a",

  text: "#e8ebf0",
  textMuted: "#a3abb9",
  textFaint: "#737c8c",

  accent: "#4c8dff",
  accentSoft: "#1b2b48",
  accentText: "#9cc0ff",
  onAccent: "#ffffff",

  success: "#3ecf8e",
  successSoft: "#12332a",
  warning: "#f0b43c",
  warningSoft: "#3a2c10",
  danger: "#f2685f",
  dangerSoft: "#3a1a1a",
  dangerText: "#ffb4ad",
};

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

// Minimum comfortable touch target (Material / HIG).
export const touch = 44;

export const font = {
  caption: 12,
  small: 13,
  body: 15,
  title: 17,
  heading: 22,
};

export const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});
