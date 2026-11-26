// Copies the files listed in src/paseo/UPSTREAM.md from a paseo-coordinator-board checkout and
// points their imports at the local stand-ins. Usage: node scripts/sync-paseo.mjs <checkout>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const upstream = process.argv[2];
if (!upstream) {
  console.error("usage: node scripts/sync-paseo.mjs <paseo-coordinator-board checkout>");
  process.exit(1);
}

const manifestPath = "src/paseo/UPSTREAM.md";
const manifest = readFileSync(manifestPath, "utf8");
const list = manifest.split(/^## 옮긴 파일$/m)[1].split(/^## /m)[0];
const files = [...list.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);

const rewrites = {
  shared: { "@getpaseo/plugin": "../plugin-shim" },
  client: {
    "@getpaseo/plugin": "../plugin-shim",
    "@getpaseo/plugin/client": "../plugin-shim",
    "./language": "../view-types",
    "./board-layout": "../view-types",
    "./remote-running": "../view-types",
  },
  test: {
    "bun:test": "vitest",
    "../client/board-layout": "../view-types",
    "../client/remote-running": "../view-types",
  },
};

for (const file of files) {
  const table = rewrites[file.split("/")[0]] ?? {};
  const text = readFileSync(join(upstream, file), "utf8").replace(
    /(\bfrom\s*)(["'])([^"']+)\2/g,
    (whole, from, quote, specifier) => (specifier in table ? from + quote + table[specifier] + quote : whole),
  );
  const target = join("src/paseo", file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

const sha = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(manifestPath, manifest.replace(/^Commit: `[0-9a-f]+`$/m, `Commit: \`${sha}\``));
console.log(`${files.length} files from ${sha}`);
