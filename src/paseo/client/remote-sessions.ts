import type { getPaseoClient } from "../plugin-shim";
import { githubRepository } from "../shared/github-repository";
import { readPages } from "../shared/pages";
import type { PullRequestView } from "../shared/prs";

import { workspacePull, type WorkspacePull } from "../shared/workspace-pull";

type Client = ReturnType<typeof getPaseoClient>;
type AgentEntry = Awaited<ReturnType<Client["agents"]["list"]>>["entries"][number];
type Workspace = Awaited<ReturnType<Client["workspaces"]["list"]>>["entries"][number];
export type LocalProject = { id: string; title: string; selected: boolean };
export type Repository = Pick<PullRequestView["projects"][number],"projectId"|"repo"|"mode">;
export type RemoteScope = { selected: string[]; known: string[]; repos: [string,string][] };
export type RemoteSession = { sessionId: string; projectId: string; title: string; activityAt?: string; workspacePull?: WorkspacePull };

export function remoteScope(projects: LocalProject[], repositories: Repository[]): RemoteScope {
  const selected = projects.filter(p => p.selected).map(p => p.id).sort();
  const known = projects.map(p => p.id).sort();
  const repos: [string,string][] = [];
  for (const source of repositories) {
    if (source.repo && source.mode !== "off" && selected.includes(source.projectId)) {
      repos.push([source.projectId,source.repo]);
    }
  }
  return { selected, known, repos: repos.sort(([a],[b]) => a.localeCompare(b)) };
}

function repositoriesByProject(workspaces: Workspace[]) {
  const projectRepos = new Map<string, Set<string | null>>();
  const projectsByRepo = new Map<string, Set<string>>();
  for (const ws of workspaces) {
    if (!ws.projectId || ws.internal || ws.archivingAt) continue;
    for (const url of [ws.gitRuntime?.remoteUrl, ws.project?.checkout?.remoteUrl]) {
      if (!url) continue;
      const repo = githubRepository(url);
      const repos = projectRepos.get(ws.projectId) ?? new Set();
      repos.add(repo);
      projectRepos.set(ws.projectId, repos);
      if (repo) {
        const ids = projectsByRepo.get(repo) ?? new Set();
        ids.add(ws.projectId);
        projectsByRepo.set(repo, ids);
      }
    }
  }
  return { projectRepos, projectsByRepo };
}

export function matchRemoteSessions(entries: AgentEntry[], workspaces: Workspace[], scope: RemoteScope, historyId?:string): RemoteSession[] {
  const byWorkspace = new Map(workspaces.map(ws => [ws.id, ws]));
  const {projectRepos, projectsByRepo} = repositoriesByProject(workspaces);
  const result = new Map<string, RemoteSession>();
  for (const {agent, project} of entries) {
    const ws = agent.workspaceId ? byWorkspace.get(agent.workspaceId) : undefined;
    if ((agent.workspaceId && !ws) || agent.archivedAt || agent.internal || ws?.internal || ws?.archivingAt) continue;
    if (historyId ? agent.id !== historyId : (agent.status !== "running" || agent.pendingPermissions.length || agent.attentionReason === "permission")) continue;
    const id = ws?.projectId || project.projectKey;
    if (!id || id === "unassigned") continue;
    let matched = id;
    if (!scope.selected.includes(id)) {
      if (scope.known.includes(id)) continue;
      const repos = projectRepos.get(id);
      if (!repos || repos.size !== 1) continue;
      const [repo] = repos;
      if (!repo || projectsByRepo.get(repo)?.size !== 1) continue;
      const local = scope.repos.filter(([,slug]) => slug === repo);
      if (local.length !== 1) continue;
      matched = local[0][0];
    }
    const work = workspacePull(ws);
    result.set(agent.id, {...(work ? {workspacePull:work} : {}),sessionId: agent.id, projectId: matched, title: agent.title?.trim() ?? "",
      ...(agent.updatedAt && {activityAt: agent.updatedAt})});
  }
  return [...result.values()];
}

export async function readRemoteSessions(
  client: Pick<Client, "agents" | "workspaces">,
  scope: RemoteScope,
  active = () => true,
): Promise<RemoteSession[]> {
  if (!scope.selected.length || !active()) return [];
  // An already outstanding request may complete after a host is hidden. Stop
  // before asking for another page or reading that host's workspace metadata.
  const checkScope = () => { if (!active()) throw Error("Remote session scope changed"); };
  const agents = await readPages<AgentEntry>(page => {
    checkScope();
    return client.agents.list({
      filter: { statuses: ["running"], includeArchived: false, includeBackground: true, includeInternal: false },
      sort: [{ key: "created_at", direction: "asc" }], page,
    });
  });
  if (!agents.length || !active()) return [];
  const spaces = await readPages<Workspace>(page => {
    checkScope();
    return client.workspaces.list({
      filter: { includeBackground: true }, sort: [{ key: "project_id", direction: "asc" }], page,
    });
  });
  return active() ? matchRemoteSessions(agents, spaces, scope) : [];
}


// A history click can reference an idle or closed agent omitted from the running-only directory.
export async function readRemoteHistorySession(client:Pick<Client,"agents"|"workspaces">, id:string, expectedProject:string,
  scope:RemoteScope, active = () => true) {
  if (!active() || !scope.selected.includes(expectedProject)) return false;
  const result = await client.agents.ref(id).refresh();
  if (!active() || !result?.project || result.agent.id !== id || result.agent.archivedAt || result.agent.internal) return false;
  const workspaces = result.agent.workspaceId ? await readPages<Workspace>(page => {
    if (!active()) throw Error("Remote history scope changed");
    return client.workspaces.list({filter:{includeBackground:true},sort:[{key:"project_id",direction:"asc"}],page});
  }) : [];
  if (!active()) return false;
  const match = matchRemoteSessions([{agent:result.agent,project:result.project}],workspaces,scope,id)[0];
  if (!match) return false;
  const repo = scope.repos.find(([project])=>project === expectedProject)?.[1];
  return match.projectId === expectedProject || (!!repo && scope.repos.some(([project,slug])=>project === match.projectId && slug === repo));
}
