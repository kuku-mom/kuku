import { createSignal, onMount } from "solid-js";

import { createDesktopToken } from "@/lib/api/auth";
import { getProfile } from "@/lib/api/dashboard";
import { safeDesktopCallback } from "@/lib/auth/redirect";

function desktopState(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return new URLSearchParams(window.location.search).get("state") ?? "";
}

function desktopCallback(): string {
  if (typeof window === "undefined") {
    return "";
  }
  // Without validation, `?desktop_callback=http://attacker.com` would
  // receive the one-time desktop token in its query string — attacker
  // then exchanges it on our server for a real session. Only the shapes
  // the real desktop app uses (`kuku://` deep link or loopback dev
  // server) are allowed through; everything else falls back to the
  // default `kuku://` URL in `complete()`.
  const raw = new URLSearchParams(window.location.search).get("desktop_callback");
  return safeDesktopCallback(raw);
}

function desktopRedirectPath(state: string): string {
  const params = new URLSearchParams({ state });
  const callback = desktopCallback();
  if (callback) {
    params.set("desktop_callback", callback);
  }
  return `/auth/desktop?${params.toString()}`;
}

function appendQueryParams(input: string, params: URLSearchParams): string {
  const [base, fragment] = input.split("#", 2);
  const separator = base.includes("?") ? "&" : "?";
  const output = `${base}${separator}${params.toString()}`;
  return fragment ? `${output}#${fragment}` : output;
}

export default function DesktopAuth() {
  const [message, setMessage] = createSignal("Completing desktop sign in...");

  onMount(() => {
    void complete();
  });

  async function complete(): Promise<void> {
    const state = desktopState();
    if (!state) {
      setMessage("Missing desktop authentication state.");
      return;
    }
    const redirectPath = desktopRedirectPath(state);

    window.sessionStorage.setItem("oauth_redirect", redirectPath);

    try {
      await getProfile();
    } catch {
      window.location.href = `/auth/signin?redirect=${encodeURIComponent(redirectPath)}`;
      return;
    }

    try {
      const token = await createDesktopToken(state);
      const authParams = new URLSearchParams({ token, state });
      const callback = desktopCallback();
      window.location.href = callback
        ? appendQueryParams(callback, authParams)
        : `kuku://auth?${authParams.toString()}`;
    } catch {
      setMessage("Unable to create a desktop sign-in token.");
    }
  }

  return <p class="auth-secondary-copy">{message()}</p>;
}
