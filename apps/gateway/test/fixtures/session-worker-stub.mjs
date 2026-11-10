/**
 * 会话 worker 协议桩(测试夹具):按 STUB_MODE 演协议——happy(journal 上行+done)/
 * rpc(readSession 请求→回包校验)/cancel(等 cancel→cancelled)。
 * 入参 argv[2]=描述符文件;env STUB_MODE 选场景。
 */
import { readFileSync, writeFileSync as wfs, mkdirSync as mkd } from "node:fs";
import { join as joinP, dirname as dirP } from "node:path";

const spec = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const sid = spec.task.sessionId;
const send = (m) => { try { process.send(m); } catch { /* 已断 */ } };
const mode = process.env.STUB_MODE ?? "happy";

send({ t: "ready", pid: process.pid });

if (mode === "happy") {
  setTimeout(() => {
    send({ t: "journal.append", events: [
      { kind: "message.user", sessionId: sid, payload: { text: "stub-hello" }, time: Date.now() },
    ] });
    send({ t: "subagent.mirror", entries: [{ agentId: "agent_stub1", outputFile: "/tmp/stub-output.txt", status: "running", sessionId: sid, title: "桩子代理", lastEventAt: Date.now() }] });
    setTimeout(() => { send({ t: "task.state", taskId: spec.task.id, state: "done", result: "stub 完成" }); setTimeout(() => process.exit(0), 50); }, Number(process.env.STUB_HOLD_MS ?? 150));
  }, 80);
} else if (mode === "rpc") {
  send({ t: "req", id: 1, kind: "journal.readSession", payload: { sessionId: sid } });
  const timer = setTimeout(() => { send({ t: "task.state", taskId: spec.task.id, state: "failed", error: "rpc 超时" }); process.exit(1); }, 8000);
  process.on("message", (m) => {
    if (m.t === "res" && m.id === 1) {
      clearTimeout(timer);
      send({ t: "journal.append", events: [{ kind: "message.agent", sessionId: sid, payload: { text: `rpc 回包事件数=${Array.isArray(m.value) ? m.value.length : -1}` } }] });
      send({ t: "task.state", taskId: spec.task.id, state: "done", result: "rpc ok" });
      setTimeout(() => process.exit(0), 50);
    }
  });
} else if (mode === "cancel") {
  const timer = setTimeout(() => { send({ t: "task.state", taskId: spec.task.id, state: "failed", error: "等 cancel 超时" }); process.exit(1); }, 8000);
  process.on("message", (m) => {
    if (m.t === "cancel") {
      clearTimeout(timer);
      send({ t: "task.state", taskId: spec.task.id, state: "cancelled" });
      setTimeout(() => process.exit(0), 50);
    }
  });
} else if (mode === "board") {
  // 白板中继桩(n5):worker 上行 board.update + board.comment,host 应中继成 gateway bus 的 board.changed。
  setTimeout(() => {
    send({ t: "journal.append", events: [
      { kind: "board.update", sessionId: sid, payload: { taskId: "t-board-1", rev: 3, nodeCount: 2, edgeCount: 1, status: "draft" }, time: Date.now() },
      { kind: "board.comment", sessionId: sid, payload: { taskId: "t-board-1", nodeId: "n1", text: "评论" }, time: Date.now() },
      { kind: "message.user", sessionId: sid, payload: { text: "board-stub-nonboard" }, time: Date.now() },
    ] });
    setTimeout(() => { send({ t: "task.state", taskId: spec.task.id, state: "done", result: "board 桩完成" }); setTimeout(() => process.exit(0), 50); }, Number(process.env.STUB_HOLD_MS ?? 150));
  }, 80);
} else if (mode === "journalsync") {
 // 写前屏障桩:按序发 appendSync(带一条事件)与 flushStrict,把两次 ack 回写 journal,
  // 供 host 侧断言「落账 + flush 都成功才 ok」与失败分支。
  const listeners = {};
  process.on("message", (m) => { if (m.t === "res" && listeners[m.id]) { listeners[m.id](m); delete listeners[m.id]; } });
  const ask = (id, kind, payload) => new Promise((resolve) => { listeners[id] = resolve; send({ t: "req", id, kind, payload }); });
  const timer = setTimeout(() => { send({ t: "task.state", taskId: spec.task.id, state: "failed", error: "journalsync 超时" }); process.exit(1); }, 8000);
  const a = await ask(1, "journal.appendSync", { events: [{ kind: "message.agent", sessionId: sid, payload: { text: "sync-evt" }, time: Date.now() }] });
  // appendSync 失败(落账/flush 失败)时 worker 侧同样不会继续发纯屏障 RPC——桩如实模拟。
  const b = a.ok ? await ask(2, "journal.flushStrict", {}) : { ok: false, error: "skipped(appendSync 失败)" };
  clearTimeout(timer);
  send({ t: "journal.append", events: [{ kind: "custom", sessionId: sid, payload: { what: "journalsync.ack", a: { ok: a.ok, error: a.error ?? null }, b: { ok: b.ok, error: b.error ?? null } } }] });
  send({ t: "task.state", taskId: spec.task.id, state: "done", result: "journalsync 完成" });
  setTimeout(() => process.exit(0), 50);
} else if (mode === "badversion") {
  // 版本握手桩:期望 spec.protocolVersion===99,不匹配即 fail-visible(真 worker 同型校验)
  if (spec.protocolVersion !== 99) {
    send({ t: "task.state", taskId: spec.task.id, state: "failed", error: `会话 worker 协议版本不匹配(host=${spec.protocolVersion}, worker=99)` });
    setTimeout(() => process.exit(2), 50);
  } else {
    send({ t: "task.state", taskId: spec.task.id, state: "done", result: "版本匹配" });
    setTimeout(() => process.exit(0), 50);
  }
} else if (mode === "durable") {
 // 终态落盘对账桩:交稿落盘 terminal.json 后**不发 task.state 直接退出**——
  // 模拟「gateway 拥堵导致在途 uplink 随 IPC 通道关闭丢失」;host exit 收割应回读落盘按 done 记账。
  setTimeout(() => {
    const p = joinP(spec.repoRoot, ".genie", "session-workers", `${spec.task.id}.terminal.json`);
    try { mkd(dirP(p), { recursive: true }); wfs(p, JSON.stringify({ taskId: spec.task.id, state: "done", result: "durable 交稿(回执丢失场景)", at: Date.now(), pid: process.pid }), "utf-8"); } catch { /* 模拟失败=走旧路径 */ }
    send({ t: "journal.append", events: [{ kind: "message.agent", sessionId: sid, payload: { text: "durable-stub-work" }, time: Date.now() }] });
    setTimeout(() => process.exit(0), 50); // 不发 task.state=uplink 丢失
  }, 80);
} else if (mode === "freeze") {
 // 冻结桩(冻结探针):ready+镜像条目后完全静默——模拟事件循环被同步 IO 冻死
  // (不发心跳不发任何上行;真 worker 的心跳由 session-worker.ts 30s 一跳)。
  // host 侧冻结探针应在 GENIE_SESSION_WORKER_FREEZE_MS 后收割:任务翻 failed(worker.freeze)+镜像翻 failed。
  send({ t: "subagent.mirror", entries: [{ agentId: "agent_stub_frz", outputFile: "/tmp/stub-frz.txt", status: "running", sessionId: sid, title: "冻结桩子代理", lastEventAt: Date.now() }] });
  // 保活:模拟「进程活着只是事件循环冻住」——不能让事件循环空转退出(那样走的是 exit 收割路径)
  const hold = setTimeout(() => {}, 60_000);
  process.on("message", (m) => { if (m.t === "cancel") { clearTimeout(hold); process.exit(0); } });
} else if (mode === "hb") {
  // 心跳桩:ready 后每 300s 发 {t:"hb"}——健康长任务(异步等待中)心跳照发,冻结探针不得误伤。
  // 收到 cancel 正常退场。
  const hb = setInterval(() => send({ t: "hb", pid: process.pid }), 300);
  hb.unref?.();
  const timer = setTimeout(() => { process.exit(0); }, 60_000);
  timer.unref?.();
  process.on("message", (m) => {
    if (m.t === "cancel") {
      clearInterval(hb);
      clearTimeout(timer);
      send({ t: "task.state", taskId: spec.task.id, state: "cancelled" });
      setTimeout(() => process.exit(0), 50);
    }
  });
} else {
  send({ t: "task.state", taskId: spec.task.id, state: "failed", error: `未知 STUB_MODE:${mode}` });
  process.exit(1);
}
