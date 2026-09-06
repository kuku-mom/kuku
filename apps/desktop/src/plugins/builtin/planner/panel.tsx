import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { currentLocale } from "~/i18n";
import type { PlannerTask } from "~/lib/planner_tasks";
import { focusTask } from "~/plugins/document_mutations";
import { getActiveTab, openTab } from "~/stores/files";
import { vaultState } from "~/stores/vault";

import { BINDINGS_PATH } from "./bindings";
import { dateFromKey, localDate, matchesFilter } from "./dates";
import { pt, providerName } from "./messages";
import { PlannerGlyph } from "./icons";
import { plannerSelection } from "./selection";
import type { PlannerService } from "./service";
import { createTodayFeed, upcomingEvents } from "./today_feed";
import { PROVIDERS, sameEventRef, type ExternalItem } from "./types";

function noteName(path: string) {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

function openNote(path: string) {
  openTab(noteName(path), path);
}

function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function eventLabel(item: ExternalItem, today: string) {
  const day = item.allDay
    ? item.start?.slice(0, 10)
    : item.start
      ? localDate(new Date(item.start))
      : item.dueDate?.slice(0, 10);
  const date =
    day === today
      ? pt("today")
      : day
        ? dateFromKey(day).toLocaleDateString(currentLocale(), {
            month: "short",
            day: "numeric",
            weekday: "short",
          })
        : "";
  return `${date}${date ? " · " : ""}${item.allDay ? pt("allDay") : item.start ? timeLabel(item.start) : pt("reminders")}`;
}

export function PlannerContextPanel(props: {
  service: PlannerService;
  openTask: (task: PlannerTask) => void;
  openExternal: (item: ExternalItem) => void;
}) {
  const inPlanner = () => getActiveTab()?.type === "planner";
  const feed = createTodayFeed(props.service, () => !inPlanner());
  const [now, setNow] = createSignal(new Date());
  const [busy, setBusy] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [linking, setLinking] = createSignal(false);
  const today = () => localDate(now());
  const selection = () => plannerSelection(props.service);
  const selectedTask = createMemo(() => {
    const item = selection();
    if (!item) return null;
    if ("path" in item) return item;
    const linked = props.service.linkedTask(item);
    return linked && "path" in linked ? linked : null;
  });
  const selectedExternal = createMemo(() => {
    const item = selection();
    if (!item) return null;
    if (!("path" in item)) return item;
    const link = props.service.timeBlockForTask(item);
    return link
      ? (props.service.state.sources[link.eventRef.provider].items.find(
          (event) => event.writeRef && sameEventRef(event.writeRef, link.eventRef),
        ) ?? null)
      : null;
  });
  const items = () =>
    PROVIDERS.flatMap((provider) => {
      if (
        !props.service.state.preferences.enabledSources[provider] ||
        !props.service.state.sources[provider].status.connected
      )
        return [];
      const selected = props.service.state.preferences.selectedCalendars[provider];
      const visible = new Set(
        props.service.visibleCalendars(provider).map((calendar) => calendar.id),
      );
      return feed
        .state()
        [provider].items.filter(
          (item) => selected.includes(item.calendarId) && visible.has(item.calendarId),
        );
    });
  const upcoming = () => upcomingEvents(items(), now());
  const reminders = () =>
    items().filter(
      (item) =>
        item.kind === "reminder" &&
        !item.completed &&
        !!item.dueDate &&
        item.dueDate.slice(0, 10) <= today(),
    );
  const tasks = () =>
    props.service.state.tasks.filter((task) => matchesFilter(task, "today", today()));
  const linkedNotes = () => {
    const item = selectedExternal();
    return item ? props.service.linkedNotes(item) : [];
  };
  const perform = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      props.service.report(error);
    } finally {
      setBusy(false);
    }
  };
  const originalApp = (item: ExternalItem) => {
    if (
      item.provider === "google" &&
      item.url &&
      /^https:\/\/(?:(?:www|calendar)\.)?google\.com\//.test(item.url)
    )
      return openUrl(item.url);
    if (item.provider.startsWith("apple"))
      return invoke("planner_apple_open_app", {
        kind: item.provider === "apple-calendar" ? "calendar" : "reminders",
      });
    return Promise.resolve();
  };
  onMount(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    const resume = () => setNow(new Date());
    window.addEventListener("focus", resume);
    onCleanup(() => {
      clearInterval(timer);
      window.removeEventListener("focus", resume);
    });
  });
  return (
    <div class="planner planner-panel">
      <Show
        when={inPlanner()}
        fallback={
          <>
            <header>
              <h2>{pt("today")}</h2>
              <button type="button" onClick={() => openTab(pt("name"), null, "planner")}>
                <span>{pt("week")}</span> <PlannerGlyph name="open" size={12} />
              </button>
            </header>
            <section class="planner-panel-section" aria-label={pt("today")}>
              <For each={tasks()}>
                {(task) => (
                  <div class="planner-panel-row">
                    <input
                      type="checkbox"
                      aria-label={task.title}
                      checked={task.checked}
                      disabled={busy() || props.service.undo.busy()}
                      onChange={(event) => {
                        const input = event.currentTarget;
                        void perform(() =>
                          props.service.undo.updateTask(
                            task,
                            { checked: !task.checked },
                            pt("completionUndo"),
                          ),
                        ).finally(() => {
                          input.checked = task.checked;
                        });
                      }}
                    />
                    <button type="button" onClick={() => props.openTask(task)}>
                      <strong>{task.title}</strong>
                      <small title={task.path}>{noteName(task.path)}</small>
                    </button>
                  </div>
                )}
              </For>
              <For each={reminders()}>
                {(item) => (
                  <div class="planner-panel-row">
                    <Show when={item.writable}>
                      <input
                        type="checkbox"
                        aria-label={item.title}
                        checked={!!item.completed}
                        disabled={busy() || props.service.undo.busy()}
                        onChange={(event) => {
                          const input = event.currentTarget;
                          void perform(async () => {
                            await props.service.undo.updateItem(
                              item,
                              { completed: true },
                              pt("completionUndo"),
                            );
                            await feed.refresh();
                          }).finally(() => {
                            input.checked = !!item.completed;
                          });
                        }}
                      />
                    </Show>
                    <button type="button" onClick={() => props.openExternal(item)}>
                      <strong>{item.title}</strong>
                      <small>
                        {providerName(item.provider)}
                        {!item.writable ? ` · ${pt("readOnly")}` : ""}
                      </small>
                    </button>
                  </div>
                )}
              </For>
              <Show when={!tasks().length && !reminders().length}>
                <p class="planner-muted">{pt("emptyTasks")}</p>
              </Show>
            </section>
            <section class="planner-panel-section">
              <header>
                <div>
                  <h3>{pt("next")}</h3>
                  <small class="planner-muted">{pt("sevenDayWindow")}</small>
                </div>
                <button
                  type="button"
                  title={pt("refresh")}
                  aria-label={pt("refresh")}
                  disabled={PROVIDERS.some((provider) => feed.state()[provider].loading)}
                  onClick={() => void feed.refresh(true)}
                >
                  <PlannerGlyph name="refresh" />
                </button>
              </header>
              <For
                each={upcoming()}
                fallback={
                  <p class="planner-muted">
                    {PROVIDERS.some((provider) => feed.state()[provider].loading)
                      ? pt("loading")
                      : pt("noEvents")}
                  </p>
                }
              >
                {(item) => (
                  <button
                    type="button"
                    class="planner-next-event"
                    onClick={() => props.openExternal(item)}
                  >
                    <small>{eventLabel(item, today())}</small>
                    <strong>{item.title}</strong>
                    <small>{providerName(item.provider)}</small>
                  </button>
                )}
              </For>
              <For each={PROVIDERS}>
                {(provider) => (
                  <Show when={feed.state()[provider].error || feed.state()[provider].reconnect}>
                    <div
                      class="planner-panel-status"
                      role="status"
                      title={feed.state()[provider].error}
                    >
                      <span>
                        {providerName(provider)} ·{" "}
                        {feed.state()[provider].reconnect
                          ? pt("reconnect")
                          : feed.state()[provider].updatedAt
                            ? pt("cached")
                            : pt("error")}
                      </span>
                      <Show when={feed.state()[provider].updatedAt}>
                        {(updatedAt) => (
                          <small>
                            {pt("lastUpdated")}{" "}
                            {new Date(updatedAt()).toLocaleString(currentLocale())}
                          </small>
                        )}
                      </Show>
                    </div>
                  </Show>
                )}
              </For>
            </section>
          </>
        }
      >
        <header>
          <h2>{pt("selectionDetails")}</h2>
        </header>
        <Show
          when={selection()}
          keyed
          fallback={
            <div class="planner-panel-empty">
              <p>{pt("selectItemHint")}</p>
            </div>
          }
        >
          {(item) => (
            <>
              <section class="planner-panel-detail">
                <span class="planner-panel-meta">
                  {"path" in item ? pt("noteTasks") : providerName(item.provider)}
                </span>
                <h3>{item.title}</h3>
                <Show when={"path" in item ? item.metadata?.scheduledStart : item.start}>
                  <p class="planner-panel-meta">
                    {"path" in item
                      ? `${new Date(item.metadata!.scheduledStart!).toLocaleDateString(currentLocale())} · ${timeLabel(item.metadata!.scheduledStart!)}${item.metadata?.scheduledEnd ? `–${timeLabel(item.metadata.scheduledEnd)}` : ""}`
                      : eventLabel(item, today())}
                  </p>
                </Show>
                <Show when={"path" in item ? item.metadata?.dueDate : item.dueDate}>
                  {(due) => (
                    <p class="planner-panel-meta">
                      {pt("dueDate")} · {due()}
                    </p>
                  )}
                </Show>
                <Show when={!("path" in item) && item.location}>
                  {(location) => <p class="planner-panel-meta">{location()}</p>}
                </Show>
                <Show when={!("path" in item) && item.description}>
                  {(description) => <p class="planner-panel-description">{description()}</p>}
                </Show>
                <div class="planner-panel-actions">
                  <button
                    type="button"
                    onClick={() =>
                      "path" in item ? props.openTask(item) : props.openExternal(item)
                    }
                  >
                    {"path" in item ? pt("editTask") : pt("editItem")}
                  </button>
                  <Show when={!("path" in item)}>
                    <button
                      type="button"
                      onClick={() => void perform(() => originalApp(item as ExternalItem))}
                    >
                      {pt("originalApp")}
                    </button>
                  </Show>
                </div>
              </section>
              <section class="planner-panel-section">
                <h3>{pt("prepareNotes")}</h3>
                <Show when={selectedTask()}>
                  {(task) => (
                    <button
                      type="button"
                      class="planner-panel-note"
                      title={task().path}
                      onClick={() => void perform(() => focusTask(task()))}
                    >
                      <strong>{noteName(task().path)}</strong>
                      <small>{pt("openNote")}</small>
                    </button>
                  )}
                </Show>
                <For each={linkedNotes()}>
                  {(path) => (
                    <button
                      type="button"
                      class="planner-panel-note"
                      title={path}
                      onClick={() => openNote(path)}
                    >
                      <strong>{noteName(path)}</strong>
                      <small>{pt("linkedCalendarNote")}</small>
                    </button>
                  )}
                </For>
                <Show when={!selectedTask() && !linkedNotes().length}>
                  <p class="planner-muted">{pt("noLinkedNotes")}</p>
                </Show>
                <Show when={selectedExternal() && vaultState.rootPath}>
                  <div class="planner-panel-actions">
                    <button
                      type="button"
                      aria-expanded={linking()}
                      onClick={() => setLinking(!linking())}
                    >
                      {pt("linkNote")}
                    </button>
                    <button
                      type="button"
                      disabled={busy()}
                      onClick={() =>
                        void perform(async () => {
                          const external = selectedExternal();
                          if (external) openNote(await props.service.createNote(external));
                        })
                      }
                    >
                      {pt("createNote")}
                    </button>
                  </div>
                  <Show when={linking()}>
                    <input
                      aria-label={pt("chooseNote")}
                      placeholder={pt("chooseNote")}
                      value={query()}
                      onInput={(event) => setQuery(event.currentTarget.value)}
                    />
                    <div class="planner-note-results">
                      <For
                        each={props.service.state.notes
                          .filter(
                            (path) =>
                              path !== BINDINGS_PATH &&
                              !linkedNotes().includes(path) &&
                              path.toLocaleLowerCase().includes(query().toLocaleLowerCase()),
                          )
                          .slice(0, 20)}
                      >
                        {(path) => (
                          <button
                            type="button"
                            title={path}
                            disabled={busy()}
                            onClick={() =>
                              void perform(async () => {
                                const external = selectedExternal();
                                if (external) await props.service.attachNote(external, path);
                                setLinking(false);
                                setQuery("");
                              })
                            }
                          >
                            {noteName(path)}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </section>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
