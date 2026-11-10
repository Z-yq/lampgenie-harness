import { execSync } from "node:child_process";
const ws = (await import("ws")).default ?? (await import("ws"));
const SID = "web-1793279074382";
const connect = () => new Promise((resolve) => {
  const s = new ws("ws://127.0.0.1:7700");
  s.on("open", () => resolve(s));
  s.on("error", () => resolve(null));
  setTimeout(() => resolve(null), 6000);
});
const INSTR = `【续跑】上轮「继续优化提升C的效果,要多测测,看看网上有没有长对话的测试集、针对ai陪伴的测试集」被系统中断(基础设施故障,与任务本身无关)。请继续完成:①网上调研长对话/AI陪伴测试集(web_search);②对 C(接 message_builder 完整链路)多用几组对话测,对比 B;③给出优化建议与结论。已有测试脚本与产物(genie-voice/tasks/step-047-mb-ab-test/)直接复用。`;
const s = await connect();
if (!s) { console.log("WS 不可连"); process.exit(1); }
s.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: SID, instruction: INSTR }));
console.log("已提交 →", SID);
await new Promise((r) => setTimeout(r, 1500));
s.close();
const t0 = Date.now();
while (Date.now() - t0 < 50 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 25_000));
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
