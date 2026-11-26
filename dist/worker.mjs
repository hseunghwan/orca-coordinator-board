// src/worker.ts
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

// src/model.ts
var MAX_REPLY = 8e3;
var CLOSED_PER_PROJECT = 3;
var CLOSED_MAX_AGE = 7 * 24 * 60 * 60 * 1e3;
var RESUME_AGENTS = [
  "claude",
  "codebuddy",
  "codex",
  "qoder",
  "qoder-cn",
  "qwen-code",
  "gemini",
  "antigravity",
  "opencode",
  "opencode2",
  "pi",
  "mimo-code",
  "droid",
  "grok",
  "devin",
  "omp",
  "prime-agent",
  "copilot",
  "cursor",
  "kimi",
  "muse",
  "zcode",
  "dsh",
  "jcode",
  "kiro",
  "hermes"
];
var isResumeAgent = (agent) => RESUME_AGENTS.includes(agent);
function closedSessions(input) {
  const byId = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const live = /* @__PURE__ */ new Set();
  const unsure = /* @__PURE__ */ new Set();
  for (const workspace of input.workspaces) {
    const agents = input.agents.get(workspace.id);
    if (!agents) {
      unsure.add(workspace.id);
      continue;
    }
    for (const agent of agents) {
      if (agent.sessionId) live.add(agent.sessionId);
      else unsure.add(workspace.id);
    }
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of [...input.history].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const workspace = row.workspaceId ? byId.get(row.workspaceId) : void 0;
    if (!workspace || unsure.has(workspace.id) || row.running || live.has(row.sessionId) || seen.has(row.sessionId)) continue;
    if (!isResumeAgent(row.agent) || !/^[A-Za-z0-9._:-]{1,256}$/.test(row.sessionId)) continue;
    if (input.now - row.updatedAt > CLOSED_MAX_AGE) continue;
    seen.add(row.sessionId);
    out.push({
      key: "closed:" + row.sessionId,
      sessionId: row.sessionId,
      agent: row.agent,
      title: cleanLine(row.title || row.agent, 200),
      workspaceId: workspace.id,
      workspaceName: cleanLine(workspace.name, 200),
      branch: workspace.branch,
      updatedAt: row.updatedAt
    });
    if (out.length >= (input.limit ?? CLOSED_PER_PROJECT)) break;
  }
  return out;
}
var ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
var CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
function cleanLine(text2, max = 512) {
  return text2.replace(ANSI, "").replace(/\t/g, "  ").replace(/[\r\n]/g, " ").replace(CONTROL, " ").slice(0, max);
}
function cleanTail(lines, keep = 30) {
  const out = lines.map((line) => cleanLine(line, 400).trimEnd());
  while (out.length && !out[out.length - 1]) out.pop();
  return out.slice(-keep);
}
function sessionRows(workspace, agents) {
  return agents.map((agent) => ({
    // A new state gets a new key, so a dismissed card returns when the session asks again.
    key: `${agent.terminalId ?? workspace.id + ":" + (agent.title ?? "")}@${agent.stateStartedAt}`,
    terminalId: agent.terminalId,
    workspaceId: workspace.id,
    workspaceName: cleanLine(workspace.name, 200),
    branch: workspace.branch,
    agent: agent.agent,
    title: cleanLine(agent.task?.title || agent.title || agent.agent || "agent", 200),
    state: agent.state,
    since: agent.stateStartedAt
  }));
}
var pullKey = (pull) => `pr:${pull.repo}#${pull.number}@${pull.updatedAt}`;
var RANK = { permission: 0, reply: 1, review: 2 };
function decisionsFor(lanes, dismissed) {
  const out = [];
  const seenPulls = /* @__PURE__ */ new Set();
  for (const lane of lanes) {
    for (const session of lane.sessions) {
      if (session.state === "blocked") {
        out.push({ key: session.key, kind: "permission", projectName: lane.name, since: session.since, session });
      } else if (session.state === "waiting" && !dismissed.has(session.key)) {
        out.push({ key: session.key, kind: "reply", projectName: lane.name, since: session.since, session });
      }
    }
    for (const pull of lane.pulls) {
      const key = pullKey(pull);
      if (pull.reason !== "ready" || seenPulls.has(key) || dismissed.has(key)) continue;
      seenPulls.add(key);
      out.push({ key, kind: "review", projectName: lane.name, since: Date.parse(pull.updatedAt) || 0, pull });
    }
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
function buildBoard(input) {
  const chosen = input.projects.filter((project) => input.selected.includes(project.id)).sort((a, b) => a.name.localeCompare(b.name));
  const projects = chosen.map((project) => {
    const own = input.workspaces.filter((workspace) => workspace.projectId === project.id);
    const closed = input.history ? closedSessions({ history: input.history, workspaces: own, agents: input.agents, now: input.now }) : [];
    const sessions = own.flatMap((workspace) => sessionRows(workspace, input.agents.get(workspace.id) ?? [])).sort((a, b) => b.since - a.since);
    const pulls = input.pulls.get(project.id) ?? { repo: null, status: "unmapped", items: [] };
    return { projectId: project.id, name: cleanLine(project.name, 200), sessions, closed, repo: pulls.repo, pullStatus: pulls.status, pulls: pulls.items };
  });
  return {
    at: input.now,
    selected: chosen.map((project) => project.id),
    projects,
    decisions: decisionsFor(projects, input.dismissed),
    replies: [...input.replies],
    truncated: input.truncated
  };
}
function resumeGuard(input) {
  if (!input.text.trim()) return "empty";
  if (input.text.length > MAX_REPLY) return "too-long";
  if (!input.row || input.row.agent !== input.agent || !isResumeAgent(input.agent)) return "gone";
  if (input.row.running || !input.live) return "open";
  if (input.live.some((agent) => agent.sessionId === input.sessionId || !agent.sessionId)) return "open";
  return null;
}
function replyGuard(agent, text2, expectedSince) {
  if (!text2.trim()) return "empty";
  if (text2.length > MAX_REPLY) return "too-long";
  if (!agent || !agent.terminalId) return "gone";
  if (agent.state === "blocked") return "permission";
  if (agent.state === "working") return "busy";
  if (agent.stateStartedAt !== expectedSince) return "changed";
  return null;
}
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function remember(list, value, cap) {
  return [...list, value].slice(-cap);
}

// src/github.ts
var SLUG = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i;
function repositorySlug(value) {
  if (typeof value !== "string") return null;
  const slug = value.trim();
  if (!SLUG.test(slug) || [".", ".."].includes(slug.split("/")[1])) return null;
  return slug.toLowerCase();
}
function githubRepository(remote) {
  if (!remote || remote.length > 512) return null;
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/?#\s]+\/[^/?#\s]+?)\/?$/i.exec(remote.trim());
  return match ? repositorySlug(match[1].replace(/\.git$/i, "")) : null;
}
var pullUrl = (repo, number) => `https://github.com/${repo}/pull/${number}`;
function commandEnv(env, platform) {
  const next = { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" };
  const profile = env.USERPROFILE;
  if (platform === "win32" && profile) {
    next.APPDATA ??= profile + "\\AppData\\Roaming";
    next.LOCALAPPDATA ??= profile + "\\AppData\\Local";
    next.HOME ??= profile;
  }
  return next;
}
var SCAN_LIMIT = 200;
var GH_FIELDS = "number,title,state,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest";
var GH_PROJECTION = "[.[] | {number,title,state,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,checks:[.statusCheckRollup[]? | {status,conclusion,state}],autoMerge:(.autoMergeRequest != null)}]";
var text = (value) => value === null || typeof value === "string";
function rawPull(value) {
  if (!value || typeof value !== "object") return null;
  const row = value;
  if (!Number.isInteger(row.number) || row.number <= 0 || typeof row.title !== "string") return null;
  if (row.state !== "OPEN" || typeof row.updatedAt !== "string" || Number.isNaN(Date.parse(row.updatedAt))) return null;
  if (typeof row.isDraft !== "boolean" || typeof row.autoMerge !== "boolean" || !Array.isArray(row.checks)) return null;
  if (!text(row.mergeable) || !text(row.mergeStateStatus) || !text(row.reviewDecision)) return null;
  return row;
}
var FAILING = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"];
var GREEN = ["SUCCESS", "NEUTRAL", "SKIPPED"];
function pullReason(p) {
  if (p.isDraft || p.mergeStateStatus === "DRAFT") return "draft";
  if (p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY") return "conflict";
  if (p.checks.some((c) => FAILING.includes(c.conclusion || c.state || ""))) return "checks-failed";
  if (p.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (p.checks.some((c) => c.status ? c.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(c.state ?? ""))) return "checks-pending";
  if (p.autoMerge) return "auto-merge";
  if (p.reviewDecision === "REVIEW_REQUIRED" || ["BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS"].includes(p.mergeStateStatus ?? "")) return "blocked";
  if (p.reviewDecision && p.reviewDecision !== "APPROVED") return "unknown";
  if (p.checks.some((c) => !(c.status === "COMPLETED" && GREEN.includes(c.conclusion ?? "")) && c.state !== "SUCCESS")) return "unknown";
  return p.mergeable === "MERGEABLE" && p.mergeStateStatus === "CLEAN" ? "ready" : "unknown";
}
function parseOpenPulls(repo, json) {
  const rows = JSON.parse(json);
  if (!Array.isArray(rows)) throw new Error("gh returned something other than a list");
  const seen = /* @__PURE__ */ new Set();
  const items = [];
  for (const row of rows.slice(0, SCAN_LIMIT)) {
    const pull = rawPull(row);
    if (!pull || seen.has(pull.number)) continue;
    seen.add(pull.number);
    items.push({ repo, number: pull.number, title: cleanLine(pull.title), url: pullUrl(repo, pull.number), reason: pullReason(pull), updatedAt: pull.updatedAt });
  }
  return { status: rows.length > SCAN_LIMIT ? "truncated" : "ok", items };
}

// src/i18n.ts
function translator(locale) {
  return /^ko(?:-|$)/i.test(locale) ? (ko) => ko : (_ko, en) => en;
}

// src/summary.ts
function waitingCounts(view) {
  const counts = { permission: 0, reply: 0, review: 0, working: 0 };
  for (const decision of view.decisions) counts[decision.kind] += 1;
  for (const lane of view.projects) counts.working += lane.sessions.filter((session) => session.state === "working").length;
  return counts;
}
function statusItem(t, view) {
  if (!view || !view.selected.length) {
    return { text: t("\uBCF4\uB4DC", "Board"), tone: "neutral", tooltip: t("\uCF54\uB514\uB124\uC774\uD130 \uBCF4\uB4DC: \uB20C\uB7EC\uC11C \uD504\uB85C\uC81D\uD2B8\uB97C \uACE0\uB974\uC138\uC694", "Coordinator Board: click to choose projects") };
  }
  const counts = waitingCounts(view);
  const waiting = counts.permission + counts.reply;
  return {
    text: waiting ? t(`\uAE30\uB2E4\uB9BC ${waiting}`, `${waiting} waiting`) : t("\uAE30\uB2E4\uB9BC \uC5C6\uC74C", "Nothing waiting"),
    // Permission first: only the session itself can clear it.
    tone: counts.permission ? "warning" : counts.reply ? "accent" : "neutral",
    tooltip: [
      `${t("\uAD8C\uD55C \uB300\uAE30", "Permission")} ${counts.permission}`,
      `${t("\uB2F5 \uAE30\uB2E4\uB9BC", "Waiting for you")} ${counts.reply}`,
      `${t("\uC791\uC5C5 \uC911", "Working")} ${counts.working}`
    ].join(" \xB7 ") + t(" \xB7 \uB20C\uB7EC\uC11C \uB300\uC2DC\uBCF4\uB4DC \uC5F4\uAE30", " \xB7 Click to open the dashboard")
  };
}
var DASHBOARD_DIR = ".coordinator-board";
var DASHBOARD_FILE = DASHBOARD_DIR + "/board.coordinator-board";
var EXCLUDE_LINE = "/" + DASHBOARD_DIR + "/";
function dashboardFileText() {
  return JSON.stringify({ coordinatorBoard: 1, note: "Opens the Coordinator Board dashboard in Orca. The board keeps no data here." }, null, 2) + "\n";
}
function withExcludeLine(current) {
  const present = current.split(/\r?\n/).map((line) => line.trim()).some((line) => line === EXCLUDE_LINE || line === DASHBOARD_DIR + "/" || line === "/" + DASHBOARD_DIR || line === DASHBOARD_DIR);
  if (present) return null;
  const head = current && !current.endsWith("\n") ? current + "\n" : current;
  return head + "# Coordinator Board (Orca plugin): the dashboard key file\n" + EXCLUDE_LINE + "\n";
}
function samePath(a, b) {
  const norm = (path) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
function focusedWorkspace(context, workspaces) {
  if (!context) return void 0;
  const id = context.workspaceId;
  if (id) {
    const exact = workspaces.find((row) => row.id === id);
    if (exact) return exact;
    const cut = id.indexOf("::");
    if (cut >= 0) {
      const path = id.slice(cut + 2);
      const byPath = workspaces.filter((row) => samePath(row.path, path));
      if (byPath.length === 1) return byPath[0];
    }
  }
  if (!context.displayName) return void 0;
  const byName = workspaces.filter((row) => row.name === context.displayName && (row.branch ?? "") === context.branch);
  return byName.length === 1 ? byName[0] : void 0;
}

// src/worker.ts
var SELECTED = "selectedProjects";
var DISMISSED = "dismissed";
var REPLIES = "replies";
var LOCALE = "locale";
var STATUS_ITEM = "waiting";
var OPEN_DASHBOARD = "open-dashboard";
var POLL_MS = 3e4;
var MAX_WORKSPACES = 60;
var MAX_TAILS = 12;
var TTL = 6e4;
var FAILED_TTL = 15e3;
function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      shell: false,
      windowsHide: true,
      timeout: command === "gh" ? 15e3 : 3e3,
      maxBuffer: 2 * 1024 * 1024,
      env: commandEnv(process.env, process.platform)
    }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}
var hostGithub = {
  async originOf(path) {
    if (!await isCheckout(path)) return null;
    try {
      return githubRepository(await run("git", ["-C", path, "remote", "get-url", "origin"]));
    } catch {
      return null;
    }
  },
  async openPulls(repo) {
    return parseOpenPulls(repo, await run("gh", [
      "pr",
      "list",
      "--repo",
      "github.com/" + repo,
      "--state",
      "open",
      "--limit",
      String(SCAN_LIMIT + 1),
      "--json",
      GH_FIELDS,
      "--jq",
      GH_PROJECTION
    ]));
  },
  now: () => Date.now()
};
async function isCheckout(path) {
  if (!isAbsolute(path)) return false;
  try {
    const marker = await stat(join(path, ".git"));
    return marker.isFile() || marker.isDirectory();
  } catch {
    return false;
  }
}
var hostFiles = {
  async ensureDashboard(root) {
    if (!isAbsolute(root)) throw new Error("not a local path");
    const target = join(root, DASHBOARD_FILE);
    await mkdir(dirname(target), { recursive: true });
    const text2 = dashboardFileText();
    if (await readFile(target, "utf8").catch(() => null) !== text2) await writeFile(target, text2);
    if (!await isCheckout(root)) return;
    const reported = (await run("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"])).trim();
    if (!reported) return;
    const exclude = isAbsolute(reported) ? reported : join(root, reported);
    const next = withExcludeLine(await readFile(exclude, "utf8").catch(() => ""));
    if (next === null) return;
    await mkdir(dirname(exclude), { recursive: true });
    await writeFile(exclude, next);
  }
};
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}
function replyRecords(value) {
  return Array.isArray(value) ? value.filter((row) => row && typeof row.at === "number") : [];
}
function activateWith(orca, github, options = {}) {
  const files = options.files ?? hostFiles;
  const pollMs = options.pollMs ?? POLL_MS;
  let locale = "en";
  void orca.storage.get(LOCALE).then((value) => {
    if (typeof value === "string") locale = value;
  }, () => void 0);
  const origins = /* @__PURE__ */ new Map();
  const pullLists = /* @__PURE__ */ new Map();
  function cached(map, key, refresh, load, ttl) {
    const hit = map.get(key);
    if (hit && (hit.expires === Infinity || !refresh && hit.expires > github.now())) return hit.value;
    const entry = { expires: Infinity, value: load() };
    map.set(key, entry);
    entry.value.then(
      (value) => {
        entry.expires = github.now() + ttl(value);
      },
      () => {
        if (map.get(key) === entry) map.delete(key);
      }
    );
    return entry.value;
  }
  async function agentsOf(workspaceId) {
    return (await orca.host.call("agents.list", { workspaceId })).agents;
  }
  async function pullsFor(project, refresh) {
    if (project.hostId && project.hostId !== "local") return { repo: null, status: "remote", items: [] };
    const repo = await cached(origins, project.path, refresh, () => github.originOf(project.path), () => TTL);
    if (!repo) return { repo: null, status: "unmapped", items: [] };
    const list = await cached(pullLists, repo, refresh, async () => {
      try {
        return await github.openPulls(repo);
      } catch (error) {
        const { code, stderr } = error;
        orca.log(`gh pr list failed for ${repo}: exit ${String(code ?? "")}: ${String(stderr ?? "").trim().slice(0, 300)}`);
        return { status: "unavailable", items: [] };
      }
    }, (value) => value.status === "unavailable" ? FAILED_TTL : TTL);
    return { repo, status: list.status, items: list.items };
  }
  async function readHistory(workspaceId) {
    try {
      const { sessions } = await orca.host.call("agent.listSessions", workspaceId ? { workspaceId, limit: 200 } : { limit: 200 });
      return sessions;
    } catch (error) {
      orca.log(`agent history unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return void 0;
    }
  }
  async function readBoard(refresh, read = { pulls: true, tails: true }) {
    const [projectList, workspaceList, selectedRaw, dismissedRaw, repliesRaw] = await Promise.all([
      orca.host.call("project.list", {}),
      orca.host.call("workspace.list", { includeStatus: true }),
      orca.storage.get(SELECTED),
      orca.storage.get(DISMISSED),
      orca.storage.get(REPLIES)
    ]);
    const projects = projectList.projects;
    const selected = strings(selectedRaw).filter((id) => projects.some((project) => project.id === id));
    const workspaces = workspaceList.workspaces.filter((w) => w.projectId != null && selected.includes(w.projectId));
    const scanned = workspaces.slice(0, MAX_WORKSPACES);
    let truncated = projectList.truncated || workspaceList.truncated || workspaces.length > scanned.length;
    const agents = /* @__PURE__ */ new Map();
    await mapLimited(scanned, 4, async (workspace) => {
      try {
        agents.set(workspace.id, await agentsOf(workspace.id));
      } catch {
        truncated = true;
      }
    });
    const chosen = projects.filter((project) => selected.includes(project.id));
    const pulls = new Map(read.pulls ? await mapLimited(chosen, 3, async (project) => [project.id, await pullsFor(project, refresh)]) : []);
    const history = read.pulls ? await readHistory() : void 0;
    const board = buildBoard({
      projects,
      selected,
      workspaces,
      agents,
      pulls,
      dismissed: new Set(strings(dismissedRaw)),
      replies: replyRecords(repliesRaw).slice(-20).reverse(),
      history,
      now: github.now(),
      truncated
    });
    if (!read.tails) return board;
    const waiting = board.decisions.filter((d) => d.kind === "reply" && d.session?.terminalId).slice(0, MAX_TAILS);
    await mapLimited(waiting, 4, async (decision) => {
      try {
        const output = await orca.host.call("terminal.read", { terminalId: decision.session.terminalId, maxLines: 60 });
        decision.tail = cleanTail(output.lines);
      } catch {
      }
    });
    return board;
  }
  let statusRun = null;
  let statusTimer;
  let stopped = false;
  async function showStatus(view) {
    if (stopped) return;
    try {
      await orca.host.call("statusBar.update", { id: STATUS_ITEM, ...statusItem(translator(locale), view) });
    } catch {
    }
  }
  function updateStatus() {
    statusRun ??= readBoard(false, { pulls: false, tails: false }).then((view) => showStatus(view), () => void 0).finally(() => {
      statusRun = null;
    });
    return statusRun;
  }
  function statusSoon() {
    if (stopped) return;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = void 0;
      void updateStatus();
    }, 500);
  }
  const poll = pollMs > 0 ? setInterval(() => void updateStatus(), pollMs) : void 0;
  if (pollMs > 0) void updateStatus();
  orca.panels.handle("board.read", async (input) => {
    if (typeof input?.locale === "string" && input.locale && input.locale !== locale) {
      locale = input.locale.slice(0, 35);
      await orca.storage.set(LOCALE, locale);
    }
    const board = await readBoard(input?.refresh === true);
    void showStatus(board);
    return board;
  });
  orca.panels.handle("board.projects", async () => {
    const [{ projects }, selected] = await Promise.all([orca.host.call("project.list", {}), orca.storage.get(SELECTED)]);
    return {
      projects: projects.filter((project) => !project.hidden).map((project) => ({ id: project.id, name: project.name, path: project.path, remote: !!project.hostId && project.hostId !== "local" })).sort((a, b) => a.name.localeCompare(b.name)),
      selected: strings(selected)
    };
  });
  orca.panels.handle("board.select-projects", async (input) => {
    const { projects } = await orca.host.call("project.list", {});
    const known = new Set(projects.map((project) => project.id));
    const selected = [...new Set(strings(input?.projectIds))].filter((id) => known.has(id));
    await orca.storage.set(SELECTED, selected);
    orca.panels.post("board.changed", { at: github.now() });
    statusSoon();
    return { selected };
  });
  async function typeInto(terminalId, text2) {
    const inFocus = async () => {
      const context = await orca.host.call("workspace.readContext", {}).catch(() => null);
      return !!context?.terminals.some((terminal) => terminal.id === terminalId);
    };
    if (!await inFocus()) {
      const moved = await orca.host.call("terminal.focus", { terminalId }).catch(() => ({ focused: false }));
      if (!moved.focused) return false;
      let shown = false;
      for (let tries = 0; tries < 20 && !(shown = await inFocus()); tries += 1) await new Promise((done) => setTimeout(done, 100));
      if (!shown) return false;
    }
    const sent = await orca.host.call("terminal.sendText", { terminalId, text: text2, enter: true });
    return sent.accepted;
  }
  orca.panels.handle("board.reply", async (input) => {
    const at = github.now();
    const text2 = typeof input?.text === "string" ? input.text : "";
    let status = null;
    if (typeof input?.workspaceId !== "string" || typeof input?.terminalId !== "string" || typeof input?.expectedSince !== "number") {
      status = "gone";
    } else {
      let agents = [];
      try {
        agents = await agentsOf(input.workspaceId);
      } catch {
      }
      const agent = agents.find((row) => row.terminalId === input.terminalId);
      status = replyGuard(agent, text2, input.expectedSince);
      if (!status) {
        try {
          status = await typeInto(input.terminalId, text2.trimEnd()) ? "sent" : "failed";
        } catch (error) {
          orca.log(`reply failed: ${error instanceof Error ? error.message : String(error)}`);
          status = "failed";
        }
      }
    }
    const record = {
      projectName: String(input?.projectName ?? "").slice(0, 200),
      workspaceName: String(input?.workspaceName ?? "").slice(0, 200),
      title: String(input?.title ?? "").slice(0, 200),
      text: text2.slice(0, 2e3),
      status,
      at
    };
    await orca.storage.set(REPLIES, remember(replyRecords(await orca.storage.get(REPLIES)), record, 50));
    orca.panels.post("board.changed", { at });
    statusSoon();
    return { status, at };
  });
  async function settled(terminalId, timeoutMs = 3e4) {
    let last = "";
    let same = 0;
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
      await new Promise((done) => setTimeout(done, 500));
      const output = await orca.host.call("terminal.read", { terminalId, maxLines: 40 }).catch(() => null);
      const text2 = output ? output.lines.join("\n").trim() : "";
      same = text2 && text2 === last ? same + 1 : 0;
      last = text2;
      if (same >= 3) return true;
    }
    return false;
  }
  orca.panels.handle("board.resume-reply", async (input) => {
    const at = github.now();
    const text2 = typeof input?.text === "string" ? input.text : "";
    let status;
    if (typeof input?.workspaceId !== "string" || typeof input?.sessionId !== "string" || typeof input?.agent !== "string") {
      status = "gone";
    } else {
      const [live, history] = await Promise.all([agentsOf(input.workspaceId).catch(() => void 0), readHistory(input.workspaceId)]);
      const row = history?.find((session) => session.sessionId === input.sessionId);
      const refused = resumeGuard({ text: text2, sessionId: input.sessionId, agent: input.agent, row, live });
      status = refused ?? "failed";
      if (!refused && isResumeAgent(input.agent)) {
        try {
          const resumed = await orca.host.call("agent.resume", { workspaceId: input.workspaceId, agent: input.agent, sessionId: input.sessionId });
          orca.log(`resume reply: ${resumed.started ? "started" : "already running"} in ${resumed.terminalId}`);
          if (await settled(resumed.terminalId)) status = await typeInto(resumed.terminalId, text2.trimEnd()) ? "sent" : "failed";
          else orca.log("resume reply: the resumed terminal did not settle; nothing typed");
        } catch (error) {
          orca.log(`resume reply failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const record = {
      projectName: String(input?.projectName ?? "").slice(0, 200),
      workspaceName: String(input?.workspaceName ?? "").slice(0, 200),
      title: String(input?.title ?? "").slice(0, 200),
      text: text2.slice(0, 2e3),
      status,
      at
    };
    await orca.storage.set(REPLIES, remember(replyRecords(await orca.storage.get(REPLIES)), record, 50));
    orca.panels.post("board.changed", { at });
    statusSoon();
    return { status, at };
  });
  orca.panels.handle("board.focus", async (input) => {
    try {
      if (typeof input?.terminalId === "string") return await orca.host.call("terminal.focus", { terminalId: input.terminalId });
      if (typeof input?.workspaceId === "string") return { focused: (await orca.host.call("workspace.open", { workspaceId: input.workspaceId })).opened };
    } catch {
    }
    return { focused: false };
  });
  orca.panels.handle("board.dismiss", async (input) => {
    if (typeof input?.key === "string" && input.key.length <= 1024) {
      await orca.storage.set(DISMISSED, remember(strings(await orca.storage.get(DISMISSED)).filter((key) => key !== input.key), input.key, 300));
      orca.panels.post("board.changed", { at: github.now() });
      statusSoon();
    }
    return { ok: true };
  });
  orca.commands.register(OPEN_DASHBOARD, async () => {
    const t = translator(locale);
    const context = await orca.host.call("workspace.readContext", {}).catch((error) => {
      orca.log(`open dashboard: readContext failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    const { workspaces } = await orca.host.call("workspace.list", {});
    const workspace = focusedWorkspace(context, workspaces);
    orca.log(`open dashboard: focused ${context?.workspaceId ?? "none"} -> ${workspace?.id ?? "no match"}`);
    if (!workspace) {
      return t(
        "\uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uB97C \uD558\uB098 \uC5F0 \uB4A4 \uB2E4\uC2DC \uB204\uB974\uC138\uC694. \uB300\uC2DC\uBCF4\uB4DC\uB294 \uC9C0\uAE08 \uBCF4\uACE0 \uC788\uB294 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC5D0 \uD0ED\uC73C\uB85C \uC5F4\uB9BD\uB2C8\uB2E4.",
        "Open a workspace, then try again. The dashboard opens as a tab in the workspace you are looking at."
      );
    }
    if (workspace.hostId && workspace.hostId !== "local") {
      return t(
        "\uB2E4\uB978 \uD638\uC2A4\uD2B8\uC758 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uC5D0\uC11C\uB294 \uB300\uC2DC\uBCF4\uB4DC\uB97C \uC5F4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC774 \uCEF4\uD4E8\uD130\uC758 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4\uB85C \uC62E\uAE34 \uB4A4 \uB204\uB974\uC138\uC694.",
        "The dashboard cannot open in a workspace on another host. Switch to a workspace on this computer."
      );
    }
    try {
      await files.ensureDashboard(workspace.path);
      await orca.host.call("editor.open", { workspaceId: workspace.id, path: DASHBOARD_FILE });
      orca.log("open dashboard: opened");
      return void 0;
    } catch (error) {
      orca.log(`open dashboard failed: ${error instanceof Error ? error.message : String(error)}`);
      return t("\uB300\uC2DC\uBCF4\uB4DC\uB97C \uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", "Could not open the dashboard.");
    }
  });
  return () => {
    stopped = true;
    if (poll) clearInterval(poll);
    if (statusTimer) clearTimeout(statusTimer);
  };
}
var stop;
function activate(orca) {
  stop = activateWith(orca, hostGithub);
}
function deactivate() {
  stop?.();
  stop = void 0;
}
export {
  OPEN_DASHBOARD,
  STATUS_ITEM,
  activateWith,
  deactivate,
  activate as default,
  hostFiles,
  hostGithub
};
