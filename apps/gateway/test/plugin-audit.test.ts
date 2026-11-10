/**
 * 插件清单 ABI / 能力 / consent 指纹 / 审计表 / kill list 纯函数测试(M135 A 段)。
 * 另含「ABI 拒装时零落盘」的接线断言(plugin-audit 是唯一实现,plugins.ts 只接线)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_ABI_INVALID,
  PLUGIN_CAPABILITY_UNKNOWN,
  PLUGIN_CONSENT_REQUIRED,
  PLUGIN_KILLED,
  PLUGIN_UNPINNED,
  buildPluginAudit,
  checkCapabilities,
  consentHash,
  declaredSet,
  isKilled,
  parseKillList,
  validateManifest,
  type AuditAsset,
} from "../src/plugin-audit.js";
import { PluginSystem } from "../src/plugins.js";

/** 合法清单基线(命令资产)。 */
function base(): Record<string, unknown> {
  return {
    id: "demo",
    name: "演示插件",
    description: "演示用",
    version: "1.0.0",
    author: "genie",
    category: "开发",
    provides: { commands: [{ name: "demo", body: "做点事" }] },
  };
}

function walk(root: string, baseDir = root): string[] {
  const out: string[] = [];
  for (const e of readdirSync(baseDir, { withFileTypes: true })) {
    const p = join(baseDir, e.name);
    const rel = p.slice(root.length + 1);
    if (e.isDirectory()) out.push(rel + "/", ...walk(root, p));
    else out.push(rel);
  }
  return out.sort();
}

describe("validateManifest(ABI 校验)", () => {
  it("合法清单(含 pin 元数据键 uid/url/zip/sha256)通过", () => {
    const m = { ...base(), uid: "u1", url: "https://x/p.zip", zip: "p.zip", sha256: "abc", componentTypes: ["command"] };
    expect(validateManifest(m)).toEqual({ ok: true });
  });

  it("未知顶层键 / 未知 provides 键 / 未知资产字段:稳定码 + issues 路径,一次收全", () => {
    const m = {
      ...base(),
      surprise: 1,
      provides: {
        commands: [{ name: "x", body: "y", foo: 1 }],
        robots: [{ name: "r" }],
      },
    };
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(PLUGIN_ABI_INVALID);
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("surprise");
    expect(paths).toContain("provides.commands[0].foo");
    expect(paths).toContain("provides.robots");
    // 不短路:一次至少 3 条
    expect(r.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("必填缺失 / 类型错 / 枚举错:issues 带精确路径", () => {
    const m: Record<string, unknown> = {
      id: "demo",
      version: 1,
      author: "genie",
      category: "开发",
      source: "blackmarket",
      componentTypes: "skill",
      icon: 5,
      provides: [],
    };
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.issues.map((i) => i.path).sort();
    expect(paths).toContain("name");
    expect(paths).toContain("description");
    expect(paths).toContain("version");
    expect(paths).toContain("source");
    expect(paths).toContain("componentTypes");
    expect(paths).toContain("icon");
    expect(paths).toContain("provides");
  });

  it("资产字段缺必填 / 类型错 / 非对象条目", () => {
    const m = {
      ...base(),
      provides: {
        agents: [{ name: "a", description: "d" }, 7],
        mcp: [{ name: "m", command: "npx", args: "x" }],
        skills: [{ name: "s", description: "d", body: "b", extra: true }],
      },
    };
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("provides.agents[0].systemPrompt");
    expect(paths).toContain("provides.agents[1]");
    expect(paths).toContain("provides.mcp[0].args");
    expect(paths).toContain("provides.skills[0].extra");
  });
});

describe("checkCapabilities(能力白名单)", () => {
  it("skill/command/agent/mcp/hook/ui 全部合法", () => {
    const m = { ...base(), componentTypes: ["skill", "command", "agent", "mcp", "hook", "ui"] };
    expect(checkCapabilities(m)).toEqual({ ok: true });
  });

  it("白名单外的组件类型 → PLUGIN_CAPABILITY_UNKNOWN + unknown 列表", () => {
    const m = { ...base(), componentTypes: ["skill", "telepathy", "telepathy"] };
    const r = checkCapabilities(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(PLUGIN_CAPABILITY_UNKNOWN);
    expect(r.unknown).toEqual(["telepathy"]);
  });
});

describe("declaredSet / consentHash", () => {
  it("声明集名字排序、固定键序", () => {
    const m = {
      ...base(),
      provides: {
        commands: [{ name: "zeta", body: "z" }, { name: "alpha", body: "a" }],
        skills: [{ name: "s1", description: "d", body: "b" }],
      },
    };
    const ds = declaredSet(m);
    expect(Object.keys(ds)).toEqual(["version", "commands", "agents", "mcp", "skills"]);
    expect(ds.commands).toEqual(["alpha", "zeta"]);
    expect(ds.skills).toEqual(["s1"]);
    expect(consentHash(m)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("provides 顺序打乱 hash 不变;version 或新增命令 hash 变", () => {
    const a = { ...base(), provides: { commands: [{ name: "a", body: "1" }, { name: "b", body: "2" }] } };
    const b = { ...base(), provides: { commands: [{ name: "b", body: "2" }, { name: "a", body: "1" }] } };
    expect(consentHash(a)).toBe(consentHash(b));
    const c = { ...a, version: "1.0.1" };
    expect(consentHash(c)).not.toBe(consentHash(a));
    const d = { ...a, provides: { commands: [{ name: "a", body: "1" }, { name: "b", body: "2" }, { name: "c", body: "3" }] } };
    expect(consentHash(d)).not.toBe(consentHash(a));
    // body 变更不属于声明集(授权粒度=版本+资产名)
    const e = { ...a, provides: { commands: [{ name: "a", body: "改了正文" }, { name: "b", body: "2" }] } };
    expect(consentHash(e)).toBe(consentHash(a));
  });

  it("同清单卸载后重装:台账 consentHash 相同", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-consent-"));
    try {
      mkdirSync(join(root, ".genie"), { recursive: true });
      writeFileSync(join(root, ".genie", "plugins-catalog.json"), JSON.stringify([base()]), "utf-8");
      const ps = new PluginSystem(root, () => ({ id: "m" }), () => true);
      const r1 = ps.install("demo") as { consentHash: string; status: string };
      expect(r1.consentHash).toBe(consentHash(base()));
      expect(r1.status).toBe("installed");
      ps.uninstall("demo");
      const r2 = ps.install("demo") as { consentHash: string };
      expect(r2.consentHash).toBe(r1.consentHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildPluginAudit(审计表)", () => {
  it("静态:provides 每项一行 ok,ok=true", () => {
    const m = {
      ...base(),
      provides: {
        commands: [{ name: "c1", body: "b" }],
        agents: [{ name: "a1", description: "d", systemPrompt: "s" }],
        mcp: [{ name: "m1", command: "npx" }],
        skills: [{ name: "s1", description: "d", body: "b" }],
      },
    };
    const a = buildPluginAudit(m);
    expect(a.id).toBe("demo");
    expect(a.version).toBe("1.0.0");
    expect(a.assets.map((x) => x.kind).sort()).toEqual(["agent", "command", "mcp", "skill"]);
    expect(a.assets.every((x) => x.status === "ok")).toBe(true);
    expect(a.ok).toBe(true);
  });

  it("空资产视为 ok:true", () => {
    const a = buildPluginAudit({ ...base(), provides: {} });
    expect(a.assets).toEqual([]);
    expect(a.ok).toBe(true);
  });

  it("componentTypes 含 ui/hook → unsupported-runtime 行,ok=false", () => {
    const m = { ...base(), componentTypes: ["command", "ui", "hook"] };
    const a = buildPluginAudit(m);
    const ui = a.assets.find((x) => x.kind === "ui");
    const hook = a.assets.find((x) => x.kind === "hook");
    expect(ui).toMatchObject({ name: "(runtime)", status: "unsupported", reason: "unsupported-runtime" });
    expect(hook).toMatchObject({ status: "unsupported", reason: "unsupported-runtime" });
    expect(a.ok).toBe(false);
  });

  it("outcomes 按 kind+name 覆盖同名行,其余保留;degraded → ok=false", () => {
    const m = {
      ...base(),
      provides: { commands: [{ name: "c1", body: "b" }], mcp: [{ name: "m1", command: "npx" }] },
    };
    const outcomes: AuditAsset[] = [
      { kind: "mcp", name: "m1", status: "degraded", reason: "宿主不可用" },
      { kind: "mcp", name: "m2", status: "skipped", reason: "坏 .mcp.json" },
    ];
    const a = buildPluginAudit(m, outcomes);
    expect(a.assets.filter((x) => x.kind === "command")).toEqual([{ kind: "command", name: "c1", status: "ok" }]);
    expect(a.assets.find((x) => x.kind === "mcp" && x.name === "m1")).toMatchObject({ status: "degraded", reason: "宿主不可用" });
    expect(a.assets.some((x) => x.kind === "mcp" && x.name === "m2")).toBe(true);
    expect(a.ok).toBe(false);
  });
});

describe("kill list", () => {
  it("parseKillList:坏 JSON / 非数组 → [];条目规范化", () => {
    expect(parseKillList(null)).toEqual([]);
    expect(parseKillList(undefined)).toEqual([]);
    expect(parseKillList("not json{{")).toEqual([]);
    expect(parseKillList('{"id":"x"}')).toEqual([]);
    expect(parseKillList('[{"id":"a","version":"1.0.0","reason":"r"},{"nope":1},{"id":"b"}]')).toEqual([
      { id: "a", version: "1.0.0", reason: "r" },
      { id: "b" },
    ]);
  });

  it("isKilled:version 缺省匹配任意版本,否则精确相等", () => {
    const entries = [{ id: "a" }, { id: "b", version: "2.0.0" }];
    expect(isKilled(entries, "a", "9.9.9")).toEqual({ id: "a" });
    expect(isKilled(entries, "b", "2.0.0")).toEqual({ id: "b", version: "2.0.0" });
    expect(isKilled(entries, "b", "2.0.1")).toBeUndefined();
    expect(isKilled(entries, "c", "1.0.0")).toBeUndefined();
  });
});

describe("稳定码常量", () => {
  it("五个码值固定", () => {
    expect([PLUGIN_ABI_INVALID, PLUGIN_CAPABILITY_UNKNOWN, PLUGIN_UNPINNED, PLUGIN_KILLED, PLUGIN_CONSENT_REQUIRED]).toEqual([
      "PLUGIN_ABI_INVALID",
      "PLUGIN_CAPABILITY_UNKNOWN",
      "PLUGIN_UNPINNED",
      "PLUGIN_KILLED",
      "PLUGIN_CONSENT_REQUIRED",
    ]);
  });
});

describe("ABI 失败时安装零落盘", () => {
  it("未知顶层键拒装:文件树不变,且无 .genie/plugins.json", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-abi-"));
    try {
      mkdirSync(join(root, ".genie"), { recursive: true });
      writeFileSync(
        join(root, ".genie", "plugins-catalog.json"),
        JSON.stringify([{ ...base(), evil: "x" }]),
        "utf-8",
      );
      const before = walk(root);
      const ps = new PluginSystem(root, () => ({ id: "m" }), () => true);
      const r = ps.install("demo") as { error?: string };
      expect(r.error).toContain(PLUGIN_ABI_INVALID);
      expect(r.error).toContain("evil");
      expect(walk(root)).toEqual(before);
      expect(existsSync(join(root, ".genie", "plugins.json"))).toBe(false);
      expect(ps.listInstalled()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("未知能力拒装:同样零落盘", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-cap-"));
    try {
      mkdirSync(join(root, ".genie"), { recursive: true });
      writeFileSync(
        join(root, ".genie", "plugins-catalog.json"),
        JSON.stringify([{ ...base(), componentTypes: ["command", "telepathy"] }]),
        "utf-8",
      );
      const before = walk(root);
      const ps = new PluginSystem(root, () => ({ id: "m" }), () => true);
      const r = ps.install("demo") as { error?: string };
      expect(r.error).toContain(PLUGIN_CAPABILITY_UNKNOWN);
      expect(r.error).toContain("telepathy");
      expect(walk(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
