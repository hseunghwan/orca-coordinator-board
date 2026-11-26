// Screenshots the harness in a local headless Chrome or Edge over the DevTools protocol, waiting in
// real time so ResizeObserver layouts settle: node dev/shoot.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const browsers = [
  process.env.BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);
const browser = browsers.find(path => existsSync(path));
if (!browser) throw new Error("No Chrome or Edge found; set BROWSER to its path.");

const page = pathToFileURL(resolve("dev/out/index.html")).href;
const press = (...labels) => "&press=" + encodeURIComponent(labels.join(","));
const shots = [
  ["inbox-light-wide", "theme=light", 1280, 800],
  ["inbox-dark-wide", "theme=dark", 1280, 800],
  ["inbox-light-narrow", "theme=light", 520, 800],
  ["inbox-dark-narrow", "theme=dark", 520, 800],
  ["inbox-light-narrow-detail", "theme=light" + press("결제 웹훅"), 520, 800],
  ["inbox-dark-narrow-detail", "theme=dark" + press("결제 웹훅"), 520, 800],
  ["inbox-light-evidence", "theme=light" + press("결제 웹훅", "근거 보기"), 1280, 800],
  ["inbox-dark-permission", "theme=dark" + press("응답을 기다리는"), 1280, 800],
  ["progress-light-wide", "theme=light" + press("진행"), 1280, 1000],
  ["progress-dark-wide", "theme=dark" + press("진행"), 1280, 1000],
  ["progress-dark-narrow", "theme=dark" + press("진행"), 520, 1000],
  ["history-dark-wide", "theme=dark" + press("기록"), 1280, 500],
  ["settings-light", "theme=light" + press("설정", "보드에서 관리할"), 1280, 700],
  ["classic-dark-wide", "theme=dark&view=classic", 1280, 1000],
  ["focus-light-wide", "theme=light&view=focus", 1280, 500],
  ["inbox-en-dark-wide", "theme=dark&lang=en", 1280, 800],
  ["inbox-empty-light", "theme=light&empty=1", 1280, 500],
];

const profile = mkdtempSync(join(tmpdir(), "board-shots-"));
const chrome = spawn(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
  "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const endpoint = await new Promise((done, fail) => {
  let seen = "";
  chrome.stderr.on("data", chunk => {
    seen += chunk;
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
    if (match) done(match[1]);
  });
  chrome.on("exit", () => fail(new Error("Browser exited: " + seen)));
});
const port = new URL(endpoint).port;
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(done => socket.addEventListener("open", done, { once: true }));
let next = 0;
const waiting = new Map();
const listeners = new Set();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message.result); waiting.delete(message.id); }
  else for (const listener of listeners) listener(message);
});
const send = (method, params = {}) => new Promise(done => { const id = ++next; waiting.set(id, done); socket.send(JSON.stringify({ id, method, params })); });
const loaded = () => new Promise(done => { const on = message => { if (message.method === "Page.loadEventFired") { listeners.delete(on); done(); } }; listeners.add(on); });
const sleep = ms => new Promise(done => setTimeout(done, ms));

await send("Page.enable");
mkdirSync("dev/shots", { recursive: true });
try {
  for (const [name, query, width, height] of shots) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const load = loaded();
    await send("Page.navigate", { url: `${page}?${query}` });
    await load;
    await sleep(1500);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const out = resolve("dev/shots", name + ".png");
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(out);
  }
} finally {
  socket.close();
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
