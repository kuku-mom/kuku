/**
 * Externally managed links. Swap values here to change every call site —
 * footer, landing nav, hero download button, and CTA banner all read from
 * this file.
 */
export const externalLinks = {
  github: "https://github.com/kuku-mom/kuku",
  /** macOS DMG for the current release. Bump version on every release. */
  downloadMac:
    "https://github.com/kuku-mom/kuku/releases/download/0.3.0/Kuku_0.3.0_aarch64.dmg",
} as const;

/**
 * Resolve `downloadMac` for rendering inside an `<a href>`.
 *
 * Hash anchors need a leading `/` when used from subpages so the browser
 * first navigates to the home page, then scrolls. Absolute URLs are passed
 * through unchanged.
 */
export function resolveDownloadHref(pathname: string): string {
  const href = externalLinks.downloadMac;
  if (href.startsWith("#")) {
    return pathname === "/" ? href : `/${href}`;
  }
  return href;
}
