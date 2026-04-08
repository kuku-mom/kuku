import { createSignal, onMount } from "solid-js";

import { getProfile } from "@/lib/api/dashboard";

export default function AuthNavLink() {
  const [isSignedIn, setIsSignedIn] = createSignal(false);

  onMount(() => {
    void checkAuth();
  });

  async function checkAuth() {
    try {
      await getProfile();
      setIsSignedIn(true);
    } catch {
      setIsSignedIn(false);
    }
  }

  return (
    <a href={isSignedIn() ? "/dashboard" : "/auth/signin"}>
      {isSignedIn() ? "Dashboard" : "Login"}
    </a>
  );
}
