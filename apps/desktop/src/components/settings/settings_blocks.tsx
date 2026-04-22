import { Show, splitProps, type JSX } from "solid-js";
import { twMerge } from "tailwind-merge";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Select,
  type SelectProps,
} from "~/components/ui";

interface SettingsPanelProps {
  title: string;
  description?: string;
  action?: JSX.Element;
  children: JSX.Element;
  anchor?: string;
  class?: string;
  headerClass?: string;
  bodyClass?: string;
  titleClass?: string;
  descriptionClass?: string;
  actionClass?: string;
}

interface SettingsCardProps {
  title?: string;
  description?: string;
  action?: JSX.Element;
  children: JSX.Element;
  anchor?: string;
  tone?: "default" | "subtle" | "muted" | "error";
  class?: string;
  headerClass?: string;
  bodyClass?: string;
  titleClass?: string;
  descriptionClass?: string;
  actionClass?: string;
}

interface SettingsMetricRowProps {
  label: string;
  value: string;
  class?: string;
  labelClass?: string;
  valueClass?: string;
}

interface SettingsStatusBadgeProps {
  tone: "neutral" | "success" | "info" | "error";
  children: JSX.Element;
  class?: string;
}

interface SettingsProgressProps {
  value: number;
  max: number;
  tone?: "info" | "success" | "warning" | "error";
  label?: string;
  class?: string;
  labelRowClass?: string;
  labelClass?: string;
  valueClass?: string;
  trackClass?: string;
  barClass?: string;
}

interface SettingsBannerProps {
  tone: "info" | "warning" | "error" | "success";
  title?: string;
  description: JSX.Element;
  action?: JSX.Element;
  class?: string;
  titleClass?: string;
  descriptionClass?: string;
  actionClass?: string;
}

interface SettingsFieldRowProps {
  label: string;
  description?: string;
  control: JSX.Element;
  stacked?: boolean;
  class?: string;
  labelClass?: string;
  descriptionClass?: string;
  controlClass?: string;
}

interface SettingsListRowProps {
  title: JSX.Element;
  description?: JSX.Element;
  meta?: JSX.Element;
  action?: JSX.Element;
  class?: string;
  titleClass?: string;
  descriptionClass?: string;
  metaClass?: string;
  actionClass?: string;
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
  triggerClass?: string;
  contentClass?: string;
}

type SettingsInputProps = JSX.InputHTMLAttributes<HTMLInputElement>;

type SettingsTextareaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement>;

type SettingsSelectProps = SelectProps;

interface SettingsToolbarActionProps {
  children: JSX.Element;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "warning" | "destructive";
  type?: "button" | "submit" | "reset";
  class?: string;
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
      class={twMerge("overflow-hidden rounded-xs border border-border bg-bg-primary", props.class)}
      data-settings-anchor={props.anchor}
    >
      <div
        class={twMerge(
          "flex items-center justify-between gap-2 border-b border-border px-4 py-3",
          props.headerClass,
        )}
      >
        <div>
          <h3 class={twMerge("text-[0.8125rem] font-medium text-text-primary", props.titleClass)}>
            {props.title}
          </h3>
          <Show when={props.description}>
            {(description) => (
              <p
                class={twMerge(
                  "mt-0.5 text-[0.75rem] whitespace-pre-line text-text-muted",
                  props.descriptionClass,
                )}
              >
                {description()}
              </p>
            )}
          </Show>
        </div>
        <Show when={props.action}>
          {(action) => <div class={props.actionClass}>{action()}</div>}
        </Show>
      </div>

      <div class={twMerge("@container space-y-3 p-4", props.bodyClass)}>{props.children}</div>
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
    <div
      class={twMerge("rounded-xs border p-3", toneClass(), props.class)}
      data-settings-anchor={props.anchor}
    >
      <Show when={props.title || props.description || props.action}>
        <div class={twMerge("flex items-start justify-between gap-3", props.headerClass)}>
          <div>
            <Show when={props.title}>
              {(title) => (
                <div
                  class={twMerge(
                    "text-[0.6875rem] tracking-[0.12em] text-text-muted uppercase",
                    props.titleClass,
                  )}
                >
                  {title()}
                </div>
              )}
            </Show>
            <Show when={props.description}>
              {(description) => (
                <p
                  class={twMerge(
                    "mt-1 text-[0.75rem] whitespace-pre-line text-text-muted",
                    props.descriptionClass,
                  )}
                >
                  {description()}
                </p>
              )}
            </Show>
          </div>
          <Show when={props.action}>
            {(action) => <div class={props.actionClass}>{action()}</div>}
          </Show>
        </div>
      </Show>

      <div
        class={twMerge(
          props.title || props.description || props.action ? "mt-3" : undefined,
          props.bodyClass,
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

function SettingsMetricRow(props: SettingsMetricRowProps): JSX.Element {
  return (
    <div
      class={twMerge(
        "flex items-center justify-between gap-4 text-[0.75rem] text-text-secondary",
        props.class,
      )}
    >
      <span class={props.labelClass}>{props.label}</span>
      <span class={twMerge("font-medium text-text-primary", props.valueClass)}>{props.value}</span>
    </div>
  );
}

function SettingsFieldRow(props: SettingsFieldRowProps): JSX.Element {
  return (
    <div
      class={twMerge(
        "rounded-xs border border-border/60 bg-bg-primary/60 px-3 py-2",
        props.stacked
          ? "space-y-2"
          : "flex flex-col gap-2 @sm:flex-row @sm:items-start @sm:justify-between @sm:gap-4",
        props.class,
      )}
    >
      <div class={props.stacked ? undefined : "@sm:min-w-0 @sm:flex-1"}>
        <div class={twMerge("text-[0.75rem] font-medium text-text-primary", props.labelClass)}>
          {props.label}
        </div>
        <Show when={props.description}>
          {(description) => (
            <p
              class={twMerge(
                "mt-0.5 text-[0.6875rem] whitespace-pre-line text-text-muted",
                props.descriptionClass,
              )}
            >
              {description()}
            </p>
          )}
        </Show>
      </div>
      <div class={twMerge(props.stacked ? undefined : "@sm:min-w-0", props.controlClass)}>
        {props.control}
      </div>
    </div>
  );
}

function SettingsListRow(props: SettingsListRowProps): JSX.Element {
  return (
    <div
      class={twMerge(
        "flex items-start justify-between gap-4 rounded-xs border border-border/60 bg-bg-primary/60 px-3 py-2",
        props.class,
      )}
    >
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <div class={twMerge("text-[0.75rem] font-medium text-text-primary", props.titleClass)}>
            {props.title}
          </div>
          <Show when={props.meta}>
            {(meta) => <div class={twMerge("shrink-0", props.metaClass)}>{meta()}</div>}
          </Show>
        </div>
        <Show when={props.description}>
          {(description) => (
            <p
              class={twMerge(
                "mt-0.5 text-[0.6875rem] whitespace-pre-line text-text-muted",
                props.descriptionClass,
              )}
            >
              {description()}
            </p>
          )}
        </Show>
      </div>
      <Show when={props.action}>
        {(action) => <div class={twMerge("shrink-0", props.actionClass)}>{action()}</div>}
      </Show>
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
    <div class={twMerge("rounded-xs border px-3 py-2", className(), props.class)}>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <Show when={props.title}>
            {(title) => (
              <div class={twMerge("text-[0.75rem] font-medium", titleClass(), props.titleClass)}>
                {title()}
              </div>
            )}
          </Show>
          <div
            class={twMerge(
              "text-[0.75rem]",
              props.title
                ? "mt-1 whitespace-pre-line text-text-secondary"
                : "whitespace-pre-line text-text-secondary",
              props.descriptionClass,
            )}
          >
            {props.description}
          </div>
        </div>
        <Show when={props.action}>
          {(action) => <div class={twMerge("shrink-0", props.actionClass)}>{action()}</div>}
        </Show>
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
    <div class={twMerge("space-y-1.5", props.class)}>
      <div
        class={twMerge(
          "flex items-center justify-between gap-3 text-[0.6875rem] text-text-muted",
          props.labelRowClass,
        )}
      >
        <span class={props.labelClass}>{props.label ?? "Progress"}</span>
        <span class={twMerge("font-medium text-text-primary", props.valueClass)}>
          {props.value} / {props.max} ({percentage()}%)
        </span>
      </div>
      <div class={twMerge("h-1 overflow-hidden rounded-xs bg-bg-tertiary", props.trackClass)}>
        <div
          class={twMerge(
            "h-full rounded-xs transition-all duration-300",
            barClass(),
            props.barClass,
          )}
          style={{ width: `${percentage()}%` }}
        />
      </div>
    </div>
  );
}

function SettingsInput(props: SettingsInputProps): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return <input {...rest} class={twMerge(settingsInputClass(), local.class)} />;
}

function SettingsTextarea(props: SettingsTextareaProps): JSX.Element {
  const [local, rest] = splitProps(props, ["class"]);
  return <textarea {...rest} class={twMerge(settingsTextareaClass(), local.class)} />;
}

function SettingsSelect(props: SettingsSelectProps): JSX.Element {
  return (
    <Select
      {...props}
      triggerClass={twMerge(settingsInputClass(), props.triggerClass)}
      contentClass={props.contentClass}
      itemClass={props.itemClass}
    />
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
    <span
      class={twMerge("rounded-xs border px-2 py-0.5 text-[0.6875rem]", className(), props.class)}
    >
      {props.children}
    </span>
  );
}

function SettingsDropdownMenu(props: SettingsDropdownMenuProps): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger class={twMerge(settingsActionButtonClass(), props.triggerClass)}>
        {props.label ?? "Actions"}
      </DropdownMenuTrigger>
      <DropdownMenuContent class={props.contentClass}>
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
      class={twMerge(settingsToolbarActionClass(props.variant), props.class)}
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
  SettingsSelect,
  SettingsStatusBadge,
  SettingsTextarea,
  SettingsToolbarAction,
  settingsActionButtonClass,
  settingsInputClass,
  settingsTextareaClass,
  settingsToolbarActionClass,
};
