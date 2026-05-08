import { invoke } from "@tauri-apps/api/core";
import { lazy } from "solid-js";

import { closeRightPanelView, layoutState, openRightPanelView } from "~/stores/layout";
import { t } from "~/i18n";
import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { KukuPlugin } from "~/plugins/types";

import { createAiEventBridge } from "./event_bridge";
import { createProxyToolBridge } from "./proxy_tool_bridge";
import { clearPersistedConfig, loadConfig, loadTools, resetChatState } from "./chat_store";

const ChatPanelView = lazy(() => import("./chat_panel"));
const AiSettingsView = lazy(() =>
  import("./components/ai_settings").then((module) => ({ default: module.AiSettings })),
);

const aiChatPlugin: KukuPlugin = {
  id: "ai-chat",
  name: "AI Chat",
  version: "0.1.0",
  description: "Chat with Gemini from the right panel",
  canDisable: true,
  dependencies: ["core-auth", "core-tool-registry"],

  views: [
    {
      id: "ai-chat.panel",
      label: t("right_panel.ai_chat"),
      icon: "message-square",
      location: { slot: "rightPanel" },
      order: 20,
      component: ChatPanelView,
    },
    {
      id: "ai-chat.settings",
      label: "AI Chat",
      location: { slot: "settingsSection" },
      order: 20,
      component: AiSettingsView,
    },
  ],

  commands: [
    {
      id: "ai-chat.openPanel",
      label: "Toggle AI Chat",
      category: "AI",
      defaultKeys: ["$mod+KeyL"],
      global: true,
      execute: () => {
        if (layoutState.rightPanelOpen && layoutState.activeRightPanelViewId === "ai-chat.panel") {
          closeRightPanelView();
        } else {
          openRightPanelView("ai-chat.panel");
        }
      },
    },
  ],

  async reset() {
    await clearPersistedConfig();
    await invoke<void>("plugin:kuku-ai|ai_reset_state");
    resetChatState();
  },

  async activate(ctx) {
    const proxyTools = ctx.services.get("core-tool-registry.proxyTools") as
      | AiProxyToolRegistry
      | undefined;
    if (proxyTools) {
      const disposeProxyBridge = await createProxyToolBridge(proxyTools, {
        onToolsChanged: loadTools,
      });
      ctx.track(disposeProxyBridge);
    }

    const disposeEvents = await createAiEventBridge();
    ctx.track(disposeEvents);

    try {
      await Promise.all([loadConfig(), loadTools()]);
    } catch {
      // Keep defaults if the backend plugin is not ready yet.
    }
  },
};

export { aiChatPlugin };
