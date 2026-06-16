import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Dynamic } from "solid-js/web";

import { PluginSettingsSection } from "~/components/settings/plugin_settings_section";
import ScrollArea from "~/components/scroll_area";
import { AboutSection } from "~/components/settings/sections/about_section";
import { AppearanceSection } from "~/components/settings/sections/appearance_section";
import { DebugSection } from "~/components/settings/sections/debug_section";
import { EditorSection } from "~/components/settings/sections/editor_section";
import { FilesSection } from "~/components/settings/sections/files_section";
import { GeneralSection } from "~/components/settings/sections/general_section";
import { KeybindingsSection } from "~/components/settings/sections/keybindings_section";
import { PluginsSection } from "~/components/settings/sections/plugins_section";
import { t } from "~/i18n";
import { getPluginDisplayOrder } from "~/plugins/registry";
import { slotRegistry } from "~/plugins/slots";
import type { SlotFill } from "~/plugins/types";
import { resetAllDesktopState } from "~/stores/app_reset";
import {
  filesState,
  setSettingsTarget,
  type SettingsCategoryId,
  type SettingsTarget,
} from "~/stores/files";

// ── Types ──

interface NavCategory {
  id: string;
  label?: string;
}

// ── Data ──

const CATEGORIES: NavCategory[] = [
  { id: "general" },
  { id: "appearance" },
  { id: "editor" },
  { id: "files" },
  { id: "keybindings" },
  { id: "plugins" },
  { id: "about" },
  { id: "debug" },
];

const SECTION_MAP: Record<string, Component> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  editor: EditorSection,
  files: FilesSection,
  keybindings: KeybindingsSection,
  plugins: PluginsSection,
  about: AboutSection,
  debug: DebugSection,
};

// ── Nav Button ──

function NavButton(props: {
  cat: NavCategory;
  active: boolean;
  onClick: () => void;
  class?: string;
}) {
  return (
    <button
      type="button"
      class={`flex h-8 w-full cursor-pointer items-center rounded-xs border-none px-2.5 text-[0.8125rem] leading-normal transition-colors duration-100 ${props.class ?? ""} ${
        props.active
          ? "bg-ghost-selected text-text-primary"
          : "bg-transparent text-text-secondary hover:bg-ghost-hover hover:text-text-primary"
      }`}
      onClick={props.onClick}
    >
      {props.cat.label ?? categoryLabel(props.cat.id)}
    </button>
  );
}

function categoryLabel(id: string): string {
  switch (id) {
    case "general":
      return t("settings.nav.general");
    case "appearance":
      return t("settings.nav.appearance");
    case "editor":
      return t("settings.nav.editor");
    case "files":
      return t("settings.nav.files");
    case "keybindings":
      return t("settings.nav.keybindings");
    case "plugins":
      return t("settings.nav.plugins");
    case "about":
      return t("settings.nav.about");
    case "debug":
      return t("settings.nav.debug");
    default:
      return id;
  }
}

function pluginSettingsLabel(fill: SlotFill): string {
  switch (fill.id) {
    case "core-auth.settings":
      return t("settings.plugin.account");
    case "core-sync.settings":
      return t("settings.plugin.sync");
    case "core-indexer.settings":
      return t("settings.plugin.indexer");
    case "ai-chat.settings":
      return t("settings.plugin.ai_chat");
    case "graph-view.settings":
      return t("settings.plugin.graph_view");
    case "voxel-graph.settings":
      return t("settings.plugin.voxel_graph");
    default:
      return fill.label;
  }
}

// ── Main Component ──

export default function SettingsView() {
  const [activeCategory, setActiveCategory] = createSignal("general");
  const [confirmReset, setConfirmReset] = createSignal(false);
  const [isResetting, setIsResetting] = createSignal(false);
  const [settingsRefreshToken, setSettingsRefreshToken] = createSignal(0);
  let contentRootRef: HTMLDivElement | undefined;
  let anchorScrollTimer: number | undefined;

  const primaryCategories = () =>
    CATEGORIES.filter((c) => c.id !== "plugins" && c.id !== "about" && c.id !== "debug");
  const pluginCategories = () => {
    const order = new Map(getPluginDisplayOrder().map((id, index) => [id, index]));
    const uniqueFills = new Map<string, SlotFill>();

    for (const fill of slotRegistry.fills.settingsSection) {
      if (!fill.isActive()) continue;
      if (!uniqueFills.has(fill.id)) {
        uniqueFills.set(fill.id, fill);
      }
    }

    return [...uniqueFills.values()]
      .sort((left: SlotFill, right: SlotFill) => {
        const pluginOrder =
          (order.get(left.pluginId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.pluginId) ?? Number.MAX_SAFE_INTEGER);
        if (pluginOrder !== 0) return pluginOrder;
        if (left.order !== right.order) return left.order - right.order;
        return left.label.localeCompare(right.label);
      })
      .map((fill: SlotFill) => ({ id: `plugin:${fill.id}`, label: pluginSettingsLabel(fill) }));
  };
  const pluginsOverviewCategory = () => CATEGORIES.find((c) => c.id === "plugins") ?? null;
  const trailingCategories = () =>
    CATEGORIES.filter((c) =>
      import.meta.env.DEV ? c.id === "about" || c.id === "debug" : c.id === "about",
    );
  const allCategoryIds = () => [
    ...primaryCategories().map((category) => category.id),
    ...(pluginsOverviewCategory() ? ["plugins"] : []),
    ...pluginCategories().map((category: NavCategory) => category.id),
    ...trailingCategories().map((category) => category.id),
  ];
  const activePluginFillId = () =>
    activeCategory().startsWith("plugin:") ? activeCategory().slice("plugin:".length) : null;
  const sectionComponent = () => SECTION_MAP[activeCategory()];
  const resetButtonLabel = () => {
    if (isResetting()) return t("settings.reset.resetting");
    if (confirmReset()) return t("settings.reset.confirm");
    return t("settings.reset.default");
  };
  const currentSettingsTarget = createMemo<SettingsTarget | null>(() =>
    filesState.settingsDialogOpen ? (filesState.settingsTarget ?? null) : null,
  );

  function isSettingsCategoryId(value: string): value is SettingsCategoryId {
    return CATEGORIES.some((category) => category.id === value);
  }

  function resolveCategoryIdForTarget(target: SettingsTarget | null): string | null {
    if (!target) return null;

    if (target.kind === "category") {
      return allCategoryIds().includes(target.categoryId) ? target.categoryId : null;
    }

    const pluginCategoryId = `plugin:${target.fillId}`;
    if (allCategoryIds().includes(pluginCategoryId)) {
      return pluginCategoryId;
    }

    return allCategoryIds().includes("plugins") ? "plugins" : null;
  }

  function targetForCategoryId(categoryId: string): SettingsTarget | undefined {
    if (categoryId.startsWith("plugin:")) {
      return {
        kind: "plugin",
        fillId: categoryId.slice("plugin:".length),
      };
    }

    if (isSettingsCategoryId(categoryId)) {
      return {
        kind: "category",
        categoryId,
      };
    }

    return undefined;
  }

  function selectCategory(categoryId: string): void {
    setActiveCategory(categoryId);
    setSettingsTarget(targetForCategoryId(categoryId));
  }

  function findAnchorNode(anchor: string): HTMLElement | undefined {
    if (!contentRootRef) return undefined;

    const nodes = contentRootRef.querySelectorAll<HTMLElement>("[data-settings-anchor]");
    return [...nodes].find((node) => node.dataset.settingsAnchor === anchor);
  }

  function clearAnchorScrollTimer(): void {
    if (anchorScrollTimer !== undefined) {
      window.clearTimeout(anchorScrollTimer);
      anchorScrollTimer = undefined;
    }
  }

  function scheduleAnchorScroll(anchor: string, attempt = 0): void {
    clearAnchorScrollTimer();
    anchorScrollTimer = window.setTimeout(
      () => {
        const node = findAnchorNode(anchor);
        if (node) {
          node.scrollIntoView({ block: "start", behavior: "auto" });
          anchorScrollTimer = undefined;
          return;
        }

        if (attempt < 10) {
          scheduleAnchorScroll(anchor, attempt + 1);
        }
      },
      attempt === 0 ? 0 : 50,
    );
  }

  onCleanup(() => clearAnchorScrollTimer());

  createEffect(() => {
    const category = activeCategory();
    if (!allCategoryIds().includes(category)) {
      setActiveCategory(primaryCategories()[0]?.id ?? "about");
    }
  });

  createEffect(() => {
    const resolvedCategoryId = resolveCategoryIdForTarget(currentSettingsTarget());
    if (resolvedCategoryId && resolvedCategoryId !== activeCategory()) {
      setActiveCategory(resolvedCategoryId);
    }
  });

  createEffect(() => {
    const target = currentSettingsTarget();
    if (!target) return;

    const resolvedCategoryId = resolveCategoryIdForTarget(target);
    if (!resolvedCategoryId) return;

    let fallbackAnchor: string;
    if (resolvedCategoryId === "plugins" && target.kind === "plugin") {
      fallbackAnchor = "plugins";
    } else if (target.kind === "category") {
      fallbackAnchor = target.categoryId;
    } else {
      fallbackAnchor = `plugin:${target.fillId}`;
    }

    scheduleAnchorScroll(target.anchor ?? fallbackAnchor);
    setSettingsRefreshToken((current) => current + 1);
  });

  return (
    <div class="flex h-full">
      {/* ── Left Nav ── */}
      <nav class="flex w-45 shrink-0 flex-col border-r border-border bg-bg-secondary py-2">
        <ScrollArea class="flex-1 px-2" axis="y" scrollbarAutoHide="leave">
          {/* Main categories */}
          <For each={primaryCategories()}>
            {(cat) => (
              <NavButton
                cat={cat}
                active={activeCategory() === cat.id}
                onClick={() => selectCategory(cat.id)}
              />
            )}
          </For>

          <div class="m-2 h-px bg-border" />

          <Show when={pluginsOverviewCategory()}>
            {(cat) => (
              <NavButton
                cat={cat()}
                active={activeCategory() === cat().id}
                onClick={() => selectCategory(cat().id)}
              />
            )}
          </Show>

          <Show when={pluginCategories().length > 0}>
            <div class="mt-1" />
            <For each={pluginCategories()}>
              {(cat) => (
                <NavButton
                  cat={cat}
                  active={activeCategory() === cat.id}
                  onClick={() => selectCategory(cat.id)}
                  class="pl-6 text-[0.75rem]"
                />
              )}
            </For>
          </Show>

          <Show when={trailingCategories().length > 0}>
            <div class="m-2 h-px bg-border" />
          </Show>

          <For each={trailingCategories()}>
            {(cat) => (
              <NavButton
                cat={cat}
                active={activeCategory() === cat.id}
                onClick={() => selectCategory(cat.id)}
              />
            )}
          </For>
        </ScrollArea>
        <div class="shrink-0 border-t border-border px-3 py-2">
          <button
            type="button"
            disabled={isResetting()}
            class={`w-full cursor-pointer rounded-xs border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              confirmReset()
                ? "border-error bg-error/10 text-error hover:bg-error/20"
                : "border-border bg-transparent text-text-muted hover:bg-ghost-hover hover:text-error"
            }`}
            onClick={() => {
              if (confirmReset()) {
                void (async () => {
                  setIsResetting(true);
                  try {
                    await resetAllDesktopState();
                    setConfirmReset(false);
                  } finally {
                    setIsResetting(false);
                  }
                })();
              } else {
                setConfirmReset(true);
                setTimeout(() => setConfirmReset(false), 3000);
              }
            }}
            onBlur={() => setConfirmReset(false)}
          >
            {resetButtonLabel()}
          </button>
        </div>
      </nav>

      {/* ── Right Content ── */}
      <div class="flex min-w-0 flex-1 flex-col">
        {/* Settings content */}
        <ScrollArea class="min-h-0 flex-1" axis="y" scrollbarVisibility="always">
          <div ref={contentRootRef} class="mx-auto max-w-140 px-5 py-2">
            <Show when={activePluginFillId()} fallback={<Dynamic component={sectionComponent()} />}>
              {(fillId) => (
                <PluginSettingsSection
                  fillId={fillId()}
                  settingsRefreshToken={settingsRefreshToken()}
                />
              )}
            </Show>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
