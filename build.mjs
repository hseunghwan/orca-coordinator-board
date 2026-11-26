// Bundles the worker and the dashboard frame into dist/. Orca plugins get no node_modules, so
// everything they import from npm has to be inside these files.
import { writeFileSync } from "node:fs";
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
const common = { bundle: true, logLevel: "info", sourcemap: false, minify: !watch };
const targets = [
  { ...common, entryPoints: ["src/worker.ts"], outfile: "dist/worker.mjs", platform: "node", format: "esm", target: "node20" },
  {
    ...common, entryPoints: ["src/dashboard/main.tsx"], outfile: "dist/dashboard.js", platform: "browser", format: "esm", target: "es2022",
    jsx: "automatic", jsxImportSource: "react", define: { "process.env.NODE_ENV": '"production"' },
  },
];

// Orca treats a declared frame entry as a document whatever its extension, so the entry is this page
// and the bundle is a script it loads.
writeFileSync("dist/dashboard.html", '<!doctype html>\n<html><head><meta charset="utf-8"><title>Coordinator Board</title></head><body><script type="module" src="./dashboard.js"></script></body></html>\n');

if (watch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(targets.map((options) => build(options)));
}
