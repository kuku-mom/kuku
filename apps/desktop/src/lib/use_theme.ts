import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { registerCommand, unregisterCommand } from "~/keybindings/command_registry";
import { addKeybinding, removeKeybinding } from "~/keybindings/keybinding_manager";

// ── Types ──

export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

export interface UseThemeReturn {
  /** Current preference (system | light | dark) */
  preference: Accessor<ThemePreference>;
  /** Resolved theme after applying system detection */
  effectiveTheme: Accessor<EffectiveTheme>;
  /** Set theme preference */
  setTheme: (theme: ThemePreference) => void;
  /** Toggle between light and dark (ignores system) */
  toggleTheme: () => void;
}

// ── Constants ──

const STORAGE_KEY = "theme-preference";
const BG_COLORS: Record<EffectiveTheme, string> = {
  dark: "#1a1a1a",
  light: "#ffffff",
};

// ── Helpers ──

function loadPreference(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark" || saved === "system") {
    return saved;
  }
  return "system";
}

/** Update inline styles on <html> and <body> to prevent flash on resize / theme switch. */
function applyBgColor(theme: EffectiveTheme): void {
  const color = BG_COLORS[theme];
  document.documentElement.style.backgroundColor = color;
  document.documentElement.style.colorScheme = theme;
  document.body.style.backgroundColor = color;

  // Update <meta name="theme-color"> if it exists
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = color;
  }
}

// ── Hook ──

export function useTheme(): UseThemeReturn {
  const [preference, setPreference] = createSignal<ThemePreference>(loadPreference());
  const [systemTheme, setSystemTheme] = createSignal<EffectiveTheme>("dark");

  // Fetch initial system theme from Tauri
  const win = getCurrentWindow();
  void win.theme().then((theme) => {
    setSystemTheme(theme === "light" ? "light" : "dark");
  });

  // Listen for native theme changes
  let unlisten: (() => void) | undefined;
  void win
    .onThemeChanged(({ payload }) => {
      setSystemTheme(payload === "light" ? "light" : "dark");
    })
    .then((fn) => {
      unlisten = fn;
    });
  onCleanup(() => unlisten?.());

  // Resolve effective theme
  const effectiveTheme = createMemo<EffectiveTheme>(() => {
    const pref = preference();
    if (pref === "system") {
      return systemTheme();
    }
    return pref;
  });

  // Apply theme to DOM whenever it changes
  createEffect(() => {
    const theme = effectiveTheme();

    // Set data-theme attribute (light sets it, dark removes it — dark is default in CSS)
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }

    // Prevent flash on webview resize
    applyBgColor(theme);

    // Persist preference
    localStorage.setItem(STORAGE_KEY, preference());
  });

  const setTheme = (newTheme: ThemePreference): void => {
    setPreference(newTheme);
  };

  const toggleTheme = (): void => {
    setPreference(effectiveTheme() === "dark" ? "light" : "dark");
  };

  // ── Register theme command ──
  registerCommand({
    id: "app.toggleTheme",
    label: "Toggle Theme",
    execute: () => toggleTheme(),
  });
  addKeybinding({
    keys: "$mod+Shift+KeyT",
    commandId: "app.toggleTheme",
  });
  onCleanup(() => {
    unregisterCommand("app.toggleTheme");
    removeKeybinding("$mod+Shift+KeyT");
  });

  return {
    preference,
    effectiveTheme,
    setTheme,
    toggleTheme,
  };
}
