// ── Plugin System Type Definitions ──
//
// Based on: Plugin System Design v1.3
// All plugin interfaces, contribution types, and the PluginContext API surface.

import type { Component } from "solid-js";

// ── ProseKit Types ──

import type { Editor, Extension } from "prosekit/core";

// ── Markdown Types ──

import type { Root } from "mdast";

import type {
  MdastToPmBlockHandler,
  MdastToPmInlineHandler,
  PmToMdastBlockHandler,
  PmToMdastInlineHandler,
  PmToMdastMarkHandler,
  RemarkPlugin,
} from "~/lib/markdown";
import type {
  ChecksumWriteResult,
  FileChangeEvent,
  FileEntry,
  FileReadResult,
} from "~/lib/vault_fs";
import type { IndexerStatus } from "~/plugins/builtin/core_indexer/types";
import type { TabType } from "~/stores/files";

// ── Utility ──

type Disposer = () => void;
type NodeViewMutationRecord = MutationRecord | { type: "selection"; target: Node };

/** JSON Schema draft-07 object. Used for settings validation and auto-UI. */
type JSONSchema = Record<string, unknown>;

// ── Registry State ──

interface PluginRegistryState {
  /** Registered plugin metadata (for UI rendering). */
  plugins: Record<string, PluginMeta>;
  /** IDs of successfully activated plugins. */
  activated: string[];
  /** IDs of user-disabled plugins. */
  disabled: string[];
  /** Plugins that failed to activate (error message + timestamp). */
  failed: Record<string, { error: string; timestamp: number }>;
}

interface PluginMeta {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  canDisable: boolean;
  hasViews: boolean;
  hasEditor: boolean;
  hasCommands: boolean;
  hasSettings: boolean;
  hasThemes: boolean;
}

// ── Plugin ──

interface KukuPlugin {
  // ── Identity ──
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Other plugin IDs that must be activated before this one. */
  dependencies?: string[];
  /** Whether the user may disable this plugin from settings. */
  canDisable?: boolean;

  // ── UI Contributions ──
  views?: ViewContribution[];
  themes?: ThemePack[];
  fonts?: FontPack;
  statusBar?: StatusBarContribution[];

  // ── Editor Contributions ──
  editor?: EditorContribution;

  // ── Functionality Contributions ──
  commands?: CommandContribution[];
  settings?: SettingsContribution;

  // ── Event Declarations ──
  events?: EventDeclaration[];

  // ── Lifecycle ──
  activate?(ctx: PluginContext): void | Disposer | Promise<void | Disposer>;
  deactivate?(): void | Promise<void>;
  reset?(): void | Promise<void>;
}

// ── Events ──

interface EventDeclaration {
  /** Event ID, e.g. 'ai-chat:response'. */
  id: string;
  /** Optional JSON Schema for runtime validation of event data. */
  schema?: JSONSchema;
  /** Whether this plugin emits, subscribes to, or does both for this event. */
  direction: "emit" | "subscribe" | "both";
}

/**
 * Built-in event map. Plugins extend this via declaration merging:
 *
 * ```ts
 * declare module '~/plugins/types' {
 *   interface PluginEventMap {
 *     'my-plugin:event': { data: string };
 *   }
 * }
 * ```
 */
interface PluginEventMap {
  "vault:opened": { rootPath: string };
  "vault:closed": void;
  "vault:fileCreated": { path: string };
  "vault:fileChanged": { path: string };
  "vault:fileDeleted": { path: string };
  "indexer:updated": IndexerStatus;
  "editor:saved": { filePath: string; content: string };
  "editor:activeChanged": { filePath: string | null };
}

// ── Editor ──

interface EditorContribution {
  /**
   * Factory that returns a ProseKit Extension.
   * Composed from defineNodeSpec(), defineMarkSpec(), defineCommands(), etc.
   * Called once during plugin activation; result is injected via editor.use().
   */
  extension: () => Extension;

  /**
   * SolidJS components to render as ProseMirror node views.
   * Keyed by node name (must match the name in defineNodeSpec).
   */
  nodeViews?: Record<string, NodeViewContribution>;

  /** SolidJS components to render as ProseMirror mark views. */
  markViews?: Record<string, MarkViewContribution>;

  /** Markdown ↔ PM JSON conversion handlers for this plugin's nodes/marks. */
  markdown?: MarkdownContribution;
}

/** Markdown conversion handlers contributed by a plugin. */
interface MarkdownContribution {
  /** Additional remark plugins for parsing/stringifying custom syntax. */
  remarkPlugins?: RemarkPlugin[];
  /**
   * Optional mdast tree transforms applied around the conversion pipeline.
   *
   * - `afterParse`  — runs on the mdast tree **after** remark parses the
   *   markdown string, **before** mdast → PM conversion.
   * - `beforeStringify` — runs on the mdast tree **after** PM → mdast
   *   conversion, **before** remark serialises back to markdown.
   */
  mdastTransform?: {
    afterParse?: (tree: Root) => Root;
    beforeStringify?: (tree: Root) => Root;
  };
  /** mdast → PM JSON handlers. */
  mdastToPm?: {
    block?: Record<string, MdastToPmBlockHandler>;
    inline?: Record<string, MdastToPmInlineHandler>;
  };
  /** PM JSON → mdast handlers. */
  pmToMdast?: {
    block?: Record<string, PmToMdastBlockHandler>;
    inline?: Record<string, PmToMdastInlineHandler>;
    mark?: Record<string, PmToMdastMarkHandler>;
  };
}

interface NodeViewContribution {
  component: Component;
  /** Wrapper DOM element tag (default: 'div'). */
  as?: string;
  /** Content DOM element tag for editable content area. */
  contentAs?: string;
  /** Return true for DOM events that should not be handled by the editor. */
  stopEvent?: (event: Event) => boolean;
  /** Return true for DOM mutations that ProseMirror can safely ignore. */
  ignoreMutation?: (mutation: NodeViewMutationRecord) => boolean | void;
}

interface MarkViewContribution {
  component: Component;
  as?: string;
}

// ── UI: Views ──

interface ViewContribution {
  /** Unique ID, e.g. 'graph-view.tab'. */
  id: string;
  /** Display label for tab/panel header. */
  label: string;
  /** Icon name (references IconPack). */
  icon?: string;
  /** Where this view renders in the layout. */
  location: ViewLocation;
  /** Sort order within the same slot (default: 100). */
  order?: number;
  /** Reactive — return false to hide this view. */
  isActive?: () => boolean;
  /** SolidJS component. May be wrapped with lazy() for code splitting. */
  component: Component;
  /** For centerTab slot: the Tab.type value this view handles. */
  tabType?: string;
  /** State save/restore for tab persistence across restarts. */
  getState?: () => Record<string, unknown>;
  setState?: (state: Record<string, unknown>) => void;
}

type ViewLocation =
  | { slot: "titleBarLeftAction" }
  | { slot: "titleBarRightAction" }
  | { slot: "centerTab" }
  | { slot: "overlay" }
  | { slot: "leftSection" }
  | { slot: "rightPanel" }
  | { slot: "bottomPanel" }
  | { slot: "settingsSection"; order?: number };

interface StatusBarContribution {
  id: string;
  component: Component;
  /** Sort order left-to-right (default: 100). */
  order?: number;
  /** Position within the status bar. */
  align?: "left" | "right";
  /** Reactive — return false to hide. */
  isActive?: () => boolean;
}

// ── UI: Theme ──

interface ThemePack {
  id: string;
  name: string;
  author?: string;
  variants: ThemeVariant[];
}

interface ThemeVariant {
  name: string;
  appearance: "light" | "dark";
  /** Required CSS variable values — maps 1:1 to the app's 14 base tokens. */
  colors: ThemeColors;
  /** Optional extended semantic tokens. */
  extended?: Partial<ThemeExtendedColors>;
  /** Optional editor syntax highlighting tokens. */
  syntax?: Record<string, string>;
}

interface ThemeColors {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgElevated: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentDim: string;
  listActive: string;
  listInactive: string;
  border: string;
}

interface ThemeExtendedColors {
  ghostHover: string;
  ghostSelected: string;
  error: string;
  warning: string;
  success: string;
  info: string;
}

// ── UI: Fonts ──

interface FontPack {
  id: string;
  name: string;
  fonts: {
    sans: FontDefinition;
    mono: FontDefinition;
  };
}

interface FontDefinition {
  family: string;
  faces: FontFaceRule[];
  fallbacks: string[];
}

interface FontFaceRule {
  weight: number | string;
  style: "normal" | "italic";
  src: string;
}

// ── Commands ──

interface CommandContribution {
  /** Unique ID. Convention: 'pluginId.actionName'. */
  id: string;
  /** Human-readable label shown in Command Palette. */
  label: string;
  /** Palette grouping: displayed as "Category: Label". */
  category?: string;
  /** Icon name (references IconPack). */
  icon?: string;

  /** Default key bindings in tinykeys format. User-overridable. */
  defaultKeys?: string[];
  /** Platform-specific key overrides (macOS). */
  mac?: string[];

  /**
   * Global execution function. Runs regardless of editor focus.
   * At least one of `execute` or `editorExecute` is required.
   */
  execute?: () => void;

  /**
   * Editor-context execution function. Receives the ProseKit Editor instance.
   * Called by the central KeyRegistry when a matching key is pressed in the editor.
   *
   * The `editor` parameter exposes full ProseMirror internals:
   * - `editor.commands.xxx()` — registered typed commands
   * - `editor.view` — ProseMirror EditorView (DOM, dispatch, state)
   * - `editor.state` — ProseMirror EditorState (doc, selection, schema)
   *
   * Return `true` if handled (will preventDefault), `false` to pass through.
   */
  editorExecute?: (editor: Editor) => boolean;

  /**
   * When true, this command fires even when an `<input>` or `<textarea>` has focus.
   * Use for truly global shortcuts like Command Palette ($mod+P) or Save ($mod+S).
   * Default: false — commands are suppressed in text input elements.
   */
  global?: boolean;

  /** Reactive: return false to hide from Command Palette. */
  when?: () => boolean;
  /** Reactive: return false to show as disabled (greyed out). */
  canExecute?: () => boolean;

  /** Menu placements for this command. */
  menus?: MenuPlacement[];
}

interface MenuPlacement {
  location: MenuLocation;
  group?: string;
  order?: number;
  when?: () => boolean;
}

type MenuLocation = "commandPalette" | "toolbar" | "editor/context" | "panel/title" | "statusBar";

// ── Settings ──

interface SettingsContribution<T extends Record<string, unknown> = Record<string, unknown>> {
  /** JSON Schema for runtime validation and auto-UI generation. Serializable. */
  schema: JSONSchema;
  /** Default values. TypeScript type is inferred from this object. */
  defaults: T;
  /** Settings version number for migrations. */
  version: number;
  /** Migration functions keyed by target version. */
  migrations?: Record<number, (old: Record<string, unknown>) => Partial<T>>;

  /** Per-field UI hints for auto-generated settings forms. */
  meta?: Partial<Record<keyof T, SettingsFieldMeta>>;

  /**
   * Custom settings component (escape hatch).
   * When provided, replaces the auto-generated UI entirely.
   */
  component?: Component<{
    settings: T;
    set: <K extends keyof T>(key: K, value: T[K]) => void;
  }>;
}

interface SettingsFieldMeta {
  label: string;
  description?: string;
  order?: number;
  /** Input control type hint for auto-UI. */
  control?: "text" | "number" | "toggle" | "select" | "color" | "path";
  /** For 'select' control: available choices. */
  options?: { value: string; label: string }[];
}

// ── PluginContext ──

/**
 * API surface passed to `plugin.activate(ctx)`.
 * Gateway to app stores, editor, file system, and inter-plugin communication.
 * All registrations made through ctx are auto-tracked and disposed on deactivate.
 */
interface PluginContext {
  /** This plugin's ID. */
  pluginId: string;

  // ── Paths (~/.kuku) ──
  paths: {
    /** App root data directory: ~/.kuku */
    appRoot: string;
    /** This plugin's data directory: ~/.kuku/plugins/{pluginId} */
    pluginData: string;
    /** This plugin's settings file: ~/.kuku/plugins/{pluginId}/settings.json */
    pluginSettings: string;
  };

  // ── File System (Rust-backed, sandboxed) ──
  /**
   * Sandboxed file system access. **Relative paths only** (plugin data root).
   * Example: `ctx.fs.readFile('data/cache.json')`
   *
   * All paths are resolved by a Rust backend that:
   * 1. Joins pluginId + relativePath → ~/.kuku/plugins/{pluginId}/{path}
   * 2. Lexically validates each path component (blocks `..` escape)
   * 3. Only performs I/O if the resolved path stays within the sandbox
   *
   * For vault file writes, use `ctx.vault.writeFile()` instead (triggers events).
   */
  fs: {
    readFile(relativePath: string): Promise<string>;
    writeFile(relativePath: string, content: string): Promise<void>;
    readBinary(relativePath: string): Promise<Uint8Array>;
    writeBinary(relativePath: string, data: Uint8Array): Promise<void>;
    exists(relativePath: string): Promise<boolean>;
    mkdir(relativePath: string): Promise<void>;
    readDir(relativePath: string): Promise<string[]>;
    remove(relativePath: string): Promise<void>;
  };

  // shell: removed in v1.3. Will return in v2 with manifest-based permission model.

  // ── Vault (user document files) ──
  vault: {
    readonly rootPath: string | null;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    readFileWithChecksum(path: string): Promise<FileReadResult>;
    writeFileWithChecksum(
      path: string,
      content: string,
      checksum: string,
    ): Promise<ChecksumWriteResult>;
    listFiles(path?: string): Promise<FileEntry[]>;
    exists(path: string): Promise<boolean>;
    onFileChanged(callback: (event: FileChangeEvent) => void): Promise<Disposer>;
  };

  // ── Editor ──
  editor: {
    /**
     * Active ProseKit Editor instance, or null if no editor is mounted.
     * Exposes full ProseMirror access:
     * - `instance.view` — EditorView
     * - `instance.state` — EditorState
     * - `instance.schema` — Schema
     */
    readonly instance: Editor | null;
    /** File path of the currently edited document. */
    readonly activeFilePath: string | null;
    /** Inject a dynamic extension into the editor. Returns a disposer (auto-tracked). */
    use(extension: Extension): Disposer;
    /** Whether there is a non-empty text selection in the editor. */
    readonly hasSelection: boolean;
    /** Plain text content of the current document. */
    getTextContent(): string | null;
    /** Text of the current selection, or null if collapsed. */
    getSelectedText(): string | null;
  };

  // ── Tabs ──
  tabs: {
    readonly activeTab: unknown;
    readonly allTabs: readonly unknown[];
    open(fileName: string, filePath?: string | null, type?: TabType): void;
    close(tabId: string): void;
  };

  // ── Layout ──
  layout: {
    readonly leftPanelOpen: boolean;
    readonly rightPanelOpen: boolean;
    readonly bottomPanelOpen: boolean;
    toggleLeft(): void;
    toggleRight(): void;
    toggleBottom(): void;
  };

  // ── Commands ──
  commands: {
    /** Register a command at runtime. Disposer is auto-tracked. */
    register(cmd: CommandContribution): Disposer;
    /** Execute a command by ID. Returns true if handled. */
    execute(commandId: string): boolean;
  };

  // ── Events (typed, inter-plugin communication) ──
  events: {
    emit<K extends keyof PluginEventMap>(event: K, data: PluginEventMap[K]): void;
    emit(event: string, data?: unknown): void;
    on<K extends keyof PluginEventMap>(
      event: K,
      handler: (data: PluginEventMap[K]) => void,
    ): Disposer;
    on(event: string, handler: (data: unknown) => void): Disposer;
  };

  // ── Services (strong coupling, requires dependency declaration) ──
  services: {
    register(name: string, service: unknown): Disposer;
    get(name: string): unknown;
  };

  // ── Context Keys (for reactive `when` conditions) ──
  context: {
    set(key: string, value: unknown): void;
    get(key: string): unknown;
  };

  /** Register a disposer to be called automatically on plugin deactivate. */
  track(disposer: Disposer): void;
}

// ── Slot System ──

type SlotName =
  | "titleBarLeftAction"
  | "titleBarRightAction"
  | "centerTab"
  | "overlay"
  | "leftSection"
  | "rightPanel"
  | "bottomPanel"
  | "bottomBar"
  | "settingsSection";

interface SlotFill {
  id: string;
  pluginId: string;
  slot: SlotName;
  label: string;
  icon?: string;
  component: Component;
  order: number;
  isActive: () => boolean;
  /** centerTab only. */
  tabType?: string;
  /** bottomBar only. */
  align?: "left" | "right";
}

// ── Exports ──

export type {
  // Utility
  Disposer,
  JSONSchema,
  // Registry
  PluginRegistryState,
  PluginMeta,
  // Plugin
  KukuPlugin,
  // Events
  EventDeclaration,
  PluginEventMap,
  // Editor
  EditorContribution,
  NodeViewContribution,
  MarkViewContribution,
  // Editor types (re-export placeholders until ProseKit is installed)
  Editor,
  Extension,
  // UI: Views
  ViewContribution,
  ViewLocation,
  StatusBarContribution,
  // UI: Theme
  ThemePack,
  ThemeVariant,
  ThemeColors,
  ThemeExtendedColors,
  // UI: Fonts
  FontPack,
  FontDefinition,
  FontFaceRule,
  // Commands
  CommandContribution,
  MenuPlacement,
  MenuLocation,
  // Settings
  SettingsContribution,
  SettingsFieldMeta,
  // Context
  PluginContext,
  // Markdown
  MarkdownContribution,
  // Slots
  SlotName,
  SlotFill,
};
