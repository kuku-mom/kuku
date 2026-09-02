import { registerEditorSlashItem } from "~/plugins/builtin/core_editor/slash_items";
import type { KukuPlugin } from "~/plugins/types";

import { defineMeetingTranscriptPlugin } from "./meeting_transcript_plugin";
import { mt } from "./messages";
import { MeetingService, getMeetingService, setMeetingService, meetingUi } from "./service";
import { MeetingOverlays, MeetingSettings, MeetingStatus, MeetingToolbar } from "./ui";

function toggle(): void {
  const service = getMeetingService();
  void service?.toggle().catch((error: unknown) => service.report(error));
}

export const meetingNotesPlugin: KukuPlugin = {
  id: "meeting-notes",
  get name() {
    return mt("name");
  },
  version: "0.1.0",
  get description() {
    return mt("description");
  },
  canDisable: true,
  dependencies: ["core-editor"],
  views: [
    {
      id: "meeting-notes.toolbar",
      label: "Meeting Notes",
      location: { slot: "titleBarRightAction" },
      component: MeetingToolbar,
      order: 10,
    },
    {
      id: "meeting-notes.overlays",
      label: "Meeting Notes",
      location: { slot: "overlay" },
      component: MeetingOverlays,
    },
    {
      id: "meeting-notes.settings",
      get label() {
        return mt("name");
      },
      location: { slot: "settingsSection" },
      component: MeetingSettings,
      order: 30,
    },
  ],
  statusBar: [{ id: "meeting-notes.status", component: MeetingStatus, align: "right", order: 20 }],
  editor: { extension: defineMeetingTranscriptPlugin },
  commands: [
    {
      id: "meeting-notes.toggle",
      get label() {
        return mt("name");
      },
      category: "Meeting Notes",
      defaultKeys: ["$mod+Shift+M"],
      execute: toggle,
    },
  ],
  settings: {
    defaults: { detection: true, consentVersion: 0, mode: "combined" },
    schema: {
      type: "object",
      properties: {
        detection: { type: "boolean" },
        consentVersion: { type: "number" },
        mode: { type: "string", enum: ["combined", "microphone", "system"] },
      },
    },
    version: 1,
    component: MeetingSettings,
  },
  async activate(ctx) {
    const service = new MeetingService(ctx);
    setMeetingService(service);
    try {
      await service.activate();
    } catch (error) {
      await service.dispose();
      setMeetingService(null);
      throw error;
    }
    ctx.services.register("meeting-notes", service);
    ctx.track(
      registerEditorSlashItem({
        id: "meeting-notes",
        get title() {
          return mt("name");
        },
        get description() {
          return mt("description");
        },
        icon: "mic",
        keywords: ["meeting", "notes", "record", "transcribe", "미팅", "회의", "녹음"],
        group: "meeting",
        order: -100,
        isEnabled: () => meetingUi.available && !meetingUi.busy,
        execute: toggle,
      }),
    );
  },
  async deactivate() {
    await getMeetingService()?.dispose();
    setMeetingService(null);
  },
};
