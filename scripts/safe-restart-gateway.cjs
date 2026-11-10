#!/usr/bin/env node
/**
 * safe-restart-gateway.cjs(2026-10-25 step-1002B)
 *
 * 目的:重启 7700 前先问网关「现在有没有活跃任务(running/queued/blocked)」,
 * **0 活跃才停旧进程并拉起新进程**;有活跃任务就打印清单并非零退出(不静默杀),
 * 需要强制时显式 `--force`。
 *
 * 流程:
 *   1. WS 连 ws://127.0.0.1:<port>,发 task.list 取任务快照(5s 超时);
 *      连不上(ECONNREFUSED)=网关本来就不在 → 直接走启动;
 *      连上但探测超时/回 error = 状态未知 → 拒绝重启(除非 --force)。
 *   2. 活跃任务>0 且无 --force → 打印任务清单 + 退出码 2。
 *   3. 定位旧进程:--pid > 端口属主(ss -tlnp) > .genie/gateway.pid > pgrep(仅默认端口)。
 *   4. SIGTERM → 等待退出(killTimeoutMs;--force 超时补 SIGKILL)→ 回收陈旧 gateway.lock。
 *   5. setsid 起 node dist/gateway.mjs(日志 .genie/logs/gateway.log.<ts>),等 HTTP 200 后
 *      写 .genie/gateway.pid,再等 **WS hello 就绪探针**(--ws-ready-ms,缺省 300000)。
 *
 * WS 就绪探针(2026-11-09 实测补):HTTP 200 只代表端口先就绪,网关仍在装配(journal 分片
 * 加载实测 704741 行 ≈148s;同日 9p 缓存冷启动 722495 行/314832ms ≈5 分钟),WS upgrade
 * 处理器要等装配完成才挂;此时连 WS 会被回 200
 * (`Unexpected server response: 200`)。所以 HTTP 200 之后必须连 WS 等到一帧才算真就绪;
 * 老协议网关没有 hello 时,收到任意合法 JSON 帧(hello/error/…)即视为可交互。
 * 超时只报未就绪并退 5,**绝不杀进程**(可能只是慢)。
 *
 * 用法:
 *   node scripts/safe-restart-gateway.cjs [--port 7700] [--force] [--dry-run]
 *        [--pid <旧pid>] [--root <仓根>] [--timeout-ms 5000] [--wait-ms 180000]
 *        [--ws-ready-ms 300000] [--kill-timeout-ms 12000]
 * 退出码:0 成功/无事可做;1 参数错误;2 有活跃任务拒绝;3 状态未知拒绝;4 旧进程停不下来;
 *         5 新进程未就绪(HTTP 未 200,或 HTTP 200 但 WS 到超时仍未就绪)。
 *
 * 设计约束:脚本本身不做业务决策(活跃判定复用协议 state 终态集);不依赖 build/重启 7700;
 * 所有「杀/起」动作只在 main() 里发生,纯函数导出便于单测(require 本文件不会执行)。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

const REPO_ROOT = path.resolve(__dirname, "..");
/** 任务终态(与 protocol TaskState 对齐):其余 queued/running/blocked 都算活跃。 */
const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "interrupted"]);
/**
 * interrupted = 进程已死 / 恢复待定,不是正在执行(2026-11-08 实锤:21 条历史 interrupted
 * 让 0 running 的机器永久挡门)。所以它计入终态、不阻断重启,只单列打印计数与 ≤5 条明细。
 */
const INTERRUPTED_STATE = "interrupted";
const INTERRUPTED_DETAIL_LIMIT = 5;
const EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  activeTasks: 2,
  unknown: 3,
  stopFailed: 4,
  startFailed: 5,
});

function usage() {
  return [
    "用法: node scripts/safe-restart-gateway.cjs [选项]",
    "  --port <n>            网关端口(缺省读 genie.config.json gateway.port,再缺省 7700)",
    "  --force               有活跃任务/探测失败/停不下来时仍继续",
    "  --dry-run             只打印将执行的动作,不杀不起",
    "  --pid <n>             显式指定要停的旧进程(测试/特殊场景)",
    "  --root <path>         仓根(缺省=本脚本上一级)",
    "  --timeout-ms <n>      WS task.list 探测超时(缺省 5000)",
    "  --wait-ms <n>         新进程 HTTP 200 就绪等待(缺省 180000)",
    "  --ws-ready-ms <n>     HTTP 200 后等 WS hello 就绪(缺省 300000;老协议任意合法帧即就绪)",
    "                        journal 冷加载实测可达 ~5 分钟(9p 缓存冷),热启动仅数秒",
    "  --kill-timeout-ms <n> SIGTERM 后等待退出(缺省 12000)",
    "退出码: 0 成功;1 参数错误;2 有活跃任务;3 状态未知;4 旧进程未退出;5 新进程未就绪",
  ].join("\n");
}

function positiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 需要正数,收到 ${JSON.stringify(v)}`);
  return n;
}

function parseArgs(argv) {
  const out = {
    port: undefined,
    force: false,
    dryRun: false,
    pid: undefined,
    root: REPO_ROOT,
    timeoutMs: 5000,
    waitMs: 180000,
    wsReadyMs: 300000,
    killTimeoutMs: 12000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = positiveNumber(argv[++i], "--port");
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--pid") out.pid = positiveNumber(argv[++i], "--pid");
    else if (a === "--root") out.root = path.resolve(String(argv[++i]));
    else if (a === "--timeout-ms") out.timeoutMs = positiveNumber(argv[++i], "--timeout-ms");
    else if (a === "--wait-ms") out.waitMs = positiveNumber(argv[++i], "--wait-ms");
    else if (a === "--ws-ready-ms") out.wsReadyMs = positiveNumber(argv[++i], "--ws-ready-ms");
    else if (a === "--kill-timeout-ms") out.killTimeoutMs = positiveNumber(argv[++i], "--kill-timeout-ms");
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

/** 读配置端口;失败返回 undefined(调用方回落 7700)。 */
function readConfigPort(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "genie.config.json"), "utf8"));
    const p = Number(cfg && cfg.gateway && cfg.gateway.port);
    return Number.isFinite(p) && p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

/** journal 目录(锁文件所在);与 main.ts 同口径:相对路径锚定仓根。 */
function readConfigJournalDir(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "genie.config.json"), "utf8"));
    const rel = cfg && cfg.journal && cfg.journal.dir;
    if (typeof rel === "string" && rel.trim()) return path.isAbsolute(rel) ? rel : path.join(root, rel);
  } catch { /* 缺省 */ }
  return path.join(root, ".genie", "journals");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = err && err.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return fs.existsSync(`/proc/${pid}`) ? true : !fs.existsSync("/proc");
  }
  // 僵尸(kill 0 成功但已退出未回收)不算活。
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (rest[0] === "Z" || rest[0] === "X" || rest[0] === "x") return false;
  } catch { /* 无 /proc:按 kill 结果 */ }
  return true;
}

/** 读取网关 pid 文件(纯数字)。 */
function readPidFile(file) {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** 读单实例锁里的 pid(JSON {pid} 或旧纯数字);损坏/不存在返回 undefined。 */
function readLockPid(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (!raw) return undefined;
    const obj = raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw) };
    const n = Number(obj && obj.pid);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** 活跃任务 = state 不在终态集合;返回精简清单(不带 instruction 全文)。 */
function activeTasksOf(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list
    .filter((t) => t && !TERMINAL_STATES.has(String(t.state || "")))
    .map(briefTask);
}

/** 历史中断记录(state=interrupted):只打印、不阻断重启。 */
function interruptedTasksOf(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list.filter((t) => t && String(t.state || "") === INTERRUPTED_STATE).map(briefTask);
}

/** 精简任务清单(不带 instruction 全文)。 */
function briefTask(t) {
  return {
    id: String(t.id || "?"),
    state: String(t.state || "?"),
    title: String(t.title || t.instruction || "").slice(0, 60),
  };
}

/**
 * 纯决策:探测结果 + force → 动作。
 * probe = {ok:true,tasks:[...]} | {ok:false,reason:"connect"|"timeout"|"closed"|...,code?}
 */
function decideRestart({ probe, force }) {
  if (probe && probe.ok) {
    const active = activeTasksOf(probe.tasks);
    // interrupted 只是历史记录:带回给 main 打印计数,但绝不参与截断判定。
    const interrupted = interruptedTasksOf(probe.tasks);
    if (active.length > 0 && !force) return { action: "refuse-active", active, interrupted };
    return { action: "restart", active, interrupted, forced: active.length > 0 };
  }
  const down = Boolean(probe && probe.reason === "connect" && (probe.code === "ECONNREFUSED" || probe.code === "ECONNRESET"));
  if (down) return { action: "restart", active: [], gatewayDown: true };
  if (force) return { action: "restart", active: [], unknownProbe: true };
  return { action: "refuse-unknown", reason: (probe && probe.reason) || "unknown", error: probe && probe.error };
}

/** 优先用全局 WebSocket(Node22+),否则从 apps/gateway 的依赖里取 ws(仓内已安装)。 */
function loadWs(root) {
  try {
    const req = createRequire(path.join(root, "apps", "gateway", "package.json"));
    return req("ws");
  } catch (err) {
    if (typeof WebSocket === "function") return WebSocket;
    throw new Error(`找不到 ws 依赖(在 ${root}/apps/gateway 安装依赖,或升级 Node 22+):${err && err.message}`);
  }
}

/** WS task.list 探测:resolve {ok:true,tasks} 或 {ok:false,reason,code,error}。 */
function probeTasks({ port, timeoutMs, WebSocketImpl }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let ws;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws && ws.close(); } catch { /* 已关 */ }
      resolve(v);
    };
    try {
      ws = new WebSocketImpl(`ws://127.0.0.1:${port}`);
    } catch (err) {
      resolve({ ok: false, reason: "connect", error: String(err && err.message ? err.message : err) });
      return;
    }
    timer = setTimeout(() => done({ ok: false, reason: "timeout" }), timeoutMs);
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify({ v: 1, type: "task.list" }));
      } catch (err) {
        done({ ok: false, reason: "send", error: String(err && err.message ? err.message : err) });
      }
    });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m && m.type === "task.list") done({ ok: true, tasks: m.tasks || [] });
      else if (m && m.type === "error") done({ ok: false, reason: "gateway-error", error: `${m.code || "?"}:${m.message || ""}` });
    });
    ws.on("error", (err) => done({ ok: false, reason: "connect", code: err && err.code, error: err && err.message }));
    ws.on("close", () => done({ ok: false, reason: "closed" }));
  });
}

/**
 * 单帧判定(纯函数,便于单测):
 *  - "hello":握手帧 {"type":"hello"} → 真就绪;
 *  - "frame":任意合法 JSON 对象帧(老协议没有 hello,error/status 等也算)→ 可交互;
 *  - "invalid":坏 JSON / 非对象(忽略,继续等下一帧)。
 */
function classifyWsFrame(raw) {
  let m;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return "invalid";
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return "invalid";
  return m.type === "hello" ? "hello" : "frame";
}

/** 探针结果 → 退出码(纯函数):就绪 = 0;超时/upgrade 被 200 拒/从未连上 = 5(绝不杀进程)。 */
function wsProbeExitCode(result) {
  return result && result.ok === true ? EXIT.ok : EXIT.startFailed;
}

/** 兼容 ws 包(EventEmitter)与 Node 全局 WebSocket(addEventListener)两种实现。 */
function bindWs(ws, ev, fn) {
  if (typeof ws.on === "function") {
    ws.on(ev, fn);
    return;
  }
  if (ev === "message") ws.onmessage = (e) => fn(e && e.data);
  else if (ev === "open") ws.onopen = () => fn();
  else if (ev === "error") ws.onerror = (e) => fn(e);
  else if (ev === "close") ws.onclose = () => fn();
}

/**
 * 一次 WS 连接尝试:连上后等第一帧,hello → {ok:true,hello:true};老协议任意合法帧 →
 * {ok:true,legacy:true}。upgrade 被 HTTP 200 拒(=装配中)/close/无帧超时 → 未就绪。
 */
function probeWsHello({ port, timeoutMs, WebSocketImpl }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let ws;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws && ws.close(); } catch { /* 已关 */ }
      resolve(v);
    };
    try {
      ws = new WebSocketImpl(`ws://127.0.0.1:${port}`);
    } catch (err) {
      resolve({ ok: false, reason: "connect", error: String(err && err.message ? err.message : err) });
      return;
    }
    timer = setTimeout(() => done({ ok: false, reason: "no-frame" }), timeoutMs);
    bindWs(ws, "message", (raw) => {
      const kind = classifyWsFrame(raw);
      if (kind === "hello") done({ ok: true, hello: true });
      else if (kind === "frame") done({ ok: true, legacy: true });
      // invalid:不是网关帧,继续等
    });
    bindWs(ws, "error", (err) => {
      const msg = String((err && err.message) || err || "");
      // upgrade 处理器未挂时,http server 会回 200,ws 客户端报 Unexpected server response: 200
      const rejected = /unexpected server response/i.test(msg);
      done({ ok: false, reason: rejected ? "upgrade-rejected" : "connect", code: err && err.code, error: msg });
    });
    bindWs(ws, "close", () => done({ ok: false, reason: "closed" }));
  });
}

/**
 * WS 就绪等待:反复尝试直到 wsReadyMs;每 attemptTimeoutMs 判一次「连上但无帧」。
 * 网关 HTTP 200 后仍在装配(journal 加载实测 ≈148s),upgrade 会被回 200 —— 这属未就绪,重试。
 */
async function waitWsReady({ port, wsReadyMs, WebSocketImpl, log, retryMs = 500, attemptTimeoutMs = 5000 }) {
  const t0 = Date.now();
  let attempts = 0;
  let last = { ok: false, reason: "no-attempt" };
  let lastLogAt = 0;
  for (;;) {
    const left = wsReadyMs - (Date.now() - t0);
    if (left <= 0) break;
    attempts++;
    last = await probeWsHello({
      port,
      timeoutMs: Math.max(300, Math.min(attemptTimeoutMs, left)),
      WebSocketImpl,
    });
    if (last.ok) return { ...last, waitedMs: Date.now() - t0, attempts };
    const waited = Date.now() - t0;
    // 节流:首次 + 每 15s 一条,装配期 148s 不刷屏
    if (log && (attempts === 1 || waited - lastLogAt >= 15000)) {
      lastLogAt = waited;
      log(`WS 尚未就绪(${last.reason}${last.error ? `:${last.error}` : ""}),已等 ${waited}ms/最多 ${wsReadyMs}ms;继续重试`);
    }
    const left2 = wsReadyMs - (Date.now() - t0);
    if (left2 <= 0) break;
    await sleep(Math.max(0, Math.min(retryMs, left2)));
  }
  return { ...last, ok: false, waitedMs: Date.now() - t0, attempts };
}

function looksLikeGateway(pid) {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (!args) return true; // 读不到内容:保守当网关(不误杀未知进程)
    return /gateway\.mjs|gateway[\\/]src[\\/]main\.ts|genie-gateway/i.test(args);
  } catch {
    return true; // 无 /proc(Windows 等):只能信任 pid 文件/端口属主
  }
}

/**
 * 定位旧进程。portOwner(ss) 最可信;pid 文件需 cmdline 佐证;pgrep 只在默认端口启用
 * (自定义端口的 pgrep 会误选别的网关实例)。
 */
function findGatewayPid({ port, root, overridePid, defaultPort }) {
  if (overridePid) return { pid: overridePid, source: "--pid", verified: true };
  const ss = spawnSync("ss", ["-tlnp"], { encoding: "utf8" });
  if (ss.status === 0 && ss.stdout) {
    const re = new RegExp(`[:.]${port}\\s`);
    for (const line of ss.stdout.split("\n")) {
      if (!re.test(line)) continue;
      const m = line.match(/pid=(\d+)/);
      if (!m) continue;
      const pid = Number(m[1]);
      // 端口属主必须仍是网关:7700 被别的程序占用时,不能「先杀掉它再起网关」。
      if (looksLikeGateway(pid)) return { pid, source: "ss", verified: true };
      return { pid: undefined, source: "ss-unverified", candidatePid: pid, verified: false };
    }
  }
  const fromFile = readPidFile(path.join(root, ".genie", "gateway.pid"));
  if (fromFile && pidAlive(fromFile) && looksLikeGateway(fromFile)) {
    return { pid: fromFile, source: "gateway.pid", verified: true };
  }
  if (defaultPort !== undefined && port === defaultPort) {
    const pg = spawnSync("pgrep", ["-f", "dist/gateway.mjs"], { encoding: "utf8" });
    if (pg.status === 0 && pg.stdout) {
      for (const raw of pg.stdout.split("\n")) {
        const pid = Number(raw.trim());
        if (!Number.isInteger(pid) || pid <= 0) continue;
        if (pid === process.pid) continue;
        if (looksLikeGateway(pid)) return { pid, source: "pgrep", verified: true };
      }
    }
  }
  return { pid: undefined, source: "none", verified: false };
}

/** 回收陈旧锁:持有者活着(或不可判定)就不动;死/僵尸/损坏 → 删除。 */
function reclaimStaleLock(lockPath, log) {
  if (!fs.existsSync(lockPath)) return { removed: false, reason: "absent" };
  const pid = readLockPid(lockPath);
  if (pid && pidAlive(pid)) {
    log(`单实例锁仍被活进程持有(pid=${pid}),不回收:${lockPath}`);
    return { removed: false, reason: "held", pid };
  }
  try {
    fs.unlinkSync(lockPath);
    log(`回收陈旧单实例锁(pid=${pid === undefined ? "未知/损坏" : pid}):${lockPath}`);
    return { removed: true, reason: "stale", pid };
  } catch (err) {
    log(`陈旧单实例锁删除失败(${err && err.code ? err.code : err}):${lockPath}`);
    return { removed: false, reason: "unlink-failed", pid, error: String(err) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** SIGTERM → 等退出;--force 超时补 SIGKILL。 */
async function stopGateway({ pid, killTimeoutMs, force, log }) {
  if (!pid || !pidAlive(pid)) return { ok: true, already: true };
  log(`停止旧网关 pid=${pid}(SIGTERM)`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if (err && err.code === "ESRCH") return { ok: true, already: true };
    return { ok: false, error: `SIGTERM 失败:${err && err.code ? err.code : err}` };
  }
  const deadline = Date.now() + killTimeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return { ok: true, stopped: true };
    await sleep(200);
  }
  if (!force) return { ok: false, error: `pid=${pid} 在 ${killTimeoutMs}ms 内未退出(可 --force 强杀)` };
  log(`pid=${pid} 超时未退出,--force → SIGKILL`);
  try { process.kill(pid, "SIGKILL"); } catch (err) { if (!(err && err.code === "ESRCH")) return { ok: false, error: `SIGKILL 失败:${err && err.code ? err.code : err}` }; }
  for (let i = 0; i < 25; i++) {
    if (!pidAlive(pid)) return { ok: true, killed: true };
    await sleep(200);
  }
  return { ok: false, error: `pid=${pid} SIGKILL 后仍未退出` };
}

/** 轮询 HTTP 200(面板/网关同端口)。000=未在听。 */
function httpCode(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(Number(res.statusCode) || 0);
    });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
  });
}

async function waitHttpReady({ port, waitMs, log }) {
  const t0 = Date.now();
  let code = 0;
  while (Date.now() - t0 < waitMs) {
    code = await httpCode(port);
    if (code === 200) return { ok: true, code, waitedMs: Date.now() - t0 };
    await sleep(500);
  }
  log(`等待 HTTP 200 超时(${waitMs}ms),最后状态码=${code || "000"}`);
  return { ok: false, code, waitedMs: Date.now() - t0 };
}

/** OOM 堆取证参数(纯函数,便于单测;与 gateway-watchdog.sh 同参,**必须两处一致**):
 *  - --max-old-space-size=6144:巨型会话投影把缺省 2GB 堆打穿成 OOM 崩溃循环的实锤
 *    (2026-11-03),缺此参数的任何启动路径都是崩溃循环的复活口。
 *  - --report-on-fatalerror + --diagnostic-dir=<root>/.genie/heap-reports:OOM/致命错误时在
 *    诊断目录留下报告(堆快照/摘要),否则崩溃只剩 exit code,拿不到堆证据。
 * 顺序固定(测试断言 + 人工排障可读性)。 */
function gatewaySpawnArgs(entry, root) {
  return [
    "--max-old-space-size=6144",
    "--report-on-fatalerror",
    `--diagnostic-dir=${path.join(root, ".genie", "heap-reports")}`,
    entry,
  ];
}

/** setsid 脱离式启动 node dist/gateway.mjs;返回新 pid 与日志路径。 */
function startGateway({ root, log }) {
  const gwDir = path.join(root, "apps", "gateway");
  const entry = path.join(gwDir, "dist", "gateway.mjs");
  if (!fs.existsSync(entry)) return { ok: false, error: `未构建:${entry} 不存在(先 pnpm -F @lampgenie/gateway build)` };
  const logDir = path.join(root, ".genie", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  // 诊断目录必须先存在:node --diagnostic-dir 不自动创建,目录缺失时报告会被丢弃。
  fs.mkdirSync(path.join(root, ".genie", "heap-reports"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + `-${process.pid}`;
  const logPath = path.join(logDir, `gateway.log.${stamp}`);
  const out = fs.openSync(logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, gatewaySpawnArgs(entry, root), {
      cwd: gwDir,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, GENIE_STARTED_BY: "safe-restart" },
    });
  } finally {
    fs.closeSync(out);
  }
  child.unref();
  log(`新网关已启动 pid=${child.pid},log=${logPath}`);
  return { ok: true, pid: child.pid, logPath };
}

function writePidFile(root, pid) {
  const file = path.join(root, ".genie", "gateway.pid");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${pid}.tmp`;
    fs.writeFileSync(tmp, String(pid), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

async function main(argv) {
  const log = (msg) => console.log(`[safe-restart] ${msg}`);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[safe-restart] ${err.message}\n${usage()}`);
    return EXIT.usage;
  }
  if (opts.help) {
    console.log(usage());
    return EXIT.ok;
  }
  const root = opts.root;
  const configPort = readConfigPort(root);
  const defaultPort = configPort !== undefined ? configPort : 7700;
  const port = opts.port !== undefined ? opts.port : defaultPort;
  log(`目标 :${port}(root=${root}${opts.dryRun ? ",dry-run" : ""}${opts.force ? ",force" : ""})`);

  const WebSocketImpl = loadWs(root);
  const probe = await probeTasks({ port, timeoutMs: opts.timeoutMs, WebSocketImpl });
  const decision = decideRestart({ probe, force: opts.force });

  if (decision.action === "refuse-active") {
    console.error(`[safe-restart] 拒绝重启:${decision.active.length} 个活跃任务在跑(不静默杀;处理完再试,或 --force)`);
    for (const t of decision.active) console.error(`  - ${t.state} ${t.id} ${t.title}`);
    const interruptedCount = (decision.interrupted || []).length;
    if (interruptedCount > 0) console.error(`[safe-restart] 另有 ${interruptedCount} 条 interrupted 历史记录(不阻断,处理完活跃任务后可重启)`);
    return EXIT.activeTasks;
  }
  if (decision.action === "refuse-unknown") {
    console.error(`[safe-restart] 拒绝重启:无法确认活跃任务状态(${decision.reason}${decision.error ? `:${decision.error}` : ""});确认后可 --force`);
    return EXIT.unknown;
  }
  if (decision.gatewayDown) log("网关未在听(ECONNREFUSED)→ 直接启动");
  if (decision.unknownProbe) log("--force:探测失败仍继续(无法确认活跃任务)");
  if (decision.forced) {
    log(`--force:忽略 ${decision.active.length} 个活跃任务`);
    for (const t of decision.active) log(`  - ${t.state} ${t.id} ${t.title}`);
  }
  const interrupted = decision.interrupted || [];
  if (interrupted.length > 0) {
    log(`另有 ${interrupted.length} 条 interrupted 历史记录(不阻断)`);
    for (const t of interrupted.slice(0, INTERRUPTED_DETAIL_LIMIT)) log(`  - interrupted ${t.id} ${t.title}`);
    if (interrupted.length > INTERRUPTED_DETAIL_LIMIT) {
      log(`  … 其余 ${interrupted.length - INTERRUPTED_DETAIL_LIMIT} 条略`);
    }
  }

  const found = findGatewayPid({ port, root, overridePid: opts.pid, defaultPort });
  if (found.pid) log(`旧进程 pid=${found.pid}(来源:${found.source})`);
  else log("未定位到旧进程(可能已经停止)");
  if (found.candidatePid) {
    console.error(`[safe-restart] 端口 ${port} 被非网关进程占用(pid=${found.candidatePid},来源:${found.source});拒绝停止/启动(避免误杀)`);
    return EXIT.stopFailed;
  }

  const lockPath = path.join(readConfigJournalDir(root), "gateway.lock");

  if (opts.dryRun) {
    log(`dry-run:将停止 pid=${found.pid ?? "(无)"} → 回收陈旧锁 → 启动 ${path.join(root, "apps/gateway/dist/gateway.mjs")} → 等 HTTP 200 → 等 WS hello(≤${opts.wsReadyMs}ms)`);
    return EXIT.ok;
  }

  if (!found.pid && !decision.gatewayDown) {
    console.error("[safe-restart] 端口在听但无法定位网关进程(ss/pid 文件/pgrep 均未命中);拒绝盲目启动(会 EADDRINUSE)");
    return EXIT.stopFailed;
  }

  if (found.pid) {
    const stopped = await stopGateway({ pid: found.pid, killTimeoutMs: opts.killTimeoutMs, force: opts.force, log });
    if (!stopped.ok) {
      console.error(`[safe-restart] 停止旧进程失败:${stopped.error}`);
      return EXIT.stopFailed;
    }
    log(stopped.already ? "旧进程已不存在" : "旧进程已退出");
    // 等端口真正释放(最多 5s;不阻塞也不把旧连接算成新实例)。
    for (let i = 0; i < 10; i++) {
      if ((await httpCode(port, 500)) === 0) break;
      await sleep(500);
    }
  }

  reclaimStaleLock(lockPath, log);

  const started = startGateway({ root, log });
  if (!started.ok) {
    console.error(`[safe-restart] 启动失败:${started.error}`);
    return EXIT.startFailed;
  }
  const ready = await waitHttpReady({ port, waitMs: opts.waitMs, log });
  if (!ready.ok) {
    console.error(`[safe-restart] 新进程未就绪(pid=${started.pid},http=${ready.code || "000"});日志:${started.logPath}`);
    return EXIT.startFailed;
  }
  // HTTP 200 只代表端口先就绪:网关还在装配(journal 分片加载实测 ≈148s),WS upgrade
  // 处理器装配完才挂。pid 文件先写(进程已真实存在),再等 WS 帧确认可交互。
  const wrote = writePidFile(root, started.pid);
  log(`HTTP 200(等待 ${ready.waitedMs}ms)→ 等 WS hello 就绪(最多 ${opts.wsReadyMs}ms)`);
  const wsReady = await waitWsReady({ port, wsReadyMs: opts.wsReadyMs, WebSocketImpl, log });
  if (wsProbeExitCode(wsReady) !== EXIT.ok) {
    console.error(`[safe-restart] 新进程 HTTP 200 但 WS 到 ${opts.wsReadyMs}ms 仍未就绪(${wsReady.reason}${wsReady.error ? `:${wsReady.error}` : ""};尝试 ${wsReady.attempts} 次)`);
    console.error("[safe-restart] 进程仍在装配,不是失败:journal 分片加载耗时可达数分钟(实测 704741 行 ≈148s;9p 缓存冷启动 722495 行/314832ms ≈5 分钟),WS 在装配完成后才 attach;脚本不会杀进程。");
    console.error(`[safe-restart] 可加大 --ws-ready-ms(当前 ${opts.wsReadyMs})后重跑,或稍后手动跑 WS 探针;日志:${started.logPath}`);
    console.error("[safe-restart] journal 冷加载实测可达 ~5 分钟(9p 缓存冷);可先 --dry-run 看进程存活,或稍后手动跑 WS 探针。");
    return wsProbeExitCode(wsReady);
  }
  log(`WS 就绪(${wsReady.hello ? "hello 帧" : "老协议任意帧"},等待 ${wsReady.waitedMs}ms)`);
  log(`重启完成 pid=${started.pid},HTTP 200 + WS hello,等待 ${ready.waitedMs + wsReady.waitedMs}ms${wrote ? "" : "(pid 文件写入失败)"}`);
  return EXIT.ok;
}

module.exports = {
  EXIT,
  TERMINAL_STATES,
  parseArgs,
  readConfigPort,
  readConfigJournalDir,
  readPidFile,
  readLockPid,
  pidAlive,
  activeTasksOf,
  interruptedTasksOf,
  decideRestart,
  probeTasks,
  classifyWsFrame,
  wsProbeExitCode,
  probeWsHello,
  waitWsReady,
  findGatewayPid,
  reclaimStaleLock,
  stopGateway,
  waitHttpReady,
  gatewaySpawnArgs,
  startGateway,
  writePidFile,
  main,
  usage,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[safe-restart] 未捕获失败:", err && err.stack ? err.stack : err);
      process.exit(EXIT.usage);
    });
}
