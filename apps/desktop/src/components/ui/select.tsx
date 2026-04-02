import { Select as KSelect } from "@kobalte/core/select";
import { Show } from "solid-js";

import ScrollArea from "~/components/scroll_area";

// ── Types ──

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  /** List of options */
  options: SelectOption[];
  /** Currently selected value */
  value?: string;
  /** Default value (uncontrolled) */
  defaultValue?: string;
  /** Called when selection changes */
  onChange?: (value: string) => void;
  /** Placeholder text when no value is selected */
  placeholder?: string;
  /** Whether the select is disabled */
  disabled?: boolean;
  /** Accessible label (visually hidden) */
  label?: string;
  /** Form field name */
  name?: string;
  /** Additional class on the root */
  class?: string;
}

// ── Icons ──

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// ── Component ──

/**
 * Dropdown select built on Kobalte's Select primitive.
 * Styled with Tailwind v4 `data-[highlighted]` / `data-[selected]` selectors.
 *
 * @example
 * ```tsx
 * <Select
 *   options={[
 *     { value: "en", label: "English" },
 *     { value: "ko", label: "한국어" },
 *   ]}
 *   value={lang()}
 *   onChange={setLang}
 *   placeholder="Select language"
 * />
 * ```
 */
export default function Select(props: SelectProps) {
  const selectedOption = () => props.options.find((o) => o.value === props.value);
  const defaultOption = () => props.options.find((o) => o.value === props.defaultValue);

  return (
    <KSelect<SelectOption>
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      optionDisabled="disabled"
      value={selectedOption()}
      defaultValue={defaultOption()}
      onChange={(opt) => {
        if (opt) props.onChange?.(opt.value);
      }}
      disabled={props.disabled}
      name={props.name}
      placeholder={props.placeholder}
      class={props.class}
      itemComponent={(itemProps) => (
        <KSelect.Item
          item={itemProps.item}
          class={[
            "flex h-8 cursor-pointer items-center justify-between gap-2 rounded-xs px-2.5 text-[0.8125rem] leading-normal text-text-primary outline-none",
            "transition-colors duration-75",
            "data-[highlighted]:bg-ghost-hover",
            "data-[disabled]:cursor-not-allowed data-[disabled]:text-text-disabled",
          ].join(" ")}
        >
          <KSelect.ItemLabel>{itemProps.item.rawValue.label}</KSelect.ItemLabel>
          <KSelect.ItemIndicator class="shrink-0 text-icon-accent">
            <CheckIcon />
          </KSelect.ItemIndicator>
        </KSelect.Item>
      )}
    >
      <Show when={props.label}>
        <KSelect.Label class="sr-only">{props.label}</KSelect.Label>
      </Show>

      <KSelect.Trigger
        class={[
          "flex h-8 w-full items-center justify-between gap-2 rounded-xs border border-border bg-bg-primary px-2.5 text-[0.8125rem] leading-normal text-text-primary outline-none",
          "transition-colors duration-100",
          "hover:border-border-focused",
          "focus-visible:border-border-focused",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        ].join(" ")}
      >
        <KSelect.Value<SelectOption> class="min-w-0 flex-1 truncate text-left">
          {(state) => state.selectedOption()?.label ?? props.placeholder}
        </KSelect.Value>
        <KSelect.Icon class="shrink-0 text-icon-muted">
          <ChevronDownIcon />
        </KSelect.Icon>
      </KSelect.Trigger>

      <KSelect.Portal>
        <KSelect.Content
          class={[
            "z-1000 min-w-[var(--kb-popper-anchor-width)] overflow-hidden rounded-xs border border-border bg-bg-secondary p-1",
            "shadow-[0_4px_16px_rgba(0,0,0,0.28),0_0_0_1px_rgba(0,0,0,0.06)]",
            "origin-[var(--kb-select-content-transform-origin)]",
          ].join(" ")}
        >
          <ScrollArea
            axis="y"
            style={{ "max-height": "15rem" }}
            options={{ scrollbars: { visibility: "hidden" } }}
          >
            <KSelect.Listbox class="outline-none" />
          </ScrollArea>
        </KSelect.Content>
      </KSelect.Portal>
    </KSelect>
  );
}

export type { SelectOption, SelectProps };
