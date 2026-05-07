const DECISION_NODE_SELECTOR = "[data-kuku-decision-node]";
const INTERACTIVE_SELECTOR =
  "textarea,input,select,button,[contenteditable='true'],[data-kuku-decision-interactive]";

function stopKukuDecisionNodeEvent(event: Event): boolean {
  return isKukuDecisionInteractiveEventTarget(event.target);
}

function isKukuDecisionInteractiveEventTarget(target: EventTarget | null): boolean {
  const element = toElement(target);
  if (!element) return false;

  const root = element.closest(DECISION_NODE_SELECTOR);
  const interactive = element.closest(INTERACTIVE_SELECTOR);

  if (!root || !interactive) return false;
  return root.contains(interactive);
}

function toElement(target: EventTarget | null): Element | null {
  if (!target || typeof Element === "undefined") return null;
  if (target instanceof Element) return target;

  if (typeof Node !== "undefined" && target instanceof Node) {
    return target.parentElement;
  }

  return null;
}

export { isKukuDecisionInteractiveEventTarget, stopKukuDecisionNodeEvent };
