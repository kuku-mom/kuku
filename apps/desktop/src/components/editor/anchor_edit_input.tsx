import { createEffect, createSignal, For, Show } from "solid-js";

import { CloseIcon, LinkIcon } from "~/components/icons";
import { computeFloatingOverlayPosition } from "~/components/editor/floating_overlay_position";
import ScrollArea from "~/components/scroll_area";
import type {
  AnchorEditSuggestItem,
  AnchorEditTarget,
  AnchorEditValues,
} from "~/plugins/anchor_editors";

interface AnchorEditInputProps {
  target: AnchorEditTarget;
  autoFocus?: boolean;
  viewportEl?: HTMLElement;
  onApply: (values: AnchorEditValues) => void;
  onPinnedChange?: (pinned: boolean) => void;
  onClose: () => void;
}

interface AnchorPosition {
  top: number;
  left: number;
  width: number;
}

function computeAnchorPosition(
  rect: DOMRect,
  containerEl: HTMLElement,
  viewportEl: HTMLElement | undefined,
  width: number,
  height: number,
): AnchorPosition {
  const position = computeFloatingOverlayPosition({
    anchorRect: rect,
    containerRect: containerEl.getBoundingClientRect(),
    viewportRect: (viewportEl ?? containerEl).getBoundingClientRect(),
    overlayWidth: width,
    overlayHeight: height,
    verticalOffset: 10,
  });

  return { top: position.top, left: position.left, width: position.width };
}

export default function AnchorEditInput(props: AnchorEditInputProps) {
  let containerRef: HTMLDivElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  let firstInputRef: HTMLInputElement | undefined;
  let syncedTargetId: string | null = null;
  let focusedTargetId: string | null = null;
  const width = () => props.target.width ?? (props.target.fields.length > 1 ? 360 : 320);

  const [values, setValues] = createSignal<AnchorEditValues>({});
  const [position, setPosition] = createSignal({ top: 0, left: 0, width: width() });

  // ── Suggest state ──
  const [focusedFieldKey, setFocusedFieldKey] = createSignal<string | null>(null);
  const [suggestItems, setSuggestItems] = createSignal<AnchorEditSuggestItem[]>([]);
  const [suggestSelectedIndex, setSuggestSelectedIndex] = createSignal(0);
  const suggestItemRefs: (HTMLButtonElement | undefined)[] = [];

  createEffect(() => {
    const target = props.target;
    if (target.id === syncedTargetId) return;
    syncedTargetId = target.id;
    setValues(Object.fromEntries(target.fields.map((field) => [field.key, field.value])));
  });

  createEffect(() => {
    const host = containerRef?.parentElement;
    if (!host) return;
    const suggestCount = suggestItems().length;
    const hasFocusedField = focusedFieldKey();

    requestAnimationFrame(() => {
      const nextHost = containerRef?.parentElement;
      if (!nextHost) return;

      const baseHeight = panelRef?.offsetHeight ?? 160;
      const suggestHeight =
        hasFocusedField && suggestCount > 0 ? Math.min(160, suggestCount * 28) + 8 : 0;

      setPosition(
        computeAnchorPosition(
          props.target.rect,
          nextHost,
          props.viewportEl,
          width(),
          baseHeight + suggestHeight,
        ),
      );
    });
  });

  createEffect(() => {
    const targetId = props.target.id;
    if (!props.autoFocus || targetId === focusedTargetId) return;
    focusedTargetId = targetId;

    requestAnimationFrame(() => {
      firstInputRef?.focus();
      firstInputRef?.select();
    });
  });

  // Recompute suggestions when values or focused field changes.
  createEffect(() => {
    const key = focusedFieldKey();
    if (!key) {
      setSuggestItems([]);
      return;
    }

    const field = props.target.fields.find((f) => f.key === key);
    if (!field?.suggest) {
      setSuggestItems([]);
      return;
    }

    const query = values()[key] ?? "";
    const items = field.suggest(query);
    setSuggestItems(items);
    setSuggestSelectedIndex(0);
  });

  // Keep refs array in sync.
  createEffect(() => {
    suggestItemRefs.length = suggestItems().length;
  });

  // Auto-scroll selected suggest item into view.
  createEffect(() => {
    const idx = suggestSelectedIndex();
    const items = suggestItems();
    if (idx < 0 || idx >= items.length) return;

    requestAnimationFrame(() => {
      const el = suggestItemRefs[idx];
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  function handleFocusIn(): void {
    props.onPinnedChange?.(true);
  }

  function handleFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (!next || !containerRef?.contains(next)) {
      props.onPinnedChange?.(false);
      setFocusedFieldKey(null);
    }
  }

  function updateValue(key: string, value: string): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function selectSuggestion(key: string, item: AnchorEditSuggestItem): void {
    updateValue(key, item.value);
    setFocusedFieldKey(null);
  }

  function submit(): void {
    props.onApply(values());
  }

  function handleFieldFocus(key: string): void {
    setFocusedFieldKey(key);
  }

  function handleFieldBlur(key: string, e: FocusEvent): void {
    // Keep suggest open if focus moves to another element within the container
    // (e.g. clicking a suggestion button).
    const next = e.relatedTarget as Node | null;
    if (next && containerRef?.contains(next)) return;
    if (focusedFieldKey() === key) {
      setFocusedFieldKey(null);
    }
  }

  function handleKeyDown(e: KeyboardEvent, fieldKey: string): void {
    e.stopPropagation();

    // ── Suggest-aware keyboard handling ──
    const field = props.target.fields.find((f) => f.key === fieldKey);
    const suggestActive =
      Boolean(field?.suggest) && focusedFieldKey() === fieldKey && suggestItems().length > 0;

    if (suggestActive) {
      const items = suggestItems();

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSuggestSelectedIndex((current) => Math.min(current + 1, items.length - 1));
          return;
        case "ArrowUp":
          e.preventDefault();
          setSuggestSelectedIndex((current) => Math.max(current - 1, 0));
          return;
        case "Enter":
        case "Tab": {
          const item = items[suggestSelectedIndex()];
          if (item) {
            e.preventDefault();
            selectSuggestion(fieldKey, item);
            return;
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          setFocusedFieldKey(null);
          return;
      }
    }

    // ── Default keyboard handling ──
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      props.onPinnedChange?.(false);
      props.onClose();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const pos = () => position();

  return (
    <div
      ref={containerRef}
      class="pointer-events-none absolute inset-0 z-50"
      style={{ overflow: "visible" }}
    >
      <div
        ref={panelRef}
        data-link-editor=""
        class="pointer-events-auto absolute rounded-sm border border-border bg-bg-elevated p-2 shadow-popover"
        style={{
          top: `${pos().top}px`,
          left: `${pos().left}px`,
          width: `${pos().width}px`,
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
        }}
        onFocusIn={handleFocusIn}
        onFocusOut={handleFocusOut}
      >
        <div class="mb-2 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-[0.75rem] text-text-secondary">
            <LinkIcon size={13} />
            <span>{props.target.title}</span>
          </div>
          <button
            type="button"
            class="flex size-5 items-center justify-center rounded-xs border-none bg-transparent p-0 text-text-muted hover:bg-ghost-hover hover:text-text-primary"
            onClick={() => {
              props.onPinnedChange?.(false);
              props.onClose();
            }}
          >
            <CloseIcon size={10} />
          </button>
        </div>

        <div class="space-y-2">
          <For each={props.target.fields}>
            {(field, index) => {
              const showSuggest = () =>
                Boolean(field.suggest) &&
                focusedFieldKey() === field.key &&
                suggestItems().length > 0;

              return (
                <>
                  <label class="block text-[0.6875rem] tracking-[0.08em] text-text-muted uppercase">
                    {field.label}
                  </label>
                  <div class="relative">
                    <input
                      ref={(el) => {
                        if (index() === 0) {
                          firstInputRef = el;
                        }
                      }}
                      type="text"
                      class="w-full rounded-xs border border-border bg-bg-primary px-2 py-1.5 text-[0.8125rem] text-text-primary outline-none focus:border-border-selected"
                      value={values()[field.key] ?? ""}
                      onInput={(e) => updateValue(field.key, e.currentTarget.value)}
                      onFocus={() => handleFieldFocus(field.key)}
                      onFocusOut={(e) => handleFieldBlur(field.key, e)}
                      onKeyDown={(e) => handleKeyDown(e, field.key)}
                      placeholder={field.placeholder}
                      autocomplete="off"
                    />
                    <Show when={showSuggest()}>
                      <div class="absolute inset-x-0 top-full z-10 mt-1 rounded-xs border border-border bg-bg-elevated shadow-soft-2">
                        <ScrollArea axis="y" class="max-h-40 py-0.5">
                          <For each={suggestItems()}>
                            {(item, idx) => {
                              const selected = () => suggestSelectedIndex() === idx();

                              return (
                                <button
                                  ref={(el) => {
                                    suggestItemRefs[idx()] = el;
                                  }}
                                  type="button"
                                  tabIndex={-1}
                                  class="flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left transition-colors outline-none"
                                  classList={{
                                    "bg-ghost-hover": selected(),
                                  }}
                                  onMouseEnter={() => setSuggestSelectedIndex(idx())}
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    selectSuggestion(field.key, item);
                                  }}
                                >
                                  <span class="flex size-4 shrink-0 items-center justify-center text-text-muted">
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      stroke="currentColor"
                                      stroke-width="1.5"
                                      stroke-linecap="round"
                                      stroke-linejoin="round"
                                    >
                                      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2Z" />
                                      <path d="M9 2v4h4" />
                                    </svg>
                                  </span>
                                  <span class="min-w-0 flex-1 truncate">
                                    <span class="text-[0.75rem] text-text-primary">
                                      {item.label}
                                    </span>
                                    <Show when={item.description}>
                                      {(desc) => (
                                        <span class="ml-1 text-[0.625rem] text-text-muted">
                                          {desc()}
                                        </span>
                                      )}
                                    </Show>
                                  </span>
                                </button>
                              );
                            }}
                          </For>
                        </ScrollArea>
                      </div>
                    </Show>
                  </div>
                </>
              );
            }}
          </For>
        </div>

        <div class="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-xs border border-border bg-transparent px-2 py-1 text-[0.75rem] text-text-secondary hover:bg-ghost-hover hover:text-text-primary"
            onClick={() => {
              props.onPinnedChange?.(false);
              props.onClose();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-xs border border-border bg-element px-2 py-1 text-[0.75rem] text-text-primary hover:bg-element-hover"
            onClick={submit}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
