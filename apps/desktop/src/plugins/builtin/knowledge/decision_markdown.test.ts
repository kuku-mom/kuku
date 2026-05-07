import { describe, expect, it } from "vitest";

import {
  RegistryBuilder,
  createProcessor,
  mdastToProseMirror,
  proseMirrorToMdast,
  type PMNodeJSON,
} from "~/lib/markdown";
import type { MarkdownContribution } from "~/plugins/types";
import { editorCoreMarkdown } from "~/plugins/builtin/core_editor/markdown_handlers";

import { knowledgeMarkdown } from "./markdown_handlers";

const DECISION_MARKDOWN = `\`\`\`kuku-decision
id: decision_auth
proposal_id: prop_auth
target_change_id: change_auth
question: Remember this memory?
selection_mode: single
required: true
status: pending
selected_option_id: yes
options:
- id: yes
  label: Yes
- id: no
  label: No
- id: other
  label: Other
  requires_input: true
\`\`\`
`;

const DECISION_DOCUMENT_MARKDOWN = `---
id: doc_auth
proposal_id: prop_auth
target_kind: memory
request_source: ui_command
status: pending
created_at: 2026-05-07T00:00:00Z
updated_at: 2026-05-07T00:00:00Z
source_refs:
- path: Notes/Auth.md
  title: Auth
  checksum: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
---

# Memory Proposal

${DECISION_MARKDOWN}`;

describe("kuku-decision markdown", () => {
  it("preserves decision document frontmatter markers", () => {
    const output = stringifyDecisionMarkdown(parseDecisionMarkdown(DECISION_DOCUMENT_MARKDOWN));

    expect(output.startsWith("---\nid: doc_auth\n")).toBe(true);
    expect(output).toContain("\n---\n\n# Memory Proposal");
    expect(output).toContain("```kuku-decision");
  });

  it("renders frontmatter as an opaque editor node", () => {
    const pm = parseDecisionMarkdown(DECISION_DOCUMENT_MARKDOWN);

    expect(pm.content?.[0]).toMatchObject({
      type: "kukuFrontmatter",
      attrs: {
        value: expect.stringContaining("proposal_id: prop_auth"),
      },
    });
  });

  it("renders kuku-decision fences as editor nodes", () => {
    const pm = parseDecisionMarkdown(DECISION_MARKDOWN);
    expect(pm.content?.[0]).toMatchObject({
      type: "kukuDecision",
      attrs: {
        id: "decision_auth",
        proposalId: "prop_auth",
        targetChangeId: "change_auth",
        selectedOptionId: "yes",
      },
    });
  });

  it("updates selected option in serialized Markdown", () => {
    const pm = parseDecisionMarkdown(DECISION_MARKDOWN);
    const decision = pm.content?.[0];
    if (!decision?.attrs) throw new Error("missing decision attrs");

    decision.attrs = { ...decision.attrs, selectedOptionId: "no" };
    const output = stringifyDecisionMarkdown(pm);

    expect(output).toContain("selected_option_id: no");
    expect(output).not.toContain("selected_option_id: yes");
  });

  it("serializes other input back into the decision block", () => {
    const pm = parseDecisionMarkdown(DECISION_MARKDOWN);
    const decision = pm.content?.[0];
    if (!decision?.attrs) throw new Error("missing decision attrs");

    decision.attrs = {
      ...decision.attrs,
      selectedOptionId: "other",
      otherText: "Needs a narrower version.\nKeep it short.",
    };
    const output = stringifyDecisionMarkdown(pm);

    expect(output).toContain("selected_option_id: other");
    expect(output).toContain("other_text: |-");
    expect(output).toContain("  Needs a narrower version.");
    expect(output).toContain("  Keep it short.");
  });

  it("keeps non-Kuku fenced code as codeBlock", () => {
    const pm = parseDecisionMarkdown("```ts\nconst x = 1;\n```\n");
    expect(pm.content?.[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "ts" },
    });
  });

  it("round-trips decision Markdown idempotently", () => {
    const first = stringifyDecisionMarkdown(parseDecisionMarkdown(DECISION_MARKDOWN));
    const second = stringifyDecisionMarkdown(parseDecisionMarkdown(first));
    expect(second).toBe(first);
  });
});

function parseDecisionMarkdown(markdown: string): PMNodeJSON {
  const contributions = [editorCoreMarkdown, knowledgeMarkdown];
  const processor = createProcessor({
    remarkPlugins: contributions.flatMap((contribution) => contribution.remarkPlugins ?? []),
  });
  return mdastToProseMirror(processor.parse(markdown), createKnowledgeTestRegistry());
}

function stringifyDecisionMarkdown(pm: PMNodeJSON): string {
  const contributions = [editorCoreMarkdown, knowledgeMarkdown];
  const processor = createProcessor({
    remarkPlugins: contributions.flatMap((contribution) => contribution.remarkPlugins ?? []),
  });
  return processor.stringify(proseMirrorToMdast(pm, createKnowledgeTestRegistry()));
}

function createKnowledgeTestRegistry() {
  const builder = new RegistryBuilder().addBase();
  for (const contribution of [editorCoreMarkdown, knowledgeMarkdown]) {
    addMarkdownContribution(builder, contribution);
  }
  return builder.build();
}

function addMarkdownContribution(
  builder: RegistryBuilder,
  contribution: MarkdownContribution,
): void {
  for (const [type, handler] of Object.entries(contribution.mdastToPm?.block ?? {})) {
    builder.addMdastBlockHandler(type, handler);
  }
  for (const [type, handler] of Object.entries(contribution.mdastToPm?.inline ?? {})) {
    builder.addMdastInlineHandler(type, handler);
  }
  for (const [type, handler] of Object.entries(contribution.pmToMdast?.block ?? {})) {
    builder.addPmBlockHandler(type, handler);
  }
  for (const [type, handler] of Object.entries(contribution.pmToMdast?.inline ?? {})) {
    builder.addPmInlineHandler(type, handler);
  }
  for (const [type, handler] of Object.entries(contribution.pmToMdast?.mark ?? {})) {
    builder.addPmMarkHandler(type, handler);
  }
}
