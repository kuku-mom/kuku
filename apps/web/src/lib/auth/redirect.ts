// Helpers for sanitizing user-supplied redirect targets before they become `window.location.*` assignments.

/**
 * Returns a same-origin path-only redirect. Anything absolute, cross-origin,
 * protocol-relative (`//evil.com`), or non-http(s) is rejected.
 *
 * Always call this before assigning to `window.location` or stashing the
 * value where a later step will.
 */
export function safeLocalRedirect(input: string | null | undefined, fallback: string): string {
  if (!input) return fallback;
  // Reject protocol-relative (`//host/path`) — browsers treat as absolute.
  if (!input.startsWith("/") || input.startsWith("//")) return fallback;
  try {
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const url = new URL(input, origin);
    if (url.origin !== origin) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/**
 * Returns the desktop-callback URL iff it's one of the shapes our desktop
 * app actually uses:
 *
 *   - `kuku://...` — production deep link
 *   - `http://127.0.0.1:<port>/...` / `http://localhost:<port>/...` — dev
 *     callback HTTP server that `auth_commands.rs` spawns on a random
 *     loopback port
 *
 * Any other scheme (`javascript:`, `data:`, remote `http(s):`) is rejected
 * — the caller falls back to the plain `kuku://` deep link which only a
 * registered desktop client can receive.
 */
export function safeDesktopCallback(input: string | null | undefined): string {
  if (!input) return "";
  try {
    const url = new URL(input);
    if (url.protocol === "kuku:") return input;
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        // Only http is actually used in dev, but we accept https here
        // defensively — a future self-signed dev loopback would still pass.
        return input;
      }
    }
    return "";
  } catch {
    return "";
  }
}
