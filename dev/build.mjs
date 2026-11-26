// Builds the dashboard frame against a fake window.orca into dev/out/index.html, with Orca's built-in
// theme tokens baked in the way Orca's frame shell bakes them.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

const light = { background: "#fff", foreground: "#0a0a0a", card: "#fff", "card-foreground": "#0a0a0a", popover: "#fff", "popover-foreground": "#0a0a0a",
  primary: "#171717", "primary-foreground": "#fafafa", secondary: "#f5f5f5", "secondary-foreground": "#171717", muted: "#f5f5f5", "muted-foreground": "#696969",
  accent: "#f5f5f5", "accent-foreground": "#171717", destructive: "#e40014", "destructive-foreground": "#fff", border: "#e5e5e5", input: "#e5e5e5", ring: "#a1a1a1" };
const dark = { background: "#0a0a0a", foreground: "#f0f0f0", card: "#171717", "card-foreground": "#f0f0f0", popover: "#171717", "popover-foreground": "#f0f0f0",
  primary: "#e5e5e5", "primary-foreground": "#171717", secondary: "#262626", "secondary-foreground": "#f0f0f0", muted: "#262626", "muted-foreground": "#acacac",
  accent: "#404040", "accent-foreground": "#f0f0f0", destructive: "#ff6568", "destructive-foreground": "#450a0a", border: "rgb(255 255 255 / 0.07)", input: "rgb(255 255 255 / 0.15)", ring: "#737373" };
const shared = { radius: "0.625rem", "font-sans": "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  "font-mono": "'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace" };
const vars = tokens => Object.entries({ ...tokens, ...shared }).map(([name, value]) => `--orca-${name}:${value}`).join(";");

const result = await build({
  entryPoints: ["dev/harness.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  jsx: "automatic", jsxImportSource: "react", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning", outfile: "harness.js",
});
await mkdir("dev/out", { recursive: true });
await writeFile("dev/out/harness.js", result.outputFiles[0].contents);
await writeFile("dev/out/index.html", `<!doctype html><html><head><meta charset="utf-8"><title>Coordinator Board harness</title>
<style id="orca-design-tokens">html.light{${vars(light)}}html.dark{${vars(dark)}}</style></head>
<body><script type="module" src="harness.js"></script></body></html>`);
console.log("dev/out/index.html");
