import { describe, expect, it, vi } from "vitest";

vi.mock("~/stores/vault", () => ({ vaultState: { rootPath: "/vault" } }));

import { TodayFeed, todayQueryRange, upcomingEvents } from "./today_feed";
import type { ConnectionStatus, ExternalItem, Provider } from "./types";

const now = new Date("2026-09-04T12:00:00+09:00");

function event(id: string, start = "2026-09-04T14:00:00+09:00"): ExternalItem {
  return {
    id,
    provider: "google",
    calendarId: "work",
    title: id,
    kind: "event",
    allDay: false,
    start,
    end: new Date(Date.parse(start) + 3600000).toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  let connected = true;
  const status = vi.fn(
    async (provider: Provider): Promise<ConnectionStatus> => ({
      provider,
      connected,
      configured: true,
    }),
  );
  const items = vi.fn(async () => [event("next")]);
  const feed = new TodayFeed({ status, items }, () => now);
  feed.configure([{ provider: "google", calendarIds: ["work"], enabled: true }]);
  return {
    feed,
    status,
    items,
    disconnect: () => {
      connected = false;
    },
  };
}

describe("independent Today feed", () => {
  it("queries from today's local midnight for seven civil dates", async () => {
    const { feed, items } = setup();
    await feed.refresh();
    const range = todayQueryRange(now);
    expect(items).toHaveBeenCalledWith("google", ["work"], range.start, range.end, range.timeZone);
    const start = new Date(range.start);
    const end = new Date(range.end);
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(now.getDate());
    expect(end.getHours()).toBe(0);
    expect(end.getDate()).toBe(now.getDate() + 7);
    expect(feed.state().google.items[0].title).toBe("next");
    expect(feed.state().google.updatedAt).toBe(now.toISOString());
  });

  it("keeps the last successful snapshot and timestamp after a failed page/query", async () => {
    const { feed, items } = setup();
    await feed.refresh();
    items.mockRejectedValueOnce(new Error("Page 2 failed"));
    await feed.refresh();
    expect(feed.state().google.items).toEqual([event("next")]);
    expect(feed.state().google.updatedAt).toBe(now.toISOString());
    expect(feed.state().google.error).toBe("Page 2 failed");
    expect(feed.state().google.loading).toBe(false);
  });

  it("clears revoked-source data and stops automatic lookups until explicit recheck", async () => {
    const { feed, status, items, disconnect } = setup();
    await feed.refresh();
    disconnect();
    await feed.refresh();
    expect(feed.state().google).toMatchObject({ items: [], reconnect: true, updatedAt: undefined });
    const calls = status.mock.calls.length;
    await feed.refresh();
    expect(status).toHaveBeenCalledTimes(calls);
    expect(items).toHaveBeenCalledTimes(1);
    await feed.refresh(true);
    expect(status).toHaveBeenCalledTimes(calls + 1);
  });

  it("does not accept a late response after calendars are deselected", async () => {
    const { feed, items } = setup();
    const response = deferred<ExternalItem[]>();
    items.mockReturnValue(response.promise);
    const pending = feed.refresh();
    await Promise.resolve();
    feed.configure([{ provider: "google", calendarIds: [], enabled: true }]);
    response.resolve([event("late")]);
    await pending;
    expect(feed.state().google.items).toEqual([]);
    expect(feed.state().google.updatedAt).toBeUndefined();
    expect(feed.state().google.loading).toBe(false);
  });

  it("does not replace the new calendar selection with a previous response", async () => {
    const { feed, items } = setup();
    const response = deferred<ExternalItem[]>();
    items.mockReturnValueOnce(response.promise);
    const pending = feed.refresh();
    await Promise.resolve();
    feed.configure([{ provider: "google", calendarIds: ["personal"], enabled: true }]);
    items.mockResolvedValueOnce([{ ...event("personal event"), calendarId: "personal" }]);
    await feed.refresh();
    response.resolve([event("old work event")]);
    await pending;
    expect(feed.state().google.items.map((item) => item.title)).toEqual(["personal event"]);
  });

  it("invalidates in-flight data on unmount and clears it between vaults", async () => {
    const { feed, items } = setup();
    await feed.refresh();
    const response = deferred<ExternalItem[]>();
    items.mockReturnValue(response.promise);
    const pending = feed.refresh();
    await Promise.resolve();
    feed.stop();
    response.resolve([event("stale")]);
    await pending;
    expect(feed.state().google.items.map((item) => item.title)).toEqual(["next"]);
    feed.reset();
    expect(feed.state().google.items).toEqual([]);
    expect(feed.state().google.updatedAt).toBeUndefined();
  });
});

describe("upcoming display", () => {
  it("sorts by actual instants across offsets and omits ended or out-of-range events", () => {
    const earlier = event("earlier", "2026-09-04T04:00:00Z");
    const later = event("later", "2026-09-04T14:00:00+09:00");
    const ended = event("ended", "2026-09-04T00:00:00Z");
    const beyond = event("beyond", "2026-09-12T00:00:00Z");
    expect(upcomingEvents([later, beyond, ended, earlier], now).map((item) => item.id)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("keeps multi-day all-day events and uses the exclusive end date", () => {
    const ended = { ...event("yesterday"), allDay: true, start: "2026-09-02", end: "2026-09-04" };
    const ongoing = { ...event("trip"), allDay: true, start: "2026-09-03", end: "2026-09-06" };
    expect(upcomingEvents([ended, ongoing], now).map((item) => item.id)).toEqual(["trip"]);
  });
});
