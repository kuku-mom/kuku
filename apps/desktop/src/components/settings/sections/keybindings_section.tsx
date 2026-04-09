import { createMemo, createSignal, For, Show } from "solid-js";

import {
  SettingsCard,
  SettingsInput,
  SettingsListRow,
  SettingsPanel,
} from "~/components/settings/settings_blocks";
import {
  destroyKeymap,
  getAllCommands,
  getEffectiveKeys,
  updateCommandKeys,
  type RegisteredCommand,
} from "~/plugins/commands";
import { resetKeybindingOverride, setKeybindingOverride, settingsState } from "~/stores/settings";

const IS_MAC =
  navigator.platform.toLowerCase().includes("mac") ||
  navigator.userAgent.toLowerCase().includes("mac");

const COMMAND_GROUP_LABELS: Record<string, string> = {
  app: "Application",
  editor: "Editor",
  graph: "Graph",
  panel: "Panel",
  tab: "Tab",
};

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

function getCommandGroup(id: string): string {
  const prefix = id.split(".")[0] ?? "";
  return COMMAND_GROUP_LABELS[prefix] ?? "Other";
}

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

  if (parts.length === 0) return null;

  parts.push(event.code);
  return parts.join("+");
}

function KeyBadge(props: { keys?: string }) {
  return (
    <Show when={props.keys} fallback={<span class="text-[0.6875rem] text-text-disabled">—</span>}>
      {(keys) => (
        <div class="flex shrink-0 items-center gap-1">
          <For each={parseKeys(keys())}>
            {(key) => (
              <kbd class="inline-flex min-w-5 items-center justify-center rounded-xs border border-border bg-bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none text-text-secondary">
                {key}
              </kbd>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}

function RecordingInput(props: { onCapture: (keys: string) => void; onCancel: () => void }) {
  let ref!: HTMLInputElement;

  queueMicrotask(() => ref?.focus());

  return (
    <input
      ref={ref}
      type="text"
      class="w-36 rounded-xs border border-border-focused bg-bg-secondary px-2.5 py-0.5 text-[0.6875rem] text-text-muted outline-none placeholder:text-text-placeholder"
      placeholder="Press shortcut..."
      readOnly
      onKeyDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          props.onCancel();
          return;
        }
        const captured = captureKeybinding(event);
        if (captured) props.onCapture(captured);
      }}
      onBlur={props.onCancel}
    />
  );
}

function KeybindingsSection() {
  const [search, setSearch] = createSignal("");
  const [recording, setRecording] = createSignal<string | null>(null);

  const effectiveKey = (commandId: string): string | undefined => {
    const keys = getEffectiveKeys(commandId);
    return keys.length > 0 ? keys[0] : undefined;
  };

  const isOverridden = (commandId: string) => commandId in settingsState.keybindings.overrides;

  const filtered = createMemo(() => {
    const query = search().toLowerCase().trim();
    const all = getAllCommands();
    if (!query) return all;

    return all.filter(
      (registered) =>
        registered.contribution.label.toLowerCase().includes(query) ||
        (effectiveKey(registered.contribution.id) ?? "").toLowerCase().includes(query),
    );
  });

  const grouped = createMemo(() =>
    Object.entries(
      filtered().reduce<Record<string, RegisteredCommand[]>>((acc, registered) => {
        const group =
          registered.contribution.category ?? getCommandGroup(registered.contribution.id);
        (acc[group] ??= []).push(registered);
        return acc;
      }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );

  function startRecording(commandId: string) {
    destroyKeymap();
    setRecording(commandId);
  }

  function cancelRecording() {
    setRecording(null);
    const commands = getAllCommands();
    if (commands.length > 0) {
      const id = commands[0].contribution.id;
      updateCommandKeys(id, getEffectiveKeys(id));
    }
  }

  function handleCapture(commandId: string, keys: string) {
    setKeybindingOverride(commandId, keys);
    updateCommandKeys(commandId, [keys]);
    setRecording(null);
  }

  function handleReset(commandId: string, event: MouseEvent) {
    event.stopPropagation();
    resetKeybindingOverride(commandId);
    updateCommandKeys(commandId, []);
  }

  return (
    <SettingsPanel
      title="Keybindings"
      description="Search commands and override their shortcuts."
      anchor="keybindings"
    >
      <SettingsInput
        type="search"
        placeholder="Search keybindings..."
        value={search()}
        onInput={(event) => setSearch(event.currentTarget.value)}
      />

      <Show
        when={grouped().length > 0}
        fallback={
          <SettingsCard tone="subtle">
            <div class="text-center text-[0.8125rem] text-text-muted">No keybindings found.</div>
          </SettingsCard>
        }
      >
        <div class="space-y-3">
          <For each={grouped()}>
            {([group, commands]) => (
              <SettingsCard title={group} titleClass="text-[0.6875rem]">
                <div class="space-y-2">
                  <For each={commands}>
                    {(command) => (
                      <div
                        onClick={() => {
                          if (recording() !== command.contribution.id) {
                            startRecording(command.contribution.id);
                          }
                        }}
                      >
                        <SettingsListRow
                          class={
                            recording() === command.contribution.id
                              ? "cursor-pointer bg-ghost-hover"
                              : "cursor-pointer hover:bg-ghost-hover"
                          }
                          title={<span>{command.contribution.label}</span>}
                          action={
                            <Show
                              when={recording() === command.contribution.id}
                              fallback={
                                <div class="flex items-center gap-1.5">
                                  <KeyBadge keys={effectiveKey(command.contribution.id)} />
                                  <Show when={isOverridden(command.contribution.id)}>
                                    <button
                                      type="button"
                                      class="flex size-4 cursor-pointer items-center justify-center rounded-xs border-none bg-transparent text-text-disabled hover:text-text-primary"
                                      title="Reset to default"
                                      onClick={(event) =>
                                        handleReset(command.contribution.id, event)
                                      }
                                    >
                                      ×
                                    </button>
                                  </Show>
                                </div>
                              }
                            >
                              <RecordingInput
                                onCapture={(keys) => handleCapture(command.contribution.id, keys)}
                                onCancel={cancelRecording}
                              />
                            </Show>
                          }
                        />
                      </div>
                    )}
                  </For>
                </div>
              </SettingsCard>
            )}
          </For>
        </div>
      </Show>
    </SettingsPanel>
  );
}

export { KeybindingsSection };
