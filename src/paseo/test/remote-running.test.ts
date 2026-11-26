import { expect, test } from "vitest";
import { matchRemoteSessions, readRemoteSessions, remoteScope } from "../client/remote-sessions";

type Entry = Parameters<typeof matchRemoteSessions>[0][number];
type WS = Parameters<typeof matchRemoteSessions>[1][number];
type Reader = Parameters<typeof readRemoteSessions>[0];
const project = (id:string,selected = true) => ({id,title:"같은 이름",selected});
const map = (projectId:string,repo:string) => ({projectId,repo,mode:"manual" as const});
const scope=remoteScope([project("a"),project("b"),project("excluded",false)],[map("a","test/alpha"),map("b","test/beta")]);
const ag=(id:string,ws:string,changes: Record<string,unknown> = {}) => ({
  agent:{id,title:"실제 원격 작업",workspaceId:ws,status:"running",pendingPermissions:[],...changes},
  project:{projectKey:"unknown",projectName:"같은 이름"},
}) as unknown as Entry;
const ws=(id:string,projectId:string,repo?:string,changes: Record<string,unknown> = {}) => ({
  id,projectId,projectDisplayName:"같은 이름", gitRuntime:{remoteUrl: repo ? "https://github.com/"+repo+".git" : null}, ...changes,
}) as unknown as WS;

test("동일한 프로젝트 ID 또는 양 호스트에서 유일한 GitHub 저장소만 연결한다",()=>{
 const updatedAt="2026-11-22T13:30:00Z";
 const entries=[ag("one","remote-a",{updatedAt}),ag("two","remote-b"),ag("named","new"),ag("excluded","hidden")];
 const spaces=[ws("remote-a","a"),ws("remote-b","x","Test/Beta"),ws("new","other"),ws("hidden","excluded","test/alpha")];
 expect(matchRemoteSessions(entries,spaces,scope)).toEqual([
  {sessionId:"one",projectId:"a",title:"실제 원격 작업",activityAt:updatedAt},
  {sessionId:"two",projectId:"b",title:"실제 원격 작업"},
 ]);
});

test("형제 체크아웃의 저장소 충돌, 로컬 또는 원격의 중복 매핑, 외부 URL은 모두 제외한다",()=>{
 const entry=[ag("s","work")];
 const spaces=[ws("work","x","test/alpha")];
 expect(matchRemoteSessions(entry,spaces,remoteScope([project("a"),project("b")],[map("a","test/alpha"),map("b","test/alpha")]))).toEqual([]);
 expect(matchRemoteSessions(entry,[...spaces,ws("two","y","test/alpha")],scope)).toEqual([]);
 expect(matchRemoteSessions(entry,[...spaces,ws("two","x","another/repo")],scope)).toEqual([]);
 const foreign=ws("work","x","test/alpha",{project:{checkout:{remoteUrl:"https://example.org/test/alpha"}}});
 expect(matchRemoteSessions(entry,[foreign],scope)).toEqual([]);
 expect(matchRemoteSessions(entry,spaces,remoteScope([project("a")],[{projectId:"a",repo:"test/alpha",mode:"off"}]))).toEqual([]);
 expect(matchRemoteSessions(entry,[...spaces,ws("same-project","x","test/alpha")],scope)).toHaveLength(1);
});

test("보관, 내부, 미접근 작업 공간, 권한 대기·유휴 세션은 진행으로 표시하지 않는다",()=>{
 const entries=[ag("arch","w",{archivedAt:"yesterday"}),ag("internal","w",{internal:true}),
   ag("permission","w",{pendingPermissions:[{}]}),ag("perm","w",{attentionReason:"permission"}),
   ag("idle","w",{status:"idle"}),ag("ws-arch","arch"),ag("ws-int","i"),ag("missing","unknown"),
   ag("s","w"),ag("s","w")];
 expect(matchRemoteSessions(entries,[ws("w","a"),ws("arch","a",undefined,{archivingAt:"now"}),ws("i","a",undefined,{internal:true})],scope).map(r=>r.sessionId)).toEqual(["s"]);
});

test("활성 메타데이터만 읽고 양쪽 페이지를 순회한다. 선택/실행 중 작업이 없으면 이후 조회를 생략한다",async()=>{
 const reads:string[]=[];
 const client={
  agents:{list:async({filter,page}:{filter:{statuses:string[]},page:{cursor?:string}})=>{
    expect(filter.statuses).toEqual(["running"]);reads.push("agent");
    return {entries:[ag(page.cursor?"two":"one","w")],pageInfo:{hasMore:!page.cursor,nextCursor:page.cursor?null:"next"}};
  }},
  workspaces:{list:async({page}:{page:{cursor?:string}})=>{
    reads.push("space");return{entries:page.cursor?[ws("w","a")]:[],pageInfo:{hasMore:!page.cursor,nextCursor:page.cursor?null:"more"}};
  }},
 } as unknown as Reader;
 expect(await readRemoteSessions(client,remoteScope([],[]))).toEqual([]);expect(reads).toEqual([]);
 expect((await readRemoteSessions(client,scope)).map(r=>r.sessionId)).toEqual(["one","two"]);
 expect(reads).toEqual(["agent","agent","space","space"]);
 const inactive={agents:{list:async()=>({entries:[],pageInfo:{hasMore:false,nextCursor:null}})},workspaces:{list:()=>{throw Error("unnecessary")}}} as unknown as Reader;
 expect(await readRemoteSessions(inactive,scope)).toEqual([]);
});

test("조회 중 호스트 제외 시 다음 페이지나 작업 공간 조회를 중단한다", async () => {
  let active = true;
  let readCount = 0;
  const client = {
    agents: { list: async () => {
      readCount++;
      active = false;
      return { entries: [ag("a", "w")], pageInfo: { hasMore: true, nextCursor: "more" } };
    } },
    workspaces: { list: () => { throw Error("unexpected workspace request"); } },
  } as unknown as Reader;
  await expect(readRemoteSessions(client, scope, () => active)).rejects.toThrow("scope changed");
  expect(readCount).toBe(1);
});

test("opening an idle remote history source checks its exact identity and project without listing every session",async()=>{
 const {readRemoteHistorySession} = await import("../client/remote-sessions");
 const sources=[ws("remote-w","x","Test/Beta")];
 let current=ag("old","remote-w",{status:"closed"}); let agents=0, spaces=0;
 const client={
  agents:{ref:(id:string)=>({refresh:async()=>{agents++;expect(id).toBe("old");return current;}})},
  workspaces:{list:async()=>{spaces++;return {entries:sources,pageInfo:{hasMore:false,nextCursor:null}};}},
 } as unknown as Reader;
 expect(await readRemoteHistorySession(client,"old","b",scope)).toBe(true);
 expect(await readRemoteHistorySession(client,"old","a",scope)).toBe(false);
 current=ag("other","remote-w",{status:"idle"});
 expect(await readRemoteHistorySession(client,"old","b",scope)).toBe(false);
 current=ag("old","remote-w",{status:"idle",archivedAt:"2026-01-01"});
 expect(await readRemoteHistorySession(client,"old","b",scope)).toBe(false);
 expect(await readRemoteHistorySession(client,"old","excluded",scope)).toBe(false);
 expect(agents).toBe(4);expect(spaces).toBe(2);
});
