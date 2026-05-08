import { For, Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import type { SolidNodeViewProps } from "prosekit/solid";

import { executePluginCommand } from "~/plugins/commands";
import { editorState } from "~/stores/editor";

import type { KukuDecisionAttrs, KukuDecisionOption } from "../decision_markdown";
import {
  getVisibleKnowledgeEditorApplyState,
  resetKnowledgeEditorApplyState,
  type KnowledgeEditorApplyState,
} from "../editor_apply_state";
import type { ApplyDecisionDocumentResult, KnowledgeError } from "../types";

function KukuDecisionNode(props: SolidNodeViewProps) {
  const attrs = createMemo(() => normalizeAttrs(props.node.attrs));
  const [draftOtherText, setDraftOtherText] = createSignal(attrs().otherText ?? "");
  const selectedOptionId = createMemo(() => attrs().selectedOptionId ?? "");
  const readOnly = createMemo(() => attrs().status !== "pending");
  const missingSelection = createMemo(() => attrs().required && !selectedOptionId());
  const selectedRequiresInput = createMemo(() => {
    const selected = attrs().options.find((option) => option.id === selectedOptionId());
    return selected?.requires_input === true;
  });
  const missingOtherText = createMemo(
    () => selectedRequiresInput() && draftOtherText().trim() === "",
  );
  const applyState = createMemo(() => getVisibleKnowledgeEditorApplyState(editorState.filePath));

  createEffect(() => {
    const next = attrs().otherText ?? "";
    if (untrack(draftOtherText) !== next) {
      setDraftOtherText(next);
    }
  });

  function updateSelection(option: KukuDecisionOption): void {
    if (readOnly()) return;
    resetKnowledgeEditorApplyState(editorState.filePath);
    props.setAttrs({
      ...attrsWithDraftOtherText(),
      selectedOptionId: option.id,
    });
  }

  function updateOtherText(value: string): void {
    if (readOnly()) return;
    setDraftOtherText(value);
    resetKnowledgeEditorApplyState(editorState.filePath);
  }

  function commitOtherText(): void {
    if (readOnly()) return;
    const next = draftOtherText();
    if (next === (attrs().otherText ?? "")) return;
    props.setAttrs({
      ...attrsWithDraftOtherText(),
    });
  }

  function applyDocument(): void {
    commitOtherText();
    void executePluginCommand("knowledge.applyDecisionDocument");
  }

  function attrsWithDraftOtherText(): Record<string, unknown> {
    return {
      ...attrs(),
      otherText: draftOtherText() || null,
    };
  }

  return (
    <section
      contentEditable={false}
      data-kuku-decision-node=""
      data-invalid={missingSelection() || missingOtherText() ? "" : undefined}
      data-resolved={readOnly() ? "" : undefined}
    >
      <div data-kuku-decision-header="">
        <div data-kuku-decision-title="">
          <span>{attrs().question}</span>
          <span data-kuku-decision-status="">{attrs().status}</span>
        </div>
        <button
          disabled={applyState().status === "applying"}
          onClick={applyDocument}
          onMouseDown={(event) => event.preventDefault()}
          data-kuku-decision-apply=""
          data-status={applyState().status}
          type="button"
        >
          {applyButtonLabel(applyState())}
        </button>
      </div>

      <ApplyStateMessage state={applyState()} />

      <div data-kuku-decision-options="" role="radiogroup" aria-label={attrs().question}>
        <For each={attrs().options}>
          {(option) => (
            <button
              aria-checked={selectedOptionId() === option.id}
              disabled={readOnly()}
              onClick={() => updateSelection(option)}
              onMouseDown={(event) => event.preventDefault()}
              data-kuku-decision-option=""
              data-selected={selectedOptionId() === option.id ? "" : undefined}
              role="radio"
              type="button"
            >
              {option.label}
            </button>
          )}
        </For>
      </div>

      <Show when={selectedRequiresInput()}>
        <textarea
          disabled={readOnly()}
          onInput={(event) => updateOtherText(event.currentTarget.value)}
          onBlur={commitOtherText}
          placeholder="Revision note"
          value={draftOtherText()}
          data-kuku-decision-other=""
        />
      </Show>

      <Show when={missingSelection()}>
        <div data-kuku-decision-validation="">Selection required</div>
      </Show>
      <Show when={!missingSelection() && missingOtherText()}>
        <div data-kuku-decision-validation="">Revision note required</div>
      </Show>
    </section>
  );
}

function applyButtonLabel(state: KnowledgeEditorApplyState): string {
  if (state.status === "applying") return "Applying...";
  if (state.status === "applied") return "Applied";
  if (state.status === "error") return "Apply failed";
  return "Apply document";
}

function ApplyStateMessage(props: { state: KnowledgeEditorApplyState }) {
  const state = () => props.state;
  return (
    <Show when={state().status !== "idle"}>
      <div
        data-kuku-decision-apply-state=""
        data-status={state().status}
        role={state().status === "error" ? "alert" : "status"}
      >
        <Show when={state().status === "applying"}>Applying...</Show>
        <Show when={state().status === "applied"}>
          <ApplyResultSummary result={applyResult(state())} />
        </Show>
        <Show when={state().status === "error"}>
          <ApplyErrorSummary error={applyError(state())} />
        </Show>
      </div>
    </Show>
  );
}

function applyResult(state: KnowledgeEditorApplyState): ApplyDecisionDocumentResult | undefined {
  return state.status === "applied" ? state.result : undefined;
}

function applyError(state: KnowledgeEditorApplyState): KnowledgeError | undefined {
  return state.status === "error" ? state.error : undefined;
}

function ApplyResultSummary(props: { result?: ApplyDecisionDocumentResult }) {
  const result = () => props.result;
  const committedCount = () =>
    (result()?.committed_memory_paths.length ?? 0) + (result()?.committed_wiki_paths.length ?? 0);
  return (
    <Show when={result()}>
      {(value) => (
        <div>
          <span>{value().status}</span>
          <span> · committed {committedCount()}</span>
          <span> · rejected {value().rejected_decision_ids.length}</span>
          <span> · revision {value().needs_revision_decision_ids.length}</span>
          <Show when={value().journal_cleanup_required}>
            <span> · cleanup required</span>
          </Show>
        </div>
      )}
    </Show>
  );
}

function ApplyErrorSummary(props: { error?: KnowledgeError }) {
  const error = () => props.error;
  const summary = createMemo(() => {
    const value = error();
    return value ? formatApplyError(value) : undefined;
  });
  return (
    <Show when={error()}>
      {(value) => (
        <div>
          <div data-kuku-decision-apply-state-title="">{summary()?.title}</div>
          <div>{summary()?.message}</div>
          <div data-kuku-decision-apply-state-code="">{value().code}</div>
          <Show when={value().details}>
            <pre>{JSON.stringify(value().details, null, 2)}</pre>
          </Show>
        </div>
      )}
    </Show>
  );
}

function formatApplyError(error: KnowledgeError): { title: string; message: string } {
  if (error.code === "DOCUMENT_CHANGED") {
    if (error.message.includes("Wiki page changed before apply")) {
      return {
        title: "Target wiki page changed",
        message:
          "This update proposal is based on an older wiki page. Read the current wiki page and create a fresh update proposal before applying.",
      };
    }
    return {
      title: "Decision document changed",
      message: "Reload the decision document, review the current content, and apply again.",
    };
  }
  return {
    title: "Apply failed",
    message: error.message,
  };
}

function normalizeAttrs(attrs: Record<string, unknown>): KukuDecisionAttrs {
  return {
    id: typeof attrs.id === "string" ? attrs.id : "",
    proposalId: typeof attrs.proposalId === "string" ? attrs.proposalId : "",
    targetChangeId: typeof attrs.targetChangeId === "string" ? attrs.targetChangeId : "",
    question: typeof attrs.question === "string" ? attrs.question : "Remember this memory?",
    selectionMode: typeof attrs.selectionMode === "string" ? attrs.selectionMode : "single",
    required: typeof attrs.required === "boolean" ? attrs.required : true,
    status: typeof attrs.status === "string" ? attrs.status : "pending",
    selectedOptionId:
      typeof attrs.selectedOptionId === "string" ? attrs.selectedOptionId : undefined,
    options: Array.isArray(attrs.options) ? attrs.options.filter(isDecisionOption) : [],
    otherText: typeof attrs.otherText === "string" ? attrs.otherText : undefined,
    resolvedAt: typeof attrs.resolvedAt === "string" ? attrs.resolvedAt : undefined,
  };
}

function isDecisionOption(value: unknown): value is KukuDecisionOption {
  if (!value || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  return typeof option.id === "string" && typeof option.label === "string";
}

export default KukuDecisionNode;
export { applyButtonLabel, formatApplyError };
