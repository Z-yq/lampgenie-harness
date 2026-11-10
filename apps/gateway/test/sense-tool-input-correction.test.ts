/**
 * code_sense 入参纠偏( token 轮 P2)。
 * 经验证驱动:24h 2064 次调用里 code_sense 被调 14 次、**硬失败率 21.4%**;同期 grep 124 次、
 * read_file 227 次。典型错法是拿「目录路径」当符号名查 symbol/impact——索引里当然零命中,
 * 回一段表面成功(空清单),模型只能自己悟,于是重试或改用 read_file 整读(经验证 read_file
 * 单次峰值 71,967 字符)。
 * 契约:只拦**确定会零命中**的形态(路径/文件名 → 当符号名;中文/路径 → mode=debug),
 * 且回执必须给出**可直接照抄的替代调用**,而不是笼统建议。真正「符号名可能不存在」不拦
 * ——那是正常查询,空结果是有效信息。
 */
import { describe, it, expect } from "vitest";
import { dispatchSenseArgs, semanticQueryHint, structuralTargetHint, stripRedundantTargetPrefix } from "../src/sense-tool.js";

describe("structuralTargetHint:路径当符号名", () => {
  it("symbol/impact 收到目录路径 → 拦下并给出三条替代调用", () => {
    for (const action of ["symbol", "impact"] as const) {
      const hint = structuralTargetHint(action, "packages/harness-runtime/src/agent");
      expect(hint).toBeDefined();
      expect(hint).toContain("不是符号名");
      expect(hint).toContain("action=file");        // 看文件符号表
      expect(hint).toContain("action=branches");    // 看分支骨架
      expect(hint).toContain("mode=explore");       // 语义检索
    }
  });

  it("symbol/impact 收到带扩展名的文件名 → 也拦(同样必然零命中)", () => {
    expect(structuralTargetHint("symbol", "apps/gateway/src/agent-wiring.ts")).toBeDefined();
    expect(structuralTargetHint("impact", "loop.ts")).toBeDefined();
  });

  it("negative 真符号名放行(不误拦正常查询)", () => {
    expect(structuralTargetHint("symbol", "deriveMessages")).toBeUndefined();
    expect(structuralTargetHint("impact", "AgentLoop.runTurn")).toBeUndefined();
    // 空 target 也放行(各 action 自己的「需要 target」文案更准确)
    expect(structuralTargetHint("symbol", "")).toBeUndefined();
  });

  it("negative 本来就要路径的 action 不拦(file/branches/vars/flow)", () => {
    for (const action of ["file", "branches", "vars", "flow"] as const) {
      expect(structuralTargetHint(action, "apps/gateway/src/agent-wiring.ts")).toBeUndefined();
    }
  });
});

describe("semanticQueryHint:mode=debug 收到非符号名", () => {
  it("中文自然语言 → 拦下并指向 explore", () => {
    const hint = semanticQueryHint("debug", "聊天窗模型切换怎么做的");
    expect(hint).toBeDefined();
    expect(hint).toContain("mode=explore");
    expect(hint).toContain("自然语言");
  });

  it("路径形态 → 拦下", () => {
    const hint = semanticQueryHint("debug", "apps/gateway/src/panel.ts");
    expect(hint).toBeDefined();
    expect(hint).toContain("路径形态");
  });

  it("negative 真符号名放行", () => {
    expect(semanticQueryHint("debug", "deriveMessages")).toBeUndefined();
    expect(semanticQueryHint("debug", "AgentLoop.runTurn")).toBeUndefined();
  });

  it("negative 其它 mode 不做形态拦截(query 允许自然语言)", () => {
    expect(semanticQueryHint("explore", "聊天窗模型切换")).toBeUndefined();
    expect(semanticQueryHint("plan", "这个项目架构怎么样")).toBeUndefined();
  });
});

describe("dispatchSenseArgs 端到端", () => {
  it("路径当 symbol → kind=invalid(不发起索引查询)", () => {
    const d = dispatchSenseArgs({ action: "symbol", target: "packages/harness-runtime/src/agent" });
    expect(d.kind).toBe("invalid");
    if (d.kind === "invalid") expect(d.reason).toContain("action=file");
  });

  it("negative 正常结构查询仍走 structural", () => {
    const d = dispatchSenseArgs({ action: "impact", target: "deriveMessages" });
    expect(d.kind).toBe("structural");
    if (d.kind === "structural") {
      expect(d.action).toBe("impact");
      expect(d.target).toBe("deriveMessages");
    }
  });

  it("negative 旧习惯「把 target 写进 query」仍被兜住(不被新校验误伤)", () => {
    const d = dispatchSenseArgs({ action: "symbol", query: "deriveMessages" });
    expect(d.kind).toBe("structural");
    if (d.kind === "structural") expect(d.target).toBe("deriveMessages");
  });

  it("debug + 中文 → kind=invalid 并指向 explore", () => {
    const d = dispatchSenseArgs({ mode: "debug", query: "白板怎么画的" });
    expect(d.kind).toBe("invalid");
    if (d.kind === "invalid") expect(d.reason).toContain("mode=explore");
  });
});

describe("stripRedundantTargetPrefix:root 收窄后剥冗余前缀(a1)", () => {
  const REPO = "/ws";
  const SUB = "/ws/packages/harness-workflow";

  it("相对前缀剥离:target 带工作区根→子仓前缀 → 剥成相对子仓路径", () => {
    expect(stripRedundantTargetPrefix(REPO, SUB, "packages/harness-workflow/src/engine.ts")).toBe("src/engine.ts");
    // Windows 反斜杠形态也剥
    expect(stripRedundantTargetPrefix(REPO, SUB, "packages\\harness-workflow\\src\\engine.ts")).toBe("src/engine.ts");
    // ./ 前缀先去掉再剥
    expect(stripRedundantTargetPrefix(REPO, SUB, "./packages/harness-workflow/src/engine.ts")).toBe("src/engine.ts");
  });

  it("恰等于前缀 → 空串(target 本身就是子仓根)", () => {
    expect(stripRedundantTargetPrefix(REPO, SUB, "packages/harness-workflow")).toBe("");
    expect(stripRedundantTargetPrefix(REPO, SUB, "packages/harness-workflow/")).toBe("");
  });

  it("绝对路径落在 effRoot 内 → 相对化为子仓相对路径;根外绝对路径原样返回", () => {
    expect(stripRedundantTargetPrefix(REPO, SUB, "/ws/packages/harness-workflow/src/engine.ts")).toBe("src/engine.ts");
    expect(stripRedundantTargetPrefix(REPO, SUB, "/ws/packages/harness-workflow")).toBe("");
    // effRoot 本身(equal 分支)
    expect(stripRedundantTargetPrefix(REPO, SUB, SUB)).toBe("");
    // 根外绝对路径:不擅动
    expect(stripRedundantTargetPrefix(REPO, SUB, "/elsewhere/src/engine.ts")).toBe("/elsewhere/src/engine.ts");
  });

  it("无关 target(不带子仓前缀的相对路径)原样返回", () => {
    expect(stripRedundantTargetPrefix(REPO, SUB, "src/engine.ts")).toBe("src/engine.ts");
    expect(stripRedundantTargetPrefix(REPO, SUB, "packages/other-repo/src/engine.ts")).toBe("packages/other-repo/src/engine.ts");
  });

  it("effRoot===repoRoot 时 prefix 为 '.',不剥任何东西", () => {
    expect(stripRedundantTargetPrefix("/ws", "/ws", "src/engine.ts")).toBe("src/engine.ts");
  });
});