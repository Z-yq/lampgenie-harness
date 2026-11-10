import { execSync } from "node:child_process";
const ws = (await import("ws")).default ?? (await import("ws"));
const SID = "web-1793279074382";
const connect = () => new Promise((resolve) => {
  const s = new ws("ws://127.0.0.1:7700");
  s.on("open", () => resolve(s));
  s.on("error", () => resolve(null));
  setTimeout(() => resolve(null), 6000);
});
const INSTR = `【续跑·编码收尾】上轮「message_builder 接入 A/B 差异测试」已到 verify 阶段(三臂跑通、负面已证,旧任务板 rev2/11 节点),因系统故障中断过两次。本轮直接收尾交付:
1) 若当前任务还没有自己的板:调 board_upsert 把旧任务板(0d0b5ec5)的结构落到当前任务 id——board_upsert 是延迟加载工具,你的工具清单里没有它时先调 tool_view(name="board_upsert") 激活,不要反复 board_read;
2) 复跑正常路径一次+产物断言+报告核对,回填 P0 证据;
3) 输出最终报告:A/B(接/不接 message_builder)的可测差异、测试方法、实测数据、结论。已有脚本与产物直接复用。`;
const s = await connect();
if (!s) { console.log("WS 不可连"); process.exit(1); }
s.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: SID, instruction: INSTR }));
console.log("已提交续跑任务 →", SID);
await new Promise((r) => setTimeout(r, 1500));
s.close();
const t0 = Date.now();
while (Date.now() - t0 < 45 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 20_000));
  const s2 = await connect();
  if (!s2) continue;
  const st = await new Promise((resolve) => {
    const to = setTimeout(() => { try { s2.close(); } catch {} resolve("timeout"); }, 5000);
    s2.on("message", (d) => {
      const txt = String(d);
      if (!txt.includes('"hello"')) return;
      clearTimeout(to);
      const t = (JSON.parse(txt).tasks ?? []).filter((x) => x.sessionId === SID).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      s2.close(); resolve(t ? `${t.state}(${t.id.slice(0, 8)})` : "none");
    });
  });
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${st}`);
  if (["done", "failed", "cancelled"].some((x) => st.startsWith(x))) break;
}
