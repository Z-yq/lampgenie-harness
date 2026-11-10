import { describe, it, expect } from "vitest";
import { NodeRegistry } from "../src/nodes";

describe("NodeRegistry(可达性分派)", () => {
  it("注册→心跳→在线→分派到负载最低且达标的节点", () => {
    const reg = new NodeRegistry();
    reg.register({ nodeId: "pc-1", capabilities: ["build"], reachability: ["lan"] });
    reg.register({ nodeId: "server-2", capabilities: ["build", "deploy"], reachability: ["lan", "vpn-x"] });
    // 需要 vpn-x 的任务只能去 server-2
    expect(reg.dispatch({ reachability: ["vpn-x"] })?.nodeId).toBe("server-2");
    // 只需要 build 的,负载低优先
    reg.heartbeat("pc-1", { cpu: 10, mem: 20, runningTasks: 3 });
    reg.heartbeat("server-2", { cpu: 10, mem: 20, runningTasks: 0 });
    expect(reg.dispatch({ capabilities: ["build"] })?.nodeId).toBe("server-2");
  });
  it("失联节点不参与分派", () => {
    const reg = new NodeRegistry();
    reg.staleMs = 50;
    reg.register({ nodeId: "n1", capabilities: ["x"], reachability: [] });
    // 心跳过期
    reg.heartbeat("n1", { cpu: 0, mem: 0, runningTasks: 0 });
    (reg as unknown as { nodes: Map<string, { lastHeartbeat: number }> }).nodes.get("n1")!.lastHeartbeat = Date.now() - 1000;
    expect(reg.dispatch({ capabilities: ["x"] })).toBeNull();
  });
});
