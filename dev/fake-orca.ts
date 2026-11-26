// A stand-in for Orca's frame API: the worker answers from the fixture, storage lives in memory.
// URL parameters: theme=light|dark, view=inbox|focus|matrix|classic, lang=ko|en, empty=1, press=<button text>,...
import { boardSnapshot } from "../src/paseo/shared/contract";
import { fixtureSnapshot } from "./fixture";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.add(theme);

const snapshot = boardSnapshot.output.parse(fixtureSnapshot());
if (params.get("empty")) {
  snapshot.sessions = snapshot.sessions.filter(session => session.lane !== "human");
  snapshot.trackedDecisions = { status: "ok", items: [] };
  snapshot.pullRequests = undefined;
}
const storage = new Map<string, unknown>([
  ["device-setting:board-view", { mode: params.get("view") ?? "inbox" }],
  ["device-setting:board-language", { language: params.get("lang") ?? "ko" }],
]);

const handlers: Record<string, (input: any) => unknown> = {
  "board.snapshot": () => structuredClone(snapshot),
  "board.readiness": () => ({ configured: true, coordinator: null }),
  "board.scope": (input: { projectId: string; enabled: boolean }) => {
    const project = snapshot.projects.find(p => p.id === input.projectId);
    if (project) project.selected = input.enabled;
    return { ok: true };
  },
  "board.open-session": (input: { sessionId: string }) => {
    console.info("open-session", input.sessionId);
    return { opened: true };
  },
};

const disposable = { dispose() {} };
(globalThis as any).orca = {
  locale: "ko-KR",
  plugin: {
    async request(name: string, input: unknown) {
      const handler = handlers[name];
      if (!handler) throw Object.assign(new Error("unknown_method: " + name), { code: "unknown_method" });
      return handler(input);
    },
    on: () => disposable,
  },
  storage: {
    async get(key: string) { return storage.get(key) ?? null; },
    async set(key: string, value: unknown) { storage.set(key, value); },
    async delete(key: string) { storage.delete(key); },
    async keys() { return [...storage.keys()]; },
    onDidChange: () => disposable,
  },
  document: { get: async () => ({ version: 1, readOnly: true, content: { kind: "text", text: "" } }) },
  shell: { openExternal: async () => ({ opened: true }) },
  on: () => disposable,
};

const presses = params.get("press")?.split(",") ?? [];
async function pressAll() {
  for (const label of presses) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const target = Array.from(document.querySelectorAll<HTMLElement>("button")).find(button => button.textContent?.trim().startsWith(label));
    target?.click();
  }
}
window.addEventListener("load", () => void pressAll());
