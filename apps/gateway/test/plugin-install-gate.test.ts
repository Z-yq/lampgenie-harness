/**
 * 插件安装闸门( A 段)集成测试:pin / kill list / consent 加载态 / host 降级 / ABI 拒装。
 * 全部用临时根目录自建 user catalog,不依赖官方市场快照。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, existsSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_ABI_INVALID,
  PLUGIN_CONSENT_REQUIRED,
  PLUGIN_KILLED,
  PLUGIN_UNPINNED,
  consentHash,
} from "../src/plugin-audit.js";
import { PluginSystem, type InstalledPlugin } from "../src/plugins.js";

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

function mkRoot(catalog: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "plug-gate-"));
  mkdirSync(join(root, ".genie"), { recursive: true });
  writeCatalog(root, catalog);
  return root;
}

function writeCatalog(root: string, catalog: unknown[]): void {
  writeFileSync(join(root, ".genie", "plugins-catalog.json"), JSON.stringify(catalog), "utf-8");
}

function writeKillList(root: string, raw: unknown): void {
  writeFileSync(
    join(root, ".genie", "plugin-kill-list.json"),
    typeof raw === "string" ? raw : JSON.stringify(raw),
    "utf-8",
  );
}

function userManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gate",
    name: "闸门插件",
    description: "测试用",
    version: "1.0.0",
    author: "tester",
    category: "测试",
    source: "user",
    provides: { commands: [{ name: "gate-cmd", body: "做事" }] },
    ...over,
  };
}

const okMcp = (i: { name: string }): { id: string } => ({ id: "mcp-" + i.name });

describe("pin(定版校验)", () => {
  it("user 条目伪造 source=official 且无 sha256 → PLUGIN_UNPINNED,零落盘", () => {
    const root = mkRoot([userManifest({ id: "fake-official", source: "official" })]);
    try {
      const before = walk(root);
      const ps = new PluginSystem(root, okMcp, () => true);
      const r = ps.install("fake-official") as { error?: string };
      expect(r.error).toContain(PLUGIN_UNPINNED);
      expect(walk(root)).toEqual(before);
      expect(ps.listInstalled()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("user 条目带 url 无 sha256 → 拒;带 url+sha256 → 正常装", () => {
    const root = mkRoot([userManifest({ id: "urlly", url: "https://example.com/p.zip" })]);
    try {
      const ps = new PluginSystem(root, okMcp, () => true);
      const bad = ps.install("urlly") as { error?: string };
      expect(bad.error).toContain(PLUGIN_UNPINNED);
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd.md"))).toBe(false);
      writeCatalog(root, [userManifest({ id: "urlly", url: "https://example.com/p.zip", sha256: "a".repeat(64) })]);
      const ok = ps.install("urlly") as InstalledPlugin;
      expect("error" in ok).toBe(false);
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd.md"))).toBe(true);
      expect(ok.consentHash).toBe(consentHash(userManifest({ id: "urlly", url: "https://example.com/p.zip", sha256: "a".repeat(64) })));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builtin 豁免 pin:正常装", () => {
    const root = mkRoot([]);
    try {
      const ps = new PluginSystem(root, okMcp, () => true);
      const rec = ps.install("git-flow") as InstalledPlugin;
      expect("error" in rec).toBe(false);
      expect(rec.status).toBe("installed");
      expect(rec.consentHash).toMatch(/^[0-9a-f]{32}$/);
      expect(rec.audit?.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("kill list", () => {
  it("缺省版本命中 → 拒装且零落盘", () => {
    const root = mkRoot([userManifest({ id: "killme" })]);
    try {
      writeKillList(root, [{ id: "killme", reason: "供应链事件" }]);
      const before = walk(root);
      const ps = new PluginSystem(root, okMcp, () => true);
      const r = ps.install("killme") as { error?: string };
      expect(r.error).toContain(PLUGIN_KILLED);
      expect(walk(root)).toEqual(before);
      expect(existsSync(join(root, ".genie", "plugins.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("版本精确匹配才拒;不匹配正常装", () => {
    const root = mkRoot([userManifest({ id: "killver" })]);
    try {
      writeKillList(root, [{ id: "killver", version: "2.0.0" }]);
      const ps = new PluginSystem(root, okMcp, () => true);
      expect("error" in (ps.install("killver") as object)).toBe(false);
      ps.uninstall("killver");
      writeKillList(root, [{ id: "killver", version: "1.0.0" }]);
      const r = ps.install("killver") as { error?: string };
      expect(r.error).toContain(PLUGIN_KILLED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("已安装后写 kill list 再重开实例 → status killed / enabled false / 资产被移(台账保留)", () => {
    const root = mkRoot([userManifest({ id: "later" })]);
    try {
      const ps = new PluginSystem(root, okMcp, () => true);
      ps.install("later");
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd.md"))).toBe(true);
      writeKillList(root, [{ id: "later", reason: "revoked" }]);
      const ps2 = new PluginSystem(root, okMcp, () => true);
      const rec = ps2.listInstalled()[0]!;
      expect(rec.id).toBe("later");
      expect(rec.status).toBe("killed");
      expect(rec.enabled).toBe(false);
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd.md"))).toBe(false);
      // 停用但保留台账
      expect(JSON.parse(readFileSync(join(root, ".genie", "plugins.json"), "utf-8"))[0].status).toBe("killed");
      const on = ps2.toggle("later", true) as { error?: string };
      expect(on.error).toContain(PLUGIN_KILLED);
      // 再次重开:幂等(不重复处理、不抛)
      const ps3 = new PluginSystem(root, okMcp, () => true);
      expect(ps3.listInstalled()[0]!.status).toBe("killed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kill list 坏 JSON → 视为空,正常装", () => {
    const root = mkRoot([userManifest({ id: "badjson" })]);
    try {
      writeKillList(root, "{oops not json");
      const ps = new PluginSystem(root, okMcp, () => true);
      const rec = ps.install("badjson") as InstalledPlugin;
      expect("error" in rec).toBe(false);
      expect(rec.enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host 降级(MCP 宿主不可用)", () => {
  const pack = () =>
    userManifest({
      id: "mcp-pack",
      provides: {
        commands: [{ name: "mcp-cmd", body: "做事" }],
        mcp: [{ name: "s1", command: "npx", args: ["-y", "s1"] }],
      },
    });

  it("mcpAdd 抛错 → 安装成功、该 mcp 行 degraded、台账已写", () => {
    const root = mkRoot([pack()]);
    try {
      const ps = new PluginSystem(root, () => { throw new Error("mcp host down"); }, () => true);
      const rec = ps.install("mcp-pack") as InstalledPlugin;
      expect("error" in rec).toBe(false);
      expect(rec.status).toBe("installed");
      const mcpAsset = rec.audit!.assets.find((a) => a.kind === "mcp");
      expect(mcpAsset).toMatchObject({ name: "s1", status: "degraded" });
      expect(mcpAsset!.reason).toContain("mcp host down");
      expect(rec.audit!.ok).toBe(false);
      expect(existsSync(join(root, ".genie", "commands", "mcp-cmd.md"))).toBe(true);
      expect(existsSync(join(root, ".genie", "plugins.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mcpAdd 返回 {error} → 同样 degraded 继续", () => {
    const root = mkRoot([pack()]);
    try {
      const ps = new PluginSystem(root, () => ({ error: "boom" }), () => true);
      const rec = ps.install("mcp-pack") as InstalledPlugin;
      expect("error" in rec).toBe(false);
      expect(rec.audit!.assets.find((a) => a.kind === "mcp")).toMatchObject({ status: "degraded", reason: "boom" });
      expect(rec.artifacts.mcpIds).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("全部 mcp 失败且无其它资产 → host-unavailable 且无台账", () => {
    const root = mkRoot([userManifest({ id: "mcp-only", provides: { mcp: [{ name: "s1", command: "npx" }] } })]);
    try {
      const ps = new PluginSystem(root, () => { throw new Error("down"); }, () => true);
      const r = ps.install("mcp-only") as { error?: string };
      expect(r.error).toBe("host-unavailable");
      expect(ps.listInstalled()).toEqual([]);
      expect(existsSync(join(root, ".genie", "plugins.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degraded 插件的已写资产可被 uninstall 回收", () => {
    const root = mkRoot([pack()]);
    try {
      const removed: string[] = [];
      const ps = new PluginSystem(root, (i) => ({ id: "mcp-" + i.name }), (id) => { removed.push(id); return true; });
      ps.install("mcp-pack");
      expect(ps.uninstall("mcp-pack")).toBe(true);
      expect(existsSync(join(root, ".genie", "commands", "mcp-cmd.md"))).toBe(false);
      expect(removed).toEqual(["mcp-s1"]);
      expect(ps.listInstalled()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("consent 加载态", () => {
  it("清单变更 → needs-consent / enabled false / 资产被移(不重写);同清单重开仍 installed", () => {
    const root = mkRoot([userManifest({ id: "gate" })]);
    try {
      const ps = new PluginSystem(root, okMcp, () => true);
      ps.install("gate");
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd.md"))).toBe(true);
      // 同清单重开:不得误判 needs-consent
      const same = new PluginSystem(root, okMcp, () => true).listInstalled()[0]!;
      expect(same.status).toBe("installed");
      expect(same.enabled).toBe(true);
      // 篡改:新增命令 → 指纹变
      writeCatalog(root, [userManifest({
        id: "gate",
        provides: { commands: [{ name: "gate-cmd", body: "做事" }, { name: "gate-cmd-2", body: "新命令" }] },
      })]);
      const ps2 = new PluginSystem(root, okMcp, () => true);
      const rec = ps2.listInstalled()[0]!;
      expect(rec.status).toBe("needs-consent");
      expect(rec.enabled).toBe(false);
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd.md"))).toBe(false);
      // 未重写新资产
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd-2.md"))).toBe(false);
      // listInstalled 可见
      expect(ps2.listInstalled().map((x) => x.id)).toEqual(["gate"]);
      // toggle 启用被拒
      expect((ps2.toggle("gate", true) as { error?: string }).error).toContain(PLUGIN_CONSENT_REQUIRED);
      // reconsent:重新校验+写资产+新指纹,保留 installedAt
      const rc = ps2.reconsent("gate") as InstalledPlugin;
      expect("error" in rc).toBe(false);
      expect(rc.status).toBe("installed");
      expect(rc.enabled).toBe(true);
      expect(rc.installedAt).toBe(rec.installedAt);
      expect(rc.consentHash).toBe(consentHash(userManifest({
        id: "gate",
        provides: { commands: [{ name: "gate-cmd", body: "做事" }, { name: "gate-cmd-2", body: "新命令" }] },
      })));
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd-2.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("版本变更也触发 needs-consent", () => {
    const root = mkRoot([userManifest({ id: "gate" })]);
    try {
      new PluginSystem(root, okMcp, () => true).install("gate");
      writeCatalog(root, [userManifest({ id: "gate", version: "1.0.1" })]);
      expect(new PluginSystem(root, okMcp, () => true).listInstalled()[0]!.status).toBe("needs-consent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("legacy 台账迁移", () => {
  it("无 consentHash + 清单可读 → 补指纹 migrated,enabled 保持;清单不可读 → kept-unavailable 不删资产", () => {
    const root = mkRoot([userManifest({ id: "legacy" })]);
    try {
      mkdirSync(join(root, ".genie", "commands"), { recursive: true });
      writeFileSync(join(root, ".genie", "commands", "gate-cmd.md"), "旧资产\n", "utf-8");
      writeFileSync(
        join(root, ".genie", "plugins.json"),
        JSON.stringify([
          { id: "legacy", version: "1.0.0", enabled: true, installedAt: 111, artifacts: { commandFiles: ["gate-cmd.md"] } },
        ], null, 2),
        "utf-8",
      );
      const ps = new PluginSystem(root, okMcp, () => true);
      const rec = ps.listInstalled()[0]!;
      expect(rec.status).toBe("migrated");
      expect(rec.enabled).toBe(true);
      expect(rec.consentHash).toBe(consentHash(userManifest({ id: "legacy" })));
      expect(typeof rec.consentAt).toBe("number");
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd.md"))).toBe(true);
      // 目录里删掉该条目 → kept-unavailable,资产与 enabled 不动
      writeCatalog(root, []);
      const ps2 = new PluginSystem(root, okMcp, () => true);
      const rec2 = ps2.listInstalled()[0]!;
      expect(rec2.status).toBe("kept-unavailable");
      expect(rec2.enabled).toBe(true);
      expect(existsSync(join(root, ".genie", "commands", "gate-cmd.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ABI 拒装(catalog 条目形状非法)", () => {
  it("未知顶层键 → PLUGIN_ABI_INVALID 且零落盘", () => {
    const root = mkRoot([userManifest({ id: "badabi", whatever: true })]);
    try {
      const before = walk(root);
      const ps = new PluginSystem(root, okMcp, () => true);
      const r = ps.install("badabi") as { error?: string };
      expect(r.error).toContain(PLUGIN_ABI_INVALID);
      expect(r.error).toContain("whatever");
      expect(walk(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
