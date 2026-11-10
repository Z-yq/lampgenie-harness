import { describe, it, expect } from "vitest";
import {
  wildcardMatch, expandHome, evaluatePermission, permissionRulesFromConfig, deriveChildRules,
} from "../src/permission/permission";

describe("core/permission( F1)", () => {
  it("wildcard:* 任意/? 单字符/精确;expandHome 展开 $HOME", () => {
    expect(wildcardMatch("spawn_subagent", "*")).toBe(true);
    expect(wildcardMatch("spawn_subagent", "spawn_*")).toBe(true);
    expect(wildcardMatch("tool", "too?")).toBe(true);
    expect(wildcardMatch("tool", "other")).toBe(false);
    expect(expandHome("$HOME/x", "/home/u")).toBe("/home/u/x");
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("/etc/*", "/home/u")).toBe("/etc/*");
  });

  it("fromConfig:平铺形态/嵌套形态/非法值显式抛错", () => {
    const flat = permissionRulesFromConfig({ spawn_subagent: "deny" });
    expect(flat).toEqual([{ permission: "spawn_subagent", action: "deny", pattern: "*" }]);
    const nested = permissionRulesFromConfig({ fs: { "/etc/*": "deny", "$HOME/*": "allow" } });
    expect(nested.find((r) => r.pattern === (process.env.HOME ?? "~") + "/*")).toBeTruthy();
    expect(() => permissionRulesFromConfig({ x: "sometimes" as never })).toThrow(/只允许/);
  });

  it("evaluate:最后命中优先/全无命中默认 ask(fail-safe)", () => {
    const rules = [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "spawn_*", pattern: "*", action: "deny" as const },
    ];
    expect(evaluatePermission("spawn_subagent", "*", [rules]).action).toBe("deny");
    expect(evaluatePermission("code_sense", "*", [rules]).action).toBe("allow");
    expect(evaluatePermission("anything", "*", [[]]).action).toBe("ask");
  });

  it("deriveChildRules:只收不放——deny 下传,allow/ask 不下传", () => {
    const parent = [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "shell", pattern: "rm *", action: "deny" as const },
      { permission: "fs", pattern: "/etc/*", action: "ask" as const },
    ];
    const child = deriveChildRules(parent);
    expect(child).toEqual([{ permission: "shell", pattern: "rm *", action: "deny" }]);
  });
});
