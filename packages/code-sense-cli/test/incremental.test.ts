/**
 * 增量复用引擎测试(G4 硬需求):init aa → init bb → init . 三连——
 * ①重叠子树不重复探索(复用 N/新扫 M 如实);②合并图与全量构建节点/边集对等(parity);
 * ③relink 恢复跨子树调用边;④trunk/leaf 重分类(namedIn 语义);⑤文件变更只重扫该文件。
 * 注册表/索引产物全部落在临时 HOME 与临时目录,不污染真实 ~/.codesense。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildC2fIndex, loadIndex, querySymbol, saveIndex } from "@lampgenie/code-sense";
import { INDEX_EXTRACTOR_VERSION } from "@lampgenie/code-sense/callgraph/engine";
import { buildIndexWithReuse } from "../src/incremental.js";
import { runDoctor } from "../src/doctor.js";
import {
  canonicalPath, loadRegistry, loadSidecar, makeEntry, normalizeRoot, purgeRootData, removeRoot,
  resolveProjectRoot, sidecarPath, upsertRoot,
} from "../src/registry.js";

let ws = "";
let fakeHome = "";

const AA_FILES: Record<string, string> = {
  "aa/src/alpha.ts": [
    "export function alphaHelper(x: number): number { return x + 1; }",
    "export function alphaTrunk(): number { return alphaHelper(1); }",
    "",
  ].join("\n"),
};

const BB_FILES: Record<string, string> = {
  "bb/src/beta.ts": [
    "export function betaHelper(x: number): number { return x * 2; }",
    "export function betaTrunk(): number { return betaHelper(21); }",
    "",
  ].join("\n"),
};

function writeFiles(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    writeFileSync(abs, content);
  }
}

beforeAll(() => {
  // HOME 隔离:registryDir() 走 os.homedir()(POSIX 读 HOME)
  fakeHome = mkdtempSync(join(tmpdir(), "cshome-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  ws = mkdtempSync(join(tmpdir(), "csincr-"));
  writeFiles(ws, AA_FILES);
  writeFiles(ws, BB_FILES);
  writeFiles(ws, {
    "shared/util.ts": "export function utilAdd(a: number, b: number): number { return a + b; }\n",
    "main.ts": [
      'import { alphaTrunk } from "./aa/src/alpha";',
      'import { betaTrunk } from "./bb/src/beta";',
      'import { utilAdd } from "./shared/util";',
      "export function mainEntry(): number {",
      "  const a = alphaTrunk();",
      "  const b = betaTrunk();",
      "  return utilAdd(a, b);",
      "}",
      "",
    ].join("\n"),
  });
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}, 60_000);

describe("增量复用:aa → bb → 整仓三连", () => {
  it("①init aa/bb 各自全量,登记后 init 整仓复用 2 文件/新扫 2 文件", { timeout: 180_000 }, async () => {
    const aa = await buildIndexWithReuse(join(ws, "aa"));
    expect(aa.mode).toBe("full");
    expect(aa.scanned).toEqual(["src/alpha.ts"]);
    upsertRoot({ ...makeEntry(join(ws, "aa")), lastBuild: { reused: 0, scanned: 1, buildMs: aa.buildMs, mode: "full" } });

    const bb = await buildIndexWithReuse(join(ws, "bb"));
    expect(bb.mode).toBe("full");
    upsertRoot({ ...makeEntry(join(ws, "bb")), lastBuild: { reused: 0, scanned: 1, buildMs: bb.buildMs, mode: "full" } });

    const whole = await buildIndexWithReuse(ws);
    expect(whole.mode).toBe("incremental");
    expect(whole.reused.sort()).toEqual(["aa/src/alpha.ts", "bb/src/beta.ts"]);
    expect(whole.scanned.sort()).toEqual(["main.ts", "shared/util.ts"]);
    // 合并图完整:6 节点(2+2+utilAdd+mainEntry)
    expect(whole.index.nodes).toHaveLength(6);
    // relink 恢复了整仓→子仓的调用边(mainEntry→alphaTrunk/betaTrunk)
    expect(whole.relinked).toBeGreaterThanOrEqual(2);
  });

  it("②parity:增量合并图与全量 buildC2fIndex 的节点/边集对等(边 kind 的 import/unique 差异除外)", { timeout: 180_000 }, async () => {
    const incr = loadIndex(ws);
    expect(incr).not.toBeNull();
    const full = await buildC2fIndex(ws);
    const nodeKey = (n: { id: string; name: string; file: string; line: number; kind: string; outCount: number; inCount: number }) =>
      `${n.id}|${n.name}|${n.file}|${n.line}|${n.kind}|${n.outCount}|${n.inCount}`;
    expect(incr!.nodes.map(nodeKey).sort()).toEqual(full.nodes.map(nodeKey).sort());
    const edgeKey = (e: { from: string; to: string; toName: string; file: string; line: number }) =>
      `${e.from}|${e.to}|${e.toName}|${e.file}|${e.line}`;
    expect(incr!.edges.map(edgeKey).sort()).toEqual(full.edges.map(edgeKey).sort());
  });

  it("③recount:alphaTrunk 在整仓图中因 mainEntry 调用降为 regular(子图里是 trunk)", async () => {
    const incr = loadIndex(ws)!;
    const inAA = querySymbol(incr, "alphaTrunk");
    expect(inAA[0]!.symbol.kind).toBe("regular"); // namedIn 含 mainEntry
    expect(inAA[0]!.callers.map((c) => c.name)).toContain("mainEntry"); // relink 边进了 callers
    const wholeTrunk = incr.nodes.filter((n) => n.kind === "trunk").map((n) => n.name);
    expect(wholeTrunk).toContain("mainEntry");
  });

  it("④文件变更只重扫该文件,其余复用;变更文件新符号可查", { timeout: 180_000 }, async () => {
    appendFileSync(join(ws, "shared", "util.ts"), "export function utilMul(a: number, b: number): number { return a * b; }\n");
    const again = await buildIndexWithReuse(ws);
    expect(again.mode).toBe("incremental");
    expect(again.scanned).toEqual(["shared/util.ts"]);
    expect(again.reused.length).toBe(3);
    const idx = loadIndex(ws)!;
    expect(querySymbol(idx, "utilMul").length).toBe(1);
  });

  it("⑤--force 全量重建后 sidecar 仍在(下次仍可增量)", { timeout: 180_000 }, async () => {
    const forced = await buildIndexWithReuse(ws, { force: true });
    expect(forced.mode).toBe("full");
    expect(forced.reused).toHaveLength(0);
    const next = await buildIndexWithReuse(ws);
    expect(next.mode).toBe("incremental");
    expect(next.reused).toHaveLength(4);
  });
});

describe("注册表", () => {
  it("就近解析:嵌套目录命中最近登记根;未登记目录逐级向上回退", () => {
    const reg = loadRegistry();
    expect(reg.roots.length).toBeGreaterThanOrEqual(2);
    const hit = resolveProjectRoot(join(ws, "aa", "src"));
    expect(hit).not.toBeNull();
    // aa/src 自身未登记:命中其最近登记祖先(aa 或整仓,取决于用例序中的登记态)
    expect([normalizeRoot(ws), normalizeRoot(join(ws, "aa"))]).toContain(normalizeRoot(hit!.root));
  });

  it("remove+purge 清注册表与索引目录;二次移除=未登记", { timeout: 180_000 }, async () => {
    const extra = join(ws, "extra");
    mkdirSync(join(extra, "src"), { recursive: true });
    writeFileSync(join(extra, "src", "x.ts"), "export function x1(): number { return 1; }\n");
    await buildIndexWithReuse(extra);
    upsertRoot({ ...makeEntry(extra) });
    expect(removeRoot(normalizeRoot(extra))).not.toBeNull();
    expect(removeRoot(normalizeRoot(extra))).toBeNull();
    purgeRootData(extra);
    expect(loadIndex(extra)).toBeNull();
  });
});

describe("sidecar v2:规范绝对路径指纹(2026-10-15 二期)", () => {
  it("①不同父目录/路径拼写(符号链接)两次 init 命中同一批指纹键,复用成立", { timeout: 180_000 }, async () => {
    const real = mkdtempSync(join(tmpdir(), "csreal-"));
    mkdirSync(join(real, "src"), { recursive: true });
    writeFileSync(join(real, "src", "m.ts"), "export function rm(): number { return 1; }\n");
    await buildIndexWithReuse(real);
    // 经符号链接拼写(不同父 cwd 形态)发起增量:键=realpath,必须命中
    const link = join(tmpdir(), `cslink-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    symlinkSync(real, link);
    try {
      const viaLink = await buildIndexWithReuse(link);
      expect(viaLink.mode).toBe("incremental");
      expect(viaLink.reused).toEqual(["src/m.ts"]);
      const side = loadSidecar(real)!;
      expect(side.version).toBe(2);
      expect(side.root).toBe(canonicalPath(real));
      const keys = Object.keys(side.files);
      expect(keys.every((k) => k.startsWith(canonicalPath(real) + "/"))).toBe(true);
      expect(keys.some((k) => k.startsWith(link))).toBe(false); // 不落符号链接拼写
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("②项目整体迁移(目录改名):旧根→新根键重映射,复用成立;迁移后改文件只重扫该文件", { timeout: 180_000 }, async () => {
    const m1 = mkdtempSync(join(tmpdir(), "csmiga-"));
    mkdirSync(join(m1, "src"), { recursive: true });
    writeFileSync(join(m1, "src", "a.ts"), "export function fa(): number { return 1; }\n");
    writeFileSync(join(m1, "src", "b.ts"), "export function fb(): number { return 2; }\n");
    await buildIndexWithReuse(m1);
    const m2 = m1 + "-moved";
    renameSync(m1, m2);
    try {
      const at = await buildIndexWithReuse(m2);
      expect(at.mode).toBe("incremental");
      expect(at.reused.sort()).toEqual(["src/a.ts", "src/b.ts"]);
      appendFileSync(join(m2, "src", "b.ts"), "export function fb2(): number { return 3; }\n");
      const at2 = await buildIndexWithReuse(m2);
      expect(at2.mode).toBe("incremental");
      expect(at2.reused).toEqual(["src/a.ts"]);
      expect(at2.scanned).toEqual(["src/b.ts"]);
      const idx = loadIndex(m2)!;
      expect(querySymbol(idx, "fb2").length).toBe(1);
    } finally {
      rmSync(m2, { recursive: true, force: true });
    }
  });

  it("③v1 sidecar(相对路径键)诚实拒收走全量,重建后落 v2", { timeout: 180_000 }, async () => {
    const v1 = mkdtempSync(join(tmpdir(), "csv1-"));
    mkdirSync(join(v1, "src"), { recursive: true });
    writeFileSync(join(v1, "src", "a.ts"), "export function va(): number { return 1; }\n");
    await buildIndexWithReuse(v1); // 产出 v2 + 索引
    // 手工降级为 v1 形态(相对路径键)
    const canon = canonicalPath(v1);
    const side = loadSidecar(v1)!;
    const legacy = { version: 1, root: v1, builtAt: side.builtAt, files: Object.fromEntries(Object.entries(side.files).map(([k, fp]) => [k.slice(canon.length + 1), fp])) };
    writeFileSync(sidecarPath(v1), JSON.stringify(legacy));
    const out = await buildIndexWithReuse(v1);
    expect(out.mode).toBe("full"); // 诚实:不可复用
    expect(loadSidecar(v1)!.version).toBe(2); // 重建落 v2
    rmSync(v1, { recursive: true, force: true });
  });

  it("④不存在的根拒绝索引(不再静默写空产物)", async () => {
    await expect(buildIndexWithReuse(join(tmpdir(), `csnope-${Date.now()}`))).rejects.toThrow(/根不存在/);
  });
});

describe("抽取器版本迁移(2026-10-21 验收缺口 1)", () => {
  /** 构造「旧抽取器产物」:索引只留函数节点(模拟 v1 不收 interface/type/enum/const),
   * sidecar/索引都不带 extractorVersion(隐式 v1)。指纹与源码完全一致——旧逻辑会直接
   * 搬运这份残缺节点集,新逻辑必须因版本闸触发一次全量重扫。 */
  function makeLegacyArtifacts(root: string): void {
    const idx = loadIndex(root)!;
    const keep = idx.nodes.find((n) => n.name === "keepMe");
    expect(keep, "fixture 缺 keepMe 节点").toBeTruthy();
    idx.nodes = [keep!];
    idx.edges = [];
    idx.byFile = { "src/mixed.ts": [keep!.id] };
    idx.byName = { [keep!.name]: [keep!.id] };
    delete idx.extractorVersion;
    saveIndex(root, idx);
    const side = loadSidecar(root)!;
    const legacy = JSON.parse(JSON.stringify(side)) as Record<string, unknown>;
    delete legacy.extractorVersion;
    writeFileSync(sidecarPath(root), JSON.stringify(legacy));
  }

  it("旧 sidecar+旧索引 → 版本升级全量重扫一次(补回类型符号),第二次恢复增量复用", { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "csmigver-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "mixed.ts"), [
      "export function keepMe(): number { return 1; }",
      "export interface AddedType { a: number }",
      "export type AddedAlias = string;",
      "export enum AddedEnum { A }",
      "",
    ].join("\n"));
    try {
      const first = await buildIndexWithReuse(root);
      expect(first.extractorVersion).toBe(INDEX_EXTRACTOR_VERSION);
      expect(loadIndex(root)!.extractorVersion).toBe(INDEX_EXTRACTOR_VERSION);
      expect(loadSidecar(root)!.extractorVersion).toBe(INDEX_EXTRACTOR_VERSION);

      makeLegacyArtifacts(root);
      expect(loadIndex(root)!.extractorVersion).toBeUndefined();
      expect(loadSidecar(root)!.extractorVersion).toBeUndefined();

      // doctor 必须点破假绿:索引为旧版抽取器产物(即使 builtAt/mtime 新鲜)
      const doc = await runDoctor(root);
      const indexCheck = doc.checks.find((c) => c.name === "index")!;
      expect(indexCheck.status).toBe("warn");
      expect(indexCheck.detail).toContain("抽取器已升级,索引为旧版");
      expect(indexCheck.detail).toContain(`当前 v${INDEX_EXTRACTOR_VERSION}`);

      const migrated = await buildIndexWithReuse(root);
      expect(migrated.mode).toBe("full"); // 旧版产物不可复用
      expect(migrated.reused).toEqual([]);
      expect(migrated.scanned).toEqual(["src/mixed.ts"]);
      expect(migrated.versionMigration).toEqual({ from: 1, to: INDEX_EXTRACTOR_VERSION });
      const idx = loadIndex(root)!;
      expect(idx.extractorVersion).toBe(INDEX_EXTRACTOR_VERSION);
      expect(loadSidecar(root)!.extractorVersion).toBe(INDEX_EXTRACTOR_VERSION);
      // 版本迁移后类型符号全部补回(file/symbol 面不再系统性缺报)
      for (const name of ["AddedType", "AddedAlias", "AddedEnum"]) {
        expect(querySymbol(idx, name), `迁移后缺符号 ${name}`).toHaveLength(1);
      }

      const again = await buildIndexWithReuse(root);
      expect(again.mode).toBe("incremental"); // 迁移只一次,随后恢复增量
      expect(again.reused).toEqual(["src/mixed.ts"]);
      expect(again.versionMigration).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("纯类型文件根(旧索引 0 节点,无文件可「拒绝」)也识别为版本迁移并重扫", { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "csmigtypes-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "types.ts"), [
      "export interface SessionSpec { id: string }",
      "export type Notice = { t: \"ready\" } | { t: \"log\" };",
      "export enum Kind { A, B }",
      "export const DEFAULT_KIND = Kind.A;",
      "",
    ].join("\n"));
    try {
      await buildIndexWithReuse(root);
      // 旧抽取器对纯类型文件产出 0 节点:索引空、sidecar/索引都无版本字段
      const old = loadIndex(root)!;
      old.nodes = [];
      old.edges = [];
      old.byFile = {};
      old.byName = {};
      delete old.extractorVersion;
      saveIndex(root, old);
      const oldSide = JSON.parse(JSON.stringify(loadSidecar(root)!)) as Record<string, unknown>;
      delete oldSide.extractorVersion;
      writeFileSync(sidecarPath(root), JSON.stringify(oldSide));

      const out = await buildIndexWithReuse(root);
      expect(out.mode).toBe("full");
      expect(out.versionMigration).toEqual({ from: 1, to: INDEX_EXTRACTOR_VERSION });
      expect(out.scanned).toEqual(["src/types.ts"]);
      // file 面:纯类型文件的 4 个符号全部回来(此前系统性 0 条)
      const names = loadIndex(root)!.nodes.filter((n) => n.file === "src/types.ts").map((n) => n.name);
      for (const expected of ["SessionSpec", "Notice", "Kind", "DEFAULT_KIND"]) {
        expect(names, `迁移后缺符号 ${expected}`).toContain(expected);
      }

      const again = await buildIndexWithReuse(root);
      expect(again.mode).toBe("incremental");
      expect(again.reused).toEqual(["src/types.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--force 不算版本迁移(无 versionMigration 标记),产物仍落当前版本", { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "csmigforce-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "mixed.ts"), [
      "export function keepMe(): number { return 1; }",
      "export interface AddedType { a: number }",
      "",
    ].join("\n"));
    try {
      await buildIndexWithReuse(root);
      makeLegacyArtifacts(root);
      const forced = await buildIndexWithReuse(root, { force: true });
      expect(forced.mode).toBe("full");
      expect(forced.versionMigration).toBeUndefined();
      expect(loadIndex(root)!.extractorVersion).toBe(INDEX_EXTRACTOR_VERSION);
      expect(querySymbol(loadIndex(root)!, "AddedType")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
