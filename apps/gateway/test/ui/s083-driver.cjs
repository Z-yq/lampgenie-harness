/** e2e 驱动(真实 LLM,gateway 7803,journal /tmp/j-s083):
 * phaseA 规划电子签(非 coding)→ 白板页面结构板 + 零 review.findings(黄框场景)
 * phaseB 同会话追问规划内容 → agent 调 board_read 引用板
 * phaseC scratch 项目 coding 任务(真实改码)→ agent 自主调 code_review 产 findings
 * 用法:node apps/gateway/test/ui/s083-driver.cjs phaseA|phaseB|phaseC
 */
const { createRequire } = require("node:module");
const req = createRequire(__filename);
const WebSocket = req("ws");
const fs = require("node:fs");

const PORT = 7803;
const JDIR = "/tmp/j-s083";
const SID = "s083-e2e";
const PHASE = process.argv[2] || "phaseA";

function submitTask(msg) {
  return new Promise((res) => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
    const to = setTimeout(() => { ws.close(); res({ timeout: true }); }, 20000);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "hello") ws.send(JSON.stringify(msg));
      if (m.type === "task.submitted") { clearTimeout(to); ws.close(); res(m.task); }
      if (m.type === "error") { clearTimeout(to); ws.close(); res({ error: m }); }
    });
    ws.on("error", (e) => { clearTimeout(to); res({ wserror: String(e).slice(0, 120) }); });
  });
}

function waitTaskState(taskId, timeoutMs = 420000) {
  return new Promise((res) => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
    const to = setTimeout(() => { ws.close(); res("timeout"); }, timeoutMs);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "task.changed" && m.task && m.task.id === taskId && ["done", "failed", "cancelled"].includes(m.task.state)) {
        clearTimeout(to); ws.close(); res(m.task.state);
      }
    });
    ws.on("error", () => { clearTimeout(to); res("wserror"); });
  });
}

function journal() {
  // journal=每会话一个 .jsonl(core FileJournal):读目录下全部文件合并。
  const out = [];
  for (const f of fs.readdirSync(JDIR)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      for (const l of fs.readFileSync(JDIR + "/" + f, "utf-8").trim().split("\n").filter(Boolean)) {
        try { out.push(JSON.parse(l)); } catch { /* 半截行跳过 */ }
      }
    } catch { /* 读失败跳过 */ }
  }
  return out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (PHASE === "phaseA") {
    const t = await submitTask({ v: 1, type: "task.submit", sessionId: SID, instruction: "规划一个电子签 html,只规划不动代码。把规划结构画到白板上。", kind: "user" });
    console.log("[A] submitted taskId:", t && t.id, "state:", t && t.state);
    if (!t || !t.id) { console.log("[A] FAIL submit", JSON.stringify(t).slice(0, 200)); process.exit(1); }
    const st = await waitTaskState(t.id);
    console.log("[A] task state:", st);
    await sleep(2000);
    const j = journal();
    const boards = j.filter((e) => e.kind === "board.update" && e.sessionId === SID);
    const reviews = j.filter((e) => e.kind === "review.findings" && e.sessionId === SID);
    console.log("[A] board.update count:", boards.length);
    for (const b of boards) console.log("[A]   board:", JSON.stringify(b.payload).slice(0, 240));
    console.log("[A] review.findings count:", reviews.length, reviews.length === 0 ? "(黄框场景 PASS:非 coding 任务零评论卡)" : "(FAIL:非 coding 任务不应有评论卡)");
    fs.writeFileSync("/tmp/s083/phaseA.json", JSON.stringify({ taskId: t.id, boards: boards.length, reviews: reviews.length }));
  }

  if (PHASE === "phaseB") {
    const t = await submitTask({ v: 1, type: "task.submit", sessionId: SID, instruction: "只看不改:我们之前规划的电子签 html 有哪些页面?每个页面有哪些区块?请按白板上的内容回答,不要重新规划。", kind: "user" });
    console.log("[B] submitted taskId:", t && t.id);
    if (!t || !t.id) { console.log("[B] FAIL submit", JSON.stringify(t).slice(0, 200)); process.exit(1); }
    const st = await waitTaskState(t.id);
    console.log("[B] task state:", st);
    await sleep(1500);
    const j = journal().filter((e) => e.sessionId === SID);
    const reads = j.filter((e) => (e.kind === "tool.call" || e.kind === "tool.result") && JSON.stringify(e.payload ?? {}).includes("board_read"));
    const agentMsgs = j.filter((e) => e.kind === "message.agent");
    const last = agentMsgs.at(-1);
    const text = JSON.stringify(last?.payload ?? {});
    console.log("[B] board_read 事件数:", reads.length, reads.length > 0 ? "(PASS:agent 主动读回板)" : "(FAIL:未读板)");
    console.log("[B] 末条回复提及签署/页面:", /签署|页面/.test(text) ? "PASS" : "FAIL");
    console.log("[B] 末条回复前 600 字:", String(last?.payload?.text ?? last?.payload?.content ?? "").slice(0, 600).replace(/\n/g, " "));
    fs.writeFileSync("/tmp/s083/phaseB.json", JSON.stringify({ reads: reads.length }));
  }

  if (PHASE === "phaseC") {
    const add = await new Promise((res) => {
      const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/ws");
      const to = setTimeout(() => { ws.close(); res({ timeout: true }); }, 20000);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "hello") ws.send(JSON.stringify({ v: 1, type: "project.add", path: "/tmp/s083-scratch" }));
        // project.add 无定向回执:广播 project.list.result(含新项目)
        if (m.type === "project.list.result") {
          const hit = (m.projects ?? []).find((p) => p.path === "/tmp/s083-scratch");
          if (hit) { clearTimeout(to); ws.close(); res({ type: "project.list.result", project: hit }); }
        }
        if (m.type === "error") { clearTimeout(to); ws.close(); res(m); }
      });
      ws.on("error", () => { clearTimeout(to); res({ wserror: true }); });
    });
    const projectId = add.project ? add.project.id : null;
    console.log("[C] project.add:", add.type, projectId ? "ok" : JSON.stringify(add).slice(0, 160));
    const t = await submitTask({ v: 1, type: "task.submit", sessionId: SID, instruction: "修复 calc.js 里 add 函数的 bug(当前实现是减法,应为加法),再新增一个 multiply(a,b) 函数并导出。注意先看项目里已有的代码风格。", kind: "user", projectId });
    console.log("[C] submitted taskId:", t && t.id);
    if (!t || !t.id) { console.log("[C] FAIL submit", JSON.stringify(t).slice(0, 200)); process.exit(1); }
    const st = await waitTaskState(t.id, 480000);
    console.log("[C] task state:", st);
    await sleep(2500);
    const j = journal().filter((e) => e.sessionId === SID);
    const crCalls = j.filter((e) => e.kind === "tool.call" && JSON.stringify(e.payload ?? {}).includes("code_review"));
    const findings = j.filter((e) => e.kind === "review.findings");
    console.log("[C] code_review 工具调用数:", crCalls.length, crCalls.length > 0 ? "(PASS:触发权在 coding agent,真跑)" : "(FAIL)");
    console.log("[C] review.findings 事件数:", findings.length);
    for (const f of findings) console.log("[C]   findings:", JSON.stringify(f.payload).slice(0, 300));
    fs.writeFileSync("/tmp/s083/phaseC.json", JSON.stringify({ crCalls: crCalls.length, findings: findings.length }));
  }
  process.exit(0);
})().catch((e) => { console.error("driver error:", String(e).slice(0, 300)); process.exit(1); });
