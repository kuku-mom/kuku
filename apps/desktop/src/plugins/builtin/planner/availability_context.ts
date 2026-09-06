import type { PlannerTask } from "~/lib/planner_tasks";

import type { BusyInterval } from "./availability";
import type { PlannerService } from "./service";
import { externalKey, eventRefKey, type ExternalItem, type CalendarChoice } from "./types";

export function planningKey(item: PlannerTask | ExternalItem): string {
  return "path" in item
    ? `task:${item.path}:${item.id}`
    : `${item.kind === "reminder" ? "reminder" : "event"}:${item.writeRef ? eventRefKey(item.writeRef) : externalKey(item)}`;
}

export function taskPlanningDestination(
  service: PlannerService,
  item: PlannerTask | ExternalItem,
): CalendarChoice | null {
  const reference = service.timeBlockForTask(item)?.eventRef;
  return reference && reference.provider !== "apple-reminders"
    ? { provider: reference.provider, calendarId: reference.calendarId }
    : (service.state.preferences.defaultCalendar ?? null);
}

export function planningCalendars(service: PlannerService, destination?: CalendarChoice | null) {
  return (["google", "apple-calendar"] as const).flatMap((provider) => {
    if (!service.state.preferences.enabledSources[provider]) return [];
    const selected = service.state.preferences.selectedCalendars[provider];
    const known = new Set(service.state.sources[provider].calendars.map((calendar) => calendar.id));
    const visible = new Set(service.visibleCalendars(provider).map((calendar) => calendar.id));
    // A missing cached calendar is unresolved, not proof that its time is free.
    // Keep it for fresh provider validation, excluding only known alternate connections.
    const ids = selected.filter((id) => !known.has(id) || visible.has(id));
    if (destination?.provider === provider && !ids.includes(destination.calendarId))
      ids.push(destination.calendarId);
    return ids.length ? [{ provider, ids }] : [];
  });
}

export function visiblePlanningEvents(service: PlannerService): ExternalItem[] {
  return planningCalendars(service).flatMap(({ provider, ids }) =>
    service.state.sources[provider].items.filter(
      (item) => item.kind === "event" && ids.includes(item.calendarId),
    ),
  );
}

export function planningExcludedKeys(
  service: PlannerService,
  item?: PlannerTask | ExternalItem,
): string[] {
  if (!item) return [];
  const keys = [planningKey(item)];
  if (!("path" in item) && item.kind === "event") {
    const task = service.linkedTask(item);
    if (task) keys.push(planningKey(task));
  } else {
    const link = service.timeBlockForTask(item);
    if (link) keys.push(`event:${eventRefKey(link.eventRef)}`);
  }
  return keys;
}

/** A linked note task and its provider event occupy a single calendar block.
 * Completed blocks still occupy time, exactly as they do in Planner's history. */
export function planningIntervals(
  service: PlannerService,
  events: readonly ExternalItem[] = visiblePlanningEvents(service),
): BusyInterval[] {
  const local = service.state.tasks.filter(
    (task) => task.metadata?.scheduledStart && task.metadata.scheduledEnd,
  );
  const result: BusyInterval[] = local.map((task) => ({
    key: planningKey(task),
    title: task.title,
    start: task.metadata!.scheduledStart!,
    end: task.metadata!.scheduledEnd!,
  }));
  for (const event of events) {
    if (event.kind !== "event" || !event.start || !event.end) continue;
    const linked = service.linkedTask(event);
    if (
      linked &&
      "path" in linked &&
      local.some(
        (task) =>
          task.path === linked.path &&
          task.id === linked.id &&
          Date.parse(task.metadata!.scheduledStart!) === Date.parse(event.start!) &&
          Date.parse(task.metadata!.scheduledEnd!) === Date.parse(event.end!),
      )
    )
      continue;
    result.push({
      key: planningKey(event),
      title: event.title,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
    });
  }
  return result;
}
