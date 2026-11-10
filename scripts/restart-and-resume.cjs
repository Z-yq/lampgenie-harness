#!/usr/bin/env node
/**
 * restart-and-resume.cjs(2026-10-28):重启网关后**把正在跑的这个会话自己捞回来**。
 *
 * 问题:主 agent 跑在 session-worker 里,worker 是网关 fork 的子进程(ppid 看门狗 + disconnect 自退)。
 * 「重启网关」= 把自己所在的进程树连根拔起:当前任务被 task-manager.restore() 标成
 * cancelled「网关重启中断(可重发)」,没有人在线,任务就此停摆。
 *
 * 解法:把重启动作交给**脱离进程树**的本脚本(setsid 启动,网关死了它照活),它按序做:
 *   1. 落交接文件(.genie/restart-handoff/*.json)——重启前的现场 + 复活后要干的事;
 *   2. 静默 watchdog(否则窗口期它会跟我们抢着起进程;结束后原样重新武装);
 *   3. 复用 scripts/safe-restart-gateway.cjs --force 做真正的停/起/等 HTTP 200(失败重试);
 *   4. **用新网关的 WS 提交一条续跑任务**(同 sessionId + 幂等键),让新 session-worker 起来;
 *   5. 轮询 task.list 确认这条任务真的出现并进入 running,写结果文件。
 * 结果:用户视角只是「面板闪了一下」,agent 自己接着干。
 *
 * 用法(必须由外部 setsid 脱离启动,否则网关一死它跟着死):
 *   setsid nohup node scripts/restart-and-resume.cjs \
 *     --session <sessionId> --instruction-file <abs path> [选项] >/dev/null 2>&1 &
 *   选项:--port <n> --settle-ms <n> --wait-ms <n> --verify-ms <n> --dry-run --no-watchdog
 *   (--instruction 可直接给一句话,与 --instruction-file 二选一)
 * 退出码:0 复活成功;1 参数错误;4 重启失败;5 续跑任务提交失败;6 提交了但没确认到 running。
 *
 * 纪律:--help / --dry-run / 参数不全 一律**不碰进程**;所有杀/起动作只在 main() 里发生。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

const REPO_ROOT = path.resolve(__dirname, "..");
const EXIT = Object.freeze({ ok: 0, usage: 1, restartFailed: 4, submitFailed: 5, notConfirmed: 6 });

function usage() {
  return [
    "用法: node scripts/restart-and-resume.cjs --session <id> (--instruction <文本> | --instruction-file <路径>) [选项]",
    "  --session <id>             目标会话(续跑任务投到同一会话,历史与白板不丢)",
    "  --instruction <文本>       续跑任务书(告诉复活后的自己接着干什么)",
    "  --instruction-file <路径>  从文件读续跑任务书(长文本推荐)",
    "  --port <n>                 网关端口(缺省读 genie.config.json gateway.port,再缺省 7700)",
    "  --settle-ms <n>            停网关前的静置等待,给当前回合落盘(缺省 4000)",
    "  --wait-ms <n>              新网关 HTTP 200 等待(缺省 180000)",
    "  --verify-ms <n>            续跑任务确认 running 的轮询窗口(缺省 120000)",
    "  --dry-run                  只打印将执行的动作,不杀不起不提交",
    "  --no-watchdog              不动 gateway-watchdog(默认会先静默、结束后重新武装)",
    "约定:本脚本**必须由 setsid 脱离启动**,否则随之所在进程树一起被杀。",
    "退出码: 0 复活成功;1 参数错误;4 重启失败;5 提交失败;6 未确认到运行",
  ].join("\n");
}

function positiveNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 需要正数,收到 ${JSON.stringify(v)}`);
  return n;
}

function parseArgs(argv) {
  const out = {
    session: undefined,
    instruction: undefined,
    instructionFile: undefined,
    port: undefined,
    settleMs: 4000,
    waitMs: 180000,
    verifyMs: 120000,
    dryRun: false,
    watchdog: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") out.session = String(argv[++i] ?? "").trim();
    else if (a === "--instruction") out.instruction = String(argv[++i] ?? "");
    else if (a === "--instruction-file") out.instructionFile = String(argv[++i] ?? "");
    else if (a === "--port") out.port = positiveNumber(argv[++i], "--port");
    else if (a === "--settle-ms") out.settleMs = positiveNumber(argv[++i], "--settle-ms");
    else if (a === "--wait-ms") out.waitMs = positiveNumber(argv[++i], "--wait-ms");
    else if (a === "--verify-ms") out.verifyMs = positiveNumber(argv[++i], "--verify-ms");
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-watchdog") out.watchdog = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

/** 参数校验(纯函数):返回错误列表,空数组=可用。-help/--dry-run 也要过这一关,防半残调用。 */
function validateArgs(opts) {
  const errs = [];
  if (!opts.session) errs.push("缺少 --session");
  const hasInline = typeof opts.instruction === "string" && opts.instruction.trim().length > 0;
  const hasFile = typeof opts.instructionFile === "string" && opts.instructionFile.trim().length > 0;
  if (!hasInline && !hasFile) errs.push("缺少 --instruction 或 --instruction-file(续跑任务书)");
  if (hasInline && hasFile) errs.push("--instruction 与 --instruction-file 只能给一个");
  return errs;
}

/** 读续跑任务书:文件优先,去掉首尾空白;空内容算无效。 */
function readInstruction(opts) {
  if (opts.instructionFile) {
    const file = path.resolve(opts.instructionFile);
    const text = fs.readFileSync(file, "utf8").trim();
    if (!text) throw new Error(`续跑任务书为空: ${file}`);
    return { text, source: file };
  }
  const text = String(opts.instruction ?? "").trim();
  if (!text) throw new Error("续跑任务书为空");
  return { text, source: "inline" };
}

/**
 * 续跑任务的 task.submit 帧(纯函数)。幂等键带时间戳:重跑脚本不会重复投递同一批。
 * 注意:服务端会给客户端键统一加 `user.` 前缀,这里**不带**前缀,避免双前缀。
 */
function buildSubmitFrame({ sessionId, instruction, stamp }) {
  return {
    v: 1,
    type: "task.submit",
    sessionId,
    instruction,
    idempotencyKey: `restart-resume-${stamp}`,
  };
}

/**
 * 复活判定(纯函数):在 task.list 快照里找「本次提交产生的那条任务」。
 * sinceAt 用提交前的时间戳兜底(时钟同源),只认同会话 + 创建时间不早于它。
 */
function pickResumeTask(tasks, { sessionId, sinceAt }) {
  const list = Array.isArray(tasks) ? tasks : [];
  const hit = list
    .filter((t) => t && t.sessionId === sessionId && Number(t.createdAt ?? 0) >= sinceAt)
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))[0];
  return hit || undefined;
}

/** 交接文件内容(纯函数):重启前的现场,留给人事后复盘。 */
function buildHandoff({ sessionId, port, oldPid, instruction, source, startedAt }) {
  return {
    at: startedAt,
    sessionId,
    port,
    oldGatewayPid: oldPid ?? null,
    instructionSource: source,
    instructionChars: instruction.length,
    instructionHead: instruction.slice(0, 300),
  };
}

function readConfigPort(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "genie.config.json"), "utf8"));
    const p = Number(cfg && cfg.gateway && cfg.gateway.port);
    return Number.isFinite(p) && p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (rest[0] === "Z") return false;
  } catch { /* 无 /proc */ }
  return true;
}

/** 网关 pid:优先 ss 端口属主(必须 cmdline 像网关),否则 .genie/gateway.pid。 */
function findGatewayPid({ port, root }) {
  const ss = spawnSync("ss", ["-tlnp"], { encoding: "utf8" });
  if (ss.status === 0 && ss.stdout) {
    const re = new RegExp(`[:.]${port}\\s`);
    for (const line of ss.stdout.split("\n")) {
      if (!re.test(line)) continue;
      const m = line.match(/pid=(\d+)/);
      if (!m) continue;
      const pid = Number(m[1]);
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
        if (/gateway\.mjs/.test(args)) return pid;
      } catch { /* 读不到 cmdline 就跳过 */ }
    }
  }
  try {
    const n = Number(fs.readFileSync(path.join(root, ".genie", "gateway.pid"), "utf8").trim());
    if (Number.isInteger(n) && n > 0 && pidAlive(n)) return n;
  } catch { /* 无 pid 文件 */ }
  return undefined;
}

/** 找 gateway-watchdog 进程(排除本脚本路径误命中)。 */
function findWatchdogPids() {
  const pg = spawnSync("pgrep", ["-f", "gateway-watchdog\\.sh"], { encoding: "utf8" });
  if (pg.status !== 0 || !pg.stdout) return [];
  return pg.stdout
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid && pidAlive(n));
}

/** 静默 watchdog:落 stop 标记并等它自己退出(它轮询 10s 一次)。返回「是否原本在跑」。 */
async function quiesceWatchdog({ root, log, enabled }) {
  if (!enabled) {
    log("--no-watchdog:不动 watchdog");
    return { wasRunning: false };
  }
  const pids = findWatchdogPids();
  if (pids.length === 0) {
    log("watchdog 未在跑,跳过静默");
    return { wasRunning: false };
  }
  const stop = path.join(root, ".genie", "gateway.watchdog.stop");
  try { fs.writeFileSync(stop, String(Date.now())); } catch { /* 尽力 */ }
  log(`watchdog 在跑(pid=${pids.join(",")})→ 已落 stop 标记,等待退出`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (findWatchdogPids().length === 0) {
      log("watchdog 已退出");
      return { wasRunning: true };
    }
    await sleep(500);
  }
  log("watchdog 15s 内未退出(继续,端口释放由 safe-restart 兜)");
  return { wasRunning: true };
}

/** 结束后重新武装 watchdog(setsid 脱离,失败只记日志)。 */
function resumeWatchdog({ root, log, wasRunning }) {
  if (!wasRunning) return;
  const script = path.join(root, ".genie", "gateway-watchdog.sh");
  if (!fs.existsSync(script)) {
    log("watchdog 脚本不存在,不重新武装");
    return;
  }
  try {
    const child = spawn("bash", [script], { cwd: root, detached: true, stdio: "ignore" });
    child.unref();
    log(`watchdog 已重新武装 pid=${child.pid ?? "?"}`);
  } catch (err) {
    log(`watchdog 重新武装失败:${String(err && err.message ? err.message : err)}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 调 safe-restart-gateway.cjs --force(它负责停旧/回收锁/起新/等 200),最多重试 retries 次。 */
function runSafeRestart({ root, port, log, retries = 3 }) {
  const script = path.join(root, "scripts", "safe-restart-gateway.cjs");
  if (!fs.existsSync(script)) return { ok: false, error: `缺少 ${script}` };
  let last = "";
  for (let i = 1; i <= retries; i++) {
    const r = spawnSync(process.execPath, [script, "--force", "--port", String(port)], {
      cwd: root,
      encoding: "utf8",
      timeout: 240000,
    });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    last = out;
    for (const line of out.split("\n").filter(Boolean)) log(`safe-restart: ${line}`);
    if (r.status === 0) return { ok: true, output: out, attempts: i };
    log(`safe-restart 第 ${i}/${retries} 次失败(exit=${r.status});${i < retries ? "2s 后重试" : "放弃"}`);
    if (i < retries) spawnSync("sleep", ["2"]);
  }
  return { ok: false, error: last || "safe-restart 未成功" };
}

function loadWs(root) {
  try {
    const req = createRequire(path.join(root, "apps", "gateway", "package.json"));
    return req("ws");
  } catch (err) {
    if (typeof WebSocket === "function") return WebSocket;
    throw new Error(`找不到 ws 依赖:${err && err.message}`);
  }
}

/** 连上新网关提交续跑任务,等 task.submitted 回帧。 */
function submitResumeTask({ port, frame, WebSocketImpl, timeoutMs, log }) {
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
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
      return;
    }
    timer = setTimeout(() => done({ ok: false, error: `task.submitted 超时(${timeoutMs}ms)` }), timeoutMs);
    ws.on("open", () => {
      log(`WS 已连上新网关,提交续跑任务(session=${frame.sessionId})`);
      try { ws.send(JSON.stringify(frame)); } catch (err) { done({ ok: false, error: `发送失败:${String(err)}` }); }
    });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m) return;
      if (m.type === "task.submitted") done({ ok: true, task: m.task });
      else if (m.type === "error") done({ ok: false, error: `${m.code || "?"}:${m.message || ""}` });
    });
    ws.on("error", (err) => done({ ok: false, error: `WS 错误:${err && err.message ? err.message : err}` }));
    ws.on("close", () => done({ ok: false, error: "WS 在收到 task.submitted 前关闭" }));
  });
}

/** 取一次 task.list 快照(WS 协议已就绪的判据之一)。 */
function fetchTaskList({ port, WebSocketImpl, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws && ws.close(); } catch { /* 已关 */ }
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* 已关 */ }
      resolve(v);
    };
    try { ws = new WebSocketImpl(`ws://127.0.0.1:${port}`); } catch (err) { done({ ok: false, error: String(err) }); return; }
    ws.on("open", () => { try { ws.send(JSON.stringify({ v: 1, type: "task.list" })); } catch (err) { done({ ok: false, error: String(err) }); } });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m && m.type === "task.list") done({ ok: true, tasks: m.tasks || [] });
      else if (m && m.type === "error") done({ ok: false, error: `${m.code || "?"}:${m.message || ""}` });
    });
    ws.on("error", () => done({ ok: false, error: "ws error" }));
    ws.on("close", () => done({ ok: false, error: "closed" }));
  });
}

/**
 * 等新网关**任务表也已就绪**(HTTP 200 可能早于 journal 回放完成):
 * 能拿到 task.list 快照才算真的能接活,否则过早提交有被回放覆盖的风险。
 */
async function waitGatewayReady({ port, WebSocketImpl, waitMs, log }) {
  const deadline = Date.now() + waitMs;
  let last = "";
  while (Date.now() < deadline) {
    const snap = await fetchTaskList({ port, WebSocketImpl });
    if (snap.ok) {
      log(`新网关任务表就绪(task.list 返回 ${(snap.tasks || []).length} 条)`);
      return { ok: true };
    }
    last = String(snap.error || "");
    await sleep(1000);
  }
  log(`新网关任务表等待超时:${last}`);
  return { ok: false, error: last };
}

/** 轮询 task.list 直到看到续跑任务并进入 running/done/failed。 */
async function confirmRevived({ port, sessionId, taskId, sinceAt, WebSocketImpl, verifyMs, log }) {
  const deadline = Date.now() + verifyMs;
  let last = "未观察到";
  while (Date.now() < deadline) {
    const snapshot = await fetchTaskList({ port, WebSocketImpl });
    if (snapshot.ok) {
      const hit = (snapshot.tasks || []).find((t) => t && (t.id === taskId || (t.sessionId === sessionId && Number(t.createdAt ?? 0) >= sinceAt)));
      if (hit) {
        last = `${hit.state} ${hit.id}`;
        log(`续跑任务:${last}`);
        if (["running", "done", "failed", "blocked"].includes(String(hit.state))) return { ok: true, task: hit };
      }
    } else {
      last = `task.list 失败(${snapshot.error})`;
    }
    await sleep(5000);
  }
  log(`确认窗口内未看到续跑任务进入运行:${last}`);
  return { ok: false, state: last };
}

function writeResult(root, lines) {
  const file = path.join(root, ".genie", "restart-resume-result.txt");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  } catch { /* 结果文件失败不影响主流程 */ }
  return file;
}

async function main(argv) {
  const startedAt = Date.now();
  const logDir = path.join(REPO_ROOT, ".genie", "logs");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* 尽力 */ }
  const logFile = path.join(logDir, `restart-resume.${new Date(startedAt).toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${process.pid}.log`);
  const logLines = [];
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] [restart-resume ${process.pid}] ${msg}`;
    logLines.push(line);
    try { fs.appendFileSync(logFile, line + "\n"); } catch { /* 尽力 */ }
  };

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[restart-resume] ${err.message}\n${usage()}`);
    return EXIT.usage;
  }
  if (opts.help) {
    console.log(usage());
    return EXIT.ok;
  }
  const errs = validateArgs(opts);
  if (errs.length > 0) {
    console.error(`[restart-resume] ${errs.join(";")}\n${usage()}`);
    return EXIT.usage;
  }
  let instruction;
  try {
    instruction = readInstruction(opts);
  } catch (err) {
    console.error(`[restart-resume] ${err.message}`);
    return EXIT.usage;
  }

  const root = REPO_ROOT;
  const port = opts.port ?? readConfigPort(root) ?? 7700;
  log(`启动(port=${port},session=${opts.session},settle=${opts.settleMs}ms,dryRun=${opts.dryRun})任务书 ${instruction.text.length} 字(来源 ${instruction.source})`);

  // 交接文件:重启前现场,人事后复盘用
  const oldPid = findGatewayPid({ port, root });
  const handoffDir = path.join(root, ".genie", "restart-handoff");
  try {
    fs.mkdirSync(handoffDir, { recursive: true });
    const handoffFile = path.join(handoffDir, `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(handoffFile, JSON.stringify(buildHandoff({ sessionId: opts.session, port, oldPid, instruction: instruction.text, source: instruction.source, startedAt }), null, 2), "utf8");
    log(`交接文件:${handoffFile}`);
  } catch (err) {
    log(`交接文件写入失败(继续):${String(err)}`);
  }

  if (opts.dryRun) {
    log(`dry-run:将静置 ${opts.settleMs}ms → 静默 watchdog → 停旧网关(pid=${oldPid ?? "无"}) → safe-restart --force 起新网关(等 200 至 ${opts.waitMs}ms) → WS 提交续跑任务 → 轮询 ${opts.verifyMs}ms 确认 running`);
    console.log(logLines.join("\n"));
    return EXIT.ok;
  }

  log(`静置 ${opts.settleMs}ms(给当前回合落盘 journal)`);
  await sleep(opts.settleMs);

  const wd = await quiesceWatchdog({ root, log, enabled: opts.watchdog });
  const restarted = runSafeRestart({ root, port, log });
  if (!restarted.ok) {
    log(`重启失败:${restarted.error}`);
    resumeWatchdog({ root, log, wasRunning: wd.wasRunning });
    console.error(logLines.join("\n"));
    writeResult(root, [...logLines.slice(-20), "结果: 重启失败"]);
    return EXIT.restartFailed;
  }
  log(`新网关就绪(第 ${restarted.attempts} 次尝试成功)`);

  const WebSocketImpl = loadWs(root);
  // HTTP 200 只代表面板在听;journal 回放可能还没完。等任务表也能读再提交,
  // 避免「提交了但被启动期状态覆盖」。
  const readyForTasks = await waitGatewayReady({ port, WebSocketImpl, waitMs: Math.min(opts.waitMs, 60000), log });
  if (!readyForTasks.ok) log(`任务表未就绪(继续尝试提交):${readyForTasks.error}`);
  const frame = buildSubmitFrame({ sessionId: opts.session, instruction: instruction.text, stamp: String(startedAt) });
  const submittedAt = Date.now();
  let submitted = { ok: false };
  for (let attempt = 1; attempt <= 5; attempt++) {
    submitted = await submitResumeTask({ port, frame, WebSocketImpl, timeoutMs: 20000, log });
    if (submitted.ok) break;
    log(`提交第 ${attempt}/5 次失败:${submitted.error};3s 后重试`);
    await sleep(3000);
  }
  if (!submitted.ok) {
    log(`续跑任务提交失败:${submitted.error}`);
    resumeWatchdog({ root, log, wasRunning: wd.wasRunning });
    console.error(logLines.join("\n"));
    writeResult(root, [...logLines.slice(-20), "结果: 提交失败"]);
    return EXIT.submitFailed;
  }
  const task = submitted.task || {};
  log(`续跑任务已提交 taskId=${task.id ?? "?"} state=${task.state ?? "?"}`);

  const revived = await confirmRevived({
    port,
    sessionId: opts.session,
    taskId: String(task.id ?? ""),
    sinceAt: submittedAt,
    WebSocketImpl,
    verifyMs: opts.verifyMs,
    log,
  });
  resumeWatchdog({ root, log, wasRunning: wd.wasRunning });

  const newPid = findGatewayPid({ port, root });
  const summary = [
    `时间: ${new Date().toISOString()}`,
    `旧网关 pid: ${oldPid ?? "(无)"}`,
    `新网关 pid: ${newPid ?? "(未识别)"}`,
    `会话: ${opts.session}`,
    `续跑任务: ${task.id ?? "?"}(${revived.ok ? `已确认 ${revived.task.state}` : `未确认:${revived.state}`})`,
    `日志: ${logFile}`,
    `结果: ${revived.ok ? "复活成功" : "提交成功但未确认到运行"}`,
  ];
  writeResult(root, summary);
  console.log(logLines.join("\n"));
  console.log(summary.join("\n"));
  return revived.ok ? EXIT.ok : EXIT.notConfirmed;
}

module.exports = {
  EXIT,
  parseArgs,
  validateArgs,
  readInstruction,
  buildSubmitFrame,
  pickResumeTask,
  buildHandoff,
  findGatewayPid,
  readConfigPort,
  pidAlive,
  usage,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[restart-resume] 未捕获失败:", err && err.stack ? err.stack : err);
      process.exit(EXIT.usage);
    });
}
