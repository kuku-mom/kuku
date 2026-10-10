import { describe, expect, it, vi } from "vitest";

import { PlannerRequestReceipts } from "./ai_tools_receipts";

function store() {
  const files = new Map<string, string>();
  return {
    files,
    exists: vi.fn(async (path: string) => files.has(path)),
    readFile: vi.fn(async (path: string) => files.get(path)!),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
  };
}
const locator = { kind: "task" as const, path: "Tasks/Inbox.md", taskId: "stable-task-id" };
const noop = () => {};

describe("Planner durable creation receipts", () => {
  it("persists started before creation, deduplicates concurrent calls, and replays after restart", async () => {
    const fs = store();
    const receipts = new PlannerRequestReceipts(fs);
    const create = vi.fn(async () => {
      expect([...fs.files.values()].map((value) => JSON.parse(value))[0].status).toBe("started");
      return locator;
    });
    const first = receipts.run("/vault", "request-001", { title: "Task" }, noop, create);
    const second = receipts.run("/vault", "request-001", { title: "Task" }, noop, create);
    expect((await first).replayed).toBe(false);
    expect((await second).replayed).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    const replay = await new PlannerRequestReceipts(fs).run(
      "/vault",
      "request-001",
      { title: "Task" },
      noop,
      create,
    );
    expect(replay).toEqual({ result: locator, replayed: true, durable: true });
    expect(create).toHaveBeenCalledOnce();
    await expect(
      new PlannerRequestReceipts(fs).run(
        "/vault",
        "request-001",
        { title: "Different" },
        noop,
        create,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
  });

  it("does not replay a started request after a lost response or a failed receipt completion", async () => {
    const fs = store();
    let writes = 0;
    fs.writeFile.mockImplementation(async (path, value) => {
      if (++writes === 2) throw new Error("disk failed after remote create");
      fs.files.set(path, value);
    });
    const create = vi.fn(async () => locator);
    await expect(
      new PlannerRequestReceipts(fs).run("/vault", "request-001", {}, noop, create),
    ).rejects.toThrow("disk failed");
    await expect(
      new PlannerRequestReceipts(fs).run("/vault", "request-001", {}, noop, create),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("prevents creation if initial persistence or lifecycle validation fails", async () => {
    const fs = store();
    const create = vi.fn(async () => locator);
    fs.writeFile.mockRejectedValueOnce(new Error("unwritable"));
    await expect(
      new PlannerRequestReceipts(fs).run("/vault", "request-001", {}, noop, create),
    ).rejects.toThrow("unwritable");
    await expect(
      new PlannerRequestReceipts(fs).run(
        "/vault",
        "request-002",
        {},
        () => {
          throw new Error("disabled");
        },
        create,
      ),
    ).rejects.toThrow("disabled");
    expect(create).not.toHaveBeenCalled();
  });

  it("isolates equal request IDs across vaults and rejects corrupt or foreign receipt locators", async () => {
    const fs = store();
    const create = vi.fn(async () => locator);
    await new PlannerRequestReceipts(fs).run("/vault-a", "request-001", {}, noop, create);
    await new PlannerRequestReceipts(fs).run("/vault-b", "request-001", {}, noop, create);
    expect(fs.files.size).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
    const path = [...fs.files.keys()][0];
    const receipt = JSON.parse(fs.files.get(path)!);
    fs.files.set(
      path,
      JSON.stringify({ ...receipt, result: { kind: "note", path: "../outside.md" } }),
    );
    await expect(
      new PlannerRequestReceipts(fs).run("/vault-a", "request-001", {}, noop, create),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    fs.files.set(path, JSON.stringify({ ...receipt, root: "/foreign" }));
    await expect(
      new PlannerRequestReceipts(fs).run("/vault-a", "request-001", {}, noop, create),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
