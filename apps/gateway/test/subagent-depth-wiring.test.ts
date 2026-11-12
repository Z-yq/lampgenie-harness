/**
 * 网关接线单测:读源码断言 + 纯路径直测。
 * ① 深度校验必须发生在 spawn 记录登记之前(链推导,Fail-closed);
 * ② 工具面 deny 收敛接进子代理池(convergeDeny + PRIMARY_ONLY_TOOLS + journal 留痕);
 * ③ resume_agent 用同一 child 会话键(child:<原 taskId>),不新开会话;
 * ④ 纯路径直测:证实网关解析到的 runtime 模块行为与契约一致。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_SUBAGENT_DEPTH,
  convergeDeny,
  resumeSessionKey,
  spawnDepthVerdict,
} from "@lampgenie/runtime/agent/subagent-depth";
import { DEFAULT_SUBAGENT_DENY, PRIMARY_ONLY_TOOLS, convergeProfileTools } from "@lampgenie/runtime/agent/agent-profiles";
import { AGENT_WIRING_SRC } from "./panel-source.js";

const wiring = AGENT_WIRING_SRC;

/** 取两个锚点之间的源码段(锚点不命中直接失败,不静默返回空)。 */
function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
}

describe("深度校验接在 spawn 前(链推导)", () => {
  it("从 subagent-depth 导入 spawnDepthVerdict(而非只靠旧 depthOf)", () => {
    expect(wiring).toContain('from "@lampgenie/runtime/agent/subagent-depth"');
    expect(wiring).toContain("spawnDepthVerdict");
  });

  it("用 registry records 作唯一事实来源( list 快照)", () => {
    const block = between(wiring, "const depthVerdict = spawnDepthVerdict({", "if (!depthVerdict.ok)");
    expect(block).toContain("records: subagentRegistry.list({ includeDone: true, limit: 200 })");
    expect(block).toContain("parentId: task.id");
  });

  it("校验早于 registry.register(本次 spawn 记录尚未进入链)", () => {
    const depthAt = wiring.indexOf("const depthVerdict = spawnDepthVerdict({");
    const registerAt = wiring.indexOf("subagentRegistry.register({");
    expect(depthAt).toBeGreaterThan(0);
    expect(registerAt).toBeGreaterThan(depthAt);
  });

  it("非 OK 直接 rejected 并落 journal(subagent.depth.reject),不 spawn", () => {
    const block = between(wiring, "if (!depthVerdict.ok) {", "//  嵌套深度");
    expect(block).toContain('type: "subagent.depth.reject"');
    expect(block).toContain("code: depthVerdict.code");
    expect(block).toContain("reason: depthVerdict.reason");
    expect(block).toContain('status: "rejected"');
    expect(block).not.toContain("registerSubagentRecord()");
  });

  it("自报深度只作为 requestedDepth 传入(不参与判定)", () => {
    const block = between(wiring, "const depthVerdict = spawnDepthVerdict({", "if (!depthVerdict.ok)");
    expect(block).toContain("...(typeof rawArgs.depth === \"number\" ? { requestedDepth: rawArgs.depth } : {})");
  });
});

describe("工具面 deny 收敛接入子代理池", () => {
  it("用 convergeDeny + PRIMARY_ONLY_TOOLS 计算 deny", () => {
    const block = between(wiring, "const convergedDeny = convergeDeny({", "const allowedExtraTools");
    expect(block).toContain("parentDeny: parentDenyNames");
    expect(block).toContain("primaryOnly: PRIMARY_ONLY_TOOLS");
    expect(block).toContain('kind: "subagent"');
  });

  it("父 deny 取自当前 permissionRules 的 deny 规则", () => {
    const block = between(wiring, "const parentDenyNames =", "const convergedDeny");
    expect(block).toContain('filter((r) => r.action === "deny")');
    expect(block).toContain("r.permission");
  });

  it("deny 命中的注入面工具从池中摘掉,并喂给后端 extraTools", () => {
    expect(wiring).toContain("const allowedExtraTools = capExtraTools ? capExtraTools.filter((t) => !convergedDeny.includes(t.name)) : undefined;");
    expect(wiring).toContain("...SUBAGENT_WRITE_TOOLS, ...allowedExtraTools.map((t) => t.name)");
    expect(wiring).toContain("toolWhitelist: cap.toolWhitelist, extraTools: allowedExtraTools");
  });

  it("journal 留痕 subagent.tool.deny(带 agentId 与 deny 列表)", () => {
    const block = between(wiring, 'type: "subagent.tool.deny"', "// 子代理工具池名字集");
    expect(block).toContain("agentId: bgAgentId");
    expect(block).toContain("deny: convergedDeny");
  });
});

describe("resume_agent 同 child 会话续跑", () => {
  it("spawn 侧接受 resumeSessionKey 并据此定 TaskSpec.taskId(不加 -sub/-bg)", () => {
    expect(wiring).toContain("const resumeSessionKeyArg = typeof rawArgs.resumeSessionKey === \"string\"");
    expect(wiring).toContain("const subTaskId = resumeSessionKeyArg ?? (task.id.slice(0, 8) + \"-\" + bgAgentId.slice(6, 14));");
    expect(wiring).toContain("const taskSpecId = (suffix: \"-sub\" | \"-bg\"): string => resumeSessionKeyArg ?? subTaskId + suffix;");
    expect(wiring).toContain('taskId: taskSpecId("-sub")');
    expect(wiring).toContain('taskId: taskSpecId("-bg")');
  });

  it("resume 侧用 resumeSessionKey 生成键并传给 spawn", () => {
    expect(wiring).toContain('const sessionKey = resumeSessionKey(String(rec?.taskId || id).replace(/^child:/, ""));');
    expect(wiring).toContain("resumeSessionKey: sessionKey");
  });

  it("registry 记录用同一 subTaskId(键写进 registry,不新建会话 id)", () => {
    const block = between(wiring, "subagentRegistry.register({", "// :原任务书/角色留进程内");
    expect(block).toContain("taskId: subTaskId");
    expect(block).toContain("parentId: task.id");
  });
});

describe("纯路径直测(网关解析到的 runtime 模块)", () => {
  it("探针 A:root→a→b→c 深度 3,再 spawn 拒绝", () => {
    const records = [
      { agentId: "root" },
      { agentId: "a", parentId: "root" },
      { agentId: "b", parentId: "a" },
      { agentId: "c", parentId: "b" },
    ];
    expect(spawnDepthVerdict({ records, parentId: "b" })).toMatchObject({ ok: true, depth: 3 });
    expect(spawnDepthVerdict({ records, parentId: "c" })).toMatchObject({ ok: false, code: "DEPTH_EXCEEDED", depth: 4 });
  });

  it("探针 B:成环 → CYCLE", () => {
    expect(spawnDepthVerdict({ records: [{ agentId: "a", parentId: "b" }, { agentId: "b", parentId: "a" }], parentId: "a" }).code).toBe("CYCLE");
  });

  it("探针 C+E:父 deny ∪ 子 deny ∪ 默认 deny", () => {
    const r = convergeDeny({ parentDeny: ["terminal"], childDeny: ["board"] });
    expect(r.deny).toEqual(expect.arrayContaining(["terminal", "board", ...DEFAULT_SUBAGENT_DENY]));
  });

  it("探针 D:primary-only 工具默认即 deny(清单当前为空,给出清单时必须命中)", () => {
    const r = convergeDeny({ primaryOnly: ["spawn_subagent"] });
    expect(r.deny).toContain("spawn_subagent");
    expect(convergeDeny({ primaryOnly: PRIMARY_ONLY_TOOLS }).deny).toEqual(["task", "todowrite"]);
  });

  it("探针 F:resumeSessionKey 稳定 child:<taskId>", () => {
    expect(resumeSessionKey("1a2b3c4d")).toBe("child:1a2b3c4d");
  });

  it("convergeProfileTools:declared 白名单剔除 deny、fallback 保持 *", () => {
    const declared = convergeProfileTools({ name: "x", description: "", systemPrompt: "", tools: ["read", "task"], builtin: false }, ["todowrite"]);
    expect(declared).toMatchObject({ source: "declared", converged: true });
    expect(declared.allow).toEqual(["read_file", "glob", "grep", "list_dir"]);
    expect(declared.deny).toContain("task");
    const fallback = convergeProfileTools(undefined, []);
    expect(fallback).toMatchObject({ source: "fallback", allow: ["*"], converged: false });
  });

  it("上限常量与契约一致(=3)", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3);
  });
});
