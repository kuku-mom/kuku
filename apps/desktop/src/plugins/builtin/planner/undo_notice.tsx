import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";

import { getActiveTab } from "~/stores/files";

import { pt } from "./messages";
import { PlannerGlyph } from "./icons";
import type { PlannerService } from "./service";
import { PlannerUndoError } from "./undo";
import { refreshTodayFeed } from "./today_feed";

export function UndoNotice(props: { service: PlannerService; keyboard?: boolean }) {
  const [error, setError] = createSignal("");
  const [dismissed, setDismissed] = createSignal("");
  createEffect(
    on(
      () => props.service.undo.entry()?.id,
      () => setError(""),
    ),
  );
  const undo = async () => {
    setDismissed("");
    setError("");
    try {
      await props.service.undo.undo();
      await refreshTodayFeed(props.service);
    } catch (error) {
      const code =
        error instanceof PlannerUndoError
          ? error.code
          : String(error).includes("CONFLICT")
            ? "changed"
            : "unavailable";
      setError(
        pt(
          code === "changed"
            ? "undoChanged"
            : code === "pending" || code === "busy"
              ? "undoPending"
              : code === "calendar"
                ? "undoCalendar"
                : "undoUnavailable",
        ),
      );
    }
  };
  onMount(() => {
    if (!props.keyboard) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "z" ||
        !props.service.undo.entry() ||
        props.service.undo.busy()
      )
        return;
      if (getActiveTab()?.type !== "planner") return;
      if (
        (event.target as HTMLElement | null)?.closest(
          'input, textarea, [contenteditable="true"], [role="textbox"], dialog',
        )
      )
        return;
      event.preventDefault();
      void undo();
    };
    window.addEventListener("keydown", keydown);
    onCleanup(() => window.removeEventListener("keydown", keydown));
  });
  return (
    <Show when={props.service.undo.entry()} keyed>
      {(entry) => (
        <Show when={dismissed() !== entry.id}>
          <div class="planner-undo-notice" role="status" aria-live="polite">
            <div>
              <span>{entry.label}</span>
              <Show when={entry.recreatesBlock}>
                <small>{pt("undoRecreates")}</small>
              </Show>
              <Show when={error()}>
                <small role="alert">{error()}</small>
              </Show>
            </div>
            <button type="button" disabled={props.service.undo.busy()} onClick={() => void undo()}>
              {pt("undo")}
            </button>
            <button type="button" aria-label={pt("close")} onClick={() => setDismissed(entry.id)}>
              <PlannerGlyph name="close" size={12} />
            </button>
          </div>
        </Show>
      )}
    </Show>
  );
}
