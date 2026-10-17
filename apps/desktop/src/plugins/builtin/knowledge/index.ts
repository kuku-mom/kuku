import { lazy, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { union, type Extension } from "prosekit/core";

import type { AiProxyToolRegistry } from "~/plugins/builtin/core_tool_registry/types";
import type { KukuPlugin } from "~/plugins/types";
import { openRightPanelView } from "~/stores/layout";

import { registerKnowledgeAiTools } from "./ai_tools";
import KukuDecisionNode from "./components/kuku_decision_node";
import { stopKukuDecisionNodeEvent } from "./decision_node_events";
import { applyActiveDecisionDocument, isKnowledgeDecisionDocumentPath } from "./editor_apply";
import { knowledgeMarkdown } from "./markdown_handlers";
import { defineKukuDecision } from "./nodes/kuku_decision";
import { createKnowledgeService } from "./service";
import { knowledgeSettings } from "./settings";

import "./knowledge_decision.css";

const KnowledgePanel = lazy(() => import("./components/knowledge_panel"));
const KnowledgeMemorySettings = lazy(() => import("./components/memory_settings"));

function defineKnowledgeEditorExtension(): Extension {
  return union(defineKukuDecision());
}

const knowledgePlugin: KukuPlugin = {
  id: "knowledge",
  name: "Second Brain",
  version: "0.1.0-alpha",
  description: "Knowledge memory proposal, review, apply, and search",
  canDisable: true,
  dependencies: ["core-tool-registry", "core-editor", "core-indexer"],

  views: [
    {
      id: "knowledge.settings",
      label: "Second Brain",
      location: { slot: "settingsSection" },
      component: KnowledgeMemorySettings,
      order: 40,
    },
    {
      id: "knowledge.panel",
      label: "Second Brain",
      icon: "second-brain",
      location: { slot: "rightPanel" },
      order: 30,
      component: KnowledgePanel,
    },
  ],

  editor: {
    extension: defineKnowledgeEditorExtension,
    nodeViews: {
      kukuDecision: {
        component: KukuDecisionNode as unknown as Component,
        stopEvent: stopKukuDecisionNodeEvent,
      },
    },
    markdown: knowledgeMarkdown,
  },

  commands: [
    {
      id: "knowledge.openPanel",
      label: "Open Second Brain",
      category: "Second Brain",
      execute: () => openRightPanelView("knowledge.panel"),
    },
    {
      id: "knowledge.init",
      label: "Initialize Second Brain",
      category: "Second Brain",
      execute: () => {
        const service = createKnowledgeService();
        void service.init();
      },
    },
  ],

  settings: knowledgeSettings,

  activate(ctx) {
    const service = createKnowledgeService();
    ctx.services.register("knowledge", service);
    ctx.commands.register({
      id: "knowledge.applyDecisionDocument",
      label: "Apply Decision Document",
      category: "Second Brain",
      execute: () => {
        void applyActiveDecisionDocument(ctx, service);
      },
      when: () => isKnowledgeDecisionDocumentPath(ctx.editor.activeFilePath),
      canExecute: () => isKnowledgeDecisionDocumentPath(ctx.editor.activeFilePath),
    });

    const proxyTools = ctx.services.get("core-tool-registry.proxyTools") as
      | AiProxyToolRegistry
      | undefined;
    if (proxyTools) {
      ctx.track(
        registerKnowledgeAiTools(proxyTools, service, async (method, params) =>
          JSON.stringify(await invoke("memory_tool", { method, params })),
        ),
      );
      for (const name of ["memory_read", "memory_remember"] as const) {
        ctx.track(
          proxyTools.register({
            name,
            toolId: `knowledge.${name}`,
            category: "knowledge",
            access: name === "memory_remember" ? "proposesMutation" : "readOnly",
            description:
              name === "memory_read"
                ? "Read an authorized shared memory and its sources."
                : "Save an explicit preference, confirmed decision or user correction. The server applies the user's scope and auto-save policy. Updates require id and expected_version; reuse request_id on retries.",
            parameters:
              name === "memory_read"
                ? { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
                : {
                    type: "object",
                    properties: {
                      request_id: { type: "string" },
                      scope: { type: "string" },
                      title: { type: "string" },
                      body: { type: "string" },
                      id: { type: "string" },
                      expected_version: { type: "integer" },
                      kind: { type: "string" },
                      tags: { type: "array", items: { type: "string" } },
                      expires_at: { type: "string" },
                    },
                    required: ["request_id", "scope", "title", "body"],
                  },
            handler: async (params) =>
              JSON.stringify(await invoke("memory_tool", { method: name, params })),
          }),
        );
      }
    }
  },
};

export { knowledgePlugin };
export type { KnowledgeService } from "./service";
export type {
  ApplyDecisionDocumentResult,
  ApplyDecisionDocumentStatus,
  KnowledgeInitResult,
  KnowledgeStatusResult,
} from "./types";
