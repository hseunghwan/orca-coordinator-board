// src/i18n.ts
function translator(locale) {
  return /^ko(?:-|$)/i.test(locale) ? (ko) => ko : (_ko, en) => en;
}

// src/dashboard/style.ts
var STYLE = `
:root { --cb-blocked: #e5a00d; --cb-waiting: var(--orca-destructive, #e5484d); --cb-working: #3b82f6; --cb-done: #30a46c; --cb-radius: var(--orca-radius, 8px); }
html, body { margin: 0; background: var(--orca-background); color: var(--orca-foreground); font: 13px/1.45 var(--orca-font-sans, system-ui, sans-serif); }
* { box-sizing: border-box; }
.app { padding: 20px 24px 40px; max-width: 1680px; margin: 0 auto; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-bottom: 18px; }
.top .title { flex: 1 1 260px; min-width: 0; }
h1 { font-size: 18px; margin: 0 0 2px; font-weight: 600; }
h2 { font-size: 13px; margin: 0; font-weight: 600; text-transform: none; }
h3 { font-size: 13.5px; margin: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--orca-muted-foreground); }
.small { font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--orca-border); border-radius: 999px; background: var(--orca-card); }
.chip strong { font-size: 15px; font-variant-numeric: tabular-nums; }
.chip.zero { opacity: .55; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--orca-muted-foreground); }
.dot.blocked { background: var(--cb-blocked); } .dot.waiting { background: var(--cb-waiting); }
.dot.working { background: var(--cb-working); } .dot.done { background: var(--cb-done); } .dot.review { background: var(--cb-done); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
button { font: inherit; border-radius: 6px; padding: 5px 11px; border: 1px solid var(--orca-border); background: var(--orca-secondary); color: var(--orca-secondary-foreground); cursor: pointer; }
button:hover:not(:disabled) { background: var(--orca-accent); color: var(--orca-accent-foreground); }
button.primary { background: var(--orca-primary); color: var(--orca-primary-foreground); border-color: transparent; }
button.primary:hover:not(:disabled) { opacity: .9; background: var(--orca-primary); color: var(--orca-primary-foreground); }
button.ghost { background: transparent; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, textarea:focus-visible, .session:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--orca-ring); outline-offset: 1px; }
.banner { padding: 10px 12px; border-radius: var(--cb-radius); border: 1px solid var(--cb-waiting); margin-bottom: 14px; }
.layout { display: grid; grid-template-columns: minmax(360px, 5fr) 7fr; gap: 22px; align-items: start; }
@media (max-width: 1050px) { .layout { grid-template-columns: 1fr; } }
.column { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.column-head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px 2px; }
.count { font-variant-numeric: tabular-nums; color: var(--orca-muted-foreground); }
.card { background: var(--orca-card); color: var(--orca-card-foreground); border: 1px solid var(--orca-border); border-radius: var(--cb-radius); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.card.permission { border-left: 3px solid var(--cb-blocked); }
.card.reply { border-left: 3px solid var(--cb-waiting); }
.card.review { border-left: 3px solid var(--cb-done); }
.card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-head h3 { flex: 1; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--orca-border); white-space: nowrap; }
.badge.blocked { color: var(--cb-blocked); border-color: var(--cb-blocked); }
.badge.waiting { color: var(--cb-waiting); border-color: var(--cb-waiting); }
.badge.working { color: var(--cb-working); border-color: var(--cb-working); }
.badge.done, .badge.review { color: var(--cb-done); border-color: var(--cb-done); }
pre.tail { margin: 0; font: 11.5px/1.45 var(--orca-font-mono, ui-monospace, monospace); background: var(--orca-muted); padding: 8px 10px; border-radius: 6px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
textarea { width: 100%; min-height: 66px; resize: vertical; background: var(--orca-background); color: inherit; border: 1px solid var(--orca-input, var(--orca-border)); border-radius: 6px; padding: 8px 10px; font: inherit; }
.empty { padding: 28px 16px; text-align: center; border: 1px dashed var(--orca-border); border-radius: var(--cb-radius); }
.lanes { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--orca-muted); }
.bar span { display: block; }
.bar .blocked { background: var(--cb-blocked); } .bar .waiting { background: var(--cb-waiting); }
.bar .working { background: var(--cb-working); } .bar .done { background: var(--cb-done); }
.sessions { display: flex; flex-direction: column; gap: 1px; margin: 0 -6px; }
.session { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; min-width: 0; }
.closed { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.closed-session { display: flex; flex-direction: column; gap: 6px; }
.closed-session .session { cursor: default; margin: 0 -6px; }
.closed-session .actions { justify-content: flex-end; }
.session:hover { background: var(--orca-accent); color: var(--orca-accent-foreground); }
.session[aria-disabled="true"] { cursor: default; }
.session .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session .where { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details > summary { cursor: pointer; padding: 2px 0; }
.pulls { display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--orca-border); padding-top: 8px; }
.pull { display: flex; gap: 8px; align-items: center; min-width: 0; }
.pull a { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; }
a { color: var(--orca-primary); }
.picker { max-width: 640px; }
.picker label { display: flex; gap: 10px; align-items: flex-start; padding: 6px 4px; border-radius: 6px; cursor: pointer; }
.picker label:hover { background: var(--orca-accent); }
.history { margin-top: 6px; }
.history li { margin: 4px 0; }
.history ul { padding-left: 18px; margin: 6px 0 0; }
`;

// src/labels.ts
function stateLabel(t2, state2) {
  switch (state2) {
    case "working":
      return t2("\uC791\uC5C5 \uC911", "Working");
    case "blocked":
      return t2("\uAD8C\uD55C \uB300\uAE30", "Waiting for permission");
    case "waiting":
      return t2("\uB2F5 \uAE30\uB2E4\uB9BC", "Waiting for you");
    case "done":
      return t2("\uC644\uB8CC", "Done");
  }
}
function pullReasonLabel(t2, reason) {
  switch (reason) {
    case "ready":
      return t2("\uB9AC\uBDF0 \uAC00\uB2A5", "Ready for review");
    case "draft":
      return t2("\uCD08\uC548", "Draft");
    case "conflict":
      return t2("\uCDA9\uB3CC", "Conflict");
    case "checks-failed":
      return t2("\uAC80\uC0AC \uC2E4\uD328", "Checks failed");
    case "checks-pending":
      return t2("\uAC80\uC0AC \uC911", "Checks running");
    case "changes-requested":
      return t2("\uC218\uC815 \uC694\uCCAD\uB428", "Changes requested");
    case "blocked":
      return t2("\uBCD1\uD569 \uC870\uAC74 \uBBF8\uCDA9\uC871", "Blocked");
    case "auto-merge":
      return t2("\uC790\uB3D9 \uBCD1\uD569 \uB300\uAE30", "Auto-merge on");
    case "unknown":
      return t2("\uC0C1\uD0DC \uD655\uC778 \uD544\uC694", "Needs a look");
  }
}
function pullStatusNote(t2, status) {
  switch (status) {
    case "ok":
      return null;
    case "truncated":
      return t2("PR\uC774 \uB9CE\uC544 \uC77C\uBD80\uB9CC \uBCF4\uC785\uB2C8\uB2E4.", "Showing only some pull requests.");
    case "unmapped":
      return t2("origin \uC6D0\uACA9\uC5D0\uC11C GitHub \uC800\uC7A5\uC18C\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", "No GitHub repository found in the origin remote.");
    case "unavailable":
      return t2("PR\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. gh \uB85C\uADF8\uC778 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.", "Could not read pull requests. Check that gh is signed in.");
    case "remote":
      return t2("\uB2E4\uB978 \uD638\uC2A4\uD2B8\uC758 \uD504\uB85C\uC81D\uD2B8\uB294 PR\uC744 \uC77D\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", "Pull requests are not read for projects on another host.");
  }
}
function replyStatusLabel(t2, status) {
  switch (status) {
    case "sent":
      return t2("\uBCF4\uB0C8\uC2B5\uB2C8\uB2E4.", "Sent.");
    case "empty":
      return t2("\uBCF4\uB0BC \uB0B4\uC6A9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", "Nothing to send.");
    case "too-long":
      return t2("\uB2F5\uC774 \uB108\uBB34 \uAE41\uB2C8\uB2E4. 8000\uC790 \uC774\uD558\uB85C \uC904\uC774\uC138\uC694.", "The reply is too long. Keep it under 8000 characters.");
    case "gone":
      return t2("\uC138\uC158\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", "The session is no longer there.");
    case "permission":
      return t2("\uAD8C\uD55C \uC694\uCCAD\uC744 \uAE30\uB2E4\uB9AC\uB294 \uC138\uC158\uC774\uB77C \uBCF4\uB0B4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC138\uC158\uC5D0\uC11C \uC9C1\uC811 \uCC98\uB9AC\uD558\uC138\uC694.", "Not sent: the session is waiting for permission. Handle it in the session.");
    case "busy":
      return t2("\uC138\uC158\uC774 \uC791\uC5C5 \uC911\uC774\uB77C \uBCF4\uB0B4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uB05D\uB098\uBA74 \uB2E4\uC2DC \uBCF4\uB0B4\uC138\uC694.", "Not sent: the session is working. Send again when it stops.");
    case "changed":
      return t2("\uC138\uC158 \uC0C1\uD0DC\uAC00 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4. \uCD5C\uADFC \uCD9C\uB825\uC744 \uB2E4\uC2DC \uD655\uC778\uD55C \uB4A4 \uBCF4\uB0B4\uC138\uC694.", "The session changed. Check its latest output, then send again.");
    case "failed":
      return t2("\uBCF4\uB0B4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", "Could not send.");
    case "open":
      return t2("\uC774 \uC138\uC158\uC774 \uC9C0\uAE08 \uC5F4\uB824 \uC788\uC5B4 \uC774\uC5B4 \uC5F4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC5F4\uB9B0 \uC138\uC158\uC5D0\uC11C \uB2F5\uD558\uC138\uC694.", "Not resumed: the session is open now. Answer it where it runs.");
  }
}

// src/model.ts
var MAX_REPLY = 8e3;
var CLOSED_MAX_AGE = 7 * 24 * 60 * 60 * 1e3;

// src/summary.ts
function waitingCounts(view) {
  const counts = { permission: 0, reply: 0, review: 0, working: 0 };
  for (const decision of view.decisions) counts[decision.kind] += 1;
  for (const lane of view.projects) counts.working += lane.sessions.filter((session) => session.state === "working").length;
  return counts;
}
var RANK = { blocked: 0, waiting: 1, working: 2, done: 3 };
function laneGroups(lane) {
  const counts = { blocked: 0, waiting: 0, working: 0, done: 0 };
  for (const session of lane.sessions) counts[session.state] += 1;
  const sorted = [...lane.sessions].sort((a, b) => RANK[a.state] - RANK[b.state] || b.since - a.since);
  return { active: sorted.filter((session) => session.state !== "done"), done: sorted.filter((session) => session.state === "done"), counts };
}
function ago(t2, now, at) {
  const seconds = Math.max(0, Math.round((now - at) / 1e3));
  if (seconds < 45) return t2("\uBC29\uAE08", "just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t2(`${minutes}\uBD84 \uC804`, `${minutes}m ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t2(`${hours}\uC2DC\uAC04 \uC804`, `${hours}h ago`);
  return t2(`${Math.round(hours / 24)}\uC77C \uC804`, `${Math.round(hours / 24)}d ago`);
}
var DASHBOARD_DIR = ".coordinator-board";
var DASHBOARD_FILE = DASHBOARD_DIR + "/board.coordinator-board";
var EXCLUDE_LINE = "/" + DASHBOARD_DIR + "/";

// src/dashboard/dom.ts
function h(tag, attrs = null, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === "class") element.className = String(value);
    else if (name === "value") element.value = String(value);
    else if (name === "checked") element.checked = true;
    else if (name === "disabled") element.disabled = true;
    else if (name === "open") element.open = true;
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  append(element, children);
  return element;
}
function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

// src/dashboard/view.ts
var STATES = ["blocked", "waiting", "working", "done"];
function button(label, onClick, options = {}) {
  return h("button", { type: "button", class: options.kind ?? null, disabled: options.disabled, title: options.title ?? null, onClick }, label);
}
function badge(state2, label) {
  return h("span", { class: "badge " + state2 }, label);
}
function details(s, a, key, summary, ...children) {
  return h(
    "details",
    { open: !!s.open[key], onToggle: (event) => a.toggle(key, event.currentTarget.open) },
    h("summary", { class: "muted small" }, summary),
    ...children
  );
}
function header(t2, s, a) {
  const board = s.board;
  const counts = board ? waitingCounts(board) : null;
  const sessions = board ? board.projects.reduce((sum, lane) => sum + lane.sessions.length, 0) : 0;
  const chip = (state2, label, value) => h("span", { class: "chip" + (value ? "" : " zero") }, h("span", { class: "dot " + state2 }), label, h("strong", null, value));
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "title" },
      h("h1", null, t2("\uCF54\uB514\uB124\uC774\uD130 \uBCF4\uB4DC", "Coordinator Board")),
      board && h(
        "div",
        { class: "muted small" },
        `${t2("\uD504\uB85C\uC81D\uD2B8", "Projects")} ${board.projects.length} \xB7 ${t2("\uC138\uC158", "Sessions")} ${sessions} \xB7 ${t2("\uAC31\uC2E0", "Updated")} ${ago(t2, s.now, board.at)}`
      )
    ),
    counts && h(
      "div",
      { class: "chips" },
      chip("blocked", t2("\uAD8C\uD55C \uB300\uAE30", "Permission"), counts.permission),
      chip("waiting", t2("\uB2F5 \uAE30\uB2E4\uB9BC", "Waiting for you"), counts.reply),
      chip("review", t2("\uB9AC\uBDF0 \uAC00\uB2A5", "Ready for review"), counts.review),
      chip("working", t2("\uC791\uC5C5 \uC911", "Working"), counts.working)
    ),
    h(
      "div",
      { class: "actions" },
      button(t2("\uD504\uB85C\uC81D\uD2B8 \uACE0\uB974\uAE30", "Choose projects"), a.openPicker, { kind: "ghost" }),
      button(s.refreshing ? t2("\uC77D\uB294 \uC911", "Loading") : t2("\uC0C8\uB85C \uACE0\uCE68", "Refresh"), a.refresh, { disabled: s.refreshing })
    )
  );
}
function meta(t2, s, decision, session) {
  const where = [decision.projectName, session.workspaceName, session.branch].filter(Boolean).join(" \xB7 ");
  return h("div", { class: "muted small" }, `${where} \xB7 ${ago(t2, s.now, session.since)}`);
}
function permissionCard(t2, s, a, decision) {
  const session = decision.session;
  return h(
    "article",
    { class: "card permission" },
    h("div", { class: "card-head" }, h("h3", { title: session.title }, session.title), badge("blocked", stateLabel(t2, "blocked"))),
    meta(t2, s, decision, session),
    h("div", { class: "small" }, t2(
      "\uAD8C\uD55C \uC694\uCCAD\uC744 \uAE30\uB2E4\uB9AC\uB294 \uC911\uC785\uB2C8\uB2E4. \uBCF4\uB4DC\uB294 \uC774 \uC138\uC158\uC5D0 \uAE00\uC744 \uBCF4\uB0B4\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uC138\uC158\uC5D0\uC11C \uC9C1\uC811 \uC2B9\uC778\uD558\uAC70\uB098 \uAC70\uC808\uD558\uC138\uC694.",
      "This session is waiting for permission. The board never types into it. Approve or deny in the session."
    )),
    h("div", { class: "actions" }, button(openLabel(t2, session), () => a.focus(session)))
  );
}
function openLabel(t2, session) {
  return session.terminalId ? t2("\uC138\uC158 \uC5F4\uAE30", "Open session") : t2("\uCC44\uD305 \uC5F4\uAE30", "Open chat");
}
function chatCard(t2, s, a, decision) {
  const session = decision.session;
  return h(
    "article",
    { class: "card reply" },
    h("div", { class: "card-head" }, h("h3", { title: session.title }, session.title), badge("waiting", stateLabel(t2, "waiting"))),
    meta(t2, s, decision, session),
    h("div", { class: "small" }, t2(
      "\uCC44\uD305 \uD0ED\uC5D0\uC11C \uB3C4\uB294 \uC138\uC158\uC774\uB77C \uBCF4\uB4DC\uC5D0\uC11C \uB2F5\uC744 \uBCF4\uB0BC \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uCC44\uD305 \uC5F4\uAE30\uB85C \uAC00\uC11C \uB2F5\uD558\uC138\uC694.",
      "This session runs in a chat tab, so the board cannot send to it. Open the chat to answer."
    )),
    h(
      "div",
      { class: "actions" },
      button(t2("\uCC44\uD305 \uC5F4\uAE30", "Open chat"), () => a.focus(session), { kind: "primary" }),
      button(t2("\uD655\uC778\uD568", "Mark reviewed"), () => a.dismiss(decision.key), { kind: "ghost" })
    )
  );
}
function replyCard(t2, s, a, decision) {
  const session = decision.session;
  if (!session.terminalId) return chatCard(t2, s, a, decision);
  const terminalId = session.terminalId;
  const busy = !!s.sending[terminalId];
  const receipt = s.receipts[terminalId];
  const send2 = button(busy ? t2("\uBCF4\uB0B4\uB294 \uC911", "Sending") : t2("\uBCF4\uB0B4\uAE30", "Send"), () => a.send(decision), {
    kind: "primary",
    disabled: busy || !(s.drafts[terminalId] ?? "").trim(),
    title: t2("Ctrl+Enter\uB85C \uBCF4\uB0B4\uAE30", "Ctrl+Enter to send")
  });
  const box = h("textarea", {
    rows: 3,
    maxlength: MAX_REPLY,
    placeholder: t2("\uC774 \uC138\uC158\uC5D0 \uBCF4\uB0BC \uB2F5\uC744 \uC4F0\uC138\uC694", "Write your reply to this session"),
    "aria-label": t2("\uB2F5\uC7A5", "Reply"),
    "data-terminal": terminalId,
    value: s.drafts[terminalId] ?? "",
    disabled: busy,
    onInput: (event) => {
      const text = event.currentTarget.value;
      a.draft(terminalId, text);
      send2.disabled = busy || !text.trim();
    },
    onKeydown: (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        if (!send2.disabled) a.send(decision);
      }
    }
  });
  return h(
    "article",
    { class: "card reply" },
    h("div", { class: "card-head" }, h("h3", { title: session.title }, session.title), badge("waiting", stateLabel(t2, "waiting"))),
    meta(t2, s, decision, session),
    decision.tail && decision.tail.length > 0 && h("pre", { class: "tail", "aria-label": t2("\uCD5C\uADFC \uCD9C\uB825", "Recent output") }, decision.tail.join("\n")),
    box,
    receipt && h(
      "div",
      { class: "small", style: receipt.status === "sent" ? null : "color: var(--cb-blocked)" },
      `${replyStatusLabel(t2, receipt.status)} \xB7 ${ago(t2, s.now, receipt.at)}`
    ),
    h(
      "div",
      { class: "actions" },
      send2,
      button(t2("\uC138\uC158 \uC5F4\uAE30", "Open session"), () => a.focus(session), { kind: "ghost" }),
      button(t2("\uD655\uC778\uD568", "Mark reviewed"), () => a.dismiss(decision.key), { kind: "ghost" })
    )
  );
}
function reviewCard(t2, s, a, decision) {
  const pull = decision.pull;
  return h(
    "article",
    { class: "card review" },
    h("div", { class: "card-head" }, h("h3", { title: pull.title }, `${pull.repo}#${pull.number}`), badge("review", pullReasonLabel(t2, pull.reason))),
    h("div", null, pull.title),
    h("div", { class: "muted small" }, `${decision.projectName} \xB7 ${ago(t2, s.now, decision.since)}`),
    h(
      "div",
      { class: "actions" },
      button(t2("GitHub\uC5D0\uC11C \uBCF4\uAE30", "Open on GitHub"), () => a.openUrl(pull.url)),
      button(t2("\uD655\uC778\uD568", "Mark reviewed"), () => a.dismiss(decision.key), { kind: "ghost" })
    )
  );
}
function decisionColumn(t2, s, a, board) {
  const cards = board.decisions.map((decision) => decision.kind === "permission" ? permissionCard(t2, s, a, decision) : decision.kind === "reply" ? replyCard(t2, s, a, decision) : reviewCard(t2, s, a, decision));
  return h(
    "section",
    { class: "column", "aria-label": t2("\uB0B4 \uACB0\uC815", "My decisions") },
    h("div", { class: "column-head" }, h("h2", null, t2("\uB0B4 \uACB0\uC815", "My decisions")), h("span", { class: "count" }, board.decisions.length)),
    cards.length ? cards : h("div", { class: "empty muted" }, t2("\uC9C0\uAE08 \uACB0\uC815\uD560 \uC77C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4", "Nothing needs you right now")),
    history(t2, s, a, board)
  );
}
function history(t2, s, a, board) {
  if (!board.replies.length) return null;
  return h("div", { class: "history" }, details(
    s,
    a,
    "history",
    t2("\uCD5C\uADFC \uBCF4\uB0B8 \uB2F5\uC7A5", "Recent replies"),
    h("ul", null, board.replies.map((reply) => h(
      "li",
      { class: "small" },
      h("span", null, reply.text.split("\n")[0].slice(0, 160)),
      h("span", { class: "muted" }, ` \xB7 ${reply.projectName} \xB7 ${reply.title} \xB7 ${replyStatusLabel(t2, reply.status)} \xB7 ${ago(t2, s.now, reply.at)}`)
    )))
  ));
}
function sessionRow(t2, s, a, session) {
  const go = () => a.focus(session);
  return h(
    "div",
    {
      class: "session",
      role: "button",
      tabindex: 0,
      title: session.terminalId ? t2("\uB20C\uB7EC\uC11C \uC138\uC158 \uC5F4\uAE30", "Open the session") : t2("\uB20C\uB7EC\uC11C \uCC44\uD305\uC774 \uC788\uB294 \uC6CC\uD06C\uC2A4\uD398\uC774\uC2A4 \uC5F4\uAE30", "Open the workspace of this chat"),
      onClick: go,
      onKeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          go();
        }
      }
    },
    h("span", { class: "dot " + session.state }),
    h("span", { class: "name" }, session.title),
    h("span", { class: "where muted small" }, session.workspaceName),
    h("span", { class: "muted small" }, ago(t2, s.now, session.since))
  );
}
function laneCard(t2, s, a, lane) {
  const groups = laneGroups(lane);
  const note = pullStatusNote(t2, lane.pullStatus);
  const total = lane.sessions.length;
  return h(
    "article",
    { class: "card lane" },
    h(
      "div",
      { class: "card-head" },
      h("h3", { title: lane.name }, lane.name),
      h("span", { class: "muted small" }, `${t2("\uC138\uC158", "Sessions")} ${total} \xB7 PR ${lane.pulls.length}`)
    ),
    total > 0 && h(
      "div",
      { class: "bar", title: STATES.map((state2) => `${stateLabel(t2, state2)} ${groups.counts[state2]}`).join(" \xB7 ") },
      STATES.filter((state2) => groups.counts[state2]).map((state2) => h("span", { class: state2, style: `flex: ${groups.counts[state2]}` }))
    ),
    groups.active.length ? h("div", { class: "sessions" }, groups.active.map((session) => sessionRow(t2, s, a, session))) : h("div", { class: "muted small" }, t2("\uC9C4\uD589 \uC911\uC778 \uC138\uC158\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", "No active sessions.")),
    groups.done.length > 0 && details(
      s,
      a,
      "done:" + lane.projectId,
      t2(`\uC644\uB8CC ${groups.done.length}\uAC1C`, `${groups.done.length} done`),
      h("div", { class: "sessions" }, groups.done.map((session) => sessionRow(t2, s, a, session)))
    ),
    lane.pulls.length > 0 && h("div", { class: "pulls" }, lane.pulls.map((pull) => h(
      "div",
      { class: "pull small" },
      h("a", { href: pull.url, title: pull.title, onClick: (event) => {
        event.preventDefault();
        a.openUrl(pull.url);
      } }, `#${pull.number} ${pull.title}`),
      badge(pull.reason === "ready" ? "review" : "", pullReasonLabel(t2, pull.reason))
    ))),
    lane.closed.length > 0 && details(
      s,
      a,
      "closed:" + lane.projectId,
      t2(`\uB2EB\uD78C \uCD5C\uADFC \uC138\uC158 ${lane.closed.length}\uAC1C`, `${lane.closed.length} recently closed`),
      h("div", { class: "closed" }, lane.closed.map((session) => closedRow(t2, s, a, lane, session)))
    ),
    note && h("div", { class: "muted small" }, note)
  );
}
function closedRow(t2, s, a, lane, session) {
  const key = session.key;
  const busy = !!s.sending[key];
  const receipt = s.receipts[key];
  const send2 = button(busy ? t2("\uC774\uC5B4 \uC5EC\uB294 \uC911", "Resuming") : t2("\uC774\uC5B4 \uC5F4\uACE0 \uBCF4\uB0B4\uAE30", "Resume and send"), () => a.resume(lane.name, session), {
    kind: "primary",
    disabled: busy || !(s.drafts[key] ?? "").trim(),
    title: t2("\uC774 \uC138\uC158\uC744 \uC0C8 \uD130\uBBF8\uB110\uC5D0\uC11C \uC774\uC5B4 \uC5F0 \uB4A4 \uB2F5\uC744 \uBCF4\uB0C5\uB2C8\uB2E4", "Resumes this session in a new terminal, then sends your reply")
  });
  return h(
    "div",
    { class: "closed-session" },
    h(
      "div",
      { class: "session" },
      h("span", { class: "dot done" }),
      h("span", { class: "name", title: session.title }, session.title),
      h("span", { class: "where muted small" }, session.workspaceName),
      h("span", { class: "muted small" }, ago(t2, s.now, session.updatedAt))
    ),
    h("textarea", {
      rows: 2,
      maxlength: MAX_REPLY,
      placeholder: t2("\uC774\uC5B4 \uC5F0 \uB4A4 \uBCF4\uB0BC \uB2F5\uC744 \uC4F0\uC138\uC694", "Write the reply to send after resuming"),
      "aria-label": t2("\uB2EB\uD78C \uC138\uC158\uC5D0 \uBCF4\uB0BC \uB2F5", "Reply to the closed session"),
      "data-terminal": key,
      value: s.drafts[key] ?? "",
      disabled: busy,
      onInput: (event) => {
        const text = event.currentTarget.value;
        a.draft(key, text);
        send2.disabled = busy || !text.trim();
      },
      onKeydown: (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
          event.preventDefault();
          if (!send2.disabled) a.resume(lane.name, session);
        }
      }
    }),
    receipt && h(
      "div",
      { class: "small", style: receipt.status === "sent" ? null : "color: var(--cb-blocked)" },
      `${replyStatusLabel(t2, receipt.status)} \xB7 ${ago(t2, s.now, receipt.at)}`
    ),
    h("div", { class: "actions" }, send2)
  );
}
function progressColumn(t2, s, a, board) {
  const sessions = board.projects.reduce((sum, lane) => sum + lane.sessions.length, 0);
  return h(
    "section",
    { class: "column", "aria-label": t2("\uC138\uC158 \uC9C4\uD589", "Session progress") },
    h("div", { class: "column-head" }, h("h2", null, t2("\uC138\uC158 \uC9C4\uD589", "Session progress")), h("span", { class: "count" }, sessions)),
    board.truncated && h("div", { class: "muted small" }, t2("\uC138\uC158\uC774 \uB9CE\uC544 \uC77C\uBD80\uB9CC \uBCF4\uC785\uB2C8\uB2E4.", "Showing only some sessions.")),
    h("div", { class: "lanes" }, board.projects.map((lane) => laneCard(t2, s, a, lane)))
  );
}
function picker(t2, s, a) {
  const list = s.choices;
  const chosen = s.picking ?? [];
  return h(
    "section",
    { class: "card picker" },
    h("h2", null, t2("\uBCF4\uB4DC\uC5D0 \uBAA8\uC744 \uD504\uB85C\uC81D\uD2B8", "Projects on this board")),
    !list ? h("div", { class: "muted" }, t2("\uD504\uB85C\uC81D\uD2B8\uB97C \uC77D\uB294 \uC911", "Loading projects")) : !list.projects.length ? h("div", { class: "muted" }, t2("Orca\uC5D0 \uD504\uB85C\uC81D\uD2B8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4", "Orca has no projects")) : list.projects.map((project) => h(
      "label",
      null,
      h("input", { type: "checkbox", checked: chosen.includes(project.id), onChange: (event) => a.togglePick(project.id, event.currentTarget.checked) }),
      h("span", null, h("div", null, project.name), h("div", { class: "muted small" }, project.remote ? t2("\uB2E4\uB978 \uD638\uC2A4\uD2B8", "Another host") : project.path))
    )),
    h(
      "div",
      { class: "actions" },
      button(t2("\uC800\uC7A5", "Save"), a.savePicker, { kind: "primary", disabled: !list }),
      s.board?.selected.length ? button(t2("\uCDE8\uC18C", "Cancel"), a.closePicker, { kind: "ghost" }) : null
    )
  );
}
function renderApp(t2, s, a) {
  const board = s.board;
  return h(
    "div",
    { class: "app" },
    header(t2, s, a),
    s.error && h("div", { class: "banner", role: "alert" }, `${t2("\uBCF4\uB4DC\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4", "Could not load the board")}: ${s.error}`),
    s.picking ? picker(t2, s, a) : !board ? h("div", { class: "empty muted" }, t2("\uBCF4\uB4DC\uB97C \uC77D\uB294 \uC911", "Loading the board")) : h("div", { class: "layout" }, decisionColumn(t2, s, a, board), progressColumn(t2, s, a, board))
  );
}

// src/dashboard/main.ts
var REFRESH_MS = 3e4;
var t = translator(orca.locale);
var style = document.createElement("style");
style.textContent = STYLE;
document.head.append(style);
var app = document.createElement("div");
document.body.append(app);
var state = {
  board: null,
  error: null,
  choices: null,
  picking: null,
  drafts: {},
  receipts: {},
  sending: {},
  open: {},
  refreshing: false,
  now: Date.now()
};
var message = (error) => error instanceof Error ? error.message : String(error);
var pending = false;
var pressing = false;
function busyTyping() {
  const active = document.activeElement;
  return !!active && active.tagName === "TEXTAREA" && app.contains(active);
}
function draw() {
  if (pressing || busyTyping()) {
    pending = true;
    return;
  }
  pending = false;
  const scroll = window.scrollY;
  state.now = Date.now();
  app.replaceChildren(renderApp(t, state, actions));
  app.querySelectorAll("pre.tail").forEach((tail) => {
    tail.scrollTop = tail.scrollHeight;
  });
  window.scrollTo(0, scroll);
}
window.addEventListener("pointerdown", () => {
  pressing = true;
}, true);
window.addEventListener("pointerup", () => {
  pressing = false;
  if (pending) setTimeout(draw, 0);
}, true);
app.addEventListener("focusout", () => setTimeout(() => {
  if (pending) draw();
}, 0));
var generation = 0;
async function refresh(force = false) {
  const mine = ++generation;
  state.refreshing = true;
  draw();
  try {
    const board = await orca.plugin.request("board.read", { refresh: force, locale: orca.locale });
    if (mine !== generation) return;
    state.board = board;
    state.error = null;
    if (!board.selected.length && !state.picking) await openPicker();
  } catch (error) {
    if (mine === generation) state.error = message(error);
  } finally {
    if (mine === generation) {
      state.refreshing = false;
      draw();
    }
  }
}
var soonTimer;
function soon() {
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = void 0;
    void refresh();
  }, 400);
}
async function openPicker() {
  state.picking = state.board?.selected ? [...state.board.selected] : [];
  draw();
  try {
    const choices = await orca.plugin.request("board.projects");
    state.choices = choices;
    state.picking = [...choices.selected];
  } catch (error) {
    state.error = message(error);
  }
  draw();
}
async function send(decision) {
  const session = decision.session;
  if (!session?.terminalId) return;
  const terminalId = session.terminalId;
  state.sending[terminalId] = true;
  draw();
  try {
    const result = await orca.plugin.request("board.reply", {
      workspaceId: session.workspaceId,
      terminalId,
      text: state.drafts[terminalId] ?? "",
      expectedSince: session.since,
      projectName: decision.projectName,
      workspaceName: session.workspaceName,
      title: session.title
    });
    state.receipts[terminalId] = result;
    if (result.status === "sent") delete state.drafts[terminalId];
  } catch {
    state.receipts[terminalId] = { status: "failed", at: Date.now() };
  } finally {
    delete state.sending[terminalId];
    const active = document.activeElement;
    if (active?.dataset?.terminal === terminalId) active.blur();
    draw();
  }
}
async function resume(projectName, session) {
  const key = session.key;
  state.sending[key] = true;
  draw();
  try {
    const result = await orca.plugin.request("board.resume-reply", {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      agent: session.agent,
      text: state.drafts[key] ?? "",
      projectName,
      workspaceName: session.workspaceName,
      title: session.title
    });
    state.receipts[key] = result;
    if (result.status === "sent") delete state.drafts[key];
  } catch {
    state.receipts[key] = { status: "failed", at: Date.now() };
  } finally {
    delete state.sending[key];
    const active = document.activeElement;
    if (active?.dataset?.terminal === key) active.blur();
    draw();
  }
}
var actions = {
  refresh: () => void refresh(true),
  openPicker: () => void openPicker(),
  togglePick(projectId, on) {
    const ids = (state.picking ?? []).filter((id) => id !== projectId);
    state.picking = on ? [...ids, projectId] : ids;
  },
  savePicker() {
    const projectIds = state.picking ?? [];
    void orca.plugin.request("board.select-projects", { projectIds }).then(() => {
      state.picking = null;
      return refresh(true);
    }).catch((error) => {
      state.error = message(error);
      draw();
    });
  },
  closePicker() {
    state.picking = null;
    draw();
  },
  draft(terminalId, text) {
    state.drafts[terminalId] = text;
  },
  send: (decision) => void send(decision),
  resume: (projectName, session) => void resume(projectName, session),
  focus(session) {
    void orca.plugin.request("board.focus", { terminalId: session.terminalId, workspaceId: session.workspaceId }).catch(() => void 0);
  },
  dismiss(key) {
    void orca.plugin.request("board.dismiss", { key }).catch((error) => {
      state.error = message(error);
      draw();
    });
  },
  openUrl(url) {
    void orca.shell?.openExternal(url);
  },
  toggle(key, open) {
    state.open[key] = open;
  }
};
void orca.document?.get().catch(() => void 0);
orca.plugin.on("board.changed", () => void refresh());
orca.on("agent.status.changed", soon);
orca.on("workspace.created", soon);
orca.on("workspace.removed", soon);
setInterval(() => void refresh(), REFRESH_MS);
void refresh();
