// ── Markdown Service ──
//
// Collects markdown contributions from plugins, builds a unified
// markdown ↔ PM JSON conversion service, and exposes parse/stringify API.
//
// Lifecycle:
//   1. Collection: contributeMarkdown() called during plugin activation
//   2. Build: buildMarkdownService() called after all plugins activated
//   3. Use: getMarkdownService() returns the frozen service
//
// Design: v1.3 §7 Markdown Round-Trip Pipeline

import type { Root } from "mdast";

import { mdastToProseMirror } from "~/lib/markdown/mdast_to_pm";
import { proseMirrorToMdast } from "~/lib/markdown/pm_to_mdast";
import { createProcessor, type RemarkPlugin } from "~/lib/markdown/processor";
import { RegistryBuilder } from "~/lib/markdown/registry";
import type { PMNodeJSON } from "~/lib/markdown/types";
import type { MarkdownContribution } from "./types";

// ── Types ──

export interface MarkdownService {
  parse(source: string): PMNodeJSON;
  stringify(doc: PMNodeJSON): string;
  parseMdast(source: string): Root;
}

type Disposer = () => void;
type MdastTransform = (tree: Root) => Root;

// ── State ──

const pendingContributions = new Map<string, MarkdownContribution>();
let service: MarkdownService | null = null;

// ── Collection Phase (called during plugin activation) ──

export function contributeMarkdown(pluginId: string, contribution: MarkdownContribution): Disposer {
  pendingContributions.set(pluginId, contribution);
  return () => {
    pendingContributions.delete(pluginId);
  };
}

// ── Build Phase (called once after all plugins activated) ──

export function buildMarkdownService(): void {
  const builder = new RegistryBuilder().addBase();
  const remarkPlugins: RemarkPlugin[] = [];
  const afterParseTransforms: MdastTransform[] = [];
  const beforeStringifyTransforms: MdastTransform[] = [];

  for (const [, contrib] of pendingContributions) {
    // Collect remark plugins
    if (contrib.remarkPlugins) {
      remarkPlugins.push(...contrib.remarkPlugins);
    }
    // Collect mdast tree transforms
    if (contrib.mdastTransform?.afterParse) {
      afterParseTransforms.push(contrib.mdastTransform.afterParse);
    }
    if (contrib.mdastTransform?.beforeStringify) {
      beforeStringifyTransforms.push(contrib.mdastTransform.beforeStringify);
    }
    // Collect mdast → PM handlers
    if (contrib.mdastToPm?.block) {
      for (const [type, handler] of Object.entries(contrib.mdastToPm.block)) {
        builder.addMdastBlockHandler(type, handler);
      }
    }
    if (contrib.mdastToPm?.inline) {
      for (const [type, handler] of Object.entries(contrib.mdastToPm.inline)) {
        builder.addMdastInlineHandler(type, handler);
      }
    }
    // Collect PM → mdast handlers
    if (contrib.pmToMdast?.block) {
      for (const [type, handler] of Object.entries(contrib.pmToMdast.block)) {
        builder.addPmBlockHandler(type, handler);
      }
    }
    if (contrib.pmToMdast?.inline) {
      for (const [type, handler] of Object.entries(contrib.pmToMdast.inline)) {
        builder.addPmInlineHandler(type, handler);
      }
    }
    if (contrib.pmToMdast?.mark) {
      for (const [type, handler] of Object.entries(contrib.pmToMdast.mark)) {
        builder.addPmMarkHandler(type, handler);
      }
    }
  }

  // Build — R1: build() internally calls createTextInlineHandler if mark count > 0
  const registry = builder.build();
  const processor = createProcessor({ remarkPlugins });

  // Compose transform chains into single functions
  const applyAfterParse = chainTransforms(afterParseTransforms);
  const applyBeforeStringify = chainTransforms(beforeStringifyTransforms);

  // Freeze service (idempotent — re-calling replaces previous service)
  service = {
    parse: (source) => {
      const tree = applyAfterParse(processor.parse(source));
      return mdastToProseMirror(tree, registry);
    },
    stringify: (doc) => {
      const tree = applyBeforeStringify(proseMirrorToMdast(doc, registry));
      return processor.stringify(tree);
    },
    parseMdast: (source) => applyAfterParse(processor.parse(source)),
  };
}

// ── Helpers ──

/** Chain multiple mdast transforms into a single function (left-to-right). */
function chainTransforms(transforms: MdastTransform[]): MdastTransform {
  if (transforms.length === 0) return (tree) => tree;
  if (transforms.length === 1) return transforms[0];
  return (tree) => transforms.reduce((t, fn) => fn(t), tree);
}

// ── Access ──

export function getMarkdownService(): MarkdownService | null {
  return service;
}
