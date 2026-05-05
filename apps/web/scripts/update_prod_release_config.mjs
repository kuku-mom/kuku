import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(scriptDir, "../src/config/prod_release.ts");
const stringLiteral = String.raw`"(?:\\.|[^"\\])*"`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function constantPattern(name) {
  return new RegExp(`const\\s+${name}\\s*=\\s*(${stringLiteral});`);
}

function readStringConstant(source, name) {
  const match = source.match(constantPattern(name));
  if (!match?.[1]) {
    fail(`Missing string constant: ${name}`);
  }

  return JSON.parse(match[1]);
}

function replaceStringConstant(source, name, value) {
  const pattern = constantPattern(name);
  if (!pattern.test(source)) {
    fail(`Missing string constant: ${name}`);
  }

  return source.replace(pattern, `const ${name} = ${JSON.stringify(value)};`);
}

function readField(field) {
  const source = readFileSync(configPath, "utf8");
  const fieldToConstant = {
    apiBaseUrl: "apiBaseUrl",
    githubRepo: "githubRepo",
    siteUrl: "siteUrl",
    webUrl: "webUrl",
    version: "version",
  };
  const constantName = fieldToConstant[field];

  if (!constantName) {
    fail(`Unknown field: ${field}`);
  }

  process.stdout.write(readStringConstant(source, constantName));
}

function writeRelease(version, pubDate, signature) {
  let source = readFileSync(configPath, "utf8");

  source = replaceStringConstant(source, "version", version);
  source = replaceStringConstant(source, "pubDate", pubDate);
  source = replaceStringConstant(source, "signature", signature);

  writeFileSync(configPath, source);
}

const [command, ...args] = process.argv.slice(2);

if (command === "read") {
  const [field] = args;
  if (!field) {
    fail("Usage: node scripts/update_prod_release_config.mjs read <field>");
  }

  readField(field);
} else if (command === "write") {
  const [version, pubDate, signature] = args;
  if (!version || !pubDate || !signature) {
    fail(
      "Usage: node scripts/update_prod_release_config.mjs write <version> <pubDate> <signature>",
    );
  }

  writeRelease(version, pubDate, signature);
} else {
  fail(
    "Usage: node scripts/update_prod_release_config.mjs read <field> | write <version> <pubDate> <signature>",
  );
}
