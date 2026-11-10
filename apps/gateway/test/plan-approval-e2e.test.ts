/**
 * Plan 审批流端到端(C19③,审计 R1 闭环):plan 模式任务完成→计划文件落盘→
 * plan.approval.request 广播→approve(切回+按计划派实施)/feedback(steered+保持 plan)。
 * 审计 R1 打倒的三断裂之一(零端到端)由此闭合;①死代码②早退已修,由本测试+其它锚定。
 */
import { describe, it, expect } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { setPermissionMode, permissionMode } from "../src/permission-mode.js";
import type { Server } from "node:http";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const wsConn = (port: number): Promise<import("ws").WebSocket> =>
  import("ws").then(({ WebSocket }) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`);
    return new Promise((res, rej) => { w.on("open", () => res(w)); w.on("error", rej); });
  });

function waitMsg(w: import("ws").WebSocket, type: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("timeout:" + type)), timeoutMs);
    const on = (raw: unknown) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if ((m as { type?: string }).type === type) { clearTimeout(to); w.off("message", on); res(m); }
    };
    w.on("message", on);
  });
}

const planLlm = { async chat() { return { content: "## 实施计划\n- 步骤一:修登录页\n- 步骤二:补测试" }; } };

describe("plan 审批流 e2e(step-053 闭环)", () => {
  let app: Awaited<ReturnType<typeof createGatewayApp>>;
  let server: Server;
  let port = 0;
  const SID = "plan-e2e-s1";

  it("plan 模式任务完成→计划文件落盘+审批广播", { timeout: 20_000 }, async () => {
    setPermissionMode("plan");
    app = createGatewayApp({
      port: 0, llm: planLlm as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    const { createServer } = await import("node:http");
    server = createServer();
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
    app.attachWs(server);
    const w = await wsConn(port);
    const approval = waitMsg(w, "plan.approval.request");
    app.taskManager.submit("user", SID, "做个功能");
    const req = await Promise.race([approval, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("审批广播超时")), 14_000))]);
    expect(req.sessionId).toBe(SID);
    const planPath = String(req.planPath);
    expect(existsSync(planPath)).toBe(true);
    const content = readFileSync(planPath, "utf-8");
    expect(content).toContain("实施计划");
    expect(content).toContain("步骤一");
    // journal 留痕
    expect(app.journal.readAll().some((e) => e.kind === "plan.saved" && e.sessionId === SID)).toBe(true);
    w.close();
  });

  it("approve:切回 ask+按计划派实施(ZCode 模型内容逐字)", async () => {
    const w = await wsConn(port);
    w.send(JSON.stringify({ v: 1, type: "plan.approve", sessionId: SID, taskId: "any", decision: "approve" }));
    await new Promise((r) => setTimeout(r, 800));
    expect(permissionMode(), "批准后应切回 ask").toBe("ask");
    const impl = app.taskManager.list().find((t) => (t.instruction || "").includes("用户已批准你的计划"));
    expect(impl, "应派实施任务").toBeTruthy();
    expect(impl!.instruction).toContain("## 已批准的计划:");
    expect(impl!.instruction).toContain("步骤一");
    // 「已退出计划模式」通知入流
    expect(app.journal.readAll().some((e) => e.kind === "message.system" && String((e.payload as { text?: string }).text ?? "").includes("已退出计划模式"))).toBe(true);
    w.close();
  });

  it("feedback:steered 修订消息+保持 plan 模式", async () => {
    setPermissionMode("plan");
    const w = await wsConn(port);
    w.send(JSON.stringify({ v: 1, type: "plan.approve", sessionId: SID, taskId: "any", decision: "feedback", feedback: "风险节太薄,补回滚方案" }));
    await new Promise((r) => setTimeout(r, 500));
    expect(app.journal.readAll().some((e) => e.kind === "message.user" && String((e.payload as { text?: string }).text ?? "").includes("[计划反馈] 风险节太薄"))).toBe(true);
    expect(permissionMode(), "feedback 不切模式").toBe("plan");
    w.close();
    setPermissionMode("ask");
  });

  it("收尾", async () => {
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
    if (existsSync(join(".genie", "plans", `plan-${SID}.md`))) rmSync(join(".genie", "plans", `plan-${SID}.md`));
  });
});
