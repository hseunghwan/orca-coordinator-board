// Adapted from paseo-coordinator-board server/project-icons.ts @ 2e9d128: the favicon discovery for a project
// Orca shows without an icon. Orca keeps uploaded project icons itself (repo list's repoIcon), so there is no
// uploaded icon to read here. SVG is skipped: the dashboard frame draws only raster data: URLs (src/orca/view.ts),
// and Paseo's SVG check is its SDK's code. A found icon is kept for a few minutes per folder.
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const priority = ["public", "static", "priv/static", "assets", "images", "img"];
const ignored = new Set([".git", "node_modules", "dist", "build", ".next", ".nuxt", ".output", "coverage", ".cache", "vendor", "src", "lib", "test", "tests", "__tests__"]);
const names = [
  /^favicon\.png$/, /^favicon-.*\.png$/, /^favico\.png$/, /^icon\.png$/, /^app-icon\.png$/,
  /^apple-touch-icon\.png$/, /^apple-touch-icon-.*\.png$/, /^icon-.*\.png$/, /^android-chrome-.*\.png$/,
  /^mstile-.*\.png$/, /^logo\.png$/, /^favicon\.ico$/, /^favico\.ico$/,
];
const MAX_BYTES = 32 * 1024;
const CACHE_MS = 5 * 60_000;

async function readIcon(path: string) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > MAX_BYTES) return undefined;
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length);
      if (bytesRead > MAX_BYTES) return undefined;
      const image = bytes.subarray(0, bytesRead);
      const mime = image.subarray(0, 8).equals(png) ? "image/png"
        : image.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg"
        : image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
        : image.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) ? "image/x-icon"
        : undefined;
      return mime && `data:${mime};base64,${image.toString("base64")}`;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function scan(dir: string, depth: number): Promise<string | undefined> {
  const children = await entries(dir);
  const files = children.filter(entry => entry.isFile());
  for (const pattern of names) {
    for (const file of files) {
      if (!pattern.test(file.name)) continue;
      const icon = await readIcon(join(dir, file.name));
      if (icon) return icon;
    }
  }
  if (!depth) return undefined;
  for (const child of children) {
    if (!child.isDirectory() || ignored.has(child.name)) continue;
    const icon = await scan(join(dir, child.name), depth - 1);
    if (icon) return icon;
  }
}

async function scanPriority(root: string) {
  for (const folder of priority) {
    const icon = await scan(join(root, folder), 2);
    if (icon) return icon;
  }
}

export async function discoverIcon(root: string) {
  if (!isAbsolute(root)) return undefined;
  const rootIcon = await scanPriority(root);
  if (rootIcon) return rootIcon;
  for (const folder of ["packages", "apps"]) {
    const directory = join(root, folder);
    for (const child of await entries(directory)) {
      if (!child.isDirectory()) continue;
      const project = join(directory, child.name);
      const icon = await scanPriority(project) ?? await scan(project, 0);
      if (icon) return icon;
    }
  }
  return scan(root, 0);
}

export class ProjectIcons {
  private readonly found = new Map<string, { at: number; icon: Promise<string | undefined> }>();
  constructor(private readonly now: () => number = Date.now) {}
  /** Orca's icon when it has one, else a favicon found in the project folder. */
  read(root: string, orcaIcon: string | undefined): Promise<string | undefined> {
    if (orcaIcon || !root) return Promise.resolve(orcaIcon);
    const cached = this.found.get(root);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.icon;
    const icon = discoverIcon(root).catch(() => undefined);
    this.found.set(root, { at: this.now(), icon });
    return icon;
  }
}
