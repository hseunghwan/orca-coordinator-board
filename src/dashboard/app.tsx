/** @jsxImportSource react */
// Paseo's HostBoard (index.client.tsx) on Orca: one snapshot from the worker, read on mount, on the
// worker's change signal and every 30 s. A response older than the newest request is dropped.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { projectIconSources } from "../paseo/client/project-icon";
import type { Snapshot } from "../paseo/client/model";
import { boardScope, boardSnapshot } from "../paseo/shared/contract";
import { boardReadiness, type BoardReadiness } from "../paseo/shared/readiness";
import { BoardView } from "./board";
import { call, openSession } from "./rpc";
import { ProjectIconSources } from "./ui/controls";
import { BoardLanguageProvider, useBoardLanguage } from "./ui/language";

const POLL_MS = 30_000;

// manual: the person asked, so it reads fresh and shows progress. poll: skipped while a read is out.
// changed: the worker said the board changed, so it supersedes any read already out.
type RefreshReason = "manual" | "poll" | "changed";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function useCompact() {
  const narrow = () => window.innerWidth < 600;
  const [compact, setCompact] = useState(narrow);
  useEffect(() => {
    const onResize = () => setCompact(narrow());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return compact;
}

function HostBoard() {
  const { t } = useBoardLanguage();
  const compact = useCompact();
  const latest = useRef(0);
  const pending = useRef(false);
  const active = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [readiness, setReadiness] = useState<BoardReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [changing, setChanging] = useState(false);

  const refresh = useCallback(async (reason: RefreshReason) => {
    if (!active.current || (pending.current && reason === "poll")) return;
    const request = ++latest.current;
    pending.current = true;
    if (reason === "manual") setLoading(true);
    try {
      const next = await call(boardSnapshot, reason === "manual" ? { fresh: true } : {});
      if (active.current && request === latest.current) {
        setSnapshot(next);
        setError(null);
        setUpdatedAt(new Date());
      }
    } catch (e) {
      if (active.current && request === latest.current) setError(message(e));
    } finally {
      if (active.current && request === latest.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh("changed");
    const initial = latest.current;
    void call(boardReadiness, {}).then(value => {
      if (active.current && latest.current === initial) setReadiness(value);
    }).catch(() => {});
    const timer = setInterval(() => void refresh("poll"), POLL_MS);
    const changes = orca.plugin.on("board.changed", () => void refresh("changed"));
    return () => { clearInterval(timer); changes.dispose(); active.current = false; latest.current++; };
  }, [refresh]);

  async function updateScope(input: z.input<typeof boardScope.input>) {
    setChanging(true);
    setActionError(null);
    try {
      await call(boardScope, input);
      setSnapshot(null);
      setReadiness(null);
      await refresh("manual");
    } catch (e) {
      setActionError(message(e));
    } finally {
      setChanging(false);
    }
  }

  function open(sessionId: string) {
    setActionError(null);
    void call(openSession, { sessionId }).then(result => {
      if (!result.opened) setActionError(t("세션을 열지 못했습니다. 세션이 아직 있는지 확인해 주세요.", "Could not open the session. Check that it still exists."));
    }).catch(e => setActionError(message(e)));
  }

  const icons = useMemo(() => projectIconSources(snapshot?.projects ?? []), [snapshot?.projects]);
  return <ProjectIconSources.Provider value={icons}>
    <BoardView snapshot={snapshot} readiness={readiness} hostLabel={t("이 기기", "This device")} compact={compact}
      error={actionError || error} loading={loading} updatedAt={updatedAt} changing={changing}
      onRefresh={() => void refresh("manual")} onProject={(projectId, enabled) => void updateScope({ kind: "project", projectId, enabled })}
      onCoordinator={sessionId => void updateScope({ kind: "coordinator", sessionId })} onOpen={open} />
  </ProjectIconSources.Provider>;
}

export function App() {
  return <BoardLanguageProvider><HostBoard /></BoardLanguageProvider>;
}
