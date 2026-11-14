/**
 * 插件目录测试(自有解压器 + 市场降级语义):
 * zip 解压器(手写 store 模式 zip writer 驱动)/官方快照缺席时目录优雅降级
 * (内置精选卡保留,官方条目自然消失,安装未知 id 干净报错不崩)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { PluginSystem, loadOfficialCatalog, unzipInto } from "../src/plugins.js";

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
    const raw = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, "utf-8");
    const comp = e.deflate ? deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;
    const nameB = Buffer.from(e.name, "utf-8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    locals.push(local, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
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

describe("unzipInto(自有解压器)", () => {
  it("store 与 deflate 混合解压;目录条目与路径穿越跳过", () => {
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

  it("坏包(非 zip)报错", () => {
    const tmp = mkdtempSync(join(tmpdir(), "unzipbad-"));
    try {
      const zip = join(tmp, "bad.zip");
      writeFileSync(zip, "not a zip at all");
      expect(() => unzipInto(zip, join(tmp, "o"))).toThrow(/EOCD/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("官方快照缺席 → 市场优雅降级", () => {
  it("loadOfficialCatalog 返回空目录;catalog() 只剩内置卡,不抛不崩", () => {
    expect(loadOfficialCatalog()).toEqual([]);
    const tmp = mkdtempSync(join(tmpdir(), "cat-"));
    try {
      const ps = new PluginSystem(tmp, () => ({ id: "x" }), () => true);
      const cat = ps.catalog();
      expect(cat.length).toBeGreaterThan(0); // 内置精选卡仍在
      expect(cat.some((m) => m.source === "official")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("安装未知/不存在来源的 id:干净报错,不产生半成品", () => {
    const tmp = mkdtempSync(join(tmpdir(), "inst-"));
    try {
      const ps = new PluginSystem(tmp, () => ({ id: "x" }), () => true);
      const r = ps.install("no-such-plugin") as { error?: string };
      expect(typeof r.error === "string" && r.error.length > 0).toBe(true);
      expect(existsSync(join(tmp, ".genie", "plugins", "no-such-plugin"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
