/** ask-aware 契约子进程( F4):spawn→ready→permission.ask→等 permission.respond→按决议 result。 */
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const reply = (extra) => send({ id: msg.id, ...extra });
  switch (msg.type) {
    case "spawn":
      reply({ ok: true });
      send({ type: "ready" });
      send({ type: "permission.ask", requestId: "req-1", summary: "执行危险命令 rm -rf", risk: "high" });
      break;
    case "permission.respond":
      reply({ ok: true });
      send({ type: "result", ok: msg.decision === "allow-once", finalText: msg.decision === "allow-once" ? "放行后完成" : undefined, error: msg.decision === "allow-once" ? undefined : { kind: "cancelled", detail: "权限被拒" } });
      break;
  }
});
