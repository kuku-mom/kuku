interface EditableNameParts {
  editableName: string;
  preservedExtension: string | null;
}

function getPathName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function getParentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash !== -1 ? path.slice(0, lastSlash) : "";
}

function joinVaultPath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

function splitNameForEditing(name: string, isDir: boolean): EditableNameParts {
  if (isDir || name.endsWith(".")) {
    return {
      editableName: name,
      preservedExtension: null,
    };
  }

  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) {
    return {
      editableName: name,
      preservedExtension: null,
    };
  }

  return {
    editableName: name.slice(0, lastDot),
    preservedExtension: name.slice(lastDot),
  };
}

function buildNameFromEditable(
  editableName: string,
  preservedExtension: string | null | undefined,
): string {
  return `${editableName}${preservedExtension ?? ""}`;
}

// Vault paths are compared case-insensitively to match macOS APFS and
// Windows NTFS defaults. A case-only rename like `Notes/` → `notes/`
// must remap descendant tabs / selections; otherwise they hold a stale
// casing and reconciliation drops them.
function pathEqualsIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

function pathStartsWithIgnoreCase(path: string, prefix: string): boolean {
  return (
    path.length >= prefix.length &&
    path.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
  );
}

function isSameOrDescendantPath(path: string, targetPath: string, isDir: boolean): boolean {
  if (pathEqualsIgnoreCase(path, targetPath)) return true;
  return isDir && pathStartsWithIgnoreCase(path, `${targetPath}/`);
}

function remapMovedPath(path: string, from: string, to: string, isDir: boolean): string {
  if (pathEqualsIgnoreCase(path, from)) {
    return to;
  }

  if (isDir && pathStartsWithIgnoreCase(path, `${from}/`)) {
    return `${to}${path.slice(from.length)}`;
  }

  return path;
}

function remapPathSet(
  paths: Iterable<string>,
  from: string,
  to: string,
  isDir: boolean,
): Set<string> {
  return new Set([...paths].map((path) => remapMovedPath(path, from, to, isDir)));
}

export {
  buildNameFromEditable,
  getParentPath,
  getPathName,
  isSameOrDescendantPath,
  joinVaultPath,
  pathEqualsIgnoreCase,
  remapMovedPath,
  remapPathSet,
  splitNameForEditing,
};
export type { EditableNameParts };
