export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  children?: FileEntry[];
}

export interface FileChangeEvent {
  /** "create" | "modify" | "delete" | "rename" */
  kind: string;
  path: string;
  is_dir: boolean;
  old_path?: string;
}

export interface FileReadResult {
  content: string;
  checksum: string;
}

export type ChecksumWriteResult =
  | { status: "Written"; checksum: string }
  | { status: "Conflict"; expected: string; actual: string };
