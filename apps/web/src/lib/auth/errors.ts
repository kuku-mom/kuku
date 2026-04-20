// User-facing copy for the `?error=<code>` values the server emits from
// `apps/server/internal/auth/oauth_callback.go::oauthErrorCode`. Keep this
// file in sync with that mapping — adding a new server error code without
// a message here collapses it to the generic fallback.

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  // GitHub: `/user/emails` returned no primary+verified entry. The user
  // either made every email private or didn't grant the `user:email`
  // scope. Actionable hint instead of blaming the auth code.
  no_verified_email:
    "Your provider didn't return a verified email. Make your primary email public in the provider's settings, then try again.",
  // Provider credentials are unset server-side. Not the user's fault.
  oauth_not_configured: "This sign-in option is temporarily unavailable.",
  // Callback arrived without `code`/`state` — either the OAuth flow was
  // interrupted or the link was tampered with.
  missing_oauth_params: "The sign-in link was incomplete. Please start again.",
  // Fallback for anything we don't have specific copy for (network
  // failures, provider 5xx, etc). Kept generic because the server-side
  // error string already landed in our logs.
  oauth_failed: "Unable to complete sign-in. Please try again.",
};

/**
 * Returns a user-facing message for a server-emitted OAuth error code, or
 * `null` when no code is present. Unknown codes fall back to the
 * `oauth_failed` copy so a future server addition doesn't render as blank.
 */
export function oauthErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return OAUTH_ERROR_MESSAGES[code] ?? OAUTH_ERROR_MESSAGES.oauth_failed;
}
