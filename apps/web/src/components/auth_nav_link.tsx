import { createSignal, onMount } from "solid-js";

import type { MessageKey } from "@/i18n";
import { getProfile } from "@/lib/api/dashboard";

interface Props {
  pathname: string;
}

export default function AuthNavLink(props: Props) {
  const [isSignedIn, setIsSignedIn] = createSignal(false);

  onMount(() => {
    void checkAuth();
  });

  async function checkAuth() {
    try {
      await getProfile();
      setIsSignedIn(true);
      // Re-run the landing-page i18n script so the swapped `data-i18n` key
      // (nav.signin → nav.dashboard) picks up the active language.
      window.dispatchEvent(new Event("kuku:lang-refresh"));
    } catch {
      setIsSignedIn(false);
    }
  }

  const href = () => (isSignedIn() ? "/dashboard" : "/auth/signin");
  const i18nKey = (): MessageKey => (isSignedIn() ? "nav.dashboard" : "nav.signin");
  const label = () => (isSignedIn() ? "Dashboard" : "Sign in");
  const ariaCurrent = () => {
    const target = isSignedIn() ? "/dashboard" : "/auth";
    return props.pathname.startsWith(target) ? "page" : undefined;
  };

  return (
    <a class="lp-nav-signin" href={href()} aria-current={ariaCurrent()} data-i18n={i18nKey()}>
      {label()}
    </a>
  );
}
