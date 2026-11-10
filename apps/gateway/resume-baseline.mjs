const ws = (await import("ws")).default ?? (await import("ws"));
const SID = "web-1793279074382";
const connect = () => new Promise((resolve) => {
  const s = new ws("ws://127.0.0.1:7700");
  s.on("open", () => resolve(s));
  s.on("error", () => resolve(null));
  setTimeout(() => resolve(null), 6000);
});
const INSTR = `【续跑】上轮「继续提升C的效果,建立测试基线数据集」被系统基础设施故障中断两次(与任务本身无关,已修复)。请继续:基于已有成果(genie-voice/tasks/step-047-mb-ab-test/ 的三臂测试与 40~50 轮话术、此前 C vs B 扩测结论)建立可复用的测试基线数据集(基线用例+判定口径+跑法),并继续提升 C 的效果(重点:指令间语义冲突的修正)。交付:基线数据集落盘+使用说明+C 效果提升结论。`;
const s = await connect();
if (!s) { console.log("WS 不可连"); process.exit(1); }
s.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: SID, instruction: INSTR }));
console.log("已提交");
await new Promise((r) => setTimeout(r, 1500));
s.close();
const t0 = Date.now();
while (Date.now() - t0 < 55 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 30_000));
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
