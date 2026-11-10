import { describe, it, expect } from "vitest";
import { startNodeAgent } from "../src/index";

describe("node-agent", () => {
  it("startNodeAgent 可构造并关闭", () => {
    const agent = startNodeAgent({
      gatewayUrl: "ws://127.0.0.1:1", // 不连真服务,只验证构造
      nodeId: "n1",
      kind: "pc",
      capabilities: [],
      reachability: [],
    });
    expect(agent.close).toBeTypeOf("function");
    agent.close();
  });

 // 回归(补强):CONNECTING 态 close→ws.terminate 会异步 emit
  // "WebSocket was closed before the connection was established"(已在裸 ws 复现为
  // unhandled 'error' 事件炸进程)。契约:error 监听必须在位,进程级零未捕获异常。
  it("CONNECTING 态 close 不产生 unhandled error(进程级零未捕获,连接拒绝也被吞)", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => { uncaught.push(e); };
    const onRejection = (e: unknown) => { uncaught.push(e); };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onRejection);
    try {
      const agent = startNodeAgent({
        gatewayUrl: "ws://127.0.0.1:1", // 立即连接拒绝
        nodeId: "n1-c26",
        kind: "pc",
        capabilities: [],
        reachability: [],
      });
      agent.close(); // CONNECTING 窗口内立即 terminate(触发 before-established error 路径)
      // 覆盖 socket 层 ECONNREFUSED 的异步到达窗口
      await new Promise((r) => setTimeout(r, 400));
      expect(uncaught, "进程级不得出现未捕获 error(reject/exception)").toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onRejection);
    }
  });
});
