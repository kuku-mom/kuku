import { Select as KSelect } from "@kobalte/core/select";
import { Show, createMemo, createSignal, onCleanup } from "solid-js";
import { PlannerGlyph } from "./icons";

export interface PlannerSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface PlannerSelectProps {
  options: PlannerSelectOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  placeholder?: string;
  compact?: boolean;
  iconOnly?: boolean;
}

/** Planner's single-choice field, including menus inside native dialog top layers. */
export function PlannerSelect(props: PlannerSelectProps) {
  const [open, setOpen] = createSignal(false);
  const [mount, setMount] = createSignal<HTMLElement>();
  let trigger: HTMLButtonElement | undefined;
  let layer: HTMLDivElement | undefined;
  const options = createMemo<PlannerSelectOption[]>((previous) => {
    const next = props.options.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      disabled: option.disabled,
    }));
    const unchanged =
      previous.length === next.length &&
      next.every((option, index) => {
        const old = previous[index];
        return (
          old.value === option.value &&
          old.label === option.label &&
          old.description === option.description &&
          old.disabled === option.disabled
        );
      });
    return unchanged ? previous : next;
  }, []);
  const selected = createMemo(
    () => options().find((option) => option.value === props.value) ?? null,
  );

  const changeOpen = (next: boolean) => {
    if (next) {
      const parent = trigger?.closest("dialog") ?? document.body;
      if (!layer) {
        // This Kobalte version uses an absolute positioner. Its fixed viewport
        // parent keeps positioning independent of the dialog's scroll surface.
        layer = document.createElement("div");
        layer.dataset.plannerSelectLayer = "";
        Object.assign(layer.style, {
          position: "fixed",
          inset: "0",
          pointerEvents: "none",
          zIndex: "10000",
        });
      }
      if (layer.parentElement !== parent) parent.append(layer);
      setMount(layer);
    }
    setOpen(next);
  };
  onCleanup(() => layer?.remove());

  return (
    <KSelect<PlannerSelectOption>
      class="planner-select"
      data-compact={props.compact ? "" : undefined}
      data-planner-select-open={open() ? "" : undefined}
      options={options()}
      optionValue="value"
      optionTextValue="label"
      optionDisabled="disabled"
      value={selected()}
      onChange={(option) => {
        if (option && !option.disabled && option.value !== props.value)
          props.onChange(option.value);
      }}
      open={open()}
      onOpenChange={changeOpen}
      disabled={props.disabled}
      placeholder={props.placeholder ?? props.label}
      closeOnSelection
      disallowEmptySelection
      shouldFocusWrap
      modal={false}
      preventScroll={false}
      placement="bottom-start"
      gutter={6}
      sameWidth={!props.iconOnly}
      flip
      slide
      fitViewport
      overflowPadding={8}
      itemComponent={(itemProps) => (
        <KSelect.Item item={itemProps.item} class="planner-select-item">
          <div>
            <KSelect.ItemLabel class="planner-select-label">
              {itemProps.item.rawValue.label}
            </KSelect.ItemLabel>
            <Show when={itemProps.item.rawValue.description}>
              <KSelect.ItemDescription class="planner-select-description">
                {itemProps.item.rawValue.description}
              </KSelect.ItemDescription>
            </Show>
          </div>
          <KSelect.ItemIndicator class="planner-select-check">
            <PlannerGlyph name="check" />
          </KSelect.ItemIndicator>
        </KSelect.Item>
      )}
    >
      <KSelect.Trigger
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={props.label}
        aria-autocomplete="none"
        title={props.iconOnly ? `${props.label}: ${selected()?.label ?? ""}` : undefined}
        data-icon-only={props.iconOnly ? "" : undefined}
        data-filtered={props.iconOnly && props.value !== "all" ? "" : undefined}
        class="planner-select-trigger"
        data-compact={props.compact ? "" : undefined}
        data-planner-select-open={open() ? "" : undefined}
      >
        <Show
          when={props.iconOnly}
          fallback={
            <>
              {" "}
              <KSelect.Value<PlannerSelectOption> class="planner-select-value">
                {(state) => state.selectedOption()?.label ?? props.placeholder ?? props.label}
              </KSelect.Value>
              <KSelect.Icon class="planner-select-chevron">
                <PlannerGlyph name="chevron-down" />
              </KSelect.Icon>
            </>
          }
        >
          <KSelect.Value<PlannerSelectOption> class="sr-only">
            {(state) => `${props.label}: ${state.selectedOption()?.label ?? ""}`}
          </KSelect.Value>
          <PlannerGlyph name="filter" size={15} />
        </Show>
      </KSelect.Trigger>
      <KSelect.Portal mount={mount()}>
        <KSelect.Content
          class="planner-select-content"
          data-planner-select-content=""
          style={{ "pointer-events": "auto" }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <KSelect.Listbox class="planner-select-list" />
        </KSelect.Content>
      </KSelect.Portal>
    </KSelect>
  );
}
