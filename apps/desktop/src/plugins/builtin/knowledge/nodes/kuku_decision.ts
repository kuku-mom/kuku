import { defineNodeSpec, type Extension } from "prosekit/core";

function defineKukuDecision(): Extension {
  return defineNodeSpec({
    name: "kukuDecision",
    group: "block",
    atom: true,
    isolating: true,
    selectable: false,
    attrs: {
      id: { default: "" },
      proposalId: { default: "" },
      targetChangeId: { default: "" },
      question: { default: "" },
      selectionMode: { default: "single" },
      required: { default: true },
      status: { default: "pending" },
      selectedOptionId: { default: null },
      options: { default: [] },
      otherText: { default: null },
      resolvedAt: { default: null },
    },
    parseDOM: [
      {
        tag: "div[data-kuku-decision]",
        getAttrs(dom) {
          if (typeof dom === "string") return false;
          return {
            id: dom.getAttribute("data-decision-id") ?? "",
            proposalId: dom.getAttribute("data-proposal-id") ?? "",
            targetChangeId: dom.getAttribute("data-target-change-id") ?? "",
            question: dom.getAttribute("data-question") ?? "",
            selectionMode: dom.getAttribute("data-selection-mode") ?? "single",
            required: dom.getAttribute("data-required") !== "false",
            status: dom.getAttribute("data-status") ?? "pending",
            selectedOptionId: dom.getAttribute("data-selected-option-id") || null,
            options: [],
            otherText: dom.getAttribute("data-other-text") || null,
            resolvedAt: dom.getAttribute("data-resolved-at") || null,
          };
        },
      },
    ],
    toDOM(node) {
      const attrs = node.attrs as Record<string, unknown>;
      return [
        "div",
        {
          "data-kuku-decision": "",
          "data-decision-id": attrs.id,
          "data-proposal-id": attrs.proposalId,
          "data-target-change-id": attrs.targetChangeId,
          "data-question": attrs.question,
          "data-selection-mode": attrs.selectionMode,
          "data-required": String(attrs.required),
          "data-status": attrs.status,
          "data-selected-option-id": attrs.selectedOptionId || undefined,
          "data-other-text": attrs.otherText || undefined,
          "data-resolved-at": attrs.resolvedAt || undefined,
        },
      ];
    },
  });
}

export { defineKukuDecision };
