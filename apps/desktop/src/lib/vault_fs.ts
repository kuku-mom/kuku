import { invoke } from "@tauri-apps/api/core";

import type {
  ChecksumWriteResult,
  FileChangeEvent,
  FileEntry,
  FileReadResult,
} from "~/lib/vault_types";

async function vaultOpen(path: string): Promise<void> {
  await invoke<void>("vault_open", { path });
}

async function vaultClose(): Promise<void> {
  await invoke<void>("vault_close");
}

async function vaultGetCurrent(): Promise<string | null> {
  return invoke<string | null>("vault_get_current");
}

async function readFile(path: string): Promise<string> {
  return invoke<string>("vault_read_text", { path });
}

async function writeFile(path: string, content: string): Promise<void> {
  await invoke<void>("vault_write_text", { path, content });
}

async function readFileWithChecksum(path: string): Promise<FileReadResult> {
  return invoke<FileReadResult>("vault_read_with_checksum", { path });
}

async function writeFileWithChecksum(
  path: string,
  content: string,
  checksum: string,
): Promise<ChecksumWriteResult> {
  return invoke<ChecksumWriteResult>("vault_write_with_checksum", { path, content, checksum });
}

async function listDirectory(path = ""): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("vault_list_dir", { path });
}

async function exists(path: string): Promise<boolean> {
  return invoke<boolean>("vault_exists", { path });
}

async function mkdir(path: string): Promise<void> {
  await invoke<void>("vault_mkdir", { path });
}

async function remove(path: string): Promise<void> {
  await invoke<void>("vault_remove", { path });
}

async function rename(from: string, to: string): Promise<void> {
  await invoke<void>("vault_rename", { from, to });
}

async function chooseVaultDirectory(): Promise<string | null> {
  return invoke<string | null>("vault_choose_directory");
}

export {
  chooseVaultDirectory,
  exists,
  listDirectory,
  mkdir,
  readFile,
  readFileWithChecksum,
  remove,
  rename,
  vaultClose,
  vaultGetCurrent,
  vaultOpen,
  writeFile,
  writeFileWithChecksum,
};
export type { ChecksumWriteResult, FileChangeEvent, FileEntry, FileReadResult };

// Backwards-compatible aliases used by existing UI.
export {
  vaultOpen as openVault,
  vaultClose as closeVault,
  vaultGetCurrent as getCurrentVault,
  readFile as readVaultFile,
  writeFile as writeVaultFile,
  readFileWithChecksum as readVaultFileWithChecksum,
  writeFileWithChecksum as writeVaultFileWithChecksum,
  listDirectory as listVaultFiles,
  exists as vaultExists,
  mkdir as vaultMkdir,
  remove as vaultRemove,
  rename as vaultRename,
};
