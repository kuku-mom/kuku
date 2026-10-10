import { lazy } from "solid-js";

import type { KukuPlugin } from "~/plugins/types";
import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import { closeTab, filesState, openTab } from "~/stores/files";
import { closeRightPanelView, layoutState } from "~/stores/layout";

import { plannerDecorations } from "./decorations";
import { registerPlannerAiTools } from "./ai_tools";
import { pt } from "./messages";
import { getPlannerService, PlannerService, setPlannerService } from "./service";
import { DEFAULT_PREFERENCES } from "./types";

const Tab = lazy(() => import("./view"));
const Panel = lazy(() => import("./view").then((m) => ({ default: m.PlannerPanel })));
const Settings = lazy(() => import("./view").then((m) => ({ default: m.PlannerSettings })));
const Toolbar = lazy(() => import("./view").then((m) => ({ default: m.PlannerToolbar })));
export const plannerPlugin: KukuPlugin = {
  id: "planner",
  get name() {
    return pt("name");
  },
  version: "0.1.0",
  get description() {
    return pt("description");
  },
  canDisable: true,
  dependencies: ["core-editor", "core-tool-registry"],
  views: [
    {
      id: "planner.tab",
      get label() {
        return pt("name");
      },
      location: { slot: "centerTab" },
      tabType: "planner",
      component: Tab,
    },
    {
      id: "planner.panel",
      get label() {
        return pt("name");
      },
      location: { slot: "rightPanel" },
      icon: "calendar",
      component: Panel,
      order: 5,
    },
    {
      id: "planner.toolbar",
      get label() {
        return pt("name");
      },
      location: { slot: "titleBarLeftAction" },
      component: Toolbar,
      order: 15,
    },
    {
      id: "planner.settings",
      get label() {
        return pt("name");
      },
      location: { slot: "settingsSection" },
      component: Settings,
    },
  ],
  commands: [
    {
      id: "planner.open",
      get label() {
        return pt("name");
      },
      category: "Planner",
      execute: () => openTab(pt("name"), null, "planner"),
    },
  ],
  settings: {
    defaults: { ...DEFAULT_PREFERENCES },
    version: 1,
    schema: {
      type: "object",
      properties: {
        excludedFolders: { type: "array", items: { type: "string" } },
        selectedCalendars: { type: "object" },
        enabledSources: { type: "object" },
      },
    },
    component: Settings,
  },
  editor: { extension: plannerDecorations },
  async activate(ctx) {
    const service = new PlannerService(ctx);
    setPlannerService(service);
    ctx.track(() => {
      service.dispose();
      setPlannerService(null);
    });
    ctx.services.register("service", service);
    try {
      await service.activate();
      const tools = ctx.services.get("core-tool-registry.proxyTools") as
        | AiProxyToolRegistry
        | undefined;
      if (!tools) throw new Error("Planner requires the shared AI tool registry.");
      ctx.track(registerPlannerAiTools(tools, service, { requestStore: ctx.fs }));
    } catch (error) {
      service.dispose();
      setPlannerService(null);
      throw error;
    }
  },
  async deactivate() {
    getPlannerService()?.dispose();
    for (const tab of [...filesState.tabs]) if (tab.type === "planner") closeTab(tab.id);
    if (layoutState.activeRightPanelViewId === "planner.panel") closeRightPanelView();
  },
};
