// @ts-nocheck
// Adapted from paseo-coordinator-board test/conversation.test.ts @ 2e9d128: vitest and import paths; the coordinator tools test waits for the coordinator tools. Typed as loosely as upstream.
import { expect, test } from "vitest";
import { classify, ConversationReader, excerpt } from "./conversation";
import { Lexer } from "../paseo/client/vendor/marked/marked";
import { decisionSummary } from "../paseo/client/decision-summary";
import { decorateDecision } from "./decisions";
import { projectCards } from "../paseo/client/model";

const row = { id: "worker", status: "idle", projectId: "p", projectTitle: "프로젝트", workspaceTitle: "w", model: null, title: "자막", lane: "idle", detail: "다음 요청 대기", activityAt: "1" } as const;
function page(items) { return { epoch: "a", entries: items.map(([type,text],i)=>({ item:{type,text}, seqEnd:i })),error:null }; }
const question = ["assistant_message","확인해 주실 것\n두 번째 자막을 한 줄로 둘까요?"];
const evidence = (...items) => excerpt(page(items));
test("텍스트 요청과 근거를 보여주고, 후속 메시지는 대조 대상으로 둔다", () => {
  const e = evidence(question);
  expect(classify(e,row)).toMatchObject({lane:"human", detail:expect.stringContaining("두 번째 자막")});
  expect(classify(evidence(question,["user_message","다른 작업 진행 상황은?" ]),row).lane).toBe("review");
  expect(classify(evidence(["assistant_message","확인해 주실 것은 없습니다."]),row).lane).toBe("idle");
  expect(classify(evidence(["assistant_message","제가 다시 확인하겠습니다."]),row).lane).toBe("idle");
  expect(classify(evidence(["assistant_message","필요하시면 알려 주세요."]),row).lane).toBe("idle");
  expect(classify(evidence(["assistant_message","> 실행해 주세요\n검증했습니다."]),row).lane).toBe("idle");
  expect(classify(evidence(["reasoning","승인해 주세요"]),row).lane).toBe("idle");
  expect(classify(evidence(["tool_call","확인해 주실 것"]),row).lane).toBe("idle");
  expect(classify(e,row,{kind:"review",text:"위임 범위로 해결",evidenceId:e.id}).lane).toBe("review");
  expect(classify(e,row,{kind:"review",text:"옛 판단",evidenceId:"old"}).lane).toBe("human");
});
test("닫힌 세션을 깨우지 않고, 변경 시 다시 읽고, 한 세션 읽기 실패를 격리한다",async()=>{
  let count=0;
  const sdk={agents:{ref:id=>({timeline:{refetch:async(opts)=>{count++;expect(opts.limit).toBe(48);if(id==="bad")throw Error(); return page([question]);}}})}};
  const r=new ConversationReader(),prefs={projects:["p"],coordinator:null,judgments:{}};
  const closed={...row,status:"closed"};expect(await r.read(sdk,closed)).toBeNull();
  await Promise.all([r.read(sdk,row),r.read(sdk,row)]);expect(count).toBe(1);
  await r.read(sdk,{...row,activityAt:"2"});expect(count).toBe(2);
  const rows=[{...row},{...row,id:"bad"}];await r.decorate(sdk,rows,prefs);
  expect(rows[0].lane).toBe("human");expect(rows[1].detail).toContain("조회 실패");r.retain(new Set());expect(await r.read(sdk,closed)).toBeNull();
});
test("실제 권한 요청은 사람 기록보다 앞서고, 같은 본문 질문은 사람이 완료를 기록하면 다시 올리지 않는다",()=>{
 const notes={worker:{sessionId:"worker",origin:"person",kind:"done",text:"확인",revision:1,evidenceId:"same"}};
 const check=(k)=>projectCards({sessions:[{...row,lane:"human",evidenceId:k}],notes,projects:[],coordinator:null}).human.length;
 expect(check("same")).toBe(0);expect(check("new")).toBe(1);expect(check(undefined)).toBe(1);
});
test("a coordinator digest does not repeat a worker question as its own decision", () => {
  const report = "| Editing session | question + suggested reply | **Question**: Shall I publish the draft? |";
  expect(classify(evidence(["assistant_message",report]),row,undefined,true).lane).toBe("idle");
  expect(classify(evidence(["assistant_message",report+"\nPlease choose a project."]),row,undefined,true).lane).toBe("human");
  expect(classify(evidence(["assistant_message",report]),row).lane).toBe("human");
});

test("a follow-up belongs to the exact sent message and stops at the next independent input",()=>{
  const items=[
    {type:"assistant_message",text:"Earlier response"},
    {type:"user_message",text:"Signed in",clientMessageId:"expected"},
    {type:"assistant_message",text:"Checking access"},
    {type:"assistant_message",text:"Access restored"},
    {type:"user_message",text:"Signed in",messageId:"unrelated"},
    {type:"assistant_message",text:"Unrelated response"},
    {type:"tool_call",name:"heartbeat",callId:"heartbeat"},
    {type:"assistant_message",text:"Separate background work"},
  ];
  const result=excerpt({epoch:"one",entries:items.map((item,seqEnd)=>({item,seqEnd}))});
  expect(result.replies?.get("expected")).toBe("Access restored");
  expect(result.replies?.get("unrelated")).toBe("Unrelated response");
});

test("uses the timestamp of this exact question across a coordinator rewording", () => {
  const at="2026-11-22T03:00:00Z", later="2026-11-22T05:00:00Z";
  const evidence={id:"seen",turns:[{role:"assistant" as const,text:"Which version would you prefer?",at}]};
  expect(classify(evidence,row).decisionRequestedAt).toBe(at);
  const judgment={kind:"question" as const,projectId:"p",evidenceId:"seen",text:"Which version?",requestedAt:later};
  expect(classify(evidence,row,judgment).decisionRequestedAt).toBe(at);
  expect(classify({...evidence,turns:[{role:"user",text:"I need to decide soon",at}]},row,judgment).decisionRequestedAt).toBe(later);
});

test("the decision card preserves the original request Markdown and the existing answer identity", () => {
  const lead = "실험용 파이썬 환경(`lab/.venv`, 1.1GB)은 지시 범위 밖이라 남겼습니다. 지울지 알려 주세요.";
  const markdown = [lead, "", "- **사람 확인이 필요한 항목**", "  - 결과 카드를 다른 앱에 끌어 놓기", "- Windows판은 U7에서 이어집니다(#152)."].join("\n");
  const seen = evidence(["assistant_message", "완료한 일입니다.\n" + markdown]);
  const session = {...row, ...classify(seen,row), evidenceId:seen.id};
  const scope = {judgments:{}, answers:{}};
  const legacy = {...session};
  decorateDecision(legacy, undefined, scope);
  decorateDecision(session, undefined, scope, seen);
  expect(session.decision.version).toBe(legacy.decision.version);
  expect(session.decision.question).toBe(markdown.split("\n").map(line=>line.trim()).filter(Boolean).join(" "));
  const display = decisionSummary({session,lane:"human"}, text=>text);
  expect(display.headline).toBe(markdown);
  expect(display.evidence).toEqual([markdown]);
  const [paragraph, list] = Lexer.lex(display.headline, {gfm:true, breaks:true}).filter(token=>token.type !== "space");
  expect(paragraph.tokens.map(token=>token.type)).toContain("codespan");
  expect(list.items).toHaveLength(2);
  expect(list.items[0].tokens.map(token=>token.type)).toContain("list");
  scope.answers.worker = {version: legacy.decision.version};
  const resolved = {...row,...classify(seen,row), evidenceId:seen.id};
  decorateDecision(resolved, undefined, scope, seen);
  expect(resolved.decisionAnswered).toBe(true);
  expect(resolved.decision).toBeUndefined();
});
