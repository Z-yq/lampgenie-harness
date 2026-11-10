/**
 * wait_until 端到端(2026-11-08 审计 R1·C3 开放事实收口):
 * 「挂起期间零 LLM 消耗」的直接观测——真实 gateway app(端口 0)+假 LLM:
 * 第 1 次调用发起 wait_until(file 条件 ~3s 后才满足)→ 工具挂起 → 满足后第 2 次调用收终稿。
 * 断言:①全程恰好 2 次 llm.chat(挂起窗口内无任何额外调用);②两次调用间隔 ≥2.5s
 * (挂起真实发生);③任务终态 done。
 * 操作级证据形态:真进程+真文件系统+真计时器(createGatewayApp 全装配,非 mock loop)。
 * 标记文件落 repoRoot/.genie/wue2e-marker/(wait_until 围栏根=taskRoot=repoRoot),
 * afterAll 清理,不污染生产数据。
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
const markerDir = join(repoRoot, ".genie", "wue2e-marker");
const marker = join(markerDir, "ready.log");
rmSync(markerDir, { recursive: true, force: true });
afterAll(() => rmSync(markerDir, { recursive: true, force: true }));

const apps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  rmSync(marker, { force: true });
});

describe("wait_until e2e:挂起期间零 LLM(审计 C3)", () => {
  it("file 条件 ~3s 后满足:全程 2 次 llm 调用,间隔≥2.5s,任务 done", async () => {
    mkdirSync(markerDir, { recursive: true });
    const chatLog: { at: number; subagent: boolean }[] = [];
    const sid = "wait-until-e2e-1";
    const app = createGatewayApp({
      port: 0,
      llm: { async chat(_m: unknown) {
        const m = JSON.stringify(_m);
        const subagent = m.includes("独立上下文");
        chatLog.push({ at: Date.now(), subagent });
        if (subagent) return { content: "子代理完成" };
        const step = chatLog.length - 1;
        if (step === 0) {
          // 以 call1 为锚:发出 wait_until 后 3s 才写标记(挂起必须真等;任务派发耗时不影响计时)
          setTimeout(() => writeFileSync(marker, "BUILD DONE\n"), 3000);
          return {
            content: "",
            toolCalls: [{ id: "w1", name: "wait_until", arguments: JSON.stringify({ file: { path: ".genie/wue2e-marker/ready.log", contains: "BUILD DONE" }, timeoutSec: 30 }) }],
          };
        }
        return { content: "终稿" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "等待标记文件后收尾");
    for (let k = 0; k < 400; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const mainCalls = chatLog.filter((c) => !c.subagent);
    const task = app.taskManager.list().find((x) => x.sessionId === sid);
    // 诊断输出:失败时能看到卡在哪(状态/调用数/标记文件是否出现)
    console.log("[wue2e] state=" + task?.state + " mainCalls=" + mainCalls.length + " marker=" + existsSync(marker));
    expect(task?.state).toBe("done");
    // 零 LLM 断言:主轨恰好 2 次调用(发起 wait_until + 收终稿),挂起窗口内零额外调用
    expect(mainCalls.length).toBe(2);
    expect(mainCalls[1]!.at - mainCalls[0]!.at).toBeGreaterThanOrEqual(2500);
  }, 60_000);
});
