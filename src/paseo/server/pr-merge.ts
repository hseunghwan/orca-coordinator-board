import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  mergeMethod,
  repositorySlug,
  type MergeMethod,
  type MergePreview,
  type MergeReason,
  type MergeNotification,
  type MergeResult,
  type MergeTarget,
  type PullMergeActivity,
} from "../shared/prs";

const query = `query BoardMergePreview($owner:String!, $name:String!, $number:Int!) {
  viewer { id }
  repository(owner:$owner,name:$name) {
    nameWithOwner viewerPermission isArchived isDisabled
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
    pullRequest(number:$number) {
      id number title state isDraft headRefName headRefOid baseRefName
      baseRef { target { oid } refUpdateRule { requiresLinearHistory }
        rules(first:100) { pageInfo { hasNextPage } nodes { type parameters { ... on PullRequestParameters { allowedMergeMethods } } } } }
      mergeCommit { oid } autoMergeRequest { enabledAt }
      mergeable mergeStateStatus reviewDecision isInMergeQueue isMergeQueueEnabled
      statusCheckRollup { state contexts(first:1) { totalCount } }
    }
  }
}`;
const mutation = `mutation BoardMerge($id:ID!, $head:GitObjectID!, $method:PullRequestMergeMethod!) {
  mergePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method}) {
    pullRequest { id state headRefOid baseRefName mergeCommit { oid } }
  }
}`;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const commit = z.object({ oid: sha });
const pullDetails = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: sha,
  baseRefName: z.string(),
  baseRef: z
    .object({
      target: commit.nullable(),
      refUpdateRule: z.object({ requiresLinearHistory: z.boolean() }).nullable(),
      rules: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean() }),
        nodes: z.array(
          z.object({
            type: z.string(),
            parameters: z.object({ allowedMergeMethods: z.array(z.string()).nullish() }).nullable(),
          }),
        ),
      }),
    })
    .nullable(),
  mergeCommit: commit.nullable(),
  autoMergeRequest: z.object({ enabledAt: z.string() }).nullable(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  isInMergeQueue: z.boolean(),
  isMergeQueueEnabled: z.boolean(),
  statusCheckRollup: z
    .object({ state: z.string(), contexts: z.object({ totalCount: z.number().int().nonnegative() }) })
    .nullable(),
});
const repository = z.object({
  nameWithOwner: repositorySlug,
  viewerPermission: z.string().nullable(),
  isArchived: z.boolean(),
  isDisabled: z.boolean(),
  mergeCommitAllowed: z.boolean(),
  squashMergeAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
  viewerDefaultMergeMethod: z.string().nullable(),
  pullRequest: pullDetails,
});
const response = z.object({
  errors: z.never().optional(),
  data: z.object({ viewer: z.object({ id: z.string().min(1) }), repository }),
});
const mutationResponse = z.object({
  errors: z.never().optional(),
  data: z.object({
    mergePullRequest: z.object({
      pullRequest: z.object({
        id: z.string(),
        state: z.literal("MERGED"),
        headRefOid: sha,
        baseRefName: z.string(),
        mergeCommit: commit.nullable(),
      }),
    }),
  }),
});
type Repo = z.infer<typeof repository>;
type State = { viewer: string; repo: Repo };
type Request = MergeTarget & { token: string; method: MergeMethod };

type Gh = (args: string[]) => Promise<string>;
export function githubMergeApi(gh: Gh) {
  return {
    async inspect(target: MergeTarget): Promise<State> {
      const [owner, name] = target.repo.split("/");
      const output = await gh([
        "api",
        "--hostname",
        "github.com",
        "graphql",
        "-f",
        "query=" + query,
        "-f",
        "owner=" + owner,
        "-f",
        "name=" + name,
        "-F",
        "number=" + target.number,
      ]);
      const { data } = response.parse(JSON.parse(output));
      if (data.repository.nameWithOwner !== target.repo || data.repository.pullRequest.number !== target.number)
        throw Error("GitHub response target mismatch");
      return { viewer: data.viewer.id, repo: data.repository };
    },
    async merge(state: State, method: MergeMethod): Promise<string | null> {
      const pull = state.repo.pullRequest;
      const output = await gh([
        "api",
        "--hostname",
        "github.com",
        "graphql",
        "-f",
        "query=" + mutation,
        "-f",
        "id=" + pull.id,
        "-f",
        "head=" + pull.headRefOid,
        "-f",
        "method=" + method.toUpperCase(),
      ]);
      const merged = mutationResponse.parse(JSON.parse(output)).data.mergePullRequest.pullRequest;
      if (
        merged.id !== pull.id ||
        merged.headRefOid !== pull.headRefOid ||
        merged.baseRefName !== pull.baseRefName
      )
        throw Error("GitHub response commit mismatch");
      return merged.mergeCommit?.oid ?? null;
    },
  };
}
type Api = ReturnType<typeof githubMergeApi>;
const unsafeText = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
function readiness(repo: Repo, methods: MergeMethod[]): MergeReason {
  const p = repo.pullRequest;
  if (p.state === "MERGED") return "merged";
  if (p.state === "CLOSED") return "closed";
  if (repo.isArchived || repo.isDisabled) return "blocked";
  if (!["ADMIN", "MAINTAIN", "WRITE"].includes(repo.viewerPermission ?? "")) return "permission";
  if (
    p.isMergeQueueEnabled ||
    p.isInMergeQueue ||
    p.baseRef?.rules.nodes.some((rule) => rule.type === "MERGE_QUEUE")
  )
    return "queue";
  if (p.baseRef?.rules.pageInfo.hasNextPage) return "unknown";
  if (p.baseRef?.rules.nodes.some((rule) => rule.type === "LOCK_BRANCH")) return "blocked";
  if (p.autoMergeRequest) return "auto-merge";
  if (p.isDraft) return "draft";
  if (p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY") return "conflict";
  if (p.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (p.reviewDecision === "REVIEW_REQUIRED") return "blocked";
  if (p.statusCheckRollup) {
    const { state } = p.statusCheckRollup;
    if (state === "FAILURE" || state === "ERROR") return "checks-failed";
    if (state === "PENDING" || state === "EXPECTED") return "checks-pending";
    if (state !== "SUCCESS") return "unknown";
  }
  if (p.mergeStateStatus !== "CLEAN") return p.mergeStateStatus === "UNKNOWN" ? "unknown" : "blocked";
  if (p.mergeable !== "MERGEABLE" || (p.reviewDecision !== null && p.reviewDecision !== "APPROVED"))
    return "unknown";
  if (
    !p.baseRef?.target?.oid ||
    !p.baseRefName ||
    !p.headRefName ||
    unsafeText.test(p.baseRefName) ||
    unsafeText.test(p.headRefName)
  )
    return "unknown";
  return methods.length ? "ready" : "no-method";
}
function blank(reason: MergeReason): MergePreview {
  return {
    status: "blocked",
    reason,
    title: "",
    headSha: "",
    headRef: "",
    baseRef: "",
    baseSha: "",
    checks: 0,
    methods: [],
    defaultMethod: null,
    token: null,
  };
}
function view(state: State): MergePreview {
  const repo = state.repo,
    p = repo.pullRequest;
  const permitted = {
    merge: repo.mergeCommitAllowed,
    squash: repo.squashMergeAllowed,
    rebase: repo.rebaseMergeAllowed,
  };
  const rules = p.baseRef?.rules.nodes ?? [];
  const linear =
    p.baseRef?.refUpdateRule?.requiresLinearHistory ||
    rules.some((rule) => rule.type === "REQUIRED_LINEAR_HISTORY");
  const methods = mergeMethod.options.filter(
    (m) =>
      permitted[m] &&
      !(linear && m === "merge") &&
      rules.every((rule) => {
        const allowed = rule.parameters?.allowedMergeMethods;
        return !allowed || allowed.some((method) => method.toLowerCase() === m);
      }),
  );
  const selected = methods.find((m) => m.toUpperCase() === repo.viewerDefaultMergeMethod);
  const reason = readiness(repo, methods);
  const safe = (s: string) => s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ");
  return {
    status: reason === "ready" ? "ready" : reason === "merged" ? "merged" : "blocked",
    reason,
    title: safe(p.title).slice(0, 512),
    headSha: p.headRefOid,
    headRef: safe(p.headRefName),
    baseRef: safe(p.baseRefName),
    baseSha: p.baseRef?.target?.oid ?? "",
    checks: p.statusCheckRollup?.contexts.totalCount ?? 0,
    methods,
    defaultMethod: selected ?? (methods.length === 1 ? methods[0] : null),
    token: null,
  };
}
function fingerprint(state: State, v: MergePreview) {
  const p = state.repo.pullRequest;
  return JSON.stringify([
    state.viewer,
    p.id,
    p.title,
    v.headSha,
    v.headRef,
    v.baseSha,
    v.baseRef,
    v.checks,
    p.reviewDecision,
    v.methods,
    v.defaultMethod,
  ]);
}
const outcome = (
  status: MergeResult["status"],
  reason: MergeReason,
  mergeSha: string | null = null,
): MergeResult => ({ status, reason, mergeSha });
type Voucher = {
  target: MergeTarget;
  fingerprint: string;
  pullId: string;
  title: string;
  head: string;
  baseRef: string;
  expires: number;
  method?: MergeMethod;
  submitted?: boolean;
  attempt?: Promise<MergeResult>;
  result?: MergeResult;
};
const sameTarget = (a: MergeTarget, b: MergeTarget) =>
  a.projectId === b.projectId && a.repo === b.repo && a.number === b.number;

export class PullMerges {
  private readonly vouchers = new Map<string, Voucher>();
  private readonly busy = new Set<string>();
  constructor(
    private readonly api: Api,
    private readonly now: () => number,
    private readonly invalidate: (repo: string) => void,
    private readonly record: (entry: PullMergeActivity) => void,
  ) {}

  private recordMerge(target: MergeTarget, title: string, status: "merged" | "already-merged", mergeSha: string | null) {
    try {
      this.record({
        projectId: target.projectId, title, at: new Date(this.now()).toISOString(),
        pullMerge: { repo: target.repo, number: target.number, status, mergeSha },
      });
    } catch {
      // GitHub's confirmed outcome must still reach the person who clicked Merge.
      console.warn("Could not save the confirmed PR merge to board history.");
    }
  }

  async preview(target: MergeTarget, scope: () => Promise<() => boolean>): Promise<MergePreview> {
    let current: () => boolean;
    try {
      current = await scope();
    } catch {
      return blank("scope");
    }
    if (!current()) return blank("scope");
    let state: State;
    try {
      state = await this.api.inspect(target);
    } catch {
      return blank("unavailable");
    }
    if (!current()) return blank("scope");
    const result = view(state);
    if (result.status !== "ready") {
      if (result.status === "merged") {
        this.recordMerge(target, result.title, "already-merged", state.repo.pullRequest.mergeCommit?.oid ?? null);
      }
      this.invalidate(target.repo);
      return result;
    }
    for (const [key, v] of this.vouchers) if (v.expires <= this.now() && !v.attempt) this.vouchers.delete(key);
    if (this.vouchers.size >= 512) return { ...result, status: "blocked", reason: "unavailable" };
    const token = randomUUID();
    this.vouchers.set(token, {
      target: { ...target },
      fingerprint: fingerprint(state, result),
      pullId: state.repo.pullRequest.id,
      title: result.title,
      head: result.headSha,
      baseRef: result.baseRef,
      expires: this.now() + 300_000,
    });
    return { ...result, token };
  }

  async confirm(request: Request, scope: () => Promise<() => boolean>,
    notify?: (entry: PullMergeActivity) => Promise<MergeNotification>): Promise<MergeResult> {
    const v = this.vouchers.get(request.token);
    if (!v || v.expires <= this.now()) return outcome("changed", "expired");
    if (!sameTarget(request, v.target) || (v.method && v.method !== request.method))
      return outcome("changed", "changed");
    let current: () => boolean;
    try {
      current = await scope();
    } catch {
      return outcome("blocked", "scope");
    }
    if (!current()) return outcome("blocked", "scope");
    if (v.attempt) return v.attempt;
    if (v.result && v.result.status !== "unconfirmed") return v.result;
    const key = request.repo + "#" + request.number;
    if (this.busy.has(key)) return outcome("unconfirmed", "unconfirmed");
    this.busy.add(key);
    v.method = request.method;
    const attempt = this.apply(v, request, current).then(async result => {
      if (result.status === "merged" && notify) {
        // Only this fresh, successful mutation can create a notification.
        const entry = {projectId:request.projectId, title:v.title, at:new Date(this.now()).toISOString(),
          pullMerge:{repo:request.repo,number:request.number,status:result.status,mergeSha:result.mergeSha}};
        try { result.notification = await notify(entry); }
        catch { result.notification = {status:"unavailable"}; }
      } else if (result.status === "merged" || result.status === "already-merged") {
        this.recordMerge(request, v.title, result.status, result.mergeSha);
      }
      v.result = result;
      this.invalidate(request.repo);
      return result;
    });
    v.attempt = attempt;
    try {
      return await attempt;
    } finally {
      this.busy.delete(key);
      delete v.attempt;
    }
  }

  private async apply(v: Voucher, request: Request, current: () => boolean): Promise<MergeResult> {
    let state: State;
    try {
      state = await this.api.inspect(request);
    } catch {
      return outcome("unconfirmed", "unavailable");
    }
    if (!current()) return outcome("blocked", "scope");
    const pull = state.repo.pullRequest,
      live = view(state);
    if (pull.id !== v.pullId || live.headSha !== v.head || live.baseRef !== v.baseRef)
      return outcome("changed", "changed");
    if (live.status === "merged") return outcome("already-merged", "merged", pull.mergeCommit?.oid);
    if (live.status !== "ready") return outcome("blocked", live.reason);
    if (fingerprint(state, live) !== v.fingerprint || !live.methods.includes(request.method))
      return outcome("changed", "changed");
    // An ambiguous mutation never gets re-sent by retrying the same confirmation button.
    if (v.submitted) return outcome("unconfirmed", "unconfirmed");
    // The confirmed checkout was resolved before this fresh GitHub read. Do not wait
    // for another remote request between the final local scope check and submission.
    if (v.expires <= this.now()) return outcome("changed", "expired");
    v.submitted = true;
    try {
      const mergeSha = await this.api.merge(state, request.method);
      return outcome("merged", "merged", mergeSha);
    } catch (error) {
      if (!current()) return outcome("unconfirmed", "scope");
      try {
        const after = await this.api.inspect(request),
          p = after.repo.pullRequest;
        if (!current()) return outcome("unconfirmed", "scope");
        if (p.id !== v.pullId || p.headRefOid !== v.head || p.baseRefName !== v.baseRef)
          return outcome("changed", "changed");
        if (p.state === "MERGED") return outcome("already-merged", "merged", p.mergeCommit?.oid);
        const latest = view(after);
        if (latest.status !== "ready") return outcome("blocked", latest.reason);
      } catch {
        return outcome("unconfirmed", "unconfirmed");
      }
      const failure = error as { stderr?: string; message?: string };
      const detail = [failure?.stderr, failure?.message].filter((s) => typeof s === "string").join(" ");
      if (/HTTP 403|Resource not accessible|not authorized|permission denied/i.test(detail))
        return outcome("blocked", "permission");
      if (/protected branch|branch protection|repository rule|merge queue|not mergeable/i.test(detail))
        return outcome("blocked", "blocked");
      return outcome("unconfirmed", "unconfirmed");
    }
  }
}
