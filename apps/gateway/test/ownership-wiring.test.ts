import { AGENT_WIRING_SRC } from "./panel-source.js";
import { SERVER_SRC } from "./panel-source.js";
/**
 * 会话工作所有权与代际关闭的接线测试。
 * 两类断言,全部确定性(不启服务、不 spawn 进程、不写文件):
 * 1) 源码锚点:接线散落在四个文件里,用 readFileSync 锁住关键调用不被后续重构悄悄拆掉
 * (register / settle+STALE_GENERATION / closeByOwner / cancelOwnedUnit / new OwnerRegistry)。
 * 2) 纯路径:OwnerRegistry 本体(关闸顺序、代际丢弃、canStart)在本仓内可独立跑通。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OwnerRegistry } from "@lampgenie/runtime/task/ownership";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf-8");

const WIRING = AGENT_WIRING_SRC;
const SERVER = SERVER_SRC;
const APP = read("../src/app.ts");
const SESSION = read("../../../packages/harness-terminal/src/session.ts");

describe("session.ts:终端会话的 owner/代际上报", () => {
  it("TerminalSessionOptions 暴露 ownerSessionId / ownerGeneration(可选)", () => {
    expect(SESSION).toContain("ownerSessionId?: string;");
    expect(SESSION).toContain("ownerGeneration?: number;");
  });

  it("导出 OwnedTerminalSessionInfo(info() 的返回类型)", () => {
    expect(SESSION).toContain("export interface OwnedTerminalSessionInfo extends TerminalSessionInfo");
    expect(SESSION).toMatch(/info\(\): OwnedTerminalSessionInfo/);
    expect(SESSION).toContain("ownerSessionId: this.opts.ownerSessionId ?? this.opts.owner");
    expect(SESSION).toContain("ownerGeneration: this.opts.ownerGeneration ?? this.generation");
  });
});

describe("agent-wiring.ts:三种后台单元的登记与终态", () => {
  it("登记点覆盖 terminal / subagent / workflow,并导出 cancelOwnedUnit", () => {
    expect(WIRING).toContain("function registerOwnedUnit(");
    expect(WIRING).toMatch(/kind: "terminal"/);
    expect(WIRING).toMatch(/kind: "subagent"/);
    expect(WIRING).toMatch(/kind: "workflow"/);
    expect(WIRING).toContain("export async function cancelOwnedUnit(unit: OwnerUnit)");
  });

  it("终态走 settle 且旧代际(STALE_GENERATION)只丢弃不写回", () => {
    expect(WIRING).toContain("function settleOwnedUnit(");
    expect(WIRING).toContain('r.code === "STALE_GENERATION"');
    expect(WIRING).toContain("丢弃旧代际终态");
 // 子代理闭包内两处调用:登记 + 结算
    expect(WIRING).toContain("registerOwnedSubagent()");
    expect(WIRING).toContain("settleOwnedSubagent()");
  });

  it("归属只认注册时写入的 ownerSessionId,不用 parentTaskId 当归属", () => {
    expect(WIRING).toMatch(/ownerSessionId: task\.sessionId/);
    const registerLines = WIRING.split("\n").filter((line) => line.includes("registerOwnedUnit(journal"));
    expect(registerLines.length).toBeGreaterThanOrEqual(3);
    for (const line of registerLines) expect(line).not.toContain("parentTaskId");
  });

  it("未注入注册表时降级 no-op(绑定函数对 undefined 直接返回)", () => {
    expect(WIRING).toContain("export function bindOwnerRegistry(");
    expect(WIRING).toMatch(/if \(!registry\) return;/);
  });

  it("task.cancel 的既有 loop.cancel 字面未被改动(user-stop-resume 源码锁)", () => {
    expect(WIRING).toContain('loop.cancel("task.cancel");');
  });
});

describe("server.ts / app.ts:会话关闸接线", () => {
  it("server 用 closeByOwner → cancelOwnedUnit → settle → completeClose 级联收尾", () => {
    expect(SERVER).toContain("registry.closeByOwner(sessionId)");
    expect(SERVER).toContain("opts.cancelOwnedUnit?.(unit)");
    expect(SERVER).toContain("registry.settle(unit.unitId, { generation: unit.generation })");
    expect(SERVER).toContain("registry.completeClose(sessionId)");
    expect(SERVER).toContain('code === "STALE_GENERATION"');
  });

  it("server 声明可选的 ownerRegistry / cancelOwnedUnit 注入位(缺省=老行为)", () => {
    expect(SERVER).toContain("ownerRegistry?: OwnerRegistry;");
    expect(SERVER).toContain("cancelOwnedUnit?: (unit: OwnerUnit) => Promise<void> | void;");
  });

  it("无 taskId / closeSession:true 在解析前用宽松读取识别(不改 protocol)", () => {
    expect(SERVER).toContain("function isOwnerClosePayload(");
    expect(SERVER).toContain('parsed.closeSession === true || !hasTaskId');
    expect(SERVER).toMatch(/peekedType === "task\.cancel" && isOwnerClosePayload\(rawText\)/);
  });

  it("app.ts 建一份注册表并同时注入 wireAgentLoop 与 startGatewayServer", () => {
    expect(APP).toContain("const ownerRegistry = new OwnerRegistry();");
    expect(APP).toMatch(/undefined, ownerRegistry\);/);
    expect(APP).toMatch(/startGatewayServer\(\{[\s\S]{0,400}ownerRegistry,/);
    expect(APP).toContain("cancelOwnedUnit: (u) => cancelOwnedUnit(u)");
  });
});

describe("OwnerRegistry 纯路径", () => {
  it("关闸顺序 terminal → subagent → workflow,全部 settle 后 completeClose 全 closed", () => {
    let now = 1000;
    const registry = new OwnerRegistry({ now: () => now++ });
    registry.register({ unitId: "wf-1", kind: "workflow", ownerSessionId: "s1", generation: 1 });
    registry.register({ unitId: "t-1", kind: "terminal", ownerSessionId: "s1", generation: 1 });
    registry.register({ unitId: "a-1", kind: "subagent", ownerSessionId: "s1", generation: 1 });

    const begun = registry.closeByOwner("s1");
    expect(begun.code).toBe("OK");
    expect((begun.units ?? []).map((u) => u.kind)).toEqual(["terminal", "subagent", "workflow"]);

    for (const unit of begun.units ?? []) {
      expect(registry.settle(unit.unitId, { generation: unit.generation }).code).toBe("OK");
    }
    const done = registry.completeClose("s1");
    expect(done.code).toBe("OK");
    expect(done.pending ?? []).toEqual([]);
    expect(registry.snapshot("s1").every((u) => u.state === "closed")).toBe(true);
  });

  it("旧代际 settle 返回 STALE_GENERATION 且状态不变", () => {
    const registry = new OwnerRegistry({ now: () => 1 });
    registry.register({ unitId: "t-2", kind: "terminal", ownerSessionId: "s2", generation: 2 });
    const stale = registry.settle("t-2", { generation: 1 });
    expect(stale.code).toBe("STALE_GENERATION");
    expect(registry.get("t-2")?.state).toBe("running");
    expect(registry.isStale("t-2", 1)).toBe(true);
    expect(registry.isStale("t-2", 2)).toBe(false);
 // 当代际可达=OK;settle 只记结算集合,不改 state(状态翻转留给 completeClose)
    expect(registry.settle("t-2", { generation: 2 }).code).toBe("OK");
    expect(registry.get("t-2")?.state).toBe("running");
  });

  it("beginClose 后 canStart 恒 false(关闸期间不许再冒新单元)", () => {
    const registry = new OwnerRegistry({ now: () => 1 });
    expect(registry.canStart("s3")).toBe(true);
    registry.register({ unitId: "t-3", kind: "terminal", ownerSessionId: "s3", generation: 1 });
    registry.beginClose("s3");
    expect(registry.canStart("s3")).toBe(false);
    const rejected = registry.register({ unitId: "t-4", kind: "terminal", ownerSessionId: "s3", generation: 1 });
    expect(rejected.code).toBe("CLOSING");
    expect(registry.get("t-4")).toBeUndefined();
  });
});
