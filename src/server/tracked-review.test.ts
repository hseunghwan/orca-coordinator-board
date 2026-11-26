// @ts-nocheck
// Ported from paseo-coordinator-board test/tracked-review.test.ts @ 2e9d128: vitest, import paths and bun's toBeEmpty.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceStore } from "../paseo/server/preferences";
import { TrackedDecisionStore } from "./tracked-decisions";
import { trackedReviewTool } from "./tracked-review";
import { resolveTrackedDecision } from "../paseo/shared/tracked-decisions";

const scratch:string[] = [];
afterEach(() => { for(const dir of scratch.splice(0)) rmSync(dir,{recursive:true,force:true}); });
const card = (id:string, extra={}) => ({source:"fixture", projectId:"book", id, title:id, sessionId:"worker", where:"manager", kind:"check", ...extra});
const merge = (id:string,number:number,extra={}) => card(id,{
  kind:"merge", title:"PR #"+number, ask:[`https://github.com/example/book/pull/${number}를 병합할까요?`],
  mergeTarget:{repo:"example/book",number}, ...extra,
});
function fixture(initial:unknown[]) {
  const dir = mkdtempSync(join(tmpdir(),"review-board-records-"));
  scratch.push(dir);
  const feed=join(dir,"tracked.json"), prefs=new PreferenceStore(join(dir,"preferences.json"));
  const store=()=>new TrackedDecisionStore(feed);
  const tracked=store();
  const projectSet=()=>new Set(prefs.read().projects);
  const read=()=>store().read(projectSet(),[],{items:[],projects:[]});
  const write=(items:unknown[])=>writeFileSync(feed,JSON.stringify({version:1,items}));
  prefs.change(s=>{s.projects=["book"]; s.coordinator="coord";});
  write(initial);
  const status={pr:"MERGED", beforePr:()=>{}, beforeEvidence:()=>{}, evidence:{id:"turn-3",turns:[]},
    worker:"idle", workerProject:"book", workerBlocked:false, invalidations:0, queries:[] as number[]};
  const page=(entries:unknown[])=>({entries,pageInfo:{hasMore:false,nextCursor:null}});
  const sdk={workspaces:{list:async()=>page([])},agents:{
    list:async()=>page(["coord","worker"].map(id=>({agent:{id,title:id,status:id==="worker"?status.worker:"idle",
      updatedAt:"2026-11-22T08:01:00Z",pendingPermissions:id==="worker"&&status.workerBlocked?[{id:"approval"}]:[]},
      project:{projectKey:id==="worker"?status.workerProject:"book"}}))),
  }};
  const prs={lifecycle:async (_p,t)=>{status.queries.push(t.number);status.beforePr();return status.pr;}};
  const reader={read:async()=>{status.beforeEvidence();return status.evidence;}};
  const tool=trackedReviewTool(prefs,tracked,prs,reader,()=>{status.invalidations++;});
  const run=(input={},caller="coord")=>tool.execute(tool.input.parse(input),{paseo:sdk,agent:{id:caller}});
  const claim=(record,quote:string,evidenceId="turn-3")=>({review:{key:record.key,fingerprint:record.fingerprint,quote,evidenceId}});
  return {prefs,tracked,projectSet,read,write,status,run,claim};
}

test("merged-only records close against their own PR and a restart preserves the reviewer's evidence",async()=>{
  const f=fixture([merge("merged",42),merge("follow-up",43,{questions:[{id:"Q1",text:"When do we publish?"}]}),
    merge("mixed",44,{ask:["Should we merge #44? When should we publish?"]}),
    merge("review-by-person",45,{where:"human"}),merge("unanswered-follow-up",46,{qa:[{q:"Who will deploy?",a:null}]})]);
  const item=f.read().items[0];
  const result=JSON.parse((await f.run()).text);
  expect(result.closed).toEqual([item.key]);expect(f.status.queries).toEqual([42]);
  const view=f.read();
  expect(view.items.map(i=>i.id)).toEqual(["follow-up","mixed","review-by-person","unanswered-follow-up"]);
  expect(view.history).toHaveLength(1);
  expect(view.history![0]).toMatchObject({status:"closed",reviewedBy:"coord",reviewReason:"GitHub · example/book #42 · MERGED"});
  expect(view.history![0].answer).toBeUndefined();expect(view.history![0].messageId).toBeUndefined();
  expect(JSON.parse((await f.run()).text).closed).toHaveLength(0);expect(f.status.invalidations).toBe(1);
});

test("a stale explicit PR binding cannot supersede the repository/number in the request",async()=>{
  const f=fixture([merge("mismatch-number",42,{ask:["https://github.com/example/book/pull/43를 병합할까요?"]}),
    merge("mismatch-repo",42,{ask:["https://github.com/another/repo/pull/42를 병합할까요?"]}),
    merge("mismatch-short",42,{ask:["#43를 병합할까요?"]})]);
  await f.run();
  expect(f.read().items).toHaveLength(3);expect(f.read().history).toBeUndefined();
});

test("an unmerged or unavailable PR, changed ledger and pending user delivery cannot be closed",async()=>{
  for(const pr of ["OPEN","CLOSED","UNKNOWN"]){
    const f=fixture([merge("pull",42)]);f.status.pr=pr;await f.run();expect(f.read().items).toHaveLength(1);
  }
  const f=fixture([merge("pull",42)]);
  f.status.beforePr=()=>f.write([merge("pull",42,{questions:[{id:"when",text:"Now or next week?"}]})]);
  await f.run();expect(f.read().items).toHaveLength(1);
  f.status.beforePr=()=>{};f.write([merge("pull",42)]);
  const item=f.read().items[0];
  const target={ready:true,stillCurrent:()=>true,send:async()=>{throw Error("dropped confirmation");},accepted:async()=>false};
  const reply=await f.tracked.deliver({...item,recipientId:"coord",answer:"Check the build"},f.projectSet,async()=>target);
  expect(reply.status).toBe("unconfirmed");
  await f.run();expect(f.read().history![0].status).toBe("pending");expect(f.read().items).toHaveLength(1);
});

test("only the designated coordinator can record a finished check; human replies keep their separate manual path",async()=>{
  const f=fixture([card("audio-check"),card("needs-human",{where:"human"}),card("cleanup",{kind:"cleanup"})]);
  const [check,human,cleanup]=f.read().items;
  const statement="audio-check 검증을 완료했습니다.";
  f.status.evidence={id:"turn-3",turns:[{role:"assistant",text:statement}]};
  await expect(f.run(f.claim(check,statement),"worker")).rejects.toThrow();
  for(const claim of [f.claim(check,"fabricated audio-check completed"),f.claim(check,statement,"old-turn"),
    f.claim({...check,fingerprint:"0".repeat(64)},statement),f.claim(human,statement),f.claim(cleanup,statement)]) {
    await f.run(claim);expect(f.read().items).toHaveLength(3);
  }
  await f.run(f.claim(check,statement));
  expect(f.read().history![0]).toMatchObject({reviewedBy:"coord",reviewReason:statement,status:"closed"});
  const manual={source:human.source,projectId:human.projectId,id:human.id,fingerprint:human.fingerprint};
  expect(resolveTrackedDecision.input.safeParse({...manual,reviewedBy:"coord"}).success).toBe(false);
  expect(f.tracked.resolve(manual,f.projectSet).status).toBe("closed");
  expect(f.read().history?.find(h=>h.title===human.title)?.reviewedBy).toBeUndefined();
});

test("an exact quote about incomplete work, a new instruction, or an older turn never serves as completion proof",async()=>{
  const f=fixture([card("audio-check")]);
  const record=f.read().items[0];
  for(const [quote,turn] of [
    ["audio-check 검증은 아직 완료되지 않았습니다.","audio-check 검증은 아직 완료되지 않았습니다."],
    ["audio-check 검증을 완료했습니다.","이전 보고: audio-check 검증을 완료했습니다. 재검증이 필요하므로 지금은 보류해 주세요."],
  ]) {
    f.status.evidence={id:"turn-3",turns:[{role:"assistant",text:turn}]};
    await f.run(f.claim(record,quote));
    expect(f.read().items).toHaveLength(1);
  }
  const quote="audio-check 검증을 완료했습니다.";
  for(const evidence of [
    {id:"turn-3",turns:[{role:"assistant",text:quote,truncated:true}]},
    {id:"turn-3",turns:[{role:"assistant",text:quote}],laterInput:true},
    {id:"turn-3",turns:[{role:"assistant",text:quote},{role:"user",text:"다시 확인해 주세요"}]},
  ]) {
    f.status.evidence=evidence;await f.run(f.claim(record,quote));expect(f.read().items).toHaveLength(1);
  }
});

test("an old source session must still belong to the card project when its evidence comes back",async()=>{
  const f=fixture([card("audio-check")]);const record=f.read().items[0];
  const quote="audio-check 검증을 완료했습니다.";
  f.status.evidence={id:"turn-3",turns:[{role:"assistant",text:quote}]};
  f.status.beforeEvidence=()=>f.prefs.change(s=>{
    s.projects=["book","other"];
    s.sessionLinks.worker={sessionId:"worker",title:"worker",sourceProjectId:"book",sourceProjectTitle:"Book",
      targetProjectId:"other",targetProjectTitle:"Other",workspaceTitle:"Workspace"};
  });
  await f.run(f.claim(record,quote));expect(f.read().items).toHaveLength(1);
});

test("the caller losing its role or the managed project being removed during verification invalidates the close",async()=>{
  const f=fixture([merge("ready",42)]);
  f.status.beforePr=()=>f.prefs.change(s=>{s.coordinator="replacement";});
  await expect(f.run()).rejects.toThrow();
  expect(f.read().items).toHaveLength(1);
  const g=fixture([merge("ready",42)]);
  g.status.beforePr=()=>g.prefs.change(s=>{s.projects=["another"];});
  await g.run();
  g.prefs.change(s=>{s.projects=["book"];});
  expect(g.read().items).toHaveLength(1);
});

test("an unverified source session, remote source or active permission stops session-based review",async()=>{
  const f=fixture([card("audio-check")]);
  const quote="audio-check 검증을 완료했습니다.";
  f.status.evidence={id:"turn-3",turns:[{role:"assistant",text:quote}]};
  for(const variant of [
    {change:{sessionHost:"remote"},status:"idle",pending:false},
    {change:{sessionId:"missing"},status:"idle",pending:false},
    {change:{},status:"running",pending:false},
    {change:{},status:"idle",pending:true},
  ]){
    f.status.worker=variant.status;f.status.workerBlocked=variant.pending;f.write([card("audio-check",variant.change)]);
    const [record]=f.read().items;
    await f.run(f.claim(record,quote));expect(f.read().items).toHaveLength(1);
  }
});

test("a dated check requires a source turn at or after that card, even if a previous check used the same title",async()=>{
  const since="2026-11-22T08:00:00Z";
  const f=fixture([card("export-check",{title:"Export validation",since})]);
  const record=f.read().items[0];
  const quote="Export validation completed.";
  const report=async(at?:string)=>{
    f.status.evidence={id:"turn-3",turns:[{role:"assistant",text:quote,at}]};
    return f.run(f.claim(record,quote));
  };
  for (const at of [undefined,"2026-11-22T16:59:59+09:00","unknown"]) {
    await report(at);expect(f.read().items).toHaveLength(1);
  }
  await report("2026-11-22T17:00:00+09:00");
  expect(f.read().history?.[0]).toMatchObject({status:"closed",reviewReason:quote});
});
