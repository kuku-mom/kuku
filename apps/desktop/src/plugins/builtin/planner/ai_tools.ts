import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { currentLocale } from "~/i18n";
import type { PlannerTask, TaskMetadata, TaskPatch } from "~/lib/planner_tasks";
import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import { focusTask } from "~/plugins/document_mutations";
import type { Disposer, PluginContext } from "~/plugins/types";
import { vaultState } from "~/stores/vault";

import { analyzeOverlap, suggestFreeSlots } from "./availability";
import {
  planningCalendars,
  planningExcludedKeys,
  planningIntervals,
  taskPlanningDestination,
} from "./availability_context";
import { addDays, dateFromKey, localDate, matchesFilter } from "./dates";
import { providers } from "./providers";
import type { PlannerService } from "./service";
import { queryTaskEntries, type TaskSort } from "./task_query";
import {
  PROVIDERS,
  calendarKey,
  eventRefKey,
  externalKey,
  sameEventRef,
  type CalendarChoice,
  type ExternalCalendar,
  type ExternalItem,
  type ItemDraft,
  type ItemPatch,
  type Provider,
  type TimeBlockLink,
} from "./types";
import { PlannerRequestReceipts, type PlannerCreationLocator } from "./ai_tools_receipts";
import {
  PlannerAiError,
  bool,
  canonical,
  choice,
  copy,
  date,
  instant,
  integer,
  invalid,
  object,
  refSchema,
  requestSchema,
  revisionSchema,
  schema,
  stringSchema,
  text,
  timeZone,
  title,
} from "./ai_tools_validation";

export const PLANNER_AI_TOOL_NAMES = [
  "planner_tasks_search",
  "planner_task_read",
  "planner_task_create",
  "planner_task_update",
  "planner_task_complete",
  "planner_task_schedule",
  "planner_task_unassign",
  "planner_task_delete",
  "planner_calendars_list",
  "planner_events_list",
  "planner_event_read",
  "planner_event_create",
  "planner_event_update",
  "planner_event_delete",
  "planner_availability",
  "planner_open_source",
  "planner_link_note",
] as const;
type ToolName = (typeof PLANNER_AI_TOOL_NAMES)[number];
type TaskItem = PlannerTask | ExternalItem;
type CalendarProvider = "google" | "apple-calendar";
type Adapter = Pick<typeof providers, "status" | "calendars" | "items" | "get">;
export interface PlannerAiToolsOptions {
  adapter?: Adapter;
  requestStore?: PluginContext["fs"];
  vaultRoot?: () => string | null;
  now?: () => Date;
  openSource?: (item: TaskItem) => Promise<unknown>;
}
type Reference = {
  ref: string;
  revision: string;
  root: string;
  signature: string;
} & (
  | { kind: "task"; snapshot: PlannerTask; binding?: TimeBlockLink }
  | { kind: "item"; snapshot: ExternalItem; binding?: TimeBlockLink }
  | { kind: "calendar"; snapshot: ExternalCalendar }
);
interface CallContext {
  root: string;
  writeStarted: boolean;
  operationsBefore: Set<string>;
  check: () => void;
}

function itemValue(item: ExternalItem) {
  return {
    kind: item.kind,
    title: item.title,
    start: item.start,
    end: item.end,
    allDay: item.allDay,
    completed: item.completed,
    dueDate: item.dueDate,
    description: item.description,
    location: item.location,
    timeZone: item.timeZone,
    writable: item.writable,
    writeRef: item.writeRef,
  };
}
function requestId(args: Record<string, unknown>) {
  const id = text(args.request_id, "request_id", 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,119}$/.test(id))
    invalid("request_id must contain 8–120 letters, digits, dots, hyphens, colons or underscores.");
  return id;
}
function timedRange(args: Record<string, unknown>, maxDays = 31) {
  const start = instant(args.start, "start"),
    end = instant(args.end, "end");
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > maxDays * 86400000)
    invalid(`end must be after start and within ${maxDays} days.`);
  return { start, end };
}
const eventFields = [
  "title",
  "start",
  "end",
  "all_day",
  "time_zone",
  "location",
  "description",
] as const;
const eventProperties = {
  title: stringSchema,
  start: stringSchema,
  end: stringSchema,
  all_day: { type: "boolean" },
  time_zone: stringSchema,
  location: { type: ["string", "null"] },
  description: { type: ["string", "null"] },
};
function eventDraft(value: unknown, previous?: ExternalItem): ItemDraft {
  const args = object(value, eventFields, "event");
  const allDay =
    args.all_day === undefined && previous ? previous.allDay : bool(args.all_day, "all_day");
  const start = (allDay ? date : instant)(args.start ?? previous?.start, "start");
  const end = (allDay ? date : instant)(args.end ?? previous?.end, "end");
  if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 366 * 86400000)
    invalid("The event must end after it starts, within 366 days.");
  return {
    title: args.title === undefined && previous ? previous.title : title(args.title),
    start,
    end,
    allDay,
    timeZone: args.time_zone === undefined ? previous?.timeZone : timeZone(args.time_zone),
    location:
      args.location === undefined
        ? previous?.location
        : args.location === null
          ? undefined
          : text(args.location, "location", 2000, true),
    description:
      args.description === undefined
        ? previous?.description
        : args.description === null
          ? undefined
          : text(args.description, "description", 20000, true),
  };
}

export function registerPlannerAiTools(
  registry: AiProxyToolRegistry,
  service: PlannerService,
  options: PlannerAiToolsOptions = {},
): Disposer {
  const adapter = options.adapter ?? providers;
  const rootPath = options.vaultRoot ?? (() => vaultState.rootPath);
  const now = options.now ?? (() => new Date());
  const receipts = new PlannerRequestReceipts(options.requestStore);
  const references = new Map<string, Reference>();
  const identities = new Map<string, string>();
  const disposers: Disposer[] = [];
  let disposed = false;
  let writeQueue: Promise<unknown> = Promise.resolve();
  const clock = () => ({
    currentDate: localDate(now()),
    nowISO: now().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const context = (): CallContext => {
    const root = rootPath();
    if (disposed) throw new PlannerAiError("DISABLED", "Planner tools are no longer active.");
    if (!root) throw new PlannerAiError("NO_VAULT", "Open a vault before using Planner tools.");
    return {
      root,
      writeStarted: false,
      operationsBefore: new Set(service.state.operations.map((operation) => operation.id)),
      check: () => {
        if (disposed || rootPath() !== root)
          throw new PlannerAiError(
            "DISABLED",
            "Planner was disabled or the vault changed. No further action was taken.",
          );
      },
    };
  };
  const pending = () =>
    service.state.operations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      provider: operation.provider,
      status: operation.status,
      stage: operation.stage,
    }));
  const fail = (error: unknown, call?: CallContext): never => {
    const known = error instanceof PlannerAiError;
    const message = error instanceof Error ? error.message : String(error);
    const code = known
      ? error.code
      : /CONFLICT|checksum|stale|changed/i.test(message)
        ? "CONFLICT"
        : /READ_ONLY/i.test(message)
          ? "READ_ONLY"
          : /AUTH|permission|connect/i.test(message)
            ? "SOURCE_UNAVAILABLE"
            : "OPERATION_FAILED";
    throw new Error(
      JSON.stringify({
        ok: false,
        error: {
          code,
          message: known
            ? error.message
            : "Planner could not complete this operation. Review the source or pending operation before retrying.",
          ...(known ? error.details : {}),
          mayHaveApplied: !!call?.writeStarted,
          pendingOperations: pending(),
        },
      }),
    );
  };
  const strictScan = async (call: CallContext) => {
    try {
      await service.scan({ sync: false, throwOnError: true });
    } catch {
      throw new PlannerAiError(
        "DATA_UNAVAILABLE",
        "The vault could not be read completely. No complete task result or write was produced.",
      );
    }
    call.check();
  };
  const bindingFor = (item: TaskItem) =>
    service.timeBlockForTask(item) ??
    (!("path" in item) && item.writeRef
      ? service.state.timeBlockLinks.find((link) => sameEventRef(link.eventRef, item.writeRef!))
      : undefined);
  const itemSignature = (item: TaskItem) =>
    canonical({
      value:
        "path" in item
          ? {
              title: item.title,
              checked: item.checked,
              metadata: item.metadata,
              ...(!item.metadata?.id
                ? { path: item.path, checksum: item.sourceChecksum, start: item.sourceStart }
                : {}),
            }
          : itemValue(item),
      binding: bindingFor(item),
    });
  const put = (
    identity: string,
    input: Omit<Reference, "ref" | "revision" | "root" | "signature">,
    signature: string,
    call: CallContext,
  ): Reference => {
    call.check();
    const key = canonical([call.root, identity]);
    const existing = identities.get(key);
    const previous = existing && references.get(existing);
    const ref = previous ? previous.ref : `planner_${crypto.randomUUID()}`;
    const record = {
      ...copy(input),
      ref,
      revision:
        previous && previous.signature === signature ? previous.revision : crypto.randomUUID(),
      root: call.root,
      signature,
    } as Reference;
    identities.set(key, ref);
    references.set(ref, record);
    return record;
  };
  const calendarData = (calendar: ExternalCalendar, call: CallContext) => {
    const record = put(
      `calendar:${calendarKey(calendar.provider, calendar.id)}`,
      { kind: "calendar", snapshot: calendar },
      canonical({
        title: calendar.title,
        writable: calendar.writable,
        timeZone: calendar.timeZone,
      }),
      call,
    );
    return {
      ref: record.ref,
      revision: record.revision,
      provider: calendar.provider,
      title: calendar.title,
      writable: calendar.writable === true,
      timeZone: calendar.timeZone,
      selected: service.state.preferences.selectedCalendars[calendar.provider].includes(
        calendar.id,
      ),
      preferred: service
        .visibleCalendars(calendar.provider)
        .some((entry) => entry.id === calendar.id),
      default:
        service.state.preferences.defaultCalendar?.provider === calendar.provider &&
        service.state.preferences.defaultCalendar.calendarId === calendar.id,
    };
  };
  const itemData = (item: TaskItem, call: CallContext): Record<string, unknown> => {
    const note = "path" in item;
    const record = put(
      note
        ? `task:${item.metadata?.id ?? `${item.path}:${item.id}`}`
        : `item:${item.writeRef ? eventRefKey(item.writeRef) : externalKey(item)}`,
      { kind: note ? "task" : "item", snapshot: item, binding: bindingFor(item) } as Omit<
        Reference,
        "ref" | "revision" | "root" | "signature"
      >,
      itemSignature(item),
      call,
    );
    const duplicate =
      note &&
      !!item.metadata?.id &&
      service.state.tasks.filter((task) => task.metadata?.id === item.metadata?.id).length > 1;
    const linked = bindingFor(item);
    const destination =
      note || item.kind === "reminder" ? taskPlanningDestination(service, item) : null;
    const calendar =
      destination &&
      service.state.sources[destination.provider].calendars.find(
        (value) => value.id === destination.calendarId,
      );
    return {
      ref: record.ref,
      revision: record.revision,
      kind: note ? "note-task" : item.kind,
      title: item.title,
      provider: note ? "kuku" : item.provider,
      ...(note
        ? {
            path: item.path,
            completed: item.checked,
            dueDate: item.metadata?.dueDate,
            plannedDate: item.metadata?.plannedDate,
            start: item.metadata?.scheduledStart,
            end: item.metadata?.scheduledEnd,
            timeZone: item.metadata?.timeZone,
            ambiguous: duplicate,
            writable: !duplicate,
          }
        : {
            completed: item.completed,
            dueDate: item.dueDate,
            start: item.start,
            end: item.end,
            allDay: item.allDay,
            location: item.location,
            description: item.description,
            timeZone: item.timeZone,
            writable: item.writable === true,
            linkedNotes: service.linkedNotes(item),
          }),
      block: linked
        ? {
            start: linked.start,
            end: linked.end,
            status: linked.status,
            provider: linked.eventRef.provider,
          }
        : null,
      schedulingCalendar: calendar ? calendarData(calendar, call) : null,
    };
  };
  const reference = (value: unknown, call: CallContext, kind?: Reference["kind"]) => {
    call.check();
    const record = references.get(text(value, "ref", 100));
    if (!record || record.root !== call.root || (kind && record.kind !== kind))
      throw new PlannerAiError(
        "INVALID_REFERENCE",
        "Use a current reference returned by a Planner read tool in this vault.",
      );
    return record;
  };
  const requireSource = async (provider: Provider, call: CallContext, writable = false) => {
    if (!service.state.preferences.enabledSources[provider])
      throw new PlannerAiError(
        "SOURCE_UNAVAILABLE",
        "This source is disabled. Connect it in Planner settings before continuing.",
      );
    const status = await adapter.status(provider);
    call.check();
    if (!status.connected)
      throw new PlannerAiError(
        "SOURCE_UNAVAILABLE",
        "This source is disconnected or its permission was revoked.",
        { provider },
      );
    if (writable && status.writable !== true)
      throw new PlannerAiError("READ_ONLY", "This source does not have editing permission.", {
        provider,
      });
    return status;
  };
  const calendarCurrent = async (
    record: Reference,
    call: CallContext,
    writable = false,
    revision?: unknown,
  ) => {
    if (record.kind !== "calendar") invalid("calendar_ref must reference a calendar.");
    await requireSource(record.snapshot.provider, call, writable);
    const calendars = await adapter.calendars(record.snapshot.provider);
    call.check();
    const matches = calendars.filter(
      (calendar) =>
        calendar.provider === record.snapshot.provider && calendar.id === record.snapshot.id,
    );
    if (matches.length !== 1)
      throw new PlannerAiError(
        "UNAVAILABLE",
        "The referenced calendar is unavailable or ambiguous.",
      );
    const calendar = matches[0];
    if (
      writable &&
      (calendar.writable !== true ||
        !service.visibleCalendars(calendar.provider).some((entry) => entry.id === calendar.id))
    )
      throw new PlannerAiError(
        "READ_ONLY",
        "This calendar is read-only or uses a different preferred connection.",
      );
    if (revision !== undefined && text(revision, "calendar_revision", 100) !== record.revision)
      throw new PlannerAiError("STALE_REFERENCE", "The calendar reference revision is stale.");
    return calendar;
  };
  const guardPending = (item: TaskItem) => {
    const link = bindingFor(item);
    const found = service.state.operations.some(
      (operation) =>
        (operation.linkId && operation.linkId === link?.id) ||
        ("path" in item
          ? operation.task?.kind === "note" && operation.task.taskId === item.metadata?.id
          : !!item.writeRef &&
            ((!!operation.eventRef && sameEventRef(operation.eventRef, item.writeRef)) ||
              (operation.task?.kind === "reminder" &&
                sameEventRef(operation.task.eventRef, item.writeRef)))),
    );
    if (found || (link && link.status !== "synced"))
      throw new PlannerAiError(
        "PENDING_OPERATION",
        "Resolve this item's pending operation or binding conflict in Planner before changing it.",
      );
  };
  const linkedFresh = async (item: TaskItem, call: CallContext) => {
    const link = bindingFor(item);
    if (!link) return;
    await requireSource(link.eventRef.provider, call, true);
    const remote = await adapter.get(link.eventRef);
    call.check();
    if (
      !remote?.writeRef ||
      !sameEventRef(remote.writeRef, link.eventRef) ||
      remote.allDay ||
      remote.title !== link.title ||
      Date.parse(remote.start ?? "") !== Date.parse(link.start) ||
      Date.parse(remote.end ?? "") !== Date.parse(link.end) ||
      (link.eventRef.version && remote.writeRef.version !== link.eventRef.version)
    )
      throw new PlannerAiError(
        "CONFLICT",
        "The linked calendar block changed. Refresh and review it in Planner before editing the source task.",
      );
  };
  const currentItem = async (
    value: unknown,
    call: CallContext,
    revision?: unknown,
    changesBlock = true,
  ): Promise<TaskItem> => {
    const record = reference(value, call);
    if (record.kind === "calendar") invalid("ref must reference a task or event, not a calendar.");
    if (revision !== undefined && text(revision, "revision", 100) !== record.revision)
      throw new PlannerAiError(
        "STALE_REFERENCE",
        "This reference revision is stale. Read the item again.",
      );
    let item: TaskItem;
    if (record.kind === "task") {
      await strictScan(call);
      const source = record.snapshot;
      const matches = service.state.tasks.filter((task) =>
        source.metadata?.id
          ? task.metadata?.id === source.metadata.id
          : task.path === source.path &&
            task.id === source.id &&
            task.sourceChecksum === source.sourceChecksum,
      );
      if (matches.length !== 1)
        throw new PlannerAiError(
          matches.length ? "AMBIGUOUS_REFERENCE" : "UNAVAILABLE",
          "The original task is missing, changed, or has a duplicate ID. Search again.",
        );
      item = matches[0];
    } else {
      await requireSource(record.snapshot.provider, call, revision !== undefined);
      if (revision !== undefined && record.snapshot.writable !== true)
        throw new PlannerAiError(
          "READ_ONLY",
          "This item is read-only. Use its original application.",
        );
      if (!record.snapshot.writeRef)
        throw new PlannerAiError(
          "UNAVAILABLE",
          "The provider did not supply a source reference for this item.",
        );
      const found = await adapter.get(record.snapshot.writeRef);
      call.check();
      if (
        !found?.writeRef ||
        !sameEventRef(found.writeRef, record.snapshot.writeRef) ||
        found.kind !== record.snapshot.kind
      )
        throw new PlannerAiError(
          "UNAVAILABLE",
          "The original item or occurrence is no longer available.",
        );
      item = found;
      if (revision !== undefined && item.writable !== true)
        throw new PlannerAiError("READ_ONLY", "The item is no longer writable.");
    }
    if (revision !== undefined) {
      if (itemSignature(item) !== record.signature)
        throw new PlannerAiError(
          "STALE_REFERENCE",
          "The source changed after it was read. Review the current item before applying changes.",
          { current: itemData(item, call) },
        );
      const link = bindingFor(item);
      const unchangedLocalBlock =
        "path" in item &&
        link &&
        item.title === link.lastSync.taskTitle &&
        Date.parse(item.metadata?.scheduledStart ?? "") ===
          Date.parse(link.lastSync.taskStart ?? "") &&
        Date.parse(item.metadata?.scheduledEnd ?? "") === Date.parse(link.lastSync.taskEnd ?? "");
      if (changesBlock || ("path" in item && link && !unchangedLocalBlock)) {
        guardPending(item);
        await linkedFresh(item, call);
      }
    }
    return item;
  };
  const taskCurrent = async (
    args: Record<string, unknown>,
    call: CallContext,
    write = true,
    changesBlock = true,
  ) => {
    const item = await currentItem(args.ref, call, write ? args.revision : undefined, changesBlock);
    if (!("path" in item) && item.kind !== "reminder")
      invalid("Use an original task reference, not its calendar event reference.");
    return item;
  };
  const write = async <T>(call: CallContext, action: () => Promise<T>): Promise<T> => {
    call.check();
    call.writeStarted = true;
    const result = await action();
    call.check();
    if (service.state.operations.some((operation) => !call.operationsBefore.has(operation.id)))
      throw new PlannerAiError(
        "PENDING_OPERATION",
        "The change has an unresolved provider operation. Review it in Planner; do not repeat creation with a new request_id.",
      );
    return result;
  };
  const resolveCreated = async (locator: PlannerCreationLocator, call: CallContext) => {
    if (locator.kind === "note")
      return { notePath: locator.path, exists: service.state.notes.includes(locator.path) };
    if (locator.kind === "task") {
      await strictScan(call);
      const tasks = service.state.tasks.filter((task) => task.metadata?.id === locator.taskId);
      if (tasks.length !== 1)
        throw new PlannerAiError(
          "CREATED_ITEM_UNAVAILABLE",
          "This request already created a task, but its current source is unavailable or ambiguous. No replacement was created.",
        );
      return { task: itemData(tasks[0], call) };
    }
    if (locator.kind !== "item")
      throw new PlannerAiError(
        "UNKNOWN_OUTCOME",
        "The saved creation locator is invalid. No new creation was attempted.",
      );
    await requireSource(locator.eventRef.provider, call);
    const item = await adapter.get(locator.eventRef);
    call.check();
    if (!item?.writeRef || !sameEventRef(item.writeRef, locator.eventRef))
      throw new PlannerAiError(
        "CREATED_ITEM_UNAVAILABLE",
        "This request already created an item that is no longer available. No replacement was created.",
      );
    return { item: itemData(item, call) };
  };
  const createOnce = async (
    args: Record<string, unknown>,
    payload: unknown,
    call: CallContext,
    action: () => Promise<PlannerCreationLocator>,
  ) => {
    const receipt = await receipts.run(call.root, requestId(args), payload, call.check, () =>
      write(call, action),
    );
    return {
      ...(await resolveCreated(receipt.result, call)),
      requestId: args.request_id,
      replayed: receipt.replayed,
      durableReceipt: receipt.durable,
    };
  };
  const add = (
    name: ToolName,
    access: "readOnly" | "proposesMutation",
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    handler: (args: Record<string, unknown>, call: CallContext) => Promise<Record<string, unknown>>,
  ) => {
    disposers.push(
      registry.register({
        name,
        toolId: `planner.${name.slice("planner_".length)}`,
        category: "planner",
        access,
        description,
        parameters: schema(properties, required),
        handler: async (raw) => {
          let call: CallContext;
          try {
            call = context();
          } catch (error) {
            return fail(error);
          }
          const run = async () => {
            try {
              call.check();
              call.operationsBefore = new Set(
                service.state.operations.map((operation) => operation.id),
              );
              const args = object(raw, Object.keys(properties));
              for (const field of required)
                if (!Object.hasOwn(args, field)) invalid(`${field} is required.`);
              const result = await handler(args, call);
              call.check();
              return JSON.stringify({ ok: true, ...clock(), ...result });
            } catch (error) {
              return fail(error, call);
            }
          };
          if (access === "readOnly") return run();
          const promise = writeQueue.catch(() => {}).then(run);
          writeQueue = promise;
          return promise;
        },
      }),
    );
  };

  add(
    "planner_calendars_list",
    "readOnly",
    "List already enabled Planner calendars and reminder lists with opaque references, selected/default state and editing permission. Does not connect accounts or change settings.",
    {},
    [],
    async (_args, call) => {
      const calendars: Record<string, unknown>[] = [];
      const sources: Record<string, unknown>[] = [];
      for (const provider of PROVIDERS) {
        if (!service.state.preferences.enabledSources[provider]) {
          sources.push({ provider, enabled: false });
          continue;
        }
        try {
          const status = await requireSource(provider, call);
          const values = await adapter.calendars(provider);
          call.check();
          calendars.push(
            ...values
              .filter((calendar) => calendar.provider === provider)
              .map((calendar) => calendarData(calendar, call)),
          );
          sources.push({
            provider,
            enabled: true,
            connected: true,
            writable: status.writable === true,
          });
        } catch {
          call.check();
          sources.push({ provider, enabled: true, unavailable: true });
        }
      }
      return { calendars, sources, pendingOperations: pending() };
    },
  );
  const readEvents = async (
    targets: { provider: CalendarProvider; ids: string[] }[],
    range: { start: string; end: string },
    call: CallContext,
  ) => {
    const pages = await Promise.all(
      targets.map(async (target) => {
        await requireSource(target.provider, call);
        const calendars = await adapter.calendars(target.provider);
        call.check();
        if (
          target.ids.some(
            (id) =>
              !calendars.some(
                (calendar) => calendar.provider === target.provider && calendar.id === id,
              ),
          )
        )
          throw new PlannerAiError(
            "SOURCE_UNAVAILABLE",
            "A selected calendar is no longer available. Review the selection before treating this range as free.",
          );
        const result = await adapter.items(
          target.provider,
          target.ids,
          range.start,
          range.end,
          clock().timeZone,
        );
        call.check();
        return result.filter(
          (item) =>
            item.kind === "event" &&
            item.provider === target.provider &&
            target.ids.includes(item.calendarId),
        );
      }),
    );
    call.check();
    return pages.flat();
  };
  add(
    "planner_events_list",
    "readOnly",
    "Read events for an explicit ISO range of at most 31 days, independent of the visible Planner week. Query selected calendars by default, or supply calendar refs. A failed source fails the entire read; it never reports an incomplete range as empty.",
    {
      start: stringSchema,
      end: stringSchema,
      calendar_refs: { type: "array", items: refSchema, maxItems: 20 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    ["start", "end"],
    async (args, call) => {
      const range = timedRange(args);
      let targets = planningCalendars(service);
      if (args.calendar_refs !== undefined) {
        if (
          !Array.isArray(args.calendar_refs) ||
          !args.calendar_refs.length ||
          args.calendar_refs.length > 20
        )
          invalid("calendar_refs must contain 1–20 references.");
        const chosen = await Promise.all(
          args.calendar_refs.map(async (ref) =>
            calendarCurrent(reference(ref, call, "calendar"), call),
          ),
        );
        if (chosen.some((calendar) => calendar.provider === "apple-reminders"))
          invalid("Use tasks_search for reminder lists.");
        targets = (["google", "apple-calendar"] as const).flatMap((provider) => {
          const ids = [
            ...new Set(
              chosen
                .filter((calendar) => calendar.provider === provider)
                .map((calendar) => calendar.id),
            ),
          ];
          return ids.length ? [{ provider, ids }] : [];
        });
      }
      const limit = args.limit === undefined ? 100 : integer(args.limit, "limit", 1, 200);
      const items = (await readEvents(targets, range, call)).sort(
        (a, b) => (Date.parse(a.start ?? "") || 0) - (Date.parse(b.start ?? "") || 0),
      );
      return {
        events: items.slice(0, limit).map((item) => itemData(item, call)),
        total: items.length,
        truncated: items.length > limit,
        range,
      };
    },
  );
  add(
    "planner_tasks_search",
    "readOnly",
    "Search current vault checkboxes and selected Apple reminder lists, including tasks outside the displayed week. NFKC/case-insensitive AND matching searches title and note/list context. Returns opaque refs and revisions required for writes. incompleteSources means the returned local tasks are not a complete cross-source result.",
    {
      query: stringSchema,
      source: { type: "string", enum: ["all", "note", "apple"] },
      filter: { type: "string", enum: ["all", "today", "upcoming", "unplanned", "completed"] },
      sort: { type: "string", enum: ["due", "scheduled", "title"] },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    [],
    async (args, call) => {
      const query = args.query === undefined ? "" : text(args.query, "query", 1000, true);
      const source =
        args.source === undefined ? "all" : choice(args.source, ["all", "note", "apple"], "source");
      const filter =
        args.filter === undefined
          ? "all"
          : choice(args.filter, ["all", "today", "upcoming", "unplanned", "completed"], "filter");
      const sort: TaskSort =
        args.sort === undefined ? "due" : choice(args.sort, ["due", "scheduled", "title"], "sort");
      const limit = args.limit === undefined ? 100 : integer(args.limit, "limit", 1, 200);
      await strictScan(call);
      const items: TaskItem[] = source === "apple" ? [] : [...service.state.tasks];
      const incompleteSources: string[] = [];
      let reminderCalendars: ExternalCalendar[] = [];
      if (source === "apple" && !service.state.preferences.enabledSources["apple-reminders"])
        incompleteSources.push("apple-reminders");
      if (source !== "note" && service.state.preferences.enabledSources["apple-reminders"]) {
        try {
          await requireSource("apple-reminders", call);
          reminderCalendars = await adapter.calendars("apple-reminders");
          call.check();
          const selected = service.state.preferences.selectedCalendars["apple-reminders"];
          const ids = reminderCalendars
            .filter((calendar) => selected.includes(calendar.id))
            .map((calendar) => calendar.id);
          const reminders = ids.length
            ? await adapter.items(
                "apple-reminders",
                ids,
                dateFromKey(localDate(now())).toISOString(),
                dateFromKey(addDays(localDate(now()), 7)).toISOString(),
                clock().timeZone,
              )
            : [];
          call.check();
          items.push(
            ...reminders.filter(
              (item) =>
                item.kind === "reminder" &&
                item.provider === "apple-reminders" &&
                ids.includes(item.calendarId),
            ),
          );
        } catch {
          call.check();
          incompleteSources.push("apple-reminders");
        }
      }
      const entries = items
        .filter((item) => {
          if (filter === "all") return true;
          if ("path" in item) return matchesFilter(item, filter, localDate(now()));
          const block = service.timeBlockForTask(item);
          return matchesFilter(
            {
              id: item.id,
              path: "",
              title: item.title,
              checked: !!item.completed,
              sourceStart: 0,
              sourceEnd: 0,
              metadata: {
                id: item.id,
                dueDate: item.dueDate?.slice(0, 10),
                scheduledStart: block?.start,
              },
            },
            filter,
            localDate(now()),
          );
        })
        .map((item) => ({
          value: item,
          key: "path" in item ? `${item.path}:${item.id}` : externalKey(item),
          title: item.title,
          context:
            "path" in item
              ? item.path
              : (reminderCalendars.find((calendar) => calendar.id === item.calendarId)?.title ??
                "Apple Reminders"),
          dueDate: "path" in item ? item.metadata?.dueDate : item.dueDate,
          scheduledStart:
            "path" in item ? item.metadata?.scheduledStart : service.timeBlockForTask(item)?.start,
        }));
      const sorted = queryTaskEntries(entries, query, sort, currentLocale());
      return {
        tasks: sorted.slice(0, limit).map((entry) => itemData(entry.value, call)),
        totalKnown: sorted.length,
        truncated: sorted.length > limit,
        incompleteSources,
        pendingOperations: pending(),
      };
    },
  );
  for (const name of ["planner_task_read", "planner_event_read"] as const)
    add(
      name,
      "readOnly",
      "Read the current original item behind a Planner reference and return a fresh revision. References do not match by title and are invalid after changing vaults or restarting tools.",
      { ref: refSchema },
      ["ref"],
      async (args, call) => {
        const item =
          name === "planner_task_read"
            ? await taskCurrent(args, call, false)
            : await currentItem(args.ref, call);
        if (name === "planner_event_read" && ("path" in item || item.kind !== "event"))
          invalid("Use task_read for note tasks and reminders.");
        return { item: itemData(item, call) };
      },
    );
  add(
    "planner_task_create",
    "proposesMutation",
    "Create one Markdown task in Tasks/Inbox.md, or one Apple reminder in a referenced writable list. request_id prevents duplicate creation across retries; uncertain stored requests require Planner recovery instead of a new ID. This does not schedule a calendar block.",
    {
      title: stringSchema,
      due_date: { type: "string" },
      planned_date: { type: "string" },
      calendar_ref: refSchema,
      request_id: requestSchema,
    },
    ["title", "request_id"],
    async (args, call) => {
      const name = title(args.title);
      const metadata: Partial<TaskMetadata> = {};
      if (args.due_date !== undefined) metadata.dueDate = date(args.due_date, "due_date");
      if (args.planned_date !== undefined)
        metadata.plannedDate = date(args.planned_date, "planned_date");
      const calendar =
        args.calendar_ref === undefined
          ? undefined
          : await calendarCurrent(reference(args.calendar_ref, call, "calendar"), call, true);
      if (calendar && calendar.provider !== "apple-reminders")
        invalid("calendar_ref must be an Apple reminder list for task creation.");
      if (calendar && metadata.plannedDate)
        invalid(
          "Apple reminders do not have a separate planned day; use due_date or schedule the task.",
        );
      return createOnce(
        args,
        {
          tool: "task_create",
          title: name,
          metadata,
          calendar: calendar && calendarKey(calendar.provider, calendar.id),
        },
        call,
        async () => {
          if (calendar) {
            const created = await service.createItem("apple-reminders", calendar.id, {
              title: name,
              allDay: true,
              dueDate: metadata.dueDate,
            });
            if (!created.writeRef)
              throw new PlannerAiError(
                "UNKNOWN_OUTCOME",
                "The reminder may have been created but its source reference was missing. Do not create it again.",
              );
            return { kind: "item", eventRef: created.writeRef };
          }
          const created = await service.addTask(name, { metadata });
          return created.kind === "note"
            ? { kind: "task", taskId: created.taskId, path: created.path }
            : { kind: "item", eventRef: created.eventRef };
        },
      );
    },
  );
  const taskPatchFields = ["title", "due_date", "planned_date"];
  add(
    "planner_task_update",
    "proposesMutation",
    "Update one task title, due date or note planned day using its exact revision. Null clears a date. Deadlines do not move time blocks. Scheduling and completion have separate tools.",
    {
      ref: refSchema,
      revision: revisionSchema,
      patch: schema({
        title: stringSchema,
        due_date: { type: ["string", "null"] },
        planned_date: { type: ["string", "null"] },
      }),
    },
    ["ref", "revision", "patch"],
    async (args, call) => {
      const patch = object(args.patch, taskPatchFields, "patch");
      if (!Object.keys(patch).length) invalid("patch must contain a change.");
      const name = patch.title === undefined ? undefined : title(patch.title);
      const due =
        patch.due_date === undefined
          ? undefined
          : patch.due_date === null
            ? null
            : date(patch.due_date, "due_date");
      const planned =
        patch.planned_date === undefined
          ? undefined
          : patch.planned_date === null
            ? null
            : date(patch.planned_date, "planned_date");
      const item = await taskCurrent(args, call, true, name !== undefined);
      if ("path" in item) {
        const changes: TaskPatch = {};
        if (name !== undefined) changes.title = name;
        if (due !== undefined || planned !== undefined)
          changes.metadata = {
            ...(due !== undefined ? { dueDate: due ?? undefined } : {}),
            ...(planned !== undefined ? { plannedDate: planned ?? undefined } : {}),
          };
        return {
          task: itemData(await write(call, () => service.updateTask(item, changes, item)), call),
        };
      }
      if (planned !== undefined) invalid("Apple reminders do not have a separate planned day.");
      const updated = await write(call, () =>
        service.updateItem(item, {
          ...(name !== undefined ? { title: name } : {}),
          ...(due !== undefined ? { dueDate: due } : {}),
        }),
      );
      return { task: itemData(updated, call) };
    },
  );
  add(
    "planner_task_complete",
    "proposesMutation",
    "Set one task's completion state in its original note or Apple reminder. Existing calendar blocks remain as history. A recurring reminder may advance to its provider's next occurrence.",
    { ref: refSchema, revision: revisionSchema, completed: { type: "boolean" } },
    ["ref", "revision", "completed"],
    async (args, call) => {
      const completed = bool(args.completed, "completed");
      const item = await taskCurrent(args, call, true, false);
      const updated =
        "path" in item
          ? await write(call, () => service.updateTask(item, { checked: completed }, item))
          : await write(call, () => service.updateItem(item, { completed }));
      return { task: itemData(updated, call), calendarBlockPreserved: true };
    },
  );
  add(
    "planner_task_schedule",
    "proposesMutation",
    "Set one task's single time block with explicit zoned timestamps, in 15-minute duration increments. calendar_ref must match its existing linked calendar or the configured default; pass null only for local-only Kuku scheduling with no default. Never changes default calendars or bulk publishes existing blocks.",
    {
      ref: refSchema,
      revision: revisionSchema,
      start: stringSchema,
      end: stringSchema,
      calendar_ref: { type: ["string", "null"] },
      time_zone: stringSchema,
    },
    ["ref", "revision", "start", "end", "calendar_ref"],
    async (args, call) => {
      const range = timedRange(args, 7);
      const minutes = (Date.parse(range.end) - Date.parse(range.start)) / 60000;
      if (minutes < 15 || minutes % 15)
        invalid("Time blocks must last a positive multiple of 15 minutes.");
      const zone = args.time_zone === undefined ? clock().timeZone : timeZone(args.time_zone);
      const item = await taskCurrent(args, call);
      const expected = taskPlanningDestination(service, item);
      const target =
        args.calendar_ref === null
          ? null
          : await calendarCurrent(reference(args.calendar_ref, call, "calendar"), call, true);
      if (target?.provider === "apple-reminders")
        invalid("A reminder list cannot store a calendar block.");
      if (
        canonical(expected) !==
        canonical(target ? { provider: target.provider, calendarId: target.id } : null)
      )
        throw new PlannerAiError(
          "DESTINATION_CHANGED",
          "Use the task's linked calendar or configured default shown by current Planner reads.",
        );
      if (!("path" in item) && !target)
        invalid("A reminder needs a default calendar to receive a time block.");
      const metadata = {
        scheduledStart: range.start,
        scheduledEnd: range.end,
        plannedDate: localDate(new Date(range.start)),
        timeZone: zone,
      };
      if ("path" in item)
        return {
          task: itemData(
            await write(call, () => service.updateTask(item, { metadata }, item, expected)),
            call,
          ),
        };
      await write(call, () => service.scheduleReminder(item, metadata, expected));
      return { task: itemData(item, call) };
    },
  );
  add(
    "planner_task_unassign",
    "proposesMutation",
    "Remove one task's scheduled block and linked external calendar event, preserving the original task and its deadline. Requires the exact current revision.",
    { ref: refSchema, revision: revisionSchema },
    ["ref", "revision"],
    async (args, call) => {
      const item = await taskCurrent(args, call);
      if ("path" in item)
        return {
          task: itemData(
            await write(call, () =>
              service.updateTask(
                item,
                {
                  metadata: {
                    scheduledStart: undefined,
                    scheduledEnd: undefined,
                    timeZone: undefined,
                  },
                },
                item,
              ),
            ),
            call,
          ),
        };
      await write(call, () => service.removeReminderBlock(item));
      return { task: itemData(item, call) };
    },
  );
  add(
    "planner_task_delete",
    "proposesMutation",
    "Delete exactly one original task. delete_block explicitly chooses whether its linked external calendar block is deleted too. Other note text/child tasks are preserved. This is not a bulk operation and cannot be undone by these tools.",
    { ref: refSchema, revision: revisionSchema, delete_block: { type: "boolean" } },
    ["ref", "revision", "delete_block"],
    async (args, call) => {
      const deleteBlock = bool(args.delete_block, "delete_block");
      const item = await taskCurrent(args, call);
      if ("path" in item) await write(call, () => service.deleteTask(item, deleteBlock, item));
      else {
        if (deleteBlock && service.timeBlockForTask(item))
          await write(call, () => service.removeReminderBlock(item));
        await write(call, () => service.deleteItem(item));
      }
      return { deleted: true, blockTreatment: deleteBlock ? "delete" : "keep" };
    },
  );
  add(
    "planner_event_create",
    "proposesMutation",
    "Create one real event in a referenced writable Google or Apple calendar. Supports timed and all-day events; all-day end dates are exclusive. No recurrence rules, attendees or invitations. Reuse request_id after response loss; never recreate an uncertain request under a new ID.",
    {
      calendar_ref: refSchema,
      event: schema(eventProperties, ["title", "start", "end", "all_day"]),
      request_id: requestSchema,
    },
    ["calendar_ref", "event", "request_id"],
    async (args, call) => {
      const draft = eventDraft(args.event);
      const calendar = await calendarCurrent(
        reference(args.calendar_ref, call, "calendar"),
        call,
        true,
      );
      if (calendar.provider === "apple-reminders") invalid("Use task_create for Apple reminders.");
      return createOnce(
        args,
        { tool: "event_create", calendar: calendarKey(calendar.provider, calendar.id), draft },
        call,
        async () => {
          const item = await service.createItem(calendar.provider, calendar.id, draft);
          if (!item.writeRef)
            throw new PlannerAiError(
              "UNKNOWN_OUTCOME",
              "The event may have been created, but its provider reference was missing. Do not create it again.",
            );
          return { kind: "item", eventRef: item.writeRef };
        },
      );
    },
  );
  add(
    "planner_event_update",
    "proposesMutation",
    "Update one exact event occurrence using its current revision and provider conditional version. Supports title/time/all-day/location/description only; no attendee or recurrence-rule management. Linked tasks are synchronized by Planner's normal document path.",
    { ref: refSchema, revision: revisionSchema, patch: schema(eventProperties) },
    ["ref", "revision", "patch"],
    async (args, call) => {
      const patch = object(args.patch, eventFields, "patch");
      if (!Object.keys(patch).length) invalid("patch must contain a change.");
      const item = await currentItem(args.ref, call, args.revision);
      if ("path" in item || item.kind !== "event")
        invalid("Use task_update for task and reminder references.");
      const draft = eventDraft(patch, item);
      const updated: ItemPatch = {
        ...draft,
        ...(Object.hasOwn(patch, "location") && patch.location === null ? { location: null } : {}),
        ...(Object.hasOwn(patch, "description") && patch.description === null
          ? { description: null }
          : {}),
      };
      return { event: itemData(await write(call, () => service.updateItem(item, updated)), call) };
    },
  );
  add(
    "planner_event_delete",
    "proposesMutation",
    "Delete one exact event occurrence using its revision. For a linked task block this unassigns time and preserves the original task. It does not delete a recurring series.",
    { ref: refSchema, revision: revisionSchema },
    ["ref", "revision"],
    async (args, call) => {
      const item = await currentItem(args.ref, call, args.revision);
      if ("path" in item || item.kind !== "event")
        invalid("Use task_delete for original task/reminder references.");
      await write(call, () => service.deleteItem(item));
      return { deleted: true, linkedTaskPreserved: true };
    },
  );
  add(
    "planner_availability",
    "readOnly",
    "Suggest free time on one local day using fresh selected-calendar queries plus local task blocks, optionally including a destination calendar. Working hours are 09:00–18:00. Exclude one original task/event ref when rescheduling. Overlap is occupied minutes counted once; all-day context does not reserve the whole day. This is a read, not a reservation.",
    {
      day: stringSchema,
      duration_minutes: { type: "integer", minimum: 15, maximum: 540 },
      preferred_start: stringSchema,
      exclude_ref: refSchema,
      calendar_ref: refSchema,
    },
    ["day", "duration_minutes"],
    async (args, call) => {
      const day = date(args.day, "day"),
        duration = integer(args.duration_minutes, "duration_minutes", 15, 540);
      if (duration % 15) invalid("duration_minutes must be a multiple of 15.");
      const preferred =
        args.preferred_start === undefined
          ? undefined
          : instant(args.preferred_start, "preferred_start");
      if (preferred && localDate(new Date(preferred)) !== day)
        invalid("preferred_start must fall on day in the system time zone.");
      await strictScan(call);
      const exclude =
        args.exclude_ref === undefined ? undefined : await currentItem(args.exclude_ref, call);
      const target =
        args.calendar_ref === undefined
          ? undefined
          : await calendarCurrent(reference(args.calendar_ref, call, "calendar"), call);
      if (target?.provider === "apple-reminders")
        invalid("A reminder list is not a calendar destination.");
      const choice: CalendarChoice | undefined = target
        ? { provider: target.provider as CalendarProvider, calendarId: target.id }
        : ((exclude && ("path" in exclude || exclude.kind === "reminder")
            ? taskPlanningDestination(service, exclude)
            : service.state.preferences.defaultCalendar) ?? undefined);
      if (
        preferred &&
        Date.parse(preferred) + duration * 60000 > dateFromKey(addDays(day, 1)).getTime()
      )
        invalid("The preferred time range must end within this local day.");
      if (choice) await requireSource(choice.provider, call);
      const events = await readEvents(
        planningCalendars(service, choice),
        { start: dateFromKey(day).toISOString(), end: dateFromKey(addDays(day, 1)).toISOString() },
        call,
      );
      const intervals = planningIntervals(service, events),
        excludedKeys = planningExcludedKeys(service, exclude);
      const suggestions = suggestFreeSlots({
        day,
        durationMinutes: duration,
        intervals,
        excludedKeys,
        preferredStart: preferred,
        now: now(),
      });
      const overlap = preferred
        ? analyzeOverlap(
            {
              start: preferred,
              end: new Date(Date.parse(preferred) + duration * 60000).toISOString(),
            },
            intervals,
            excludedKeys,
          )
        : null;
      return {
        day,
        durationMinutes: duration,
        suggestions,
        overlap,
        checkedAt: now().toISOString(),
        workingHours: "09:00–18:00",
        basis: "selected calendars, optional destination, and local task blocks",
      };
    },
  );
  add(
    "planner_open_source",
    "readOnly",
    "Open the exact source checkbox or original calendar/reminder application for a current Planner reference. Does not modify note or calendar content.",
    { ref: refSchema },
    ["ref"],
    async (args, call) => {
      const item = await currentItem(args.ref, call);
      if (options.openSource) await options.openSource(item);
      else if ("path" in item) await focusTask(item);
      else if (
        item.provider === "google" &&
        item.url &&
        /^https:\/\/(?:(?:www|calendar)\.)?google\.com\//.test(item.url)
      )
        await openUrl(item.url);
      else if (item.provider.startsWith("apple"))
        await invoke("planner_apple_open_app", {
          kind: item.provider === "apple-calendar" ? "calendar" : "reminders",
        });
      else
        throw new PlannerAiError(
          "UNAVAILABLE",
          "The provider did not supply an original-app link.",
        );
      call.check();
      return { opened: true };
    },
  );
  add(
    "planner_link_note",
    "proposesMutation",
    "Link one external event/reminder occurrence to an existing vault note, or explicitly create its note under Calendar/. Viewing an event never creates a note. mode=create requires request_id for response-loss recovery; mode=attach requires a known note path.",
    {
      ref: refSchema,
      revision: revisionSchema,
      mode: { type: "string", enum: ["attach", "create"] },
      path: stringSchema,
      request_id: requestSchema,
    },
    ["ref", "revision", "mode"],
    async (args, call) => {
      const mode = choice(args.mode, ["attach", "create"], "mode");
      const item = await currentItem(args.ref, call);
      const record = reference(args.ref, call);
      if (
        text(args.revision, "revision", 100) !== record.revision ||
        itemSignature(item) !== record.signature
      )
        throw new PlannerAiError(
          "STALE_REFERENCE",
          "Read the current event before linking a note.",
          { current: itemData(item, call) },
        );
      if ("path" in item) invalid("Use an external event or reminder reference to link a note.");
      await strictScan(call);
      if (mode === "attach") {
        if (args.request_id !== undefined) invalid("request_id is only used for mode=create.");
        const path = text(args.path, "path", 2000);
        if (!service.state.notes.includes(path))
          invalid("path must be an existing note returned from this vault.");
        await write(call, () => service.attachNote(item, path));
        return { item: itemData(item, call), notePath: path };
      }
      if (args.path !== undefined)
        invalid("A new calendar note's path is chosen by Planner; omit path.");
      return createOnce(
        args,
        {
          tool: "note_create",
          event: item.writeRef ? eventRefKey(item.writeRef) : externalKey(item),
        },
        call,
        async () => ({ kind: "note", path: await service.createNote(item) }),
      );
    },
  );

  return () => {
    disposed = true;
    for (const dispose of disposers.splice(0)) dispose();
    references.clear();
    identities.clear();
  };
}
