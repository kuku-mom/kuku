import { lazy, type Component } from "solid-js";
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
import { defineKukuFrontmatter } from "./nodes/kuku_frontmatter";
import { createKnowledgeService } from "./service";
import { knowledgeSettings } from "./settings";

import "./knowledge_decision.css";

const KnowledgePanel = lazy(() => import("./components/knowledge_panel"));

function defineKnowledgeEditorExtension(): Extension {
  return union(defineKukuFrontmatter(), defineKukuDecision());
}

const knowledgePlugin: KukuPlugin = {
  id: "knowledge",
  name: "Second Brain",
  version: "0.1.0",
  description: "Knowledge memory proposal, review, apply, and search",
  dependencies: ["core-tool-registry", "core-editor", "core-indexer"],

  views: [
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
      ctx.track(registerKnowledgeAiTools(proxyTools, service));
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
