import { createStore } from "solid-js/store";

// ── Types ──

export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

interface GeneralSettings {
  language: string;
  autoSave: boolean;
  spellCheck: boolean;
}

interface AppearanceSettings {
  theme: ThemePreference;
  fontSize: number;
  /** UI font — CSS font-family name, e.g. "Goorm Sans" */
  fontFamily: string;
  /** Editor / monospace font — CSS font-family name, e.g. "Goorm Sans Code" */
  fontMono: string;
}

interface EditorSettings {
  tabSize: number;
  wordWrap: boolean;
  lineNumbers: boolean;
}

interface FilesSettings {
  newFileLocation: string;
  deletedFiles: string;
}

interface Settings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
  editor: EditorSettings;
  files: FilesSettings;
}

// ── Defaults ──

const DEFAULTS: Settings = {
  general: {
    language: "en",
    autoSave: true,
    spellCheck: false,
  },
  appearance: {
    theme: "system",
    fontSize: 14,
    fontFamily: "Goorm Sans",
    fontMono: "Goorm Sans Code",
  },
  editor: {
    tabSize: 2,
    wordWrap: true,
    lineNumbers: false,
  },
  files: {
    newFileLocation: "root",
    deletedFiles: "trash",
  },
};

// ── Persistence ──

const STORE_KEY = "app-settings";

function loadSettingsSync(): Settings {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      general: { ...DEFAULTS.general, ...saved.general },
      appearance: { ...DEFAULTS.appearance, ...saved.appearance },
      editor: { ...DEFAULTS.editor, ...saved.editor },
      files: { ...DEFAULTS.files, ...saved.files },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveSettingsSync(): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(settingsState));
}

// ── Store ──

const [settingsState, setSettingsState] = createStore<Settings>(loadSettingsSync());

// ── Setters ──

function setSetting<S extends keyof Settings, K extends keyof Settings[S]>(
  section: S,
  key: K,
  value: Settings[S][K],
): void {
  //
  (setSettingsState as (s: S, k: K, v: Settings[S][K]) => void)(section, key, value);
  saveSettingsSync();
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
  const defaults = structuredClone(DEFAULTS);
  setSettingsState("general", defaults.general);
  setSettingsState("appearance", defaults.appearance);
  setSettingsState("editor", defaults.editor);
  setSettingsState("files", defaults.files);
  saveSettingsSync();
}

// ── Exports ──

export {
  DEFAULTS as SETTING_DEFAULTS,
  resetSettings,
  setAppearanceSetting,
  setEditorSetting,
  setFilesSetting,
  setGeneralSetting,
  setSetting,
  settingsState,
};
export type { AppearanceSettings, EditorSettings, FilesSettings, GeneralSettings, Settings };
