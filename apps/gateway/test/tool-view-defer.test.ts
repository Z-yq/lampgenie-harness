/**
 * tool_view 装配契约(2026-10-22):长描述摘要化 + wire 体量超阈值的工具打 deferred 标
 * (loop 不进广告面,用时激活);核心工具与短体量工具豁免;tool_view 目录列出延迟工具。
 */
import { describe, it, expect } from "vitest";
import { attachToolView, CORE_NEVER_DEFER, TOOL_DEFER_MIN_CHARS, pruneToolsForTaskClass, TASK_CLASS_TOOL_DENY, freezeToolsForSession, resetSessionToolFloor } from "../src/tool-view.js";
import type { Tool } from "@lampgenie/runtime/agent/loop";

const mk = (name: string, descLen: number, schemaLen = 0): Tool => ({
  name,
  description: "x".repeat(descLen),
  parameters: { type: "object", properties: { p: { type: "string", description: "y".repeat(schemaLen) } } },
  isConcurrencySafe: () => true,
  async execute() { return "ok"; },
});

describe("pruneToolsForTaskClass 按类别装配期裁剪(2026-10-29 token 轮 P2)", () => {
  const tools = ["spawn_subagent", "board_export_pptx", "import_meeting", "steer_task", "run_workflow", "code_review", "session_search", "read_file"].map((n) => mk(n, 50));

  it("qa 类去掉 PPT/会议/workflow/steer;保留读文件类", () => {
    const names = pruneToolsForTaskClass(tools, "qa").map((t) => t.name);
    expect(names).not.toContain("board_export_pptx");
    expect(names).not.toContain("import_meeting");
    expect(names).not.toContain("run_workflow");
    expect(names).not.toContain("steer_task");
    expect(names).toContain("read_file");
    expect(names).toContain("code_review"); // qa 仍可能要评审
  });

  it("office 类去掉 code_review/steer/session_search", () => {
    const names = pruneToolsForTaskClass(tools, "office").map((t) => t.name);
    expect(names).not.toContain("code_review");
    expect(names).not.toContain("steer_task");
    expect(names).not.toContain("session_search");
    expect(names).toContain("board_export_pptx"); // 办公类核心
  });

  it("negative coding/未知类别:原样返回(逐引用相同,零变化)", () => {
    expect(pruneToolsForTaskClass(tools, "coding")).toEqual(tools);
    expect(pruneToolsForTaskClass(tools, undefined)).toEqual(tools);
    expect(pruneToolsForTaskClass(tools, "no-such-class")).toEqual(tools);
  });

  it("negative 裁剪表只含真·类别外工具:不得裁掉任何 read_* / write_* / edit_* / terminal", () => {
    const essential = ["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "terminal", "todo_write", "task_phase", "spawn_subagent"];
    for (const deny of Object.values(TASK_CLASS_TOOL_DENY)) {
      for (const n of essential) expect(deny).not.toContain(n);
    }
  });
});

describe("freezeToolsForSession 会话级工具面冻结(2026-10-29 轮 P3,修 P2-1 副作用)", () => {
  const ALL = ["spawn_subagent", "board_export_pptx", "import_meeting", "steer_task", "run_workflow", "code_review", "session_search", "read_file", "terminal"].map((n) => mk(n, 50));
  const names = (ts: { name: string }[]) => ts.map((t) => t.name).sort();

  it("冻结:qa→coding→qa 三次装配后工具集恒为并被(只增不减,不再 23→27 往返)", () => {
    resetSessionToolFloor();
    const a = freezeToolsForSession(ALL, "qa", "s-freeze-1");
    const b = freezeToolsForSession(ALL, "coding", "s-freeze-1");
    const c = freezeToolsForSession(ALL, "qa", "s-freeze-1");
    // 第一次按 qa 裁剪(省字符仍生效)
    expect(names(a)).not.toContain("board_export_pptx");
    // 第二次 coding 全量(coding 不裁) → 全集
    expect(names(b)).toEqual(names(ALL));
    // 第三次回 qa:必须补回 coding 期间广告过的工具(否则前缀从该位置起变化)
    expect(names(c)).toEqual(names(ALL));
    expect(names(b)).toEqual(names(c));
  });

  it("negative 不同 session 的冻结集互不串味", () => {
    resetSessionToolFloor();
    freezeToolsForSession(ALL, "coding", "s-A");
    const b = freezeToolsForSession(ALL, "qa", "s-B");
    // B 从未见过 coding,应仍按 qa 裁剪
    expect(names(b)).not.toContain("board_export_pptx");
    expect(names(b)).not.toContain("run_workflow");
  });

  it("negative 首任务仍按 taskClass 裁剪(省字符收益保留,不是一律全量)", () => {
    resetSessionToolFloor();
    const qa = freezeToolsForSession(ALL, "qa", "s-first");
    expect(names(qa).length).toBeLessThan(ALL.length);
    expect(qa.length).toBe(ALL.length - 4); // qa deny 4 项
  });

  it("negative sessionId 缺省=不冻结(旧调用点行为不变)", () => {
    resetSessionToolFloor();
    expect(names(freezeToolsForSession(ALL, "qa", undefined))).toEqual(names(pruneToolsForTaskClass(ALL, "qa")));
  });

  it("resetSessionToolFloor 清空后可重新开始(测试隔离与「彻底重置会话」入口)", () => {
    resetSessionToolFloor();
    freezeToolsForSession(ALL, "coding", "s-reset");
    resetSessionToolFloor("s-reset");
    const again = freezeToolsForSession(ALL, "qa", "s-reset");
    expect(names(again)).not.toContain("board_export_pptx");
  });
});

describe("attachToolView 延迟加载", () => {
  it("大体量非核心工具打 deferred;核心工具与短体量豁免", () => {
    const out = attachToolView([mk("big", 9000), mk("small", 100), mk("board_upsert", 500, 9000)]);
    const by = new Map(out.map((t) => [t.name, t]));
    expect(by.get("big")!.deferred).toBe(true);
    expect(by.get("small")!.deferred).toBeUndefined();
    // board_upsert 在核心豁免集(2026-10-30 死锁事故):它是 plan-gate 的指定出口,
    // 延迟它=闸门要求一个清单里不存在的工具,写意图被约束采样掰成 board_read 死循环
    expect(by.get("board_upsert")!.deferred).toBeUndefined();
    expect(by.has("tool_view")).toBe(true);
    expect(by.get("tool_view")!.deferred).toBeUndefined();
  });

  it("核心工具即使体量超阈值也不延迟", () => {
    for (const core of CORE_NEVER_DEFER) {
      const out = attachToolView([mk(core, 9000)]);
      expect(out.find((t) => t.name === core)!.deferred, `${core} 应豁免延迟`).toBeUndefined();
    }
  });

  it("tool_view 目录列出延迟工具名(模型据此知道可按需加载)", () => {
    const out = attachToolView([mk("big", 9000)]);
    const tv = out.find((t) => t.name === "tool_view")!;
    expect(tv.description).toContain("big");
    expect(tv.description).toContain("延迟加载");
  });

  it("defer=false 或体量不足阈值:不延迟(回退口径)", () => {
    const off = attachToolView([mk("big", 9000)], { defer: false });
    expect(off.find((t) => t.name === "big")!.deferred).toBeUndefined();
    const small = attachToolView([mk("mid", 100)], { deferMinChars: TOOL_DEFER_MIN_CHARS });
    expect(small.find((t) => t.name === "mid")!.deferred).toBeUndefined();
  });

  it("tool_view 执行返回完整 description+schema(含已延迟工具)", async () => {
    const out = attachToolView([mk("board_upsert", 900, 9000)]);
    const tv = out.find((t) => t.name === "tool_view")!;
    const r = String(await tv.execute({ name: "board_upsert" }));
    expect(r).toContain("完整说明");
    expect(r).toContain("参数 schema");
  });
});
