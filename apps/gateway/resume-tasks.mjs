import { execSync } from "node:child_process";
const ws = (await import("ws")).default ?? (await import("ws"));
const G = "/mnt/e/workship/genie/lampgenie-harness";
const connect = () => new Promise((resolve) => {
  const s = new ws("ws://127.0.0.1:7700");
  s.on("open", () => resolve(s));
  s.on("error", () => resolve(null));
  setTimeout(() => resolve(null), 6000);
});

const jobs = [
  {
    sessionId: "web-1793267686700",
    instruction: "【续跑】上一轮「结合 harness/genie 项目 session 再分析(交付质量×token×命中率)」的分析工作已经全部完成(数据收集、跨项目脚本、结论都已就绪,前一会话因网关故障在交付环节被中断,你此前已得出结论)。请基于本会话历史里已有的全部分析素材与已落盘的产物(.genie/tmp/agent-eff/ 下脚本与数据),直接输出完整最终报告——不要重新收集数据、不要重跑脚本,把上次已形成的结论完整交付(含三个最大浪费源与优化建议)。",
    tag: "审计续分析",
  },
  {
    sessionId: "web-1793279074382",
    instruction: "【续跑】上一轮「测试出不接 message_builder+人格一次写入 system 和接 message_builder 的区别」的任务已推进到 verify 阶段(三臂已跑通、负面已证),因网关故障被系统中断。请继续完成收尾:复跑正常路径+产物断言+报告核对,回填 P0 证据,然后交付最终报告(A/B 对比结论:接与不接 message_builder 的可测差异、测试方法、实测数据)。已有的测试脚本与产物直接复用,不要从零重做。",
    tag: "message_builder A/B",
  },
];

const s = await connect();
if (!s) { console.log("WS 不可连"); process.exit(1); }
let submitted = 0;
s.on("message", (d) => {
  const txt = String(d);
  if (txt.includes("task.submit.result") || txt.includes('"ok":true')) submitted++;
});
for (const j of jobs) {
  s.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: j.sessionId, instruction: j.instruction }));
  console.log(`已提交: ${j.tag} → ${j.sessionId}`);
}
await new Promise((r) => setTimeout(r, 2000));
s.close();

// 轮询两个任务到终态
const t0 = Date.now();
while (Date.now() - t0 < 60 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 20_000));
  const s2 = await connect();
  if (!s2) continue;
  const states = await new Promise((resolve) => {
    const to = setTimeout(() => { try { s2.close(); } catch {} resolve(null); }, 6000);
    s2.on("message", (d) => {
      const txt = String(d);
      if (!txt.includes('"hello"')) return;
      clearTimeout(to);
      const tasks = JSON.parse(txt).tasks ?? [];
      const out = {};
      for (const j of jobs) {
        const t = tasks.filter((x) => x.sessionId === j.sessionId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
        out[j.tag] = t ? `${t.state}(${t.id.slice(0, 8)})` : "无任务";
      }
      s2.close(); resolve(out);
    });
  });
  if (!states) continue;
  const el = Math.round((Date.now() - t0) / 1000);
  console.log(`[${el}s] ${JSON.stringify(states)}`);
  const vals = Object.values(states);
  if (vals.every((v) => v.startsWith("done") || v.startsWith("failed") || v.startsWith("cancelled"))) {
    console.log("全部终态");
    break;
  }
}
