// ── Theme Registry ──
//
// Manages ThemePack registration and CSS variable application.
// Plugins contribute themes via `plugin.themes`; the user selects
// a variant (light/dark) which gets applied to the document root.
//
// CSS variable mapping covers the app's 11-layer semantic token system
// defined in index.css. ThemeColors (required) maps to the core surface/text
// tokens; ThemeExtendedColors (optional) maps to ghost/status tokens.
//
// SolidJS module-level singleton — no Context provider needed.

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import type {
  Disposer,
  ThemeColors,
  ThemeExtendedColors,
  ThemePack,
  ThemeVariant,
} from "~/plugins/types";

// ── Types ──

interface ThemeRegistryState {
  /** All registered theme packs, keyed by pack ID. */
  packs: Record<string, ThemePack>;
  /** ID of the currently active theme variant, in format "packId:variantName". */
  activeVariantId: string | null;
}

// ── Store ──

const [themeRegistry, setThemeRegistry] = createStore<ThemeRegistryState>({
  packs: {},
  activeVariantId: null,
});

/** The currently applied ThemeVariant (reactive signal for fast access). */
const [activeVariant, setActiveVariant] = createSignal<ThemeVariant | null>(null);

// ── Registration ──

/**
 * Register a theme pack. Makes its variants available for selection.
 * Returns a disposer that unregisters the pack.
 *
 * If the currently active variant belongs to this pack and the pack is
 * re-registered (e.g. during hot-reload), the active variant is refreshed.
 */
function registerThemePack(pack: ThemePack): Disposer {
  setThemeRegistry("packs", pack.id, pack);

  // If we're replacing a pack that has the active variant, refresh it
  const current = themeRegistry.activeVariantId;
  if (current?.startsWith(`${pack.id}:`)) {
    const variantName = current.slice(pack.id.length + 1);
    const variant = pack.variants.find((v) => v.name === variantName);
    if (variant) {
      applyThemeVariant(pack.id, variant);
    }
  }

  return () => {
    setThemeRegistry("packs", pack.id, undefined as never);
  };
}

// ── Application ──

/**
 * Apply a specific theme variant to the document.
 *
 * Sets:
 * 1. `data-theme` attribute on `<html>` (for CSS selectors)
 * 2. Core CSS variables from `ThemeColors` (required)
 * 3. Extended CSS variables from `ThemeExtendedColors` (optional)
 * 4. Syntax highlighting variables (optional)
 *
 * All CSS variables are set inside a single `requestAnimationFrame`
 * to avoid flicker from partial updates.
 *
 * @param packId — the pack this variant belongs to
 * @param variant — the ThemeVariant to apply
 */
function applyThemeVariant(packId: string, variant: ThemeVariant): void {
  const variantId = `${packId}:${variant.name}`;
  setThemeRegistry("activeVariantId", variantId);
  setActiveVariant(variant);

  const root = document.documentElement;

  requestAnimationFrame(() => {
    // Set appearance attribute (used by light/dark CSS selectors)
    root.setAttribute("data-theme", variant.appearance);

    // ── Core colors (required) ──
    const colorMap = buildCoreColorMap(variant.colors);
    for (const [prop, value] of colorMap) {
      root.style.setProperty(prop, value);
    }

    // ── Extended colors (optional) ──
    if (variant.extended) {
      const extMap = buildExtendedColorMap(variant.extended);
      for (const [prop, value] of extMap) {
        if (value !== undefined) {
          root.style.setProperty(prop, value);
        }
      }
    }

    // ── Syntax highlighting (optional) ──
    if (variant.syntax) {
      for (const [token, color] of Object.entries(variant.syntax)) {
        root.style.setProperty(`--syntax-${token}`, color);
      }
    }
  });
}

/**
 * Apply a theme variant by its composite ID ("packId:variantName").
 * Returns false if the pack or variant is not found.
 */
function applyThemeById(variantId: string): boolean {
  const colonIdx = variantId.indexOf(":");
  if (colonIdx === -1) return false;

  const packId = variantId.slice(0, colonIdx);
  const variantName = variantId.slice(colonIdx + 1);

  const pack = themeRegistry.packs[packId];
  if (!pack) return false;

  const variant = pack.variants.find((v) => v.name === variantName);
  if (!variant) return false;

  applyThemeVariant(packId, variant);
  return true;
}

/**
 * Clear all custom CSS variables set by the theme system.
 * Reverts to the CSS-defined defaults in index.css.
 */
function clearThemeOverrides(): void {
  const root = document.documentElement;
  root.removeAttribute("data-theme");

  // Remove all properties we might have set
  const allProps = [
    ...buildCoreColorMap(EMPTY_COLORS).keys(),
    ...buildExtendedColorMap(FULL_EXTENDED).keys(),
  ];

  for (const prop of allProps) {
    root.style.removeProperty(prop);
  }

  setThemeRegistry("activeVariantId", null);
  setActiveVariant(null);
}

// ── Queries ──

/**
 * Get all available theme variants across all registered packs.
 * Returns a flat list with pack metadata attached, suitable for a theme picker UI.
 */
function getAvailableThemes(): {
  packId: string;
  packName: string;
  variantId: string;
  variant: ThemeVariant;
}[] {
  const result: {
    packId: string;
    packName: string;
    variantId: string;
    variant: ThemeVariant;
  }[] = [];

  for (const pack of Object.values(themeRegistry.packs)) {
    for (const variant of pack.variants) {
      result.push({
        packId: pack.id,
        packName: pack.name,
        variantId: `${pack.id}:${variant.name}`,
        variant,
      });
    }
  }

  return result;
}

/**
 * Get variants filtered by appearance (light or dark).
 */
function getThemesByAppearance(
  appearance: "light" | "dark",
): ReturnType<typeof getAvailableThemes> {
  return getAvailableThemes().filter((t) => t.variant.appearance === appearance);
}

// ── CSS Variable Mapping ──

/**
 * Maps ThemeColors fields to CSS custom property names.
 * These are the core surface, text, accent, list, and border tokens.
 */
function buildCoreColorMap(colors: ThemeColors): Map<string, string> {
  return new Map([
    // Surface
    ["--color-bg-primary", colors.bgPrimary],
    ["--color-bg-secondary", colors.bgSecondary],
    ["--color-bg-tertiary", colors.bgTertiary],
    ["--color-bg-elevated", colors.bgElevated],
    // Text
    ["--color-text-primary", colors.textPrimary],
    ["--color-text-secondary", colors.textSecondary],
    ["--color-text-muted", colors.textMuted],
    // Accent
    ["--color-accent", colors.accent],
    ["--color-accent-dim", colors.accentDim],
    // List
    ["--color-list-active", colors.listActive],
    ["--color-list-inactive", colors.listInactive],
    // Border
    ["--color-border", colors.border],
  ]);
}

/**
 * Maps ThemeExtendedColors fields to CSS custom property names.
 * These are optional — only set if the theme provides them.
 */
function buildExtendedColorMap(
  extended: Partial<ThemeExtendedColors>,
): Map<string, string | undefined> {
  return new Map([
    ["--color-ghost-hover", extended.ghostHover],
    ["--color-ghost-selected", extended.ghostSelected],
    ["--color-error", extended.error],
    ["--color-warning", extended.warning],
    ["--color-success", extended.success],
    ["--color-info", extended.info],
  ]);
}

// ── Internal Constants ──

/** Empty ThemeColors — used to enumerate all core CSS property names. */
const EMPTY_COLORS: ThemeColors = {
  bgPrimary: "",
  bgSecondary: "",
  bgTertiary: "",
  bgElevated: "",
  textPrimary: "",
  textSecondary: "",
  textMuted: "",
  accent: "",
  accentDim: "",
  listActive: "",
  listInactive: "",
  border: "",
};

/** Full ThemeExtendedColors — used to enumerate all extended CSS property names. */
const FULL_EXTENDED: ThemeExtendedColors = {
  ghostHover: "",
  ghostSelected: "",
  error: "",
  warning: "",
  success: "",
  info: "",
};

// ── Exports ──

export {
  activeVariant,
  applyThemeById,
  applyThemeVariant,
  clearThemeOverrides,
  getAvailableThemes,
  getThemesByAppearance,
  registerThemePack,
  themeRegistry,
};
