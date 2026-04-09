import { FontInput } from "~/components/settings/font_input";
import { SettingsFieldRow, SettingsPanel } from "~/components/settings/settings_blocks";
import { Select, Switch } from "~/components/ui";
import { setEditorSetting, setGeneralSetting, settingsState } from "~/stores/settings";

const TAB_SIZE_OPTIONS = [
  { value: "2", label: "2" },
  { value: "4", label: "4" },
  { value: "8", label: "8" },
];

const FONT_SIZE_OPTIONS = [
  { value: "12", label: "12 px" },
  { value: "13", label: "13 px" },
  { value: "14", label: "14 px" },
  { value: "15", label: "15 px" },
  { value: "16", label: "16 px" },
  { value: "17", label: "17 px" },
  { value: "18", label: "18 px" },
  { value: "19", label: "19 px" },
  { value: "20", label: "20 px" },
  { value: "21", label: "21 px" },
  { value: "22", label: "22 px" },
  { value: "23", label: "23 px" },
  { value: "24", label: "24 px" },
  { value: "25", label: "25 px" },
  { value: "26", label: "26 px" },
  { value: "27", label: "27 px" },
  { value: "28", label: "28 px" },
  { value: "29", label: "29 px" },
  { value: "30", label: "30 px" },
  { value: "31", label: "31 px" },
  { value: "32", label: "32 px" },
];

const LINE_HEIGHT_OPTIONS = [
  { value: "1.4", label: "1.4" },
  { value: "1.5", label: "1.5" },
  { value: "1.6", label: "1.6" },
  { value: "1.7", label: "1.7" },
  { value: "1.8", label: "1.8" },
  { value: "2", label: "2.0" },
];

function EditorSection() {
  return (
    <SettingsPanel
      title="Editor"
      description="Configure writing behavior, spacing, and typography."
      anchor="editor"
    >
      <SettingsFieldRow
        label="Auto-save"
        description="Automatically save changes after editing."
        control={
          <Switch
            checked={settingsState.general.autoSave}
            onChange={(value) => setGeneralSetting("autoSave", value)}
          />
        }
      />
      <SettingsFieldRow
        label="Typing indicator"
        description="Show character count in the sidebar while typing."
        control={
          <Switch
            checked={settingsState.general.typingIndicator}
            onChange={(value) => setGeneralSetting("typingIndicator", value)}
          />
        }
      />
      <SettingsFieldRow
        label="Tab size"
        description="Number of spaces per tab character."
        control={
          <div class="w-40">
            <Select
              options={TAB_SIZE_OPTIONS}
              value={String(settingsState.editor.tabSize)}
              onChange={(value) => setEditorSetting("tabSize", Number.parseInt(value, 10))}
              placeholder="Select tab size"
            />
          </div>
        }
      />
      <SettingsFieldRow
        label="Font size"
        description="Base text size used in the editor body."
        control={
          <div class="w-40">
            <Select
              options={FONT_SIZE_OPTIONS}
              value={String(settingsState.editor.fontSize)}
              onChange={(value) => setEditorSetting("fontSize", Number.parseInt(value, 10))}
              placeholder="Select font size"
            />
          </div>
        }
      />
      <SettingsFieldRow
        label="Line height"
        description="Line spacing for editor paragraphs and text."
        control={
          <div class="w-40">
            <Select
              options={LINE_HEIGHT_OPTIONS}
              value={String(settingsState.editor.lineHeight)}
              onChange={(value) => setEditorSetting("lineHeight", Number.parseFloat(value))}
              placeholder="Select line height"
            />
          </div>
        }
      />
      <SettingsFieldRow
        label="Editor font"
        description="Font used in the editor. Enter a CSS font-family name."
        control={
          <div class="w-70">
            <FontInput
              value={settingsState.editor.fontFamily}
              placeholder="e.g. Goorm Sans"
              onCommit={(value) => setEditorSetting("fontFamily", value)}
            />
          </div>
        }
      />
      <SettingsFieldRow
        label="Monospace font"
        description="Monospace font used in the editor. Enter a CSS font-family name."
        control={
          <div class="w-70">
            <FontInput
              value={settingsState.editor.fontMono}
              placeholder="e.g. Goorm Sans Code"
              onCommit={(value) => setEditorSetting("fontMono", value)}
            />
          </div>
        }
      />
    </SettingsPanel>
  );
}

export { EditorSection };
