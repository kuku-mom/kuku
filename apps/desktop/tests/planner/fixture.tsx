import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { Show, createSignal } from "solid-js";
// Development-only integration fixture. All documents, accounts and IPC are synthetic.
import { render } from "solid-js/web";

import MarkdownEditor from "~/components/editor/markdown_editor";
import { initAppPaths } from "~/plugins/app_paths";
import { editorCorePlugin } from "~/plugins/builtin/core_editor";
import { coreToolRegistryPlugin } from "~/plugins/builtin/core_tool_registry";
import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import { getService } from "~/plugins/services";
import { PlannerAiConsole } from "./ai_tools_console";
import { plannerPlugin } from "~/plugins/builtin/planner";
import { blockFor, addDays, localDate } from "~/plugins/builtin/planner/dates";
import { getPlannerService } from "~/plugins/builtin/planner/service";
import type {
  EventRef,
  ExternalItem,
  ItemDraft,
  ItemPatch,
  Provider,
} from "~/plugins/builtin/planner/types";
import PlannerView, { PlannerPanel } from "~/plugins/builtin/planner/view";
import { buildMarkdownService } from "~/plugins/markdown_service";
import { registerPlugin, activatePlugin } from "~/plugins/registry";
import { getActiveTab, openTab } from "~/stores/files";
import { openVault } from "~/stores/vault";
import "~/index.css";

const today = localDate();
const defaults: Record<string, string> = {
  "Projects/Launch.md": `# 출시 준비\n\n- [ ] 온보딩 문구 다듬기 <!-- kuku-task: ${JSON.stringify({ id: "fixture-copy", dueDate: today, ...blockFor(today, 10 * 60, 60) })} -->\n- [ ] 디자인 리뷰 자료 보내기 <!-- kuku-task: ${JSON.stringify({ id: "fixture-design", dueDate: addDays(today, -1) })} -->\n- [ ] 사용자 인터뷰 정리 <!-- kuku-task: ${JSON.stringify({ id: "fixture-interview", plannedDate: today })} -->\n- [ ] 다음 릴리스 아이디어 모으기\n- [x] 출시 체크리스트 작성\n`,
  "Notes/Weekly.md": "# 주간 회의\n\n팀과 논의할 내용입니다.\n",
};
if (location.search.includes("reset")) {
  localStorage.removeItem("planner-fixture-disk");
  localStorage.removeItem("planner-fixture-settings");
  localStorage.removeItem("planner-fixture-external");
  localStorage.removeItem("planner-fixture-local-files");
  localStorage.removeItem("planner-fixture-connections");
  localStorage.removeItem("tabs-state");
}
const disk: Record<string, string> =
  JSON.parse(localStorage.getItem("planner-fixture-disk") ?? "null") ?? defaults;
const [revision, setRevision] = createSignal(0);
let preferences = JSON.parse(localStorage.getItem("planner-fixture-settings") ?? "null") ?? {
  enabledSources: { google: true, "apple-calendar": true, "apple-reminders": true },
  selectedCalendars: {
    google: ["work"],
    "apple-calendar": ["personal"],
    "apple-reminders": ["reminders"],
  },
  excludedFolders: [],
  defaultCalendar: { provider: "google", calendarId: "work" },
};
if (!("defaultCalendar" in preferences))
  preferences.defaultCalendar = { provider: "google", calendarId: "work" };
const localFiles: Record<string, string> = JSON.parse(
  localStorage.getItem("planner-fixture-local-files") ?? "{}",
);
let offline = false;
const connections: Record<Provider, boolean> = JSON.parse(
  localStorage.getItem("planner-fixture-connections") ?? "null",
) ?? {
  google: true,
  "apple-calendar": true,
  "apple-reminders": true,
};
const status = (provider: Provider) => ({
  provider,
  connected: connections[provider],
  configured: true,
  writable: connections[provider],
});
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const withReference = (item: ExternalItem, itemId = item.id, version = "1"): ExternalItem => ({
  ...item,
  writable: true,
  timeZone: item.timeZone ?? timeZone,
  writeRef: {
    provider: item.provider,
    calendarId: item.calendarId,
    itemId,
    version,
    occurrence: item.occurrence,
    externalId: item.externalId,
    start: item.start,
    end: item.end,
  },
});
const initialExternal: ExternalItem[] = [
  withReference(
    {
      id: "work:standup",
      calendarId: "work",
      provider: "google",
      kind: "event",
      title: "제품 팀 스탠드업",
      start: blockFor(today, 9 * 60, 30).scheduledStart,
      end: blockFor(today, 9 * 60, 30).scheduledEnd,
      allDay: false,
      url: "https://www.google.com/calendar/event?eid=fixture",
      occurrence: today,
    },
    "standup",
  ),
  withReference({
    id: "lunch",
    calendarId: "personal",
    provider: "apple-calendar",
    kind: "event",
    title: "점심 약속",
    start: blockFor(today, 12 * 60, 60).scheduledStart,
    end: blockFor(today, 12 * 60, 60).scheduledEnd,
    allDay: false,
  }),
  withReference({
    id: "birthday",
    calendarId: "personal",
    provider: "apple-calendar",
    kind: "event",
    title: "민지 생일",
    start: today,
    end: addDays(today, 1),
    allDay: true,
  }),
  withReference({
    id: "reminder",
    calendarId: "reminders",
    provider: "apple-reminders",
    kind: "reminder",
    title: "도서관 책 반납",
    dueDate: today,
    allDay: true,
    completed: false,
  }),
];
const external: { items: ExternalItem[]; revision: number } = JSON.parse(
  localStorage.getItem("planner-fixture-external") ?? "null",
) ?? {
  items: initialExternal,
  revision: 0,
};
const externalChanged = () => {
  external.revision++;
  localStorage.setItem("planner-fixture-external", JSON.stringify(external));
};
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const checkConnection = (provider: Provider) => {
  if (offline) throw new Error("NETWORK: Fixture is offline");
  if (!connections[provider]) throw new Error("AUTH: Reconnect the synthetic account");
};
const itemIndex = (reference: EventRef) =>
  external.items.findIndex(
    (item) =>
      item.provider === reference.provider &&
      item.calendarId === reference.calendarId &&
      item.writeRef?.itemId === reference.itemId &&
      (item.occurrence ?? "") === (reference.occurrence ?? ""),
  );
const validateDraft = (provider: Provider, draft: ItemDraft) => {
  if (!draft.title.trim()) throw new Error("INVALID: Enter a title");
  if (
    provider !== "apple-reminders" &&
    (!draft.start || !draft.end || new Date(draft.end) <= new Date(draft.start))
  )
    throw new Error("INVALID: End must follow start");
};
const createExternal = (
  provider: Provider,
  calendarId: string,
  draft: ItemDraft,
  operationId: string,
) => {
  checkConnection(provider);
  const prior = external.items.find(
    (item) =>
      item.provider === provider &&
      item.calendarId === calendarId &&
      item.operationId === operationId,
  );
  if (prior) return copy(prior);
  validateDraft(provider, draft);
  const rawId = `fixture-${operationId}`;
  const item = withReference(
    {
      ...draft,
      id: provider === "google" ? `${calendarId}:${rawId}` : rawId,
      provider,
      calendarId,
      kind: provider === "apple-reminders" ? "reminder" : "event",
      operationId,
    },
    rawId,
  );
  external.items.push(item);
  externalChanged();
  return copy(item);
};
const updateExternal = (reference: EventRef, patch: ItemPatch, force = false) => {
  checkConnection(reference.provider);
  const index = itemIndex(reference);
  if (index < 0) throw new Error("NOT_FOUND: Synthetic item was deleted");
  const current = external.items[index]!;
  if (!force && current.writeRef?.version !== reference.version)
    throw new Error("CONFLICT: Synthetic item changed");
  const next = { ...current } as ExternalItem;
  for (const [key, value] of Object.entries(patch)) {
    if (
      ![
        "title",
        "start",
        "end",
        "allDay",
        "timeZone",
        "location",
        "description",
        "dueDate",
        "completed",
      ].includes(key)
    )
      throw new Error("INVALID: Unsupported fixture field");
    if (value === null) delete (next as unknown as Record<string, unknown>)[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  validateDraft(reference.provider, next);
  external.items[index] = withReference(
    next,
    reference.itemId,
    String(Number(current.writeRef?.version ?? 0) + 1),
  );
  externalChanged();
  return copy(external.items[index]!);
};
const removeExternal = (reference: EventRef, force = false) => {
  checkConnection(reference.provider);
  const index = itemIndex(reference);
  if (index < 0) return;
  if (!force && external.items[index]!.writeRef?.version !== reference.version)
    throw new Error("CONFLICT: Synthetic item changed");
  external.items.splice(index, 1);
  externalChanged();
};
const checksum = (path: string) => disk[path] ?? "";
const entries = () =>
  Object.keys(disk).map((path) => ({ name: path.split("/").pop(), path, is_directory: false }));
const changed = () => {
  localStorage.setItem("planner-fixture-disk", JSON.stringify(disk));
  setRevision((value) => value + 1);
};
mockWindows("main");
Object.defineProperty(window, "isTauri", { value: true, configurable: true });
mockIPC(
  async (command, raw) => {
    const args = (raw ?? {}) as Record<string, any>;
    if (command === "plugin_ensure_root_dirs") return "/fixture-app";
    if (command === "plugin_get_settings") return args.pluginId === "planner" ? preferences : {};
    if (command === "plugin_save_settings") {
      if (args.pluginId === "planner") {
        preferences = args.settings;
        localStorage.setItem("planner-fixture-settings", JSON.stringify(preferences));
      }
      return;
    }
    if (command === "plugin_fs_exists") return args.path in localFiles;
    if (command === "plugin_fs_read_text") return localFiles[args.path];
    if (command === "plugin_fs_write_text") {
      localFiles[args.path] = args.content;
      localStorage.setItem("planner-fixture-local-files", JSON.stringify(localFiles));
      return;
    }
    if (command === "vault_list_dir") return entries();
    if (command === "vault_exists") return args.path in disk;
    if (command === "vault_read_text") {
      if (!(args.path in disk)) throw new Error("Missing fixture note");
      return disk[args.path];
    }
    if (command === "vault_read_with_checksum") {
      if (!(args.path in disk)) throw new Error("Missing fixture note");
      return { content: disk[args.path], checksum: checksum(args.path) };
    }
    if (command === "vault_write_text") {
      disk[args.path] = args.content;
      changed();
      return;
    }
    if (command === "vault_write_with_checksum") {
      if (args.checksum !== checksum(args.path))
        return { status: "Conflict", expected: args.checksum, actual: checksum(args.path) };
      disk[args.path] = args.content;
      changed();
      return { status: "Written", checksum: checksum(args.path) };
    }
    if (command.startsWith("planner_")) {
      const provider: Provider = command.startsWith("planner_google_")
        ? "google"
        : args.kind === "reminders"
          ? "apple-reminders"
          : "apple-calendar";
      const action = command.replace(/^planner_(?:google|apple)_/, "");
      if (action === "status") return status(provider);
      if (action === "connect" || action === "disconnect") {
        connections[provider] = action === "connect";
        localStorage.setItem("planner-fixture-connections", JSON.stringify(connections));
        return status(provider);
      }
      if (action === "suspend" || action === "open_app") return;
      if (action === "revision") return external.revision;
      checkConnection(provider);
      if (action === "calendars")
        return [
          {
            id:
              provider === "google"
                ? "work"
                : provider === "apple-calendar"
                  ? "personal"
                  : "reminders",
            provider,
            title:
              provider === "google"
                ? "Work · hello@example.test"
                : provider === "apple-calendar"
                  ? "Personal · iCloud"
                  : "Personal reminders",
            writable: true,
            timeZone,
            isDefault: true,
            accountId: provider === "google" ? "hello@example.test" : "fixture-icloud",
            sourceTitle: provider === "google" ? "Google Calendar" : "iCloud",
          },
        ];
      if (action === "get") {
        const index = itemIndex(args.eventRef);
        return index < 0 ? null : copy(external.items[index]);
      }
      if (action === "create")
        return createExternal(provider, args.calendarId, args.draft, args.operationId);
      if (action === "update") return updateExternal(args.eventRef, args.patch);
      if (action === "delete") return removeExternal(args.eventRef);
      if (action === "events" || action === "items")
        return copy(
          external.items.filter((item) => {
            if (item.provider !== provider || !args.calendarIds.includes(item.calendarId))
              return false;
            if (item.kind === "reminder") return true;
            const start = new Date(item.start! + (item.allDay ? "T00:00:00" : ""));
            const end = new Date(item.end! + (item.allDay ? "T00:00:00" : ""));
            return start < new Date(args.end) && end > new Date(args.start);
          }),
        );
    }
    return null;
  },
  { shouldMockEvents: true },
);

await initAppPaths();
registerPlugin(coreToolRegistryPlugin);
registerPlugin(editorCorePlugin);
await activatePlugin("core-editor");
buildMarkdownService();
await openVault("/planner-fixture");
registerPlugin(plannerPlugin);
await activatePlugin("planner");
buildMarkdownService();
openTab("Planner", null, "planner");
const [rawVisible, setRawVisible] = createSignal(false);
const [aiVisible, setAiVisible] = createSignal(false);
const panelVisible = new URLSearchParams(location.search).get("panel") === "1";
Object.assign(window, {
  __plannerFixture: {
    disk,
    external,
    localFiles,
    remoteEdit: (reference: EventRef, patch: ItemPatch) => updateExternal(reference, patch, true),
    remoteDelete: (reference: EventRef) => removeExternal(reference, true),
    service: getPlannerService(),
    activeTab: () => getActiveTab(),
    openPlanner: () => openTab("Planner", null, "planner"),
    openNote: () => openTab("Launch.md", "Projects/Launch.md"),
    setOffline: (value: boolean) => {
      offline = value;
    },
  },
});
render(
  () => (
    <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
      <div
        style={{
          padding: "6px 16px",
          "font-size": "11px",
          background: "var(--color-bg-secondary)",
          color: "var(--color-text-muted)",
          display: "flex",
          gap: "16px",
        }}
      >
        <span>Planner fixture · synthetic data only</span>
        <button onClick={() => openTab("Planner", null, "planner")}>Planner</button>
        <Show when={panelVisible}>
          <button onClick={() => openTab("Launch.md", "Projects/Launch.md")}>Note</button>
        </Show>
        <button onClick={() => setRawVisible(!rawVisible())}>Saved Markdown</button>
        <button onClick={() => setAiVisible(!aiVisible())}>AI tools</button>
      </div>
      <Show when={aiVisible()}>
        <PlannerAiConsole
          registry={getService("core-tool-registry.proxyTools") as AiProxyToolRegistry}
        />
      </Show>
      <div style={{ display: "flex", flex: "1", "min-height": "0", "min-width": "0" }}>
        <main
          style={{
            display: "flex",
            "flex-direction": "column",
            flex: "1",
            "min-width": "0",
            "min-height": "0",
          }}
        >
          <Show
            when={getActiveTab()?.type === "planner"}
            fallback={
              <Show when={getActiveTab()} keyed>
                {(tab) => (
                  <MarkdownEditor tabId={tab.id} filePath={tab.filePath ?? ""} mode="editable" />
                )}
              </Show>
            }
          >
            <PlannerView />
          </Show>
        </main>
        <Show when={panelVisible}>
          <aside
            aria-label="Planner context"
            style={{
              width: "260px",
              "flex-shrink": "0",
              "min-height": "0",
              "border-left": "1px solid var(--color-border-default)",
              background: "var(--color-bg-secondary)",
            }}
          >
            <PlannerPanel />
          </aside>
        </Show>
      </div>
      <Show when={rawVisible()}>
        <pre
          style={{ "max-height": "180px", overflow: "auto", "font-size": "11px", padding: "10px" }}
        >
          {revision() >= 0 ? JSON.stringify(disk, null, 2) : ""}
        </pre>
      </Show>
    </div>
  ),
  document.getElementById("fixture")!,
);
