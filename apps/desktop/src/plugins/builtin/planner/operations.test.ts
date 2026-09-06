import { describe, expect, it } from "vitest";
import type { PluginContext } from "~/plugins/types";
import { journalPath, loadOperations, patchMatches, saveOperations } from "./operations";
import type { ExternalItem, PendingOperation } from "./types";

describe("Planner retry journal", () => {
  it("restores interrupted operations with the same idempotency identity and isolates vaults", async () => {
    const files = new Map<string, string>();
    const fs = {
      exists: async (path: string) => files.has(path),
      readFile: async (path: string) => files.get(path)!,
      writeFile: async (path: string, value: string) => {
        files.set(path, value);
      },
    } as PluginContext["fs"];
    const operation: PendingOperation = {
      id: "same-id",
      type: "create",
      provider: "google",
      calendarId: "work",
      draft: { title: "Task", allDay: false },
      stage: "remote",
      status: "pending",
      attempts: 1,
      createdAt: "2026-09-04T01:00:00Z",
    };
    await saveOperations(fs, "/one", [operation]);
    expect((await loadOperations(fs, "/one"))[0]).toMatchObject({
      id: "same-id",
      status: "failed",
      attempts: 1,
    });
    expect(await loadOperations(fs, "/two")).toEqual([]);
    files.set(journalPath("/two"), files.get(journalPath("/one"))!);
    await expect(loadOperations(fs, "/two")).rejects.toThrow("does not match");
  });
  it("recognizes lost successful updates by requested fields, including equivalent instants and clearing", () => {
    const item: ExternalItem = {
      id: "event",
      provider: "google",
      calendarId: "work",
      title: "Edited",
      kind: "event",
      allDay: false,
      start: "2026-09-04T10:00:00+09:00",
      end: "2026-09-04T10:30:00+09:00",
    };
    expect(
      patchMatches(item, { title: "Edited", start: "2026-09-04T01:00:00Z", location: null }),
    ).toBe(true);
    expect(patchMatches(item, { title: "Different" })).toBe(false);
    expect(patchMatches(item, { start: "2026-09-04T02:00:00Z" })).toBe(false);
  });
  it("keeps operations from a new plugin instance when an older response arrives late", async () => {
    const files = new Map<string, string>();
    const fs = {
      exists: async (path: string) => files.has(path),
      readFile: async (path: string) => files.get(path)!,
      writeFile: async (path: string, value: string) => {
        files.set(path, value);
      },
    } as PluginContext["fs"];
    const older = await loadOperations(fs, "/vault");
    older.push({
      id: "old",
      type: "create",
      provider: "google",
      calendarId: "work",
      draft: { title: "Old", allDay: false },
      stage: "remote",
      status: "pending",
      attempts: 1,
      createdAt: "2026-09-04T01:00:00Z",
    });
    await saveOperations(fs, "/vault", older);
    const newer = await loadOperations(fs, "/vault");
    newer.push({ ...older[0], id: "new", draft: { title: "New", allDay: false } });
    await saveOperations(fs, "/vault", newer);
    older[0].status = "failed";
    await saveOperations(fs, "/vault", older);
    expect((await loadOperations(fs, "/vault")).map((operation) => operation.id).sort()).toEqual([
      "new",
      "old",
    ]);
  });
});
