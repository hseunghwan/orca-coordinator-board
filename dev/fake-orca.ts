// A stand-in for Orca's frame API: the worker answers from the fixture, storage lives in memory.
// URL parameters: theme=light|dark, view=inbox|focus|matrix|classic, lang=ko|en, empty=1, solo=1, press=<button text>,...
// solo=1 leaves one decision (the webhook reply), so sending it shows a board where everything is handled.
// send=<n> starts the reply outcomes at the n-th of: confirmed, unconfirmed delivery, a receipt for another recipient.
// coord=1 starts with a coordinator; fail=1 makes coordinator requests and setup fail.
import { clarificationKey, askClarification } from "../src/paseo/shared/clarifications";
import { boardSnapshot } from "../src/paseo/shared/contract";
import { sendDecision } from "../src/paseo/shared/decision-actions";
import { askDigest, requestWork } from "../src/paseo/shared/operations";
import { requestRecommendation } from "../src/paseo/shared/recommendation";
import { startCoordinator } from "../src/dashboard/rpc";
import { coordinatorSession, fixtureOperations, fixtureSnapshot } from "./fixture";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.add(theme);

const snapshot = boardSnapshot.output.parse(fixtureSnapshot());
if (params.get("empty")) {
  snapshot.sessions = snapshot.sessions.filter(session => session.lane !== "human");
  snapshot.trackedDecisions = { status: "ok", items: [] };
  snapshot.pullRequests = undefined;
}
function assignCoordinator(sessionId: string | null) {
  if (sessionId === coordinatorSession.id && !snapshot.sessions.some(session => session.id === sessionId)) snapshot.sessions.push(structuredClone(coordinatorSession));
  snapshot.coordinator = sessionId;
}
if (params.get("solo")) {
  snapshot.sessions = snapshot.sessions.filter(session => session.lane !== "human" || session.id === "s-webhook");
  snapshot.trackedDecisions = { status: "ok", items: [] };
  snapshot.pullRequests = undefined;
}
if (params.get("coord")) assignCoordinator(coordinatorSession.id);
const failing = !!params.get("fail");
const refuse = () => { throw Object.assign(new Error("delivery_uncertain: 코디네이터 세션이 작업 중이라 보내지 않았습니다."), { code: "delivery_uncertain" }); };

const storage = new Map<string, unknown>([
  ["device-setting:board-view", { mode: params.get("view") ?? "inbox" }],
  ["device-setting:board-language", { language: params.get("lang") ?? "ko" }],
]);

const outcomes = ["confirmed", "uncertain", "other-recipient"] as const;
let sends = Number(params.get("send") ?? 0);
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

const handlers: Record<string, (input: any) => unknown> = {
  "board.snapshot": () => structuredClone(snapshot),
  "board.readiness": () => ({ configured: true, coordinator: snapshot.coordinator }),
  "board.scope": (input: { kind: "project"; projectId: string; enabled: boolean } | { kind: "coordinator"; sessionId: string | null }) => {
    if (input.kind === "coordinator") assignCoordinator(input.sessionId);
    else {
      const project = snapshot.projects.find(p => p.id === input.projectId);
      if (project) project.selected = input.enabled;
    }
    return { ok: true };
  },
  "board.operations": () => fixtureOperations(),
  "board.setup-coordinator": async (raw: unknown) => {
    const input = startCoordinator.input.parse(raw);
    await settle();
    if (failing) throw new Error("setup_failed: 워크스페이스에서 터미널을 열지 못했습니다.");
    console.info("setup-coordinator", input.workspaceId);
    assignCoordinator(coordinatorSession.id);
    return { sessionId: coordinatorSession.id, workspaceId: input.workspaceId ?? null, reused: false };
  },
  "board.request-work": async (raw: unknown) => {
    requestWork.input.parse(raw);
    await settle();
    if (failing) refuse();
    return { ok: true };
  },
  "board.request-digest": async (raw: unknown) => {
    askDigest.input.parse(raw);
    await settle();
    if (failing) refuse();
    return { ok: true };
  },
  "board.request-recommendation": async (raw: unknown) => {
    const input = requestRecommendation.input.parse(raw);
    await settle();
    if (failing) refuse();
    return { ok: true, recipientId: input.coordinator, messageId: crypto.randomUUID() };
  },
  "board.open-session": (input: { sessionId: string }) => {
    console.info("open-session", input.sessionId);
    return { opened: true };
  },
  "board.send-decision": async (raw: unknown) => {
    const input = sendDecision.input.parse(raw);
    await settle();
    const outcome = outcomes[sends++ % outcomes.length];
    if (input.action === "coordinate" && outcome === "confirmed") return { ok: true, recipientId: input.recipientId, messageId: crypto.randomUUID() };
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
// "@<label>=<text>" types into the visible text box with that accessible label instead of pressing.
function type(label: string, text: string) {
  const box = Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea"))
    .find(area => area.offsetParent !== null && area.getAttribute("aria-label")?.startsWith(label));
  if (!box) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}
async function pressAll() {
  for (const label of presses) {
    await new Promise(resolve => setTimeout(resolve, 450));
    if (label.startsWith("@")) { const [name, ...text] = label.slice(1).split("="); type(name, text.join("=")); continue; }
    // "#<name>" matches the start of the accessible name, for buttons whose text starts with an icon.
    const named = label.startsWith("#") ? label.slice(1) : null;
    const target = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find(button => button.offsetParent !== null && (named === null ? button.textContent?.trim().startsWith(label) : button.getAttribute("aria-label")?.startsWith(named)));
    target?.click();
  }
}
window.addEventListener("load", () => void pressAll());
