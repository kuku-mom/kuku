import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";
const mode = process.argv[2];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    shell: isWindows,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function installGoTools() {
  const bin = join(root, ".bin");
  mkdirSync(bin, { recursive: true });
  run("go", ["install", "tool"], {
    env: {
      GOBIN: bin,
    },
  });
}

function hasRustTools() {
  return [
    "protoc-gen-buffa",
    "protoc-gen-buffa-packaging",
    "protoc-gen-connect-rust",
  ].every((name) => existsSync(join(root, ".cargo-tools", "bin", `${name}${exe}`)));
}

function installRustTools() {
  if (hasRustTools()) {
    return;
  }

  const cargoHome = join(root, ".cache", "cargo");
  const rootArg = join(root, ".cargo-tools");
  const tools = [
    ["protoc-gen-buffa", "0.3.0"],
    ["protoc-gen-buffa-packaging", "0.3.0"],
    ["connectrpc-codegen", "0.3.2"],
  ];

  for (const [name, version] of tools) {
    run("cargo", ["install", "--locked", "--root", rootArg, name, "--version", version], {
      env: {
        CARGO_HOME: cargoHome,
      },
    });
  }
}

if (mode === "go") {
  installGoTools();
} else if (mode === "rust") {
  installRustTools();
} else {
  console.error("Usage: node scripts/install-tools.mjs <go|rust>");
  process.exit(1);
}
