import { type Component, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

import ScrollArea from "~/components/scroll_area";
import SettingItem from "~/components/settings/setting_item";
import SettingSection from "~/components/settings/setting_section";
import { Select, Switch } from "~/components/ui";
import {
  setAppearanceSetting,
  setEditorSetting,
  setFilesSetting,
  setGeneralSetting,
  settingsState,
} from "~/stores/settings";
import { getAllBindings, getAllCommands, type Command } from "~/keybindings";

// ── Types ──

interface NavCategory {
  id: string;
  label: string;
  group?: string;
}

// ── Data ──

const CATEGORIES: NavCategory[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "files", label: "Files & Links" },
  { id: "keybindings", label: "Keybindings" },
  { id: "plugins", label: "Plugins", group: "Advanced" },
  { id: "about", label: "About", group: "Advanced" },
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
      <SettingItem label="Auto-save (WIP)" description="Automatically save changes after editing.">
        <Switch
          checked={settingsState.general.autoSave}
          onChange={(v) => setGeneralSetting("autoSave", v)}
        />
      </SettingItem>
      <SettingItem
        label="Spell check (WIP)"
        description="Check spelling while typing in the editor."
      >
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
      <SettingItem label="Word wrap (WIP)" description="Wrap long lines to fit the editor width.">
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
        label="Default new file location (WIP)"
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

  const commands = getAllCommands();
  const bindingMap = new Map(getAllBindings().map((b) => [b.commandId, b.keys]));

  const filtered = createMemo(() => {
    const q = search().toLowerCase().trim();
    if (!q) return commands;
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(q) ||
        (bindingMap.get(cmd.id) ?? "").toLowerCase().includes(q),
    );
  });

  const grouped = createMemo(() =>
    Object.entries(
      filtered().reduce<Record<string, Command[]>>((acc, cmd) => {
        const g = getCommandGroup(cmd.id);
        (acc[g] ??= []).push(cmd);
        return acc;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );

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
                      class={`flex items-center justify-between gap-4 px-3 py-2 hover:bg-ghost-hover ${i() > 0 ? "border-t border-border" : ""}`}
                    >
                      <span class="text-[0.8125rem] text-text-primary">{cmd.label}</span>
                      <KeyBadge keys={bindingMap.get(cmd.id)} />
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

function PluginsSection() {
  return (
    <SettingSection title="Plugins">
      <SettingItem label="Plugin system" description="The plugin system is under development.">
        <p class="text-[0.75rem] text-text-muted">Coming soon.</p>
      </SettingItem>
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

const SECTION_MAP: Record<string, Component> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  editor: EditorSection,
  files: FilesSection,
  keybindings: KeybindingsSection,
  plugins: PluginsSection,
  about: AboutSection,
};

// ── Nav Button ──

function NavButton(props: { cat: NavCategory; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      class={`flex h-8 w-full cursor-pointer items-center rounded-md border-none px-2.5 text-[0.8125rem] leading-normal transition-colors duration-100 ${
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

// ── Main Component ──

export default function SettingsView() {
  const [activeCategory, setActiveCategory] = createSignal("general");

  const mainCategories = () => CATEGORIES.filter((c) => !c.group);
  const advancedCategories = () => CATEGORIES.filter((c) => c.group === "Advanced");

  const sectionComponent = () => SECTION_MAP[activeCategory()];

  return (
    <div class="flex h-full">
      {/* ── Left Nav ── */}
      <nav class="flex w-45 shrink-0 flex-col border-r border-border bg-bg-secondary py-2">
        <ScrollArea class="flex-1 px-2" axis="y">
          {/* Main categories */}
          <For each={mainCategories()}>
            {(cat) => (
              <NavButton
                cat={cat}
                active={activeCategory() === cat.id}
                onClick={() => setActiveCategory(cat.id)}
              />
            )}
          </For>

          {/* Separator */}
          <div class="m-2 h-px bg-border" />

          {/* Advanced categories */}
          <For each={advancedCategories()}>
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
            <Dynamic component={sectionComponent()} />
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
