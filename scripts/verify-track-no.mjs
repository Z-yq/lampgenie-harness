#!/usr/bin/env node
/**
 * 端到端验证(Trace 看板 turn 序号修复):
 * ① track.view.result.turns[].no 递增(按 taskId 分组近似会话;跨任务同会话时 no 因 sessionId 计数而连续);
 * ② 构建产物含新代码(dist 渲染读 t.no;widget 含 sw-sa-fold);
 * ③ trace.stats 子代理 agents 带 lastAt。
 * 用法:node scripts/verify-track-no.mjs [sessionId](可选,用于点名最近会话)
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// ws 只在 apps/gateway 依赖里:从其 node_modules 解析(scripts/ 无独立依赖)
const { WebSocket } = createRequire(join(root, "apps/gateway/package.json"))("ws");
const argSid = process.argv[2] || "";
let failed = 0;
const check = (name, ok, detail) => { console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? " — " + detail : "")); if (!ok) failed++; };

const ws = new WebSocket("ws://127.0.0.1:7700");
// 面板真实形态(panel.ts:13235):track.view 带 sessionId,单会话视图。
// 不带 sid 会 readAll 混合所有会话,no 是各会话独立计数(2,2,2 属不同会话,语义正确)。
const sidsAll = readdirSync(join(root, ".genie/journals/sessions")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
const viewSid = argSid && sidsAll.includes(argSid) ? argSid : sidsAll[sidsAll.length - 1];
ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "track.view", sessionId: viewSid })));
ws.on("error", (e) => { console.error("WS 连接失败(网关未起?):", e.message); process.exit(2); });
setTimeout(() => { console.error("超时:未收到 track.view.result"); process.exit(3); }, 15000);

ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== "track.view.result") return;
  clearTimeout();
  console.log("== track.view.result 端到端验证 ==");
 // ① no 字段:跨任务同会话时 no 不满足任务内 i+1,断言改为「全部带 no + 存在 no>1 + 无重复」
  const ts = m.turns || [];
  const allHaveNo = ts.length > 0 && ts.every((t) => typeof t.no === "number" && t.no >= 1);
  const maxNo = ts.reduce((a, t) => Math.max(a, t.no || 0), 0);
  check("turns[].no 全部在场且 ≥1", allHaveNo, `n=${ts.length} maxNo=${maxNo}`);
  check("存在 no>1(会话内多轮派生,不再恒 1)", maxNo > 1, `maxNo=${maxNo}`);
 // no 按 sessionId 独立计数:taskId 不是正确分组键(一任务可含多会话事件)。可诚实断言的是:
 // 最新一条 turn(journal 序末位,即当前活跃会话本轮)的 no 应为全表最大——会话级计数不回退的代理判据。
  const last = ts[ts.length - 1];
  check(`会话 ${viewSid} 视图:no 即 1..n 连续递增`, ts.length > 0 && ts.every((t, i) => t.no === i + 1), `n=${ts.length} no=[${ts.map((t) => t.no).join(",")}]`);

 // ② 构建产物含新代码
  const dist = readFileSync(join(root, "apps/gateway/dist/gateway.mjs"), "utf8");
  check("dist(gateway) 含 t.no||t.turn 渲染", dist.includes("t.no || t.turn") || dist.includes("t.no||t.turn"));
  const widget = readFileSync(join(root, "apps/gateway/src/assets/status-widget.js"), "utf8");
  check("status-widget 含 sw-sa-fold 折叠", widget.includes("sw-sa-fold") && widget.includes("slice(0, 3)"));
  ws.close();

 // ③ trace.stats 子代理 lastAt(最近会话)
  const ws2 = new WebSocket("ws://127.0.0.1:7700");
  ws2.on("error", () => { check("trace.stats WS", false, "第二连接失败"); finish(); });
  const sids = readdirSync(join(root, ".genie/journals/sessions")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
  const sid = argSid && sids.includes(argSid) ? argSid : sids[sids.length - 1];
  ws2.on("open", () => ws2.send(JSON.stringify({ v: 1, type: "trace.stats", sessionId: sid })));
  ws2.on("message", (raw2) => {
    const s = JSON.parse(String(raw2));
    if (s.type !== "trace.stats.result") return;
    const ag = s.stats?.subagents?.agents ?? [];
    const withLast = ag.filter((a) => typeof a.lastAt === "number").length;
    check(`trace.stats(${sid}) 子代理 lastAt 在场`, ag.length === 0 || withLast === ag.length, `${withLast}/${ag.length} 个子代理带 lastAt`);
    ws2.close();
    finish();
  });
  function finish() {
    console.log(failed === 0 ? "== 全部通过 ==" : `== ${failed} 项失败 ==`);
    process.exit(failed === 0 ? 0 : 1);
  }
});
