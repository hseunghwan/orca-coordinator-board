import { displayLane } from "../shared/decision-count";
import type { z } from "zod";
import type { boardSnapshot, saveNote } from "../shared/contract";

export type Snapshot = z.output<typeof boardSnapshot.output>;
export type Session = Snapshot["sessions"][number];
export type Note = Snapshot["notes"][string];
export type NoteInput = z.input<typeof saveNote.input>;
export type Lane = Session["lane"] | "done";
export type Card = { session: Session; note: Note | undefined; lane: Lane };
export const lanes: readonly Lane[] = ["human", "running", "review", "idle", "done", "unknown"];
export const labels: Record<Lane, string> = {
  human: "내 결정", running: "진행 중", review: "확인 대기", idle: "대기 중", done: "완료", unknown: "미확인",
};
export const noteLabels = { question: "결정 요청", review: "확인 요청", done: "완료 근거" } as const;

type Translate = (ko: string, en: string) => string;
const laneEnglish = { human: "My decisions", running: "In progress", review: "Awaiting review", idle: "Idle", done: "Done", unknown: "Unknown" };
const noteEnglish = { question: "Decision request", review: "Review request", done: "Completion evidence" };

export function laneLabel(lane: Lane, t: Translate) { return t(labels[lane], laneEnglish[lane]); }
export function noteLabel(kind: keyof typeof noteLabels, t: Translate) { return t(noteLabels[kind], noteEnglish[kind]); }

const statusPhrases: Record<string, string> = {
  "답장을 보냈습니다. 담당 세션의 결과를 기다립니다.": "Reply sent. Waiting for the assigned session’s result.",
  "세션에서 응답 요청 확인": "Review the request in the session",
  "오류 확인 필요": "Error needs review",
  "작업 중": "In progress",
  "세션을 여는 중": "Opening session",
  "마지막 오류 확인 필요": "Review the last error",
  "세션 결과 확인 필요": "Review session results",
  "다음 요청 대기": "Waiting for the next request",
  "대화 종료": "Conversation closed",
  "세션 상태 미확인": "Session status unknown",
  "질문 뒤에 메시지가 왔습니다. 같은 질문에 대한 답인지 확인하세요.": "A message followed the question. Check whether it answers that question.",
};

export function sessionDetail(detail: string, t: Translate) {
  if (Object.hasOwn(statusPhrases, detail)) return t(detail, statusPhrases[detail]);
  const pending = /^응답을 기다리는 요청 (\d+)건$/.exec(detail);
  if (pending) return t(detail, `Requests awaiting a response: ${pending[1]}`);
  const tasks = /^대화 대기 · 백그라운드 작업 (\d+)개$/.exec(detail);
  if (tasks) return t(detail, `Conversation idle · Background tasks: ${tasks[1]}`);
  for (const [ko, en] of [["코디네이터 판단 · ", "Coordinator assessment · "], ["세션의 확인 요청 · ", "Session question · "]]) {
    if (detail.startsWith(ko)) return t(ko, en) + detail.slice(ko.length);
  }
  return detail;
}

export function factStatus({ delivery, kind }: Pick<NonNullable<Session["boardFact"]>, "delivery" | "kind">, t: Translate) {
  if (delivery === "recorded" && kind === "report") return t("진행 보고 기록됨", "Progress report recorded");
  const words = {
    recorded: t("사실 확인 기록됨", "Fact recorded"),
    pending: t("사실 답변 전달 확인 중", "Checking delivery of fact"),
    sent: t("사실 답변 전달됨", "Fact delivered"),
    unconfirmed: t("사실 답변 전달 미확인", "Fact delivery unconfirmed"),
  };
  return words[delivery];
}

export function projectFilterNames(projects: Pick<Snapshot["projects"][number], "id" | "title" | "path">[]) {
  const names = new Map<string, string>();
  for (const project of projects) {
    const others = projects.filter(other => other.id !== project.id && other.title === project.title);
    let label = project.title;
    if (others.length) {
      const parts = (path: string) => path.split(/[\\/]+/).filter(Boolean);
      const own = parts(project.path);
      const paths = others.map(other => parts(other.path));
      let suffix = project.id;
      for (let depth = 1; depth <= own.length; depth++) {
        const tail = own.slice(-depth).join("/");
        if (paths.every(path => path.slice(-depth).join("/") !== tail)) {
          suffix = tail;
          break;
        }
      }
      label += " · " + suffix;
    }
    names.set(project.id, label);
  }
  return names;
}

export function projectCards(snapshot: Snapshot) {
  const projects = new Map<string, { id: string; title: string; cards: Card[] }>();
  const human: Card[] = [];
  for (const session of snapshot.sessions) {
    const note = snapshot.notes[session.id];
    const card = { session, note, lane: displayLane(session, note) };
    const project = projects.get(session.projectId) ?? { id: session.projectId, title: session.projectTitle, cards: [] };
    project.cards.push(card);
    projects.set(project.id, project);
    if (card.lane === "human") human.push(card);
  }
  return { human, projects: [...projects.values()].sort((a, b) => a.title.localeCompare(b.title)) };
}
