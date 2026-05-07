// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  isKukuDecisionInteractiveEventTarget,
  stopKukuDecisionNodeEvent,
} from "./decision_node_events";

function createDecisionNode() {
  const root = document.createElement("section");
  root.setAttribute("data-kuku-decision-node", "");

  const title = document.createElement("span");
  title.textContent = "Remember this memory?";
  root.appendChild(title);

  const button = document.createElement("button");
  button.textContent = "Use memory";
  root.appendChild(button);

  const textarea = document.createElement("textarea");
  root.appendChild(textarea);

  document.body.appendChild(root);
  return { root, title, button, textarea };
}

describe("kuku decision node events", () => {
  it("stops editor handling for textarea keyboard events", () => {
    const { textarea } = createDecisionNode();
    const event = new KeyboardEvent("keydown", { bubbles: true });

    textarea.dispatchEvent(event);

    expect(stopKukuDecisionNodeEvent(event)).toBe(true);
  });

  it("stops editor handling for button pointer events", () => {
    const { button } = createDecisionNode();
    const event = new MouseEvent("mousedown", { bubbles: true });

    button.dispatchEvent(event);

    expect(stopKukuDecisionNodeEvent(event)).toBe(true);
  });

  it("treats text nodes inside controls as interactive targets", () => {
    const { button } = createDecisionNode();

    expect(isKukuDecisionInteractiveEventTarget(button.firstChild)).toBe(true);
  });

  it("does not stop editor handling for non-interactive decision chrome", () => {
    const { title } = createDecisionNode();
    const event = new MouseEvent("mousedown", { bubbles: true });

    title.dispatchEvent(event);

    expect(stopKukuDecisionNodeEvent(event)).toBe(false);
  });

  it("does not stop editor handling for controls outside a decision node", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const event = new KeyboardEvent("keydown", { bubbles: true });

    textarea.dispatchEvent(event);

    expect(stopKukuDecisionNodeEvent(event)).toBe(false);
  });
});
