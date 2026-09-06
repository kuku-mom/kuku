import { beforeEach, describe, expect, it, vi } from "vitest";
import { vaultClose, writeFileWithChecksum } from "../vault_fs";

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
beforeEach(() => ipc.invoke.mockReset());

describe("shared checksum write ordering", () => {
  it("serializes editor and plugin writes to the same canonical path", async () => {
    let finish!: (result: unknown) => void;
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    ipc.invoke.mockResolvedValue({ status: "Conflict", expected: "old", actual: "new" });
    const first = writeFileWithChecksum("Notes/a.md", "first", "old");
    const second = writeFileWithChecksum("notes/./a.md", "second", "old");
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce());
    finish({ status: "Written", checksum: "new" });
    await first;
    expect(await second).toMatchObject({ status: "Conflict" });
    expect(ipc.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not poison later saves after an IPC failure", async () => {
    ipc.invoke.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(writeFileWithChecksum("failure.md", "first", "old")).rejects.toThrow(
      "Disk unavailable",
    );
    ipc.invoke.mockResolvedValueOnce({ status: "Written", checksum: "new" });
    await expect(writeFileWithChecksum("failure.md", "retry", "old")).resolves.toMatchObject({
      status: "Written",
    });
  });

  it("cancels a queued save if the user switches vaults before it starts", async () => {
    let finish!: (result: unknown) => void;
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    ipc.invoke.mockResolvedValue(undefined);
    const first = writeFileWithChecksum("switch.md", "first", "old");
    const queued = writeFileWithChecksum("switch.md", "second", "old");
    const rejected = expect(queued).rejects.toThrow(/vault changed/);
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce());
    await vaultClose();
    finish({ status: "Written", checksum: "new" });
    await first;
    await rejected;
    expect(
      ipc.invoke.mock.calls.filter(([command]) => command === "vault_write_with_checksum"),
    ).toHaveLength(1);
  });
});
