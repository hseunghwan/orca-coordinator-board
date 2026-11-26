import type {ReplyEntry} from "../shared/reply-history";
import type {SessionRow} from "../shared/contract";
import type {RemoteSession} from "./remote-sessions";

type State = ReplyEntry["recipientState"];
export type HistorySession = {
  role: "source" | "received" | "target";
  id: string; host?: string; hostLabel?: string; title?: string; state?: State; available: boolean; verify?: () => Promise<boolean>;
};
type Local = Pick<SessionRow, "id" | "title" | "projectId" | "lane" | "status">;
export type HistoryDirectory = {
  hostId?: string; sessions: readonly Local[]; repos: ReadonlyMap<string,string>;
  verifyRemote?: (host:string,id:string,project:string) => Promise<boolean>;
  peers: readonly {host:{serverId:string;label:string}; rows:readonly RemoteSession[]}[];
};
export type HistoryLinks = (entry:ReplyEntry) => HistorySession[];

function localState(row: Local): State {
  if (row.lane === "running") return "running";
  if (row.status === "idle" || row.status === "closed" || row.status === "error") return row.status;
  return "unknown";
}

// Two selected checkouts can have different Paseo project IDs for the same repository.
export function matchesProject(id:string, expected:string | null, repos:ReadonlyMap<string,string>) {
  return expected !== null && (id === expected || (!!repos.get(expected) && repos.get(expected) === repos.get(id)));
}

export function historySessionLinks(entry:ReplyEntry, directory:HistoryDirectory):HistorySession[] {
  const {hostId,sessions,repos,peers} = directory;
  const notification = entry.pullMerge?.notification;
  const recipientId = entry.recipientId ?? notification?.recipientId;
  const links:HistorySession[] = [];
  if (recipientId) {
    const received = (notification?.status ?? entry.status) === "sent";
    const row = sessions.find(s=>s.id===recipientId);
    links.push({role:received ? "received" : "target", id:recipientId, available:!!entry.canOpen || !!row,
      title:entry.recipientTitle ?? row?.title, state:entry.recipientState ?? (row && localState(row))});
  }

  const origin = entry.origin;
  if (!origin?.sessionId) return links;
  const id = origin.sessionId;
  const host = origin.sessionHost;
  const project = origin.sessionProjectId ?? entry.projectId;
  if (host && host !== hostId) {
    const peer = peers.find(p=>p.host.serverId === host);
    const row = peer?.rows.find(s=>s.sessionId === id && matchesProject(s.projectId,project,repos));
    links.push({role:"source", id, host, hostLabel:peer?.host.label, title:row?.title || undefined, available:!!row,
      ...(!row && peer && project && directory.verifyRemote ? {verify:() => directory.verifyRemote!(host,id,project)} : {})});
  } else if (id !== recipientId) {
    const row = sessions.find(s=>s.id === id && matchesProject(s.projectId,project,repos));
    links.push(row ? {role:"source", id, title:row.title, state:localState(row), available:true} : {role:"source", id, available:false});
  }
  return links;
}
