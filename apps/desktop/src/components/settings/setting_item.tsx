import type { JSX } from "solid-js";

// ── Types ──

interface SettingItemProps {
  /** Setting label displayed prominently */
  label: string;
  /** Optional description text below the label */
  description?: string;
  /** Control element (toggle, input, dropdown, etc.) */
  children: JSX.Element;
}

// ── Component ──

/**
 * A single setting row with vertical layout: label → description → control.
 *
 * ```tsx
 * <SettingItem label="Font size" description="Base font size for the editor.">
 *   <input type="number" value={14} />
 * </SettingItem>
 * ```
 */
export default function SettingItem(props: SettingItemProps) {
  return (
    <div class="flex flex-col gap-1.5 py-3">
      <div class="flex flex-col gap-0.5">
        <span class="text-[0.8125rem] text-text-primary">{props.label}</span>
        {props.description && (
          <span class="text-xs/normal whitespace-pre-line text-text-muted">
            {props.description}
          </span>
        )}
      </div>
      <div>{props.children}</div>
    </div>
  );
}
