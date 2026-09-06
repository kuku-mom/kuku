import { Show, createSignal, onMount } from "solid-js";

import { currentLocale } from "~/i18n";

import { Modal } from "./dialog";
import { pt } from "./messages";
import { providers } from "./providers";
import type { PlannerService } from "./service";
import type { ExternalItem, PendingOperation, TimeBlockLink } from "./types";

export function OperationReview(props: {
  service: PlannerService;
  operation: PendingOperation;
  close: () => void;
}) {
  const [latest, setLatest] = createSignal<ExternalItem | null>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(true);
  onMount(() => {
    const ref = props.operation.eventRef;
    if (!ref) {
      setBusy(false);
      return;
    }
    providers
      .get(ref)
      .then(setLatest)
      .catch((error) => setError(String(error)))
      .finally(() => setBusy(false));
  });
  const value = (input: string | undefined) =>
    input && input.includes("T") ? new Date(input).toLocaleString(currentLocale()) : input || "—";
  return (
    <Modal title={pt("retryConflict")} close={props.close}>
      <p class="planner-muted">{props.operation.error}</p>
      <Show when={!busy()} fallback={<p>{pt("loading")}</p>}>
        <div class="planner-form-grid">
          <section>
            <h3>{pt("latestChanges")}</h3>
            <p>{latest()?.title ?? "—"}</p>
            <p>{value(latest()?.start)}</p>
            <p>{value(latest()?.end)}</p>
            <p>{latest()?.dueDate}</p>
          </section>
          <section>
            <h3>{pt("yourChanges")}</h3>
            <p>{props.operation.patch?.title ?? props.operation.draft?.title ?? latest()?.title}</p>
            <p>
              {value(
                props.operation.patch?.start ?? props.operation.draft?.start ?? latest()?.start,
              )}
            </p>
            <p>
              {value(props.operation.patch?.end ?? props.operation.draft?.end ?? latest()?.end)}
            </p>
            <p>{props.operation.patch?.dueDate}</p>
          </section>
        </div>
        <footer>
          <button type="button" onClick={props.close}>
            {pt("cancel")}
          </button>
          <button
            type="button"
            class="planner-primary"
            disabled={!!error() || !latest()}
            onClick={() => {
              setBusy(true);
              props.service
                .retryOperation(props.operation.id, latest()?.writeRef?.version)
                .then(props.close)
                .catch((error) => setError(String(error)))
                .finally(() => setBusy(false));
            }}
          >
            {pt("reapply")}
          </button>
        </footer>
      </Show>
      <Show when={error()}>
        <p class="planner-error" role="alert">
          {error()}
        </p>
      </Show>
    </Modal>
  );
}

export function LinkConflictReview(props: {
  service: PlannerService;
  link: TimeBlockLink;
  close: () => void;
}) {
  const [latest, setLatest] = createSignal<ExternalItem | null>();
  const [task, setTask] = createSignal<{ title: string; start?: string; end?: string }>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(true);
  onMount(() => {
    void (async () => {
      try {
        setLatest(await providers.get(props.link.eventRef));
        if (props.link.task.kind === "note") {
          const id = props.link.task.taskId;
          const entries = props.service.state.tasks.filter((entry) => entry.metadata?.id === id);
          if (entries.length !== 1) throw new Error(pt("missingTask"));
          setTask({
            title: entries[0].title,
            start: entries[0].metadata?.scheduledStart,
            end: entries[0].metadata?.scheduledEnd,
          });
        } else {
          const source = await providers.get(props.link.task.eventRef);
          if (!source) throw new Error(pt("missingTask"));
          setTask({ title: source.title, start: props.link.start, end: props.link.end });
        }
      } catch (failure) {
        setError(String(failure));
      } finally {
        setBusy(false);
      }
    })();
  });
  const value = (input?: string) => (input ? new Date(input).toLocaleString(currentLocale()) : "—");
  const resolve = async (choice: "task" | "event") => {
    setBusy(true);
    setError("");
    try {
      await props.service.resolveLink(props.link.id, choice, latest()?.writeRef?.version, task());
      props.close();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={pt("retryConflict")} close={props.close}>
      <p class="planner-muted">{props.link.error}</p>
      <Show when={!busy()} fallback={<p>{pt("loading")}</p>}>
        <div class="planner-form-grid">
          <section>
            <h3>{pt("latestChanges")}</h3>
            <p>{latest()?.title ?? pt("deletedEvent")}</p>
            <p>{value(latest()?.start)}</p>
            <p>{value(latest()?.end)}</p>
          </section>
          <section>
            <h3>{pt("yourChanges")}</h3>
            <p>{task()?.title}</p>
            <p>{value(task()?.start)}</p>
            <p>{value(task()?.end)}</p>
          </section>
        </div>
        <footer>
          <button type="button" onClick={props.close}>
            {pt("cancel")}
          </button>
          <button
            type="button"
            disabled={!!error() || !task()}
            onClick={() => void resolve("event")}
          >
            {pt("useCalendar")}
          </button>
          <button
            type="button"
            class="planner-primary"
            disabled={!!error() || !task()?.start}
            onClick={() => void resolve("task")}
          >
            {pt("useTask")}
          </button>
        </footer>
      </Show>
      <Show when={error()}>
        <p class="planner-error" role="alert">
          {error()}
        </p>
      </Show>
    </Modal>
  );
}
