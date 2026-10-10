import { Show, createEffect, createSignal } from "solid-js";

import type { TaskMetadata } from "~/lib/planner_tasks";

import type { CalendarRange } from "./calendar_gestures";
import { addDays, dateTimeInput, localDate, localDateTimeToISO } from "./dates";
import { Modal, type PopoverAnchor, type ComposerContext } from "./dialog";
import { PlannerSelect } from "./controls";
import { DurationPresets } from "./duration_presets";
import { PlannerGlyph } from "./icons";
import { SlotSuggestions } from "./slot_suggestions";
import { taskPlanningDestination } from "./availability_context";
import { pt, providerName } from "./messages";
import type { PlannerService } from "./service";
import type { CalendarChoice, ExternalItem, ItemPatch } from "./types";

export function taskSourceOptions(value: string): {
  source?: { provider: "apple-reminders"; calendarId: string };
} {
  return value === "note" ? {} : { source: { provider: "apple-reminders", calendarId: value } };
}
export function TaskSourceSelect(props: {
  service: PlannerService;
  value: string;
  change: (value: string) => void;
  compact?: boolean;
}) {
  createEffect(() => {
    const source = props.service.state.sources["apple-reminders"];
    if (
      props.value !== "note" &&
      !source.loading &&
      (!props.service.state.preferences.enabledSources["apple-reminders"] ||
        !source.calendars.some((calendar) => calendar.id === props.value && calendar.writable))
    )
      props.change("note");
  });
  return (
    <div class="planner-field">
      <Show when={!props.compact}>
        <span>{pt("source")}</span>
      </Show>
      <PlannerSelect
        label={pt("source")}
        value={props.value}
        onChange={props.change}
        compact={props.compact}
        options={[
          { value: "note", label: pt("inbox"), description: pt("noteTasks") },
          ...props.service.state.sources["apple-reminders"].calendars
            .filter(
              (calendar) =>
                calendar.writable &&
                props.service.state.preferences.enabledSources["apple-reminders"],
            )
            .map((calendar) => ({
              value: calendar.id,
              label: calendar.title,
              description: providerName("apple-reminders"),
            })),
        ]}
      />
    </div>
  );
}
export function CalendarSelect(props: {
  service: PlannerService;
  value: string;
  change: (value: string) => void;
  allowLocal?: boolean;
  label?: string;
}) {
  const calendars = () =>
    (["google", "apple-calendar"] as const).flatMap((provider) =>
      props.service.state.preferences.enabledSources[provider] &&
      props.service.state.sources[provider].status.connected
        ? props.service
            .visibleCalendars(provider)
            .filter((calendar) => calendar.writable)
            .map((calendar) => ({ ...calendar, provider }))
        : [],
    );
  return (
    <PlannerSelect
      label={props.label ?? pt("calendar")}
      value={props.value}
      onChange={props.change}
      options={[
        { value: "", label: props.allowLocal ? pt("localOnly") : pt("chooseCalendar") },
        ...calendars().map((calendar) => ({
          value: JSON.stringify({ provider: calendar.provider, calendarId: calendar.id }),
          label: calendar.title,
          description: providerName(calendar.provider),
        })),
      ]}
    />
  );
}
function readRange(
  start: string,
  end: string,
  allDay: boolean,
  previous?: { start?: string; end?: string },
): CalendarRange {
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start)
      throw new Error(pt("invalidTime"));
    return { start, end: addDays(end, 1), allDay };
  }
  const a = localDateTimeToISO(start, previous?.start),
    b = localDateTimeToISO(end, previous?.end);
  if (!a || !b) throw new Error(pt("invalidLocalTime"));
  if (Date.parse(b) - Date.parse(a) < 15 * 60000) throw new Error(pt("invalidTime"));
  return { start: a, end: b, allDay };
}
function Fields(props: {
  title: string;
  setTitle: (value: string) => void;
  start: string;
  setStart: (value: string) => void;
  end: string;
  setEnd: (value: string) => void;
  allDay: boolean;
  setAllDay: (value: boolean) => void;
  location: string;
  setLocation: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  reminder?: boolean;
  task?: boolean;
  compact?: boolean;
  previousStart?: string;
  previousEnd?: string;
  onPresetEnd?: (value: string, iso: string) => void;
}) {
  return (
    <>
      <label class="planner-field">
        {pt("title")}
        <input
          autofocus
          required
          value={props.title}
          placeholder={props.compact ? pt("eventTitlePlaceholder") : undefined}
          onInput={(event) => props.setTitle(event.currentTarget.value)}
        />
      </label>
      <Show when={!props.reminder}>
        <Show when={!props.task}>
          <label class="planner-checkbox-field">
            <input
              type="checkbox"
              checked={props.allDay}
              onChange={(event) => props.setAllDay(event.currentTarget.checked)}
            />{" "}
            {pt("allDay")}
          </label>
        </Show>
        <div class="planner-form-grid">
          <label>
            {pt("start")}
            <input
              required
              type={props.allDay ? "date" : "datetime-local"}
              step="900"
              value={props.start}
              onInput={(event) => props.setStart(event.currentTarget.value)}
            />
          </label>
          <label>
            {pt("end")}
            <input
              required
              type={props.allDay ? "date" : "datetime-local"}
              step="900"
              value={props.end}
              onInput={(event) => props.setEnd(event.currentTarget.value)}
            />
          </label>
        </div>
        <Show when={!props.allDay}>
          <DurationPresets
            start={props.start}
            end={props.end}
            previousStart={props.previousStart}
            previousEnd={props.previousEnd}
            onEnd={(value, iso) =>
              props.onPresetEnd ? props.onPresetEnd(value, iso) : props.setEnd(value)
            }
          />
        </Show>
        <Show when={!props.task && !props.compact}>
          <label class="planner-field">
            {pt("location")}
            <input
              value={props.location}
              onInput={(event) => props.setLocation(event.currentTarget.value)}
            />
          </label>
          <label class="planner-field">
            {pt("details")}
            <textarea
              rows="3"
              value={props.description}
              onInput={(event) => props.setDescription(event.currentTarget.value)}
            />
          </label>
        </Show>
        <Show when={!props.task && props.compact}>
          <details class="planner-add-details">
            <summary>
              <PlannerGlyph name="chevron-right" size={12} class="planner-disclosure-chevron" />
              <span>{pt("addDetails")}</span>
            </summary>
            <label class="planner-field">
              {pt("location")}
              <input
                value={props.location}
                onInput={(event) => props.setLocation(event.currentTarget.value)}
              />
            </label>
            <label class="planner-field">
              {pt("details")}
              <textarea
                rows="2"
                value={props.description}
                onInput={(event) => props.setDescription(event.currentTarget.value)}
              />
            </label>
          </details>
        </Show>
      </Show>
    </>
  );
}
export function NewItemEditor(props: {
  service: PlannerService;
  range: CalendarRange;
  close: () => void;
  anchor?: PopoverAnchor;
  composer?: ComposerContext;
  initialSource?: string;
  onSourceChange?: (source: string) => void;
  preview?: (range: CalendarRange, title: string) => void;
}) {
  const [kind, setKind] = createSignal<"event" | "task">("event");
  const [source, setSource] = createSignal(props.initialSource ?? "note");
  const [title, setTitle] = createSignal("");
  const [allDay, setAllDay] = createSignal(props.range.allDay);
  const [start, setStart] = createSignal(
    props.range.allDay ? props.range.start : dateTimeInput(props.range.start),
  );
  const [end, setEnd] = createSignal(
    props.range.allDay ? addDays(props.range.end, -1) : dateTimeInput(props.range.end),
  );
  const [preferredEnd, setPreferredEnd] = createSignal(props.range.end);
  const [preferredStart, setPreferredStart] = createSignal(props.range.start);
  const [location, setLocation] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [calendar, setCalendar] = createSignal(
    props.service.state.preferences.defaultCalendar
      ? JSON.stringify(props.service.state.preferences.defaultCalendar)
      : "",
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => {
    try {
      props.preview?.(
        readRange(start(), end(), allDay(), { start: preferredStart(), end: preferredEnd() }),
        title(),
      );
    } catch {
      /* Keep the last valid selection while entering a date. */
    }
  });
  const toggleAllDay = (value: boolean) => {
    if (value) {
      setStart(start().slice(0, 10));
      setEnd(end().slice(0, 10));
    } else {
      setStart(`${start().slice(0, 10)}T09:00`);
      setEnd(`${end().slice(0, 10)}T09:30`);
    }
    setAllDay(value);
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError("");
    const before = new Set(props.service.state.operations.map((operation) => operation.id));
    try {
      const range = readRange(start(), end(), allDay(), {
        start: preferredStart(),
        end: preferredEnd(),
      });
      const selected = calendar()
        ? (JSON.parse(calendar()) as { provider: "google" | "apple-calendar"; calendarId: string })
        : null;
      if (kind() === "event") {
        if (!selected) throw new Error(pt("noWritableCalendar"));
        if (
          !props.service.state.preferences.selectedCalendars[selected.provider].includes(
            selected.calendarId,
          )
        ) {
          await props.service.selectCalendar(selected.provider, selected.calendarId, true);
        }
        await props.service.createItem(selected.provider, selected.calendarId, {
          title: title().trim(),
          ...range,
          location: location(),
          description: description(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      } else {
        if (range.allDay) throw new Error(pt("invalidTime"));
        // Explicitly selecting a destination also sets the destination for subsequent task drops.
        const current = props.service.state.preferences.defaultCalendar;
        if (JSON.stringify(current ?? null) !== JSON.stringify(selected))
          await props.service.setDefaultCalendar(selected);
        await props.service.addTask(title().trim(), {
          ...taskSourceOptions(source()),
          metadata: {
            scheduledStart: range.start,
            scheduledEnd: range.end,
            plannedDate: localDate(new Date(range.start)),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        });
      }
      props.close();
    } catch (error) {
      const captured = props.service.state.operations.some(
        (operation) => !before.has(operation.id) && operation.draft?.title === title().trim(),
      );
      if (captured) {
        props.service.report(error);
        props.close();
      } else setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={pt("newItem")}
      close={props.close}
      anchor={props.anchor}
      composer={props.composer}
    >
      <form onSubmit={(event) => void save(event)}>
        <div class="planner-kind-picker">
          <button type="button" aria-pressed={kind() === "event"} onClick={() => setKind("event")}>
            {pt("event")}
          </button>
          <button
            type="button"
            aria-pressed={kind() === "task"}
            onClick={() => {
              setKind("task");
              if (allDay()) toggleAllDay(false);
            }}
          >
            {pt("tasks")}
          </button>
        </div>
        <Show when={kind() === "task"}>
          <TaskSourceSelect
            service={props.service}
            value={source()}
            change={(value) => {
              setSource(value);
              props.onSourceChange?.(value);
            }}
          />
        </Show>
        <Fields
          title={title()}
          setTitle={setTitle}
          start={start()}
          setStart={setStart}
          end={end()}
          setEnd={setEnd}
          allDay={allDay()}
          setAllDay={(value) => {
            if (kind() === "event") toggleAllDay(value);
          }}
          location={location()}
          setLocation={setLocation}
          description={description()}
          setDescription={setDescription}
          task={kind() === "task"}
          compact={!!props.anchor}
          previousStart={preferredStart()}
          previousEnd={preferredEnd()}
          onPresetEnd={(value, iso) => {
            setEnd(value);
            setPreferredEnd(iso);
          }}
        />
        <SlotSuggestions
          service={props.service}
          start={start()}
          end={end()}
          allDay={allDay()}
          destination={calendar() ? (JSON.parse(calendar()) as CalendarChoice) : null}
          previousStart={preferredStart()}
          previousEnd={preferredEnd()}
          disabled={busy()}
          onSelect={(range) => {
            setStart(dateTimeInput(range.start));
            setEnd(dateTimeInput(range.end));
            setPreferredStart(range.start);
            setPreferredEnd(range.end);
          }}
        />
        <div class="planner-field">
          <span>{pt("calendar")}</span>
          <CalendarSelect
            service={props.service}
            value={calendar()}
            change={setCalendar}
            allowLocal={kind() === "task"}
          />
        </div>
        <Show when={!calendar() && kind() === "event"}>
          <p class="planner-muted">{pt("noWritableCalendar")}</p>
        </Show>
        <Show when={kind() === "task"}>
          <p class="planner-muted">{pt("timeHint")}</p>
        </Show>
        <Show when={error()}>
          <p class="planner-error" role="alert">
            {error()}
          </p>
        </Show>
        <footer>
          <Show when={props.anchor}>
            <small class="planner-composer-hint">{pt("enterToSave")}</small>
          </Show>
          <button type="button" onClick={props.close}>
            {pt("cancel")}
          </button>
          <button
            type="submit"
            class="planner-primary"
            disabled={busy() || !title().trim() || (kind() === "event" && !calendar())}
          >
            {busy() ? pt("saving") : pt("save")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ExternalItemForm(props: {
  service: PlannerService;
  item: ExternalItem;
  close: () => void;
}) {
  const reminder = props.item.kind === "reminder";
  const link = props.service.timeBlockForTask(props.item);
  const [title, setTitle] = createSignal(props.item.title);
  const [due, setDue] = createSignal(props.item.dueDate?.slice(0, 10) ?? "");
  const [completed, setCompleted] = createSignal(!!props.item.completed);
  const [allDay, setAllDay] = createSignal(props.item.allDay);
  const [start, setStart] = createSignal(
    reminder
      ? dateTimeInput(link?.start)
      : props.item.allDay
        ? (props.item.start ?? "")
        : dateTimeInput(props.item.start),
  );
  const [end, setEnd] = createSignal(
    reminder
      ? dateTimeInput(link?.end)
      : props.item.allDay && props.item.end
        ? addDays(props.item.end, -1)
        : dateTimeInput(props.item.end),
  );
  const [preferredEnd, setPreferredEnd] = createSignal(link?.end ?? props.item.end);
  const [preferredStart, setPreferredStart] = createSignal(link?.start ?? props.item.start);
  const [location, setLocation] = createSignal(props.item.location ?? "");
  const [description, setDescription] = createSignal(props.item.description ?? "");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [removeBlock, setRemoveBlock] = createSignal(true);
  const execute = async (work: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await work();
      props.close();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    execute(async () => {
      const patch: ItemPatch = {};
      if (title() !== props.item.title) patch.title = title().trim();
      if (reminder) {
        if (due() !== (props.item.dueDate?.slice(0, 10) ?? "")) patch.dueDate = due() || null;
        if (completed() !== !!props.item.completed) patch.completed = completed();
        const metadata: Partial<TaskMetadata> =
          start() || end()
            ? (() => {
                const range = readRange(start(), end(), false, {
                  start: preferredStart(),
                  end: preferredEnd(),
                });
                return {
                  scheduledStart: range.start,
                  scheduledEnd: range.end,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  plannedDate: localDate(new Date(range.start)),
                };
              })()
            : { scheduledStart: undefined, scheduledEnd: undefined };
        const changedTime =
          metadata.scheduledStart !== link?.start || metadata.scheduledEnd !== link?.end;
        if (Object.keys(patch).length || changedTime)
          await props.service.undo.updateReminder(
            props.item,
            patch,
            changedTime ? metadata : undefined,
            pt("editUndo"),
          );
      } else {
        const range = readRange(start(), end(), allDay(), {
          start: preferredStart(),
          end: preferredEnd(),
        });
        if (
          range.start !== props.item.start ||
          range.end !== props.item.end ||
          range.allDay !== props.item.allDay
        )
          Object.assign(patch, range, {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
        if (location() !== (props.item.location ?? "")) patch.location = location();
        if (description() !== (props.item.description ?? "")) patch.description = description();
        if (Object.keys(patch).length)
          await props.service.undo.updateItem(props.item, patch, pt("editUndo"));
      }
    });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Fields
        title={title()}
        setTitle={setTitle}
        start={start()}
        setStart={setStart}
        end={end()}
        setEnd={setEnd}
        allDay={allDay()}
        setAllDay={(value) => {
          if (value) {
            setStart(start().slice(0, 10));
            setEnd(end().slice(0, 10));
          } else {
            setStart(`${start().slice(0, 10)}T09:00`);
            setEnd(`${end().slice(0, 10)}T09:30`);
          }
          setAllDay(value);
        }}
        location={location()}
        setLocation={setLocation}
        description={description()}
        setDescription={setDescription}
        reminder={reminder}
        previousStart={preferredStart()}
        previousEnd={preferredEnd()}
        onPresetEnd={(value, iso) => {
          setEnd(value);
          setPreferredEnd(iso);
        }}
      />
      <Show when={reminder}>
        <label class="planner-checkbox-field">
          <input
            type="checkbox"
            checked={completed()}
            onChange={(event) => setCompleted(event.currentTarget.checked)}
          />{" "}
          {pt("completed")}
        </label>
        <label class="planner-field">
          {pt("dueDate")}
          <input type="date" value={due()} onInput={(event) => setDue(event.currentTarget.value)} />
        </label>
        <div class="planner-form-grid">
          <label>
            {pt("start")}
            <input
              type="datetime-local"
              step="900"
              value={start()}
              onInput={(event) => {
                setStart(event.currentTarget.value);
                if (event.currentTarget.value && !end()) {
                  const parsed = localDateTimeToISO(event.currentTarget.value);
                  if (parsed)
                    setEnd(dateTimeInput(new Date(Date.parse(parsed) + 1800000).toISOString()));
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
              onInput={(event) => setEnd(event.currentTarget.value)}
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
        <Show when={start()}>
          <button
            type="button"
            onClick={() => {
              setStart("");
              setEnd("");
            }}
          >
            {pt("removeBlock")}
          </button>
        </Show>
        <p class="planner-muted">{pt("timeHint")}</p>
      </Show>
      <SlotSuggestions
        service={props.service}
        start={start()}
        end={end()}
        allDay={!reminder && allDay()}
        previousStart={preferredStart()}
        previousEnd={preferredEnd()}
        exclude={props.item}
        destination={
          reminder
            ? taskPlanningDestination(props.service, props.item)
            : {
                provider: props.item.provider as CalendarChoice["provider"],
                calendarId: props.item.calendarId,
              }
        }
        disabled={busy()}
        onSelect={(range) => {
          setStart(dateTimeInput(range.start));
          setEnd(dateTimeInput(range.end));
          setPreferredStart(range.start);
          setPreferredEnd(range.end);
        }}
      />
      <Show when={deleting()}>
        <div class="planner-delete-confirm">
          <p>
            {props.item.kind === "event" && props.service.linkedTask(props.item)
              ? pt("blockDeleteHint")
              : pt("deleteQuestion")}
          </p>
          <Show when={reminder && link}>
            <label>
              <input
                type="checkbox"
                checked={removeBlock()}
                onChange={(event) => setRemoveBlock(event.currentTarget.checked)}
              />{" "}
              {pt("deleteLinkedBlock")}
            </label>
          </Show>
          <button
            type="button"
            disabled={busy()}
            onClick={() =>
              void execute(async () => {
                if (reminder && link && removeBlock())
                  await props.service.scheduleReminder(props.item, {
                    scheduledStart: undefined,
                    scheduledEnd: undefined,
                  });
                if (props.item.kind === "event" && props.service.linkedTask(props.item))
                  await props.service.undo.deleteBlock(props.item, pt("unscheduleUndo"));
                else await props.service.deleteItem(props.item);
              })
            }
          >
            {pt("delete")}
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <p class="planner-error" role="alert">
          {error()}
        </p>
      </Show>
      <footer>
        <button
          type="button"
          class="planner-danger-button"
          onClick={() => setDeleting(!deleting())}
        >
          {pt("delete")}
        </button>
        <button type="submit" disabled={busy() || !title().trim()} class="planner-primary">
          {busy() ? pt("saving") : pt("save")}
        </button>
      </footer>
    </form>
  );
}
