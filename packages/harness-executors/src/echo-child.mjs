/**
 * 契约验证用子进程:实现 NDJSON-RPC 被调方。
 * 收 spawn→回 ready→报 progress→收 steer→回 result。
 * 用 node 直接可跑(纯 JS,无依赖)。
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
let currentTask = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (extra) => send({ id: msg.id, ...extra });

  switch (msg.type) {
    case "spawn":
      currentTask = { id: msg.taskId, instructions: msg.instructions };
      reply({ ok: true });
      send({ type: "ready" });
      // 模拟干活:两条进度后给结果
      setTimeout(() => send({ type: "progress", note: "分析中", pct: 50 }), 100);
      setTimeout(() => {
        send({ type: "result", ok: true, finalText: `完成:${currentTask.instructions}`, artifacts: [] });
        process.exit(0);
      }, 200);
      break;
    case "steer":
      // directive 必从;hint 看内容(含「停」则拒)
      reply({ accepted: msg.mode === "directive" || !msg.text.includes("停") });
      break;
    case "cancel":
      reply({ ok: true });
      send({ type: "result", ok: false, error: { kind: "cancelled" } });
      process.exit(0);
      break;
  }
});
