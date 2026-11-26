// Ported from paseo-coordinator-board test/board-facts.test.ts @ 2e9d128 onto a fake Orca behind the real
// Fleet. Assertions are Paseo's. What differs is the transport: a session's state, turns and permissions
// are Orca's, a fact goes to a chat as mail signed by the coordinator's terminal and to a terminal as typed
// input under the board header naming the coordinator (both stand in for Paseo's sourceAgentId), and
// what was sent is read from the outbox and the recipient's transcript. Message ids are UUIDs because
// the board's marker carries one.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCli } from "../orca/cli";
import { readMarked } from "../orca/conversation";
import { stamp } from "../orca/deliver";
import { fakeOrca } from "../orca/fixtures/fake-orca";
import { createFleet } from "../orca";
import { BoardFacts } from "./board-facts";
import { ConversationReader } from "./conversation";
import { discoverSessions } from "./discovery";
import { NoteStore } from "../paseo/server/notes";
import { PreferenceStore } from "../paseo/server/preferences";
import { managedSessions } from "./session-links";
import { decorateDecision } from "./decisions";
import { projectCards } from "../paseo/client/model";

const dirs: string[] = [];
afterEach(()=>{for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true});});
const question = "이 작업은 어느 프로젝트 소속인가요?";
const DIGEST = "d1d1d1d1-0000-4000-8000-000000000001";
const uuid = (n: number) => "e0e0e0e0-0000-4000-8000-" + String(n).padStart(12, "0");
/** Mail as Orca frames it in the recipient's transcript. */
const mail = (handle: string, body: string) => ["──── From: " + handle.toUpperCase() + " (" + handle + ") (status) ────", "Subject: s", body,
  "[Reply: orca orchestration reply --id msg_1 --body \"...\"]", "─".repeat(60)].join("\n");

function fixture(initial=question, surface: "chat"|"terminal"="chat") {
  const dir=mkdtempSync(join(tmpdir(),"board-fact-test-")); dirs.push(dir);
  const store=new PreferenceStore(join(dir,"scope.json")), notes=new NoteStore(join(dir,"notes.json")), reader=new ConversationReader();
  store.change(s => {s.projects=["managed"];s.coordinator="coord";s.sessionLinks.worker={sessionId:"worker",sourceProjectId:"source",targetProjectId:"managed",targetProjectTitle:"Managed",sourceProjectTitle:"Source",workspaceTitle:"Original",title:"Worker"};});
  let now=Date.now();
  const orca=fakeOrca([
    {id:"coord",surface:"terminal",state:"done",updatedAt:1,handle:"term_coord",project:"managed"},
    {id:"worker",surface,state:"done",updatedAt:1,project:"source",...(surface==="terminal"?{handle:"term_worker"}:{})},
    {id:"other",surface:"terminal",state:"done",updatedAt:1,handle:"term_other",project:"elsewhere"},
  ]);
  orca.say("worker","assistant",initial);
  orca.say("coord","user",stamp("new digest",DIGEST));
  const fleet=createFleet(createCli(orca.runner),Date.now,{dataDir:dir,sleep:async()=>{},mailSender:async()=>"term_board"});
  const facts=new BoardFacts(store,notes,reader,fleet,()=>now);
  const sdk=fleet.paseo;
  /** Every fact the board tried to send, with the terminal that signed it. */
  const events=()=>{
    let records: Record<string,{to:string;messageId:string;text:string}> = {};
    try { records=JSON.parse(readFileSync(join(dir,"outbox.json"),"utf8")).records; } catch { /* nothing sent yet */ }
    const signers=orca.writes.filter(w=>w[0]==="orchestration").map(w=>w[w.indexOf("--from")+1]);
    return Object.values(records).map((r,i)=>({id:r.to,messageId:r.messageId,text:readMarked(r.text)!.body,from:signers[i]}));
  };
  const snapshot=async()=>{
    fleet.invalidate();
    const scope=store.read(),rows=managedSessions(await discoverSessions(sdk),scope);
    const e=await reader.decorate(sdk,rows,scope);
    const n=notes.visible(new Set(rows.map(r=>r.id)));
    facts.decorate(rows,e,n);
    for(const row of rows)decorateDecision(row,n[row.id],store.read());
    const cards=projectCards({sessions:rows,notes:n,projects:[],coordinator:"coord"});
    return {w:rows.find(r=>r.id==="worker")!,cards};
  };
  const seed=async(key="digest-1")=>{
    fleet.invalidate();
    const token=await facts.prepareCycle(sdk,"coord",key);
    if(token)facts.bindMessage("coord",token,DIGEST);
    return token;
  };
  const reply=(cycleId:string|null,evidenceId:string|undefined,caller="coord",factService=facts)=>{
    fleet.invalidate();
    return factService.tool.execute({cycleId,evidenceId,sessionId:"worker"} as never,{paseo:sdk,agent:{id:caller}});
  };
  return {store,notes,reader,orca,events,facts,fleet,sdk,snapshot,seed,reply,tick:(ms:number)=>{now+=ms}};
}
test("cached snapshots resolve exact questions and keep durable evidence without prompting or changing workspace",async()=>{
  for(const [q,kind] of [[question,"project"],["이 세션은 어느 프로젝트에 속해 있나요?","project"],["이 세션이 관리 프로젝트에 연결되어 있나요?","managed"],["What is the current status of this session?","status"],["상태 공유입니다. 요청할 결정은 없습니다.","report"]]){
    const f=fixture(q);
    const {w,cards}=await f.snapshot();
    expect(w.boardFact).toMatchObject({kind,current:true,sourceProjectId:"source",projectId:"managed",recipientId:"worker",delivery:"recorded"});
    expect(w.boardFact!.evidenceId).toBe(w.evidenceId);expect(cards.human).toHaveLength(0);
    expect((await f.snapshot()).w.boardFact).toEqual(w.boardFact);
    expect(Object.keys(f.store.read().factHistory)).toHaveLength(1);expect(f.events()).toHaveLength(0);
    if(kind==="report")expect(await f.seed()).toBeNull();
  }
});
test("mixed questions, quotations, truncated messages, authority and preferences never generate machine replies",async()=>{
  for(const q of [question+" 병합해도 될까요?","이 세션의 현재 상태는 무엇인가요?\n폴더 삭제를 승인해 주세요.","고객에게 공개할까요?","예산을 추가할까요?","> "+question,"계획을 승인해 주세요.","성공했습니다. 복구를 진행할까요?", "Use model X or Y?", "x".repeat(2020)+" ".repeat(2100)+question]){
    const f=fixture(q);expect((await f.snapshot()).w.boardFact).toBeUndefined();expect(await f.seed()).toBeNull();expect(f.events()).toHaveLength(0);
  }
  const f=fixture();f.orca.find("worker")!.state="blocked";
  expect((await f.snapshot()).w.decision!.source).toBe("permission");expect(await f.seed()).toBeNull();
  f.orca.find("worker")!.state="done";
  f.notes.update({sessionId:"worker",kind:"question",text:"Choose the product name",expectedRevision:0});
  expect((await f.snapshot()).w.boardFact).toBeUndefined();expect(await f.seed()).toBeNull();
});
test("only one sourced fact reply is sent for the current digest, session and evidence; rereads never resend",async()=>{
  const f=fixture();const {w}=await f.snapshot();const token=await f.seed();
  expect(await f.seed()).toBe(token);
  await expect(f.reply(token,w.evidenceId,"worker")).rejects.toThrow();
  await expect(f.reply(token,"wrong-evidence")).rejects.toThrow();
  await Promise.all([f.reply(token,w.evidenceId),f.reply(token,w.evidenceId)]);
  expect(f.events()).toHaveLength(1);expect(f.events()[0]).toMatchObject({id:"worker",from:"term_coord"});
  expect(JSON.parse(f.events()[0].text)).toMatchObject({type:"coordinator-board.fact",authority:"information-only",evidenceId:w.evidenceId});
  expect((await f.snapshot()).w.boardFact).toMatchObject({senderId:"coord",messageId:f.events()[0].messageId,delivery:"sent"});
  const restarted=new BoardFacts(f.store,f.notes,new ConversationReader(),f.fleet);
  await f.reply(token,w.evidenceId,"coord",restarted);expect(f.events()).toHaveLength(1);
  f.orca.say("worker","assistant","다음 PR 병합을 승인해 주세요.");
  const next=await f.snapshot();expect(next.w.boardFact!.current).toBe(false);expect(next.cards.human.map(c=>c.session.id)).toEqual(["worker"]);
});
test("expiry, read-only or newer requests, scope changes, later human responses and opt-out cancel sends",async()=>{
  for(const change of ["expire","recommend","unlinked","permission","later","disable","rotation","during"]){
    const f=fixture();const {w}=await f.snapshot();const token=await f.seed();
    if(change==="expire")f.tick(11*60000);
    if(change==="recommend")f.orca.say("coord","user",stamp("recommend only",uuid(9)));
    if(change==="unlinked")f.store.change(s=>{delete s.sessionLinks.worker});
    if(change==="permission") f.orca.find("worker")!.state="blocked";
    if(change==="later")f.orca.say("worker","user","I will decide");
    if(change==="disable")f.store.change(s=>{s.autoReplyToBoardFacts=false});
    if(change==="rotation")f.store.change(s=>{s.coordinator="worker"});
    if(change==="during")f.orca.behavior.beforePs=()=>f.store.change(s=>{s.autoReplyToBoardFacts=false});
    await expect(f.reply(token,w.evidenceId)).rejects.toThrow();expect(f.events()).toHaveLength(0);
    if(change==="expire")expect(await f.seed()).toBeNull();
  }
});
test("missing provenance/unknown receipt has no unsigned fallback, and a new digest does not duplicate it",async()=>{
  const f=fixture();const {w}=await f.snapshot();const token=await f.seed();f.orca.behavior.loseAnswer=true;f.orca.behavior.dropText=true;
  await expect(f.reply(token,w.evidenceId)).rejects.toThrow(/unsigned/);
  expect((await f.snapshot()).w.boardFact!.delivery).toBe("unconfirmed");
  f.orca.behavior.loseAnswer=false;f.orca.behavior.dropText=false;
  await expect(f.reply(token,w.evidenceId)).rejects.toThrow(/unconfirmed/);
  const next=await f.seed("next");
  if(next)await expect(f.reply(next,w.evidenceId)).rejects.toThrow(/unconfirmed/);
  expect(f.events()).toHaveLength(1);expect(f.events()[0].from).toBe("term_coord");
});
test("a coordinator whose terminal cannot sign mail sends nothing unsigned, and the fact stays answerable",async()=>{
  const f=fixture();const {w}=await f.snapshot();const token=await f.seed();
  f.orca.find("coord")!.livePty=false;
  await expect(f.reply(token,w.evidenceId)).rejects.toThrow(/unsigned/);
  expect(f.orca.writes).toEqual([]);
  expect((await f.snapshot()).w.boardFact!.delivery).toBe("recorded");
  f.orca.find("coord")!.livePty=true;
  await f.reply(token,w.evidenceId);
  expect(f.events()).toHaveLength(1);
});
test("a later agent or scheduled input prevents attributing a new turn to the human digest",async()=>{
  for(const who of ["coord","worker"]) {
    const f=fixture();
    const {w}=await f.snapshot(),token=await f.seed();
    f.orca.say(who,"user",mail("term_other","a separate request"));
    await expect(f.reply(token,w.evidenceId)).rejects.toThrow();
    expect(f.events()).toHaveLength(0);
  }
});

test("a lost receipt is reconciled only from the recipient's transcript with matching ID, sender and body",async()=>{
  const f=fixture();const {w}=await f.snapshot(),token=await f.seed();
  f.orca.behavior.loseAnswer=true;f.orca.behavior.dropText=true;
  await expect(f.reply(token,w.evidenceId)).rejects.toThrow();
  const sent=f.events()[0];
  const receipt=mail("term_coord",stamp(sent.text,sent.messageId));
  for(const invalid of [mail("term_coord",stamp(sent.text,uuid(7))),
      mail("term_other",stamp(sent.text,sent.messageId)),
      mail("term_coord",stamp("edited answer",sent.messageId)),
      stamp(sent.text,sent.messageId)]) {
    f.orca.say("worker","user",invalid);
    expect((await f.snapshot()).w.boardFact!.delivery).toBe("unconfirmed");
  }
  f.orca.say("worker","user",receipt);
  expect((await f.snapshot()).w.boardFact).toMatchObject({current:false,delivery:"sent"});
  expect(f.events()).toHaveLength(1);
});

test("a terminal worker gets the fact typed under the coordinator's header, without needing the coordinator's terminal",async()=>{
  const f=fixture(question,"terminal");const {w}=await f.snapshot();const token=await f.seed();
  f.orca.find("coord")!.livePty=false;
  await f.reply(token,w.evidenceId);
  expect(f.orca.writes.map(x=>x.slice(0,4))).toEqual([["terminal","send","--terminal","term_worker"]]);
  const [header,body]=f.events()[0].text.split("\n");
  expect(JSON.parse(header.replace("[coordinator-board] ",""))).toEqual({from:"coord",subject:"Coordinator Board fact"});
  expect(JSON.parse(body)).toMatchObject({type:"coordinator-board.fact",authority:"information-only",evidenceId:w.evidenceId});
  expect((await f.snapshot()).w.boardFact).toMatchObject({senderId:"coord",messageId:f.events()[0].messageId,delivery:"sent"});
  await f.reply(token,w.evidenceId);expect(f.orca.writes).toHaveLength(1);
});

test("a typed fact whose answer was lost is reconciled from the terminal transcript by ID, sender and body, never typed again",async()=>{
  const f=fixture(question,"terminal");const {w}=await f.snapshot(),token=await f.seed();
  f.orca.behavior.loseAnswer=true;f.orca.behavior.dropText=true;
  await expect(f.reply(token,w.evidenceId)).rejects.toThrow(/unsigned/);
  expect((await f.snapshot()).w.boardFact!.delivery).toBe("unconfirmed");
  const sent=f.events()[0];
  const packet=sent.text.split("\n").slice(1).join("\n");
  for(const invalid of [stamp(packet,sent.messageId),stamp(sent.text.replace('"coord"','"other"'),sent.messageId),stamp(sent.text,uuid(7))]) {
    f.orca.say("worker","user",invalid);
    expect((await f.snapshot()).w.boardFact!.delivery).toBe("unconfirmed");
  }
  f.orca.say("worker","user",stamp(sent.text,sent.messageId));
  expect((await f.snapshot()).w.boardFact).toMatchObject({current:false,delivery:"sent"});
  f.orca.behavior.loseAnswer=false;f.orca.behavior.dropText=false;
  expect(f.orca.writes).toHaveLength(1);
});
