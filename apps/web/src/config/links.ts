import { prodReleaseLinks } from "./prod_release";

export const externalLinks = {
  github: prodReleaseLinks.github,
  downloadMac: prodReleaseLinks.downloadMac,
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
