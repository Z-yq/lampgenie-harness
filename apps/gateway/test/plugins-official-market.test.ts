/**
 * 官方市场源集成测试(ZCode 官方插件市场接入):
 * zip 解压器(手写 store 模式 zip writer 驱动)/清单解析(真实快照)/
 * 官方包安装分发与台账/卸载整包回收/未分发大包提示。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { deflateRawSync } from "node:zlib";
import { PluginSystem, loadOfficialCatalog, officialEntryMeta, unzipInto, officialMarketDir } from "../src/plugins.js";

/** 手写最小 zip(store 与 deflate 混合)做解压器 fixture。 */
function makeZip(entries: { name: string; content: Buffer | string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, "utf8");
    const nameB = Buffer.from(e.name, "utf8");
    const comp = e.deflate ? deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); // time/date
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("官方市场源(plugins.ts official market)", () => {
  let officialCount = 0;
  beforeAll(() => {
    // 快照可能未随仓分发(assets 由 fetch 脚本生成);未分发时官方目录用例跳过
    officialCount = existsSync(join(officialMarketDir(), "marketplace.json")) ? loadOfficialCatalog().length : 0;
  });

  it("unzipInto:store 与 deflate 混合解压;目录条目与路径穿越跳过", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unzip-"));
    try {
      const zip = join(tmp, "f.zip");
      writeFileSync(zip, makeZip([
        { name: "pkg/a.md", content: "hello 存储模式" },
        { name: "pkg/sub/b.md", content: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), deflate: true },
        { name: "pkg/dir/", content: "" },
        { name: "pkg/../evil.md", content: "should be skipped" },
      ]));
      const out = unzipInto(zip, join(tmp, "out"));
      expect(out.sort()).toEqual(["pkg/a.md", "pkg/sub/b.md"]);
      expect(readFileSync(join(tmp, "out", "pkg", "a.md"), "utf-8")).toBe("hello 存储模式");
      expect([...readFileSync(join(tmp, "out", "pkg", "sub", "b.md"))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(existsSync(join(tmp, "out", "pkg", "..", "evil.md"))).toBe(false);
      expect(existsSync(join(tmp, "evil.md"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unzipInto:坏包(非 zip)报错", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unzipbad-"));
    try {
      const zip = join(tmp, "bad.zip");
      writeFileSync(zip, "not a zip at all");
      expect(() => unzipInto(zip, join(tmp, "o"))).toThrow(/EOCD/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loadOfficialCatalog:真实快照解析(source=official,中文描述优先)", () => {
    if (!officialCount) return; // 快照未分发(干净 checkout 未跑 fetch 脚本)
    expect(officialCount).toBeGreaterThanOrEqual(50);
    const cat = loadOfficialCatalog();
    const cb = cat.find((m) => m.id === "cloudbase-skills");
    expect(cb?.source).toBe("official");
    expect(cb?.description).toContain("CloudBase"); // zh-CN 描述
    expect(cb?.componentTypes).toContain("skill");
    // 显示名对齐 ZCode 市场:displayName_i18n(zh-CN)优先,包名保留为 id
    const lark = cat.find((m) => m.id === "lark-cli");
    expect(lark?.name).toBe("飞书 CLI");
    // 图标指向本地快照路径(icons/<name>.png)
    expect(lark?.icon).toBe("official-market/icons/lark-cli.png");
    // 目录并入 PluginSystem.catalog()
    const tmp = mkdtempSync(join(tmpdir(), "offcat-"));
    try {
      const ps = new PluginSystem(tmp, () => ({ id: "x" }), () => true);
      expect(ps.catalog().some((m) => m.source === "official")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("官方包安装:命令/技能/子智能体分发+包目录保留;卸载整包回收", () => {
    if (!officialCount) return;
    // assess-credit:轻量包(agents+commands+skills 全有)
    if (!existsSync(join(officialMarketDir(), "zips", "assess-credit-0.1.2.zip"))) return;
    const tmp = mkdtempSync(join(tmpdir(), "offinst-"));
    const mcpAdded: { id: string; name: string }[] = [];
    const removed: string[] = [];
    try {
      const ps = new PluginSystem(tmp, (i) => { const id = "mcp-" + i.name; mcpAdded.push({ id, name: i.name }); return { id }; }, (id) => { removed.push(id); return true; });
      const r = ps.install("assess-credit") as { artifacts: { commandFiles?: string[]; agentFiles?: string[]; skillDirs?: string[]; pluginDir?: string } };
      expect(r.artifacts.pluginDir).toBe("assess-credit");
      // 命令落地(包内 commands/*.md)
      expect(r.artifacts.commandFiles?.length).toBeGreaterThan(0);
      for (const f of r.artifacts.commandFiles!) expect(existsSync(join(tmp, ".genie", "commands", f))).toBe(true);
      // 子智能体落地
      expect(r.artifacts.agentFiles).toContain("assess-credit.md");
      expect(readFileSync(join(tmp, ".genie", "agents", "assess-credit.md"), "utf-8")).toContain("name: assess-credit");
      // 技能整目录落地(含技能自身文件)
      expect(r.artifacts.skillDirs?.length).toBeGreaterThan(3);
      // 包目录保留(运行资产基座:README/references 等)
      expect(existsSync(join(tmp, ".genie", "plugins", "assess-credit", "README.md"))).toBe(true);
      // 卸载:全链回收
      expect(ps.uninstall("assess-credit")).toBe(true);
      expect(existsSync(join(tmp, ".genie", "plugins", "assess-credit"))).toBe(false);
      expect(existsSync(join(tmp, ".genie", "commands", r.artifacts.commandFiles![0]))).toBe(false);
      expect(existsSync(join(tmp, ".genie", "agents", "assess-credit.md"))).toBe(false);
      for (const rel of r.artifacts.skillDirs!) expect(existsSync(join(tmp, ".genie", "experiences", rel))).toBe(false);
 // 分类父目录也回收(修复:fs.rm 删目录必须 recursive,裸 rmSync EISDIR 被吞)
      expect(existsSync(join(tmp, ".genie", "experiences", "plugin-assess-credit"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("官方包 MCP 注册(.mcp.json stdio 项)", () => {
    if (!officialCount) return;
    if (!existsSync(join(officialMarketDir(), "zips", "cloudbase-skills-0.1.0.zip"))) return;
    const tmp = mkdtempSync(join(tmpdir(), "offmcp-"));
    const mcpAdded: { id: string; name: string; command: string }[] = [];
    try {
      const ps = new PluginSystem(tmp, (i) => { const id = "mcp-" + i.name; mcpAdded.push({ id, name: i.name, command: i.command }); return { id }; }, () => true);
      ps.install("cloudbase-skills");
      expect(mcpAdded.some((m) => m.name === "cloudbase" && m.command === "npx")).toBe(true);
      expect(existsSync(join(tmp, ".genie", "experiences", "plugin-cloudbase-skills", "cloudbase", "SKILL.md"))).toBe(true);
      ps.uninstall("cloudbase-skills");
      expect(mcpAdded.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("未分发大包:报错并提示拉取脚本", () => {
    if (!officialCount) return;
    const tmp = mkdtempSync(join(tmpdir(), "offbig-"));
    try {
      const ps = new PluginSystem(tmp, () => ({ id: "x" }), () => true);
      const r = ps.install("vectorcraft") as { error?: string }; // 44MB 包不随快照
      expect(r.error).toContain("fetch-official-market");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sha256 不匹配:拒装", () => {
    if (!officialCount) return;
    const tmp = mkdtempSync(join(tmpdir(), "offsha-"));
    try {
      const ps = new PluginSystem(tmp, () => ({ id: "x" }), () => true);
      // vectorcraft(44MB)快照无 zip:在缓存目录放假包 → sha256 校验失败拒装
      const meta = officialEntryMeta("vectorcraft");
      if (!meta.sha256 || !meta.version) return;
      const cacheDir = join(tmp, ".genie", "plugins-cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, `vectorcraft-${meta.version}.zip`), makeZip([{ name: "vectorcraft/x.md", content: "tampered" }]));
      const r = ps.install("vectorcraft") as { error?: string };
      expect(r.error).toContain("sha256");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("toggle:停用移资产保留台账;启用重装(官方包)", () => {
    if (!officialCount || !existsSync(join(officialMarketDir(), "zips", "github-0.1.3.zip"))) return;
    const tmp = mkdtempSync(join(tmpdir(), "offtog-"));
    try {
      const ps = new PluginSystem(tmp, () => ({ id: "x" }), () => true);
      ps.install("github");
      const off = ps.toggle("github", false) as { enabled: boolean };
      expect(off.enabled).toBe(false);
      expect(existsSync(join(tmp, ".genie", "plugins", "github"))).toBe(false);
      const on = ps.toggle("github", true) as { enabled: boolean; artifacts: { pluginDir?: string } };
      expect(on.enabled).toBe(true);
      expect(on.artifacts.pluginDir).toBe("github");
      expect(existsSync(join(tmp, ".genie", "plugins", "github"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
