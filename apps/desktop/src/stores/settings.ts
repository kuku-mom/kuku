import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";

// ── Types ──

export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";
export type UiLanguage = "system" | "en" | "ko" | "ja";

interface GeneralSettings {
  autoSave: boolean;
  spellCheck: boolean;
  typingIndicator: boolean;
}

interface AppearanceSettings {
  theme: ThemePreference;
  language: UiLanguage;
  /** UI font — CSS font-family name, e.g. "Goorm Sans" */
  fontFamily: string;
}

interface EditorSettings {
  tabSize: number;
  /** General font for the editor — CSS font-family name, e.g. "Goorm Sans" */
  fontFamily: string;
  /** Monospace font for the editor — CSS font-family name, e.g. "Goorm Sans Code" */
  fontMono: string;
  fontSize: number;
  lineHeight: number;
}

interface FilesSettings {
  newFileLocation: string;
  deletedFiles: string;
}

interface KeybindingsSettings {
  /** commandId → custom key combo (tinykeys format) */
  overrides: Record<string, string>;
}

interface Settings {
  lastOpenedVault: string | null;
  disabledPlugins: string[];
  disabledPluginDefaultsApplied: string[];
  general: GeneralSettings;
  appearance: AppearanceSettings;
  editor: EditorSettings;
  files: FilesSettings;
  keybindings: KeybindingsSettings;
}

type SettingSection = "general" | "appearance" | "editor" | "files" | "keybindings";
type TopLevelSettingKey = "lastOpenedVault" | "disabledPlugins";

interface SettingsPatch {
  lastOpenedVault?: string | null;
  disabledPlugins?: string[];
  disabledPluginDefaultsApplied?: string[];
  general?: Partial<GeneralSettings>;
  appearance?: Partial<AppearanceSettings>;
  editor?: Partial<EditorSettings>;
  files?: Partial<FilesSettings>;
  keybindings?: Partial<KeybindingsSettings>;
}

interface SettingsCache {
  theme?: ThemePreference;
  language?: UiLanguage;
  fontUi?: string;
  fontEditor?: string;
  fontMono?: string;
}

interface PersistedSettings {
  last_opened_vault?: string;
  disabled_plugins?: string[];
  disabled_plugin_defaults_applied?: string[];
  general?: {
    auto_save?: boolean;
    spell_check?: boolean;
    typing_indicator?: boolean;
  };
  appearance?: {
    theme?: ThemePreference;
    language?: UiLanguage;
    font_family?: string;
  };
  editor?: {
    tab_size?: number;
    font_family?: string;
    font_mono?: string;
    font_size?: number;
    line_height?: number;
  };
  files?: {
    new_file_location?: string;
    deleted_files?: string;
  };
  keybindings?: {
    overrides?: Record<string, string>;
  };
}

// ── Defaults ──

const DEFAULT_DISABLED_PLUGINS = ["voxel-graph"];

const DEFAULTS: Settings = {
  lastOpenedVault: null,
  disabledPlugins: ["voxel-graph"],
  disabledPluginDefaultsApplied: [],
  general: {
    autoSave: true,
    spellCheck: false,
    typingIndicator: true,
  },
  appearance: {
    theme: "system",
    language: "system",
    fontFamily: "Goorm Sans",
  },
  editor: {
    tabSize: 4,
    fontFamily: "Goorm Sans",
    fontMono: "Goorm Sans Code",
    fontSize: 16,
    lineHeight: 1.7,
  },
  files: {
    newFileLocation: "root",
    deletedFiles: "trash",
  },
  keybindings: {
    overrides: {},
  },
};

// ── Persistence ──

const STORE_KEY = "settings-cache";
const LEGACY_STORE_KEY = "app-settings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStorage(): Storage | null {
  if (typeof localStorage === "undefined" || localStorage === null) return null;
  if (
    typeof localStorage.getItem !== "function" ||
    typeof localStorage.setItem !== "function" ||
    typeof localStorage.removeItem !== "function"
  ) {
    return null;
  }
  return localStorage;
}

function cloneSettings(settings: Settings): Settings {
  return structuredClone(settings);
}

function readStorageJson(key: string): unknown {
  const raw = getStorage()?.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asThemePreference(value: unknown): ThemePreference | undefined {
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

function asUiLanguage(value: unknown): UiLanguage | undefined {
  return value === "system" || value === "en" || value === "ko" || value === "ja"
    ? value
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string"))];
}

function asOverrides(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const overrides: Record<string, string> = {};

  for (const [commandId, binding] of Object.entries(value)) {
    if (typeof binding === "string") {
      overrides[commandId] = binding;
    }
  }

  return overrides;
}

function mergeSettings(base: Settings, patch?: SettingsPatch | null): Settings {
  if (!patch) return cloneSettings(base);
  return {
    lastOpenedVault:
      patch.lastOpenedVault !== undefined ? patch.lastOpenedVault : base.lastOpenedVault,
    disabledPlugins: patch.disabledPlugins ?? base.disabledPlugins,
    disabledPluginDefaultsApplied:
      patch.disabledPluginDefaultsApplied ?? base.disabledPluginDefaultsApplied,
    general: { ...base.general, ...patch.general },
    appearance: { ...base.appearance, ...patch.appearance },
    editor: { ...base.editor, ...patch.editor },
    files: { ...base.files, ...patch.files },
    keybindings: {
      ...base.keybindings,
      ...patch.keybindings,
      overrides: patch.keybindings?.overrides ?? base.keybindings.overrides,
    },
  };
}

function cachePatchFromObject(value: unknown): SettingsPatch | null {
  if (!isRecord(value)) return null;

  const appearance: Partial<AppearanceSettings> = {};
  const editor: Partial<EditorSettings> = {};

  const theme = asThemePreference(value.theme);
  if (theme) appearance.theme = theme;

  const language = asUiLanguage(value.language);
  if (language) appearance.language = language;

  const fontUi = asNonEmptyString(value.fontUi);
  if (fontUi) appearance.fontFamily = fontUi;

  const fontEditor = asNonEmptyString(value.fontEditor);
  if (fontEditor) editor.fontFamily = fontEditor;

  const fontMono = asNonEmptyString(value.fontMono);
  if (fontMono) editor.fontMono = fontMono;

  const patch: SettingsPatch = {};
  if (Object.keys(appearance).length > 0) patch.appearance = appearance;
  if (Object.keys(editor).length > 0) patch.editor = editor;
  return Object.keys(patch).length > 0 ? patch : null;
}

function patchFromLegacySettings(value: unknown): SettingsPatch | null {
  if (!isRecord(value)) return null;

  const patch: SettingsPatch = {};
  const lastOpenedVault = value.lastOpenedVault;
  if (typeof lastOpenedVault === "string" || lastOpenedVault === null) {
    patch.lastOpenedVault = lastOpenedVault;
  }

  const disabledPlugins = asStringArray(value.disabledPlugins);
  if (disabledPlugins) patch.disabledPlugins = disabledPlugins;
  const disabledPluginDefaultsApplied = asStringArray(value.disabledPluginDefaultsApplied);
  if (disabledPluginDefaultsApplied) {
    patch.disabledPluginDefaultsApplied = disabledPluginDefaultsApplied;
  }

  const generalRaw = isRecord(value.general) ? value.general : null;
  if (generalRaw) {
    const general: Partial<GeneralSettings> = {};
    const autoSave = asBoolean(generalRaw.autoSave);
    if (autoSave !== undefined) general.autoSave = autoSave;
    const spellCheck = asBoolean(generalRaw.spellCheck);
    if (spellCheck !== undefined) general.spellCheck = spellCheck;
    const typingIndicator = asBoolean(generalRaw.typingIndicator ?? generalRaw.typing_indicator);
    if (typingIndicator !== undefined) general.typingIndicator = typingIndicator;
    if (Object.keys(general).length > 0) patch.general = general;
  }

  const appearanceRaw = isRecord(value.appearance) ? value.appearance : null;
  if (appearanceRaw) {
    const appearance: Partial<AppearanceSettings> = {};
    const theme = asThemePreference(appearanceRaw.theme);
    if (theme) appearance.theme = theme;
    const language = asUiLanguage(appearanceRaw.language);
    if (language) appearance.language = language;
    const fontFamily = asNonEmptyString(appearanceRaw.fontFamily);
    if (fontFamily) appearance.fontFamily = fontFamily;
    if (Object.keys(appearance).length > 0) patch.appearance = appearance;
  }

  const editorRaw = isRecord(value.editor) ? value.editor : null;
  if (editorRaw) {
    const editor: Partial<EditorSettings> = {};
    const tabSize = asPositiveInteger(editorRaw.tabSize);
    if (tabSize !== undefined) editor.tabSize = tabSize;
    const fontFamily = asNonEmptyString(editorRaw.fontFamily);
    if (fontFamily) editor.fontFamily = fontFamily;
    const fontMono = asNonEmptyString(editorRaw.fontMono);
    if (fontMono) editor.fontMono = fontMono;
    const fontSize = asPositiveNumber(editorRaw.fontSize);
    if (fontSize !== undefined) editor.fontSize = fontSize;
    const lineHeight = asPositiveNumber(editorRaw.lineHeight);
    if (lineHeight !== undefined) editor.lineHeight = lineHeight;
    if (Object.keys(editor).length > 0) patch.editor = editor;
  }

  const filesRaw = isRecord(value.files) ? value.files : null;
  if (filesRaw) {
    const files: Partial<FilesSettings> = {};
    const newFileLocation = asNonEmptyString(filesRaw.newFileLocation);
    if (newFileLocation) files.newFileLocation = newFileLocation;
    const deletedFiles = asNonEmptyString(filesRaw.deletedFiles);
    if (deletedFiles) files.deletedFiles = deletedFiles;
    if (Object.keys(files).length > 0) patch.files = files;
  }

  const keybindingsRaw = isRecord(value.keybindings) ? value.keybindings : null;
  if (keybindingsRaw) {
    const overrides = asOverrides(keybindingsRaw.overrides);
    if (overrides) patch.keybindings = { overrides };
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function patchFromPersistedSettings(value: unknown): SettingsPatch | null {
  if (!isRecord(value)) return null;

  const patch: SettingsPatch = {};
  const lastOpenedVault = value.last_opened_vault;
  if (typeof lastOpenedVault === "string" || lastOpenedVault === null) {
    patch.lastOpenedVault = lastOpenedVault;
  }

  const disabledPlugins = asStringArray(value.disabled_plugins);
  if (disabledPlugins) patch.disabledPlugins = disabledPlugins;
  const disabledPluginDefaultsApplied = asStringArray(value.disabled_plugin_defaults_applied);
  if (disabledPluginDefaultsApplied) {
    patch.disabledPluginDefaultsApplied = disabledPluginDefaultsApplied;
  }

  const generalRaw = isRecord(value.general) ? value.general : null;
  if (generalRaw) {
    const general: Partial<GeneralSettings> = {};
    const autoSave = asBoolean(generalRaw.auto_save);
    if (autoSave !== undefined) general.autoSave = autoSave;
    const spellCheck = asBoolean(generalRaw.spell_check);
    if (spellCheck !== undefined) general.spellCheck = spellCheck;
    const typingIndicator = asBoolean(generalRaw.typing_indicator);
    if (typingIndicator !== undefined) general.typingIndicator = typingIndicator;
    if (Object.keys(general).length > 0) patch.general = general;
  }

  const appearanceRaw = isRecord(value.appearance) ? value.appearance : null;
  if (appearanceRaw) {
    const appearance: Partial<AppearanceSettings> = {};
    const theme = asThemePreference(appearanceRaw.theme);
    if (theme) appearance.theme = theme;
    const language = asUiLanguage(appearanceRaw.language);
    if (language) appearance.language = language;
    const fontFamily = asNonEmptyString(appearanceRaw.font_family);
    if (fontFamily) appearance.fontFamily = fontFamily;
    if (Object.keys(appearance).length > 0) patch.appearance = appearance;
  }

  const editorRaw = isRecord(value.editor) ? value.editor : null;
  if (editorRaw) {
    const editor: Partial<EditorSettings> = {};
    const tabSize = asPositiveInteger(editorRaw.tab_size);
    if (tabSize !== undefined) editor.tabSize = tabSize;
    const fontFamily = asNonEmptyString(editorRaw.font_family);
    if (fontFamily) editor.fontFamily = fontFamily;
    const fontMono = asNonEmptyString(editorRaw.font_mono);
    if (fontMono) editor.fontMono = fontMono;
    const fontSize = asPositiveNumber(editorRaw.font_size);
    if (fontSize !== undefined) editor.fontSize = fontSize;
    const lineHeight = asPositiveNumber(editorRaw.line_height);
    if (lineHeight !== undefined) editor.lineHeight = lineHeight;
    if (Object.keys(editor).length > 0) patch.editor = editor;
  }

  const filesRaw = isRecord(value.files) ? value.files : null;
  if (filesRaw) {
    const files: Partial<FilesSettings> = {};
    const newFileLocation = asNonEmptyString(filesRaw.new_file_location);
    if (newFileLocation) files.newFileLocation = newFileLocation;
    const deletedFiles = asNonEmptyString(filesRaw.deleted_files);
    if (deletedFiles) files.deletedFiles = deletedFiles;
    if (Object.keys(files).length > 0) patch.files = files;
  }

  const keybindingsRaw = isRecord(value.keybindings) ? value.keybindings : null;
  if (keybindingsRaw) {
    const overrides = asOverrides(keybindingsRaw.overrides);
    if (overrides) patch.keybindings = { overrides };
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function toPersistedSettings(settings: Settings): PersistedSettings {
  const persisted: PersistedSettings = {
    disabled_plugins: [...settings.disabledPlugins],
    disabled_plugin_defaults_applied: [...settings.disabledPluginDefaultsApplied],
    general: {
      auto_save: settings.general.autoSave,
      spell_check: settings.general.spellCheck,
      typing_indicator: settings.general.typingIndicator,
    },
    appearance: {
      theme: settings.appearance.theme,
      language: settings.appearance.language,
      font_family: settings.appearance.fontFamily,
    },
    editor: {
      tab_size: settings.editor.tabSize,
      font_family: settings.editor.fontFamily,
      font_mono: settings.editor.fontMono,
      font_size: settings.editor.fontSize,
      line_height: settings.editor.lineHeight,
    },
    files: {
      new_file_location: settings.files.newFileLocation,
      deleted_files: settings.files.deletedFiles,
    },
    keybindings: {
      overrides: { ...settings.keybindings.overrides },
    },
  };

  if (settings.lastOpenedVault) {
    persisted.last_opened_vault = settings.lastOpenedVault;
  }

  return persisted;
}

function cacheFromSettings(settings: Settings): SettingsCache {
  return {
    theme: settings.appearance.theme,
    language: settings.appearance.language,
    fontUi: settings.appearance.fontFamily,
    fontEditor: settings.editor.fontFamily,
    fontMono: settings.editor.fontMono,
  };
}

function applyDefaultDisabledPlugins(settings: Settings): { settings: Settings; changed: boolean } {
  const disabled = new Set(settings.disabledPlugins);
  const applied = new Set(settings.disabledPluginDefaultsApplied);
  let changed = false;

  for (const pluginId of DEFAULT_DISABLED_PLUGINS) {
    if (applied.has(pluginId)) continue;
    applied.add(pluginId);
    disabled.add(pluginId);
    changed = true;
  }

  if (!changed) return { settings, changed: false };
  return {
    settings: {
      ...settings,
      disabledPlugins: [...disabled],
      disabledPluginDefaultsApplied: [...applied],
    },
    changed: true,
  };
}

function loadSettingsSync(): Settings {
  const cachePatch =
    cachePatchFromObject(readStorageJson(STORE_KEY)) ??
    cachePatchFromObject(
      (() => {
        const legacyPatch = patchFromLegacySettings(readStorageJson(LEGACY_STORE_KEY));
        if (!legacyPatch) return null;
        const fallback = mergeSettings(DEFAULTS, legacyPatch);
        return cacheFromSettings(fallback);
      })(),
    );

  return applyDefaultDisabledPlugins(mergeSettings(DEFAULTS, cachePatch)).settings;
}

function snapshotSettings(): Settings {
  return cloneSettings(unwrap(settingsState));
}

function updateLocalStorageCache(settings: Settings = snapshotSettings()): void {
  getStorage()?.setItem(STORE_KEY, JSON.stringify(cacheFromSettings(settings)));
}

async function writeSettings(settings: Settings): Promise<void> {
  await invoke<void>("app_settings_set", { settings: toPersistedSettings(settings) });
}

// ── Store ──

const [settingsState, setSettingsState] = createStore<Settings>(loadSettingsSync());
const [settingsReady, setSettingsReady] = createSignal(false);

let initPromise: Promise<void> | null = null;
let saveQueue = Promise.resolve();

async function initSettings(): Promise<void> {
  if (settingsReady()) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const legacyPatch = patchFromLegacySettings(readStorageJson(LEGACY_STORE_KEY));
    let next = applyDefaultDisabledPlugins(mergeSettings(DEFAULTS, legacyPatch)).settings;

    try {
      const persisted = await invoke<unknown>("app_settings_get");
      next = mergeSettings(DEFAULTS, patchFromPersistedSettings(persisted));
      if (legacyPatch) {
        next = mergeSettings(next, legacyPatch);
      }
      const applied = applyDefaultDisabledPlugins(next);
      next = applied.settings;

      setSettingsState(reconcile(next));
      updateLocalStorageCache(next);

      if (legacyPatch || applied.changed) {
        await writeSettings(next);
        getStorage()?.removeItem(LEGACY_STORE_KEY);
      }
    } catch (error) {
      setSettingsState(reconcile(next));
      updateLocalStorageCache(next);
      throw error;
    } finally {
      setSettingsReady(true);
      initPromise = null;
    }
  })();

  return initPromise;
}

function saveSettings(): void {
  const snapshot = snapshotSettings();
  updateLocalStorageCache(snapshot);

  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => writeSettings(snapshot))
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[Settings] Failed to persist settings", error);
    });
}

// ── Setters ──

function setSetting<S extends SettingSection, K extends keyof Settings[S]>(
  section: S,
  key: K,
  value: Settings[S][K],
): void {
  (setSettingsState as (s: S, k: K, v: Settings[S][K]) => void)(section, key, value);
  saveSettings();
}

function setTopLevelSetting<K extends TopLevelSettingKey>(key: K, value: Settings[K]): void {
  (setSettingsState as (k: K, v: Settings[K]) => void)(key, value);
  saveSettings();
}

function setGeneralSetting<K extends keyof GeneralSettings>(
  key: K,
  value: GeneralSettings[K],
): void {
  setSetting("general", key, value);
}

function setAppearanceSetting<K extends keyof AppearanceSettings>(
  key: K,
  value: AppearanceSettings[K],
): void {
  setSetting("appearance", key, value);
}

function setEditorSetting<K extends keyof EditorSettings>(key: K, value: EditorSettings[K]): void {
  setSetting("editor", key, value);
}

function setFilesSetting<K extends keyof FilesSettings>(key: K, value: FilesSettings[K]): void {
  setSetting("files", key, value);
}

/** Reset all settings to defaults. */
function resetSettings(): void {
  const defaults = applyDefaultDisabledPlugins(structuredClone(DEFAULTS)).settings;
  setSettingsState(reconcile(defaults));
  saveSettings();
}

function setKeybindingOverride(commandId: string, keys: string): void {
  setSetting("keybindings", "overrides", {
    ...settingsState.keybindings.overrides,
    [commandId]: keys,
  });
}

function resetKeybindingOverride(commandId: string): void {
  const rest = Object.fromEntries(
    Object.entries(settingsState.keybindings.overrides).filter(([key]) => key !== commandId),
  );
  setSettingsState("keybindings", "overrides", reconcile(rest));
  saveSettings();
}

// ── Exports ──

export {
  DEFAULTS as SETTING_DEFAULTS,
  initSettings,
  resetSettings,
  setAppearanceSetting,
  setEditorSetting,
  setFilesSetting,
  setGeneralSetting,
  setKeybindingOverride,
  resetKeybindingOverride,
  setSetting,
  setTopLevelSetting,
  settingsReady,
  settingsState,
};
export type {
  AppearanceSettings,
  EditorSettings,
  FilesSettings,
  GeneralSettings,
  KeybindingsSettings,
  Settings,
};
