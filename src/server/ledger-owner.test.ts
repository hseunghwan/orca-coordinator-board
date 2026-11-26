// Ported from paseo-coordinator-board test/ledger-owner.test.ts @ 2e9d128 onto a fake Orca behind the real
// Fleet and the board's contribute(). Assertions are Paseo's. A Paseo refresh hook is a hook on each
// Orca state read, a lost receipt is an answer Orca lost for a text that never landed, and a session
// moving out of scope moves to another Orca project.
// @ts-nocheck: typed as loosely as upstream.
import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCli } from "../orca/cli";
import { fakeOrca } from "../orca/fixtures/fake-orca";
import { createFleet } from "../orca";
import { contribute } from "./board";
import { rpcServer } from "./rpc";
import { boardSnapshot, boardScope } from "../paseo/shared/contract";
import { askClarification, clarificationRecipient, trackedClarificationCard } from "../paseo/shared/clarifications";
import { trackedRecipient, resolveTrackedDecision } from "../paseo/shared/tracked-decisions";

const scratch:string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path,{recursive:true,force:true}); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(),"ledger-owner-")); scratch.push(root);
  const data = join(root,"plugin-data","coordinator-board"), ledger = join(root,"ledger");
  mkdirSync(data,{recursive:true}); mkdirSync(ledger);
  const ownerPath = join(root,"manager.json");
  const configure = (coordinatorFile?:string) => writeFileSync(join(data,"tracked-sources.json"),JSON.stringify({
    version:1,sources:[{source:"production",directory:ledger,projectId:"studio",projectTitle:"Studio",coordinatorFile}],
  }));
  const owner = (id:string) => writeFileSync(ownerPath,JSON.stringify({agentId:id}));
  const orca = fakeOrca([...["general","operator","next","source"].map(id => ({id,surface:"terminal",state:"done",updatedAt:1,title:id,handle:"term_"+id,project:"studio"})),
    {id:"outside",surface:"terminal",state:"done",updatedAt:1,title:"outside",handle:"term_outside",project:"private"}]);
  const project = { set: (id:string,to:string) => { orca.find(id).project = to; } };
  configure(ownerPath); owner("operator");
  writeFileSync(join(ledger,"decisions.json"),JSON.stringify({items:[
    {id:"check",title:"Verify recording",kind:"human",where:"human",agentId:"source",sourceCoordinatorId:"general"},
    {id:"warning",title:"Replace media",kind:"answer",where:"manager",agentId:"source",coordinatorFile:"/fake/file",sourceCoordinatorId:"general"},
  ]}));
  writeFileSync(join(data,"tracked-decisions.json"),JSON.stringify({version:1,items:[
    {source:"flat",projectId:"studio",id:"independent",title:"Independent",where:"manager",sourceCoordinatorId:"operator"},
  ]}));
  const hook = { refresh: () => {}, set loseReceipt(lose:boolean) { orca.behavior.loseAnswer = lose; orca.behavior.dropText = lose; } };
  orca.behavior.beforePs = () => hook.refresh();
  const sent = () => orca.writes.filter(w => w[0] === "terminal" && w[1] === "send").map(w => ({id:w[w.indexOf("--terminal")+1].replace("term_","")}));
  const sendLog = { map: (fn) => sent().map(fn), get length() { return sent().length; } };
  const fleet = createFleet(createCli(orca.runner),Date.now,{dataDir:data,sleep:async()=>{},mailSender:async()=>"term_board"});
  const handlers = new Map();
  contribute(rpcServer((name,fn)=>handlers.set(name,fn),fleet.paseo),fleet,data);
  const rpc = async (def,input) => { fleet.invalidate(); return def.output.parse(await handlers.get(def.name)(def.input.parse(input))); };
  await rpc(boardScope,{kind:"project",projectId:"studio",enabled:true});
  await rpc(boardScope,{kind:"coordinator",sessionId:"general"});
  const board = () => rpc(boardSnapshot,{fresh:true});
  const answer = (item,recipientId?:string) => rpc(resolveTrackedDecision,{
    id:item.id,source:item.source,projectId:item.projectId,fingerprint:item.fingerprint,answer:"Ready",recipientId,
  });
  const ask = (item,snapshot,id:string,key:string) => rpc(askClarification,{
    card:trackedClarificationCard(item,snapshot.sessions),recipientId:id,question:"What changed?",requestKey:key,
  });
  return {board,answer,ask,owner,ownerPath,configure,project,sendLog,hook};
}

test("only an operator-configured local owner can receive imported coordinator answers and questions", async () => {
  const f = await fixture(), board = await f.board();
  const [flat,check,warning] = board.trackedDecisions.items;
  expect(flat.sourceCoordinatorId).toBeUndefined();
  expect(trackedRecipient(flat,board.coordinator,board.sessions)).toBe("general");
  for (const item of [check,warning]) {
    expect(item.sourceCoordinatorId).toBe("operator");
    expect(trackedRecipient(item,board.coordinator,board.sessions)).toBe("operator");
    expect(clarificationRecipient(trackedClarificationCard(item,board.sessions),board)).toBe("operator");
    await expect(f.ask(item,board,"general","foreign-request-"+item.id)).rejects.toThrow();
    expect((await f.answer(item,"general")).status).toBe("changed");
  }
  await f.ask(warning,board,"operator","verified-owner-question");
  expect((await f.answer(check,"operator")).status).toBe("sent");
  expect(f.sendLog.map(m=>m.id)).toEqual(["operator","operator"]);
  f.owner("next");
  const changed = await f.board();
  expect(changed.trackedDecisions.items.some(i=>i.id===check.id)).toBe(false);
  expect(changed.replyHistory.find(r=>r.title===check.title).recipientId).toBe("operator");
  expect(changed.trackedDecisions.items.find(i=>i.id==="warning")).toMatchObject({sourceCoordinatorId:"next",fingerprint:warning.fingerprint});
});

test("missing, invalid, remote, inaccessible, and rotated owners cannot fall back to the current coordinator", async () => {
  const f = await fixture();
  const board = await f.board(), item = board.trackedDecisions.items.find(i=>i.id==="warning");
  for (const configure of [
    () => f.configure(), () => f.configure("relative.json"),
    () => f.configure(f.ownerPath+".missing"),
    () => {f.configure(f.ownerPath);writeFileSync(f.ownerPath,"invalid");},
    () => f.owner("remote-owner"), () => f.owner("outside"),
  ]) {
    configure();
    const current = await f.board(), record = current.trackedDecisions.items.find(i=>i.id==="warning");
    expect(record.fingerprint).toBe(item.fingerprint);
    expect(trackedRecipient(record,current.coordinator,current.sessions)).toBeNull();
    expect(clarificationRecipient(trackedClarificationCard(record,current.sessions),current)).toBeNull();
    expect((await f.answer(record,"general")).status).toBe("changed");
    await expect(f.ask(record,current,"general","missing-recipient-key")).rejects.toThrow();
  }
  f.owner("operator");
  f.hook.refresh=()=>f.owner("next");
  expect((await f.answer(item,"operator")).status).toBe("changed");
  let refresh = 0;
  f.owner("operator");
  f.hook.refresh=()=>{if(++refresh===2)f.owner("next");};
  await expect(f.ask(item,board,"operator","rotated-in-flight")).rejects.toThrow();
  f.owner("operator"); refresh = 0;
  f.hook.refresh = () => { if (++refresh === 2) f.project.set("operator","private"); };
  await expect(f.ask(item,board,"operator","moved-outside-scope")).rejects.toThrow();
  expect(f.sendLog).toHaveLength(0);
});

test("a rotation during a pending answer preserves its receipt and never resends it to the new owner", async () => {
  const f = await fixture(), board = await f.board(), item = board.trackedDecisions.items.find(i=>i.id==="check");
  f.hook.loseReceipt=true;
  expect((await f.answer(item,"operator")).status).toBe("unconfirmed");
  f.hook.loseReceipt=false; f.owner("next");
  expect((await f.answer(item,"next")).status).toBe("changed");
  expect((await f.answer(item,"operator")).status).toBe("changed");
  expect((await f.board()).replyHistory.find(r=>r.title===item.title)).toMatchObject({status:"pending",recipientId:"operator"});
  expect(f.sendLog.map(m=>m.id)).toEqual(["operator"]);
});
