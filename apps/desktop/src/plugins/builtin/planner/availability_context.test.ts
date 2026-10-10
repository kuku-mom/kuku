import { describe, expect, it } from "vitest";

import type { PlannerTask } from "~/lib/planner_tasks";

import { analyzeOverlap } from "./availability";
import {
  planningCalendars,
  planningExcludedKeys,
  planningIntervals,
  planningKey,
  visiblePlanningEvents,
} from "./availability_context";
import type { PlannerService } from "./service";
import {
  DEFAULT_PREFERENCES,
  eventRefKey,
  externalKey,
  type ExternalItem,
  type Provider,
  type SourceState,
} from "./types";

const start = "2026-09-04T09:00:00+09:00";
const end = "2026-09-04T10:00:00+09:00";

function task(id: string, checked = false): PlannerTask {
  return {
    id,
    path: "Tasks/List.md",
    title: id,
    checked,
    sourceStart: 0,
    sourceEnd: 40,
    metadata: { id, scheduledStart: start, scheduledEnd: end },
  };
}

function event(id: string, provider: Provider = "google", calendarId = "work"): ExternalItem {
  return {
    id: `display:${id}`,
    title: id,
    provider,
    calendarId,
    kind: "event",
    start,
    end,
    allDay: false,
    writeRef: { provider, calendarId, itemId: id, version: "1", occurrence: start },
    occurrence: start,
  };
}

function fixture() {
  const source = (provider: Provider, calendarId: string): SourceState => ({
    status: { provider, connected: true, configured: true },
    calendars: [{ id: calendarId, provider, title: calendarId }],
    items: [],
    loading: false,
  });
  const state = {
    tasks: [] as PlannerTask[],
    preferences: structuredClone(DEFAULT_PREFERENCES),
    sources: {
      google: source("google", "work"),
      "apple-calendar": source("apple-calendar", "personal"),
      "apple-reminders": source("apple-reminders", "reminders"),
    },
  };
  state.preferences.enabledSources.google = true;
  state.preferences.enabledSources["apple-calendar"] = true;
  state.preferences.selectedCalendars.google = ["work"];
  state.preferences.selectedCalendars["apple-calendar"] = ["personal"];
  const linked = new Map<string, PlannerTask | ExternalItem>();
  const blocks = new Map<string, { eventRef: NonNullable<ExternalItem["writeRef"]> }>();
  const hiddenCalendars = new Set<string>();
  const refKey = (item: ExternalItem) =>
    item.writeRef ? eventRefKey(item.writeRef) : externalKey(item);
  const service = {
    state,
    visibleCalendars: (provider: Provider) =>
      state.sources[provider].calendars.filter((calendar) => !hiddenCalendars.has(calendar.id)),
    linkedTask: (item: ExternalItem) => linked.get(refKey(item)) ?? null,
    timeBlockForTask: (item: PlannerTask | ExternalItem) => blocks.get(planningKey(item)),
  } as unknown as PlannerService;
  return {
    service,
    state,
    hiddenCalendars,
    link: (item: PlannerTask | ExternalItem, block: ExternalItem) => {
      linked.set(refKey(block), item);
      blocks.set(planningKey(item), { eventRef: block.writeRef! });
    },
  };
}

describe("availability context", () => {
  it("counts a synchronized note/event once while preserving completed task history", () => {
    const { service, state, link } = fixture();
    const note = task("complete-linked", true);
    const completed = task("complete-local", true);
    const block = event("linked-event");
    state.tasks.push(note, completed);
    state.sources.google.items.push(block);
    link(note, block);
    const intervals = planningIntervals(service);
    expect(intervals.map((item) => item.key)).toEqual([planningKey(note), planningKey(completed)]);
    expect(analyzeOverlap({ start, end }, intervals).minutes).toBe(60);
  });

  it("keeps a moved remote block busy until its linked note time is reconciled", () => {
    const { service, state, link } = fixture();
    const note = task("local-old-time");
    const latest = {
      ...event("changed-event"),
      start: "2026-09-04T11:00:00+09:00",
      end: "2026-09-04T12:00:00+09:00",
    };
    state.tasks.push(note);
    link(note, latest);
    const intervals = planningIntervals(service, [latest]);
    expect(analyzeOverlap({ start, end }, intervals).minutes).toBe(60);
    expect(analyzeOverlap({ start: latest.start, end: latest.end }, intervals).minutes).toBe(60);
  });

  it("excludes the same work when editing its source note, linked event, or standalone event", () => {
    const { service, state, link } = fixture();
    const note = task("note");
    const block = event("note-block");
    state.tasks.push(note);
    link(note, block);
    const intervals = planningIntervals(service, [block]);
    for (const selected of [note, block]) {
      expect(
        analyzeOverlap({ start, end }, intervals, planningExcludedKeys(service, selected)).minutes,
      ).toBe(0);
    }
    const standalone = event("standalone");
    const { service: standaloneService } = fixture();
    expect(
      analyzeOverlap(
        { start, end },
        planningIntervals(standaloneService, [standalone]),
        planningExcludedKeys(standaloneService, standalone),
      ).minutes,
    ).toBe(0);
  });

  it("excludes a reminder's linked block even when the provider display ID differs from its write reference", () => {
    const { service, link } = fixture();
    const reminder: ExternalItem = {
      ...event("reminder", "apple-reminders", "reminders"),
      kind: "reminder",
      completed: false,
    };
    const block = event("raw-google-event-id");
    link(reminder, block);
    expect(block.id).not.toBe(block.writeRef!.itemId);
    const intervals = planningIntervals(service, [block]);
    const excluded = planningExcludedKeys(service, reminder);
    expect(analyzeOverlap({ start, end }, intervals, excluded).minutes).toBe(0);
    expect(analyzeOverlap({ start, end }, intervals).minutes).toBe(60);
  });

  it("includes only selected visible calendars from enabled calendar providers", () => {
    const { service, state, hiddenCalendars } = fixture();
    state.sources.google.calendars.push(
      { id: "other", provider: "google", title: "Other" },
      { id: "duplicate", provider: "google", title: "Duplicate" },
    );
    state.preferences.selectedCalendars.google.push("duplicate");
    hiddenCalendars.add("duplicate");
    state.sources.google.items.push(
      event("work"),
      event("other", "google", "other"),
      event("hidden", "google", "duplicate"),
    );
    state.sources["apple-calendar"].items.push(event("apple", "apple-calendar", "personal"));
    state.preferences.enabledSources["apple-calendar"] = false;
    expect(planningCalendars(service)).toEqual([{ provider: "google", ids: ["work"] }]);
    expect(visiblePlanningEvents(service).map((item) => item.title)).toEqual(["work"]);
  });

  it("includes an unselected destination once without changing the displayed calendar selection", () => {
    const { service, state } = fixture();
    state.preferences.enabledSources["apple-calendar"] = false;
    state.sources.google.calendars.push({
      id: "destination",
      provider: "google",
      title: "Destination",
    });
    const selected = state.preferences.selectedCalendars.google;
    Object.freeze(selected);
    expect(planningCalendars(service, { provider: "google", calendarId: "destination" })).toEqual([
      { provider: "google", ids: ["work", "destination"] },
    ]);
    expect(planningCalendars(service, { provider: "google", calendarId: "work" })).toEqual([
      { provider: "google", ids: ["work"] },
    ]);

    state.sources.google.calendars = [];
    expect(planningCalendars(service, { provider: "google", calendarId: "destination" })).toEqual([
      { provider: "google", ids: ["work", "destination"] },
    ]);
    expect(state.preferences.selectedCalendars.google).toBe(selected);
    expect(selected).toEqual(["work"]);
  });

  it("retains disconnected selected calendars as unresolved targets instead of claiming a local-only empty schedule", () => {
    const { service, state } = fixture();
    state.preferences.enabledSources["apple-calendar"] = false;
    state.sources.google.status.connected = false;
    state.sources.google.calendars = [];
    state.sources.google.items = [];
    const targets = planningCalendars(service);
    expect(targets).toEqual([{ provider: "google", ids: ["work"] }]);
    expect(targets.some((target) => !state.sources[target.provider].status.connected)).toBe(true);
    state.preferences.enabledSources.google = false;
    expect(planningCalendars(service)).toEqual([]);
  });

  it("retains unresolved selections when the cached calendar list is only partially populated", () => {
    const { service, state, hiddenCalendars } = fixture();
    state.preferences.enabledSources["apple-calendar"] = false;
    state.preferences.selectedCalendars.google = ["work", "unresolved", "alternate"];
    state.sources.google.calendars.push({
      id: "alternate",
      provider: "google",
      title: "Alternate",
    });
    hiddenCalendars.add("alternate");
    expect(planningCalendars(service)).toEqual([
      { provider: "google", ids: ["work", "unresolved"] },
    ]);
  });
});
