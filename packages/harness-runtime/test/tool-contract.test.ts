/**
 * 工具契约按执行上下文投影。契约:
 * - describeToolForContext 纯函数:plan/readonly 写类前缀、qa/office 任务类别提示、委派类只列真实 agent;
 * - 前缀/提示幂等(重复投影不叠句);未知上下文原样 changed=false;
 * - schema 深拷贝(改返回值不污染注册表原对象);入参任何字段不被触碰;
 * - projectToolsForContext 返回新数组、确定性、不抛错。
 */
import { describe, it, expect } from "vitest";
import {
  describeToolForContext,
  projectToolsForContext,
  READONLY_PREFIX,
  QA_READONLY_NOTE,
  NO_DELEGATE_NOTE,
  DELEGATE_LIST_MARK,
  WRITE_TOOLS,
  DELEGATE_TOOLS,
  AGENT_NAME_TABLE,
  type ToolLike,
} from "../src/agent/tool-contract";

function tool(name: string, description = "do something", parameters: Record<string, unknown> = { type: "object" }): ToolLike {
  return { name, description, parameters };
}

const writeTool = tool("write_file", "把内容写入文件。", {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
});
const readTool = tool("read_file", "读取文件内容。");
const delegateTool = tool("spawn_subagent", "派发子任务给子代理。");

describe("A/只读档:plan 与 readonly", () => {
  it("A1 plan 模式写类工具描述带只读前缀", () => {
    const d = describeToolForContext(writeTool, { permissionMode: "plan" });
    expect(d.description.startsWith(READONLY_PREFIX)).toBe(true);
    expect(d.description).toContain("把内容写入文件。");
    expect(d.changed).toBe(true);
    expect(d.reasons).toContain("readonly-prefix:plan");
  });

  it("A2 readonly 模式写类工具描述带只读前缀", () => {
    const d = describeToolForContext(writeTool, { permissionMode: "readonly" });
    expect(d.description.startsWith(READONLY_PREFIX)).toBe(true);
    expect(d.changed).toBe(true);
  });

  it("A3 只读档不改 schema 执行语义:参数表逐字保留", () => {
    const d = describeToolForContext(writeTool, { permissionMode: "plan" });
    expect(d.schema).toEqual(writeTool.parameters);
  });

  it("A4 只读档下读类工具不动(changed=false)", () => {
    const d = describeToolForContext(readTool, { permissionMode: "plan" });
    expect(d.changed).toBe(false);
    expect(d.description).toBe(readTool.description);
    expect(d.reasons).toEqual([]);
  });

  it("A5 前缀幂等:已带同前缀不重复追加", () => {
    const already = tool("write_file", `${READONLY_PREFIX}把内容写入文件。`);
    const d = describeToolForContext(already, { permissionMode: "plan" });
    expect(d.changed).toBe(false);
    expect(d.description.split(READONLY_PREFIX).length - 1).toBe(1);
  });

  it("A6 重复投影不叠句(project 两次)", () => {
    const once = projectToolsForContext([writeTool], { permissionMode: "plan" });
    const twice = projectToolsForContext(once, { permissionMode: "plan" });
    expect(twice[0]!.description).toBe(once[0]!.description);
    expect(twice[0]!.description.split(READONLY_PREFIX).length - 1).toBe(1);
  });

  it("A7 未改动入参:原 description 逐字不变(快照语义)", () => {
    const before = JSON.stringify(writeTool);
    describeToolForContext(writeTool, { permissionMode: "plan", taskClass: "qa", availableTools: ["worker"] });
    expect(JSON.stringify(writeTool)).toBe(before);
  });
});

describe("E/任务类别:qa 只读、office 产出", () => {
  it("E1 qa 写类工具追加只读提示", () => {
    const d = describeToolForContext(writeTool, { taskClass: "qa" });
    expect(d.description).toContain(QA_READONLY_NOTE);
    expect(d.changed).toBe(true);
    expect(d.reasons).toContain("task-class:qa");
  });

  it("E2 qa 读类工具不动", () => {
    expect(describeToolForContext(readTool, { taskClass: "qa" }).changed).toBe(false);
  });

  it("E3 office 下 code_review 标注不适用", () => {
    const d = describeToolForContext(tool("code_review", "审查代码变更。"), { taskClass: "office" });
    expect(d.description).toContain("代码评审不适用");
    expect(d.reasons).toContain("task-class:office:code_review");
  });

  it("E4 office 下普通写类工具不标注(办公产出本来要写文件)", () => {
    expect(describeToolForContext(writeTool, { taskClass: "office" }).changed).toBe(false);
  });

  it("E5 组合 ctx(plan+qa)两个提示都上且各只出现一次", () => {
    const d = describeToolForContext(writeTool, { permissionMode: "plan", taskClass: "qa" });
    expect(d.description.split(READONLY_PREFIX).length - 1).toBe(1);
    expect(d.description.split(QA_READONLY_NOTE).length - 1).toBe(1);
    expect(d.reasons).toEqual(["readonly-prefix:plan", "task-class:qa"]);
  });
});

describe("C/D/委派类:只列真实 agent", () => {
  it("C1 只列 availableTools 中存在的 agent,且按名表顺序", () => {
    const d = describeToolForContext(delegateTool, { availableTools: ["planner", "read_file", "worker"] });
    expect(d.description).toContain(`${DELEGATE_LIST_MARK}worker, planner。`);
    expect(d.description).not.toContain("explore");
    expect(d.changed).toBe(true);
  });

  it("C2 availableTools 里的非 agent 名不进名单", () => {
    const d = describeToolForContext(delegateTool, { availableTools: ["read_file", "board_upsert"] });
    expect(d.description).toContain(NO_DELEGATE_NOTE);
    expect(d.description).not.toContain(DELEGATE_LIST_MARK);
  });

  it("C3 全部内置 agent 可用时名单完整且确定性", () => {
    const d1 = describeToolForContext(delegateTool, { availableTools: [...AGENT_NAME_TABLE].reverse() });
    const d2 = describeToolForContext(delegateTool, { availableTools: [...AGENT_NAME_TABLE] });
    expect(d1.description).toBe(d2.description);
    expect(d1.description).toContain(AGENT_NAME_TABLE.join(", "));
  });

  it("D1 无可用 agent → 追加提示", () => {
    const d = describeToolForContext(delegateTool, { availableTools: [] });
    expect(d.description.endsWith(NO_DELEGATE_NOTE)).toBe(true);
    expect(d.reasons).toContain("delegate-none");
  });

  it("D2 未给 availableTools 字段 → 同样追加提示", () => {
    expect(describeToolForContext(delegateTool, { agentType: "main" }).description).toContain(NO_DELEGATE_NOTE);
  });

  it("D3 委派名单幂等:重复投影不重复列", () => {
    const once = projectToolsForContext([delegateTool], { availableTools: ["worker"] });
    const twice = projectToolsForContext(once, { availableTools: ["worker"] });
    expect(twice[0]!.description).toBe(once[0]!.description);
  });

  it("D4 list_agents / run_workflow 同属委派集合", () => {
    expect(DELEGATE_TOOLS.has("list_agents")).toBe(true);
    expect(DELEGATE_TOOLS.has("run_workflow")).toBe(true);
    expect(describeToolForContext(tool("list_agents"), { availableTools: ["judge"] }).description).toContain(
      `${DELEGATE_LIST_MARK}judge。`,
    );
  });
});

describe("F/未知上下文与空 ctx", () => {
  it("F1 未知 permissionMode 原样 changed=false", () => {
    const d = describeToolForContext(writeTool, { permissionMode: "workspace" });
    expect(d.changed).toBe(false);
    expect(d.description).toBe(writeTool.description);
  });

  it("F2 未知 taskClass 原样", () => {
    expect(describeToolForContext(tool("code_review", "审查代码。"), { taskClass: "research" }).changed).toBe(false);
  });

  it("F3 空 ctx {} 原样", () => {
    const d = describeToolForContext(writeTool, {});
    expect(d.changed).toBe(false);
    expect(d.schema).toEqual(writeTool.parameters);
  });

  it("F4 undefined/null ctx 原样", () => {
    expect(describeToolForContext(writeTool).changed).toBe(false);
    expect(describeToolForContext(writeTool, null).changed).toBe(false);
  });
});

describe("G/深拷贝与不抛错边界", () => {
  it("G1 改返回 schema 不污染入参(顶层)", () => {
    const d = describeToolForContext(writeTool, { permissionMode: "plan" });
    (d.schema as { type?: string }).type = "mutated";
    expect(writeTool.parameters.type).toBe("object");
  });

  it("G2 深拷贝:嵌套属性不共享引用", () => {
    const d = describeToolForContext(writeTool, {});
    const props = (d.schema as { properties: Record<string, { type: string }> }).properties;
    props.path!.type = "number";
    const origProps = (writeTool.parameters as { properties: Record<string, { type: string }> }).properties;
    expect(origProps.path!.type).toBe("string");
  });

  it("G3 非对象 parameters → 空对象,不抛错", () => {
    const bad = { name: "x", description: "d", parameters: "not-an-object" as unknown as Record<string, unknown> };
    const d = describeToolForContext(bad, { permissionMode: "plan" });
    expect(d.schema).toEqual({});
    expect(d.changed).toBe(false);
  });

  it("G4 缺 name 的工具原样退回", () => {
    const d = describeToolForContext({ name: "", description: "d", parameters: {} }, { permissionMode: "plan" });
    expect(d.changed).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it("G5 带循环引用的 schema 不抛错且仍为深拷贝(structuredClone 支持环)", () => {
    const cyc: Record<string, unknown> = { type: "object" };
    cyc.self = cyc;
    const d = describeToolForContext({ name: "write_file", description: "d", parameters: cyc }, {});
    expect(d.schema).not.toBe(cyc);
    expect((d.schema as { self: unknown }).self).toBe(d.schema);
    (d.schema as { type?: string }).type = "mutated";
    expect(cyc.type).toBe("object");
  });
});

describe("projectToolsForContext:不可变/确定性/边界", () => {
  it("P1 返回新数组,不改入参数组", () => {
    const tools = [writeTool, readTool, delegateTool];
    const out = projectToolsForContext(tools, { permissionMode: "plan", availableTools: ["worker"] });
    expect(out).not.toBe(tools);
    expect(tools.length).toBe(3);
    expect(tools[0]!.description).toBe(writeTool.description);
    expect(out.length).toBe(3);
  });

  it("P2 未改动工具保持原引用(默认路径逐字节不变)", () => {
    const out = projectToolsForContext([readTool], { permissionMode: "plan" });
    expect(out[0]).toBe(readTool);
  });

  it("P3 改动工具是新对象且保留其它字段", () => {
    const withExtra = { ...writeTool, deferred: true, execute: () => "ok" };
    const out = projectToolsForContext([withExtra], { permissionMode: "plan" });
    expect(out[0]).not.toBe(withExtra);
    expect((out[0] as unknown as { deferred: boolean }).deferred).toBe(true);
    expect(typeof (out[0] as unknown as { execute: () => string }).execute).toBe("function");
  });

  it("P4 确定性:同一入参两次结果等值", () => {
    const ctx = { permissionMode: "plan", taskClass: "qa", availableTools: ["planner"] };
    expect(projectToolsForContext([writeTool, delegateTool], ctx)).toEqual(
      projectToolsForContext([writeTool, delegateTool], ctx),
    );
  });

  it("P5 空数组 → 空数组", () => {
    expect(projectToolsForContext([], { permissionMode: "plan" })).toEqual([]);
  });

  it("P6 畸形元素原样透传,不抛错", () => {
    const bad = null as unknown as ToolLike;
    const out = projectToolsForContext([bad, writeTool], { permissionMode: "plan" });
    expect(out.length).toBe(2);
    expect(out[0]).toBe(bad);
    expect(out[1]!.description.startsWith(READONLY_PREFIX)).toBe(true);
  });
});

describe("集合表:显式可维护", () => {
  it("S1 WRITE_TOOLS 是显式集合且含关键写类工具", () => {
    for (const n of ["write_file", "edit_file", "terminal", "run_code", "board_upsert"]) {
      expect(WRITE_TOOLS.has(n)).toBe(true);
    }
    expect(WRITE_TOOLS.has("read_file")).toBe(false);
    expect(WRITE_TOOLS.has("tool_view")).toBe(false);
  });

  it("S2 DELEGATE_TOOLS 含 spawn_subagent 且不含 read_file", () => {
    expect(DELEGATE_TOOLS.has("spawn_subagent")).toBe(true);
    expect(DELEGATE_TOOLS.has("read_file")).toBe(false);
  });
});
