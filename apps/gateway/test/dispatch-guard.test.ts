import { describe, it, expect } from "vitest";
import { NodeRegistry, dispatchGuard } from "../src/nodes.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { wireExecutor } from "../src/executor-wiring.js";
import { EchoChildBackend } from "@lampgenie/executors";

describe("可达性分派守卫(修复:dispatch 接进执行路径)", () => {
  it("无标签直通 / 无节点显式失败 / 命中返回解释", () => {
    const nodes = new NodeRegistry();
    expect(dispatchGuard(nodes, {})).toEqual({ ok: true, node: null });

    const miss = dispatchGuard(nodes, { reachability: ["vpn-x"] });
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.reason).toContain("无可达节点");
      expect(miss.reason).toContain("vpn-x");
    }

    nodes.register({ nodeId: "srv", capabilities: [], reachability: ["vpn-x"] });
    const hit = dispatchGuard(nodes, { reachability: ["vpn-x"] });
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.note).toContain("分派至节点 srv");
  });

  it("执行路径集成:带标签无节点→failed 显式;注册节点后→done+分派解释落 journal", async () => {
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    const nodes = new NodeRegistry();
    wireExecutor(tm, journal, new EchoChildBackend(), nodes);

    const t1 = tm.submit("user", "dg", "干个活", { resourceTags: ["vpn-x"] });
    await new Promise((r) => setTimeout(r, 400));
    expect(tm.get(t1.id)?.state).toBe("failed");
    expect(String(tm.get(t1.id)?.result)).toContain("无可达节点");
    expect(String(tm.get(t1.id)?.result)).toContain("vpn-x");

    nodes.register({ nodeId: "local", capabilities: [], reachability: ["vpn-x"] });
    const t2 = tm.submit("user", "dg", "再干个活", { resourceTags: ["vpn-x"] });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("done 超时")), 10_000);
      const p = setInterval(() => {
        if (tm.get(t2.id)?.state === "done") { clearTimeout(t); clearInterval(p); res(); }
      }, 30);
    });
    expect(tm.get(t2.id)?.state).toBe("done");
    const dispatchNote = journal.readAll().find(
      (e) => e.kind === "task.progress" && JSON.stringify(e.payload).includes("分派至节点 local"),
    );
    expect(dispatchNote).toBeTruthy();
  }, 15_000);
});
