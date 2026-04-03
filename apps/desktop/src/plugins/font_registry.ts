// ── Font Registry ──
//
// Manages FontPack registration and dynamic @font-face rule injection.
// Plugins contribute fonts via `plugin.fonts`; the active pack's font
// families are applied to the CSS custom properties --font-ui and --font-mono.
//
// Font faces are injected as a <style> element in <head>, tagged with
// `data-plugin-font="{packId}"` for clean replacement on pack switch.
//
// SolidJS module-level singleton — no Context provider needed.

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import type { Disposer, FontDefinition, FontPack } from "~/plugins/types";
import { FONT_SANS_FALLBACK, FONT_MONO_FALLBACK } from "~/lib/font_fallback";

// ── Types ──

interface FontRegistryState {
  /** All registered font packs, keyed by pack ID. */
  packs: Record<string, FontPack>;
  /** ID of the currently active font pack, or null for CSS defaults. */
  activePackId: string | null;
}

// ── Store ──

const [fontRegistry, setFontRegistry] = createStore<FontRegistryState>({
  packs: {},
  activePackId: null,
});

const [activeFontPack, setActiveFontPack] = createSignal<FontPack | null>(null);

// ── Registration ──

/**
 * Register a font pack. Makes it available for selection.
 * Returns a disposer that unregisters the pack and removes its
 * injected @font-face rules if it was active.
 */
function registerFontPack(pack: FontPack): Disposer {
  setFontRegistry("packs", pack.id, pack);

  return () => {
    // If this pack was active, revert to defaults
    if (fontRegistry.activePackId === pack.id) {
      clearFontOverrides();
    }

    setFontRegistry("packs", pack.id, undefined as never);
    removeFontStyleElement(pack.id);
  };
}

// ── Application ──

/**
 * Apply a font pack by ID. Injects @font-face rules and updates
 * --font-ui / --font-mono CSS custom properties.
 *
 * Steps:
 *   1. Remove any previously injected font <style> element
 *   2. Generate @font-face rules from the pack's font definitions
 *   3. Inject a new <style> element into <head>
 *   4. Update CSS custom properties on the document root
 *
 * Returns false if the pack ID is not found.
 */
function applyFontPack(packId: string): boolean {
  const pack = fontRegistry.packs[packId];
  if (!pack) return false;

  // Remove previous font injection (if any)
  removeFontStyleElement(fontRegistry.activePackId);

  // Generate and inject @font-face rules
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-plugin-font", packId);
  styleEl.textContent = buildFontFaceRules(pack);
  document.head.appendChild(styleEl);

  // Update CSS custom properties
  const root = document.documentElement;
  root.style.setProperty("--font-ui", buildFontStack(pack.fonts.sans, FONT_SANS_FALLBACK));
  root.style.setProperty("--font-mono", buildFontStack(pack.fonts.mono, FONT_MONO_FALLBACK));

  // Update state
  setFontRegistry("activePackId", packId);
  setActiveFontPack(pack);

  return true;
}

/**
 * Clear all font overrides and revert to CSS-defined defaults.
 * Removes injected @font-face rules and custom property overrides.
 */
function clearFontOverrides(): void {
  removeFontStyleElement(fontRegistry.activePackId);

  const root = document.documentElement;
  root.style.removeProperty("--font-ui");
  root.style.removeProperty("--font-mono");

  setFontRegistry("activePackId", null);
  setActiveFontPack(null);
}

// ── Queries ──

/**
 * Get all registered font packs as a flat array.
 * Suitable for rendering a font picker in settings.
 */
function getAvailableFonts(): { id: string; name: string; pack: FontPack }[] {
  return Object.values(fontRegistry.packs).map((pack) => ({
    id: pack.id,
    name: pack.name,
    pack,
  }));
}

// ── Internal Helpers ──

/**
 * Build CSS @font-face rule strings from a FontPack.
 *
 * Generates rules for both sans and mono font definitions,
 * each with all declared weight/style combinations.
 */
function buildFontFaceRules(pack: FontPack): string {
  let css = "";
  css += fontDefinitionToCSS(pack.fonts.sans);
  css += fontDefinitionToCSS(pack.fonts.mono);
  return css;
}

/**
 * Convert a single FontDefinition into @font-face CSS rules.
 */
function fontDefinitionToCSS(def: FontDefinition): string {
  let css = "";
  for (const face of def.faces) {
    css += `
@font-face {
  font-family: '${def.family}';
  font-weight: ${String(face.weight)};
  font-style: ${face.style};
  src: url('${face.src}');
  font-display: swap;
}
`;
  }
  return css;
}

/**
 * Build a CSS font-family stack string from a FontDefinition.
 * Format: `"Family Name", fallback1, fallback2`
 */
function buildFontStack(def: FontDefinition, fallback: string): string {
  const family = def.family.trim();
  const parts = [...(family ? [`"${family}"`] : []), ...def.fallbacks, fallback];
  return parts.join(", ");
}

/**
 * Remove the injected <style> element for a font pack (if present).
 */
function removeFontStyleElement(packId: string | null): void {
  if (!packId) return;
  const existing = document.querySelector(`style[data-plugin-font="${packId}"]`);
  if (existing) {
    existing.remove();
  }
}

// ── Exports ──

export {
  activeFontPack,
  applyFontPack,
  clearFontOverrides,
  fontRegistry,
  getAvailableFonts,
  registerFontPack,
};
