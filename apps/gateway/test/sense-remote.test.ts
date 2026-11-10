/**
 * 远端 code_sense 映射:桌面 dispatch → codesense CLI argv。
 * 运行时本身(自带 Node + CLI)由连接安装到远端 ~/.genie/genie-sense,
 * 由工作区服务在远端执行;此处锚定参数映射与不支持项的诚实提示。
 */
import { describe, it, expect } from "vitest";
import { dispatchSenseArgs, senseArgvFor } from "../src/sense-tool.js";

const root = "/home/u/proj";
const map = (args: Record<string, unknown>) => senseArgvFor(dispatchSenseArgs(args), root);

describe("senseArgvFor · 结构面", () => {
  it("symbol/impact/file/entrypoints/project/wire/refs/vars/branches 直映射 + --root", () => {
    expect(map({ action: "symbol", target: "foo" })).toEqual({ argv: ["symbol", "foo", "--root", root] });
    expect(map({ action: "impact", target: "foo" })).toEqual({ argv: ["impact", "foo", "--root", root] });
    expect(map({ action: "file", target: "src/a.ts" })).toEqual({ argv: ["file", "src/a.ts", "--root", root] });
    expect(map({ action: "entrypoints" })).toEqual({ argv: ["entrypoints", "--root", root] });
    expect(map({ action: "project" })).toEqual({ argv: ["project", "--root", root, "--no-llm"] });
    expect(map({ action: "wire" })).toEqual({ argv: ["wire", "--root", root] });
    expect(map({ action: "refs", target: "action" })).toEqual({ argv: ["refs", "action", "--root", root] });
    expect(map({ action: "vars", target: "src/a.ts" })).toEqual({ argv: ["vars", "src/a.ts", "--root", root] });
    expect(map({ action: "branches", target: "src/a.py" })).toEqual({ argv: ["branches", "src/a.py", "--root", root] });
  });

  it("flow:scope + level + maxNodes", () => {
    expect(map({ action: "flow", target: "src", level: "module" })).toEqual({
      argv: ["flow", "src", "--root", root, "--level", "module"],
    });
    expect(map({ action: "flow", level: "function", maxNodes: 40 })).toEqual({
      argv: ["flow", ".", "--root", root, "--level", "function", "--max-nodes", "40"],
    });
  });
});

describe("senseArgvFor · 语义面(远端可得的能力)", () => {
  it("auto/explore → explore;plan → modules;debug → symbol --depth 2;api/state/algo 直映射", () => {
    expect(map({ mode: "auto", query: "记忆写入" })).toEqual({ argv: ["explore", "记忆写入", "--root", root] });
    expect(map({ mode: "explore", query: "memory" })).toEqual({ argv: ["explore", "memory", "--root", root] });
    expect(map({ mode: "plan", query: "整体架构" })).toEqual({ argv: ["modules", "--root", root] });
    expect(map({ mode: "debug", query: "build_user_memory" })).toEqual({ argv: ["symbol", "build_user_memory", "--root", root, "--depth", "2"] });
    expect(map({ mode: "api", query: "接口" })).toEqual({ argv: ["api", "--root", root] });
    expect(map({ mode: "state", query: "状态" })).toEqual({ argv: ["state", "--root", root] });
    expect(map({ mode: "algo", query: "训练" })).toEqual({ argv: ["algo", "--root", root] });
  });

  it("不支持的语义模式/缺 query 如实拒绝(不静默降级)", () => {
    const ui = map({ mode: "ui", query: "页面流" });
    expect("unsupported" in ui && ui.unsupported).toContain("mode=ui");
    const empty = map({ mode: "debug", query: "  " });
    expect("unsupported" in empty && empty.unsupported).toContain("query");
  });
});
