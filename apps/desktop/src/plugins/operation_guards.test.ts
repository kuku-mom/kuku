import { describe, expect, it, vi } from "vitest";
import { allowOperation, registerOperationGuard } from "./operation_guards";

describe("plugin operation guards", () => {
  it("waits for finalization, allows unrelated tabs and preserves a failed save", async () => {
    let finish!: (value: boolean) => void;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = registerOperationGuard({
      matches: (operation) => operation.kind !== "close-tab" || operation.tabId === "recording",
      confirm,
    });
    try {
      expect(await allowOperation({ kind: "close-tab", tabId: "other" })).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      const leaving = allowOperation({ kind: "change-vault" });
      finish(false);
      expect(await leaving).toBe(false);
      const closing = allowOperation({ kind: "close-tab", tabId: "recording" });
      finish(true);
      expect(await closing).toBe(true);
    } finally {
      dispose();
    }
    expect(await allowOperation({ kind: "exit" })).toBe(true);
  });
});
