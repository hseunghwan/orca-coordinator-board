// @ts-nocheck
// Ported from paseo-coordinator-board test/pr-merge.test.ts @ 2e9d128: vitest and import paths; the reopened board
// is this board's contribute() on an empty fake Orca instead of index.server with PASEO_HOME. Typed as loosely as upstream.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmPullRequestMerge, previewPullRequestMerge } from "../paseo/shared/prs";
import { githubMergeApi } from "../paseo/server/pr-merge";
import { ProjectPullRequests } from "./prs";
import { PreferenceStore } from "../paseo/server/preferences";
import { contribute } from "./board";
import { rpcServer } from "./rpc";
import { createCli } from "../orca/cli";
import { fakeOrca } from "../orca/fixtures/fake-orca";
import { createFleet } from "../orca";
import { boardSnapshot } from "../paseo/shared/contract";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const target = { projectId: "selected", repo: "org/site", number: 7 };
const head = "a".repeat(40),
  base = "b".repeat(40),
  merged = "c".repeat(40);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "coord-merge-"));
  dirs.push(directory);
  const store = new PreferenceStore(join(directory, "plugin-data", "coordinator-board", "scope.json"));
  store.change((s) => {
    s.projects = [target.projectId];
    s.projectRepositories.selected = { mode: "manual", repo: target.repo };
  });
  const p = {
    id: "PR_node",
    number: 7,
    state: "OPEN",
    title: "A plain <b>title</b>",
    isDraft: false,
    headRefOid: head,
    headRefName: "topic",
    baseRefName: "main",
    baseRef: {
      target: { oid: base },
      refUpdateRule: null,
      rules: { pageInfo: { hasNextPage: false }, nodes: [] },
    },
    mergeCommit: null,
    autoMergeRequest: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
    statusCheckRollup: { state: "SUCCESS", contexts: { totalCount: 4 } },
  };
  const repo = {
    nameWithOwner: target.repo,
    viewerPermission: "WRITE",
    isArchived: false,
    isDisabled: false,
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: false,
    viewerDefaultMergeMethod: "SQUASH",
    pullRequest: p,
  };
  const behavior = {
    now: 10,
    viewer: "viewer",
    preRead: () => {},
    merge: async () => {
      p.state = "MERGED";
      p.mergeCommit = { oid: merged };
    },
    origin: target.repo,
    listReads: 0,
    invalidations: 0,
  };
  const commands: string[][] = [];
  const api = githubMergeApi(async (args) => {
    commands.push(args);
    expect(args.slice(0, 4)).toEqual(["api", "--hostname", "github.com", "graphql"]);
    if (args.some((s) => s.startsWith("query=mutation "))) {
      expect(args).toContain("id=PR_node");
      expect(args).toContain("head=" + head);
      expect(args.find((s) => s.startsWith("query="))).toContain("expectedHeadOid:$head");
      await behavior.merge();
      return JSON.stringify({ data: { mergePullRequest: { pullRequest: p } } });
    }
    behavior.preRead();
    expect(args).toContain("owner=org");
    expect(args).toContain("name=site");
    expect(args).toContain("number=7");
    return JSON.stringify({ data: { viewer: { id: behavior.viewer }, repository: repo } });
  });
  const sdk = {
    projects: { list: async () => ({ projects: [{ projectId: "selected", projectRootPath: "/selected" }] }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) },
  };
  const deps = {
    now: () => behavior.now,
    localOrigin: async () => behavior.origin,
    githubPulls: async () => {
      behavior.listReads++;
      return { status: "ok", items: [] };
    },
  };
  function load(notifications?: any) {
    const service = new ProjectPullRequests(store, deps, api),
      handlers = new Map();
    service.register({ handle: (rpc, fn) => handlers.set(rpc.name, fn) }, () => behavior.invalidations++,notifications);
    const call = async (def, input) =>
      def.output.parse(await handlers.get(def.name)(def.input.parse(input), { paseo: sdk }));
    return {
      preview: (t = target) => call(previewPullRequestMerge, t),
      confirm: (token, method = "squash", t = target) => call(confirmPullRequestMerge, { ...t, token, method }),
      list: () => service.read(sdk),
    };
  }
  return {
    directory,
    store,
    p,
    repo,
    behavior,
    commands,
    ...load(),
    load,
    mutations: () => commands.filter((args) => args.some((s) => s.startsWith("query=mutation "))).length,
  };
}

test("preview reads live GitHub with no mutation, then confirm merges the approved SHA and invalidates the list", async () => {
  const f = fixture();
  await f.list();
  const v = await f.preview();
  expect(v).toMatchObject({
    status: "ready",
    headSha: head,
    headRef: "topic",
    baseRef: "main",
    baseSha: base,
    checks: 4,
    methods: ["merge", "squash"],
    defaultMethod: "squash",
    title: f.p.title,
  });
  expect(f.mutations()).toBe(0);
  expect(await f.confirm(v.token)).toEqual({ status: "merged", reason: "merged", mergeSha: merged });
  expect(f.commands.some((args) => args.includes("method=SQUASH"))).toBe(true);
  expect(await f.confirm(v.token)).toMatchObject({ status: "merged", mergeSha: merged });
  expect(f.mutations()).toBe(1);
  expect(f.behavior.invalidations).toBe(1);
  await f.list();
  expect(f.behavior.listReads).toBe(2);
  expect(await f.preview()).toMatchObject({ status: "merged", token: null });
});

test("blocked policies, queue, closed/draft, checks, reviews, permissions and uncertain states never create a voucher", async () => {
  const examples = [
    [{ isMergeQueueEnabled: true }, "queue"],
    [{ isInMergeQueue: true }, "queue"],
    [{ isDraft: true }, "draft"],
    [{ state: "CLOSED" }, "closed"],
    [{ mergeStateStatus: "BLOCKED" }, "blocked"],
    [{ mergeable: "UNKNOWN" }, "unknown"],
    [{ autoMergeRequest: { enabledAt: "now" } }, "auto-merge"],
    [{ reviewDecision: "REVIEW_REQUIRED" }, "blocked"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "changes-requested"],
    [{ mergeable: "CONFLICTING" }, "conflict"],
    [{ statusCheckRollup: { state: "FAILURE", contexts: { totalCount: 2 } } }, "checks-failed"],
    [{ statusCheckRollup: { state: "PENDING", contexts: { totalCount: 1 } } }, "checks-pending"],
  ];
  for (const [change, reason] of examples) {
    const f = fixture();
    Object.assign(f.p, change);
    expect(await f.preview()).toMatchObject({ status: "blocked", reason, token: null });
    expect(f.mutations()).toBe(0);
  }
  const f = fixture();
  f.repo.viewerPermission = "TRIAGE";
  expect((await f.preview()).reason).toBe("permission");
  f.repo.viewerPermission = "ADMIN";
  f.repo.squashMergeAllowed = false;
  f.repo.mergeCommitAllowed = false;
  expect((await f.preview()).reason).toBe("no-method");
});

test("methods intersect active branch rules, linear history and GitHub preferences; absent preference requires selection", async () => {
  const f = fixture();
  f.repo.viewerDefaultMergeMethod = null;
  expect((await f.preview()).defaultMethod).toBeNull();
  f.p.baseRef.refUpdateRule = { requiresLinearHistory: true };
  expect(await f.preview()).toMatchObject({ methods: ["squash"], defaultMethod: "squash" });
  f.p.baseRef.refUpdateRule = null;
  f.p.baseRef.rules.nodes = [{ type: "PULL_REQUEST", parameters: { allowedMergeMethods: ["MERGE"] } }];
  expect(await f.preview()).toMatchObject({ methods: ["merge"], defaultMethod: "merge" });
  f.p.baseRef.rules.nodes = [{ type: "MERGE_QUEUE", parameters: null }];
  expect((await f.preview()).reason).toBe("queue");
  f.p.baseRef.rules.nodes = [];
  f.p.baseRef.rules.pageInfo.hasNextPage = true;
  expect((await f.preview()).reason).toBe("unknown");
});

test("head, target branch, base tip, actor, method, GitHub state and project scope are rechecked on confirmation", async () => {
  for (const edit of [
    (f) => (f.p.headRefOid = "d".repeat(40)),
    (f) => (f.p.baseRefName = "release"),
    (f) => (f.p.baseRef.target.oid = "d".repeat(40)),
    (f) => (f.behavior.viewer = "other"),
    (f) => (f.repo.squashMergeAllowed = false),
  ]) {
    const f = fixture(),
      v = await f.preview();
    edit(f);
    expect(await f.confirm(v.token)).toMatchObject({ status: "changed" });
    expect(f.mutations()).toBe(0);
  }
  const f = fixture(),
    v = await f.preview();
  expect(await f.confirm(v.token, "rebase")).toMatchObject({ status: "changed" });
  expect(f.mutations()).toBe(0);
  const queued = await f.preview();
  f.p.isInMergeQueue = true;
  expect(await f.confirm(queued.token)).toMatchObject({ status: "blocked", reason: "queue" });
  const h = fixture(),
    ready = await h.preview();
  h.p.reviewDecision = "CHANGES_REQUESTED";
  expect(await h.confirm(ready.token)).toMatchObject({ status: "blocked", reason: "changes-requested" });
  const g = fixture();
  g.store.change((s) => {
    delete s.projectRepositories.selected;
  });
  const auto = await g.preview();
  g.behavior.origin = "org/elsewhere";
  expect(await g.confirm(auto.token)).toMatchObject({ status: "blocked", reason: "scope" });
  expect(g.mutations()).toBe(0);
  const i = fixture(),
    approved = await i.preview();
  i.behavior.preRead = () =>
    i.store.change((s) => {
      s.projects = [];
    });
  expect(await i.confirm(approved.token)).toMatchObject({ status: "blocked", reason: "scope" });
  expect(i.mutations()).toBe(0);
});

test("two confirmations share one mutation; a fresh token sees an already merged PR", async () => {
  const f = fixture(),
    first = await f.preview(),
    second = await f.preview();
  const [a, b] = await Promise.all([f.confirm(first.token), f.confirm(first.token)]);
  expect(a).toEqual(b);
  expect(f.mutations()).toBe(1);
  expect(await f.confirm(second.token)).toMatchObject({ status: "already-merged" });
  expect(f.mutations()).toBe(1);
});
test("two independent screens confirming concurrently never start two GitHub mutations", async () => {
  const f = fixture(),
    first = await f.preview(),
    second = await f.preview();
  let done: () => void, started: () => void;
  const gate = new Promise<void>((resolve) => {
    done = resolve;
  });
  const called = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.behavior.merge = async () => {
    started();
    await gate;
    f.p.state = "MERGED";
    f.p.mergeCommit = { oid: merged };
  };
  const one = f.confirm(first.token);
  await called;
  expect(await f.confirm(second.token)).toMatchObject({ status: "unconfirmed" });
  done();
  expect(await one).toMatchObject({ status: "merged" });
  expect(await f.confirm(second.token)).toMatchObject({ status: "already-merged" });
  expect(f.mutations()).toBe(1);
});
test("read failure before submitting is retryable; a changed head at the GitHub mutation is rejected and reread", async () => {
  const f = fixture(),
    ready = await f.preview();
  f.behavior.preRead = () => {
    throw Error("network unavailable");
  };
  expect(await f.confirm(ready.token)).toMatchObject({ status: "unconfirmed", reason: "unavailable" });
  expect(f.mutations()).toBe(0);
  f.behavior.preRead = () => {};
  f.behavior.merge = async () => {
    f.p.headRefOid = "d".repeat(40);
    throw Error("approved head does not match current head");
  };
  expect(await f.confirm(ready.token)).toMatchObject({ status: "changed" });
  expect(await f.confirm(ready.token)).toMatchObject({ status: "changed" });
  expect(f.mutations()).toBe(1);
});
test("after a timeout the same confirmation only reconciles; a lost GitHub success is recovered by reading", async () => {
  const f = fixture(),
    ready = await f.preview();
  f.behavior.merge = async () => {
    throw Error("socket timed out");
  };
  expect(await f.confirm(ready.token)).toMatchObject({ status: "unconfirmed" });
  expect(await f.confirm(ready.token)).toMatchObject({ status: "unconfirmed" });
  expect(f.mutations()).toBe(1);
  f.p.state = "MERGED";
  f.p.mergeCommit = { oid: merged };
  expect(await f.confirm(ready.token)).toMatchObject({ status: "already-merged", mergeSha: merged });
  expect(f.mutations()).toBe(1);
  const g = fixture(),
    next = await g.preview();
  g.behavior.merge = async () => {
    g.p.state = "MERGED";
    g.p.mergeCommit = { oid: merged };
    throw Error("connection reset");
  };
  expect(await g.confirm(next.token)).toMatchObject({ status: "already-merged", mergeSha: merged });
  expect(g.mutations()).toBe(1);
});
test("a protected branch rejects the mutation; another PR, another project, a restart or expired preview cannot submit", async () => {
  const f = fixture(),
    ready = await f.preview();
  f.behavior.merge = async () => {
    throw Error("HTTP 403: protected branch");
  };
  expect(await f.confirm(ready.token)).toMatchObject({ status: "blocked" });
  expect(await f.confirm(ready.token)).toMatchObject({ status: "blocked" });
  expect(f.mutations()).toBe(1);
  const g = fixture(),
    next = await g.preview();
  expect(await g.confirm(next.token, "squash", { ...target, projectId: "other" })).toMatchObject({
    status: "changed",
  });
  expect(await g.confirm(next.token, "squash", { ...target, number: 8 })).toMatchObject({ status: "changed" });
  expect(await g.load().confirm(next.token)).toMatchObject({ reason: "expired" });
  g.behavior.now += 300_001;
  expect(await g.confirm(next.token)).toMatchObject({ reason: "expired" });
  expect(g.mutations()).toBe(0);
});

test("confirmed board merges survive a fresh read; repeats keep their original time and attribution", async () => {
  const f = fixture();
  const ready = await f.preview();
  await f.confirm(ready.token);
  const first = f.store.read().pullMergeHistory;
  const entries = Object.values(first);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    title: f.p.title, projectId: target.projectId,
    pullMerge: {repo:target.repo, number:target.number, status:"merged", mergeSha:merged},
  });
  f.behavior.now += 200;
  expect(await f.load().preview()).toMatchObject({status:"merged"});
  expect(f.store.read().pullMergeHistory).toEqual(first);

  // Reopen the board with a new plugin instance, after the PR left GitHub's open list.
  const handlers = new Map();
  const dataDir = join(f.directory, "plugin-data", "coordinator-board");
  const fleet = createFleet(createCli(fakeOrca([]).runner), Date.now, { dataDir });
  contribute(rpcServer((name, handler) => handlers.set(name, handler), fleet.paseo), fleet, dataDir);
  const snapshot = async () => boardSnapshot.output.parse(await handlers.get(boardSnapshot.name)({fresh:true}));
  f.store.change(scope => {scope.projectRepositories[target.projectId] = {mode:"off"};});
  expect((await snapshot()).replyHistory).toEqual([{...entries[0], key:"merge:org/site#7", status:"recorded"}]);
  f.store.change(scope => {scope.projects = [];});
  expect((await snapshot()).replyHistory).toEqual([]);
});

test("observing an externally merged PR records its confirmed state; blocked or uncertain actions do not", async () => {
  const f = fixture();
  const ready = await f.preview();
  f.behavior.merge = async () => { throw Error("timeout"); };
  expect((await f.confirm(ready.token)).status).toBe("unconfirmed");
  expect(f.store.read().pullMergeHistory).toEqual({});
  f.p.state = "MERGED";
  f.p.mergeCommit = {oid:merged};
  await f.load().preview();
  expect(Object.values(f.store.read().pullMergeHistory)[0].pullMerge).toMatchObject({status:"already-merged", mergeSha:merged});
  expect(f.mutations()).toBe(1);
});

test("history storage failure preserves the successful GitHub result", async () => {
  const f = fixture();
  const ready = await f.preview();
  f.store.change = () => { throw Error("storage is read-only"); };
  expect(await f.confirm(ready.token)).toMatchObject({status:"merged",mergeSha:merged});
  expect(f.mutations()).toBe(1);
});

test("only the confirmed mutation, never polling, stale confirmations or an externally merged PR, calls the notifier", async () => {
  const f = fixture();
  const delivered = [];
  const service = f.load({owner: () => ({coordinator:"c",recipientId:"c"}),
    confirmed: async (_, entry, expected) => {
      delivered.push({entry, expected});
      return {status:"sent",recipientId:"c"};
    }});
  const [one,two] = await Promise.all([service.preview(),service.preview()]);
  const both = await Promise.all([service.confirm(one.token),service.confirm(one.token)]);
  expect(both[0]).toEqual(both[1]);
  expect(both[0].notification).toEqual({status:"sent",recipientId:"c"});
  expect((await service.confirm(two.token)).status).toBe("already-merged");
  await service.preview();
  await service.confirm(one.token);
  expect(delivered).toHaveLength(1);
  expect(delivered[0].entry.pullMerge).toEqual({status:"merged",repo:target.repo,number:7,mergeSha:merged});
  expect(f.mutations()).toBe(1);
});
