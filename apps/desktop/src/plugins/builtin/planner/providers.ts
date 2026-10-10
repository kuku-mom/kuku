import { invoke } from "@tauri-apps/api/core";

import type {
  ConnectionStatus,
  EventRef,
  ExternalCalendar,
  ExternalItem,
  ItemDraft,
  ItemPatch,
  Provider,
} from "./types";

function command(provider: Provider, action: string) {
  return provider === "google" ? `planner_google_${action}` : `planner_apple_${action}`;
}
function args(provider: Provider) {
  return provider === "google"
    ? {}
    : { kind: provider === "apple-calendar" ? "calendar" : "reminders" };
}
export const providers = {
  status: (provider: Provider) =>
    invoke<ConnectionStatus>(command(provider, "status"), args(provider)),
  connect: (provider: Provider) =>
    invoke<ConnectionStatus>(command(provider, "connect"), args(provider)),
  disconnect: (provider: Provider) =>
    invoke<ConnectionStatus | void>(command(provider, "disconnect"), args(provider)),
  calendars: (provider: Provider) =>
    invoke<ExternalCalendar[]>(command(provider, "calendars"), args(provider)),
  items: (
    provider: Provider,
    calendarIds: string[],
    start: string,
    end: string,
    timeZone: string,
  ) =>
    invoke<ExternalItem[]>(command(provider, provider === "google" ? "events" : "items"), {
      ...args(provider),
      calendarIds,
      start,
      end,
      timeZone,
    }),
  appleRevision: () => invoke<number>("planner_apple_revision"),
  get: (eventRef: EventRef) =>
    invoke<ExternalItem | null>(command(eventRef.provider, "get"), {
      ...args(eventRef.provider),
      eventRef,
    }),
  create: (provider: Provider, calendarId: string, draft: ItemDraft, operationId: string) =>
    invoke<ExternalItem>(command(provider, "create"), {
      ...args(provider),
      calendarId,
      draft,
      operationId,
    }),
  update: (eventRef: EventRef, patch: ItemPatch, operationId: string) =>
    invoke<ExternalItem>(command(eventRef.provider, "update"), {
      ...args(eventRef.provider),
      eventRef,
      patch,
      operationId,
    }),
  delete: (eventRef: EventRef, operationId: string) =>
    invoke<void>(command(eventRef.provider, "delete"), {
      ...args(eventRef.provider),
      eventRef,
      operationId,
    }),
  suspend: () =>
    Promise.allSettled([
      invoke<void>("planner_google_suspend"),
      invoke<void>("planner_apple_suspend"),
    ]),
};
