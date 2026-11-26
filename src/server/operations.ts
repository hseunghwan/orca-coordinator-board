// Adapted from paseo-coordinator-board server/operations.ts, server/digest.ts and
// server/recommendation.ts @ 2e9d128. The provider directory and usage come from the orca CLI
// (./catalog.ts), the coordinator starts through ./lifecycle.ts in a workspace the person picks, and
// requests reach it through fleet.deliver. Paseo steers a running coordinator; Orca cannot, so a
// request waits until the coordinator is idle. Orca has no pin, photos are named by path in the message
// (./photo-files.ts), and tool names in the prompts are coordinator-board commands.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Fleet, SessionId, World, WorkspaceRecord, WorktreeId } from "../orca";
import { workspaceKey } from "../orca";
import type { T } from "../i18n";
import { setUsageRouting } from "../paseo/shared/usage-routing";
import { askDigest, coordinatorPinSettings, operationState, pinCurrentCoordinator, requestWork, setCoordinatorAutoPin,
  setProviderInclusion, setupCoordinator, setWorkerMode, updateRouting } from "../paseo/shared/operations";
import { requestRecommendation } from "../paseo/shared/recommendation";
import { includedCatalog, resolveRoute, sameRoute, validateCandidates } from "../paseo/shared/dispatch";
import type { PluginServerContext } from "../orca";
import type { PreferenceStore } from "../paseo/server/preferences";
import { readAccountUsage, readDirectory } from "./catalog";
import type { DecisionSender } from "./decisions";
import { CoordinatorLifecycle } from "./lifecycle";
import type { BoardFacts } from "./board-facts";
import { boardPhotoMessageId, readSessionPhoto } from "../paseo/shared/session-photos";
import type { WorkImage } from "../paseo/shared/work-images";
import { SessionPhotoStore } from "../paseo/server/session-photos";
import { photoDigest } from "../paseo/server/reply-photos";
import { photoFiles } from "./photo-files";

export { coordinatorWorkspace, operations, startCoordinator } from "../contract";
import { operations, startCoordinator } from "../contract";

export type OperationDeps = {
  t: () => T;
  /** The plugin's bin folder, named in the coordinator's charter. */
  bin: string;
  /** The id Orca gives the workspace the person is looking at, in any of its forms. */
  focusedWorkspace: () => Promise<string | null>;
};

const local = (w: WorkspaceRecord) => !w.archived && (!w.hostId || w.hostId === "local");

export function coordinatorWorkspaces(world: World, focusedId: string | null, selected: readonly string[]) {
  const focusKey = focusedId ? workspaceKey({ id: focusedId }) : null;
  return [...world.workspaces.values()].filter(local)
    .map(w => ({ id: w.id as string, projectId: w.projectId as string, title: w.projectName && w.projectName !== w.title ? `${w.projectName} · ${w.title}` : w.title,
      ...(focusedId && (w.listId === focusedId || w.id === focusedId || (focusKey && workspaceKey(w) === focusKey)) ? { focused: true } : {}) }))
    .sort((a, b) => Number(selected.includes(b.projectId)) - Number(selected.includes(a.projectId)) || a.title.localeCompare(b.title));
}

const prompts = {
  ko: "관리 프로젝트의 다이제스트를 한국어로 갱신하세요. coordinator-board review로 완료된 단독 병합 기록을 정리하세요. 다른 확인 기록은 원 세션에서 완료 근거가 확인된 경우에만 이 명령으로 닫으세요. coordinator-board read로 최근 근거를 확인하고 coordinator-board classify로 기록하세요. 각 질문에는 당사자가 정할 한 문장을 content.question에 적으세요. 근거·기존 기준에서 제안할 수 있는 가장 타당한 답장 하나를 content.recommendation에, 간단한 이유를 content.recommendationReason에 적으세요. 증거에 실제 답장 문장이 없어도 근거 있는 제안은 작성할 수 있습니다. 판단에 필요한 정보가 부족하면 결정을 지어내지 말고 필요한 정보를 content.needsInput에 적으세요. 예전에 판단한 질문도 needsRecommendation이 표시되면 갱신하세요. 진행 보고와 이미 정해진 사항은 내 결정에서 내리고, 직접 결정할 안건을 먼저 보고하세요.",
  en: "Refresh the digest for managed projects in English. Use coordinator-board review for verified standalone merges and coordinator checks with completion evidence from the originating session. Inspect recent evidence with coordinator-board read and use coordinator-board classify to record your findings. For every genuine human decision, write one short question in content.question. When evidence or an established preference supports it, propose one editable, ready-to-send reply in content.recommendation and give a brief reason in content.recommendationReason. The proposed wording may be new. If essential input is missing, name it in content.needsInput without inventing the person's choice. Revisit earlier decisions marked needsRecommendation. Keep progress reports and resolved matters out of My decisions, and report the remaining decisions first.",
};
export const digestPrompt = prompts.ko + " 이번 요청은 조회와 분류만 맡깁니다.";
export const englishDigestPrompt = prompts.en + " Limit this request to reading and classification.";

/** Paseo's digestWithFactReplies, naming the fact command and its flags instead of the tool. */
export function digestWithFactReplies(language: "ko" | "en", cycleId: string) {
  const command = "coordinator-board fact --cycle " + cycleId + " --session <sessionId> --evidence <evidenceId>";
  const instructions = language === "ko"
    ? "이번 다이제스트에서 보드가 단독 사실 질문으로 식별한 세션(coordinator-board read 목록의 factCandidate)에는 `" + command + "`로 답하세요. 이 명령이 허용한 대상·근거에 대해서만 코디네이터 이름으로 확인된 사실을 보낼 수 있습니다. 다른 방식의 메시지 전송은 요청하지 않았습니다. 처리 결과와 사람이 결정할 안건을 구분하세요."
    : "For this digest, run `" + command + "` for standalone factual questions identified by the board (factCandidate in the coordinator-board read listing). Only that command may send its verified facts as the coordinator. Do not send a message by any other route. Report handled items separately from human decisions.";
  return prompts[language] + " " + instructions + " " + JSON.stringify({ cycleId });
}

export function recommendationPrompt(sessionId: string, language: "ko" | "en") {
  const target = JSON.stringify({ sessionId });
  return language === "en"
    ? `Review only this decision card: ${target}. Use coordinator-board read to check the latest source. If a person must decide, use coordinator-board classify to save content.question as one concrete question. Propose one ready-to-send reply in content.recommendation with a brief recommendationReason grounded in the evidence or an established preference. Label it as a proposal, never as the person's decision. If essential information is missing, record exactly what is needed in content.needsInput. Don't invent a title, preference, approval or a fact. If the question has already been resolved, classify the evidence accordingly. This request only updates the card. Do not message the worker or carry out the proposed action.`
    : `결정 카드 한 건만 검토해 주세요. 대상은 ${target}입니다. coordinator-board read로 최신 발췌를 읽고, 사람 결정이 필요하면 coordinator-board classify의 content.question에 결정할 질문 한 문장을 기록하세요. 대화 근거나 이미 정한 기준으로 추천할 수 있으면 content.recommendation에 바로 보낼 완결된 답장 한 개, recommendationReason에 그 이유를 짧게 적으세요. 사용자가 이미 결정했다고 표현하지 마세요. 필수 정보가 부족하면 content.needsInput에 무엇을 알려줘야 하는지 적고 제목·취향·승인·사실을 지어내지 마세요. 이미 해결됐다면 근거에 맞게 분류하세요. 이번에는 이 카드만 갱신하고 작업자에게 메시지를 보내거나 추천한 행동을 실행하지 마세요.`;
}

/** A message the board wrote itself carries this first line after the delivery marker (AGENTS.md). */
export const BOARD_PREFIX = "[coordinator-board]";

function requestUuid(content: unknown[]) {
  const id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return [id.slice(0, 8), id.slice(8, 12), "4" + id.slice(13, 16), "8" + id.slice(17, 20), id.slice(20, 32)].join("-");
}

export async function sendCoordinatorRequest(fleet: Pick<Fleet, "view" | "deliver">, store: PreferenceStore, t: T,
  expected: string, key: string, text: string, options: { reserveMessage?: (originalId: string) => string; beforeSend?: (messageId: string) => void; boardMade: boolean;
    images?: WorkImage[]; photos?: (messageId: string) => string[] }) {
  if (store.read().coordinator !== expected) throw new Error(t("현재 코디네이터를 다시 확인해 주세요.", "Check the current coordinator again."));
  if (!store.read().projects.length) throw new Error(t("관리할 프로젝트를 하나 이상 선택하세요.", "Choose at least one project to manage."));
  const session = (await fleet.view({ maxAgeMs: 0 })).sessions.get(expected as SessionId);
  if (!session) throw new Error(t("코디네이터 세션을 찾을 수 없습니다. 세션을 확인하거나 새로 지정해 주세요.", "The coordinator session is gone. Check it or choose another."));
  if (store.read().coordinator !== expected) throw new Error(t("코디네이터가 교체되었습니다. 새로 고쳐 주세요.", "The coordinator changed. Refresh the board."));
  const images = options.images;
  const originalId = requestUuid(images?.length ? [expected, key, text, images.map(photoDigest)] : [expected, key, text]);
  const messageId = options.reserveMessage?.(originalId) ?? originalId;
  options.beforeSend?.(messageId);
  const outcome = await fleet.deliver({
    messageId, to: expected as SessionId, text: options.boardMade ? BOARD_PREFIX + "\n" + text : text,
    subject: "Coordinator Board", from: { kind: "person" }, whenWorking: "refuse", photos: options.photos?.(messageId) ?? [],
  });
  if (outcome.status === "refused") {
    if (outcome.reason === "working" || outcome.reason === "waiting" || outcome.reason === "blocked") {
      throw new Error(t("코디네이터가 대기 상태일 때 요청할 수 있습니다. 지금 턴이 끝난 뒤 다시 보내 주세요.", "The coordinator takes requests when it is idle. Send this again after its current turn."));
    }
    if (outcome.reason === "content-changed") throw new Error(t("내용이 달라졌습니다. 새 요청으로 보내 주세요.", "The text changed. Send it as a new request."));
    if (outcome.reason === "asleep") throw new Error(t("코디네이터 터미널이 닫혀 있습니다. 세션을 다시 열거나 새 코디네이터를 지정해 주세요.", "The coordinator's terminal is closed. Reopen the session or choose another coordinator."));
    if (outcome.reason === "no-board-sender") throw new Error(t("채팅 코디네이터에 보낼 보드 메일 터미널을 열지 못했습니다. 워크스페이스를 연 뒤 다시 보내 주세요.", "Could not open the board's mail terminal for a chat coordinator. Open a workspace and try again."));
    throw new Error(t("코디네이터에게 보내지 못했습니다. 세션 상태를 확인해 주세요.", "Could not send to the coordinator. Check its session.") + (outcome.detail ? " (" + outcome.detail + ")" : ""));
  }
  if (outcome.status === "unconfirmed") {
    throw new Error(t("전송 결과를 확인하지 못했습니다. 같은 요청을 다시 누르면 보낸 기록만 확인합니다.", "Could not confirm the send. Pressing the same request again only checks what was sent."));
  }
  return { ok: true };
}

export function registerOperations(server: PluginServerContext, store: PreferenceStore, fleet: Fleet, decisions: DecisionSender, dataDir: string, deps: OperationDeps,
  facts?: Pick<BoardFacts, "prepareCycle" | "bindMessage">) {
  const lifecycle = new CoordinatorLifecycle(store, fleet, dataDir, { t: deps.t, bin: deps.bin });
  const photoDirectory = join(dataDir, "session-photos");
  const sessionPhotos = new SessionPhotoStore(photoDirectory);
  server.handle(readSessionPhoto, async ({ sessionId, messageId, index }) => sessionPhotos.read(sessionId, messageId, index));
  const unsupportedPin = () => new Error(deps.t()("Orca에서는 플러그인이 워크스페이스를 고정할 수 없습니다.", "Orca does not let a plugin pin a workspace."));

  server.handle(coordinatorPinSettings, async () => ({ enabled: false, workspace: null }));
  server.handle(setCoordinatorAutoPin, async () => { throw unsupportedPin(); });
  server.handle(pinCurrentCoordinator, async () => { throw unsupportedPin(); });
  server.handle(operations, async ({ view }) => {
    const settings = view !== "setup";
    const initial = settings ? null : store.read();
    const needUsage = !initial || (initial.usageRouting && !initial.routing.M);
    const [directory, usage, world, focused] = await Promise.all([
      readDirectory(fleet.cli), needUsage ? readAccountUsage(fleet.cli) : undefined,
      fleet.view(), deps.focusedWorkspace().catch(() => null),
    ]);
    const scope = initial ?? store.read();
    const catalog = includedCatalog(directory.catalog, scope.excludedProviders);
    const coordinator = resolveRoute("M", scope.routing, catalog, false, scope.usageRouting ? usage : []);
    return {
      usage, usageRouting: scope.usageRouting,
      ...(settings && { workerModeOverrides: scope.workerModeOverrides, displayUsage: usage ?? [] }),
      providers: directory.providers.map(p => ({ ...p, included: !scope.excludedProviders.includes(p.id) })),
      catalog, coordinatorMode: catalog.find(m => m.provider === coordinator?.provider)?.coordinatorMode ?? null,
      routing: scope.routing, revision: scope.routingRevision,
      workspaces: coordinatorWorkspaces(world, focused, scope.projects),
    };
  });
  server.handle(setUsageRouting, async input => {
    store.change(scope => {
      if (scope.routingRevision !== input.expectedRevision) throw new Error("배정 설정이 바뀌었습니다. 새로 고쳐 주세요.");
      if (scope.usageRouting !== input.enabled) {
        scope.usageRouting = input.enabled;
        scope.routingRevision++;
      }
    });
    return { ok: true };
  });
  server.handle(setWorkerMode, async input => {
    if (input.modeId) {
      const provider = (await readDirectory(fleet.cli)).providers.find(p => p.id === input.provider);
      if (!provider?.workerModes?.some(mode => mode.id === input.modeId))
        throw new Error(`${input.provider} 작업 권한 모드 '${input.modeId}'를 확인할 수 없습니다. 설정에서 사용할 수 있는 작업 권한을 선택하세요.`);
    }
    store.change(scope => {
      if (scope.routingRevision !== input.expectedRevision) throw new Error("배정 설정이 바뀌었습니다. 새로 고쳐 주세요.");
      const current = Object.hasOwn(scope.workerModeOverrides, input.provider) ? scope.workerModeOverrides[input.provider] : null;
      if (current === input.modeId) return;
      if (input.modeId === null) delete scope.workerModeOverrides[input.provider];
      else scope.workerModeOverrides[input.provider] = input.modeId;
      scope.routingRevision++;
    });
    return { ok: true };
  });
  server.handle(setProviderInclusion, async input => {
    const { providers } = await readDirectory(fleet.cli);
    if (!providers.some(p => p.id === input.provider))
      throw new Error("현재 호스트에서 해당 실행기를 찾지 못했습니다. 목록을 새로 고쳐 주세요.");
    store.change(scope => {
      if (scope.routingRevision !== input.expectedRevision)
        throw new Error("다른 화면에서 배정 설정이 바뀌었습니다. 새로 고친 뒤 다시 선택하세요.");
      const wasIncluded = !scope.excludedProviders.includes(input.provider);
      if (wasIncluded === input.included) return;
      if (input.included) scope.excludedProviders = scope.excludedProviders.filter(p => p !== input.provider);
      else scope.excludedProviders.push(input.provider);
      scope.routingRevision++;
    });
    return { ok: true };
  });
  server.handle(updateRouting, async input => {
    const catalog = input.candidates.length ? (await readDirectory(fleet.cli)).catalog : [];
    store.change(scope => {
      if (scope.routingRevision !== input.expectedRevision)
        throw new Error("다른 화면에서 배정표가 바뀌었습니다. 새로 고친 뒤 다시 선택하세요.");
      if (input.candidates.length) {
        validateCandidates(input.grade, input.candidates, includedCatalog(catalog, scope.excludedProviders), scope.routing[input.grade]);
        scope.routing[input.grade] = input.candidates;
      } else delete scope.routing[input.grade];
      scope.routingRevision++;
    });
    return { ok: true };
  });
  server.handle(startCoordinator, async input => {
    const t = deps.t();
    const initial = store.read();
    const checkUsage = initial.usageRouting && !initial.routing.M;
    const [directory, usage, world, focused] = await Promise.all([
      readDirectory(fleet.cli), checkUsage ? readAccountUsage(fleet.cli) : [], fleet.view({ maxAgeMs: 0 }), deps.focusedWorkspace().catch(() => null),
    ]);
    const catalog = directory.catalog;
    const verifyRoute = (scope: ReturnType<typeof store.read>) => {
      const route = resolveRoute("M", scope.routing, includedCatalog(catalog, scope.excludedProviders), false, scope.usageRouting ? usage : []);
      if (checkUsage !== (scope.usageRouting && !scope.routing.M) || !route || !sameRoute(route, input.expectedRoute))
        throw new Error("코디네이터 모델 또는 권한 모드가 바뀌었습니다. 설정을 새로 고쳐 주세요.");
    };
    verifyRoute(store.read());
    const mode = catalog.find(m => m.provider === input.expectedRoute.provider)?.coordinatorMode;
    if (!mode || (input.expectedModeId !== undefined && input.expectedModeId !== mode.id))
      throw new Error("코디네이터 권한 모드를 확인할 수 없거나 바뀌었습니다. 설정에서 실행기·모델을 새로 고쳐 주세요.");
    const candidates = coordinatorWorkspaces(world, focused, initial.projects);
    const picked = input.workspaceId ? candidates.find(w => w.id === input.workspaceId) : candidates.find(w => w.focused);
    if (input.workspaceId && !picked) throw new Error(t("고른 워크스페이스를 이 컴퓨터에서 찾을 수 없습니다. 목록을 새로 고쳐 주세요.", "The chosen workspace is not on this computer any more. Refresh the list."));
    return lifecycle.ensure({
      expectedCoordinator: input.expectedCoordinator, replace: input.replace,
      config: { provider: input.expectedRoute.provider + "/" + input.expectedRoute.model,
        ...(input.expectedRoute.effort !== null ? { thinkingOptionId: input.expectedRoute.effort } : {}), modeId: mode.id },
      workspace: picked ? world.workspaces.get(picked.id as WorktreeId) ?? null : null, verifyRoute,
    });
  });
  server.handle(askDigest, async input => {
    const language = input.language ?? "ko";
    const cycle = input.handleBoardFacts && facts ? await facts.prepareCycle(fleet.paseo, input.coordinator, input.requestKey) : null;
    if (cycle && facts) {
      return sendCoordinatorRequest(fleet, store, deps.t(), input.coordinator, input.requestKey, digestWithFactReplies(language, cycle),
        { boardMade: true, beforeSend: messageId => facts.bindMessage(input.coordinator, cycle, messageId) });
    }
    return sendCoordinatorRequest(fleet, store, deps.t(), input.coordinator, input.requestKey, language === "en" ? englishDigestPrompt : digestPrompt, { boardMade: true });
  });
  server.handle(requestWork, async input => {
    const t = deps.t();
    return sendCoordinatorRequest(fleet, store, t, input.coordinator, input.requestKey, input.text, {
      boardMade: false,
      images: input.images,
      photos: messageId => input.images?.length ? photoFiles(photoDirectory, input.coordinator, messageId, input.images) : [],
      reserveMessage(originalId) {
        let messageId = input.images?.length ? boardPhotoMessageId(originalId) : originalId;
        const key = createHash("sha256").update(JSON.stringify([input.coordinator, input.requestKey])).digest("hex");
        // Reserve the content before sending so an uncertain or simultaneous
        // delivery can only be retried with the same message. Retain IDs issued by older versions.
        store.change(scope => {
          const reserved = scope.workRequestIds[key];
          if (reserved === originalId) messageId = originalId;
          if (reserved && reserved !== messageId) throw new Error(t("내용이나 사진이 달라졌습니다. 새 요청으로 보내 주세요.", "The text or photos changed. Send it as a new request."));
          scope.workRequestIds[key] = messageId;
        });
        if (input.images?.length) sessionPhotos.save(input.coordinator, messageId, input.images);
        return messageId;
      },
    });
  });
  server.handle(requestRecommendation, input => decisions.send(fleet.paseo, {
    projectId: input.projectId, sessionId: input.sessionId, version: input.version, requestKey: input.requestKey,
    recipientId: input.coordinator, action: "coordinate", text: BOARD_PREFIX + "\n" + recommendationPrompt(input.sessionId, input.language),
  }));
  return lifecycle;
}
