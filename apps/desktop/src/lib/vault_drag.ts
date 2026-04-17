import type { FileEntry } from "~/lib/vault_fs";

interface VaultEntryDragPayload {
  path: string;
  name: string;
  isDirectory: boolean;
}

function createVaultEntryDragPayload(
  entry: Pick<FileEntry, "path" | "name" | "is_directory">,
): VaultEntryDragPayload {
  return {
    path: entry.path,
    name: entry.name,
    isDirectory: entry.is_directory,
  };
}
export { createVaultEntryDragPayload };
export type { VaultEntryDragPayload };
