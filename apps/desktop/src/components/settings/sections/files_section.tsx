import { SettingsFieldRow, SettingsPanel } from "~/components/settings/settings_blocks";
import { Select } from "~/components/ui";
import { setFilesSetting, settingsState } from "~/stores/settings";

const NEW_FILE_LOCATION_OPTIONS = [
  { value: "root", label: "Vault root" },
  { value: "current", label: "Same folder as current file" },
];

const DELETED_FILES_OPTIONS = [
  { value: "trash", label: "Move to system trash" },
  { value: "kuku-trash", label: "Move to .trash folder" },
  { value: "permanent", label: "Delete permanently" },
];

function FilesSection() {
  return (
    <SettingsPanel
      title="Files & Links"
      description="Configure where new files are created and how deletes are handled."
      anchor="files"
    >
      <SettingsFieldRow
        label="Default new file location"
        description="Where new files are created by default."
        control={
          <div class="w-64">
            <Select
              options={NEW_FILE_LOCATION_OPTIONS}
              value={settingsState.files.newFileLocation}
              onChange={(value) => setFilesSetting("newFileLocation", value)}
              placeholder="Select location"
            />
          </div>
        }
      />
      <SettingsFieldRow
        label="Deleted files (WIP)"
        description="What happens when you delete a file."
        control={
          <div class="w-64">
            <Select
              options={DELETED_FILES_OPTIONS}
              value={settingsState.files.deletedFiles}
              onChange={(value) => setFilesSetting("deletedFiles", value)}
              placeholder="Select action"
            />
          </div>
        }
      />
    </SettingsPanel>
  );
}

export { FilesSection };
