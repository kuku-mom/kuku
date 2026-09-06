import { createEffect, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js";

import { vaultState } from "~/stores/vault";

import { addDays, dateFromKey, localDate } from "./dates";
import { providers } from "./providers";
import type { PlannerService } from "./service";
import { PROVIDERS, type ConnectionStatus, type ExternalItem, type Provider } from "./types";

export interface TodaySource {
  items: ExternalItem[];
  loading: boolean;
  updatedAt?: string;
  error?: string;
  reconnect: boolean;
}

export interface TodaySourceChoice {
  provider: Provider;
  calendarIds: string[];
  enabled: boolean;
}

interface TodayAdapter {
  status: (provider: Provider) => Promise<ConnectionStatus>;
  items: typeof providers.items;
}

function emptySource(): TodaySource {
  return { items: [], loading: false, reconnect: false, updatedAt: undefined, error: undefined };
}

export function todayQueryRange(now = new Date()) {
  const day = localDate(now);
  return {
    start: dateFromKey(day).toISOString(),
    end: dateFromKey(addDays(day, 7)).toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function upcomingEvents(items: ExternalItem[], now = new Date(), limit = 5) {
  const day = localDate(now);
  const endDay = addDays(day, 7);
  const horizon = dateFromKey(endDay).getTime();
  return items
    .filter((item) => {
      if (item.kind !== "event" || !item.start || !item.end) return false;
      if (item.allDay) return item.end > day && item.start < endDay;
      return Date.parse(item.end) > now.getTime() && Date.parse(item.start) < horizon;
    })
    .sort((a, b) => {
      const start = (item: ExternalItem) =>
        item.allDay ? dateFromKey(item.start!.slice(0, 10)).getTime() : Date.parse(item.start!);
      return start(a) - start(b) || a.title.localeCompare(b.title);
    })
    .slice(0, limit);
}

/** A separate read-only snapshot: browsing the central calendar never changes this range. */
export class TodayFeed {
  private choices = new Map<Provider, string[]>();
  private sequences = new Map<Provider, number>();
  private readonly read;
  private readonly write;
  private readonly adapter: TodayAdapter;
  private readonly now: () => Date;

  constructor(adapter: TodayAdapter = providers, now: () => Date = () => new Date()) {
    this.adapter = adapter;
    this.now = now;
    [this.read, this.write] = createSignal<Record<Provider, TodaySource>>({
      google: emptySource(),
      "apple-calendar": emptySource(),
      "apple-reminders": emptySource(),
    });
  }

  readonly state = () => this.read();

  private update(provider: Provider, patch: Partial<TodaySource>) {
    this.write((previous) => ({ ...previous, [provider]: { ...previous[provider], ...patch } }));
  }

  configure(choices: TodaySourceChoice[]) {
    let changed = false;
    for (const provider of PROVIDERS) {
      const choice = choices.find((entry) => entry.provider === provider);
      const next = choice?.enabled ? [...new Set(choice.calendarIds)].sort() : [];
      const previous = this.choices.get(provider) ?? [];
      if (JSON.stringify(next) === JSON.stringify(previous)) continue;
      changed = true;
      this.choices.set(provider, next);
      this.sequences.set(provider, (this.sequences.get(provider) ?? 0) + 1);
      this.update(provider, {
        ...(next.length ? {} : emptySource()),
        items: this.read()[provider].items.filter((item) => next.includes(item.calendarId)),
        loading: false,
        error: undefined,
        reconnect: false,
      });
    }
    return changed;
  }

  async refresh(recheckPermission = false) {
    await Promise.all(PROVIDERS.map((provider) => this.refreshSource(provider, recheckPermission)));
  }

  private async refreshSource(provider: Provider, recheckPermission: boolean) {
    const ids = this.choices.get(provider) ?? [];
    if (!ids.length || (this.read()[provider].reconnect && !recheckPermission)) return;
    const sequence = (this.sequences.get(provider) ?? 0) + 1;
    this.sequences.set(provider, sequence);
    const current = () => this.sequences.get(provider) === sequence;
    this.update(provider, { loading: true, error: undefined });
    try {
      const status = await this.adapter.status(provider);
      if (!current()) return;
      if (!status.connected) {
        this.update(provider, { ...emptySource(), reconnect: true, error: status.error });
        return;
      }
      const range = todayQueryRange(this.now());
      const items = await this.adapter.items(provider, ids, range.start, range.end, range.timeZone);
      if (!current()) return;
      this.update(provider, {
        items: items.filter((item) => item.provider === provider && ids.includes(item.calendarId)),
        updatedAt: this.now().toISOString(),
        reconnect: false,
        error: undefined,
      });
    } catch (error) {
      if (!current()) return;
      try {
        const status = await this.adapter.status(provider);
        if (!current()) return;
        if (!status.connected) this.update(provider, { ...emptySource(), reconnect: true });
      } catch {
        // An unavailable network is not evidence that authorization was revoked.
      }
      if (current())
        this.update(provider, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (current()) this.update(provider, { loading: false });
    }
  }

  stop() {
    for (const provider of PROVIDERS) {
      this.sequences.set(provider, (this.sequences.get(provider) ?? 0) + 1);
      this.update(provider, { loading: false });
    }
  }

  reset() {
    this.stop();
    this.choices.clear();
    for (const provider of PROVIDERS) this.update(provider, emptySource());
  }
}

const feeds = new WeakMap<PlannerService, TodayFeed>();
const activeFeeds = new WeakSet<PlannerService>();
const feedVaults = new WeakMap<PlannerService, string | null>();

export function refreshTodayFeed(service: PlannerService) {
  return activeFeeds.has(service) ? feeds.get(service)?.refresh() : undefined;
}

export function createTodayFeed(service: PlannerService, enabled: Accessor<boolean>) {
  let feed = feeds.get(service);
  if (!feed) {
    feed = new TodayFeed();
    feeds.set(service, feed);
  }
  const current = feed;
  if (feedVaults.get(service) !== vaultState.rootPath) current.reset();
  feedVaults.set(service, vaultState.rootPath);
  let active = false;
  let revision: number | undefined;
  let revisionPending = false;
  let disposed = false;
  let vault = vaultState.rootPath;
  const refresh = () => {
    if (enabled() && document.visibilityState !== "hidden") void current.refresh();
  };
  createEffect(
    on(
      () => ({
        choices: PROVIDERS.map((provider) => {
          const source = service.state.sources[provider];
          const visible = new Set(
            service.visibleCalendars(provider).map((calendar) => calendar.id),
          );
          return {
            provider,
            enabled: source.status.connected && service.state.preferences.enabledSources[provider],
            calendarIds: service.state.preferences.selectedCalendars[provider].filter((id) =>
              visible.has(id),
            ),
          };
        }),
        show: enabled(),
        vault: vaultState.rootPath,
      }),
      (settings) => {
        if (vault !== settings.vault) {
          current.reset();
          vault = settings.vault;
          feedVaults.set(service, vault);
          active = false;
        }
        const changed = current.configure(settings.choices);
        const show = settings.show;
        if (show) activeFeeds.add(service);
        else activeFeeds.delete(service);
        if (show && (!active || changed)) refresh();
        else if (!show && active) current.stop();
        active = show;
      },
    ),
  );
  onMount(() => {
    const interval = setInterval(refresh, 5 * 60000);
    const appleInterval = setInterval(() => {
      if (
        !enabled() ||
        document.visibilityState === "hidden" ||
        revisionPending ||
        !["apple-calendar", "apple-reminders"].some((provider) => {
          const key = provider as Provider;
          return (
            service.state.preferences.enabledSources[key] &&
            service.state.sources[key].status.connected
          );
        })
      )
        return;
      revisionPending = true;
      void providers
        .appleRevision()
        .then((next) => {
          if (disposed) return;
          if (revision !== undefined && revision !== next) refresh();
          revision = next;
        })
        .catch(() => {})
        .finally(() => {
          revisionPending = false;
        });
    }, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    onCleanup(() => {
      disposed = true;
      activeFeeds.delete(service);
      clearInterval(interval);
      clearInterval(appleInterval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      current.stop();
    });
  });
  return current;
}
