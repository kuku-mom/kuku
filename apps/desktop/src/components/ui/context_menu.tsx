import { ContextMenu as KMenu } from "@kobalte/core/context-menu";
import { type JSX, Show, splitProps } from "solid-js";

export function ContextMenu(props: {
  children: JSX.Element;
  onOpenChange?: (open: boolean) => void;
}) {
  return <KMenu onOpenChange={props.onOpenChange}>{props.children}</KMenu>;
}

export function ContextMenuTrigger(props: { children: JSX.Element }) {
  return <KMenu.Trigger>{props.children}</KMenu.Trigger>;
}

function ContextMenuSurface(props: JSX.HTMLAttributes<HTMLDivElement>) {
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
        class="overflow-hidden rounded-sm border border-border/40 bg-bg-elevated p-1.5 text-text-primary [box-shadow:var(--shadow-context-surface)]"
      >
        {local.children}
      </div>
    </div>
  );
}

export function ContextMenuContent(props: { children: JSX.Element; class?: string }) {
  return (
    <KMenu.Portal>
      <KMenu.Content as={ContextMenuSurface} class={[props.class ?? ""].join(" ")}>
        {props.children}
      </KMenu.Content>
    </KMenu.Portal>
  );
}

export function ContextMenuItem(props: {
  label: string;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <KMenu.Item
      onSelect={props.onSelect}
      disabled={props.disabled}
      class={[
        "flex h-7 w-full cursor-pointer items-center justify-between gap-2.5 rounded-xs px-2.5 py-0.5 text-[0.8125rem] font-normal leading-none antialiased outline-none",
        "transition-colors duration-100",
        props.danger
          ? "text-error data-highlighted:bg-error-bg"
          : "text-text-primary/95 data-highlighted:bg-bg-secondary/55",
        "data-disabled:cursor-not-allowed data-disabled:text-text-disabled",
      ].join(" ")}
    >
      <span class="whitespace-nowrap">{props.label}</span>
      <Show when={props.shortcut}>
        <span
          class={props.danger ? "text-error/70" : "text-[0.65rem] font-normal text-text-muted/85 tabular-nums"}
        >
          {props.shortcut}
        </span>
      </Show>
    </KMenu.Item>
  );
}

/**
 * A visual separator between menu items.
 */
export function ContextMenuSeparator() {
  return (
    <KMenu.Separator class="kuku-cm-separator !mx-0 my-0 h-px w-full max-w-full shrink-0 border-0 p-0" />
  );
}

/**
 * A group label for a section of menu items (e.g. "AI Skills").
 */
export function ContextMenuGroupLabel(props: { children: JSX.Element }) {
  return (
    <KMenu.GroupLabel class="px-2.5 py-0.5 text-[0.625rem] font-medium leading-none tracking-[0.06em] text-text-muted/75 normal-case">
      {props.children}
    </KMenu.GroupLabel>
  );
}

/**
 * A group of related menu items.
 */
export function ContextMenuGroup(props: { children: JSX.Element }) {
  return <KMenu.Group>{props.children}</KMenu.Group>;
}

/**
 * Root wrapper for a submenu.
 */
export function ContextMenuSub(props: { children: JSX.Element }) {
  return <KMenu.Sub>{props.children}</KMenu.Sub>;
}

/**
 * Trigger item for a submenu. Renders like a regular menu item
 * but displays a right-pointing chevron to indicate a nested menu.
 */
export function ContextMenuSubTrigger(props: { label: string; disabled?: boolean }) {
  return (
    <KMenu.SubTrigger
      disabled={props.disabled}
      class={[
        "flex h-7 w-full cursor-pointer items-center justify-between gap-2 rounded-xs px-2.5 py-0.5 text-[0.8125rem] font-normal leading-none text-text-primary/95 antialiased outline-none",
        "transition-colors duration-100",
        "data-highlighted:bg-bg-secondary/55",
        "data-disabled:cursor-not-allowed data-disabled:text-text-disabled",
      ].join(" ")}
    >
      <span class="whitespace-nowrap">{props.label}</span>
      <span class="shrink-0 pr-0.5 text-[0.6rem] text-text-muted/65" aria-hidden>
        ›
      </span>
    </KMenu.SubTrigger>
  );
}

/**
 * Portaled content panel for a submenu.
 * Uses the same portal + styling as `ContextMenuContent`.
 */
export function ContextMenuSubContent(props: { children: JSX.Element; class?: string }) {
  return (
    <KMenu.Portal>
      <KMenu.SubContent as={ContextMenuSurface} class={[props.class ?? ""].join(" ")}>
        {props.children}
      </KMenu.SubContent>
    </KMenu.Portal>
  );
}

/**
 * Compact icon-only button for use in a formatting toolbar grid
 * inside a context menu.
 */
export function ContextMenuIconButton(props: {
  children: JSX.Element;
  onSelect: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <KMenu.Item
      onSelect={props.onSelect}
      disabled={props.disabled}
      class={[
        "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[2px] outline-none",
        "transition-[color,background-color] duration-100",
        "data-highlighted:bg-bg-secondary/55",
        "data-disabled:cursor-not-allowed data-disabled:text-text-disabled",
        props.active
          ? "bg-bg-secondary/90 text-text-primary"
          : "text-text-secondary",
      ].join(" ")}
      title={props.title}
    >
      {props.children}
    </KMenu.Item>
  );
}
