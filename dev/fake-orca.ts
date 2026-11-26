// A stand-in for Orca's frame API: the worker answers from the fixture, storage lives in memory.
// URL parameters: theme=light|dark, view=inbox|focus|matrix|classic, lang=ko|en, empty=1, press=<button text>,...
// send=<n> starts the reply outcomes at the n-th of: confirmed, unconfirmed delivery, a receipt for another recipient.
import { clarificationKey, askClarification } from "../src/paseo/shared/clarifications";
import { boardSnapshot } from "../src/paseo/shared/contract";
import { sendDecision } from "../src/paseo/shared/decision-actions";
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

const outcomes = ["confirmed", "uncertain", "other-recipient"] as const;
let sends = Number(params.get("send") ?? 0);
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

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
  "board.send-decision": async (raw: unknown) => {
    const input = sendDecision.input.parse(raw);
    await settle();
    const outcome = outcomes[sends++ % outcomes.length];
    if (outcome === "uncertain") throw Object.assign(new Error("delivery_uncertain"), { code: "delivery_uncertain" });
    if (outcome === "other-recipient") return { ok: true, recipientId: "s-other", messageId: crypto.randomUUID() };
    const session = snapshot.sessions.find(row => row.id === input.sessionId)!;
    snapshot.replyHistory = [{ key: input.requestKey, status: "sent", title: session.decision?.question ?? session.title, projectId: session.projectId,
      at: new Date().toISOString(), recipientId: session.id, recipientTitle: session.title, recipientState: "running", canOpen: true, answer: input.text },
      ...snapshot.replyHistory ?? []];
    Object.assign(session, { lane: "review", status: "running", decisionAnswered: true, decision: undefined, detail: "답장을 보냈습니다. 담당 세션의 결과를 기다립니다." });
    return { ok: true, recipientId: input.recipientId, messageId: crypto.randomUUID() };
  },
  "board.ask-clarification": async (raw: unknown) => {
    const input = askClarification.input.parse(raw);
    await settle();
    const messageId = crypto.randomUUID();
    snapshot.clarifications = [...snapshot.clarifications ?? [], { cardKey: clarificationKey(input.card), messageId, recipientId: input.recipientId,
      question: input.question, at: new Date().toISOString(), status: "sent" }];
    return { ok: true, recipientId: input.recipientId, messageId };
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

// Every card stays mounted while hidden, so a press goes to the first visible button with that text.
const presses = params.get("press")?.split(",") ?? [];
async function pressAll() {
  for (const label of presses) {
    await new Promise(resolve => setTimeout(resolve, 450));
    const target = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find(button => button.offsetParent !== null && button.textContent?.trim().startsWith(label));
    target?.click();
  }
}
window.addEventListener("load", () => void pressAll());
