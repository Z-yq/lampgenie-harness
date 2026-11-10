/**
 * M153 工具注册身份治理:注册规则(保留名/重复/alias 一跳/遮蔽)+ override 授权 +
 * 未知工具可达候选。纯内存、零依赖,直接单测规则优先级。
 */
import { describe, it, expect } from "vitest";
import {
  ToolIdentityRegistry,
  describeUnknownTool,
  RESERVED_TOOL_NAMES,
} from "../src/agent/tool-identity";

describe("ToolIdentityRegistry.register:保留名", () => {
  it("plugin/mcp 注册 read_file → RESERVED_NAME_REJECTED", () => {
    for (const source of ["plugin", "mcp"] as const) {
      const r = new ToolIdentityRegistry().register({ name: "read_file", source });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("RESERVED_NAME_REJECTED");
    }
  });

  it("builtin read_file 成功,且 list/inspect/resolve 一致", () => {
    const reg = new ToolIdentityRegistry();
    const r = reg.register({ name: "read_file", source: "builtin" });
    expect(r.ok).toBe(true);
    expect(reg.list().map((x) => x.name)).toEqual(["read_file"]);
    expect(reg.inspect("read_file")).toMatchObject({ name: "read_file", source: "builtin" });
    expect(reg.resolve("read_file")).toMatchObject({ toolName: "read_file", source: "builtin", authorized: true });
  });

  it("RESERVED_TOOL_NAMES 覆盖任务书点名的核心工具", () => {
    for (const n of ["read_file", "write_file", "edit_file", "terminal", "spawn_subagent", "code_sense", "result_read"]) {
      expect(RESERVED_TOOL_NAMES).toContain(n);
    }
  });
});

describe("ToolIdentityRegistry.register:alias", () => {
  it("合法 alias 解引用到 canonical,source 取 canonical 的 source", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    const r = reg.register({ name: "slurp", source: "alias", canonical: "read_file", ownerId: "worker-1" });
    expect(r.ok).toBe(true);
    const resolved = reg.resolve("slurp")!;
    expect(resolved.toolName).toBe("read_file");
    expect(resolved.source).toBe("builtin");
    expect(reg.inspect("slurp")).toMatchObject({ name: "slurp", source: "alias", canonical: "read_file" });
    expect(reg.list()).toHaveLength(2);
  });

  it("alias 名等于保留名 write_file → SHADOW_REJECTED", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    const r = reg.register({ name: "write_file", source: "alias", canonical: "read_file" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SHADOW_REJECTED");
  });

  it("alias 名等于已存在 canonical → SHADOW_REJECTED", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    reg.register({ name: "slurp", source: "builtin" });
    const r = reg.register({ name: "slurp", source: "alias", canonical: "read_file" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SHADOW_REJECTED");
  });

  it("alias → alias → ALIAS_TO_ALIAS;canonical 缺失/未注册 → CANONICAL_MISSING", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    reg.register({ name: "slurp", source: "alias", canonical: "read_file" });
    const chain = reg.register({ name: "slurp2", source: "alias", canonical: "slurp" });
    expect(chain.ok).toBe(false);
    if (!chain.ok) expect(chain.code).toBe("ALIAS_TO_ALIAS");
    const noCanon = reg.register({ name: "orphan", source: "alias" });
    expect(noCanon.ok).toBe(false);
    if (!noCanon.ok) expect(noCanon.code).toBe("CANONICAL_MISSING");
    const missing = reg.register({ name: "orphan2", source: "alias", canonical: "nope" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("CANONICAL_MISSING");
  });
});

describe("ToolIdentityRegistry.register:重复与幂等", () => {
  it("两个 builtin 同名 → DUPLICATE_NAME", () => {
    const reg = new ToolIdentityRegistry();
    expect(reg.register({ name: "dup_tool", source: "builtin" }).ok).toBe(true);
    const r = reg.register({ name: "dup_tool", source: "builtin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DUPLICATE_NAME");
    expect(reg.list()).toHaveLength(1);
  });

  it("同 owner+name+source+canonical 重复登记 → 幂等成功", () => {
    const reg = new ToolIdentityRegistry();
    const first = reg.register({ name: "plugin_tool", source: "plugin", ownerId: "w1" });
    const again = reg.register({ name: "plugin_tool", source: "plugin", ownerId: "w1" });
    expect(first.ok && first.idempotent).toBeFalsy();
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.idempotent).toBe(true);
    expect(reg.list()).toHaveLength(1);
  });

  it("alias 同 owner 重复登记 → 幂等成功", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    reg.register({ name: "slurp", source: "alias", canonical: "read_file", ownerId: "w1" });
    const again = reg.register({ name: "slurp", source: "alias", canonical: "read_file", ownerId: "w1" });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.idempotent).toBe(true);
    expect(reg.list()).toHaveLength(2);
  });

  it("非法名 → INVALID_NAME", () => {
    const reg = new ToolIdentityRegistry();
    for (const name of ["", "有中文", "has space", "a".repeat(129)]) {
      const r = reg.register({ name, source: "builtin" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("INVALID_NAME");
    }
  });
});

describe("ToolIdentityRegistry:override 授权与注销", () => {
  it("带 ownerId 注册,grant 后 authorized=true,revoke 后 false", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    reg.register({ name: "slurp", source: "alias", canonical: "read_file", ownerId: "worker-1" });
    // alias 侧带 ownerId:未授权 → false
    expect(reg.resolve("slurp")!.authorized).toBe(false);
    reg.grantOverride("worker-1", "read_file");
    expect(reg.resolve("slurp")!.authorized).toBe(true);
    expect(reg.isAuthorized("worker-1", "read_file")).toBe(true);
    reg.revokeOverride("worker-1", "read_file");
    expect(reg.resolve("slurp")!.authorized).toBe(false);
    expect(reg.isAuthorized("worker-1", "read_file")).toBe(false);
  });

  it("无 ownerId 的公共工具恒可授权", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    expect(reg.isAuthorized(undefined, "read_file")).toBe(true);
  });

  it("unregister(owner) 撤销其 alias 与 override,返回被删 alias 名", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    reg.register({ name: "slurp", source: "alias", canonical: "read_file", ownerId: "worker-1" });
    reg.register({ name: "slurp2", source: "alias", canonical: "read_file", ownerId: "worker-2" });
    reg.grantOverride("worker-1", "read_file");
    const removed = reg.unregister("worker-1");
    expect(removed).toEqual(["slurp"]);
    expect(reg.resolve("slurp")).toBeNull();
    expect(reg.isAuthorized("worker-1", "read_file")).toBe(false);
    // 其他 owner 不受影响
    expect(reg.inspect("slurp2")).toMatchObject({ ownerId: "worker-2" });
    expect(reg.resolve("read_file")!.toolName).toBe("read_file");
  });

  it("未注册名 resolve 返回 null", () => {
    expect(new ToolIdentityRegistry().resolve("ghost")).toBeNull();
  });
});

describe("ToolIdentityRegistry.register:alias 先占名(防影子 canonical)", () => {
  it("alias 已占用该名 → builtin/mcp/plugin 同名注册一律 DUPLICATE_NAME,且 resolve 仍指向 alias 目标", () => {
    for (const source of ["builtin", "mcp", "plugin"] as const) {
      const reg = new ToolIdentityRegistry();
      reg.register({ name: "read_file", source: "builtin" });
      expect(reg.register({ name: "rf", source: "alias", canonical: "read_file", ownerId: "m1" }).ok).toBe(true);
      const shadow = reg.register({ name: "rf", source, ownerId: "m2" });
      expect(shadow.ok).toBe(false);
      if (!shadow.ok) {
        expect(shadow.code).toBe("DUPLICATE_NAME");
        expect(shadow.message).toContain("已被 alias 占用");
      }
      // 注册被拒后表内不新增真名,resolve 仍是 alias 目标
      expect(reg.inspect("rf")).toMatchObject({ source: "alias", canonical: "read_file" });
      expect(reg.resolve("rf")).toMatchObject({ toolName: "read_file", source: "builtin" });
      expect(reg.list()).toHaveLength(2);
    }
  });

  it("unregister(owner) 后 resolve(alias 名) === null(不再被影子 canonical 顶替)", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    reg.register({ name: "rf", source: "alias", canonical: "read_file", ownerId: "m1" });
    // 影子注册必须先被拒,否则下面的 null 断言会被假的真名顶替
    expect(reg.register({ name: "rf", source: "mcp", ownerId: "m2" }).ok).toBe(false);
    expect(reg.unregister("m1")).toEqual(["rf"]);
    expect(reg.resolve("rf")).toBeNull();
    expect(reg.inspect("rf")).toBeNull();
    // 原 canonical 不受伤
    expect(reg.resolve("read_file")!.toolName).toBe("read_file");
  });

  it("alias 被撤销后该名可重新注册为真名(占名随 alias 撤销释放)", () => {
    const reg = new ToolIdentityRegistry();
    reg.register({ name: "read_file", source: "builtin" });
    reg.register({ name: "rf", source: "alias", canonical: "read_file", ownerId: "m1" });
    reg.unregister("m1");
    const again = reg.register({ name: "rf", source: "mcp", ownerId: "m2" });
    expect(again.ok).toBe(true);
    expect(reg.resolve("rf")).toMatchObject({ toolName: "rf", source: "mcp" });
  });
});

describe("describeUnknownTool", () => {
  it("近似名:read_fil → reachableFrom 首项 read_file", () => {
    const s = describeUnknownTool("read_fil", ["terminal", "read_file", "write_file"]);
    expect(s.reachableFrom[0]).toBe("read_file");
    expect(s.message).toContain("未知工具 read_fil");
    expect(s.message).toContain("可达:");
  });

  it("完全无关名:reachableFrom ≤3 且 message 含「可达」", () => {
    const s = describeUnknownTool("zzzzzz", ["read_file", "write_file", "terminal", "glob", "grep"]);
    expect(s.reachableFrom.length).toBeLessThanOrEqual(3);
    expect(s.reachableFrom.length).toBeGreaterThan(0);
    expect(s.message).toContain("可达");
  });

  it("available 为空 → 明示当前无工具", () => {
    const s = describeUnknownTool("read_file", []);
    expect(s.reachableFrom).toEqual([]);
    expect(s.message).toContain("(当前无工具)");
  });
});
