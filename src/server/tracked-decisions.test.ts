// Ported from paseo-coordinator-board test/tracked-decisions.test.ts @ 2e9d128: import paths, vitest, and bun's toBeEmpty/toBeFunction as their vitest forms.
// @ts-nocheck: typed as loosely as upstream.
import { SessionPhotoStore } from "../paseo/server/session-photos";
import { isBoardPhotoMessage } from "../paseo/shared/session-photos";
import {afterEach, expect, test} from "vitest";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TrackedDecisionStore} from "./tracked-decisions";
import {cancelQueuedReply, mentionsSecurityGate, resolveTrackedDecision, suggestedTrackedReply, trackedAnswerText, trackedPullTarget, trackedRecipient, trackedCoverage, trackedDecisionViewSchema} from "../paseo/shared/tracked-decisions";
import type {SessionRow} from "../paseo/shared/contract";
import type {PullRequestView} from "../paseo/shared/prs";
import {readReplyPhoto} from "../paseo/shared/reply-history";

const directories:string[]=[];
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
const row=(id:string,extra={})=>({source:"feed",projectId:"p",id,title:"Title",...extra});
const match={projectId:"p",sessionId:"s",question:"Which header?"};
const s:SessionRow={id:"s",title:"Session",projectId:"p",projectTitle:"Test",workspaceTitle:"Main",model:null,lane:"human",detail:"Earlier draft",
  decision:{question:match.question,version:"current",source:"coordinator"}};
const target={repo:"demo/repo",number:42};
const pr={...target,title:"PR",url:"https://github.com/demo/repo/pull/42",updatedAt:"",lane:"review",reason:"ready",projectIds:["p"]} as const;
function fixture(extra?:ConstructorParameters<typeof TrackedDecisionStore>[1]){
  const dir=mkdtempSync(join(tmpdir(),"coordinator-tracked-"));directories.push(dir);
  const path=join(dir,"tracked-decisions.json"), service=new TrackedDecisionStore(path,extra);
  const selected=new Set(["p"]);
  const write=(items:unknown[])=>writeFileSync(path,JSON.stringify({version:1,items}));
  const read=(sessions:SessionRow[]=[s],pulls:PullRequestView["items"]=[{...pr,projectIds:["p"]}])=>service.read(selected,sessions,{items:pulls,projects:[]});
  const close=(item,answer?:string)=>service.resolve(resolveTrackedDecision.input.parse({
    source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint,answer,
  }),()=>new Set(selected));
  return {dir,path,service,selected,write,read,close};
}

test("two decisions in one session, explicit globals and rich content survive normalizing; unselected rows are hidden",()=>{
  const f=fixture();
  const rich=row("a",{sessionId:"s",sessionMatch:match,questions:[{id:"q",text:"Pick one",multi:true,options:[{key:"a",text:"A",recommended:true,
    does:["one","two"],pros:"faster",cons:["uses bandwidth"],note:"note"}]}],qa:[{q:"yesterday",a:"yes",askedAt:"then"}],replyHistory:[{text:"answer",at:"now"}]});
  f.write([rich,row("b",{sessionId:"s"}),row("a",{source:"another"}),row("a",{projectId:null}),row("hidden",{projectId:"x"})]);
  const view=trackedDecisionViewSchema.parse(f.read());
  expect(view.items.map(i=>[i.source,i.projectId,i.id])).toEqual([["feed","p","a"],["feed","p","b"],["another","p","a"],["feed",null,"a"]]);
  expect(new Set(view.items.map(i=>i.key)).size).toBe(4);
  expect(view.items[0]).toMatchObject({matchedSessionId:"s",questions:[{id:"q",multi:true,options:[{does:"one\ntwo",pros:"faster"}]}],qa:[{a:"yes"}],replyHistory:[{at:"now"}]});
  expect(view.items[1].matchedSessionId).toBeNull();
  f.selected.clear();expect(f.read().items.map(i=>i.projectId)).toEqual([null]);
});

test("suppression requires a ready same-repo PR or a live exact matching question with both projects included",()=>{
  const f=fixture();f.selected.add("other");
  const rows=[row("cross",{projectId:"other",sessionMatch:match}),row("merge",{kind:"merge",mergeTarget:target})];
  f.write(rows);
  const current=f.read();expect(trackedCoverage(current.items)).toEqual({sessionIds:new Set(["s"]),pullKeys:new Set(["demo/repo#42"])});
  for(const change of [{id:"renamed"},{projectId:"other"},{nativePending:true},{decisionAnswered:true},{lane:"review"},
    {decision:{...s.decision,source:"permission"}},{decision:{...s.decision,question:"Which header? Extra text."}}]){
    const result=f.read([{...s,...change}]);
    expect(result.items[0].matchedSessionId).toBeNull();
  }
  f.selected.delete("p");expect(f.read().items[0].matchedSessionId).toBeNull();
  f.selected.add("p");
  for(const diff of [{projectIds:["other"]},{repo:"elsewhere/repo"},{number:43},{reason:"draft",lane:"progress"}]){
    const view=f.read([s],[{...pr,projectIds:["p"],...diff}]);expect(view.items[1].matchedPull).toBeNull();
  }
  expect(f.read([s],[]).items).toHaveLength(2);
  f.write([row("remote",{sessionId:"s",sessionHost:"remote-device",sessionMatch:match})]);
  expect(f.read().items[0]).toMatchObject({sessionHost:"remote-device",matchedSessionId:null});
  f.write([row("merely-linked",{kind:"check",mergeTarget:target})]);expect(f.read().items[0].matchedPull).toBeNull();
});

test("resolving a fingerprint records the actual answer and time locally, preserves feed bytes and reopens changed content",()=>{
  const f=fixture();f.write([row("a"),row("b")]);
  const initial=f.read().items[0], bytes=readFileSync(f.path);
  expect(f.close(initial,"Keep blue").status).toBe("closed");
  expect(f.close(initial,"Keep blue").status).toBe("already-closed");
  expect(f.close(initial,"Make purple").status).toBe("changed");
  const receipt=JSON.parse(readFileSync(join(f.dir,"tracked-decisions.resolved.json"),"utf8")).items[0];
  expect(receipt).toMatchObject({answer:"Keep blue",key:initial.key,fingerprint:initial.fingerprint});
  expect(Number.isFinite(Date.parse(receipt.at))).toBe(true);
  expect(readFileSync(f.path)).toEqual(bytes);expect(f.read().items.map(i=>i.id)).toEqual(["b"]);
  const reload=new TrackedDecisionStore(f.path);expect(reload.read(f.selected,[],{items:[],projects:[]}).items.map(i=>i.id)).toEqual(["b"]);
  f.write([row("a",{recommend:["New proposal"]}),row("b")]);
  const newRow=f.read().items[0];expect(newRow.fingerprint).not.toBe(initial.fingerprint);
  expect(f.close(initial).status).toBe("changed");
  f.selected.clear();expect(f.close(newRow).status).toBe("out-of-scope");
});

test("file and selected external sources compose, with malformed, missing, stale, or duplicate sources failing closed",()=>{
  let entries:unknown[]=[row("adapter",{sessionMatch:match})], broken=false;
  const f=fixture(selected=>{expect(selected.has("p")).toBe(true);if(broken)throw Error("private path");return entries;});
  const initial=f.read().items[0];expect(initial.id).toBe("adapter");expect(f.read().status).toBe("ok");
  f.write([row("local")]);expect(f.read().items.map(i=>i.id)).toEqual(["local","adapter"]);
  entries.push(row("local"));expect(f.read()).toEqual({items:[],status:"invalid"});expect(f.close(initial).status).toBe("unavailable");
  broken=true;expect(f.read()).toEqual({items:[],status:"unavailable"});expect(f.close(initial).status).toBe("unavailable");
  broken=false;entries=[row("adapter",{title:"changed externally"})];expect(f.close(initial).status).toBe("changed");
  writeFileSync(f.path,"{");expect(f.read()).toEqual({items:[],status:"invalid"});
  rmSync(f.path);entries=[];expect(f.read()).toEqual({items:[],status:"absent"});
  f.write([row("a")]);writeFileSync(join(f.dir,"tracked-decisions.resolved.json"),"{");
  expect(f.read()).toEqual({items:[],status:"unavailable"});
});

test("v1 receipts remain readable and retain both answers when the same decision ID is revised",()=>{
  const f=fixture();
  const old=row("a",{title:"First question"});
  f.write([old]);
  const first=f.read().items[0];
  const previous={key:first.key,fingerprint:first.fingerprint,at:"2026-01-01T00:00:00.000Z",answer:"First answer"};
  const path=join(f.dir,"tracked-decisions.resolved.json");
  writeFileSync(path,JSON.stringify({version:1,items:[previous]}));
  expect(f.read().items).toHaveLength(0);
  f.write([{...old,sessionHost:null}]);
  expect(f.read().items).toHaveLength(0);
  f.write([row("a",{title:"Second question"})]);
  const second=f.read().items[0];
  expect(f.close(second,"Second answer").status).toBe("closed");
  const saved=JSON.parse(readFileSync(path,"utf8")).items;
  expect(saved).toHaveLength(2);
  expect(saved[0]).toEqual(previous);
  expect(saved[1]).toMatchObject({key:second.key,fingerprint:second.fingerprint,answer:"Second answer"});
  expect(f.close(second,"Second answer").status).toBe("already-closed");
  f.write([old]);
  expect(f.read().items).toHaveLength(0);
  expect(f.close(first,"A different answer").status).toBe("changed");
  writeFileSync(path,JSON.stringify({version:1,items:[previous,previous]}));
  expect(f.read().status).toBe("unavailable");
});

test("an unavailable source preserves healthy cards and never acknowledges a missing or conflicting decision",()=>{
  let partial=false,conflicting=false;
  const f=fixture(()=>({
    items: partial ? [row("healthy"),...(conflicting?[row("healthy")]:[])] : [row("healthy"),row("lost")],
    partial,
  }));
  const [healthy,lost]=f.read().items;
  expect(f.read().status).toBe("ok");
  partial=true;
  f.write([row("local")]);
  const result=trackedDecisionViewSchema.parse(f.read());
  expect(result.status).toBe("partial");
  expect(result.items.map(i=>i.id)).toEqual(["local","healthy"]);
  expect(f.close(lost).status).toBe("unavailable");
  expect(f.close(healthy).status).toBe("closed");
  expect(f.close(healthy).status).toBe("already-closed");
  conflicting=true;
  expect(f.read().status).toBe("invalid");
  expect(f.close(healthy).status).toBe("unavailable");
});

test("only resolution, queued cancellation and receipt-photo reads are exposed and failed scope checks cannot acknowledge content",async()=>{
  const f=fixture();f.write([row("a",{ask:["Deploy it"]})]);const item=f.read().items[0];
  const map=new Map(),calls:string[]=[];let changes=0;
  f.service.register({handle:(def,fn)=>{map.set(def.name,fn);calls.push(def.name);}},()=>f.selected,()=>changes++);
  expect(calls.sort()).toEqual([resolveTrackedDecision.name,readReplyPhoto.name,cancelQueuedReply.name].sort());
  const input={source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint};
  expect(resolveTrackedDecision.input.safeParse({...input,answer:"x".repeat(4001)}).success).toBe(false);
  f.selected.clear();expect((await map.get(resolveTrackedDecision.name)(input,{})).status).toBe("out-of-scope");expect(changes).toBe(0);
  f.selected.add("p");expect((await map.get(resolveTrackedDecision.name)(input,{})).status).toBe("closed");expect(changes).toBe(1);
});

test("tracked reply reaches the chosen recipient once and records the exact visible answer",async()=>{
  const f=fixture();f.write([row("editorial",{where:"manager"}),row("other")]);
  const first=f.read().items[0];
  const input={source:first.source,projectId:first.projectId,id:first.id,fingerprint:first.fingerprint,recipientId:"coordinator",answer:"Publish on Tuesday"};
  let sends=0;
  const prepare=async()=>({ready:true,stillCurrent:()=>true,accepted:async()=>false,send:async(text:string)=>{
    expect(text).toContain(first.id);expect(text).toContain(first.fingerprint);expect(text.endsWith(input.answer)).toBe(true);sends++;expect(f.close(f.read().items.find(r=>r.id==="other")!).status).toBe("closed");
  }});
  expect((await f.service.deliver(input,()=>f.selected,prepare)).status).toBe("sent");
  expect((await f.service.deliver(input,()=>f.selected,prepare)).status).toBe("sent");
  expect((await f.service.deliver({...input,answer:"A different decision"},()=>f.selected,prepare)).status).toBe("changed");
  expect(sends).toBe(1); expect(f.read().items).toHaveLength(0);
});

test("busy, rotated and uncertain recipients keep the card; a retry checks receipt before closing",async()=>{
  const f=fixture();f.write([row("one",{where:"session",sessionId:"s"})]);
  const first=f.read().items[0];
  const input={source:first.source,projectId:first.projectId,id:first.id,fingerprint:first.fingerprint,recipientId:"s",answer:"Use B"};
  let sends=0, confirmed=false;
  const target={ready:false,stillCurrent:()=>true,accepted:async()=>confirmed,send:async()=>{sends++;throw Error("Lost reply");}};
  const send=()=>f.service.deliver(input,()=>f.selected,async()=>target);
  expect((await send()).status).toBe("queued");
  expect((await f.service.deliver(input,()=>f.selected,async()=>null)).status).toBe("changed");
  target.ready=true;
  await f.service.resumeQueued(()=>f.selected,async()=>target);
  expect((await send()).status).toBe("unconfirmed");
  expect((await send()).status).toBe("unconfirmed");
  expect(f.close(first).status).toBe("unconfirmed");expect(f.read().items).toHaveLength(1);
  confirmed=true;expect((await send()).status).toBe("sent");expect(sends).toBe(1);
});

test("record routing follows explicit host and project membership",()=>{
  const f=fixture();f.write([row("one",{where:"session",sessionId:"s"})]);const [item]=f.read().items;
  expect(trackedRecipient(item,"coord",[s])).toBe("s");
  expect(trackedRecipient({...item,sessionHost:"other"},"coord",[s])).toBeNull();
  expect(trackedRecipient({...item,projectId:"other"},"coord",[s])).toBeNull();
  expect(trackedRecipient({...item,where:"manager"},"coord",[s])).toBe("coord");
  expect(trackedRecipient({...item,where:"unknown"},"coord",[s])).toBeNull();
});

test("a v1 host-wide delivery stays visible after restart and export removal without becoming a new decision", () => {
  const f = fixture();
  f.write([row("device-login",{projectId:null,title:"Sign in on the studio device",where:"human"})]);
  const [original] = f.read().items;
  const messageId="3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const at="2026-11-22T06:45:25.444Z";
  writeFileSync(join(f.dir,"tracked-decisions.resolved.json"),JSON.stringify({version:1,items:[
    {key:original.key,fingerprint:original.fingerprint,at,answer:"Signed in",recipientId:"coord",messageId,pending:false},
  ]}));
  expect(f.read().items).toHaveLength(0);
  expect(f.read().history).toMatchObject([{projectId:null,title:original.title,answer:"Signed in",status:"sent",coordinator:true,at}]);
  const evidence=new Map([["coord",{id:"e",turns:[],replies:new Map([[messageId,"Access verified"]])}]]);
  expect(f.service.read(f.selected,[],{items:[],projects:[]},evidence).history?.[0].response).toBe("Access verified");
  rmSync(f.path);
  const restarted=new TrackedDecisionStore(f.path);
  expect(restarted.read(f.selected,[],{items:[],projects:[]}).history).toMatchObject([{title:original.title,at,response:"Access verified"}]);
  expect(restarted.read(new Set(),[],{items:[],projects:[]}).history).toBeUndefined();
});

test("local-only and no-answer resolutions remain distinct and scoped to their project",()=>{
  const f=fixture();f.write([row("first"),row("second")]);
  const [first,second]=f.read().items;
  expect(f.close(first,"Keep it").status).toBe("closed");
  expect(f.close(second).status).toBe("closed");
  expect(f.read().history?.map(x=>x.status)).toEqual(["recorded","closed"]);
  f.selected.clear();f.selected.add("unrelated");
  expect(f.read().history).toBeUndefined();
});

test("merge follow-up choices carry only their own answers, including after the PR leaves the review list",()=>{
  const f=fixture();
  const url="https://github.com/demo/repo/pull/42";
  const merge = row("merge",{kind:"merge", ask:[url+" 보안 게이트 통과 뒤 병합할까요?"], recommend:["병합, Q1 A"],
    howToAnswer:"42 병합해, Q1 A", questions:[{id:"Q1",text:"글 작성 시점",options:[{key:"A",text:"첫 실행",recommended:true}]}]});
  f.write([merge]);
  const [item]=f.read([],[]).items;
  expect(item.matchedPull).toBeNull();
  expect(trackedPullTarget(item)).toEqual(target);
  expect(mentionsSecurityGate(item)).toBe(true);
  expect(suggestedTrackedReply(item)).toBe("");
  expect(suggestedTrackedReply({...item,questions:[]})).toBe("");
  expect(trackedAnswerText(item, ["A · 첫 실행"], "")).toBe("Q1 · 글 작성 시점 — A · 첫 실행");
  expect(trackedAnswerText(item, [""], "")).toBe("");
  expect(suggestedTrackedReply({...item,kind:"check",questions:[],howToAnswer:"Reviewed"})).toBe("Reviewed");
  for (const ask of [[url+" "+url+"/extra "+url+"0"],["https://github.com.evil.invalid/demo/repo/pull/42"],
    [url+"?sensitive=value"],["https://github.com/demo/../pull/42"]]) {
    expect(trackedPullTarget({...item,ask})).toBeNull();
  }
  expect(trackedPullTarget({...item,ask:[url+" "+url],kind:"answer"})).toBeNull();
  expect(trackedPullTarget({...item,ask:[url+"0"],mergeTarget:target})).toEqual(target);
});

test("two older Q3 cards forwarded to one coordinator keep their own source sessions, questions and versions",async()=>{
  const f=fixture();
  const createCard=(id:string,sessionId:string,question:string)=>row(id,{
    projectTitle:"Video editor",sessionId,where:"manager",title:"Choose a clip boundary",
    questions:[{id:"Q1",text:"Separate unanswered question"},{id:"Q3",text:question}],since:"2026-11-12T10:00:00Z",
  });
  const records=[createCard("end-padding","original-worker-a","Time after a sentence?"),
    createCard("start-padding","original-worker-b","Time before a sentence?")];
  f.write(records);
  const [first,second]=f.read().items;
  const answer="0.10 seconds";
  const inputFor=item=>({source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint,
    recipientId:"coordinator",questionIndexes:[1],answer});
  const sent:string[]=[];
  const target={ready:true,stillCurrent:()=>true,accepted:async()=>false,send:async(body:string)=>{sent.push(body);}};
  // A decision changes after the click and while the recipient is being resolved.
  const stale=await f.service.deliver(inputFor(first),()=>f.selected,async()=>{
    f.write([{...records[0],questions:[{id:"Q3",text:"A completely different question?"}]},records[1]]);
    return target;
  });
  expect(stale.status).toBe("changed");expect(sent).toHaveLength(0);
  f.write(records);
  for(const [index,item] of [first,second].entries()) {
    expect((await f.service.deliver(inputFor(item),()=>f.selected,async()=>target)).status).toBe("sent");
    const body=sent[index];
    const [header,metadata,blank,...raw] = body.split("\n");
    expect(header).toContain("Coordinator Board");
    expect(JSON.parse(metadata)).toMatchObject({
      cardId:item.id,revision:item.fingerprint,source:item.source,projectId:item.projectId,projectTitle:item.projectTitle,
      sourceSessionId:item.sessionId,recipientSessionId:"coordinator",
      questions:[{id:"Q3",text:item.questions[1].text}],
    });
    expect(blank).toBe("");
    expect(raw.join("\n")).toBe(answer);
    expect(body).not.toContain(records[1-index].sessionId);
  }
  expect(f.read().history?.map(r=>r.answer)).toEqual([answer,answer]);
});

const replyPhoto={mimeType:"image/png" as const,data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYvLAHAAOLAcF4E9p3AAAAAElFTkSuQmCC"};
const otherPhoto={mimeType:"image/webp" as const,data:"UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD+67eowmknPaRBAAAA"};

test("tracked photo-only replies keep recipient-scoped previews and recover the original delivery on retry",async()=>{
  const f=fixture();
  f.write([row("photo-check",{sessionId:"photo-worker",where:"manager",title:"Which camera frame?"})]);
  const [item]=f.read().items;
  const input={source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint,recipientId:"coordinator",images:[replyPhoto]};
  expect(resolveTrackedDecision.input.safeParse(input).success).toBe(true);
  const calls=[];
  const target={ready:true,stillCurrent:()=>true,
    send:async(body,messageId,images)=>{calls.push({body,messageId,images});throw Error("Uncertain delivery");},
    accepted:async(body,messageId)=>calls.some(call=>call.body===body && call.messageId===messageId),
  };
  const attempt=(request=input)=>f.service.deliver(request,()=>f.selected,async()=>target);
  expect((await attempt()).status).toBe("unconfirmed");
  const receipt=readFileSync(join(f.dir,"tracked-decisions.resolved.json"),"utf8");
  expect(receipt).not.toContain(replyPhoto.data);
  expect(calls).toHaveLength(1);
  expect(calls[0].images).toEqual([replyPhoto]);
  expect(isBoardPhotoMessage(calls[0].messageId)).toBe(true);
  const previews = new SessionPhotoStore(join(f.dir,"session-photos"));
  expect(previews.read("coordinator",calls[0].messageId,0)).toEqual({count:1,image:replyPhoto});
  expect(previews.read("photo-worker",calls[0].messageId,0).count).toBe(0);
  expect(calls[0].body).toContain("Which camera frame?");
  expect((await attempt({...input,images:[otherPhoto]})).status).toBe("changed");
  expect((await attempt()).status).toBe("sent");
  expect(calls).toHaveLength(1);
  expect(f.read().history?.[0]).toMatchObject({status:"sent",imageCount:1});
});

test("a pending receipt written by an older board is acknowledged using the original plain answer",async()=>{
  const f=fixture();
  f.write([row("legacy",{where:"manager"})]);
  const [card]=f.read().items;
  const input={source:card.source,projectId:card.projectId,id:card.id,fingerprint:card.fingerprint,recipientId:"coordinator",answer:"Keep the existing value"};
  const messageId="c96bfed2-f9ef-41ff-aca6-9f8b138a141f";
  writeFileSync(join(f.dir,"tracked-decisions.resolved.json"),JSON.stringify({version:1,items:[{
    key:card.key,fingerprint:card.fingerprint,recipientId:input.recipientId,answer:input.answer,
    at:"2026-11-21T05:00:00.000Z",messageId,pending:true,
  }]}));
  let sends=0;
  const target={ready:true,stillCurrent:()=>true,send:async()=>{sends++;},
    accepted:async(body,id)=>body===input.answer && id===messageId};
  expect((await f.service.deliver(input,()=>f.selected,async()=>target)).status).toBe("sent");
  expect(sends).toBe(0);
  expect(f.read().history?.[0]).toMatchObject({status:"sent",answer:input.answer});
});

test("an image attached to a local decision is retrievable only inside the project that recorded it",async()=>{
  const f=fixture();
  f.write([row("offline-card",{title:"Save a screenshot",where:"unknown"})]);
  const [item]=f.read().items;
  const handlers=new Map();
  f.service.register({handle:(contract,handler)=>handlers.set(contract.name,handler)},()=>f.selected);
  const local=resolveTrackedDecision.input.parse({
    source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint,images:[replyPhoto],
  });
  expect(await handlers.get(resolveTrackedDecision.name)(local,{})).toEqual({status:"closed"});
  const history=f.read().history?.[0];
  expect(history).toMatchObject({status:"recorded",imageCount:1,localPhotos:true});
  const handler=handlers.get(readReplyPhoto.name);
  expect(handler).toBeTypeOf("function");
  expect(await handler({key:history.key,index:0},{})).toEqual({image:replyPhoto});
  expect(await handler({key:history.key,index:1},{})).toEqual({image:null});
  f.selected.clear();f.selected.add("other-project");
  expect(await handler({key:history.key,index:0},{})).toEqual({image:null});
  expect(await handler({key:"../../anywhere",index:0},{})).toEqual({image:null});
});

test("first-open titles show only unresolved decisions in the selected scope",()=>{
  const f=fixture();
  f.write([row("done"), row("hidden",{projectId:"other"}), row("global",{projectId:null,title:"Shared",urgency:"now"}), ...[1,2,3,4].map(i=>row(String(i),{title:"Visible "+i}))]);
  expect(f.close(f.read().items[0]).status).toBe("closed");
  expect(f.service.previewTitles(f.selected)).toEqual(["Shared","Visible 1","Visible 2"]);
  expect(f.service.previewTitles(new Set())).toEqual([]);
  writeFileSync(join(f.dir,"tracked-decisions.resolved.json"),"{");
  expect(f.service.previewTitles(f.selected)).toEqual([]);
});

test("first-open titles rank all eligible decisions before limiting the preview to three", () => {
  const f = fixture();
  f.write([
    row("later", { title: "Later" }),
    row("week", { title: "This week", urgency: "week" }),
    row("today", { title: "Today", urgency: "today" }),
    row("now", { title: "Urgent", urgency: "now" }),
    row("blocked", { title: "Release waiting", blocksWork: true }),
  ]);
  expect(f.service.previewTitles(f.selected)).toEqual(["Urgent", "Release waiting", "Today"]);
});

test("changing display-only priority metadata preserves the original answer receipt", () => {
  const f=fixture();
  const original=row("schedule");
  f.write([original]);
  const card=f.read().items[0];
  expect(f.close(card,"Done").status).toBe("closed");
  f.write([{...original,dueAt:"2026-11-23",blocksWork:true}]);
  expect(f.read().items).toEqual([]);
});

test("legacy history recovers a source only from the originally answered revision and keeps it after the feed disappears",()=>{
  const f=fixture();
  const source = row("same",{sessionId:"original",sessionHost:"laptop",questions:[{id:"Q1",text:"Which one?"}]});
  f.write([source,row("changed",{sessionId:"before"})]);
  const original=f.read().items;
  writeFileSync(join(f.dir,"tracked-decisions.resolved.json"),JSON.stringify({version:1,items:original.map(item=>({
    key:item.key,fingerprint:item.fingerprint,at:"2026-11-20T10:00:00.000Z",answer:"Confirmed",
  }))}));
  f.write([source,row("changed",{sessionId:"after"})]);
  const history=f.read().history!;
  expect(history[0]).toMatchObject({status:"recorded",origin:{sessionId:"original",sessionHost:"laptop",questions:[]}});
  expect(history[0].recipientId).toBeUndefined();
  expect(history[1].origin).toBeUndefined();
  expect(f.service.resolve({...original[0],answer:"Confirmed",questionIndexes:[0]},()=>f.selected)).toEqual({status:"already-closed"});
  f.write([]);
  expect(f.read().history?.[0].origin?.sessionId).toBe("original");
});

test("two queued card replies survive a restart with their original photos, recipients and questions",async()=>{
  const f=fixture();
  f.write(["left","right"].map(id=>row(id,{where:"manager",questions:[{id:"Q3",text:"Which version?"}]})));
  const requests=f.read().items.map(item=>({source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint,
    recipientId:"coord",questionIndexes:[0],answer:item.id,images:[replyPhoto]}));
  const calls:{id:string;body:string;images:unknown}[]=[];
  let ready=false;
  const prepare=async()=>({ready,stillCurrent:()=>true,accepted:async()=>false,
    send:async(body:string,id:string,images:unknown)=>{calls.push({id,body,images});}});
  const results=await Promise.all(requests.map(request=>f.service.deliver(request,()=>f.selected,prepare)));
  expect(results.map(r=>r.status)).toEqual(["queued","queued"]);
  expect(f.read().history ?? []).toHaveLength(0);
  expect(f.read().items.map(i=>i.queuedReply?.answer)).toEqual(["left","right"]);
  const restarted=new TrackedDecisionStore(f.path);
  const resume=()=>restarted.resumeQueued(()=>f.selected,prepare,"coord");
  await resume();expect(calls).toHaveLength(0);
  ready=true;
  await Promise.all([resume(),resume()]);await resume();
  expect(calls.map(call=>JSON.parse(call.body.split("\n")[1]).cardId)).toEqual(["left","right"]);
  expect(calls.every(call=>JSON.parse(call.body.split("\n")[1]).questions[0].id==="Q3")).toBe(true);
  expect(calls.map(c=>c.images)).toEqual([[replyPhoto],[replyPhoto]]);
  expect(new Set(calls.map(c=>c.id)).size).toBe(2);
  expect(f.read().history?.map(r=>r.status)).toEqual(["sent","sent"]);
});

test("cancel a reservation during recovery without resurrecting it or canceling a replacement",async()=>{
  const f=fixture();f.write([row("one",{where:"manager"})]);
  const [item]=f.read().items;
  const input={source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint,recipientId:"c",answer:"Original"};
  let calls=0;
  const target={ready:false,stillCurrent:()=>true,accepted:async()=>false,send:async()=>{calls++;}};
  expect((await f.service.deliver(input,()=>f.selected,async()=>target)).status).toBe("queued");
  const waiting=f.read().items[0].queuedReply!;
  const cancel={...input,messageId:waiting.messageId};
  expect(f.service.cancelQueued(cancel,new Set(["other"]))).toBe(false);
  expect(f.close(item).status).toBe("unconfirmed");
  const resume=f.service.resumeQueued(()=>f.selected,async()=>{
    expect(f.service.cancelQueued(cancel,f.selected)).toBe(true);
    await f.service.deliver({...input,answer:"Updated"},()=>f.selected,async()=>target);
    return {...target,ready:true};
  });
  await resume;
  expect(calls).toBe(0);
  expect(f.service.cancelQueued(cancel,f.selected)).toBe(false);
  expect(f.read().items[0].queuedReply?.answer).toBe("Updated");
});

test("a queued reply never follows a changed card, new ledger owner or withdrawn project",async()=>{
  for(const change of ["revision","owner","scope"]) {
    let owner="old";
    let card=row("one",{where:"manager"});
    const f=fixture(()=>[{...card,sourceCoordinatorId:owner}]);const [item]=f.read().items;
    const input={source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint,recipientId:owner,answer:"Original"};
    const calls:string[]=[];
    const target={ready:false,stillCurrent:()=>true,accepted:async()=>false,send:async(body:string)=>{calls.push(body);}};
    expect((await f.service.deliver(input,()=>f.selected,async()=>target)).status).toBe("queued");
    if(change==="revision") card={...card,title:"Updated question"};
    if(change==="owner") owner="new";
    if(change==="scope") f.selected.clear();
    await f.service.resumeQueued(()=>f.selected,async()=>({...target,ready:true}));
    f.selected.add("p");
    expect(calls).toHaveLength(0);
    expect(f.read().history?.[0].status).toBe("unsent");
    expect(f.service.hasWaitingReplies()).toBe(false);
  }
});

test("snapshot delivery evidence settles a lost acknowledgement only for the same recipient, ID and body",async()=>{
  const f=fixture();f.write([row("uncertain",{where:"manager"})]);const item=f.read().items[0];
  const input={source:item.source,id:item.id,projectId:item.projectId,fingerprint:item.fingerprint,recipientId:"coord",answer:"Yes"};
  let id="",body="";
  const target={ready:true,stillCurrent:()=>true,accepted:async()=>false,send:async(text:string,messageId:string)=>{
    body=text;id=messageId;throw Error("Lost acknowledgement");
  }};
  expect((await f.service.deliver(input,()=>f.selected,async()=>target)).status).toBe("unconfirmed");
  const {createHash}=await import("node:crypto");
  const evidence=(recipient:string,text:string)=>new Map([[recipient,{id:"e",turns:[],boardMessageHashes:new Map([[id,createHash("sha256").update(text).digest("hex")]])}]]);
  for(const [recipient,text] of [["other",body],["coord","Yes"]]) {
    expect(f.service.read(f.selected,[],{items:[],projects:[]},evidence(recipient,text)).history?.[0].status).toBe("pending");
  }
  expect(f.service.read(f.selected,[],{items:[],projects:[]},evidence("coord",body)).history?.[0].status).toBe("sent");
  expect(f.read().items).toHaveLength(0);
});
