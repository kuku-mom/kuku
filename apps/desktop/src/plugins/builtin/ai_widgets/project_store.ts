import { invoke } from "@tauri-apps/api/core";

import type {
  WidgetProject,
  WidgetProjectFile,
  WidgetProjectSummary,
  WidgetSaveInput,
  WidgetType,
} from "./types";
import { assertSafeWidgetSource } from "./iframe_document";

const AI_WIDGETS_PLUGIN_ID = "ai-widgets";
const PROJECTS_DIR = "projects";

interface WidgetProjectFs {
  readDir(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
}

interface WidgetProjectStoreOptions {
  now?: () => string;
  fs?: WidgetProjectFs;
}

interface WidgetProjectStore {
  save(input: WidgetSaveInput): Promise<WidgetProject>;
  list(): Promise<WidgetProjectSummary[]>;
  read(id: string): Promise<WidgetProject>;
}

function createWidgetProjectStore(options: WidgetProjectStoreOptions = {}): WidgetProjectStore {
  const fs = options.fs ?? createTauriWidgetProjectFs();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async save(input) {
      const requestedId = normalizeWidgetId(input.widgetId ?? input.name);
      const isExplicitUpdate = input.widgetId != null && input.widgetId.trim().length > 0;
      const id = isExplicitUpdate ? requestedId : await nextAvailableWidgetId(fs, requestedId);
      const type = normalizeWidgetType(input.type);
      const files = normalizeFiles(input.files);
      const entry = input.entry ?? defaultEntryForType(type);
      assertSafeWidgetFilePath(entry);
      if (!files.some((file) => file.path === entry)) {
        throw new Error(`Widget entry file is missing: ${entry}`);
      }

      const timestamp = now();
      const previous = await readManifestIfExists(fs, id);
      const project: WidgetProject = {
        id,
        name: input.name.trim() || id,
        type,
        entry,
        files,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      await Promise.all(
        files.map((file) => fs.writeText(projectFilePath(id, file.path), file.content)),
      );
      await fs.writeText(manifestPath(id), JSON.stringify(toManifest(project), null, 2));
      return project;
    },

    async list() {
      let ids: string[];
      try {
        ids = await fs.readDir(PROJECTS_DIR);
      } catch {
        return [];
      }

      const summaries: WidgetProjectSummary[] = [];
      for (const id of ids) {
        try {
          assertSafeWidgetId(id);
          const manifest = await readManifest(fs, id);
          summaries.push({
            id: manifest.id,
            name: manifest.name,
            type: manifest.type,
            entry: manifest.entry,
            updatedAt: manifest.updatedAt,
          });
        } catch {
          // Ignore incomplete project folders; the next successful save repairs them.
        }
      }
      return sortedWidgetProjectSummaries(summaries);
    },

    async read(id) {
      assertSafeWidgetId(id);
      const manifest = await readManifest(fs, id);
      const files = normalizeFiles(
        await Promise.all(
          manifest.files.map(async (file) => ({
            path: file.path,
            content: await fs.readText(projectFilePath(id, file.path)),
          })),
        ),
        { validateSource: false },
      );
      return { ...manifest, files };
    },
  };
}

function createTauriWidgetProjectFs(): WidgetProjectFs {
  return {
    readDir(path) {
      return invoke<string[]>("vault_plugin_fs_read_dir", { pluginId: AI_WIDGETS_PLUGIN_ID, path });
    },
    readText(path) {
      return invoke<string>("vault_plugin_fs_read_text", { pluginId: AI_WIDGETS_PLUGIN_ID, path });
    },
    writeText(path, content) {
      return invoke<void>("vault_plugin_fs_write_text", {
        pluginId: AI_WIDGETS_PLUGIN_ID,
        path,
        content,
      });
    },
  };
}

async function nextAvailableWidgetId(fs: WidgetProjectFs, baseId: string): Promise<string> {
  if ((await readManifestIfExists(fs, baseId)) == null) return baseId;

  for (let suffix = 1; suffix <= 9999; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${baseId.slice(0, 64 - suffixText.length)}${suffixText}`;
    if ((await readManifestIfExists(fs, candidate)) == null) return candidate;
  }

  throw new Error(`Could not allocate widget id for: ${baseId}`);
}

async function readManifestIfExists(
  fs: WidgetProjectFs,
  id: string,
): Promise<WidgetProject | null> {
  try {
    return await readManifest(fs, id);
  } catch {
    return null;
  }
}

async function readManifest(fs: WidgetProjectFs, id: string): Promise<WidgetProject> {
  const raw = await fs.readText(manifestPath(id));
  const parsed: unknown = JSON.parse(raw);
  if (!isWidgetProjectManifest(parsed)) {
    throw new Error(`Invalid widget manifest: ${id}`);
  }
  return normalizeManifest(parsed, id);
}

function toManifest(project: WidgetProject): WidgetProject {
  return {
    ...project,
    files: project.files.map((file) => ({ path: file.path, content: "" })),
  };
}

function normalizeFiles(
  files: WidgetProjectFile[],
  options: { validateSource?: boolean } = {},
): WidgetProjectFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Widget requires at least one file");
  }

  const validateSource = options.validateSource ?? true;
  const seen = new Set<string>();
  return files.map((file) => {
    assertSafeWidgetFilePath(file.path);
    if (validateSource) {
      assertSafeWidgetSource(file.path, file.content);
    }
    if (seen.has(file.path)) {
      throw new Error(`Duplicate widget file path: ${file.path}`);
    }
    seen.add(file.path);
    return { path: file.path, content: file.content };
  });
}

function normalizeWidgetType(type: unknown): WidgetType {
  if (type !== "html" && type !== "svg") {
    throw new Error(`Unsupported widget type: ${String(type)}`);
  }
  return type;
}

function normalizeManifest(manifest: WidgetProject, requestedId: string): WidgetProject {
  assertSafeWidgetId(requestedId);
  assertSafeWidgetId(manifest.id);
  if (manifest.id !== requestedId) {
    throw new Error(`Widget manifest id mismatch: ${requestedId}`);
  }

  const type = normalizeWidgetType(manifest.type);
  assertSafeWidgetFilePath(manifest.entry);
  const files = normalizeFiles(manifest.files);
  if (!files.some((file) => file.path === manifest.entry)) {
    throw new Error(`Widget entry file is missing: ${manifest.entry}`);
  }

  return {
    id: manifest.id,
    name: manifest.name.trim() || manifest.id,
    type,
    entry: manifest.entry,
    files,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  };
}

function normalizeWidgetId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const id = slug || "widget";
  assertSafeWidgetId(id);
  return id;
}

function assertSafeWidgetId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`Unsafe widget id: ${id}`);
  }
}

function assertSafeWidgetFilePath(path: string): void {
  const unsafe =
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    !path.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part));

  if (unsafe) {
    throw new Error(`Unsafe widget file path: ${path}`);
  }
}

function defaultEntryForType(type: WidgetType): string {
  return type === "svg" ? "widget.svg" : "index.html";
}

function manifestPath(id: string): string {
  return `${PROJECTS_DIR}/${id}/manifest.json`;
}

function projectFilePath(id: string, path: string): string {
  return `${PROJECTS_DIR}/${id}/files/${path}`;
}

function sortedWidgetProjectSummaries(summaries: WidgetProjectSummary[]): WidgetProjectSummary[] {
  return insertSorted(
    summaries,
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

function insertSorted<T>(values: Iterable<T>, compare: (a: T, b: T) => number): T[] {
  const result: T[] = [];
  for (const value of values) {
    const index = result.findIndex((existing) => compare(value, existing) < 0);
    if (index === -1) {
      result.push(value);
    } else {
      result.splice(index, 0, value);
    }
  }
  return result;
}

function isWidgetProjectManifest(value: unknown): value is WidgetProject {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.name !== "string") return false;
  if (value.type !== "html" && value.type !== "svg") return false;
  if (typeof value.entry !== "string") return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (!Array.isArray(value.files)) return false;
  return value.files.every(
    (file) => isRecord(file) && typeof file.path === "string" && typeof file.content === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export {
  AI_WIDGETS_PLUGIN_ID,
  assertSafeWidgetFilePath,
  createWidgetProjectStore,
  defaultEntryForType,
  normalizeWidgetId,
};
export type { WidgetProjectFs, WidgetProjectStore, WidgetProjectStoreOptions };
