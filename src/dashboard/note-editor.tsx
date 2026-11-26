/** @jsxImportSource react */
// Paseo's NoteEditor (client/note-editor.tsx) as a native dialog. A session card asks for it through
// EditNote, so the views that place cards need no extra prop.
import { createContext, useEffect, useRef, useState } from "react";
import { noteLabel, noteLabels, type Note, type NoteInput, type Session } from "../paseo/client/model";
import { Button, column, ProjectText, row } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export const EditNote = createContext<((sessionId: string) => void) | null>(null);

type Props = {
  session: Session; note?: Note; onClose: () => void;
  onSetReporting: (enabled: boolean) => Promise<boolean>;
  onSave: (input: NoteInput) => Promise<{ ok: boolean; conflict: boolean }>;
};

export function NoteEditor({ session, note, onClose, onSave, onSetReporting }: Props) {
  const { t } = useBoardLanguage();
  const notices = {
    reporting: t("보고 설정을 저장하지 못했습니다.", "Could not save reporting settings."),
    connection: t("워커에 연결할 수 없어 보고 설정을 저장하지 못했습니다.", "Could not reach the worker to save reporting settings."),
    conflict: t("다른 곳에서 기록을 수정했습니다. 최신 기록을 확인해 주세요.", "This note changed elsewhere. Review the latest version."),
    save: t("기록을 저장하지 못했습니다. 다시 시도해 주세요.", "Could not save the note. Try again."),
    host: t("기록을 저장하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.", "Could not save the note. Check the connection and try again."),
  };
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<keyof typeof noteLabels>(note && note.kind !== "clear" ? note.kind : "question");
  const [text, setText] = useState(note?.text ?? "");
  const [evidenceId] = useState(session.evidenceId);
  const [revision, setRevision] = useState(note?.revision ?? 0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<keyof typeof notices | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  async function toggleReporting() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setMessage(null);
    try {
      if (!await onSetReporting(!session.reporting)) setMessage("reporting");
    } catch {
      setMessage("connection");
    } finally {
      submitting.current = false; setBusy(false);
    }
  }
  const conflict = revision !== (note?.revision ?? 0);
  async function submit(as: NoteInput["kind"]) {
    if (submitting.current || conflict || (as !== "clear" && !text.trim())) return;
    submitting.current = true; setBusy(true); setMessage(null);
    try {
      const result = await onSave({ sessionId: session.id, expectedRevision: revision, evidenceId, kind: as, text: as === "clear" ? "" : text.trim() });
      if (result.ok) onClose();
      else setMessage(result.conflict ? "conflict" : "save");
    } catch {
      setMessage("host");
    } finally {
      submitting.current = false; setBusy(false);
    }
  }
  const placeholder = { question: t("어떤 결정을 내려야 하나요?", "What decision is needed?"), review: t("무엇을 확인하면 될까요?", "What needs review?"),
    done: t("완료를 확인한 결과나 링크를 적어 주세요.", "Add a result or link that confirms completion.") }[kind];
  return <dialog ref={dialog} className="dialog" aria-labelledby="note-editor-title"
    onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}>
    <div style={{ ...column, gap: 12 }}>
      <p id="note-editor-title" className="section-label">{t("세션 기록", "Session note")}</p>
      <div style={{ ...column, gap: 4 }}>
        <p style={{ fontSize: 17, lineHeight: "24px", fontWeight: 600, overflowWrap: "anywhere" }}>{session.title}</p>
        <ProjectText projectId={session.projectId} projects={[session.projectTitle]} className="muted" style={{ fontSize: 13 }}>{session.projectTitle} · {session.workspaceTitle}</ProjectText>
      </div>
      <div role="radiogroup" aria-label={t("기록 종류", "Note kind")} style={{ ...row, gap: 6 }}>
        {(["question", "review", "done"] as const).map(type =>
          <Button key={type} size="sm" label={noteLabel(type, t)} selected={kind === type} disabled={busy} onPress={() => setKind(type)} />)}
      </div>
      {note?.origin === "agent" && note.kind !== "clear" &&
        <p className="muted">{t("세션이 남긴 보고입니다. 원문에서 결과를 확인하고 기록을 저장하세요.", "The session submitted this report. Verify the result in the original conversation before saving.")}</p>}
      <textarea className="textarea" aria-label={noteLabel(kind, t)} maxLength={2000} disabled={busy} value={text} placeholder={placeholder}
        onChange={event => setText(event.target.value)} style={{ minHeight: 100, padding: 12 }} />
      {conflict && <div style={{ ...column, gap: 7, alignItems: "flex-start" }}>
        <p className="warn">{t("편집 중에 기록이 바뀌었습니다. 내 초안은 여기에 남아 있습니다.", "The note changed while you were editing. Your draft is still here.")}</p>
        <p style={{ overflowWrap: "anywhere" }}>{note && note.kind !== "clear" ? [t("최신 기록", "Latest note"), noteLabel(note.kind, t), note.text].join(" · ") : t("최신 기록이 해제되었습니다.", "The latest note has been cleared.")}</p>
        <Button size="sm" label={t("최신 기록 확인 · 내 초안 계속 편집", "Acknowledge latest note and keep editing")} onPress={() => { setRevision(note?.revision ?? 0); setMessage(null); }} />
      </div>}
      {!!message && <p role="status" className="warn">{notices[message]}</p>}
      <div style={{ ...row, gap: 8, justifyContent: "flex-end" }}>
        <Button variant="ghost" label={t("취소", "Cancel")} disabled={busy} onPress={onClose} />
        {note && note.kind !== "clear" && <Button label={t("기록 해제", "Clear note")} disabled={busy || conflict} onPress={() => void submit("clear")} />}
        <Button variant="default" label={busy ? t("저장 중…", "Saving…") : t("저장", "Save")} disabled={busy || conflict || !text.trim()} onPress={() => void submit(kind)} />
      </div>
      <div style={{ ...column, gap: 7, alignItems: "flex-start", paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <p style={{ fontWeight: 600 }}>{t("이 세션의 보드 보고 받기", "Board reports from this session")} · {session.reporting ? t("켬", "On") : t("끔", "Off")}</p>
        <p className="muted" style={{ fontSize: 13 }}>{t("켠 세션은 coordinator-board report 명령으로 질문과 확인할 결과를 자기 카드에 올릴 수 있습니다.", "A session with reports on can add questions and results to its card with the coordinator-board report command.")}</p>
        <Button size="sm" label={session.reporting ? t("보드 보고 끄기", "Turn off board reports") : t("보드 보고 켜기", "Turn on board reports")} disabled={busy} onPress={() => void toggleReporting()} />
      </div>
    </div>
  </dialog>;
}
