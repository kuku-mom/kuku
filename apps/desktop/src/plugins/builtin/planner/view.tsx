import { openUrl } from "@tauri-apps/plugin-opener";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { currentLocale } from "~/i18n";
import type { PlannerTask, TaskMetadata } from "~/lib/planner_tasks";
import { focusTask } from "~/plugins/document_mutations";
import { filesState, getActiveTab, openTab, updateTabState } from "~/stores/files";
import { vaultState } from "~/stores/vault";

import { BINDINGS_PATH } from "./bindings";
import {
  addDays,
  blockFor,
  dateFromKey,
  dateTimeInput,
  localDate,
  localDateTimeToISO,
  matchesFilter,
  weekDays,
} from "./dates";
import { pt, providerName } from "./messages";
import { Modal, type PopoverAnchor } from "./dialog";
import { PlannerSelect } from "./controls";
import { DurationPresets } from "./duration_presets";
import { PlannerGlyph } from "./icons";
import { plannedMinutes } from "./planning";
import { TaskSearch } from "./task_search";
import { queryTaskEntries, type TaskQueryEntry, type TaskSort } from "./task_query";
import { SlotSuggestions } from "./slot_suggestions";
import { taskPlanningDestination } from "./availability_context";
import { DateNavigator } from "./date_navigator";
import { PlannerContextPanel } from "./panel";
import { setPlannerSelection } from "./selection";
import { UndoNotice } from "./undo_notice";
import { OperationReview, LinkConflictReview } from "./operation_review";
import { createCalendarGestures, type CalendarRange } from "./calendar_gestures";
import {
  PlannerWeek,
  commitCalendarBlock,
  taskBlock,
  reminderBlock,
  taskKey,
  reminderKey,
} from "./calendar_view";
import {
  NewItemEditor,
  ExternalItemForm,
  CalendarSelect,
  TaskSourceSelect,
  taskSourceOptions,
} from "./item_editor";
import { getPlannerService, type PlannerService } from "./service";
import {
  PROVIDERS,
  calendarKey,
  type ExternalItem,
  type TaskFilter,
  type PendingOperation,
  type TimeBlockLink,
} from "./types";

export function PlannerIcon(props: { size?: number }) {
  return <PlannerGlyph name="calendar" size={props.size ?? 18} />;
}
function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
}
function scheduleLabel(start: string) {
  const date = new Date(start);
  return `${localDate(date) === localDate() ? pt("today") : date.toLocaleDateString(currentLocale(), { month: "short", day: "numeric" })} ${timeLabel(start)}`;
}
function noteOpen(path: string) {
  openTab(path.split("/").pop() ?? path, path);
}
function run(service: PlannerService, work: Promise<unknown>) {
  void work.catch((error) => service.report(error));
}

function TaskEditor(props: { service: PlannerService; task: PlannerTask; close: () => void }) {
  const [title, setTitle] = createSignal(props.task.title);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteBlock, setDeleteBlock] = createSignal(true);
  const [due, setDue] = createSignal(props.task.metadata?.dueDate ?? "");
  const [planned, setPlanned] = createSignal(props.task.metadata?.plannedDate ?? "");
  const [start, setStart] = createSignal(dateTimeInput(props.task.metadata?.scheduledStart));
  const [end, setEnd] = createSignal(dateTimeInput(props.task.metadata?.scheduledEnd));
  const [preferredStart, setPreferredStart] = createSignal(props.task.metadata?.scheduledStart);
  const [preferredEnd, setPreferredEnd] = createSignal(props.task.metadata?.scheduledEnd);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    setError("");
    let startISO: string | undefined, endISO: string | undefined;
    try {
      startISO = start() ? (localDateTimeToISO(start(), preferredStart()) ?? undefined) : undefined;
      endISO = end() ? (localDateTimeToISO(end(), preferredEnd()) ?? undefined) : undefined;
      if ((start() && !startISO) || (end() && !endISO)) throw new Error("Invalid local time");
    } catch {
      setError(pt("invalidLocalTime"));
      return;
    }
    if (
      (startISO || endISO) &&
      (!startISO || !endISO || Date.parse(endISO) <= Date.parse(startISO))
    ) {
      setError(pt("invalidTime"));
      return;
    }
    setBusy(true);
    try {
      const metadata: Partial<TaskMetadata> = {
        dueDate: due() || undefined,
        plannedDate: start() ? start().slice(0, 10) : planned() || undefined,
      };
      if (
        startISO !== props.task.metadata?.scheduledStart ||
        endISO !== props.task.metadata?.scheduledEnd
      ) {
        Object.assign(metadata, {
          scheduledStart: startISO,
          scheduledEnd: endISO,
          timeZone: startISO ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
        });
      }
      const updated = await props.service.undo.updateTask(
        props.task,
        { title: title(), metadata },
        pt("editUndo"),
      );
      setPlannerSelection(props.service, updated);
      props.close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={pt("editTask")} close={props.close}>
      <form onSubmit={(event) => void save(event)}>
        <label class="planner-field">
          {pt("title")}
          <input
            required
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <div class="planner-form-grid">
          <label>
            {pt("dueDate")}
            <input type="date" value={due()} onInput={(e) => setDue(e.currentTarget.value)} />
          </label>
          <label>
            {pt("plannedDate")}
            <input
              type="date"
              value={planned()}
              onInput={(e) => setPlanned(e.currentTarget.value)}
            />
          </label>
          <label>
            {pt("start")}
            <input
              type="datetime-local"
              step="900"
              value={start()}
              onInput={(e) => {
                const value = e.currentTarget.value;
                setStart(value);
                if (value && !end()) {
                  try {
                    const parsed = localDateTimeToISO(value);
                    if (!parsed) throw new Error("Invalid local time");
                    setEnd(dateTimeInput(new Date(Date.parse(parsed) + 30 * 60000).toISOString()));
                  } catch {
                    setError(pt("invalidLocalTime"));
                  }
                }
              }}
            />
          </label>
          <label>
            {pt("end")}
            <input
              type="datetime-local"
              step="900"
              value={end()}
              onInput={(e) => setEnd(e.currentTarget.value)}
            />
          </label>
        </div>
        <DurationPresets
          start={start()}
          end={end()}
          previousStart={preferredStart()}
          previousEnd={preferredEnd()}
          onEnd={(value, iso) => {
            setEnd(value);
            setPreferredEnd(iso);
          }}
          disabled={busy()}
        />
        <SlotSuggestions
          service={props.service}
          start={start()}
          end={end()}
          previousStart={preferredStart()}
          previousEnd={preferredEnd()}
          exclude={props.task}
          destination={taskPlanningDestination(props.service, props.task)}
          disabled={busy()}
          onSelect={(range) => {
            setStart(dateTimeInput(range.start));
            setEnd(dateTimeInput(range.end));
            setPreferredStart(range.start);
            setPreferredEnd(range.end);
          }}
        />
        <p class="planner-muted">{pt("timeHint")}</p>
        <Show when={start()}>
          <button
            type="button"
            class="planner-text-button"
            onClick={() => {
              setStart("");
              setEnd("");
            }}
          >
            {pt("removeBlock")}
          </button>
        </Show>
        <Show when={error()}>
          <p role="alert" class="planner-error">
            {error()}
          </p>
        </Show>
        <Show when={deleting()}>
          <div class="planner-delete-confirm">
            <p>{pt("deleteTaskHint")}</p>
            <Show when={props.service.timeBlockForTask(props.task)}>
              <label>
                <input
                  type="checkbox"
                  checked={deleteBlock()}
                  onChange={(event) => setDeleteBlock(event.currentTarget.checked)}
                />{" "}
                {pt("deleteLinkedBlock")}
              </label>
            </Show>
            <button
              type="button"
              disabled={busy()}
              onClick={() => {
                setBusy(true);
                props.service
                  .deleteTask(props.task, deleteBlock())
                  .then(props.close)
                  .catch((error) => setError(String(error)))
                  .finally(() => setBusy(false));
              }}
            >
              {pt("delete")}
            </button>
          </div>
        </Show>
        <footer>
          <button
            type="button"
            class="planner-danger-button"
            onClick={() => setDeleting(!deleting())}
          >
            {pt("deleteTask")}
          </button>
          <button type="button" onClick={props.close}>
            {pt("cancel")}
          </button>
          <button type="submit" class="planner-primary" disabled={busy()}>
            {busy() ? pt("loading") : pt("save")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function ExternalDetails(props: {
  service: PlannerService;
  item: ExternalItem;
  close: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const openOriginal = () => {
    if (
      props.item.provider === "google" &&
      props.item.url &&
      /^https:\/\/(?:(?:www|calendar)\.)?google\.com\//.test(props.item.url)
    )
      run(props.service, openUrl(props.item.url));
    else if (props.item.provider.startsWith("apple")) {
      // Launch the original application using fixed, supported app bundle IDs.
      import("@tauri-apps/api/core")
        .then(({ invoke }) =>
          invoke("planner_apple_open_app", {
            kind: props.item.provider === "apple-calendar" ? "calendar" : "reminders",
          }),
        )
        .catch((e) => props.service.report(e));
    }
  };
  return (
    <Modal title={props.item.title} close={props.close}>
      <div class="planner-source-tag">
        {providerName(props.item.provider)} ·{" "}
        {props.item.writable ? pt("bidirectional") : pt("readOnly")}
      </div>
      <p>
        {props.item.allDay
          ? pt("allDay")
          : props.item.start
            ? new Date(props.item.start).toLocaleString(currentLocale())
            : props.item.dueDate}
      </p>
      <Show when={!props.item.writable}>
        <p class="planner-muted">{pt("externalHint")}</p>
      </Show>
      <Show when={props.item.writable}>
        <ExternalItemForm service={props.service} item={props.item} close={props.close} />
      </Show>
      <button type="button" onClick={openOriginal}>
        {pt("originalApp")}
      </button>
      <h3>{pt("linkedNotes")}</h3>
      <For each={props.service.linkedNotes(props.item)}>
        {(path) => (
          <button
            type="button"
            class="planner-note-link"
            onClick={() => {
              noteOpen(path);
              props.close();
            }}
          >
            {path}
          </button>
        )}
      </For>
      <Show when={vaultState.rootPath}>
        <div class="planner-link-picker">
          <h3>{pt("linkNote")}</h3>
          <input
            aria-label={pt("chooseNote")}
            placeholder={pt("chooseNote")}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <div class="planner-note-results">
            <For
              each={props.service.state.notes
                .filter((path) => path !== BINDINGS_PATH)
                .filter((p) => p.toLocaleLowerCase().includes(query().toLocaleLowerCase()))
                .slice(0, 50)}
            >
              {(path) => (
                <button
                  type="button"
                  disabled={busy() || props.service.linkedNotes(props.item).includes(path)}
                  onClick={() => void perform(() => props.service.attachNote(props.item, path))}
                >
                  {path}
                </button>
              )}
            </For>
          </div>
          <button
            type="button"
            class="planner-primary"
            disabled={busy()}
            onClick={() =>
              void perform(async () => {
                const path = await props.service.createNote(props.item);
                noteOpen(path);
                props.close();
              })
            }
          >
            {pt("createNote")}
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <p role="alert" class="planner-error">
          {error()}
        </p>
      </Show>
    </Modal>
  );
}

export function PlannerSettings() {
  const service = getPlannerService();
  if (!service) return null;
  const [folders, setFolders] = createSignal(service.state.preferences.excludedFolders.join("\n"));
  return (
    <div class="planner planner-settings">
      <Show when={service.isSourceAvailable("google")}>
        <p class="planner-muted">{pt("duplicateHint")}</p>
      </Show>
      <For each={PROVIDERS.filter((provider) => service.isSourceAvailable(provider))}>
        {(provider) => {
          const source = () => service.state.sources[provider];
          const enabled = () => service.state.preferences.enabledSources[provider];
          return (
            <section class="planner-connection">
              <header>
                <div>
                  <strong>{providerName(provider)}</strong>
                  <div class="planner-muted">
                    {enabled() && source().status.connected ? pt("connected") : pt("notConnected")}
                  </div>
                </div>
                <Show
                  when={enabled()}
                  fallback={
                    <button
                      type="button"
                      disabled={source().loading || !source().status.configured}
                      onClick={() => run(service, service.connect(provider))}
                    >
                      {source().loading ? pt("connecting") : pt("connect")}
                    </button>
                  }
                >
                  <div class="planner-actions">
                    <Show when={!source().status.connected || source().status.writable === false}>
                      <button
                        type="button"
                        disabled={source().loading}
                        onClick={() => run(service, service.connect(provider))}
                      >
                        {source().status.connected ? pt("enableWrites") : pt("reconnect")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      onClick={() => run(service, service.disconnect(provider))}
                    >
                      {pt("disconnect")}
                    </button>
                  </div>
                </Show>
              </header>
              <Show when={!source().status.configured}>
                <p class="planner-muted">
                  {provider === "google" ? pt("googleSetup") : pt("unavailable")}
                </p>
              </Show>
              <Show when={provider !== "google"}>
                <p class="planner-muted">{pt("applePermission")}</p>
              </Show>
              <Show when={enabled() && source().status.connected}>
                <p class="planner-muted">{pt("selectCalendars")}</p>
                <For each={source().calendars}>
                  {(calendar) => (
                    <div>
                      <label class="planner-calendar-choice">
                        <input
                          type="checkbox"
                          checked={service.state.preferences.selectedCalendars[provider].includes(
                            calendar.id,
                          )}
                          onChange={(e) =>
                            run(
                              service,
                              service.selectCalendar(
                                provider,
                                calendar.id,
                                e.currentTarget.checked,
                              ),
                            )
                          }
                        />
                        <span>
                          {calendar.title} {calendar.writable ? "" : `· ${pt("readOnly")}`}
                        </span>
                      </label>
                      <Show
                        when={provider !== "apple-reminders" && service.isSourceAvailable("google")}
                      >
                        <div class="planner-calendar-alias">
                          <span>{pt("duplicateCalendar")}</span>
                          <PlannerSelect
                            label={pt("duplicateCalendar")}
                            value={(() => {
                              const alias =
                                service.state.preferences.calendarAliases?.[
                                  calendarKey(provider, calendar.id)
                                ];
                              const preferred =
                                alias && service.state.preferences.preferredConnectors?.[alias];
                              if (!alias || !preferred) return "";
                              const match = service.state.sources[preferred].calendars.find(
                                (entry) =>
                                  service.state.preferences.calendarAliases?.[
                                    calendarKey(preferred, entry.id)
                                  ] === alias,
                              );
                              return match ? calendarKey(preferred, match.id) : "";
                            })()}
                            onChange={(value) => {
                              run(
                                service,
                                (async () => {
                                  if (!value) {
                                    await service.setCalendarAlias(provider, calendar.id, "");
                                    return;
                                  }
                                  const [otherProvider, otherId] = JSON.parse(value) as [
                                    "google" | "apple-calendar",
                                    string,
                                  ];
                                  const alias =
                                    service.state.preferences.calendarAliases?.[
                                      calendarKey(otherProvider, otherId)
                                    ] ||
                                    service.state.preferences.calendarAliases?.[
                                      calendarKey(provider, calendar.id)
                                    ] ||
                                    crypto.randomUUID();
                                  await service.setCalendarAlias(provider, calendar.id, alias);
                                  await service.setCalendarAlias(otherProvider, otherId, alias);
                                  await service.setPreferredConnector(alias, otherProvider);
                                })(),
                              );
                            }}
                            options={[
                              { value: "", label: pt("noAlias") },
                              ...(["google", "apple-calendar"] as const).flatMap((source) =>
                                service.state.sources[source].calendars.map((entry) => ({
                                  value: calendarKey(source, entry.id),
                                  label: entry.title,
                                  description: providerName(source),
                                })),
                              ),
                            ]}
                          />
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={source().error}>
                <p class="planner-error" role="status">
                  {source().error}
                </p>
              </Show>
              <Show when={source().updatedAt}>
                <small class="planner-muted">
                  {pt("lastUpdated")}:{" "}
                  {new Date(source().updatedAt!).toLocaleString(currentLocale())}
                </small>
              </Show>
            </section>
          );
        }}
      </For>
      <section class="planner-connection">
        <div class="planner-field">
          <span>{pt("defaultCalendar")}</span>
          <CalendarSelect
            service={service}
            label={pt("defaultCalendar")}
            value={
              service.state.preferences.defaultCalendar
                ? JSON.stringify(service.state.preferences.defaultCalendar)
                : ""
            }
            change={(value) =>
              run(service, service.setDefaultCalendar(value ? JSON.parse(value) : null))
            }
            allowLocal
          />
        </div>
      </section>
      <section class="planner-connection">
        <label>
          {pt("excludedFolders")}
          <textarea rows="3" value={folders()} onInput={(e) => setFolders(e.currentTarget.value)} />
        </label>
        <p class="planner-muted">{pt("excludedHint")}</p>
        <button
          type="button"
          onClick={() => run(service, service.setExcludedFolders(folders().split("\n")))}
        >
          {pt("save")}
        </button>
      </section>
    </div>
  );
}

function TaskRow(props: {
  task: PlannerTask;
  service: PlannerService;
  edit: (task: PlannerTask) => void;
  beginDrag?: (event: PointerEvent, task: PlannerTask) => void;
  dragging?: boolean;
}) {
  const [busy, setBusy] = createSignal(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await props.service.undo.updateTask(
        props.task,
        { checked: !props.task.checked },
        pt("completionUndo"),
      );
    } catch (e) {
      props.service.report(e);
    } finally {
      setBusy(false);
    }
  };
  const planToday = () => {
    try {
      const previous = props.task.metadata;
      const start = previous?.scheduledStart ? new Date(previous.scheduledStart) : null;
      const duration =
        start && previous?.scheduledEnd
          ? (Date.parse(previous.scheduledEnd) - start.getTime()) / 60000
          : 30;
      const metadata = start
        ? blockFor(localDate(), start.getHours() * 60 + start.getMinutes(), duration)
        : { plannedDate: localDate() };
      run(props.service, props.service.undo.updateTask(props.task, { metadata }, pt("moveUndo")));
    } catch (error) {
      props.service.report(error);
    }
  };
  return (
    <article
      class="planner-task"
      data-planner-key={taskKey(props.task)}
      data-planner-drag-source
      classList={{
        "planner-is-complete": props.task.checked,
        "planner-task-lifted": !!props.dragging,
      }}
      onPointerDown={(event) => {
        setPlannerSelection(props.service, props.task);
        if (
          !props.task.checked &&
          !(event.target as HTMLElement).closest("input, .planner-task-actions")
        )
          props.beginDrag?.(event, props.task);
      }}
    >
      <input
        type="checkbox"
        aria-label={props.task.title}
        checked={props.task.checked}
        disabled={busy() || props.service.undo.busy()}
        onChange={(event) => {
          const input = event.currentTarget;
          void toggle().finally(() => {
            input.checked = props.task.checked;
          });
        }}
      />
      <div class="planner-task-copy">
        <button
          type="button"
          class="planner-task-title"
          onClick={() => run(props.service, focusTask(props.task))}
          title={`${pt("openNote")} · ${props.task.path}`}
        >
          {props.task.title}
        </button>
        <span
          class="planner-task-status"
          data-scheduled={props.task.metadata?.scheduledStart ? "" : undefined}
        >
          {props.task.metadata?.scheduledStart
            ? scheduleLabel(props.task.metadata.scheduledStart)
            : pt("unassigned")}
        </span>
        <Show when={props.task.metadata?.dueDate}>
          <span
            class="planner-due"
            classList={{
              overdue: !props.task.checked && props.task.metadata!.dueDate! < localDate(),
            }}
          >
            {pt("dueDate")} {props.task.metadata?.dueDate}
          </span>
        </Show>
      </div>
      <div class="planner-task-actions">
        <Show when={!props.task.checked}>
          <button
            type="button"
            title={pt("planToday")}
            aria-label={pt("planToday")}
            onClick={planToday}
          >
            <PlannerGlyph name="plus" />
          </button>
        </Show>
        <button
          type="button"
          title={pt("schedule")}
          aria-label={pt("schedule")}
          onClick={() => props.edit(props.task)}
        >
          <PlannerGlyph name="more" />
        </button>
      </div>
    </article>
  );
}

function ReminderRow(props: {
  item: ExternalItem;
  service: PlannerService;
  edit: (item: ExternalItem) => void;
  gestures: ReturnType<typeof createCalendarGestures>;
}) {
  return (
    <article
      class="planner-task"
      data-planner-key={reminderKey(props.item)}
      data-planner-drag-source
      classList={{
        "planner-is-complete": !!props.item.completed,
        "planner-task-lifted": props.gestures.lifted()?.key === reminderKey(props.item),
      }}
      onPointerDown={(event) => {
        setPlannerSelection(props.service, props.item);
        if (
          !props.item.completed &&
          props.item.writable &&
          !(event.target as HTMLElement).closest("input")
        )
          props.gestures.begin(event, "move", reminderBlock(props.item, props.service), true);
      }}
    >
      <input
        type="checkbox"
        aria-label={props.item.title}
        checked={!!props.item.completed}
        disabled={!props.item.writable || props.service.undo.busy()}
        onChange={(event) => {
          const input = event.currentTarget;
          run(
            props.service,
            props.service.undo
              .updateItem(props.item, { completed: input.checked }, pt("completionUndo"))
              .finally(() => {
                input.checked = !!props.item.completed;
              }),
          );
        }}
      />
      <div class="planner-task-copy">
        <button
          type="button"
          class="planner-task-title"
          title={providerName(props.item.provider)}
          onClick={() => props.edit(props.item)}
        >
          {props.item.title}
        </button>
        <small
          class="planner-task-status"
          data-scheduled={props.service.timeBlockForTask(props.item)?.start ? "" : undefined}
        >
          {props.service.timeBlockForTask(props.item)?.start
            ? scheduleLabel(props.service.timeBlockForTask(props.item)!.start)
            : pt("unassigned")}
          {` · ${providerName(props.item.provider)}`}
          {props.item.writable ? "" : ` · ${pt("readOnly")}`}
        </small>
      </div>
    </article>
  );
}

export default function PlannerView() {
  const service = getPlannerService();
  if (!service) return null;
  const plannerTabId = getActiveTab()?.type === "planner" ? getActiveTab()?.id : undefined;
  const saved = getActiveTab()?.state?.planner;
  const [filter, setFilter] = createSignal<TaskFilter>(saved?.filter ?? "today");
  const [anchor, setAnchor] = createSignal(saved?.anchor ?? localDate());
  const [navigationRevision, setNavigationRevision] = createSignal(0);
  const [query, setQuery] = createSignal(saved?.query ?? "");
  const [sort, setSort] = createSignal<TaskSort>(saved?.sort ?? "due");
  const [dateMenuOpen, setDateMenuOpen] = createSignal(false);
  let plannerRoot!: HTMLDivElement;
  let composerScope!: HTMLDivElement;
  const taskListId = createUniqueId();
  const [availableWidth, setAvailableWidth] = createSignal(1000);
  const [tasksOpen, setTasksOpen] = createSignal(saved?.tasksOpen === true);
  const layout = createMemo(() =>
    availableWidth() < 700 ? "compact" : availableWidth() < 1000 ? "split" : "wide",
  );
  const visibleDays = createMemo(() => (layout() === "compact" ? 1 : layout() === "split" ? 3 : 7));
  const [quick, setQuick] = createSignal("");
  let quickInput!: HTMLInputElement;
  const [adding, setAdding] = createSignal(false);
  const [edit, setEdit] = createSignal<PlannerTask>();
  const [external, setExternal] = createSignal<ExternalItem>();
  const [settings, setSettings] = createSignal(false);
  const [sourceFilter, setSourceFilter] = createSignal<"all" | "note" | "apple">(
    saved?.sourceFilter ?? "all",
  );
  const [quickSource, setQuickSource] = createSignal(saved?.quickSource ?? "note");
  const [nowRequest, setNowRequest] = createSignal(0);
  let scrollTop =
    Number.isFinite(saved?.scrollTop) && saved!.scrollTop! >= 0 ? saved!.scrollTop : undefined;
  const selectTask = (task: PlannerTask) => {
    setPlannerSelection(service, task);
    setEdit(task);
  };
  const selectExternal = (item: ExternalItem) => {
    setPlannerSelection(service, item);
    setExternal(item);
  };
  const [creating, setCreating] = createSignal<CalendarRange>();
  const [composerSpace, setComposerSpace] = createSignal(0);
  const [creationAnchor, setCreationAnchor] = createSignal<PopoverAnchor>();
  const [draft, setDraft] = createSignal<CalendarRange & { title: string }>();
  const openCreate = (range: CalendarRange, point?: PopoverAnchor) => {
    setCreationAnchor(point);
    setDraft({ ...range, title: "" });
    setCreating(range);
  };
  const closeCreate = () => {
    setComposerSpace(0);
    setCreating(undefined);
    setCreationAnchor(undefined);
    setDraft(undefined);
  };
  const creationTarget = () => {
    const range = draft();
    if (!range || !composerScope) return undefined;
    const day = range.allDay ? range.start : localDate(new Date(range.start));
    const previews = [
      ...composerScope.querySelectorAll<HTMLElement>("[data-planner-drop-preview]"),
    ];
    const preview = previews.find((element) => element.dataset.plannerDay === day) ?? previews[0];
    if (!preview) return undefined;
    const rectangle = preview.getBoundingClientRect();
    const columns = previews.map((element) =>
      (
        element.closest(".planner-day-column") ??
        element.parentElement ??
        element
      ).getBoundingClientRect(),
    );
    return {
      left: Math.min(...columns.map((column) => column.left)),
      right: Math.max(...columns.map((column) => column.right)),
      top: rectangle.top,
      bottom: rectangle.bottom,
    };
  };
  const [review, setReview] = createSignal<PendingOperation>();
  const [linkReview, setLinkReview] = createSignal<TimeBlockLink>();
  const gestures = createCalendarGestures({
    create: openCreate,
    commit: (block, range) => commitCalendarBlock(service, block, range),
    error: (error) => service.report(error),
  });
  const beginTaskDrag = (event: PointerEvent, task: PlannerTask) => {
    setPlannerSelection(service, task);
    gestures.begin(event, "move", taskBlock(task), true);
  };

  const persist = () => {
    if (
      plannerTabId &&
      filesState.tabs.some((tab) => tab.id === plannerTabId && tab.type === "planner")
    )
      updateTabState(plannerTabId, {
        planner: {
          filter: filter(),
          anchor: anchor(),
          tasksOpen: tasksOpen(),
          sourceFilter: sourceFilter(),
          quickSource: quickSource(),
          scrollTop,
          query: query(),
          sort: sort(),
        },
      });
  };
  const changeAnchor = (day: string) => {
    setNavigationRevision((value) => value + 1);
    setAnchor(day);
  };
  createEffect(on([filter, anchor, tasksOpen, sourceFilter, quickSource, query, sort], persist));
  createEffect(on([anchor, visibleDays], ([day, count]) => service.setAnchor(day, count)));
  onMount(() => {
    setAvailableWidth(plannerRoot.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(plannerRoot);
    const release = service.visible();
    onCleanup(() => {
      observer.disconnect();
      release();
    });
  });
  const totalPlanned = createMemo(() => {
    const intervals = service.state.tasks.flatMap((task) =>
      task.metadata?.scheduledStart && task.metadata.scheduledEnd
        ? [{ start: task.metadata.scheduledStart, end: task.metadata.scheduledEnd }]
        : [],
    );
    const events = PROVIDERS.flatMap((provider) => service.state.sources[provider].items).flatMap(
      (item) =>
        item.kind === "event" && item.start && item.end
          ? [{ start: item.start, end: item.end, allDay: item.allDay }]
          : [],
    );
    const minutes = plannedMinutes(anchor(), [...intervals, ...events]);
    const parts = [];
    if (minutes >= 60)
      parts.push(
        new Intl.NumberFormat(currentLocale(), {
          style: "unit",
          unit: "hour",
          unitDisplay: "short",
        }).format(Math.floor(minutes / 60)),
      );
    if (minutes % 60 || !minutes)
      parts.push(
        new Intl.NumberFormat(currentLocale(), {
          style: "unit",
          unit: "minute",
          unitDisplay: "short",
        }).format(Math.round(minutes % 60)),
      );
    return parts.join(" ");
  });
  const reminderMatches = (item: ExternalItem, selected: TaskFilter) => {
    const link = service.timeBlockForTask(item);
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
          scheduledStart: link?.start,
          scheduledEnd: link?.end,
        },
      },
      selected,
    );
  };
  type ListedTask = PlannerTask | ExternalItem;
  const candidates = createMemo<TaskQueryEntry<ListedTask>[]>(() => [
    ...(sourceFilter() === "apple"
      ? []
      : service.state.tasks.map((task) => ({
          value: task,
          key: taskKey(task),
          title: task.title,
          context: task.path,
          dueDate: task.metadata?.dueDate,
          scheduledStart: task.metadata?.scheduledStart,
        }))),
    ...(sourceFilter() === "note"
      ? []
      : service.state.sources["apple-reminders"].items.map((item) => ({
          value: item,
          key: reminderKey(item),
          title: item.title,
          context: `${providerName(item.provider)} ${service.state.sources[item.provider].calendars.find((calendar) => calendar.id === item.calendarId)?.title ?? ""}`,
          dueDate: item.dueDate?.slice(0, 10),
          scheduledStart: service.timeBlockForTask(item)?.start,
        }))),
  ]);
  const searched = createMemo(() =>
    queryTaskEntries(candidates(), query(), sort(), currentLocale()),
  );
  const matchesView = (item: ListedTask, selected: TaskFilter) =>
    "path" in item ? matchesFilter(item, selected) : reminderMatches(item, selected);
  const filtered = createMemo(() =>
    searched()
      .map((entry) => entry.value)
      .filter((item) => matchesView(item, filter())),
  );
  const isOverdue = (item: ListedTask) => {
    const due = "path" in item ? item.metadata?.dueDate : item.dueDate?.slice(0, 10);
    return !!due && due < localDate();
  };
  const overdue = () => filtered().filter(isOverdue);
  const rest = () =>
    filter() === "today" ? filtered().filter((item) => !isOverdue(item)) : filtered();
  const renderTask = (item: ListedTask) =>
    "path" in item ? (
      <TaskRow
        task={item}
        service={service}
        edit={selectTask}
        beginDrag={beginTaskDrag}
        dragging={gestures.lifted()?.key === taskKey(item)}
      />
    ) : (
      <ReminderRow item={item} service={service} edit={selectExternal} gestures={gestures} />
    );
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (adding() || !quick().trim()) return;
    const submitted = quick();
    setAdding(true);
    try {
      await service.addTask(submitted, taskSourceOptions(quickSource()));
      if (quick() === submitted) setQuick("");
      setFilter("unplanned");
      persist();
      if (
        document.activeElement === document.body ||
        document.activeElement === event.submitter ||
        document.activeElement === quickInput
      )
        quickInput.focus({ preventScroll: true });
    } catch (error) {
      service.report(error);
    } finally {
      setAdding(false);
    }
  };
  return (
    <div
      ref={plannerRoot}
      class="planner planner-main"
      data-layout={layout()}
      data-tasks-open={tasksOpen() ? "" : undefined}
      classList={{
        "planner-is-dragging": gestures.lifted()?.phase === "dragging",
        "planner-is-resizing":
          !!gestures.preview()?.key && !gestures.lifted() && !gestures.busyKey(),
      }}
    >
      <header class="planner-header">
        <div class="planner-heading">
          <PlannerIcon size={21} />
          <div>
            <h1>{pt("name")}</h1>
            <span>{pt("description")}</span>
          </div>
        </div>
        <div class="planner-actions">
          <button
            type="button"
            onClick={() => run(service, service.refresh())}
            disabled={service.state.loading}
            title={pt("refresh")}
            aria-label={pt("refresh")}
          >
            <PlannerGlyph name="refresh" size={16} />
          </button>
          <button
            type="button"
            onClick={() => setSettings(true)}
            aria-label={pt("settings")}
            title={pt("settings")}
          >
            <PlannerGlyph name="settings" size={16} class="planner-settings-icon" />
            <span class="planner-settings-label">{pt("settings")}</span>
          </button>
        </div>
      </header>
      <Show when={service.state.error}>
        <div class="planner-error-banner" role="alert">
          <span>{service.state.error}</span>
          <button type="button" onClick={() => service.clearError()} aria-label={pt("close")}>
            <PlannerGlyph name="close" />
          </button>
        </div>
      </Show>
      <For
        each={service.state.timeBlockLinks.filter(
          (link) =>
            service.isSourceAvailable(link.eventRef.provider) &&
            (link.status === "conflict" || link.status === "missing"),
        )}
      >
        {(link) => (
          <div class="planner-error-banner" role="status">
            <span>
              {link.title} · {link.error || pt("pendingChanges")}
            </span>
            <button type="button" onClick={() => setLinkReview(link)}>
              {pt("retryConflict")}
            </button>
          </div>
        )}
      </For>
      <Show
        when={service.state.operations.some((operation) =>
          service.isSourceAvailable(operation.provider),
        )}
      >
        <div class="planner-operation-list" role="status">
          <For
            each={service.state.operations.filter((operation) =>
              service.isSourceAvailable(operation.provider),
            )}
          >
            {(operation) => (
              <div>
                <span>
                  {operation.status === "pending"
                    ? pt("saving")
                    : operation.error || pt("pendingChanges")}
                </span>
                <Show when={operation.status !== "pending"}>
                  <button
                    type="button"
                    onClick={() =>
                      operation.status === "conflict"
                        ? setReview(operation)
                        : run(service, service.retryOperation(operation.id))
                    }
                  >
                    {operation.status === "conflict" ? pt("retryConflict") : pt("retry")}
                  </button>
                  <button
                    type="button"
                    onClick={() => run(service, service.dismissOperation(operation.id))}
                  >
                    {pt("cancel")}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show
        when={vaultState.rootPath}
        fallback={<div class="planner-empty">{pt("vaultRequired")}</div>}
      >
        <div
          class="planner-workspace"
          ref={composerScope}
          data-composer-docked={composerSpace() > 0 ? "" : undefined}
        >
          <div class="planner-compact-bar">
            <button
              type="button"
              aria-expanded={tasksOpen()}
              aria-controls={taskListId}
              onClick={() => setTasksOpen(!tasksOpen())}
            >
              <span>{pt("tasks")}</span>
              <span class="planner-task-count">
                {service.state.tasks.filter((task) => !task.checked).length +
                  service.state.sources["apple-reminders"].items.filter((item) => !item.completed)
                    .length}
              </span>
              <PlannerGlyph name={tasksOpen() ? "chevron-up" : "chevron-down"} size={12} />
            </button>
            <span>{tasksOpen() ? pt("dragToPlan") : pt("dayPlan")}</span>
          </div>
          <div class="planner-content">
            <aside
              id={taskListId}
              class="planner-task-list"
              hidden={layout() === "compact" && !tasksOpen()}
            >
              <div class="planner-capture">
                <div class="planner-capture-heading">
                  <span>{pt("captureTask")}</span>
                  <TaskSourceSelect
                    service={service}
                    value={quickSource()}
                    change={setQuickSource}
                    compact
                  />
                </div>
                <form class="planner-quick-add" onSubmit={(event) => void submit(event)}>
                  <input
                    ref={quickInput}
                    aria-label={pt("quickAdd")}
                    placeholder={pt("quickAdd")}
                    value={quick()}
                    onInput={(e) => setQuick(e.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    aria-label={pt("add")}
                    disabled={adding() || !quick().trim()}
                  >
                    <PlannerGlyph name="return" size={15} />
                  </button>
                </form>
              </div>
              <div class="planner-task-controls">
                <nav class="planner-filters" aria-label={pt("tasks")}>
                  <For each={["today", "upcoming", "unplanned", "completed"] as TaskFilter[]}>
                    {(value) => (
                      <button
                        type="button"
                        aria-pressed={filter() === value}
                        onClick={() => {
                          setFilter(value);
                        }}
                      >
                        {pt(value)}
                        <span>
                          {searched().filter((entry) => matchesView(entry.value, value)).length}
                        </span>
                      </button>
                    )}
                  </For>
                </nav>
                <PlannerSelect
                  label={pt("sourceFilter")}
                  value={sourceFilter()}
                  onChange={(value) => setSourceFilter(value as "all" | "note" | "apple")}
                  options={[
                    { value: "all", label: pt("allSources") },
                    { value: "note", label: pt("noteTasks") },
                    { value: "apple", label: providerName("apple-reminders") },
                  ]}
                  compact
                  iconOnly
                />
              </div>
              <TaskSearch query={query()} onQuery={setQuery} sort={sort()} onSort={setSort} />
              <div class="planner-list-scroll">
                <Show when={filter() === "today" && overdue().length > 0}>
                  <h3 class="planner-overdue-heading">{pt("overdue")}</h3>
                  <For each={overdue()}>{renderTask}</For>
                </Show>
                <Show when={filter() === "today" && rest().length > 0}>
                  <h3>{pt("today")}</h3>
                </Show>
                <For each={rest()}>{renderTask}</For>
                <Show when={!filtered().length}>
                  <div class="planner-empty">
                    <PlannerIcon size={28} />
                    <strong>
                      {service.state.loading
                        ? pt("loading")
                        : query().trim()
                          ? pt("noTaskMatches")
                          : pt("emptyTasks")}
                    </strong>
                    <Show when={query().trim()} fallback={<p>{pt("emptyHint")}</p>}>
                      <button type="button" onClick={() => setQuery("")}>
                        {pt("clearTaskSearch")}
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            </aside>
            <section class="planner-calendar">
              <header class="planner-week-toolbar">
                <div class="planner-calendar-heading">
                  <h2>
                    <DateNavigator
                      value={anchor()}
                      onChange={changeAnchor}
                      onOpenChange={setDateMenuOpen}
                    />
                  </h2>
                  <span class="planner-muted">
                    {visibleDays() === 1
                      ? dateFromKey(anchor()).toLocaleDateString(currentLocale(), {
                          month: "short",
                          day: "numeric",
                          weekday: "long",
                        })
                      : visibleDays() === 3
                        ? pt("threeDayPlan")
                        : pt("week")}
                    <span class="planner-plan-total">
                      {anchor() === localDate()
                        ? pt("today")
                        : dateFromKey(anchor()).toLocaleDateString(currentLocale(), {
                            month: "numeric",
                            day: "numeric",
                          })}{" "}
                      {pt("plannedTotal")} {totalPlanned()}
                    </span>
                  </span>
                </div>
                <div class="planner-actions">
                  <button
                    type="button"
                    class="planner-now-button"
                    title={pt("currentTime")}
                    onClick={() => {
                      changeAnchor(localDate());
                      setNowRequest((value) => value + 1);
                    }}
                  >
                    {pt("now")}
                  </button>
                  <button
                    type="button"
                    class="planner-new-event"
                    aria-label={pt("newItem")}
                    onClick={(event) => {
                      const range = blockFor(anchor(), 9 * 60, 30);
                      const rect = event.currentTarget.getBoundingClientRect();
                      openCreate(
                        {
                          start: range.scheduledStart,
                          end: range.scheduledEnd,
                          allDay: false,
                        },
                        { x: rect.left, y: rect.bottom + 24 },
                      );
                    }}
                  >
                    <PlannerGlyph name="plus" />
                    <span>{pt("newItem")}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={pt(
                      visibleDays() === 1
                        ? "previousDay"
                        : visibleDays() === 3
                          ? "previousThreeDays"
                          : "previousWeek",
                    )}
                    onClick={() => changeAnchor(addDays(anchor(), -visibleDays()))}
                  >
                    <PlannerGlyph name="chevron-left" />
                  </button>
                  <button type="button" onClick={() => changeAnchor(localDate())}>
                    {pt("today")}
                  </button>
                  <button
                    type="button"
                    aria-label={pt(
                      visibleDays() === 1
                        ? "nextDay"
                        : visibleDays() === 3
                          ? "nextThreeDays"
                          : "nextWeek",
                    )}
                    onClick={() => changeAnchor(addDays(anchor(), visibleDays()))}
                  >
                    <PlannerGlyph name="chevron-right" />
                  </button>
                </div>
              </header>
              <Show when={layout() === "compact"}>
                <nav class="planner-day-picker" aria-label={pt("chooseDay")}>
                  <For each={weekDays(anchor())}>
                    {(day) => (
                      <button
                        type="button"
                        aria-pressed={day === anchor()}
                        aria-current={day === localDate() ? "date" : undefined}
                        aria-label={dateFromKey(day).toLocaleDateString(currentLocale(), {
                          month: "long",
                          day: "numeric",
                          weekday: "long",
                        })}
                        onClick={() => changeAnchor(day)}
                      >
                        <span>
                          {dateFromKey(day).toLocaleDateString(currentLocale(), {
                            weekday: "short",
                          })}
                        </span>
                        <strong>{dateFromKey(day).getDate()}</strong>
                      </button>
                    )}
                  </For>
                </nav>
              </Show>
              <div class="planner-source-strip">
                <For
                  each={PROVIDERS.filter(
                    (p) =>
                      service.isSourceAvailable(p) && service.state.preferences.enabledSources[p],
                  )}
                >
                  {(p) => (
                    <div
                      class="planner-source-status"
                      classList={{ "planner-source-stale": !!service.state.sources[p].error }}
                      title={
                        service.state.sources[p].updatedAt
                          ? `${pt("lastUpdated")} ${timeLabel(service.state.sources[p].updatedAt!)}`
                          : undefined
                      }
                    >
                      <span class="planner-source-dot" />
                      {providerName(p)}
                      <Show when={service.state.sources[p].loading}>
                        <span>{pt("loading")}</span>
                      </Show>
                      <Show when={service.state.sources[p].error}>
                        <button
                          type="button"
                          onClick={() => setSettings(true)}
                          title={service.state.sources[p].error}
                        >
                          {service.state.sources[p].items.length ? pt("cached") : pt("reconnect")}
                        </button>
                      </Show>
                      <Show when={service.state.sources[p].updatedAt}>
                        <time title={service.state.sources[p].updatedAt}>
                          {pt("lastUpdated")} {timeLabel(service.state.sources[p].updatedAt!)}
                        </time>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <PlannerWeek
                service={service}
                anchor={anchor()}
                visibleDays={visibleDays()}
                initialScrollTop={scrollTop}
                onScrollPosition={(top) => {
                  scrollTop = top;
                  persist();
                }}
                nowRequest={nowRequest()}
                navigateWeek={(direction) => setAnchor(addDays(anchor(), direction * 7))}
                navigationRevision={navigationRevision()}
                pagingDisabled={
                  !!creating() ||
                  !!edit() ||
                  !!external() ||
                  settings() ||
                  dateMenuOpen() ||
                  !!review() ||
                  !!linkReview()
                }
                gestures={gestures}
                edit={selectTask}
                external={selectExternal}
                create={openCreate}
                draft={draft()}
              />
            </section>
          </div>
          <Show when={composerSpace() > 0}>
            <div
              class="planner-composer-space"
              style={{ height: `${composerSpace()}px` }}
              aria-hidden="true"
            />
          </Show>
        </div>
      </Show>
      <UndoNotice service={service} keyboard />
      <Show when={edit()} keyed>
        {(task) => <TaskEditor service={service} task={task} close={() => setEdit(undefined)} />}
      </Show>
      <Show when={external()} keyed>
        {(item) => (
          <ExternalDetails service={service} item={item} close={() => setExternal(undefined)} />
        )}
      </Show>
      <Show when={linkReview()} keyed>
        {(link) => (
          <LinkConflictReview
            service={service}
            link={link}
            close={() => setLinkReview(undefined)}
          />
        )}
      </Show>
      <Show when={review()} keyed>
        {(operation) => (
          <OperationReview
            service={service}
            operation={operation}
            close={() => setReview(undefined)}
          />
        )}
      </Show>
      <Show when={creating()} keyed>
        {(range) => (
          <NewItemEditor
            service={service}
            range={range}
            initialSource={quickSource()}
            onSourceChange={setQuickSource}
            anchor={creationAnchor()}
            composer={{
              scope: composerScope,
              target: creationTarget,
              reserveSpace: setComposerSpace,
            }}
            preview={(range, title) => setDraft({ ...range, title })}
            close={closeCreate}
          />
        )}
      </Show>
      <Show when={settings()}>
        <Modal title={pt("settings")} close={() => setSettings(false)}>
          <PlannerSettings />
        </Modal>
      </Show>
    </div>
  );
}

export function PlannerPanel() {
  const service = getPlannerService();
  if (!service) return null;
  const [edit, setEdit] = createSignal<PlannerTask>();
  const [external, setExternal] = createSignal<ExternalItem>();
  const selectTask = (task: PlannerTask) => {
    setPlannerSelection(service, task);
    setEdit(task);
  };
  const selectExternal = (item: ExternalItem) => {
    setPlannerSelection(service, item);
    setExternal(item);
  };
  return (
    <div class="planner planner-panel-shell">
      <PlannerContextPanel service={service} openTask={selectTask} openExternal={selectExternal} />
      <Show when={getActiveTab()?.type !== "planner"}>
        <UndoNotice service={service} />
      </Show>
      <Show when={edit()} keyed>
        {(task) => <TaskEditor service={service} task={task} close={() => setEdit(undefined)} />}
      </Show>
      <Show when={external()} keyed>
        {(item) => (
          <ExternalDetails service={service} item={item} close={() => setExternal(undefined)} />
        )}
      </Show>
    </div>
  );
}

export function PlannerToolbar() {
  return (
    <button
      type="button"
      title={pt("name")}
      aria-label={pt("name")}
      class="flex size-7 items-center justify-center rounded-xs text-icon-muted hover:bg-ghost-hover hover:text-icon"
      onClick={() => openTab(pt("name"), null, "planner")}
    >
      <PlannerIcon />
    </button>
  );
}
