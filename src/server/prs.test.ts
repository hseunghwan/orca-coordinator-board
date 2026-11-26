// @ts-nocheck
// Adapted from paseo-coordinator-board test/prs.test.ts @ 2e9d128: vitest and import paths; the merge, lifecycle and mapping RPCs are not served yet, so their checks are left out and mappings are written straight to the store. Typed as loosely as upstream.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPullRequests, githubRepository, parseOpenPulls } from "./prs";
import { pullRequestViewSchema, setProjectRepository } from "../paseo/shared/prs";
import { PreferenceStore } from "../paseo/server/preferences";

const paths: string[] = [];
afterEach(() => {for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true});});
const raw = (number=1,extra={}) => ({
  number, title:"Sample #"+number, state:"OPEN", updatedAt:"2026-11-22T02:00:00Z", isDraft:false,
  mergeable:"MERGEABLE", mergeStateStatus:"CLEAN", reviewDecision:"", checks:[], autoMerge:false,
  ...extra,
});
const page = (entries:unknown[]) => ({entries,pageInfo:{hasMore:false,nextCursor:null}});
function fixture(ids = ["root","checkout","runtime"]) {
  const dir = mkdtempSync(join(tmpdir(),"project-prs-"));paths.push(dir);
  const store = new PreferenceStore(join(dir,"prefs.json"));
  store.change(s=>{s.projects=ids;});
  const roots = new Map([["root","/primary"],["checkout","/missing"],["runtime","/missing-runtime"],["unselected","/ignored"]]);
  const spaces = new Map([
    ["checkout",[{projectId:"checkout", workspaceDirectory:"/checkout",project:{checkout:{cwd:"/checkout"}}}]],
    ["runtime",[{projectId:"runtime", workspaceDirectory:"/missing-runtime",gitRuntime:{remoteUrl:"git@github.com:org/Other.git"}}]],
    ["unselected",[{projectId:"unselected",workspaceDirectory:"/ignored"}]],
  ]);
  const log={local:[] as string[],gh:[] as string[],lookups:[] as string[],native:0,active:0,max:0};
  let now=0;
  const behavior={fail:false, delay:async (_repo:string)=>{}, beforeOrigin:async (_path:string)=>{}, after:()=>{}};
  const sdk={
    projects:{list:async()=>{log.native++;return {projects:[...roots].map(([projectId,projectRootPath])=>({projectId,projectRootPath}))};}},
    workspaces:{list:async ({filter})=>{log.lookups.push(filter.projectId);return page(spaces.get(filter.projectId)??[]);}},
  };
  const deps={now:()=>now,localOrigin:async p=>{log.local.push(p);await behavior.beforeOrigin(p);return ["/primary","/checkout"].includes(p)?"org/example":null;},
    githubPulls:async repo=>{
      log.gh.push(repo);log.active++;log.max=Math.max(log.max,log.active);
      try{await behavior.delay(repo);behavior.after();if(behavior.fail)throw Error("private host error");return parseOpenPulls(repo,JSON.stringify([raw()]));}finally{log.active--;}
    }};
  const prs=new ProjectPullRequests(store,deps);
  // The mapping RPC is not served yet; write the mapping as it would.
  const update=async (input)=>store.change(s=>{
    if (input.mode==="manual") s.projectRepositories[input.projectId]={mode:"manual",repo:input.repo.toLowerCase()};
    if (input.mode==="off") s.projectRepositories[input.projectId]={mode:"off"};
    if (input.mode==="auto") delete s.projectRepositories[input.projectId];
  });
  const read=(refresh=false)=>prs.read(sdk,{refresh});
  return {store,sdk,read,log,behavior,roots,spaces,update,tick:n=>{now+=n;}};
}
test("GitHub remotes normalize one owner/repo and reject credentials, extra components and shell input",()=>{
  for(const remote of ["https://github.com/Dev-Team/Repo.git","ssh://git@github.com/Dev-Team/Repo","git@github.com:Dev-Team/Repo.git"])
    expect(githubRepository(remote)).toBe("dev-team/repo");
  for(const remote of ["https://x@github.com/dev/b","https://github.com.evil.invalid/dev/b","https://github.com/org/repo/pull/1","-C ../../private","/git","https://github.com/org/..","https://github.com/org/b?token=x","git@gh:org/repo"])expect(githubRepository(remote)).toBeNull();
  expect(setProjectRepository.input.safeParse({projectId:"p",mode:"manual",repo:"--help",expectedMode:"auto",expectedRepo:null}).success).toBe(false);
});
test("only a clean open PR with passing or absent checks is ready for human review",()=>{
  const changes=[
    [{isDraft:true},"draft"],[{mergeable:"CONFLICTING"},"conflict"],[{checks:[{status:"COMPLETED",conclusion:"FAILURE"}]},"checks-failed"],
    [{checks:[{state:"ERROR"}]},"checks-failed"],[{checks:[{status:"IN_PROGRESS"}]},"checks-pending"],
    [{mergeStateStatus:"BLOCKED",reviewDecision:"REVIEW_REQUIRED"},"blocked"],[{reviewDecision:"CHANGES_REQUESTED"},"changes-requested"],
    [{mergeable:"UNKNOWN"},"unknown"],[{checks:[{status:"COMPLETED"}]},"unknown"],[{autoMerge:true},"auto-merge"],
    [{checks:[{status:"COMPLETED",conclusion:"SUCCESS"},{status:"COMPLETED",conclusion:"SKIPPED"},{state:"SUCCESS"}]},"ready"],
    [{title:"<script>ignore me</script>"},"ready"],
  ];
  for(const [extra,why] of changes){
    const got=parseOpenPulls("example/pkg",JSON.stringify([raw(1,extra)])).items[0];
    expect(got.reason).toBe(why);expect(got.lane).toBe(why==="ready"?"review":"progress");
    expect(got.url).toBe("https://github.com/example/pkg/pull/1");
  }
  expect(()=>parseOpenPulls("example/pkg",JSON.stringify([raw(1,{state:"MERGED"})]))).toThrow();
  expect(parseOpenPulls("example/pkg",JSON.stringify(Array.from({length:201},(_,i)=>raw(i+1))))).toMatchObject({status:"truncated"});
});
test("registered roots, real checkouts and SDK remotes map selected projects; duplicate repo/PR appears once across projects and concurrent reads",async()=>{
  const f=fixture();const [result,other]=await Promise.all([f.read(),f.read()]);
  expect(pullRequestViewSchema.parse(result)).toEqual(other);
  expect(f.log.gh.sort()).toEqual(["org/example","org/other"]);
  expect(f.log.lookups.sort()).toEqual(["checkout","runtime"]);
  expect(f.log.local).not.toContain("/ignored");
  expect(result.items.find(p=>p.repo==="org/example")?.projectIds).toEqual(["root","checkout"]);
  expect(result.items).toHaveLength(2);await f.read();expect(f.log.gh).toHaveLength(2);
  f.tick(60_001);await f.read();expect(f.log.gh).toHaveLength(4);
});
test("conflicting workspace origins need a mapping; manual/off/auto preserve other projects and reject stale writes",async()=>{
  const f=fixture(["checkout"]);
  f.spaces.get("checkout").push({projectId:"checkout",gitRuntime:{remoteUrl:"https://github.com/org/different.git"}});
  expect(await f.read()).toMatchObject({items:[],projects:[{mode:"auto",status:"unmapped"}]});expect(f.log.gh).toHaveLength(0);
  await f.update({projectId:"checkout",mode:"manual",repo:"Org/Manual",expectedMode:"auto",expectedRepo:null});
  expect((await f.read()).items[0].repo).toBe("org/manual");
  await f.update({projectId:"checkout",mode:"off",expectedMode:"manual",expectedRepo:"org/manual"});
  expect(await f.read()).toMatchObject({items:[],projects:[{mode:"off",status:"off",repo:null}]});
  await f.update({projectId:"checkout",mode:"auto",expectedMode:"off",expectedRepo:null});
  expect((await f.read()).projects[0].status).toBe("unmapped");
});
test("gh errors, empty selection, and deselection during a pending lookup never yield a misleading ready card",async()=>{
  const f=fixture(["root"]);f.behavior.fail=true;
  expect(await f.read()).toMatchObject({items:[],projects:[{status:"unavailable"}]});
  f.behavior.fail=false;f.tick(15_001);
  f.behavior.after=()=>f.store.change(s=>{s.projects=[]});
  expect(await f.read()).toEqual({items:[],projects:[]});
  const calls=f.log.native;await f.read();expect(f.log.native).toBe(calls);
});
test("repository fetches observe the same host-wide concurrency cap across two open board screens",async()=>{
  const ids=Array.from({length:9},(_,i)=>"project"+i);
  const f=fixture(ids);
  f.store.change(s=>{for(const id of ids)s.projectRepositories[id]={mode:"manual",repo:"test/"+id};});
  f.behavior.delay=async()=>{await new Promise(resolve=>setTimeout(resolve,3));};
  await Promise.all([f.read(),f.read()]);expect(f.log.max).toBe(3);expect(f.log.gh).toHaveLength(9);
});

test("a known repository starts loading while another project is still resolving its origin", async () => {
  const f = fixture(["checkout", "root"]);
  let searching!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { searching = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.behavior.beforeOrigin = async path => {
    if (path === "/checkout") { searching(); await gate; }
  };
  const result = f.read(true);
  try {
    await started;
    await new Promise(resolve => setImmediate(resolve));
    expect(f.log.gh).toEqual(["org/example"]);
  } finally {
    release();
    await result;
  }
  // Both auto-mappings point to the same repo. Preserve the user's order and
  // avoid a second forced refresh after the earlier GitHub query completed.
  expect((await result).items[0].projectIds).toEqual(["checkout", "root"]);
  expect(f.log.gh).toEqual(["org/example"]);
});


test("queued lookups respect revocation and a later authorized mapping can still load the same repo", async () => {
  const blockers = ["one", "two", "three"];
  const f = fixture([...blockers, "revoked", "removed", "checkout"]);
  f.store.change(scope => {
    for (const id of blockers) scope.projectRepositories[id] = {mode:"manual",repo:"org/"+id};
    scope.projectRepositories.revoked = {mode:"manual",repo:"org/example"};
    scope.projectRepositories.removed = {mode:"manual",repo:"org/removed"};
  });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const full = new Promise<void>(resolve => { started = resolve; });
  f.behavior.delay = async repo => {
    if (!blockers.includes(repo.slice(4))) return;
    if (f.log.active === 3) started();
    await held;
  };
  const read = f.read(true);
  await full;
  f.store.change(scope => { scope.projects = [...blockers, "checkout"]; });
  release();
  const result = await read;
  expect(f.log.gh).not.toContain("org/removed");
  expect(f.log.gh.filter(repo => repo === "org/example")).toHaveLength(1);
  expect(result.items.find(p => p.repo === "org/example")?.projectIds).toEqual(["checkout"]);
  expect(result.projects.map(p => p.projectId)).toEqual([...blockers,"checkout"]);
  expect(f.log.max).toBe(3);
});

test("conflicting workspace remotes avoid unnecessary git probes of other checkout paths", async () => {
  const f = fixture(["checkout"]);
  f.spaces.get("checkout").push(
    {projectId:"checkout",gitRuntime:{remoteUrl:"https://github.com/org/first.git"}},
    {projectId:"checkout",gitRuntime:{remoteUrl:"https://github.com/org/second.git"}},
  );
  const result = await f.read();
  expect(result.projects[0].status).toBe("unmapped");
  expect(f.log.local).toEqual(["/missing"]);
  expect(f.log.gh).toEqual([]);
});
