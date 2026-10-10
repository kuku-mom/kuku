import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";

import { currentLocale } from "~/i18n";
import type { PlannerTask } from "~/lib/planner_tasks";

import {
  type CalendarGestures,
  type CalendarRange,
  type DragBlock,
  PIXELS_PER_MINUTE,
} from "./calendar_gestures";
import { calendarClock, calendarScrollTarget, initialCalendarScroll } from "./calendar_clock";
import { blockFor, calendarDays, dateFromKey, layoutSegments, localDate } from "./dates";
import { pt, providerName } from "./messages";
import { PlannerGlyph } from "./icons";
import type { PopoverAnchor } from "./dialog";
import type { PlannerService } from "./service";
import { externalKey, type ExternalItem } from "./types";
import { attachWeekPaging } from "./week_pager";
import { analyzeOverlap } from "./availability";

export const taskKey = (task: PlannerTask) => `task:${task.path}:${task.id}`;
export const eventKey = (item: ExternalItem) => `event:${externalKey(item)}`;
export const reminderKey = (item: ExternalItem) => `reminder:${externalKey(item)}`;
export function taskBlock(task: PlannerTask): DragBlock {
  const fallback = blockFor(localDate(), 0, 30);
  return {
    key: taskKey(task),
    title: task.title,
    start: task.metadata?.scheduledStart ?? fallback.scheduledStart!,
    end: task.metadata?.scheduledEnd ?? fallback.scheduledEnd!,
    allDay: false,
  };
}
export function reminderBlock(item: ExternalItem, service: PlannerService): DragBlock {
  const link = service.timeBlockForTask(item);
  const fallback = blockFor(localDate(), 0, 30);
  return {
    key: reminderKey(item),
    title: item.title,
    start: link?.start ?? fallback.scheduledStart!,
    end: link?.end ?? fallback.scheduledEnd!,
    allDay: false,
  };
}
export async function commitCalendarBlock(
  service: PlannerService,
  block: DragBlock,
  range: CalendarRange,
) {
  const task = service.state.tasks.find((value) => taskKey(value) === block.key);
  const metadata = {
    scheduledStart: range.start,
    scheduledEnd: range.end,
    plannedDate: localDate(new Date(range.start)),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  if (task) return service.undo.updateTask(task, { metadata }, pt("moveUndo"));
  const reminder = service.state.sources["apple-reminders"].items.find(
    (value) => reminderKey(value) === block.key,
  );
  if (reminder) return service.undo.scheduleReminder(reminder, metadata, pt("moveUndo"));
  const event = Object.values(service.state.sources)
    .flatMap((source) => source.items)
    .find((value) => eventKey(value) === block.key);
  if (event) return service.undo.updateItem(event, range, pt("moveUndo"));
  throw new Error("This item changed. Refresh and try again.");
}

interface DisplayBlock extends DragBlock {
  task?: PlannerTask;
  item?: ExternalItem;
  completed: boolean;
  writable: boolean;
  status?: string;
}
export function PlannerWeek(props: {
  service: PlannerService;
  anchor: string;
  visibleDays?: 1 | 3 | 7;
  gestures: CalendarGestures;
  edit: (task: PlannerTask) => void;
  external: (item: ExternalItem) => void;
  create: (range: CalendarRange, anchor?: PopoverAnchor) => void;
  draft?: CalendarRange & { title: string; key?: string };
  initialScrollTop?: number;
  onScrollPosition?: (top: number) => void;
  nowRequest?: number;
  navigateWeek?: (direction: -1 | 1) => void;
  pagingDisabled?: boolean;
  navigationRevision?: number;
}) {
  let root!: HTMLDivElement;
  let scroller!: HTMLDivElement;
  let headings!: HTMLDivElement;
  let allDay!: HTMLDivElement;
  let scrollFrame = 0;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let initialized = false;
  let pager: ReturnType<typeof attachWeekPaging> | undefined;
  const [swipeOffset, setSwipeOffset] = createSignal(0);
  const [paging, setPaging] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal("");
  const [now, setNow] = createSignal(new Date());
  const clock = createMemo(() => calendarClock(now()));
  const clockLabel = () =>
    now().toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
  const days = () => calendarDays(props.anchor, props.visibleDays);
  const pagingDisabled = () =>
    !props.navigateWeek ||
    !!props.pagingDisabled ||
    !!props.gestures.preview() ||
    !!props.gestures.lifted() ||
    !!props.gestures.busyKey();
  createEffect(() => {
    if (pagingDisabled()) pager?.cancel();
  });
  createEffect(
    on([() => props.navigationRevision, () => props.visibleDays], () => pager?.cancel(), {
      defer: true,
    }),
  );
  const preview = () => props.gestures.preview() ?? props.draft;
  const isManipulated = (block: DisplayBlock) => {
    const key = preview()?.key;
    if (!key) return false;
    if (key === block.key) return true;
    const task = block.item && props.service.linkedTask(block.item);
    return !!task && !("metadata" in task) && reminderKey(task) === key;
  };
  const external = () =>
    Object.values(props.service.state.sources)
      .flatMap((source) => source.items)
      .filter((item) => item.kind === "event");
  const blocks = createMemo<DisplayBlock[]>(() => {
    const local = props.service.state.tasks.filter(
      (task) => task.metadata?.scheduledStart && task.metadata.scheduledEnd,
    );
    const result: DisplayBlock[] = local.map((task) => ({
      ...taskBlock(task),
      task,
      completed: task.checked,
      writable: !task.checked,
      status: props.service.timeBlockForTask(task)?.status,
    }));
    for (const item of external()) {
      if (!item.start || !item.end) continue;
      const linked = props.service.linkedTask(item);
      if (
        linked &&
        "metadata" in linked &&
        local.some((task) => task.id === linked.id && task.path === linked.path)
      )
        continue;
      result.push({
        key: eventKey(item),
        title: item.title,
        start: item.start,
        end: item.end,
        allDay: item.allDay,
        item,
        completed: linked && !("metadata" in linked) ? !!linked.completed : false,
        writable: item.writable === true,
      });
    }
    return result;
  });
  const positions = createMemo(() =>
    Object.fromEntries(
      days().map((day) => [
        day,
        layoutSegments(
          blocks().filter((block) => !block.allDay),
          day,
        ),
      ]),
    ),
  );
  const blockOverlaps = createMemo(() =>
    Object.fromEntries(
      blocks()
        .filter((block) => !block.allDay)
        .map((block) => [block.key, analyzeOverlap(block, blocks(), [block.key])]),
    ),
  );
  const previewOverlap = createMemo(() =>
    preview() && !preview()!.allDay
      ? analyzeOverlap(
          preview()!,
          blocks().filter((block) => !isManipulated(block)),
        )
      : undefined,
  );
  const previewPositions = createMemo(() => {
    const candidate = preview();
    if (!candidate || candidate.allDay) return {};
    return Object.fromEntries(
      days().map((day) => [
        day,
        layoutSegments(
          [
            ...blocks().filter((block) => !block.allDay && !isManipulated(block)),
            { ...candidate, key: "drop-preview" },
          ],
          day,
        )["drop-preview"],
      ]),
    );
  });
  const rangeLabel = (range: CalendarRange) =>
    range.allDay
      ? pt("allDay")
      : `${new Date(range.start).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" })} – ${new Date(range.end).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" })}`;
  const open = (block: DisplayBlock) => {
    if (block.task) props.edit(block.task);
    else if (block.item) props.external(block.item);
  };
  const viewport = () => ({
    height: scroller.clientHeight,
    headerHeight: headings.offsetHeight + allDay.offsetHeight,
    scrollHeight: scroller.scrollHeight,
  });
  const rememberScroll = () => {
    if (!initialized) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => props.onScrollPosition?.(scroller.scrollTop), 120);
  };
  createEffect(
    on(
      () => props.nowRequest,
      () => {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => {
          setNow(new Date());
          if (!days().includes(clock().day)) return;
          scroller.scrollTo({
            top: calendarScrollTarget(clock().minute, viewport(), PIXELS_PER_MINUTE),
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "instant"
              : "smooth",
          });
        });
      },
      { defer: true },
    ),
  );
  onMount(() => {
    props.gestures.register(root, scroller);
    pager = attachWeekPaging({
      host: root,
      scroller,
      disabled: pagingDisabled,
      navigate(direction) {
        props.navigateWeek?.(direction);
        const first = dateFromKey(days()[0]).toLocaleDateString(currentLocale(), {
          month: "long",
          day: "numeric",
        });
        setAnnouncement(`${pt(direction > 0 ? "nextWeek" : "previousWeek")} · ${first}`);
      },
      onOffset: setSwipeOffset,
      onPaging: setPaging,
    });
    scrollFrame = requestAnimationFrame(() => {
      scroller.scrollTop = initialCalendarScroll(
        days(),
        now(),
        props.initialScrollTop,
        viewport(),
        PIXELS_PER_MINUTE,
      );
      initialized = true;
      rememberScroll();
    });
    const updateClock = () => setNow(new Date());
    const timer = setInterval(updateClock, 60_000);
    window.addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateClock);
    onCleanup(() => {
      pager?.dispose();
      clearInterval(timer);
      clearTimeout(scrollTimer);
      cancelAnimationFrame(scrollFrame);
      window.removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateClock);
      if (initialized) props.onScrollPosition?.(scroller.scrollTop);
    });
  });
  return (
    <div
      class="planner-week"
      ref={root}
      data-planner-visible-days={props.visibleDays ?? 7}
      data-week-paging={paging() ? "" : undefined}
      style={{ "--planner-day-count": props.visibleDays ?? 7 }}
    >
      <div class="planner-week-scroll" ref={scroller} onScroll={rememberScroll}>
        <div class="planner-week-inner">
          <div class="planner-day-headings" ref={headings}>
            <div class="planner-timezone">
              {Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop()}
            </div>
            <For each={days()}>
              {(day) => (
                <div classList={{ "planner-is-today": day === clock().day }}>
                  <span>
                    {dateFromKey(day).toLocaleDateString(currentLocale(), { weekday: "short" })}
                  </span>
                  <strong>{dateFromKey(day).getDate()}</strong>
                </div>
              )}
            </For>
          </div>
          <div class="planner-all-day" data-planner-all-day-row ref={allDay}>
            <small>{pt("allDay")}</small>
            <For each={days()}>
              {(day) => (
                <div
                  onClick={(event) => {
                    if (event.target === event.currentTarget)
                      props.create(
                        {
                          start: day,
                          end: localDate(
                            new Date(
                              dateFromKey(day).getFullYear(),
                              dateFromKey(day).getMonth(),
                              dateFromKey(day).getDate() + 1,
                            ),
                          ),
                          allDay: true,
                        },
                        { x: event.clientX, y: event.clientY },
                      );
                  }}
                >
                  <For
                    each={blocks().filter(
                      (block) => block.allDay && block.start <= day && block.end > day,
                    )}
                  >
                    {(block) => (
                      <button
                        type="button"
                        class="planner-all-day-event"
                        data-planner-key={block.key}
                        data-planner-drag-source
                        classList={{
                          "planner-block-dragging": isManipulated(block),
                          "planner-block-readonly": !block.writable,
                        }}
                        onPointerDown={(event) => {
                          if (block.writable) props.gestures.begin(event, "move", block);
                        }}
                        onClick={() => open(block)}
                      >
                        {block.title}
                      </button>
                    )}
                  </For>
                  <Show when={preview()?.allDay && preview()!.start <= day && preview()!.end > day}>
                    <div
                      class="planner-drag-preview planner-all-day-preview"
                      data-planner-drop-preview
                      data-planner-day={day}
                      data-planner-key={preview()?.key}
                    >
                      {preview()!.title || pt("newItem")}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <div class="planner-time-grid">
            <div class="planner-hours">
              <For each={Array.from({ length: 24 }, (_, i) => i)}>
                {(hour) => (
                  <span style={{ top: `${hour * 60 * PIXELS_PER_MINUTE}px` }}>
                    {String(hour).padStart(2, "0")}:00
                  </span>
                )}
              </For>
            </div>
            <For each={days()}>
              {(day) => (
                <div
                  class="planner-day-column"
                  data-planner-day={day}
                  classList={{ "planner-is-today": day === clock().day }}
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) props.gestures.begin(event, "create");
                  }}
                >
                  <Show when={day === clock().day}>
                    <div
                      class="planner-now-line"
                      aria-label={`${pt("currentTime")} ${clockLabel()}`}
                      role="img"
                      style={{ top: `${clock().minute * PIXELS_PER_MINUTE}px` }}
                    >
                      <time class="planner-now-label" dateTime={now().toISOString()}>
                        {clockLabel()}
                      </time>
                    </div>
                  </Show>
                  <For each={blocks().filter((block) => !block.allDay)}>
                    {(block) => {
                      const position = () => positions()[day]?.[block.key];
                      return (
                        <Show when={position()}>
                          <div
                            class="planner-block"
                            data-planner-key={block.key}
                            data-planner-drag-source
                            classList={{
                              "planner-task-block":
                                !!block.task ||
                                !!(block.item && props.service.linkedTask(block.item)),
                              "planner-event-block": !block.task,
                              "planner-is-complete": block.completed,
                              "planner-block-pending": !!block.status && block.status !== "synced",
                              "planner-block-dragging": isManipulated(block),
                              "planner-block-readonly": !block.writable,
                              "planner-block-compact": (position()?.height ?? 0) <= 30,
                              "planner-block-overlap":
                                (blockOverlaps()[block.key]?.minutes ?? 0) > 0,
                            }}
                            style={{
                              top: `${position()!.top * PIXELS_PER_MINUTE}px`,
                              height: `${Math.max(15, position()!.height) * PIXELS_PER_MINUTE}px`,
                              left: `calc(${position()!.left * 100}% + 2px)`,
                              width: `calc(${position()!.width * 100}% - 4px)`,
                            }}
                          >
                            <button
                              type="button"
                              class="planner-block-body"
                              title={`${block.title}${block.writable ? "" : ` · ${pt("readOnly")}`}${blockOverlaps()[block.key]?.minutes ? ` · ${Math.ceil(blockOverlaps()[block.key].minutes)}${pt("minutes")} ${pt("timeOverlap")}` : ""}`}
                              onPointerDown={(event) => {
                                if (block.writable) props.gestures.begin(event, "move", block);
                              }}
                              onClick={() => open(block)}
                            >
                              <Show when={(blockOverlaps()[block.key]?.minutes ?? 0) > 0}>
                                <span class="planner-block-overlap-mark" aria-hidden="true">
                                  <PlannerGlyph name="alert" size={11} />
                                </span>
                              </Show>
                              <b>{block.title}</b>
                              <span>
                                {new Date(block.start).toLocaleTimeString(currentLocale(), {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                                {block.item ? ` · ${providerName(block.item.provider)}` : ""}
                              </span>
                              <Show when={block.status && block.status !== "synced"}>
                                <small>
                                  {block.status === "pending" ? pt("saving") : pt("pendingChanges")}
                                </small>
                              </Show>
                            </button>
                            <Show when={block.writable && localDate(new Date(block.start)) === day}>
                              <button
                                type="button"
                                class="planner-resize planner-resize-top"
                                aria-label={pt("resizeStart")}
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                  props.gestures.begin(event, "start", block);
                                }}
                              />
                            </Show>
                            <Show when={block.writable && localDate(new Date(block.end)) === day}>
                              <button
                                type="button"
                                class="planner-resize"
                                aria-label={pt("resizeEnd")}
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                  props.gestures.begin(event, "end", block);
                                }}
                              />
                            </Show>
                          </div>
                        </Show>
                      );
                    }}
                  </For>
                  <Show when={preview() && !preview()!.allDay}>
                    {(_visible) => {
                      const segment = () => {
                        return previewPositions()[day];
                      };
                      return (
                        <Show when={segment()}>
                          <div
                            class="planner-drag-preview"
                            data-planner-drop-preview
                            data-planner-day={day}
                            data-planner-key={preview()?.key}
                            classList={{
                              "planner-preview-saving": !!props.gestures.busyKey(),
                              "planner-preview-draft": !!props.draft && !props.gestures.preview(),
                              "planner-preview-carry":
                                props.gestures.lifted()?.overCalendar &&
                                props.gestures.lifted()?.phase === "dragging",
                            }}
                            style={{
                              top: `${segment()!.top * PIXELS_PER_MINUTE}px`,
                              height: `${segment()!.height * PIXELS_PER_MINUTE}px`,
                              left: `calc(${segment()!.left * 100}% + 2px)`,
                              width: `calc(${segment()!.width * 100}% - 4px)`,
                            }}
                          >
                            <b>{preview()?.title || pt("newItem")}</b>
                            <span class="planner-drag-time">
                              {rangeLabel(preview()!)}
                              <Show when={props.gestures.busyKey()}> · {pt("saving")}</Show>
                            </span>
                          </div>
                        </Show>
                      );
                    }}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
      <Show when={Math.abs(swipeOffset()) > 10}>
        <div
          class="planner-week-cue"
          data-direction={swipeOffset() < 0 ? "next" : "previous"}
          aria-hidden="true"
          style={{ opacity: Math.min(1, Math.abs(swipeOffset()) / 56) }}
        >
          <PlannerGlyph name={swipeOffset() < 0 ? "chevron-right" : "chevron-left"} />
          <span>{pt(swipeOffset() < 0 ? "nextWeek" : "previousWeek")}</span>
        </div>
      </Show>
      <span class="planner-screen-reader" role="status" aria-live="polite" aria-atomic="true">
        {announcement()}
      </span>
      <footer class="planner-grid-hint">
        <Show
          when={(previewOverlap()?.minutes ?? 0) > 0}
          fallback={<span>{pt("createHint")}</span>}
        >
          <span
            class="planner-drag-overlap"
            title={previewOverlap()
              ?.items.map((item) => item.title)
              .join(", ")}
          >
            <PlannerGlyph name="alert" size={12} />
            {Math.ceil(previewOverlap()!.minutes)}
            {pt("minutes")} {pt("timeOverlap")} ·{" "}
            {previewOverlap()
              ?.items.map((item) => item.title)
              .join(", ")}
          </span>
        </Show>
        <Show when={props.navigateWeek}>
          <span class="planner-week-swipe-hint">{pt("weekSwipeHint")}</span>
        </Show>
      </footer>
      <Portal>
        <Show when={props.gestures.lifted()}>
          {(lifted) => (
            <div
              class="planner-floating-origin"
              classList={{ "planner-floating-settling": lifted().phase === "settling" }}
              aria-hidden="true"
              style={{
                transform: `translate3d(${lifted().x}px, ${lifted().y}px, 0)`,
              }}
            >
              <div
                class="planner-floating-card"
                classList={{
                  "planner-floating-in-calendar": lifted().overCalendar,
                  "planner-floating-compact": lifted().overCalendar && lifted().height <= 30,
                }}
                data-over-calendar={lifted().overCalendar ? "true" : "false"}
                style={{
                  transform: `translate3d(${-lifted().offsetX}px, ${-lifted().offsetY}px, 0)`,
                  width: `${lifted().width}px`,
                  height: `${lifted().height}px`,
                }}
              >
                <b>{lifted().title}</b>
                <Show when={preview()}>
                  <span>{rangeLabel(preview()!)}</span>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Portal>
    </div>
  );
}
