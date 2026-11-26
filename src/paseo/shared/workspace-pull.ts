import { z } from "zod";
import { githubRepository } from "./github-repository";
import { repositorySlug, type PullRequestItem } from "./prs";

export const workspacePullSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr"), repo: repositorySlug, number: z.number().int().positive() }),
  z.object({ kind: z.literal("branch"), repo: repositorySlug, branch: z.string().min(1) }),
]);
export type WorkspacePull = z.infer<typeof workspacePullSchema>;

type Git = { currentBranch?: string | null; remoteUrl?: string | null };
type Workspace = {
  githubRuntime?: { pullRequest?: { url: string; number?: number; headRefName: string; isMerged: boolean; state: string } | null } | null;
  gitRuntime?: Git | null;
  project?: { checkout?: Git | null } | null;
};

export function workspacePull(ws?: Workspace): WorkspacePull | undefined {
  if (!ws) return;
  const branch = ws.gitRuntime?.currentBranch;
  const pr = ws.githubRuntime?.pullRequest;
  if (pr) {
    const parts = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/([1-9]\d*)\/?$/i.exec(pr.url);
    if (!parts || pr.isMerged || pr.state.toLowerCase() !== "open" || (branch && branch !== pr.headRefName)) return;
    const repo = repositorySlug.safeParse(parts[1]);
    const number = Number(parts[2]);
    if (repo.success && Number.isSafeInteger(number) && (!pr.number || pr.number === number)) return { kind: "pr", repo: repo.data, number };
    return;
  }
  const repo = githubRepository(ws.gitRuntime?.remoteUrl);
  if (repo && branch) return { kind: "branch", repo, branch };
}

export function matchesWorkspace(pr: PullRequestItem, workspace?: WorkspacePull) {
  if (!workspace) return false;
  return workspace.kind === "pr" ? workspace.repo === pr.repo && workspace.number === pr.number
    : workspace.repo === pr.headRepo && workspace.branch === pr.headBranch;
}
