/** @jsxImportSource react */
// Paseo's PhotoComposer and usePhotoDraft (client/photo-composer.tsx). The frame is always a web page,
// so the native fallback that copies the draft and opens the session has no counterpart here.
import { useRef, useState, type ReactNode } from "react";
import { checkPhotoSelection, clipboardPhotos, isFileDrag, readWorkPhoto, type DraftPhoto, type PhotoError } from "../paseo/client/work-photos";
import { MAX_WORK_IMAGES, WORK_IMAGE_MIME_TYPES } from "../paseo/shared/work-images";
import { Button, column, row } from "./ui/controls";
import { Paperclip } from "./ui/icons";
import { useBoardLanguage } from "./ui/language";

export type PhotoDraft = ReturnType<typeof usePhotoDraft>;

export function usePhotoDraft() {
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const latest = useRef<DraftPhoto[]>([]);
  const failed = useRef(new Map<number | undefined, PhotoError>());
  const [errors, setErrors] = useState(failed.current);
  const [inputScope, setInputScope] = useState<number>();
  const [reading, setReading] = useState(false);
  const readPending = useRef(false);
  const sequence = useRef(0);

  function update(next: DraftPhoto[]) {
    latest.current = next;
    setPhotos(next);
  }
  function setFailure(scope: number | undefined, error: PhotoError | null) {
    const next = new Map(failed.current);
    if (error) next.set(scope, error);
    else next.delete(scope);
    failed.current = next;
    setErrors(next);
  }
  // Event handlers may run before React paints the reading or error state.
  function blocksSubmit() {
    return readPending.current || failed.current.size > 0;
  }
  async function add(files: File[], questionIndex?: number) {
    if (readPending.current) return;
    setInputScope(questionIndex);
    const reason = files.length ? checkPhotoSelection(latest.current, files) : "read";
    if (reason) { setFailure(questionIndex, reason); return; }
    readPending.current = true;
    setReading(true);
    try {
      const batch: DraftPhoto[] = [];
      for (const file of files) {
        const image = await readWorkPhoto(file);
        batch.push({ id: ++sequence.current, name: file.name, size: file.size, questionIndex, image, preview: `data:${image.mimeType};base64,${image.data}` });
      }
      update([...latest.current, ...batch]);
      setFailure(questionIndex, null);
    } catch {
      setFailure(questionIndex, "read");
    } finally {
      readPending.current = false;
      setReading(false);
    }
  }
  function clear() {
    update([]);
    failed.current = new Map();
    setErrors(failed.current);
  }
  return { photos, latest, errors, reading, inputScope, readPending, blocked: reading || errors.size > 0,
    blocksSubmit, add, clear, remove: (id: number) => update(latest.current.filter(photo => photo.id !== id)),
    dismissFailure: (scope?: number) => setFailure(scope, null) };
}

export function PhotoComposer({ children, disabled, draft, questionIndex, showHint }: {
  children: ReactNode; disabled: boolean; draft: PhotoDraft; questionIndex?: number; showHint?: boolean;
}) {
  const { t } = useBoardLanguage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const locked = disabled || draft.reading;
  const photos = draft.photos.filter(photo => photo.questionIndex === questionIndex);
  const attachLabel = t("첨부 파일 추가", "Add attachment");
  const atLimit = draft.photos.length >= MAX_WORK_IMAGES;
  const readingHere = draft.reading && draft.inputScope === questionIndex;
  const error = draft.errors.get(questionIndex);
  const errorText = {
    format: t("JPEG, PNG 또는 WebP 사진을 선택해 주세요.", "Choose JPEG, PNG or WebP photos."),
    count: t("사진은 요청당 최대 4장까지 첨부할 수 있습니다.", "Attach up to 4 photos per request."),
    size: t("각 사진은 0바이트보다 크고 5MiB 이하여야 합니다.", "Each photo must be nonempty and at most 5 MiB."),
    total: t("첨부한 사진의 합계는 12MiB 이하여야 합니다.", "Attached photos must total at most 12 MiB."),
    read: t("사진을 읽지 못했습니다. 파일을 다시 선택해 주세요.", "Could not read the photo. Select the file again."),
  };
  return <div className="drop-zone" data-dragging={dragging}
    onDragOver={event => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = locked ? "none" : "copy";
      setDragging(!locked);
    }}
    onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    }}
    onDrop={event => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      if (!locked && !draft.readPending.current) void draft.add(clipboardPhotos(event.dataTransfer), questionIndex);
    }}
    onPaste={event => {
      if (locked || draft.readPending.current) return;
      const files = clipboardPhotos(event.clipboardData);
      if (!files.length && !isFileDrag(event.clipboardData)) return;
      if (!Array.from(event.clipboardData.types ?? []).includes("text/plain")) event.preventDefault();
      event.stopPropagation();
      void draft.add(files, questionIndex);
    }}>
    {children}
    <input ref={fileInput} type="file" multiple hidden accept={WORK_IMAGE_MIME_TYPES.join(",")} disabled={locked}
      onChange={event => {
        if (locked || draft.readPending.current) return;
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (files.length) void draft.add(files, questionIndex);
      }} />
    <div style={{ ...row, gap: 8 }}>
      <button type="button" className="btn btn-outline btn-icon" aria-label={attachLabel} title={attachLabel} disabled={locked || atLimit}
        onClick={() => fileInput.current?.click()}><Paperclip /></button>
      {(readingHere || photos.length > 0 || dragging || showHint) && <p role="status" className="muted sm">{readingHere ? t("사진 읽는 중…", "Reading photos…")
        : dragging ? t("여기에 사진 놓기", "Drop photos here")
        : photos.length ? t(`사진 ${photos.length}장`, `${photos.length} photo${photos.length === 1 ? "" : "s"}`)
        : t("입력창에 사진을 끌어 놓거나 붙여넣으세요.", "Drop or paste photos into the input.")}</p>}
    </div>
    {photos.map(photo => {
      const name = photo.name || t(`사진 ${photo.id}`, `Photo ${photo.id}`);
      const ordinal = draft.photos.indexOf(photo) + 1;
      const distinguish = draft.photos.some(other => other.id !== photo.id && other.name === photo.name);
      const displayName = distinguish ? `${ordinal}. ${name}` : name;
      return <div key={photo.id} style={{ ...row, flexWrap: "nowrap", gap: 8 }}>
        <img className="thumb" src={photo.preview} alt={t(`첨부 사진 ${ordinal} · ${name}`, `Attached photo ${ordinal} · ${name}`)} decoding="async" />
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{displayName}</span>
        <Button size="sm" variant="ghost" label={t("제거", "Remove")} accessibilityLabel={t(`사진 제거 · ${displayName}`, `Remove photo · ${displayName}`)}
          disabled={locked} onPress={() => draft.remove(photo.id)} />
      </div>;
    })}
    {error && <div style={{ ...column, gap: 4 }}>
      <p role="status" className="danger">{errorText[error]}</p>
      <div style={{ ...row, gap: 6 }}>
        <Button size="sm" label={t("파일 다시 선택", "Choose files again")} disabled={locked || atLimit} onPress={() => fileInput.current?.click()} />
        <Button size="sm" label={t("실패한 첨부 취소", "Discard failed attachment")} disabled={locked} onPress={() => draft.dismissFailure(questionIndex)} />
      </div>
    </div>}
  </div>;
}
