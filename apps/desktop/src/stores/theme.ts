import { getCurrentWindow } from "@tauri-apps/api/window";
import { createEffect, createSignal } from "solid-js";

import {
  setAppearanceSetting,
  settingsState,
  type EffectiveTheme,
  type ThemePreference,
} from "~/stores/settings";

// ── System dark mode detection (module-level, app lifetime) ──

const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
const [systemIsDark, setSystemIsDark] = createSignal(mediaQuery.matches);
mediaQuery.addEventListener("change", (e: MediaQueryListEvent) => setSystemIsDark(e.matches));

// ── Constants ──

const BG_COLORS: Record<EffectiveTheme, string> = {
  dark: "#1a1a1a",
  light: "#ffffff",
};

const BASE_WRITING_THEME_VARS: Record<string, string> = {
  "--color-bg-primary": "#ffffff",
  "--color-bg-secondary": "#f7f6f3",
  "--color-bg-tertiary": "#efeeea",
  "--color-bg-elevated": "#ffffff",
  "--color-element": "#ffffff",
  "--color-element-hover": "#f7f6f3",
  "--color-element-active": "#efeeea",
  "--color-element-selected": "#f1f1ef",
  "--color-element-disabled": "#f7f6f3",
  "--color-text-primary": "#37352f",
  "--color-text-secondary": "#6b6963",
  "--color-text-muted": "#9b9790",
  "--color-text-placeholder": "#b8b3aa",
  "--color-text-disabled": "#cac5ba",
  "--color-text-accent": "#2f3437",
  "--color-icon": "#6b6963",
  "--color-icon-muted": "#9b9790",
  "--color-icon-disabled": "#cac5ba",
  "--color-icon-accent": "#2f3437",
  "--color-border": "#e3e2de",
  "--color-border-variant": "#eeeeeb",
  "--color-border-focused": "#a7a39b",
  "--color-border-selected": "#78746b",
  "--editor-table-border": "#e3e2de",
  "--color-kuku-mark-body": "#5f5a52",
  "--color-kuku-mark-eye": "#ffffff",
  "--color-kuku-mark-pupil": "#37352f",
  "--color-kuku-mark-mouth": "#ffffff",
  "--color-kuku-mark-spark": "#ffffff",
  "--color-kuku-mark-stroke": "#f7f6f3",
  "--color-error": "#b94a48",
  "--color-error-bg": "rgba(185, 74, 72, 0.1)",
  "--color-error-border": "rgba(185, 74, 72, 0.26)",
  "--color-warning": "#a66a19",
  "--color-warning-bg": "rgba(166, 106, 25, 0.1)",
  "--color-warning-border": "rgba(166, 106, 25, 0.28)",
  "--color-success": "#5f7f45",
  "--color-success-bg": "rgba(95, 127, 69, 0.1)",
  "--color-success-border": "rgba(95, 127, 69, 0.28)",
  "--color-info": "#6f5f4b",
  "--color-info-bg": "rgba(111, 95, 75, 0.1)",
  "--color-info-border": "rgba(111, 95, 75, 0.22)",
  "--color-created": "#5f7f45",
  "--color-modified": "#9b6b32",
  "--color-deleted": "#b94a48",
  "--color-conflict": "#a66a19",
  "--color-accent": "#37352f",
  "--color-accent-dim": "rgba(55, 53, 47, 0.08)",
  "--color-list-active": "rgba(55, 53, 47, 0.105)",
  "--color-list-inactive": "rgba(55, 53, 47, 0.055)",
  "--color-ghost-hover": "rgba(55, 53, 47, 0.07)",
  "--color-ghost-active": "rgba(55, 53, 47, 0.11)",
  "--color-ghost-selected": "rgba(55, 53, 47, 0.095)",
  "--color-graph-node-orphan": "#99866b",
  "--color-graph-node-selected": "#9b6b32",
  "--color-graph-node-current": "#4f728a",
  "--color-graph-node-stroke-strong": "#6f4f29",
  "--color-graph-node-stroke-soft": "rgba(83, 63, 37, 0.32)",
  "--color-graph-node-stroke-faint": "rgba(83, 63, 37, 0.14)",
  "--color-graph-link-default": "rgba(83, 63, 37, 0.22)",
  "--color-graph-link-selected": "rgba(155, 107, 50, 0.54)",
  "--color-graph-link-current": "rgba(79, 114, 138, 0.58)",
  "--color-graph-cluster-text-l": "34%",
  "--color-editor-code-bg": "#f7f6f3",
  "--color-editor-code-fg": "#37352f",
  "--color-editor-code-border": "#e3e2de",
  "--shadow-editor-code-inset": "inset 0 1px 0 0 rgba(255, 255, 255, 0.72)",
  "--color-editor-inline-code-fg": "#9b4f35",
  "--color-editor-inline-code-bg": "rgba(135, 131, 120, 0.14)",
  "--prosekit-outline-color": "#8b8175",
  "--prosekit-node-selection-color": "rgba(143, 132, 116, 0.16)",
  "--native-scrollbar-track": "rgba(59, 50, 40, 0.04)",
  "--native-scrollbar-thumb": "rgba(59, 50, 40, 0.19)",
  "--native-scrollbar-thumb-hover": "rgba(59, 50, 40, 0.29)",
  "--native-scrollbar-thumb-active": "rgba(59, 50, 40, 0.38)",
  "--native-scrollbar-radius": "999px",
  "--radius-xs": "4px",
  "--radius-sm": "5px",
  "--radius-md": "6px",
  "--radius-lg": "7px",
  "--radius-xl": "8px",
  "--radius-2xl": "8px",
  "--shadow-soft-1": "0 1px 1px rgba(83, 63, 37, 0.045)",
  "--shadow-soft-2": "0 2px 7px rgba(83, 63, 37, 0.065), 0 1px 2px rgba(83, 63, 37, 0.04)",
  "--shadow-popover":
    "0 12px 32px rgba(83, 63, 37, 0.13), 0 2px 8px rgba(83, 63, 37, 0.07), 0 0 0 1px rgba(83, 63, 37, 0.05)",
  "--shadow-command-bubble":
    "0 6px 18px rgba(83, 63, 37, 0.09), 0 1px 4px rgba(83, 63, 37, 0.045), 0 0 0 1px rgba(83, 63, 37, 0.045)",
  "--shadow-context-surface":
    "0 4px 18px rgba(83, 63, 37, 0.095), 0 1px 2px rgba(83, 63, 37, 0.04)",
  "--syntax-default": "#3b3228",
  "--syntax-comment": "#99866b",
  "--syntax-keyword": "#8b5a7e",
  "--syntax-string": "#5f7f45",
  "--syntax-function": "#4f728a",
  "--syntax-number": "#a66a19",
  "--syntax-operator": "#6f5f4b",
  "--syntax-punctuation": "#6f5f4b",
  "--syntax-type": "#7c5f35",
  "--syntax-variable": "#9b4f35",
  "--syntax-property": "#9b4f35",
  "--syntax-namespace": "#7c5f35",
  "--syntax-tag": "#9b4f35",
  "--syntax-attr": "#9b6b32",
  "--syntax-attr-name": "#5f7f45",
  "--syntax-meta": "#99866b",
  "--syntax-builtin": "#8b5a7e",
  "--syntax-constant": "#a66a19",
  "--syntax-regexp": "#5f7f45",
  "--syntax-title": "#3b3228",
  "--syntax-selector": "#9b4f35",
  "--syntax-deletion": "#b94a48",
  "--syntax-addition": "#5f7f45",
  "--theme-editor-content-width": "58rem",
  "--theme-editor-line-height": "1.74",
};

const GITHUB_THEME_VARS: Record<string, string> = {
  ...BASE_WRITING_THEME_VARS,
  "--color-bg-primary": "#ffffff",
  "--color-bg-secondary": "#fafafa",
  "--color-bg-tertiary": "#f3f4f4",
  "--color-bg-elevated": "#ffffff",
  "--color-element": "#ffffff",
  "--color-element-hover": "#f8f8f8",
  "--color-element-active": "#eeeeee",
  "--color-element-selected": "#eef2f8",
  "--color-element-disabled": "#fafafa",
  "--color-text-primary": "#333333",
  "--color-text-secondary": "#555555",
  "--color-text-muted": "#777777",
  "--color-text-placeholder": "#9a9a9a",
  "--color-text-disabled": "#b8b8b8",
  "--color-text-accent": "#4183c4",
  "--color-icon": "#555555",
  "--color-icon-muted": "#777777",
  "--color-icon-accent": "#4183c4",
  "--color-border": "#dfe2e5",
  "--color-border-variant": "#eeeeee",
  "--color-border-focused": "#4183c4",
  "--color-border-selected": "#4183c4",
  "--editor-table-border": "#dfe2e5",
  "--color-kuku-mark-body": "#333333",
  "--color-kuku-mark-eye": "#ffffff",
  "--color-kuku-mark-pupil": "#333333",
  "--color-kuku-mark-mouth": "#f8f8f8",
  "--color-kuku-mark-spark": "#ffffff",
  "--color-kuku-mark-stroke": "#fafafa",
  "--color-error": "#a94442",
  "--color-warning": "#8a6d3b",
  "--color-success": "#3c763d",
  "--color-info": "#4183c4",
  "--color-created": "#3c763d",
  "--color-modified": "#8a6d3b",
  "--color-deleted": "#a94442",
  "--color-conflict": "#8a6d3b",
  "--color-accent": "#4183c4",
  "--color-accent-dim": "rgba(65, 131, 196, 0.1)",
  "--color-list-active": "rgba(65, 131, 196, 0.12)",
  "--color-list-inactive": "rgba(65, 131, 196, 0.06)",
  "--color-ghost-hover": "rgba(51, 51, 51, 0.07)",
  "--color-ghost-active": "rgba(51, 51, 51, 0.11)",
  "--color-ghost-selected": "rgba(65, 131, 196, 0.11)",
  "--color-graph-node-selected": "#4183c4",
  "--color-graph-node-current": "#3c763d",
  "--color-graph-link-selected": "rgba(65, 131, 196, 0.52)",
  "--color-graph-link-current": "rgba(60, 118, 61, 0.56)",
  "--color-editor-code-bg": "#f8f8f8",
  "--color-editor-code-fg": "#333333",
  "--color-editor-code-border": "#e7eaed",
  "--color-editor-inline-code-fg": "#333333",
  "--color-editor-inline-code-bg": "#f3f4f4",
  "--prosekit-outline-color": "#4183c4",
  "--prosekit-node-selection-color": "rgba(65, 131, 196, 0.16)",
  "--syntax-default": "#333333",
  "--syntax-comment": "#777777",
  "--syntax-keyword": "#a71d5d",
  "--syntax-string": "#183691",
  "--syntax-function": "#795da3",
  "--syntax-number": "#0086b3",
  "--syntax-operator": "#333333",
  "--syntax-punctuation": "#333333",
  "--syntax-type": "#795da3",
  "--syntax-variable": "#333333",
  "--syntax-property": "#0086b3",
  "--syntax-namespace": "#795da3",
  "--syntax-tag": "#63a35c",
  "--syntax-attr": "#795da3",
  "--syntax-attr-name": "#795da3",
  "--syntax-meta": "#777777",
  "--syntax-builtin": "#795da3",
  "--syntax-constant": "#0086b3",
  "--syntax-regexp": "#183691",
  "--syntax-title": "#333333",
  "--syntax-selector": "#63a35c",
  "--syntax-deletion": "#a94442",
  "--syntax-addition": "#3c763d",
  "--theme-editor-content-width": "860px",
  "--theme-editor-line-height": "1.74",
};

const VUE_THEME_VARS: Record<string, string> = {
  ...BASE_WRITING_THEME_VARS,
  "--color-bg-primary": "#ffffff",
  "--color-bg-secondary": "#ffffff",
  "--color-bg-tertiary": "#f8f8f8",
  "--color-bg-elevated": "#ffffff",
  "--color-element": "#ffffff",
  "--color-element-hover": "#f8f8f8",
  "--color-element-active": "#f2f2f2",
  "--color-element-selected": "rgba(66, 185, 131, 0.1)",
  "--color-element-disabled": "#f8f8f8",
  "--color-text-primary": "#34495e",
  "--color-text-secondary": "#476582",
  "--color-text-muted": "#777777",
  "--color-text-placeholder": "#9a9a9a",
  "--color-text-disabled": "#b8b8b8",
  "--color-text-accent": "#42b883",
  "--color-icon": "#476582",
  "--color-icon-muted": "#6b7f92",
  "--color-icon-disabled": "#bdc8d1",
  "--color-icon-accent": "#42b883",
  "--color-border": "#dfe2e5",
  "--color-border-variant": "#dddddd",
  "--color-border-focused": "#42b883",
  "--color-border-selected": "#42b883",
  "--editor-table-border": "#dfe2e5",
  "--color-kuku-mark-body": "#34495e",
  "--color-kuku-mark-eye": "#ffffff",
  "--color-kuku-mark-pupil": "#34495e",
  "--color-kuku-mark-mouth": "#ffffff",
  "--color-kuku-mark-spark": "#ffffff",
  "--color-kuku-mark-stroke": "#ffffff",
  "--color-error": "#c92a2a",
  "--color-warning": "#b7791f",
  "--color-success": "#42b883",
  "--color-info": "#476582",
  "--color-created": "#42b883",
  "--color-modified": "#b7791f",
  "--color-deleted": "#c92a2a",
  "--color-conflict": "#d97706",
  "--color-accent": "#42b883",
  "--color-accent-dim": "rgba(66, 184, 131, 0.11)",
  "--color-list-active": "rgba(66, 184, 131, 0.13)",
  "--color-list-inactive": "rgba(66, 184, 131, 0.065)",
  "--color-ghost-hover": "rgba(66, 184, 131, 0.08)",
  "--color-ghost-active": "rgba(66, 184, 131, 0.13)",
  "--color-ghost-selected": "rgba(66, 184, 131, 0.11)",
  "--color-graph-node-orphan": "#6b7f92",
  "--color-graph-node-selected": "#42b883",
  "--color-graph-node-current": "#35495e",
  "--color-graph-node-stroke-strong": "#213547",
  "--color-graph-link-default": "rgba(33, 53, 71, 0.18)",
  "--color-graph-link-selected": "rgba(66, 184, 131, 0.56)",
  "--color-graph-link-current": "rgba(53, 73, 94, 0.48)",
  "--color-graph-cluster-text-l": "34%",
  "--color-editor-code-bg": "#f8f8f8",
  "--color-editor-code-fg": "#34495e",
  "--color-editor-code-border": "#f4f4f4",
  "--shadow-editor-code-inset": "inset 0 1px 0 0 rgba(255, 255, 255, 0.72)",
  "--color-editor-inline-code-fg": "#e96900",
  "--color-editor-inline-code-bg": "#f8f8f8",
  "--prosekit-outline-color": "#42b883",
  "--prosekit-node-selection-color": "rgba(66, 184, 131, 0.17)",
  "--syntax-default": "#34495e",
  "--syntax-comment": "#777777",
  "--syntax-keyword": "#476582",
  "--syntax-string": "#42b883",
  "--syntax-function": "#35495e",
  "--syntax-number": "#b7791f",
  "--syntax-operator": "#476582",
  "--syntax-punctuation": "#476582",
  "--syntax-type": "#3eaf7c",
  "--syntax-variable": "#d97706",
  "--syntax-property": "#35495e",
  "--syntax-namespace": "#476582",
  "--syntax-tag": "#42b883",
  "--syntax-attr": "#b7791f",
  "--syntax-attr-name": "#3eaf7c",
  "--syntax-meta": "#6b7f92",
  "--syntax-builtin": "#476582",
  "--syntax-constant": "#b7791f",
  "--syntax-regexp": "#42b883",
  "--syntax-title": "#34495e",
  "--syntax-selector": "#42b883",
  "--syntax-deletion": "#c92a2a",
  "--syntax-addition": "#42b883",
  "--theme-editor-content-width": "860px",
  "--theme-editor-line-height": "1.6",
};

const NOTION_THEME_VARS: Record<string, string> = {
  ...BASE_WRITING_THEME_VARS,
  "--color-bg-primary": "#fbfbfa",
  "--color-bg-secondary": "#f1f1ef",
  "--color-bg-tertiary": "#e9e9e7",
  "--color-bg-elevated": "#ffffff",
  "--color-element": "#ffffff",
  "--color-element-hover": "#f1f1ef",
  "--color-element-active": "#e9e9e7",
  "--color-element-selected": "#eeeeec",
  "--color-element-disabled": "#f7f7f5",
  "--color-text-primary": "#37352f",
  "--color-text-secondary": "#5f5e58",
  "--color-text-muted": "#787774",
  "--color-text-placeholder": "#9b9a97",
  "--color-text-disabled": "#bdbbb6",
  "--color-text-accent": "#37352f",
  "--color-icon": "#5f5e58",
  "--color-icon-muted": "#787774",
  "--color-icon-disabled": "#bdbbb6",
  "--color-icon-accent": "#37352f",
  "--color-border": "#deddda",
  "--color-border-variant": "#ecebea",
  "--color-border-focused": "#9b9a97",
  "--color-border-selected": "#5f5e58",
  "--editor-table-border": "#deddda",
  "--color-kuku-mark-body": "#4f4d47",
  "--color-kuku-mark-eye": "#ffffff",
  "--color-kuku-mark-pupil": "#37352f",
  "--color-kuku-mark-mouth": "#ffffff",
  "--color-kuku-mark-spark": "#ffffff",
  "--color-kuku-mark-stroke": "#f1f1ef",
  "--color-error": "#eb5757",
  "--color-warning": "#d9730d",
  "--color-success": "#448361",
  "--color-info": "#337ea9",
  "--color-created": "#448361",
  "--color-modified": "#d9730d",
  "--color-deleted": "#eb5757",
  "--color-conflict": "#d9730d",
  "--color-accent": "#37352f",
  "--color-accent-dim": "rgba(55, 53, 47, 0.08)",
  "--color-list-active": "rgba(55, 53, 47, 0.105)",
  "--color-list-inactive": "rgba(55, 53, 47, 0.055)",
  "--color-ghost-hover": "rgba(55, 53, 47, 0.07)",
  "--color-ghost-active": "rgba(55, 53, 47, 0.11)",
  "--color-ghost-selected": "rgba(55, 53, 47, 0.095)",
  "--color-graph-node-orphan": "#9b9a97",
  "--color-graph-node-selected": "#d9730d",
  "--color-graph-node-current": "#337ea9",
  "--color-graph-node-stroke-strong": "#5f5e58",
  "--color-graph-link-default": "rgba(55, 53, 47, 0.2)",
  "--color-graph-link-selected": "rgba(217, 115, 13, 0.52)",
  "--color-graph-link-current": "rgba(51, 126, 169, 0.56)",
  "--color-editor-code-bg": "#f1f1ef",
  "--color-editor-code-fg": "#37352f",
  "--color-editor-code-border": "#deddda",
  "--color-editor-inline-code-fg": "#eb5757",
  "--color-editor-inline-code-bg": "rgba(135, 131, 120, 0.15)",
  "--prosekit-outline-color": "#9b9a97",
  "--prosekit-node-selection-color": "rgba(55, 53, 47, 0.16)",
  "--syntax-default": "#37352f",
  "--syntax-comment": "#9b9a97",
  "--syntax-keyword": "#ad4e8c",
  "--syntax-string": "#448361",
  "--syntax-function": "#2f3437",
  "--syntax-number": "#d9730d",
  "--syntax-operator": "#787774",
  "--syntax-punctuation": "#5f5e58",
  "--syntax-type": "#a55a30",
  "--syntax-variable": "#c14c35",
  "--syntax-property": "#c14c35",
  "--syntax-namespace": "#a55a30",
  "--syntax-tag": "#c14c35",
  "--syntax-attr": "#b8793a",
  "--syntax-attr-name": "#448361",
  "--syntax-meta": "#9b9a97",
  "--syntax-builtin": "#ad4e8c",
  "--syntax-constant": "#d9730d",
  "--syntax-regexp": "#448361",
  "--syntax-title": "#37352f",
  "--syntax-selector": "#c14c35",
  "--syntax-deletion": "#eb5757",
  "--syntax-addition": "#448361",
  "--theme-editor-content-width": "58rem",
  "--theme-editor-line-height": "1.74",
};

const THEME_VARIANT_VARS: Record<string, Record<string, string>> = {
  github: GITHUB_THEME_VARS,
  vue: VUE_THEME_VARS,
  notion: NOTION_THEME_VARS,
};

const THEME_VARIANT_VAR_NAMES = [
  ...new Set(Object.values(THEME_VARIANT_VARS).flatMap((vars) => Object.keys(vars))),
];

// ── Helpers ──

/**
 * Resolves the effective theme from the stored preference + system detection.
 * Plain function — safe to call inside or outside reactive contexts.
 */
function getEffectiveTheme(): EffectiveTheme {
  const pref = settingsState.appearance.theme;
  if (pref === "system") return systemIsDark() ? "dark" : "light";
  if (THEME_VARIANT_VARS[pref]) return "light";
  return pref === "dark" ? "dark" : "light";
}

/** Apply theme tokens + bg color to the DOM. */
function applyToDom(theme: EffectiveTheme): void {
  const pref = settingsState.appearance.theme;
  const variantVars = THEME_VARIANT_VARS[pref];
  const color = variantVars ? variantVars["--color-bg-primary"] : BG_COLORS[theme];

  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }

  document.documentElement.dataset.themeVariant = variantVars ? pref : "";
  if (!variantVars) {
    delete document.documentElement.dataset.themeVariant;
  }

  for (const prop of THEME_VARIANT_VAR_NAMES) {
    if (variantVars?.[prop] !== undefined) {
      document.documentElement.style.setProperty(prop, variantVars[prop]);
    } else {
      document.documentElement.style.removeProperty(prop);
    }
  }

  document.documentElement.style.backgroundColor = color;
  document.documentElement.style.colorScheme = theme;
  document.body.style.backgroundColor = color;

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = color;
}

// ── Actions ──

function setTheme(theme: ThemePreference): void {
  setAppearanceSetting("theme", theme);
}

function toggleTheme(): void {
  setTheme(getEffectiveTheme() === "dark" ? "light" : "dark");
}

// ── Init ──

/**
 * Sets up a reactive effect that applies the theme to the DOM and native window
 * whenever the preference or system setting changes.
 *
 * Must be called inside a reactive root (e.g. directly in the App component body).
 */
function initTheme(): void {
  let win: ReturnType<typeof getCurrentWindow> | null = null;
  try {
    win = getCurrentWindow();
  } catch {
    win = null;
  }

  createEffect(() => {
    const theme = getEffectiveTheme();
    applyToDom(theme);

    // Sync native Tauri window theme.
    // null = follow OS; explicit value = lock the window chrome color.
    const pref = settingsState.appearance.theme;
    void win?.setTheme(pref === "system" ? null : theme);
  });
}

// ── Exports ──

export { getEffectiveTheme, initTheme, setTheme, toggleTheme };
