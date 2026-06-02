import { describe, expect, it } from "vitest";

import { formatToolIdentity, getToolDisplayInfo, getToolDisplayKind } from "./tool_identity";

describe("ai_chat tool identity", () => {
  it("uses the ACP tool title instead of the synthetic call id for display", () => {
    const info = getToolDisplayInfo("acp.call_6CbUgZx6ORTi4qsMuAlKHbiB", "Read file");

    expect(info.label).toBe("Read file");
    expect(formatToolIdentity("acp.call_6CbUgZx6ORTi4qsMuAlKHbiB", "Read file")).toBe(
      "Read file",
    );
  });

  it("keeps built-in tool ids available for kind-specific details", () => {
    expect(getToolDisplayKind("builtin.read_file", "read_file")).toBe("read_file");
  });
});
