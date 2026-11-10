import { describe, it, expect } from "vitest";
import { NdjsonChildBackend, type SubagentEvent, type TaskSpec } from "../src/ndjson-backend";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

class AskChildBackend extends NdjsonChildBackend {
  readonly kind = "ask-child";
  command() {
    return { cmd: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ask-child.mjs")] };
  }
}

describe("permission-ask 应答回流(step-033 F4)", () => {
  it("全链:spawn→permission-ask→respondPermission(allow-once)→result ok;reject→result 失败", async () => {
    const backend = new AskChildBackend();
    const events: SubagentEvent[] = [];
    const handle = await backend.spawn({ taskId: "ask-1", instructions: "干危险的活", workdir: process.cwd(), permissions: "sandbox" }, (e) => events.push(e));
    // 等 ask 到达
    for (let i = 0; i < 50 && !events.some((e) => e.type === "permission-ask"); i++) await new Promise((r) => setTimeout(r, 100));
    const ask = events.find((e) => e.type === "permission-ask");
    expect(ask).toBeTruthy();
    if (ask!.type !== "permission-ask") throw new Error("unreachable");
    expect(ask.risk).toBe("high");
    await handle.respondPermission(ask.requestId, "allow-once");
    for (let i = 0; i < 50 && !events.some((e) => e.type === "result"); i++) await new Promise((r) => setTimeout(r, 100));
    const result = events.find((e) => e.type === "result");
    expect(result?.type === "result" && result.result.ok).toBe(true);
    expect(result?.type === "result" && result.result.finalText).toBe("放行后完成");

    // reject 路径
    const events2: SubagentEvent[] = [];
    const handle2 = await new AskChildBackend().spawn({ taskId: "ask-2", instructions: "再干一次", workdir: process.cwd(), permissions: "sandbox" }, (e) => events2.push(e));
    for (let i = 0; i < 50 && !events2.some((e) => e.type === "permission-ask"); i++) await new Promise((r) => setTimeout(r, 100));
    const ask2 = events2.find((e) => e.type === "permission-ask");
    await handle2.respondPermission(ask2!.type === "permission-ask" ? ask2.requestId : "", "reject");
    for (let i = 0; i < 50 && !events2.some((e) => e.type === "result"); i++) await new Promise((r) => setTimeout(r, 100));
    const result2 = events2.find((e) => e.type === "result");
    expect(result2?.type === "result" && result2.result.ok).toBe(false);
  }, 15_000);

  it("TaskSpec.permissionRules 随 spawn 帧传输(派生规则到达子进程)", async () => {
    let seen: unknown;
    class CaptureBackend extends NdjsonChildBackend {
      readonly kind = "capture";
      command() { return { cmd: process.execPath, args: ["-e", `
        import { createInterface } from "node:readline";
        const rl = createInterface({ input: process.stdin });
        const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
        rl.on("line", (line) => {
          let m; try { m = JSON.parse(line); } catch { return; }
          if (m.type === "spawn") {
            if (m.permissionRules) send({ type: "progress", note: "RULES:" + JSON.stringify(m.permissionRules) });
            send({ id: m.id, ok: true }); send({ type: "ready" });
            send({ type: "result", ok: true, finalText: "done" });
          }
        });
      `] }; }
    }
    const spec: TaskSpec = {
      taskId: "cap-1", instructions: "x", workdir: process.cwd(), permissions: "sandbox",
      permissionRules: [{ permission: "shell", pattern: "rm *", action: "deny" }],
    };
    const events: SubagentEvent[] = [];
    await new CaptureBackend().spawn(spec, (e) => { events.push(e); if (e.type === "progress") seen = e.note; });
    for (let i = 0; i < 50 && !seen; i++) await new Promise((r) => setTimeout(r, 100));
    expect(String(seen)).toContain("RULES:");
    expect(String(seen)).toContain("rm *");
  }, 15_000);
});
