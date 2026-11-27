"use strict";

// src/cli/main.ts
var import_node_fs2 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path3 = require("node:path");

// src/channel/path.ts
var import_node_crypto = require("node:crypto");
var import_node_path = require("node:path");
function channelPath(pluginRoot, platform, tmp) {
  const path = platform === "win32" ? import_node_path.win32 : import_node_path.posix;
  const root = path.resolve(pluginRoot);
  const id = (0, import_node_crypto.createHash)("sha256").update(platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 12);
  return platform === "win32" ? `\\\\.\\pipe\\orca-coordinator-board-${id}` : path.join(tmp, `orca-coordinator-board-${id}.sock`);
}

// src/cli/orca.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");

// src/orca/locate.ts
var import_node_path2 = require("node:path");
function locateOrca(input) {
  const { platform, env } = input;
  const path = platform === "win32" ? import_node_path2.win32 : import_node_path2.posix;
  const exe = platform === "win32" ? "orca.exe" : "orca";
  const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Local") : void 0);
  const candidates = [
    env.ORCA_CLI_COMMAND,
    env.ORCA_CLI_BIN_DIR && path.join(env.ORCA_CLI_BIN_DIR, exe),
    path.join(path.dirname(input.execPath), "resources", "bin", exe),
    platform === "win32" && localAppData ? path.join(localAppData, "Programs", "orca", "resources", "bin", exe) : void 0
  ];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || /\.(?:cmd|bat)$/i.test(candidate)) continue;
    if (input.exists(candidate)) return candidate;
  }
  return null;
}

// src/cli/orca.ts
function runOrcaHere(env) {
  const exe = locateOrca({ platform: process.platform, execPath: env.CB_NODE || process.execPath, env, exists: import_node_fs.existsSync });
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return (args, timeoutMs) => new Promise((resolve) => {
    if (!exe) return resolve({ stdout: "", error: { code: "spawn_failed", message: "orca not found beside " + (env.CB_NODE || process.execPath) } });
    (0, import_node_child_process.execFile)(exe, [...args], { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childEnv, encoding: "utf8" }, (error, stdout) => {
      if (error && error.killed) return resolve({ stdout: "", error: { code: "timeout", message: "orca did not answer in time" } });
      if (stdout || !error) return resolve({ stdout, error: null });
      const errno = error.code;
      resolve({ stdout: "", error: { code: errno === "ENOENT" || errno === "EACCES" ? "spawn_failed" : "exec_failed", message: error.message } });
    });
  });
}

// src/cli/run.ts
var import_node_net = require("node:net");

// src/channel/names.ts
var COMMANDS = ["read", "classify", "plan", "assign", "fact", "review", "report"];
var EXIT = { ok: 0, error: 1, absent: 2, dropped: 3, denied: 4 };
var MAX_LINE = 1 << 20;

// src/cli/run.ts
var USAGE = [
  "Usage: coordinator-board <command> [options]",
  "",
  "Commands (one per Paseo coordinator tool):",
  '  read [--session <id>]                     list managed sessions (your own row has "self": true), or read one',
  "                                            session's recent turns and evidenceId",
  "  classify --session <id> --evidence <id> --kind question|review|idle --text-file <path|->",
  "                                            record a judgment on the session's card (content via --input-file)",
  "  report --kind question|review|done --text-file <path|->",
  "                                            post a question or a result on your own card",
  "  fact --cycle <cycleId> --session <id> --evidence <id>",
  "                                            during a digest that names a cycle, answer a board fact for that session",
  "  review [--input-file <path|->]            without input, close merged-only records and list checks to review;",
  '                                            with {"review":{key,fingerprint,evidenceId,quote}}, close one finished check',
  "  plan [--input-file <path|->]               list managed projects, workspaces, sessions and the route for each grade",
  '                                            ({"needsHooks":true} when the work needs Claude Code or Codex hooks)',
  '  assign --input-file <path|->              start one worker for a job: {"job":{projectId,workspaceId,grade,title,prompt,',
  "                                            requestKey,expectedRoute,expectedModeId?}}; the same requestKey never starts twice",
  "",
  "Options:",
  "  --input-file <path|->   the full input as a JSON object; flags override its fields",
  "  --text-file <path|->    free text ('-' reads stdin); never pass free text as an argument",
  "  --as <sessionId>        a chat session reporting on its own card (report only)",
  "",
  "Exit codes: 0 done, 1 command error, 2 board not running, 3 connection lost after sending, 4 not allowed."
].join("\n");
var FLAGS = { "--session": "sessionId", "--evidence": "evidenceId", "--kind": "kind", "--cycle": "cycleId" };
async function parseArgs(argv, io) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") return { help: true };
  if (!COMMANDS.includes(command)) return { error: "unknown command: " + command };
  let input = {};
  const set = {};
  let as = null;
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (name === "--help") return { help: true };
    if (value === void 0) return { error: "missing value for " + name };
    if (name === "--input-file") {
      const parsed = JSON.parse(await io.readText(value));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "--input-file must hold a JSON object" };
      input = parsed;
    } else if (name === "--text-file") set.text = await io.readText(value);
    else if (name === "--as") as = value;
    else if (FLAGS[name]) set[FLAGS[name]] = value;
    else return { error: "unknown option: " + name };
  }
  return { command, input: { ...input, ...set }, as };
}
async function runCli(argv, io) {
  let parsed;
  try {
    parsed = await parseArgs(argv, io);
  } catch (error) {
    io.stderr("coordinator-board: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return EXIT.error;
  }
  if ("help" in parsed) {
    io.stdout(USAGE + "\n");
    return EXIT.ok;
  }
  if ("error" in parsed) {
    io.stderr("coordinator-board: " + parsed.error + "\n\n" + USAGE + "\n");
    return EXIT.error;
  }
  const caller = {
    terminal: io.env.CB_TERMINAL || null,
    token: io.env.CB_CALLER_TOKEN || null,
    session: parsed.as
  };
  const line = JSON.stringify({ v: 2, command: parsed.command, input: parsed.input, caller }) + "\n";
  if (line.length > MAX_LINE) {
    io.stderr("coordinator-board: input too long\n");
    return EXIT.error;
  }
  const path = io.env.CB_PIPE || io.defaultPipe;
  return new Promise((resolve) => {
    let sent = false;
    let buffer = "";
    let settled = false;
    const finish = (code, text, toErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (text) (toErr ? io.stderr : io.stdout)(text.endsWith("\n") ? text : text + "\n");
      resolve(code);
    };
    const socket = (0, import_node_net.connect)(path, () => {
      sent = true;
      socket.write(line);
    });
    const timer = setTimeout(() => finish(sent ? EXIT.dropped : EXIT.absent, sent ? "coordinator-board: no answer from the board in time; the command may have run. Read the board before running it again." : "coordinator-board: the Coordinator Board plugin did not answer.", true), io.timeoutMs ?? 12e4);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0 && !settled; end = buffer.indexOf("\n")) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return finish(EXIT.dropped, "coordinator-board: the board sent an unreadable answer; the command may have run.", true);
        }
        if (message.kind === "exec") {
          const frame = message;
          const run = io.runOrca ? io.runOrca(frame.args, frame.timeoutMs) : Promise.resolve({ stdout: "", error: { code: "spawn_failed", message: "this command cannot run orca" } });
          void run.catch((error) => ({ stdout: "", error: { code: "exec_failed", message: error instanceof Error ? error.message : String(error) } })).then(({ stdout, error }) => {
            const result = { kind: "exec-result", id: frame.id, stdout, error };
            if (!socket.destroyed) socket.write(JSON.stringify(result) + "\n");
          });
          continue;
        }
        const reply = message;
        return finish(reply.exit, reply.text, reply.exit !== EXIT.ok);
      }
    });
    socket.on("error", () => finish(sent ? EXIT.dropped : EXIT.absent, sent ? "coordinator-board: the connection broke; the command may have run. Read the board before running it again." : "coordinator-board: the Coordinator Board plugin is not running in Orca.", true));
    socket.on("close", () => finish(sent ? EXIT.dropped : EXIT.absent, sent ? "coordinator-board: the board closed the connection; the command may have run." : "coordinator-board: the Coordinator Board plugin is not running in Orca.", true));
  });
}

// src/cli/main.ts
void runCli(process.argv.slice(2), {
  env: process.env,
  readText: async (path) => (0, import_node_fs2.readFileSync)(path === "-" ? 0 : path, "utf8"),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  defaultPipe: channelPath((0, import_node_path3.dirname)(__dirname), process.platform, (0, import_node_os.tmpdir)()),
  runOrca: runOrcaHere(process.env)
}).then((code) => {
  process.exitCode = code;
});
