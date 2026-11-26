import { Lexer, Parser } from "./vendor/marked/marked";
import type { Translate } from "../view-types";
import { sessionDetail, type Card } from "./model";

// A button can describe a Markdown title without putting links inside its press target.
export function plainDecisionTitle(title: string) {
  const parser = new Parser({ gfm: true });
  const label = title.trim().replace(/^#{1,6}\s+/, "");
  return parser.parseInline(Lexer.lexInline(label), parser.textRenderer).replace(/\s+/g, " ").trim();
}

// Older coordinator reports combine status, evidence and the question in one text field.
function excerptQuestion(text: string, dedicatedQuestion: boolean) {
  const lines = text
    .replace(/^```[^\n]*\n[\s\S]*?(?:^```[^\n]*$|(?![\s\S]))/gm, "")
    .split(/\r?\n/)
    .filter(line => !/^\s*>/.test(line))
    .map(line => line.trim().replace(/^[-*•]\s+/, ""))
    .filter(Boolean);
  const marker = /(?:^|[\s;·|—])(?:\*\*|__)?(?:결정\s*필요|내\s*결정|정할\s*(?:일|것)|결정\s*요청|질문|decision\s+(?:needed|required)|question)(?:\*\*|__)?\s*[:：](?:\*\*|__)?\s*/i;
  // A question that starts its own structured field can carry a checklist or code after it.
  if (dedicatedQuestion && text.includes("\n") && marker.exec(text.trimStart())?.index === 0) return text.trim();
  for (const [index, line] of lines.entries()) {
    const match = marker.exec(line);
    if (!match) continue;
    const after = line.slice(match.index + match[0].length).trim() || lines[index + 1] || "";
    if (after) return after.split(/(?<=[?？])\s|\s+(?=(?:근거|상태|배경|다음 단계|evidence|status|context)\s*[:：])/i)[0];
  }
  if (dedicatedQuestion) return text.trim();
  // Select an actual question without including a preceding status sentence or changing its words.
  for (const line of lines) {
    const question = line.split(/(?<=[.!。])\s+/).find(sentence => /[?？]/.test(sentence));
    if (question) return question.slice(0, question.search(/[?？]/) + 1);
  }
  return lines[0] || "";
}

export function decisionSummary({ session, note }: Card, t: Translate) {
  const decision = session.decision;
  const question = decision?.question || (note?.kind === "question" && note.text) || session.detail;
  const formal = !!session.nativePending || decision?.source === "permission";
  const raw = question.replace(/^(?:코디네이터 판단|세션의 확인 요청) · /, "");
  const headline = formal ? sessionDetail(question, t)
    : decision?.source === "conversation" ? decision.questionMarkdown ?? raw
    : excerptQuestion(raw, !!decision || note?.kind === "question");
  const normalize = (text: string) => text.replace(/^(?:코디네이터 판단|세션의 확인 요청) · /, "").trim();
  const evidence: string[] = [];
  for (const source of [question, session.detail, note?.kind !== "clear" && note?.text]) {
    const text = source && decision?.questionMarkdown && normalize(source) === normalize(question)
      ? decision.questionMarkdown : source;
    if (text && !evidence.some(prior => normalize(prior) === normalize(text))) evidence.push(text);
  }
  return {
    formal,
    headline: headline || t("원래 세션에서 정할 내용을 확인하세요.", "Open the session to review the decision."),
    evidence,
  };
}
