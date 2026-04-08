import {
  For,
  type JSX,
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import {
  type CurrentUsage,
  type DailyUsageData,
  type DashboardRoute,
  type LoadState,
  type PlanName,
  type SubscriptionInfo,
  type UsageDays,
  type UserProfile,
  deleteAccount,
  getCurrentUsage,
  getProfile,
  getSubscription,
  getUsageStats,
  signOut,
  updateProfile,
} from "@/lib/api/dashboard";

interface DashboardAppProps {
  initialRoute: DashboardRoute;
}

const routes = [
  { href: "/dashboard", id: "overview", label: "Overview" },
  { href: "/dashboard/billing", id: "billing", label: "Billing" },
  { href: "/dashboard/settings", id: "settings", label: "Settings" },
  { href: "/dashboard/downloads", id: "downloads", label: "Downloads" },
] as const satisfies readonly { href: string; id: DashboardRoute; label: string }[];

const planCopy: Record<PlanName, { label: string; limit: number }> = {
  FREE: { label: "Free", limit: 100 },
  PRO: { label: "Pro", limit: 500 },
  ULTRA: { label: "Ultra", limit: 10000 },
};

function routeFromPath(pathname: string): DashboardRoute {
  const normalized = pathname.replace(/\/+$/, "");

  if (normalized === "/dashboard/billing") {
    return "billing";
  }

  if (normalized === "/dashboard/settings") {
    return "settings";
  }

  if (normalized === "/dashboard/downloads") {
    return "downloads";
  }

  return "overview";
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function usagePercent(usage: CurrentUsage | null): number {
  if (!usage || usage.aiRequestsLimit <= 0) {
    return 0;
  }

  return Math.min(100, Math.round((usage.aiRequestsUsed / usage.aiRequestsLimit) * 100));
}

function DashboardPanel(props: { children: JSX.Element; title: string }) {
  return (
    <section class="dashboard-panel" aria-labelledby={`${props.title.replaceAll(" ", "-")}-title`}>
      <h2 id={`${props.title.replaceAll(" ", "-")}-title`}>{props.title}</h2>
      {props.children}
    </section>
  );
}

function UsageChart(props: { data: DailyUsageData[] }) {
  const chartData = () => props.data.slice(-7);
  const maxValue = () => Math.max(1, ...chartData().map((item) => item.aiRequests));

  return (
    <div class="usage-chart" aria-label="Daily usage">
      <For each={chartData()}>
        {(item) => {
          const height = () => `${Math.max(8, (item.aiRequests / maxValue()) * 100)}%`;

          return (
            <div class="usage-chart-column">
              <div class="usage-chart-bar" style={{ height: height() }} />
              <span>
                {item.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function LoadingText(props: { label: string; state: LoadState }) {
  return (
    <Switch>
      <Match when={props.state === "loading"}>
        <p class="muted-copy">Loading {props.label}...</p>
      </Match>
      <Match when={props.state === "error"}>
        <p class="error-copy">Unable to load {props.label}.</p>
      </Match>
    </Switch>
  );
}

export default function DashboardApp(props: DashboardAppProps) {
  const [route, setRoute] = createSignal<DashboardRoute>(props.initialRoute);
  const [profileState, setProfileState] = createSignal<LoadState>("idle");
  const [subscriptionState, setSubscriptionState] = createSignal<LoadState>("idle");
  const [usageState, setUsageState] = createSignal<LoadState>("idle");
  const [statsState, setStatsState] = createSignal<LoadState>("idle");
  const [profile, setProfile] = createSignal<UserProfile | null>(null);
  const [subscription, setSubscription] = createSignal<SubscriptionInfo | null>(null);
  const [currentUsage, setCurrentUsage] = createSignal<CurrentUsage | null>(null);
  const [dailyUsage, setDailyUsage] = createSignal<DailyUsageData[]>([]);
  const [usageDays, setUsageDays] = createSignal<UsageDays>(7);
  const [editName, setEditName] = createSignal("");
  const [profileMessage, setProfileMessage] = createSignal("");
  const [deleteConfirmText, setDeleteConfirmText] = createSignal("");

  const currentPlan = () => subscription()?.plan ?? "FREE";
  const currentPlanCopy = () => planCopy[currentPlan()];
  const currentRoute = () => routes.find((item) => item.id === route()) ?? routes[0];

  async function loadProfile() {
    setProfileState("loading");

    try {
      const data = await getProfile();
      setProfile(data);
      setEditName(data.name);
      setProfileState("success");
    } catch {
      setProfileState("error");
    }
  }

  async function loadSubscription() {
    setSubscriptionState("loading");

    try {
      setSubscription(await getSubscription());
      setSubscriptionState("success");
    } catch {
      setSubscriptionState("error");
    }
  }

  async function loadUsage() {
    setUsageState("loading");

    try {
      setCurrentUsage(await getCurrentUsage());
      setUsageState("success");
    } catch {
      setUsageState("error");
    }
  }

  async function loadUsageStats(days: UsageDays) {
    setStatsState("loading");

    try {
      setDailyUsage(await getUsageStats(days));
      setStatsState("success");
    } catch {
      setStatsState("error");
    }
  }

  function syncRoute() {
    setRoute(routeFromPath(window.location.pathname));
  }

  function navigate(event: MouseEvent, href: string) {
    event.preventDefault();
    window.history.pushState({}, "", href);
    syncRoute();
  }

  async function handleSaveProfile(event: SubmitEvent) {
    event.preventDefault();
    const trimmedName = editName().trim();

    if (!trimmedName) {
      setProfileMessage("Enter a name.");
      return;
    }

    setProfileMessage("Saving...");

    try {
      const updatedProfile = await updateProfile(trimmedName);
      setProfile(updatedProfile);
      setEditName(updatedProfile.name);
      setProfileMessage("Saved.");
    } catch {
      setProfileMessage("Unable to save profile.");
    }
  }

  async function handleSignOut() {
    try {
      await signOut();
    } finally {
      window.location.href = "/";
    }
  }

  async function handleDeleteAccount() {
    if (deleteConfirmText() !== "delete my account") {
      return;
    }

    try {
      await deleteAccount();
    } finally {
      window.location.href = "/";
    }
  }

  onMount(() => {
    syncRoute();
    window.addEventListener("popstate", syncRoute);

    void Promise.all([loadProfile(), loadSubscription(), loadUsage(), loadUsageStats(usageDays())]);
  });

  onCleanup(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", syncRoute);
    }
  });

  createEffect(
    on(
      usageDays,
      (days) => {
        void loadUsageStats(days);
      },
      { defer: true },
    ),
  );

  return (
    <div class="dashboard-shell">
      <aside class="dashboard-sidebar" aria-label="Dashboard navigation">
        <a
          class="dashboard-brand"
          href="/dashboard"
          onClick={(event) => navigate(event, "/dashboard")}
        >
          <img src="/logo.svg" alt="" />
          <span>kuku</span>
        </a>

        <div class="dashboard-user">
          <Show when={profile()} fallback={<LoadingText label="profile" state={profileState()} />}>
            {(loadedProfile) => (
              <>
                <strong>{loadedProfile().name}</strong>
                <span>{loadedProfile().email}</span>
              </>
            )}
          </Show>
        </div>

        <nav class="dashboard-nav">
          <For each={routes}>
            {(item) => (
              <a
                aria-current={route() === item.id ? "page" : undefined}
                href={item.href}
                onClick={(event) => navigate(event, item.href)}
              >
                {item.label}
              </a>
            )}
          </For>
        </nav>

        <button class="dashboard-signout" type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </aside>

      <main class="dashboard-main">
        <div class="dashboard-main-header">
          <div>
            <p class="dashboard-eyebrow">DASHBOARD</p>
            <h1>{currentRoute().label}</h1>
          </div>
          <a href="/">Home</a>
        </div>

        <Switch>
          <Match when={route() === "overview"}>
            <div class="dashboard-grid">
              <DashboardPanel title="Plan">
                <LoadingText label="subscription" state={subscriptionState()} />
                <Show when={subscription()}>
                  {(loadedSubscription) => (
                    <>
                      <p class="metric-value">{planCopy[loadedSubscription().plan].label}</p>
                      <p class="muted-copy">
                        {loadedSubscription().status === "ACTIVE" ? "Active" : "Canceled"} through{" "}
                        {formatDate(loadedSubscription().currentPeriodEnd)}
                      </p>
                    </>
                  )}
                </Show>
              </DashboardPanel>

              <DashboardPanel title="Usage">
                <LoadingText label="usage" state={usageState()} />
                <Show when={currentUsage()}>
                  {(usage) => (
                    <>
                      <p class="metric-value">
                        {usage().aiRequestsUsed}
                        <span> / {usage().aiRequestsLimit}</span>
                      </p>
                      <div class="usage-meter" aria-label={`${usagePercent(usage())}% used`}>
                        <span style={{ width: `${usagePercent(usage())}%` }} />
                      </div>
                    </>
                  )}
                </Show>
              </DashboardPanel>

              <section class="dashboard-panel dashboard-panel-wide">
                <div class="dashboard-panel-heading">
                  <h2>Daily Usage</h2>
                  <div class="segmented-control" aria-label="Usage range">
                    <button
                      aria-pressed={usageDays() === 7}
                      type="button"
                      onClick={() => setUsageDays(7)}
                    >
                      7d
                    </button>
                    <button
                      aria-pressed={usageDays() === 30}
                      type="button"
                      onClick={() => setUsageDays(30)}
                    >
                      30d
                    </button>
                  </div>
                </div>
                <LoadingText label="daily usage" state={statsState()} />
                <Show
                  when={dailyUsage().length > 0}
                  fallback={<p class="muted-copy">No usage yet.</p>}
                >
                  <UsageChart data={dailyUsage()} />
                </Show>
              </section>
            </div>
          </Match>

          <Match when={route() === "billing"}>
            <div class="dashboard-grid">
              <DashboardPanel title="Current Plan">
                <LoadingText label="subscription" state={subscriptionState()} />
                <Show when={subscription()}>
                  {(loadedSubscription) => (
                    <>
                      <p class="metric-value">{planCopy[loadedSubscription().plan].label}</p>
                      <p class="muted-copy">
                        {loadedSubscription().cancelAtPeriodEnd
                          ? `Ends on ${formatDate(loadedSubscription().currentPeriodEnd)}`
                          : `Renews on ${formatDate(loadedSubscription().currentPeriodEnd)}`}
                      </p>
                    </>
                  )}
                </Show>
              </DashboardPanel>

              <DashboardPanel title="Plan Limit">
                <p class="metric-value">{currentPlanCopy().limit}</p>
                <p class="muted-copy">AI requests per month.</p>
              </DashboardPanel>
            </div>
          </Match>

          <Match when={route() === "settings"}>
            <div class="dashboard-grid">
              <section class="dashboard-panel dashboard-panel-wide">
                <h2>Profile</h2>
                <form class="settings-form" onSubmit={handleSaveProfile}>
                  <label>
                    Name
                    <input
                      value={editName()}
                      onInput={(event) => setEditName(event.currentTarget.value)}
                    />
                  </label>
                  <button type="submit">Save profile</button>
                  <Show when={profileMessage()}>
                    <p class="muted-copy">{profileMessage()}</p>
                  </Show>
                </form>
              </section>

              <section class="dashboard-panel dashboard-panel-wide danger-panel">
                <h2>Delete Account</h2>
                <p class="muted-copy">Type "delete my account" to continue.</p>
                <div class="settings-form">
                  <label>
                    Confirmation
                    <input
                      value={deleteConfirmText()}
                      onInput={(event) => setDeleteConfirmText(event.currentTarget.value)}
                    />
                  </label>
                  <button
                    disabled={deleteConfirmText() !== "delete my account"}
                    type="button"
                    onClick={handleDeleteAccount}
                  >
                    Delete account
                  </button>
                </div>
              </section>
            </div>
          </Match>

          <Match when={route() === "downloads"}>
            <DashboardPanel title="Desktop App">
              <p class="muted-copy">Download the latest macOS build.</p>
              <a class="dashboard-action-link" href="https://www.kuku.mom">
                Download for macOS
              </a>
            </DashboardPanel>
          </Match>
        </Switch>
      </main>
    </div>
  );
}
