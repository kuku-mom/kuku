import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const toolPaths = [join(root, ".bin"), join(root, ".cargo-tools", "bin")];
const env = {
  ...process.env,
  BUF_CACHE_DIR: ".cache/buf",
  [pathKey]: [...toolPaths, process.env[pathKey] ?? ""].join(delimiter),
};

const result = spawnSync("buf", process.argv.slice(2), {
  cwd: root,
  env,
  shell: isWindows,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
