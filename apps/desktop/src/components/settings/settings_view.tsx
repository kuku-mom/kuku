import {
  ErrorBoundary,
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";

import ScrollArea from "~/components/scroll_area";
import SettingItem from "~/components/settings/setting_item";
import SettingSection from "~/components/settings/setting_section";
import { Select, Switch } from "~/components/ui";
import {
  destroyKeymap,
  getAllCommands,
  getEffectiveKeys,
  updateCommandKeys,
  type RegisteredCommand,
} from "~/plugins/commands";
import { registryState } from "~/plugins/registry";
import { PluginErrorUI, PluginSkeleton, slotRegistry } from "~/plugins/slots";
import {
  resetKeybindingOverride,
  setAppearanceSetting,
  setEditorSetting,
  setFilesSetting,
  setGeneralSetting,
  setKeybindingOverride,
  setTopLevelSetting,
  settingsState,
} from "~/stores/settings";

// ── Types ──

interface NavCategory {
  id: string;
  label: string;
}

// ── Data ──

const CATEGORIES: NavCategory[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "files", label: "Files & Links" },
  { id: "keybindings", label: "Keybindings" },
  { id: "plugins", label: "Plugins" },
  { id: "about", label: "About" },
];

// ── Shared options ──

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
  { value: "ja", label: "日本語" },
];

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const TAB_SIZE_OPTIONS = [
  { value: "2", label: "2" },
  { value: "4", label: "4" },
  { value: "8", label: "8" },
];

const FONT_SIZE_OPTIONS = [
  { value: "13", label: "13 px" },
  { value: "14", label: "14 px" },
  { value: "15", label: "15 px" },
  { value: "16", label: "16 px" },
  { value: "18", label: "18 px" },
  { value: "20", label: "20 px" },
];

const LINE_HEIGHT_OPTIONS = [
  { value: "1.4", label: "1.4" },
  { value: "1.5", label: "1.5" },
  { value: "1.6", label: "1.6" },
  { value: "1.7", label: "1.7" },
  { value: "1.8", label: "1.8" },
  { value: "2", label: "2.0" },
];

const NEW_FILE_LOCATION_OPTIONS = [
  { value: "root", label: "Vault root" },
  { value: "current", label: "Same folder as current file" },
];

const DELETED_FILES_OPTIONS = [
  { value: "trash", label: "Move to system trash" },
  { value: "kuku-trash", label: "Move to .trash folder" },
  { value: "permanent", label: "Delete permanently" },
];

// ── Styles ──

const INPUT_BASE =
  "h-8 w-full rounded-md border border-border bg-bg-primary px-2.5 text-[0.8125rem] text-text-primary outline-none transition-colors placeholder:text-text-placeholder focus:border-border-focused";

// ── Keybinding Utilities ──

const IS_MAC =
  navigator.platform.toLowerCase().includes("mac") ||
  navigator.userAgent.toLowerCase().includes("mac");

function parseKeys(keys: string): string[] {
  return keys.split("+").map((part) => {
    switch (part) {
      case "$mod":
        return IS_MAC ? "⌘" : "Ctrl";
      case "Shift":
        return IS_MAC ? "⇧" : "Shift";
      case "Control":
        return IS_MAC ? "⌃" : "Ctrl";
      case "Alt":
        return IS_MAC ? "⌥" : "Alt";
      case "Meta":
        return IS_MAC ? "⌘" : "Win";
      case "Comma":
        return ",";
      case "Period":
        return ".";
      case "Slash":
        return "/";
      case "Space":
        return "Space";
      case "Enter":
        return "↵";
      case "Backspace":
        return "⌫";
      case "Delete":
        return "Del";
      case "Escape":
        return "Esc";
      case "Tab":
        return "Tab";
      case "ArrowUp":
        return "↑";
      case "ArrowDown":
        return "↓";
      case "ArrowLeft":
        return "←";
      case "ArrowRight":
        return "→";
      default:
        if (part.startsWith("Key")) return part.slice(3);
        if (part.startsWith("Digit")) return part.slice(5);
        return part;
    }
  });
}

const COMMAND_GROUP_LABELS: Record<string, string> = {
  app: "Application",
  editor: "Editor",
  graph: "Graph",
  panel: "Panel",
  tab: "Tab",
};

function getCommandGroup(id: string): string {
  const prefix = id.split(".")[0] ?? "";
  return COMMAND_GROUP_LABELS[prefix] ?? "Other";
}

function KeyBadge(props: { keys?: string }) {
  return (
    <Show when={props.keys} fallback={<span class="text-[0.6875rem] text-text-disabled">—</span>}>
      {(keys) => (
        <div class="flex shrink-0 items-center gap-1">
          <For each={parseKeys(keys())}>
            {(k) => (
              <kbd class="inline-flex min-w-5 items-center justify-center rounded-sm border border-border bg-bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none text-text-secondary">
                {k}
              </kbd>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}

// ── Keybinding Recording ──

function captureKeybinding(event: KeyboardEvent): string | null {
  if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return null;

  const parts: string[] = [];

  if (IS_MAC) {
    if (event.metaKey) parts.push("$mod");
    if (event.ctrlKey) parts.push("Control");
  } else {
    if (event.ctrlKey) parts.push("$mod");
    if (event.metaKey) parts.push("Meta");
  }
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");

  // Require at least one modifier
  if (parts.length === 0) return null;

  parts.push(event.code);
  return parts.join("+");
}

function RecordingInput(props: { onCapture: (keys: string) => void; onCancel: () => void }) {
  let ref!: HTMLInputElement;
  onMount(() => ref.focus());

  return (
    <input
      ref={ref}
      type="text"
      class="w-36 rounded-sm border border-border-focused bg-bg-secondary px-2.5 py-0.5 text-[0.6875rem] text-text-muted outline-none placeholder:text-text-placeholder"
      placeholder="Press shortcut..."
      readOnly
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          props.onCancel();
          return;
        }
        const captured = captureKeybinding(e);
        if (captured) props.onCapture(captured);
      }}
      onBlur={props.onCancel}
    />
  );
}

// ── Section Renderers ──

function GeneralSection() {
  return (
    <SettingSection title="General">
      <SettingItem
        label="Language (WIP)"
        description="Select the display language for the interface."
      >
        <Select
          options={LANGUAGE_OPTIONS}
          value={settingsState.general.language}
          onChange={(v) => setGeneralSetting("language", v)}
          placeholder="Select language"
        />
      </SettingItem>
      <SettingItem label="Auto-save" description="Automatically save changes after editing.">
        <Switch
          checked={settingsState.general.autoSave}
          onChange={(v) => setGeneralSetting("autoSave", v)}
        />
      </SettingItem>
      <SettingItem label="Spell check" description="Check spelling while typing in the editor.">
        <Switch
          checked={settingsState.general.spellCheck}
          onChange={(v) => setGeneralSetting("spellCheck", v)}
        />
      </SettingItem>
    </SettingSection>
  );
}

function AppearanceSection() {
  return (
    <SettingSection title="Appearance">
      <SettingItem label="Theme" description="Choose between light and dark appearance.">
        <Select
          options={THEME_OPTIONS}
          value={settingsState.appearance.theme}
          onChange={(v) => setAppearanceSetting("theme", v as "system" | "light" | "dark")}
          placeholder="Select theme"
        />
      </SettingItem>
      <SettingItem
        label="UI font"
        description="Font used for the interface. Enter a CSS font-family name."
      >
        <FontInput
          value={settingsState.appearance.fontFamily}
          placeholder="e.g. Goorm Sans"
          onCommit={(v) => setAppearanceSetting("fontFamily", v)}
        />
      </SettingItem>
    </SettingSection>
  );
}

// ── FontInput ──

function FontInput(props: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = createSignal(props.value);

  // Sync draft when the committed value changes externally (e.g. reset)
  createEffect(() => setDraft(props.value));

  const commit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    props.onCommit(trimmed);
  };

  return (
    <div class="flex flex-col gap-1.5">
      <input
        type="text"
        class={INPUT_BASE}
        style={{ "font-family": draft() }}
        value={draft()}
        placeholder={props.placeholder}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function EditorSection() {
  return (
    <SettingSection title="Editor">
      <SettingItem label="Tab size (WIP)" description="Number of spaces per tab character.">
        <Select
          options={TAB_SIZE_OPTIONS}
          value={String(settingsState.editor.tabSize)}
          onChange={(v) => setEditorSetting("tabSize", Number.parseInt(v, 10))}
          placeholder="Select tab size"
        />
      </SettingItem>
      <SettingItem label="Word wrap" description="Wrap long lines to fit the editor width.">
        <Switch
          checked={settingsState.editor.wordWrap}
          onChange={(v) => setEditorSetting("wordWrap", v)}
        />
      </SettingItem>
      <SettingItem label="Line numbers (WIP)" description="Show line numbers in the gutter.">
        <Switch
          checked={settingsState.editor.lineNumbers}
          onChange={(v) => setEditorSetting("lineNumbers", v)}
        />
      </SettingItem>
      <SettingItem label="Font size" description="Base text size used in the editor body.">
        <Select
          options={FONT_SIZE_OPTIONS}
          value={String(settingsState.editor.fontSize)}
          onChange={(v) => setEditorSetting("fontSize", Number.parseInt(v, 10))}
          placeholder="Select font size"
        />
      </SettingItem>
      <SettingItem label="Line height" description="Line spacing for editor paragraphs and text.">
        <Select
          options={LINE_HEIGHT_OPTIONS}
          value={String(settingsState.editor.lineHeight)}
          onChange={(v) => setEditorSetting("lineHeight", Number.parseFloat(v))}
          placeholder="Select line height"
        />
      </SettingItem>
      <SettingItem
        label="Editor font"
        description="Font used in the editor. Enter a CSS font-family name."
      >
        <FontInput
          value={settingsState.editor.fontFamily}
          placeholder="e.g. Goorm Sans"
          onCommit={(v) => setEditorSetting("fontFamily", v)}
        />
      </SettingItem>
      <SettingItem
        label="Monospace font"
        description="Monospace font used in the editor. Enter a CSS font-family name."
      >
        <FontInput
          value={settingsState.editor.fontMono}
          placeholder="e.g. Goorm Sans Code"
          onCommit={(v) => setEditorSetting("fontMono", v)}
        />
      </SettingItem>
    </SettingSection>
  );
}

function FilesSection() {
  return (
    <SettingSection title="Files & Links">
      <SettingItem
        label="Default new file location"
        description="Where new files are created by default."
      >
        <Select
          options={NEW_FILE_LOCATION_OPTIONS}
          value={settingsState.files.newFileLocation}
          onChange={(v) => setFilesSetting("newFileLocation", v)}
          placeholder="Select location"
        />
      </SettingItem>
      <SettingItem label="Deleted files (WIP)" description="What happens when you delete a file.">
        <Select
          options={DELETED_FILES_OPTIONS}
          value={settingsState.files.deletedFiles}
          onChange={(v) => setFilesSetting("deletedFiles", v)}
          placeholder="Select action"
        />
      </SettingItem>
    </SettingSection>
  );
}

function KeybindingsSection() {
  const [search, setSearch] = createSignal("");
  const [recording, setRecording] = createSignal<string | null>(null);

  // Get effective key binding for display (first key or undefined)
  const effectiveKey = (commandId: string): string | undefined => {
    const keys = getEffectiveKeys(commandId);
    return keys.length > 0 ? keys[0] : undefined;
  };

  const isOverridden = (commandId: string) => commandId in settingsState.keybindings.overrides;

  const filtered = createMemo(() => {
    const q = search().toLowerCase().trim();
    const all = getAllCommands();
    if (!q) return all;
    return all.filter(
      (reg) =>
        reg.contribution.label.toLowerCase().includes(q) ||
        (effectiveKey(reg.contribution.id) ?? "").toLowerCase().includes(q),
    );
  });

  const grouped = createMemo(() =>
    Object.entries(
      filtered().reduce<Record<string, RegisteredCommand[]>>((acc, reg) => {
        const g = reg.contribution.category ?? getCommandGroup(reg.contribution.id);
        (acc[g] ??= []).push(reg);
        return acc;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );

  function startRecording(commandId: string) {
    // Destroy the global keymap to prevent commands from firing during recording
    destroyKeymap();
    setRecording(commandId);
  }

  function cancelRecording() {
    setRecording(null);
    // Rebuild the keymap by triggering a no-op update (rebuildKeymap is internal)
    const cmds = getAllCommands();
    if (cmds.length > 0) {
      const id = cmds[0].contribution.id;
      updateCommandKeys(id, getEffectiveKeys(id));
    }
  }

  function handleCapture(commandId: string, keys: string) {
    setKeybindingOverride(commandId, keys);
    // updateCommandKeys persists runtime state AND triggers keymap rebuild
    updateCommandKeys(commandId, [keys]);
    setRecording(null);
  }

  function handleReset(commandId: string, e: MouseEvent) {
    e.stopPropagation();
    resetKeybindingOverride(commandId);
    // Empty array → userKeys = undefined → falls back to defaultKeys + rebuilds keymap
    updateCommandKeys(commandId, []);
  }

  return (
    <SettingSection title="Keybindings">
      <input
        type="search"
        class={INPUT_BASE}
        placeholder="Search keybindings..."
        value={search()}
        onInput={(e) => setSearch(e.currentTarget.value)}
      />
      <div class="mt-3 overflow-hidden rounded-md border border-border">
        <Show
          when={grouped().length > 0}
          fallback={
            <div class="px-4 py-8 text-center text-[0.8125rem] text-text-muted">
              No keybindings found.
            </div>
          }
        >
          <For each={grouped()}>
            {([group, cmds]) => (
              <div>
                <div class="border-b border-border bg-bg-secondary px-3 py-1.5 text-[0.6875rem] font-medium tracking-wider text-text-muted uppercase">
                  {group}
                </div>
                <For each={cmds}>
                  {(cmd, i) => (
                    <div
                      class={`flex cursor-pointer items-center justify-between gap-4 px-3 py-2 ${i() > 0 ? "border-t border-border" : ""} ${recording() === cmd.contribution.id ? "bg-ghost-hover" : "hover:bg-ghost-hover"}`}
                      onClick={() => {
                        if (recording() !== cmd.contribution.id)
                          startRecording(cmd.contribution.id);
                      }}
                    >
                      <span class="text-[0.8125rem] text-text-primary">
                        {cmd.contribution.label}
                      </span>
                      <Show
                        when={recording() === cmd.contribution.id}
                        fallback={
                          <div class="flex items-center gap-1.5">
                            <KeyBadge keys={effectiveKey(cmd.contribution.id)} />
                            <Show when={isOverridden(cmd.contribution.id)}>
                              <button
                                type="button"
                                class="flex size-4 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-text-disabled hover:text-text-primary"
                                title="Reset to default"
                                onClick={(e) => handleReset(cmd.contribution.id, e)}
                              >
                                ×
                              </button>
                            </Show>
                          </div>
                        }
                      >
                        <RecordingInput
                          onCapture={(keys) => handleCapture(cmd.contribution.id, keys)}
                          onCancel={cancelRecording}
                        />
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
    </SettingSection>
  );
}

function AboutSection() {
  return (
    <SettingSection title="About">
      <SettingItem label="Version" description="Current application version.">
        <span class="text-[0.8125rem] text-text-secondary">0.0.0-dev</span>
      </SettingItem>
      <SettingItem label="License" description="Open-source license.">
        <span class="text-[0.8125rem] text-text-secondary">MIT</span>
      </SettingItem>
    </SettingSection>
  );
}

function PluginsOverviewSection() {
  const [isRestarting, setIsRestarting] = createSignal(false);
  const plugins = () => Object.values(registryState.plugins);
  const isDisabled = (pluginId: string, canDisable: boolean) =>
    canDisable && settingsState.disabledPlugins.includes(pluginId);

  function setPluginDisabled(pluginId: string, canDisable: boolean, disabled: boolean): void {
    if (!canDisable) return;

    const next = disabled
      ? [...new Set([...settingsState.disabledPlugins, pluginId])]
      : settingsState.disabledPlugins.filter((id) => id !== pluginId);

    setTopLevelSetting("disabledPlugins", next);
  }

  async function restartApp(): Promise<void> {
    if (isRestarting()) return;

    setIsRestarting(true);

    try {
      await invoke("app_restart");
    } catch {
      setIsRestarting(false);
    }
  }

  return (
    <SettingSection title="Plugins">
      <div class="mb-3 flex items-center justify-between gap-3">
        <p class="text-[0.75rem] text-text-muted">
          Enable or disable plugins and inspect their current load status. Changes apply on next app
          launch.
        </p>
        <button
          type="button"
          class="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-[0.75rem] font-medium text-text-secondary transition-colors hover:bg-ghost-hover hover:text-text-primary disabled:cursor-default disabled:opacity-60"
          disabled={isRestarting()}
          onClick={() => void restartApp()}
        >
          {isRestarting() ? "Restarting..." : "Restart"}
        </button>
      </div>

      <div class="overflow-hidden rounded-md border border-border">
        <Show
          when={plugins().length > 0}
          fallback={
            <div class="px-4 py-8 text-center text-[0.8125rem] text-text-muted">
              No plugins registered.
            </div>
          }
        >
          <For each={plugins()}>
            {(plugin, i) => {
              const isActive = () => registryState.activated.includes(plugin.id);
              const isFailed = () => plugin.id in registryState.failed;
              const failedInfo = () => registryState.failed[plugin.id];
              const disabled = () => isDisabled(plugin.id, plugin.canDisable);

              return (
                <div class={i() > 0 ? "border-t border-border" : undefined}>
                  <div class="flex items-center justify-between gap-4 px-3 py-2.5">
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="text-[0.8125rem] font-medium text-text-primary">
                          {plugin.name}
                        </span>
                        <span class="text-[0.6875rem] text-text-muted">v{plugin.version}</span>
                      </div>
                      <Show when={plugin.description}>
                        <p class="mt-0.5 text-[0.75rem] text-text-muted">{plugin.description}</p>
                      </Show>
                      <Show when={isFailed()}>
                        <p class="mt-1 text-[0.6875rem] text-error">Error: {failedInfo()?.error}</p>
                      </Show>
                    </div>

                    <div class="flex shrink-0 items-center gap-3">
                      <div class="min-w-22 text-right">
                        <Show
                          when={!isFailed()}
                          fallback={
                            <span class="text-[0.6875rem] font-medium text-error">Failed</span>
                          }
                        >
                          <Show
                            when={plugin.canDisable ? !disabled() : true}
                            fallback={
                              <span class="text-[0.6875rem] text-text-muted">
                                Disabled next launch
                              </span>
                            }
                          >
                            <Show
                              when={!plugin.canDisable}
                              fallback={
                                <Show
                                  when={isActive()}
                                  fallback={
                                    <span class="text-[0.6875rem] text-text-muted">Inactive</span>
                                  }
                                >
                                  <span class="text-[0.6875rem] text-success">Active</span>
                                </Show>
                              }
                            >
                              <span class="text-[0.6875rem] text-text-muted">Required</span>
                            </Show>
                          </Show>
                        </Show>
                      </div>

                      <Switch
                        checked={!disabled()}
                        disabled={!plugin.canDisable}
                        onChange={(enabled) =>
                          setPluginDisabled(plugin.id, plugin.canDisable, !enabled)
                        }
                      />
                    </div>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </SettingSection>
  );
}

const SECTION_MAP: Record<string, Component> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  editor: EditorSection,
  files: FilesSection,
  keybindings: KeybindingsSection,
  plugins: PluginsOverviewSection,
  about: AboutSection,
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
      class={`flex h-8 w-full cursor-pointer items-center rounded-md border-none px-2.5 text-[0.8125rem] leading-normal transition-colors duration-100 ${props.class ?? ""} ${
        props.active
          ? "bg-ghost-selected text-text-primary"
          : "bg-transparent text-text-secondary hover:bg-ghost-hover hover:text-text-primary"
      }`}
      onClick={props.onClick}
    >
      {props.cat.label}
    </button>
  );
}

function PluginSettingsSection(props: { fillId: string }) {
  const fill = () =>
    slotRegistry.fills.settingsSection.find(
      (entry) => entry.id === props.fillId && entry.isActive(),
    );

  return (
    <Show
      when={fill()}
      fallback={
        <div class="rounded-md border border-border px-4 py-8 text-center text-[0.8125rem] text-text-muted">
          Plugin settings are unavailable.
        </div>
      }
    >
      {(activeFill) => (
        <ErrorBoundary
          fallback={(err: Error, reset: () => void) => (
            <PluginErrorUI pluginId={activeFill().pluginId} error={err} onReset={reset} />
          )}
        >
          <Suspense fallback={<PluginSkeleton />}>
            <Dynamic component={activeFill().component} />
          </Suspense>
        </ErrorBoundary>
      )}
    </Show>
  );
}

// ── Main Component ──

export default function SettingsView() {
  const [activeCategory, setActiveCategory] = createSignal("general");

  const primaryCategories = () => CATEGORIES.filter((c) => c.id !== "plugins" && c.id !== "about");
  const pluginCategories = () =>
    slotRegistry.fills.settingsSection
      .filter((fill) => fill.isActive())
      .map((fill) => ({ id: `plugin:${fill.id}`, label: fill.label }));
  const pluginsOverviewCategory = () => CATEGORIES.find((c) => c.id === "plugins") ?? null;
  const trailingCategories = () => CATEGORIES.filter((c) => c.id === "about");
  const allCategoryIds = () => [
    ...primaryCategories().map((category) => category.id),
    ...(pluginsOverviewCategory() ? ["plugins"] : []),
    ...pluginCategories().map((category) => category.id),
    ...trailingCategories().map((category) => category.id),
  ];
  const activePluginFillId = () =>
    activeCategory().startsWith("plugin:") ? activeCategory().slice("plugin:".length) : null;
  const sectionComponent = () => SECTION_MAP[activeCategory()];

  createEffect(() => {
    const category = activeCategory();
    if (!allCategoryIds().includes(category)) {
      setActiveCategory(primaryCategories()[0]?.id ?? "about");
    }
  });

  return (
    <div class="flex h-full">
      {/* ── Left Nav ── */}
      <nav class="flex w-45 shrink-0 flex-col border-r border-border bg-bg-secondary py-2">
        <ScrollArea class="flex-1 px-2" axis="y">
          {/* Main categories */}
          <For each={primaryCategories()}>
            {(cat) => (
              <NavButton
                cat={cat}
                active={activeCategory() === cat.id}
                onClick={() => setActiveCategory(cat.id)}
              />
            )}
          </For>

          <div class="m-2 h-px bg-border" />

          <Show when={pluginsOverviewCategory()}>
            {(cat) => (
              <NavButton
                cat={cat()}
                active={activeCategory() === cat().id}
                onClick={() => setActiveCategory(cat().id)}
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
                  onClick={() => setActiveCategory(cat.id)}
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
                onClick={() => setActiveCategory(cat.id)}
              />
            )}
          </For>
        </ScrollArea>
      </nav>

      {/* ── Right Content ── */}
      <div class="flex min-w-0 flex-1 flex-col">
        {/* Settings content */}
        <ScrollArea class="min-h-0 flex-1" axis="y" alwaysVisible>
          <div class="mx-auto max-w-140 px-5 py-2">
            <Show when={activePluginFillId()} fallback={<Dynamic component={sectionComponent()} />}>
              {(fillId) => <PluginSettingsSection fillId={fillId()} />}
            </Show>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
