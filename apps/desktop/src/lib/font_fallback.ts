/**
 * System font fallback stacks appended to every `--font-*` CSS custom property.
 * Shared across static CSS defaults, Settings reactive effects, and the font registry.
 */

const FONT_SANS_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif';

const FONT_MONO_FALLBACK =
  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace';

/**
 * Build a CSS `font-family` value with "Emoji" prefix, an optional user font,
 * and the appropriate fallback stack.
 *
 * When `fontName` is empty or whitespace-only the entry is omitted entirely so
 * the browser falls through to the fallback fonts instead of trying to resolve
 * an empty `""` family name.
 */
function buildFontFamily(fontName: string, fallback: string): string {
  const trimmed = fontName.trim();
  return trimmed ? `"Emoji", "${trimmed}", ${fallback}` : `"Emoji", ${fallback}`;
}

export { FONT_SANS_FALLBACK, FONT_MONO_FALLBACK, buildFontFamily };
