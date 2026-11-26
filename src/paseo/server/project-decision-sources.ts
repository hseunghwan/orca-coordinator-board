import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { repositorySlug } from "../shared/prs";

// Only an operator-provided local manifest can name a ledger directory.
// The UI, sessions, and decision content cannot change which files are opened.
const nonempty = z.string().trim().min(1);
const match = z.object({ id: nonempty, title: nonempty, ask: z.array(z.string()), projectId: nonempty, sessionId: nonempty, question: nonempty });
const manifest = z.object({ version: z.literal(1), sources: z.array(z.object({
  source: nonempty, projectId: nonempty.nullable(), projectTitle: nonempty,
  directory: nonempty.refine(isAbsolute), coordinatorFile: z.unknown().optional(), repository: repositorySlug.optional(), matches: z.array(match).default([]),
})).max(200) });
const lines = z.union([z.string(), z.array(z.string())]).nullish()
  .transform(value => (typeof value === "string" ? [value] : value ?? []).map(s => s.trim()).filter(Boolean));
const entry = z.object({
  id: nonempty, title: nonempty, kind: z.string().optional(), where: z.string().optional(), agentId: nonempty.nullish(), sessionHost:nonempty.nullish(),
  ask: lines, recommend: lines, why: lines, risk: lines, steps: lines, qa: z.array(z.unknown()).default([]),
  questions: z.array(z.object({ id:z.string().optional(), text:nonempty, multi:z.boolean().optional(), options:z.array(z.object({
    key:nonempty,text:nonempty,recommended:z.boolean().default(false),does:lines,pros:lines,cons:lines,note:z.string().nullish(),
  })) })).default([]),
  pr: z.number().int().positive().nullish(), since:z.string().nullish(), howToAnswer:z.string().nullish(), answerLead:z.string().nullish(), urgency:z.string().nullish(),
  dueAt:z.string().max(64).nullish(), blocksWork:z.boolean().nullish(),
});
const ledger = z.object({ items: z.array(entry) });
function localFile(path: string, optional = false, ownerFile = false) {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (ownerFile ? constants.O_NOFOLLOW ?? 0 : 0)); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Could not open decision source");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid decision source");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

type History = {at:string; text:string};
function history(path: string) {
  const byId = new Map<string, History[]>();
  const rows = (localFile(path, true) ?? "").split(/\r?\n/).slice(1).filter(Boolean).slice(-200);
  for (const row of rows) {
    const [at,id,...parts] = row.split("\t");
    if (!id || !at || !parts.length) continue;
    // New rows store the original message, attachment count and (optionally) a shorter copy.
    if (parts.length === 3 && /^\d+$/.test(parts[1])) parts.splice(1);
    else if (parts.length > 1 && /^\d+$/.test(parts[parts.length-1])) parts.pop();
    const text = parts.join(" ").trim();
    if (text) byId.set(id, [...byId.get(id) ?? [], {at,text}]);
  }
  return byId;
}

const ownerRecord = z.object({ agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/) });

function sourceCoordinator(path: unknown, cache: Map<string, string | null>) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  if (cache.has(path)) return cache.get(path)!;
  let id: string | null = null;
  try {
    id = ownerRecord.parse(JSON.parse(localFile(path, false, true)!)).agentId;
  } catch { /* An unreadable owner leaves the ledger available for local recording. */ }
  cache.set(path, id);
  return id;
}

export function readProjectDecisionSources(manifestPath: string, selected: Set<string>, onFailure?: () => void) {
  if (!selected.size) return [];
  const raw = localFile(manifestPath, true);
  if (raw === null) return [];
  const { sources } = manifest.parse(JSON.parse(raw));
  const visible = sources.filter(s => !s.projectId || selected.has(s.projectId));
  const keys = visible.map(s => JSON.stringify([s.source,s.projectId]));
  if (new Set(keys).size !== keys.length) throw new Error("Ambiguous decision source");
  const owners = new Map<string,string | null>();
  return visible.flatMap(source => {
    try { return readLedger(source,selected,sourceCoordinator(source.coordinatorFile,owners)); }
    catch (error) {
      if (!onFailure) throw error;
      onFailure();
      return [];
    }
  });
}

function readLedger(source: z.infer<typeof manifest>["sources"][number], selected: Set<string>, sourceCoordinatorId: string | null) {
  const document = localFile(join(source.directory, "decisions.json"));
  const { items } = ledger.parse(JSON.parse(document!));
  const answers = history(join(source.directory,"live","board-answers.tsv"));
  const asked = history(join(source.directory,"live","board-questions.tsv"));
  return items.map(row => {
    const binding = source.matches.find(m => m.id === row.id && m.sessionId === row.agentId && m.title === row.title &&
      JSON.stringify(m.ask) === JSON.stringify(row.ask) && selected.has(m.projectId));
    const kind = row.kind === "approval" ? "approve" : row.kind === "human" ? "check"
      : ["check","answer","approve","merge","cleanup"].includes(row.kind ?? "") ? row.kind : "other";
    const since = Date.parse(row.since ?? "");
    const current = (event: History) => Number.isFinite(since) && Date.parse(event.at) >= since;
    const qa = [...row.qa];
    for (const prior of (asked.get(row.id) ?? []).filter(current)) {
      if (!row.qa.some(q => q && typeof q === "object" && "q" in q && q.q === prior.text)) qa.push({q:prior.text,a:null,askedAt:prior.at});
    }
    return {
      sourceCoordinatorId, source: source.source, projectId: source.projectId, projectTitle: source.projectTitle,
      id:row.id,title:row.title,kind,where:row.where,ask:row.ask,recommend:row.recommend,why:row.why,risk:row.risk,steps:row.steps,
      dueAt:row.dueAt, blocksWork:row.blocksWork, since:row.since, urgency:row.urgency, howToAnswer:row.howToAnswer, answerLead:row.answerLead, sessionId:row.agentId ?? null, sessionHost:row.sessionHost ?? null,
      questions:row.questions.map(q => ({...q, multi:q.multi ?? /복수|여러\s*개|여럿|select (?:all|multiple)/i.test(q.text)})),
      qa, replyHistory:(answers.get(row.id) ?? []).filter(current),
      mergeTarget:kind === "merge" && source.repository && row.pr ? {repo:source.repository,number:row.pr} : undefined,
      sessionMatch:binding ? {projectId:binding.projectId, sessionId:binding.sessionId, question:binding.question} : undefined,
    };
  });
}
