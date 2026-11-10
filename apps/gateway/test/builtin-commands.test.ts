/**
 * ZCode 内置命令服务面:/goal(journal 目标+回包)/ /compact(手动压缩路径)。
 * 面板 typed 提交分发为纯 UI 逻辑(panel.test 语法门覆盖);此处锚定服务端语义。
 */
import { describe, it, expect } from "vitest";
import { createGatewayApp } from "../src/app.js";
import type { Server } from "node:http";

const ws = (port: number): Promise<import("ws").WebSocket> =>
  import("ws").then(({ WebSocket }) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`);
    return new Promise((res, rej) => { w.on("open", () => res(w)); w.on("error", rej); });
  });

// 15s:与 panel.test 并发跑时资源饥饿(panel 起真网关),5s 会假超时(仓登记的 vitest 并行坑)
function waitMsg(w: import("ws").WebSocket, type: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("timeout:" + type)), timeoutMs);
    const on = (raw: unknown) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if ((m as { type?: string }).type === type) {
        clearTimeout(to);
        w.off("message", on);
        res(m);
      }
    };
    w.on("message", on);
  });
}

describe("内置命令服务面", () => {
  let app: Awaited<ReturnType<typeof createGatewayApp>>;
  let server: Server;
  let port = 0;

  it("装配", async () => {
    app = createGatewayApp({ port: 0, journalDir: undefined, llm: undefined, useExternalHttp: true });
    const { createServer } = await import("node:http");
    server = createServer();
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    app.attachWs(server);
    void ws(port); // 预热模块
  });

  it("/goal:set→get→clear 生命周期(journal 持久;pause 状态保留目标)", async () => {
    const w = await ws(port);
    w.send(JSON.stringify({ v: 1, type: "goal.set", sessionId: "gs1", goal: "把登录页修好", state: "active" }));
    const set = await waitMsg(w, "goal.result");
    expect(set.goal).toBe("把登录页修好");
    expect(set.state).toBe("active");
    expect(set.sync).toBeUndefined(); // 动作确认回包:面板 toast 提示(非同步)

    w.send(JSON.stringify({ v: 1, type: "goal.get", sessionId: "gs1" }));
    const get1 = await waitMsg(w, "goal.result");
    expect(get1.goal).toBe("把登录页修好");
    expect(get1.sync).toBe(true); // 状态同步回包:面板静默刷 chip(「目标已清除」15s 刷屏根因隔离, 视频)

    // pause:目标保留,状态 paused
    w.send(JSON.stringify({ v: 1, type: "goal.set", sessionId: "gs1", goal: "把登录页修好", state: "paused" }));
    await waitMsg(w, "goal.result");
    w.send(JSON.stringify({ v: 1, type: "goal.get", sessionId: "gs1" }));
    const get2 = await waitMsg(w, "goal.result");
    expect(get2.state).toBe("paused");

    // clear:goal=null → cleared
    w.send(JSON.stringify({ v: 1, type: "goal.set", sessionId: "gs1", goal: null, state: "active" }));
    const clr = await waitMsg(w, "goal.result");
    expect(clr.state).toBe("cleared");
    w.close();
  });

  it("/goal:get 无目标=cleared 空值(不猜)", async () => {
    const w = await ws(port);
    w.send(JSON.stringify({ v: 1, type: "goal.get", sessionId: "gs-none" }));
    const r = await waitMsg(w, "goal.result");
    expect(r.goal).toBeNull();
    expect(r.state).toBe("cleared");
    expect(r.sync).toBe(true); // 无目标轮询同样=同步回包:不再触发「目标已清除」toast
    w.close();
  });

  it("/compact:无 LLM=显式不可为(fail-visible,不假压)", async () => {
    const w = await ws(port);
    w.send(JSON.stringify({ v: 1, type: "session.compact", sessionId: "gs1" }));
    const r = await waitMsg(w, "session.compact.result");
    expect(r.compacted).toBe(false);
    expect(String(r.reason)).toContain("LLM");
    w.close();
  });

  it("收尾", async () => {
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
