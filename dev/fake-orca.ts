// A stand-in for Orca's frame API: the worker answers from the fixture, storage lives in memory.
// URL parameters: theme=light|dark, view=inbox|focus|matrix|classic (a saved classic opens the inbox), lang=ko|en, empty=1, solo=1, press=<button text>,...
// solo=1 leaves one decision (the webhook reply), so sending it shows a board where everything is handled.
// send=<n> starts the reply outcomes at the n-th of: confirmed, unconfirmed delivery, a receipt for another recipient.
// coord=1 starts with a coordinator; fail=1 makes coordinator requests and setup fail.
// ledger=1 adds the phase 5 ledger records; resolve=<status> answers every ledger reply with that status,
// merge=<blocked|unconfirmed|changed> answers the merge preview or confirm that way, pull=<OPEN|CLOSED|MERGED|UNKNOWN>
// is the lifecycle a merge record reads, repo=fail makes repository settings fail, ops=conflict makes every
// provider, usage and routing save fail with a revision conflict, photo=fail makes stored reply photos unreadable,
// links=fail makes the session link list fail and links=conflict makes every link change fail. hosts=1 answers
// board.hosts with three hosts and hosts=fail fails it; without it the method is unknown, like an older worker.
// note=conflict makes the next note save find a newer note, note=fail makes note saves and report toggles fail.
import type { z } from "zod";
import { clarificationKey, askClarification } from "../src/paseo/shared/clarifications";
import { factReplySettings, setFactAutoReply } from "../src/paseo/shared/board-facts";
import { boardSnapshot, saveNote, setReporting } from "../src/paseo/shared/contract";
import { readReplyPhoto } from "../src/paseo/shared/reply-history";
import { confirmPullRequestMerge, previewPullRequestMerge, readPullLifecycle, setProjectRepository } from "../src/paseo/shared/prs";
import { cancelQueuedReply, resolveTrackedDecision } from "../src/paseo/shared/tracked-decisions";
import { sendDecision } from "../src/paseo/shared/decision-actions";
import { askDigest, requestWork, setProviderInclusion, setWorkerMode, updateRouting } from "../src/paseo/shared/operations";
import { setUsageRouting } from "../src/paseo/shared/usage-routing";
import { requestRecommendation } from "../src/paseo/shared/recommendation";
import { startCoordinator } from "../src/dashboard/rpc";
import { coordinatorSession, fixtureLedger, fixtureOperations, fixtureSessionLinks, fixtureSnapshot } from "./fixture";
import { linkSession } from "../src/paseo/shared/session-links";

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
if (params.get("ledger")) {
  const ledger = boardSnapshot.output.parse({ ...fixtureSnapshot(), trackedDecisions: { status: "ok", items: fixtureLedger().records },
    replyHistory: [fixtureLedger().history], pullRequests: { ...fixtureSnapshot().pullRequests, projects: [...fixtureSnapshot().pullRequests.projects, ...fixtureLedger().repositories] } });
  snapshot.trackedDecisions!.items.unshift(...ledger.trackedDecisions!.items);
  snapshot.replyHistory = [...ledger.replyHistory!, ...snapshot.replyHistory ?? []];
  snapshot.pullRequests = ledger.pullRequests;
}
const resolveAs = params.get("resolve");
const mergeAs = params.get("merge");
let factReplies = false;
let conflicted = false;
const ops = fixtureOperations();
const sessionLinks = fixtureSessionLinks();
const stale = (expected: number) => { if (params.get("ops") === "conflict" || expected !== ops.revision) throw new Error("revision_conflict: 다른 곳에서 설정이 바뀌었습니다. 새로 고친 뒤 다시 저장해 주세요."); ops.revision++; };
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
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
  "board.operations": () => structuredClone(ops),
  "board.set-worker-mode": async (raw: unknown) => {
    const input = setWorkerMode.input.parse(raw);
    await settle();
    stale(input.expectedRevision);
    if (input.modeId === null) delete ops.workerModeOverrides[input.provider];
    else ops.workerModeOverrides[input.provider] = input.modeId;
    return { ok: true };
  },
  "board.set-provider-inclusion": async (raw: unknown) => {
    const input = setProviderInclusion.input.parse(raw);
    await settle();
    stale(input.expectedRevision);
    const provider = ops.providers.find(row => row.id === input.provider);
    if (provider) provider.included = input.included;
    return { ok: true };
  },
  "board.set-usage-routing": async (raw: unknown) => {
    const input = setUsageRouting.input.parse(raw);
    await settle();
    stale(input.expectedRevision);
    ops.usageRouting = input.enabled;
    return { ok: true };
  },
  "board.update-routing": async (raw: unknown) => {
    const input = updateRouting.input.parse(raw);
    await settle();
    stale(input.expectedRevision);
    if (input.candidates.length) ops.routing[input.grade] = input.candidates;
    else delete ops.routing[input.grade];
    return { ok: true };
  },
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
  "board.open-session": async (input: { sessionId: string }) => {
    console.info("open-session", input.sessionId);
    await settle();
    return { opened: snapshot.sessions.some(session => session.id === input.sessionId) };
  },
  "board.resolve-tracked-decision": async (raw: unknown) => {
    const input = resolveTrackedDecision.input.parse(raw);
    await settle();
    const items = snapshot.trackedDecisions!.items;
    const item = items.find(row => row.id === input.id && row.fingerprint === input.fingerprint);
    if (!item) return { status: "already-closed" };
    const status = (resolveAs ?? (input.recipientId ? "sent" : "closed")) as z.output<typeof resolveTrackedDecision.output>["status"];
    if (status === "queued") item.queuedReply = { messageId: crypto.randomUUID(), recipientId: input.recipientId ?? "s-coord", answer: input.answer, imageCount: 0, stopped: false };
    if (status === "sent" || status === "closed") {
      snapshot.trackedDecisions!.items = items.filter(row => row !== item);
      snapshot.replyHistory = [{ key: crypto.randomUUID(), status: status === "sent" ? "sent" : input.answer ? "recorded" : "closed", title: item.title,
        projectId: item.projectId, at: new Date().toISOString(), recipientId: input.recipientId, answer: input.answer }, ...snapshot.replyHistory ?? []];
    }
    return { status };
  },
  "board.cancel-queued-reply": async (raw: unknown) => {
    const input = cancelQueuedReply.input.parse(raw);
    await settle();
    const item = snapshot.trackedDecisions!.items.find(row => row.id === input.id && row.queuedReply?.messageId === input.messageId);
    if (item) delete item.queuedReply;
    return { canceled: !!item };
  },
  "board.preview-pull-request-merge": async (raw: unknown) => {
    const input = previewPullRequestMerge.input.parse(raw);
    await settle();
    const pr = snapshot.pullRequests?.items.find(row => row.repo === input.repo && row.number === input.number);
    const blocked = mergeAs === "blocked";
    return { status: blocked ? "blocked" : "ready", reason: blocked ? "permission" : "ready", title: pr?.title ?? "", headSha: sha("a1b2"), headRef: "docs/move-install",
      baseRef: "main", baseSha: sha("c3d4"), checks: 4, methods: ["squash", "merge", "rebase"], defaultMethod: "squash", token: blocked ? null : crypto.randomUUID() };
  },
  "board.confirm-pull-request-merge": async (raw: unknown) => {
    const input = confirmPullRequestMerge.input.parse(raw);
    await settle();
    if (mergeAs === "unconfirmed") return { status: "unconfirmed", reason: "unconfirmed", mergeSha: null };
    if (mergeAs === "changed") return { status: "changed", reason: "changed", mergeSha: null };
    const mergeSha = sha("9f8e");
    const notification = { status: "queued" as const, recipientId: snapshot.coordinator ?? undefined };
    snapshot.pullRequests!.items = snapshot.pullRequests!.items.filter(row => !(row.repo === input.repo && row.number === input.number));
    snapshot.trackedDecisions!.items = snapshot.trackedDecisions!.items.filter(row => !(row.mergeTarget?.repo === input.repo && row.mergeTarget.number === input.number));
    snapshot.replyHistory = [{ key: crypto.randomUUID(), status: "sent", title: "PR 병합", projectId: input.projectId, at: new Date().toISOString(),
      pullMerge: { repo: input.repo, number: input.number, status: "merged", mergeSha, notification: { ...notification, status: "sent" } } }, ...snapshot.replyHistory ?? []];
    return { status: "merged", reason: "merged", mergeSha, notification };
  },
  "board.read-pull-lifecycle": async (raw: unknown) => {
    readPullLifecycle.input.parse(raw);
    await settle();
    const state = params.get("pull") ?? "OPEN";
    if (state === "fail") throw new Error("unavailable");
    return { state };
  },
  "board.set-project-repository": async (raw: unknown) => {
    const input = setProjectRepository.input.parse(raw);
    await settle();
    if (params.get("repo") === "fail") throw new Error("conflict");
    const project = snapshot.pullRequests?.projects.find(row => row.projectId === input.projectId);
    if (project) Object.assign(project, { mode: input.mode, repo: input.repo ?? (input.mode === "off" ? project.repo : null), status: input.mode === "off" ? "off" : "ok" });
    return { ok: true };
  },
  "board.read-reply-photo": async (raw: unknown) => {
    const input = readReplyPhoto.input.parse(raw);
    await settle();
    if (params.get("photo") === "fail") throw new Error("unavailable");
    const data = (await photo(input.index + 1, 640, 360)).split(",")[1];
    return { image: { mimeType: "image/png", data } };
  },
  "board.session-links": async () => {
    await settle();
    if (params.get("links") === "fail") throw new Error("unavailable");
    return { sessions: structuredClone(sessionLinks) };
  },
  "board.link-session": async (raw: unknown) => {
    const input = linkSession.input.parse(raw);
    await settle();
    const entry = sessionLinks.find(row => row.sessionId === input.sessionId);
    if (params.get("links") === "conflict" || !entry || entry.targetProjectId !== input.expectedTargetProjectId) throw new Error("conflict");
    entry.targetProjectId = input.targetProjectId;
    return { ok: true };
  },
  ...(params.get("hosts") && { "board.hosts": async () => {
    await settle();
    if (params.get("hosts") === "fail") throw new Error("unavailable");
    return { hosts: [
      { id: "local", label: "작업용 데스크톱", status: "online", current: true },
      { id: "laptop", label: "노트북", status: "offline", current: false },
      { id: "build", label: "빌드 서버", status: "connecting", current: false },
    ] };
  } }),
  "board.save-note": async (raw: unknown) => {
    const input = saveNote.input.parse(raw);
    await settle();
    if (params.get("note") === "fail") throw new Error("unavailable");
    const current = snapshot.notes[input.sessionId];
    if (params.get("note") === "conflict" && !conflicted) {
      conflicted = true;
      snapshot.notes[input.sessionId] = { sessionId: input.sessionId, kind: "review", origin: "person", text: "다른 창에서 남긴 확인 요청입니다.", revision: (current?.revision ?? 0) + 1 };
      return { ok: false, conflict: true };
    }
    if ((current?.revision ?? 0) !== input.expectedRevision) return { ok: false, conflict: true };
    if (input.kind === "clear") delete snapshot.notes[input.sessionId];
    else snapshot.notes[input.sessionId] = { sessionId: input.sessionId, kind: input.kind, origin: "person", text: input.text, revision: input.expectedRevision + 1, evidenceId: input.evidenceId };
    return { ok: true, conflict: false };
  },
  "board.set-reporting": async (raw: unknown) => {
    const input = setReporting.input.parse(raw);
    await settle();
    if (params.get("note") === "fail") throw new Error("unavailable");
    const session = snapshot.sessions.find(row => row.id === input.sessionId);
    if (session) session.reporting = input.enabled || undefined;
    return { ok: !!session };
  },
  "board.fact-reply-settings": (raw: unknown) => { factReplySettings.input.parse(raw); return { enabled: factReplies }; },
  "board.set-fact-auto-reply": async (raw: unknown) => {
    factReplies = setFactAutoReply.input.parse(raw).enabled;
    await settle();
    return { ok: true };
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
      question: input.question, at: new Date().toISOString(), status: "sent", imageCount: input.images?.length || undefined }];
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

async function photo(n: number, width = 320, height = 200) {
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  const context = canvas.getContext("2d")!;
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, ["#4f46e5", "#0d9488", "#d97706", "#db2777"][n % 4]);
  gradient.addColorStop(1, "#e5e7eb");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#fff";
  context.font = `600 ${Math.round(height / 3)}px sans-serif`;
  context.fillText(String(n), width / 2 - height / 10, height / 2 + height / 8);
  return canvas.toDataURL("image/png");
}
// "+<n>" attaches n generated screenshots to the first visible attach button, "+<n>/<k>" to the k-th,
// "+bad" attaches a text file.
async function attach(spec: string) {
  const [count, nth] = spec.split("/");
  const input = Array.from(document.querySelectorAll<HTMLInputElement>("input[type=file]"))
    .filter(field => (field.nextElementSibling?.querySelector("button") as HTMLElement | null)?.offsetParent !== null)[Number(nth ?? 1) - 1];
  if (!input) return;
  const files = count === "bad" ? [new File(["notes"], "메모.txt", { type: "text/plain" })]
    : await Promise.all(Array.from({ length: Number(count) }, async (_, i) =>
      new File([await (await fetch(await photo(i + 1))).blob()], `화면-${i + 1}.png`, { type: "image/png" })));
  const transfer = new DataTransfer();
  files.forEach(file => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
// Every card stays mounted while hidden, so a press goes to the first visible button or label with that text.
const presses = params.get("press")?.split(",") ?? [];
// "@<label>=<text>" types into the visible text box with that accessible label instead of pressing.
function type(label: string, text: string) {
  const box = Array.from(document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input"))
    .find(area => area.offsetParent !== null && area.getAttribute("aria-label")?.startsWith(label));
  if (!box) return;
  const prototype = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}
async function pressAll() {
  for (const label of presses) {
    await new Promise(resolve => setTimeout(resolve, 450));
    if (label.startsWith("+")) { await attach(label.slice(1)); continue; }
    if (label.startsWith("@")) { const [name, ...text] = label.slice(1).split("="); type(name, text.join("=")); continue; }
    // "#<name>" matches the start of the accessible name, for buttons whose text starts with an icon.
    const named = label.startsWith("#") ? label.slice(1) : null;
    const target = Array.from(document.querySelectorAll<HTMLElement>("button, label"))
      .find(button => button.offsetParent !== null && (named === null ? button.textContent?.trim().startsWith(label) : button.getAttribute("aria-label")?.startsWith(named)));
    target?.click();
  }
}
window.addEventListener("load", () => void pressAll());
