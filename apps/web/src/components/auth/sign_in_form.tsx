import { Match, Show, Switch, createSignal, onMount } from "solid-js";

import OTPInput from "@/components/auth/otp_input";
import {
  type AuthActionState,
  type OAuthProvider,
  getOAuthURL,
  resendEmailCode,
  sendEmailCode,
  verifyEmailCode,
} from "@/lib/api/auth";
import { getProfile } from "@/lib/api/dashboard";
import { oauthErrorMessage } from "@/lib/auth/errors";
import { safeLocalRedirect } from "@/lib/auth/redirect";

type AuthStep = "email" | "verify";

function getRedirectPath(): string {
  if (typeof window === "undefined") {
    return "/dashboard";
  }
  // Validate here (single source) — every caller that stores or follows
  // this value (sessionStorage via OAuth flow, direct window.location)
  // inherits the safe default on rejection. An attacker-crafted
  // `?redirect=http://evil.com` silently degrades to `/dashboard`.
  const raw = new URLSearchParams(window.location.search).get("redirect");
  return safeLocalRedirect(raw, "/dashboard");
}

function rememberOAuthRedirect(path: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem("oauth_redirect", path);
}

export default function SignInForm() {
  const [step, setStep] = createSignal<AuthStep>("email");
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [emailState, setEmailState] = createSignal<AuthActionState>("idle");
  const [verifyState, setVerifyState] = createSignal<AuthActionState>("idle");
  const [oauthState, setOAuthState] = createSignal<AuthActionState>("idle");
  const [resendState, setResendState] = createSignal<AuthActionState>("idle");
  const [message, setMessage] = createSignal("");

  const isBusy = () =>
    emailState() === "loading" || verifyState() === "loading" || oauthState() === "loading";

  onMount(() => {
    consumeOAuthError();
    void redirectIfSignedIn();
  });

  // The OAuth callback path redirects failures through
  // `/auth/done` → `/auth/signin?error=<code>` (see
  // `apps/server/internal/auth/oauth_callback.go::oauthErrorCode`). We
  // surface the mapped message here and strip the param from the URL so a
  // refresh doesn't re-show it — the state signal keeps the message
  // visible for the current view.
  function consumeOAuthError(): void {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get("error");
    const text = oauthErrorMessage(errorCode);
    if (!text) return;
    setOAuthState("error");
    setMessage(text);
    params.delete("error");
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", next);
  }

  async function redirectIfSignedIn() {
    try {
      await getProfile();
      window.location.replace(getRedirectPath());
    } catch {
      // Stay on the sign-in page.
    }
  }

  async function handleEmailSubmit(event: SubmitEvent) {
    event.preventDefault();

    const trimmedEmail = email().trim();
    if (!trimmedEmail) {
      setMessage("Enter an email address.");
      return;
    }

    setEmailState("loading");
    setMessage("");

    try {
      await sendEmailCode(trimmedEmail);
      setEmail(trimmedEmail);
      setEmailState("success");
      setStep("verify");
    } catch {
      setEmailState("error");
      setMessage("Unable to send a code.");
    }
  }

  async function handleVerify() {
    if (code().length !== 6) {
      setMessage("Enter the 6 digit code.");
      return;
    }

    setVerifyState("loading");
    setMessage("");

    try {
      await verifyEmailCode(code());
      setVerifyState("success");
      window.location.href = getRedirectPath();
    } catch {
      setVerifyState("error");
      setMessage("Unable to verify the code.");
    }
  }

  async function handleResend() {
    setResendState("loading");
    setMessage("");

    try {
      await resendEmailCode();
      setResendState("success");
      setMessage("A new code was sent.");
    } catch {
      setResendState("error");
      setMessage("Unable to resend the code.");
    }
  }

  async function handleOAuth(provider: OAuthProvider) {
    setOAuthState("loading");
    setMessage("");

    try {
      rememberOAuthRedirect(getRedirectPath());
      window.location.href = await getOAuthURL(provider);
    } catch {
      setOAuthState("error");
      setMessage("Unable to start authentication.");
    }
  }

  function goBack() {
    setStep("email");
    setCode("");
    setMessage("");
    setVerifyState("idle");
  }

  return (
    <Switch>
      <Match when={step() === "verify"}>
        <div class="auth-form">
          <button
            class="auth-back-button"
            disabled={verifyState() === "loading"}
            onClick={goBack}
            type="button"
          >
            Back
          </button>

          <div>
            <h2>Enter verification code</h2>
            <p>
              We sent a code to <span>{email()}</span>
            </p>
          </div>

          <OTPInput disabled={verifyState() === "loading"} onChange={setCode} value={code()} />

          <Show when={message()}>
            <p class={verifyState() === "error" ? "auth-error" : "auth-message"}>{message()}</p>
          </Show>

          <button
            class="auth-submit-button"
            disabled={verifyState() === "loading" || code().length !== 6}
            onClick={handleVerify}
            type="button"
          >
            {verifyState() === "loading" ? "Verifying..." : "Verify"}
          </button>

          <p class="auth-secondary-copy">
            Didn't receive a code?{" "}
            <button disabled={resendState() === "loading"} onClick={handleResend} type="button">
              {resendState() === "loading" ? "Sending..." : "Resend"}
            </button>
          </p>
        </div>
      </Match>

      <Match when={step() === "email"}>
        <div class="auth-form">
          <div class="auth-oauth-stack">
            <button
              class="auth-oauth-btn"
              disabled={isBusy()}
              onClick={() => handleOAuth("google")}
              type="button"
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              Continue with Google
            </button>
            <button
              class="auth-oauth-btn"
              disabled={isBusy()}
              onClick={() => handleOAuth("github")}
              type="button"
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
              Continue with GitHub
            </button>
          </div>

          <div class="auth-divider">
            <span>or</span>
          </div>

          <form onSubmit={handleEmailSubmit}>
            <label for="auth-email">Email</label>
            <input
              disabled={isBusy()}
              id="auth-email"
              onInput={(event) => setEmail(event.currentTarget.value)}
              placeholder="Email address"
              required
              type="email"
              value={email()}
            />

            <Show when={message()}>
              <p
                class={
                  emailState() === "error" || oauthState() === "error"
                    ? "auth-error"
                    : "auth-message"
                }
              >
                {message()}
              </p>
            </Show>

            <button class="auth-submit-button" disabled={isBusy()} type="submit">
              {emailState() === "loading" ? "Sending..." : "Continue"}
            </button>
          </form>
        </div>
      </Match>
    </Switch>
  );
}
