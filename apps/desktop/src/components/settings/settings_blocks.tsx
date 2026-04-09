import { Show, splitProps, type JSX } from "solid-js";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui";

interface SettingsPanelProps {
  title: string;
  description?: string;
  action?: JSX.Element;
  children: JSX.Element;
  anchor?: string;
}

interface SettingsCardProps {
  title?: string;
  description?: string;
  action?: JSX.Element;
  children: JSX.Element;
  anchor?: string;
  tone?: "default" | "subtle" | "muted" | "error";
}

interface SettingsMetricRowProps {
  label: string;
  value: string;
}

interface SettingsStatusBadgeProps {
  tone: "neutral" | "success" | "info" | "error";
  children: JSX.Element;
}

interface SettingsProgressProps {
  value: number;
  max: number;
  tone?: "info" | "success" | "warning" | "error";
  label?: string;
}

interface SettingsBannerProps {
  tone: "info" | "warning" | "error" | "success";
  title?: string;
  description: JSX.Element;
  action?: JSX.Element;
}

interface SettingsFieldRowProps {
  label: string;
  description?: string;
  control: JSX.Element;
  stacked?: boolean;
}

interface SettingsListRowProps {
  title: string;
  description?: string;
  meta?: JSX.Element;
  action?: JSX.Element;
}

interface SettingsDropdownAction {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface SettingsDropdownGroup {
  label?: string;
  items: SettingsDropdownAction[];
}

interface SettingsDropdownMenuProps {
  label?: string;
  groups: SettingsDropdownGroup[];
}

type SettingsInputProps = JSX.InputHTMLAttributes<HTMLInputElement>;

type SettingsTextareaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement>;

interface SettingsToolbarActionProps {
  children: JSX.Element;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "warning" | "destructive";
  type?: "button" | "submit" | "reset";
}

function settingsActionButtonClass(): string {
  return "rounded-xs border border-border bg-bg-secondary px-2.5 py-1 text-[0.6875rem] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary";
}

function settingsInputClass(): string {
  return "w-full rounded-xs border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary transition-colors outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50";
}

function settingsTextareaClass(): string {
  return `${settingsInputClass()} min-h-24 resize-y`;
}

function settingsToolbarActionClass(
  variant: SettingsToolbarActionProps["variant"] = "default",
): string {
  const base =
    "rounded-xs px-2.5 py-1 text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  switch (variant) {
    case "primary":
      return `${base} border border-accent/30 bg-accent/15 text-accent hover:bg-accent/25`;
    case "warning":
      return `${base} border border-warning-border bg-warning-bg text-warning hover:opacity-80`;
    case "destructive":
      return `${base} border border-error-border bg-error-bg text-error hover:opacity-80`;
    default:
      return `${base} border border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary`;
  }
}

function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  return (
    <section
      class="overflow-hidden rounded-xs border border-border bg-bg-primary"
      data-settings-anchor={props.anchor}
    >
      <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h3 class="text-[0.8125rem] font-medium text-text-primary">{props.title}</h3>
          <Show when={props.description}>
            {(description) => <p class="mt-0.5 text-[0.75rem] text-text-muted">{description()}</p>}
          </Show>
        </div>
        <Show when={props.action}>{(action) => action()}</Show>
      </div>

      <div class="space-y-3 p-4">{props.children}</div>
    </section>
  );
}

function SettingsCard(props: SettingsCardProps): JSX.Element {
  const toneClass = () => {
    switch (props.tone) {
      case "subtle":
        return "border-border bg-bg-secondary/40";
      case "muted":
        return "border-border bg-bg-secondary/70";
      case "error":
        return "border-error-border bg-error-bg";
      default:
        return "border-border/60 bg-bg-primary/60";
    }
  };

  return (
    <div class={`rounded-xs border p-3 ${toneClass()}`} data-settings-anchor={props.anchor}>
      <Show when={props.title || props.description || props.action}>
        <div class="flex items-start justify-between gap-3">
          <div>
            <Show when={props.title}>
              {(title) => (
                <div class="text-[0.6875rem] tracking-[0.12em] text-text-muted uppercase">
                  {title()}
                </div>
              )}
            </Show>
            <Show when={props.description}>
              {(description) => <p class="mt-1 text-[0.75rem] text-text-muted">{description()}</p>}
            </Show>
          </div>
          <Show when={props.action}>{(action) => action()}</Show>
        </div>
      </Show>

      <div class={props.title || props.description || props.action ? "mt-3" : undefined}>
        {props.children}
      </div>
    </div>
  );
}

function SettingsMetricRow(props: SettingsMetricRowProps): JSX.Element {
  return (
    <div class="flex items-center justify-between gap-4 text-[0.75rem] text-text-secondary">
      <span>{props.label}</span>
      <span class="font-medium text-text-primary">{props.value}</span>
    </div>
  );
}

function SettingsFieldRow(props: SettingsFieldRowProps): JSX.Element {
  return (
    <div
      class={`rounded-xs border border-border/60 bg-bg-primary/60 px-3 py-2 ${
        props.stacked ? "space-y-2" : "flex items-start justify-between gap-4"
      }`}
    >
      <div class={props.stacked ? undefined : "min-w-0 flex-1"}>
        <div class="text-[0.75rem] font-medium text-text-primary">{props.label}</div>
        <Show when={props.description}>
          {(description) => <p class="mt-0.5 text-[0.6875rem] text-text-muted">{description()}</p>}
        </Show>
      </div>
      <div class={props.stacked ? undefined : "shrink-0"}>{props.control}</div>
    </div>
  );
}

function SettingsListRow(props: SettingsListRowProps): JSX.Element {
  return (
    <div class="flex items-start justify-between gap-4 rounded-xs border border-border/60 bg-bg-primary/60 px-3 py-2">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <div class="text-[0.75rem] font-medium text-text-primary">{props.title}</div>
          <Show when={props.meta}>{(meta) => <div class="shrink-0">{meta()}</div>}</Show>
        </div>
        <Show when={props.description}>
          {(description) => <p class="mt-0.5 text-[0.6875rem] text-text-muted">{description()}</p>}
        </Show>
      </div>
      <Show when={props.action}>{(action) => <div class="shrink-0">{action()}</div>}</Show>
    </div>
  );
}

function SettingsBanner(props: SettingsBannerProps): JSX.Element {
  const className = () => {
    switch (props.tone) {
      case "success":
        return "border-success-border bg-success-bg";
      case "warning":
        return "border-warning-border bg-warning-bg";
      case "error":
        return "border-error-border bg-error-bg";
      default:
        return "border-info-border bg-info-bg";
    }
  };

  const titleClass = () => {
    switch (props.tone) {
      case "success":
        return "text-success";
      case "warning":
        return "text-warning";
      case "error":
        return "text-error";
      default:
        return "text-info";
    }
  };

  return (
    <div class={`rounded-xs border px-3 py-2 ${className()}`}>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <Show when={props.title}>
            {(title) => <div class={`text-[0.75rem] font-medium ${titleClass()}`}>{title()}</div>}
          </Show>
          <div
            class={`text-[0.75rem] ${props.title ? "mt-1 text-text-secondary" : "text-text-secondary"}`}
          >
            {props.description}
          </div>
        </div>
        <Show when={props.action}>{(action) => <div class="shrink-0">{action()}</div>}</Show>
      </div>
    </div>
  );
}

function SettingsProgress(props: SettingsProgressProps): JSX.Element {
  const percentage = () => {
    if (props.max <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((props.value / props.max) * 100)));
  };

  const barClass = () => {
    switch (props.tone) {
      case "success":
        return "bg-success";
      case "warning":
        return "bg-warning";
      case "error":
        return "bg-error";
      default:
        return "bg-info";
    }
  };

  return (
    <div class="space-y-1.5">
      <div class="flex items-center justify-between gap-3 text-[0.6875rem] text-text-muted">
        <span>{props.label ?? "Progress"}</span>
        <span class="font-medium text-text-primary">
          {props.value} / {props.max} ({percentage()}%)
        </span>
      </div>
      <div class="h-1 overflow-hidden rounded-xs bg-bg-tertiary">
        <div
          class={`h-full rounded-xs transition-all duration-300 ${barClass()}`}
          style={{ width: `${percentage()}%` }}
        />
      </div>
    </div>
  );
}

function SettingsInput(props: SettingsInputProps): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return <input {...rest} class={[settingsInputClass(), local.class].filter(Boolean).join(" ")} />;
}

function SettingsTextarea(props: SettingsTextareaProps): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <textarea {...rest} class={[settingsTextareaClass(), local.class].filter(Boolean).join(" ")} />
  );
}

function SettingsStatusBadge(props: SettingsStatusBadgeProps): JSX.Element {
  const className = () => {
    switch (props.tone) {
      case "success":
        return "border-success-border bg-success-bg text-success";
      case "info":
        return "border-info-border bg-info-bg text-info";
      case "error":
        return "border-error-border bg-error-bg text-error";
      default:
        return "border-border bg-bg-primary text-text-muted";
    }
  };

  return (
    <span class={`rounded-xs border px-2 py-0.5 text-[0.6875rem] ${className()}`}>
      {props.children}
    </span>
  );
}

function SettingsDropdownMenu(props: SettingsDropdownMenuProps): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger class={settingsActionButtonClass()}>
        {props.label ?? "Actions"}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <ForEachGroups groups={props.groups} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SettingsToolbarAction(props: SettingsToolbarActionProps): JSX.Element {
  return (
    <button
      type={props.type ?? "button"}
      disabled={props.disabled}
      class={settingsToolbarActionClass(props.variant)}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function ForEachGroups(props: { groups: SettingsDropdownGroup[] }): JSX.Element {
  return (
    <>
      {props.groups.map((group, groupIndex) => (
        <>
          {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuGroup>
            {group.label ? <DropdownMenuGroupLabel>{group.label}</DropdownMenuGroupLabel> : null}
            {group.items.map((item) => (
              <DropdownMenuItem
                label={item.label}
                shortcut={item.shortcut}
                disabled={item.disabled}
                onSelect={item.onSelect}
              />
            ))}
          </DropdownMenuGroup>
        </>
      ))}
    </>
  );
}

export {
  SettingsBanner,
  SettingsCard,
  SettingsDropdownMenu,
  SettingsFieldRow,
  SettingsInput,
  SettingsListRow,
  SettingsMetricRow,
  SettingsPanel,
  SettingsProgress,
  SettingsStatusBadge,
  SettingsTextarea,
  SettingsToolbarAction,
  settingsActionButtonClass,
  settingsInputClass,
  settingsTextareaClass,
  settingsToolbarActionClass,
};
