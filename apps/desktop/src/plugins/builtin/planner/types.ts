export type Provider = "google" | "apple-calendar" | "apple-reminders";
export type TaskFilter = "today" | "upcoming" | "unplanned" | "completed";
export interface ExternalCalendar {
  id: string;
  provider: Provider;
  title: string;
  color?: string;
  accountId?: string;
  writable?: boolean;
  timeZone?: string;
  sourceTitle?: string;
  isDefault?: boolean;
}
export interface EventRef {
  provider: Provider;
  calendarId: string;
  itemId: string;
  version?: string;
  occurrence?: string;
  externalId?: string;
  start?: string;
  end?: string;
}
export interface ItemDraft {
  title: string;
  start?: string;
  end?: string;
  allDay: boolean;
  timeZone?: string;
  location?: string;
  description?: string;
  dueDate?: string;
  completed?: boolean;
}
export type ItemPatch = Partial<
  Omit<ItemDraft, "timeZone" | "location" | "description" | "dueDate">
> & {
  timeZone?: string | null;
  location?: string | null;
  description?: string | null;
  dueDate?: string | null;
};
export interface ExternalItem {
  id: string;
  calendarId: string;
  provider: Provider;
  title: string;
  kind: "event" | "reminder";
  start?: string;
  end?: string;
  allDay: boolean;
  dueDate?: string;
  completed?: boolean;
  timeZone?: string;
  url?: string;
  externalId?: string;
  occurrence?: string;
  writable?: boolean;
  location?: string;
  description?: string;
  writeRef?: EventRef;
  operationId?: string;
}
export interface ConnectionStatus {
  provider: Provider;
  connected: boolean;
  configured: boolean;
  error?: string;
  writable?: boolean;
}
export type CalendarChoice = { provider: "google" | "apple-calendar"; calendarId: string };
export type TaskRef =
  | { kind: "note"; taskId: string; path: string }
  | { kind: "reminder"; eventRef: EventRef };
export interface TimeBlockSnapshot {
  title: string;
  start: string;
  end: string;
  taskTitle: string;
  taskStart?: string;
  taskEnd?: string;
  taskChecked?: boolean;
  taskDueDate?: string;
}
export interface TimeBlockLink {
  id: string;
  task: TaskRef;
  eventRef: EventRef;
  title: string;
  start: string;
  end: string;
  timeZone?: string;
  lastSync: TimeBlockSnapshot;
  syncedAt?: string;
  status: "synced" | "pending" | "conflict" | "missing";
  error?: string;
}
export interface PendingOperation {
  id: string;
  type: "create" | "update" | "delete";
  provider: Provider;
  calendarId: string;
  eventRef?: EventRef;
  draft?: ItemDraft;
  patch?: ItemPatch;
  status: "pending" | "failed" | "conflict";
  attempts: number;
  createdAt: string;
  error?: string;
  linkId?: string;
  task?: TaskRef;
  /** The confirmed response is saved before changing the note/registry. */
  result?: ExternalItem | null;
  stage: "remote" | "local";
  cleanupResult?: boolean;
  origin?: "task" | "event" | "standalone";
  taskState?: { title: string; start?: string; end?: string; checked?: boolean; dueDate?: string };
}
export interface SourceState {
  status: ConnectionStatus;
  calendars: ExternalCalendar[];
  items: ExternalItem[];
  updatedAt?: string;
  range?: string;
  error?: string;
  loading: boolean;
}
export interface PlannerPreferences {
  excludedFolders: string[];
  selectedCalendars: Record<Provider, string[]>;
  enabledSources: Record<Provider, boolean>;
  defaultCalendar?: CalendarChoice | null;
  calendarAliases?: Record<string, string>;
  preferredConnectors?: Record<string, Provider>;
}
export const PROVIDERS: Provider[] = ["google", "apple-calendar", "apple-reminders"];
export const DEFAULT_PREFERENCES: PlannerPreferences = {
  excludedFolders: [],
  selectedCalendars: { google: [], "apple-calendar": [], "apple-reminders": [] },
  enabledSources: { google: false, "apple-calendar": false, "apple-reminders": false },
  defaultCalendar: null,
  calendarAliases: {},
  preferredConnectors: {},
};
export function externalKey(item: ExternalItem): string {
  return JSON.stringify([item.provider, item.calendarId, item.id, item.occurrence ?? ""]);
}
export function eventRefKey(ref: EventRef): string {
  return JSON.stringify([ref.provider, ref.calendarId, ref.itemId, ref.occurrence ?? ""]);
}
export function sameEventRef(a: EventRef, b: EventRef): boolean {
  return eventRefKey(a) === eventRefKey(b);
}
export function calendarKey(provider: Provider, calendarId: string): string {
  return JSON.stringify([provider, calendarId]);
}
