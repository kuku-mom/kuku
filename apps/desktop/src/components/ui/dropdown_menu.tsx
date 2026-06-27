import { DropdownMenu as KMenu } from "@kobalte/core/dropdown-menu";
import { type JSX, Show, splitProps } from "solid-js";

import { formatShortcutSymbols } from "~/lib/platform";

// ── Styled Sub-components ──

/**
 * Root container for the dropdown menu.
 * Controls open/close state and nesting.
 *
 * @example
 * ```tsx
 * <DropdownMenu>
 *   <DropdownMenuTrigger class={ACTION_BTN}>
 *     <EllipsisVerticalIcon />
 *   </DropdownMenuTrigger>
 *   <DropdownMenuContent>
 *     <DropdownMenuItem label="New Tab" shortcut="⌘N" onSelect={newTab} />
 *     <DropdownMenuSeparator />
 *     <DropdownMenuItem label="Settings" shortcut="⌘," onSelect={openSettings} />
 *   </DropdownMenuContent>
 * </DropdownMenu>
 * ```
 */
export function DropdownMenu(props: {
  children: JSX.Element;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <KMenu open={props.open} defaultOpen={props.defaultOpen} onOpenChange={props.onOpenChange}>
      {props.children}
    </KMenu>
  );
}

/**
 * Button that toggles the menu. Renders as a `<button>` by default.
 * Kobalte attaches click, keyboard, and ARIA attributes automatically.
 */
export function DropdownMenuTrigger(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <KMenu.Trigger {...props} />;
}

function DropdownMenuSurface(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, outerProps] = splitProps(props, ["children", "class"]);

  return (
    <div
      {...outerProps}
      class={[
        "z-1000 min-w-44 origin-[var(--kb-menu-content-transform-origin)] outline-none",
        local.class ?? "",
      ].join(" ")}
    >
      <div
        data-kuku-menu-panel
        class="overflow-hidden rounded-sm border border-border/40 bg-bg-elevated p-1.5 [box-shadow:var(--shadow-context-surface)]"
      >
        {local.children}
      </div>
    </div>
  );
}

/**
 * Portaled dropdown content panel with styling.
 * Wraps `KMenu.Portal` + `KMenu.Content`.
 */
export function DropdownMenuContent(props: { children: JSX.Element; class?: string }) {
  return (
    <KMenu.Portal>
      <KMenu.Content as={DropdownMenuSurface} class={[props.class ?? ""].join(" ")}>
        {props.children}
      </KMenu.Content>
    </KMenu.Portal>
  );
}

/**
 * A single menu item with label and optional keyboard shortcut hint.
 */
export function DropdownMenuItem(props: {
  label: string;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <KMenu.Item
      onSelect={props.onSelect}
      disabled={props.disabled}
      class={[
        "flex h-8 w-full cursor-pointer items-center justify-between gap-4 rounded-xs px-2.5 text-[0.8125rem] leading-normal text-text-primary outline-none",
        "transition-colors duration-75",
        "data-highlighted:bg-ghost-hover",
        "data-disabled:cursor-not-allowed data-disabled:text-text-disabled",
      ].join(" ")}
    >
      <span class="whitespace-nowrap">{props.label}</span>
      <Show when={props.shortcut}>
        {(shortcut) => (
          <span class="text-[0.6875rem] text-text-muted">
            {formatShortcutSymbols(shortcut())}
          </span>
        )}
      </Show>
    </KMenu.Item>
  );
}

/**
 * A visual separator between menu items.
 */
export function DropdownMenuSeparator() {
  return (
    <KMenu.Separator class="kuku-cm-separator mx-0! my-0 h-px w-full max-w-full shrink-0 border-0 p-0" />
  );
}

/**
 * A group label for a section of menu items.
 */
export function DropdownMenuGroupLabel(props: { children: JSX.Element }) {
  return (
    <KMenu.GroupLabel class="px-2.5 py-1.5 text-[0.6875rem] font-medium tracking-wider text-text-muted uppercase">
      {props.children}
    </KMenu.GroupLabel>
  );
}

/**
 * A group of related menu items.
 */
export function DropdownMenuGroup(props: { children: JSX.Element }) {
  return <KMenu.Group>{props.children}</KMenu.Group>;
}
