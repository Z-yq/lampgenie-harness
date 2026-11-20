/**
 * meta.json 带覆盖报告(冷启动治理):覆盖行/注册表摘要不该为几行数字去加载
 * 30–86MB 的 index.json(经验证 loadIndex 1.58s + readFileSync 1.12s)。
 * 本测试钉三件事:
 * 1) saveIndex 把 C2fIndex.coverage 一并写进 meta.json,readIndexMeta 回读逐字段一致;
 * 2) meta.json 仍是小文件(<64KB——冷启动读它的收益前提);
 * 3) 旧 meta(无 coverage)回读不炸、字段缺席(降级语义,不编造)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveIndex, type C2fIndex } from "../src/callgraph/c2f";
import { indexMetaPath, readIndexMeta, writeIndexMeta } from "../src/callgraph/index-meta";
import type { LanguageCoverage } from "../src/callgraph/coverage";

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-metacov-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一份「接近真实体量」的覆盖报告:byExt 按扩展名分列(真索引也就十余种),
 * skippedReasons 源侧封顶 50 条——用它验证 meta.json 仍远小于 64KB。 */
function sampleCoverage(): LanguageCoverage {
  const byExt: LanguageCoverage["byExt"] = {
    ".ts": { diskFiles: 1200, indexedFiles: 1180, full: 1170, lexical: 10, empty: 0, skipped: 20 },
    ".tsx": { diskFiles: 40, indexedFiles: 38, full: 38, lexical: 0, empty: 0, skipped: 2 },
    ".py": { diskFiles: 12, indexedFiles: 10, full: 9, lexical: 1, empty: 0, skipped: 2 },
    ".lua": { diskFiles: 3, indexedFiles: 0, full: 0, lexical: 0, empty: 0, skipped: 3, unsupported: true },
  };
  const skippedReasons: Record<string, string> = {};
  for (let i = 0; i < 50; i++) skippedReasons[`src/gen/f${i}.ts`] = "压缩产物启发:单行过长,解析守卫跳过";
  return {
    byExt,
    totalDisk: 1255,
    totalIndexed: 1228,
    totalCovered: 1228,
    layeredDisk: 1255,
    coveragePct: 97.85,
    skippedReasons,
    truncated: { reason: "文件上限 20000", limit: 20000 },
    layeredScope: "full",
    unsupportedByExt: { ".lua": 3 },
    fileStatus: { scanned: 1255, indexed: 1228, symbolLess: 20, skipped: 7, error: 0 },
  };
}

function sampleIndex(root: string, coverage: LanguageCoverage | undefined): C2fIndex {
  const nodes: C2fIndex["nodes"] = [{
    id: `${root}/src/a.ts#foo:1`, name: "foo", file: "src/a.ts", line: 1,
    kind: "regular", outCount: 0, inCount: 0,
  }];
  const idx: C2fIndex = {
    version: 1,
    root,
    gitHead: "",
    builtAt: 1_800_000_000_000,
    buildMs: 42,
    nodes,
    edges: [],
    byFile: { "src/a.ts": [nodes[0]!.id] },
    byName: { foo: [nodes[0]!.id] },
    srcCount: 1255,
    fileStatus: { "src/a.ts": { status: "indexed" } },
  };
  if (coverage) idx.coverage = coverage;
  return idx;
}

describe("meta.json 携带 coverage(覆盖行不必加载 index.json)", () => {
  it("saveIndex 落盘 coverage,readIndexMeta 回读逐字段一致", () => {
    const root = tmp();
    const cov = sampleCoverage();
    saveIndex(root, sampleIndex(root, cov));

    const meta = readIndexMeta(root);
    expect(meta).not.toBeNull();
    expect(meta!.coverage).toEqual(cov);
 // 与 index.json 本体同源同口径(不是另一套统计)
    expect(meta!.coverage!.byExt[".ts"]).toEqual(cov.byExt[".ts"]);
    expect(meta!.coverage!.fileStatus).toEqual(cov.fileStatus);
 // 原有计数字段不受影响
    expect(meta!.nodes).toBe(1);
    expect(meta!.edges).toBe(0);
    expect(meta!.srcCount).toBe(1255);
    expect(meta!.fileStatus).toEqual({ scanned: 1, indexed: 1, symbolLess: 0, skipped: 0, error: 0 });
  });

  it("meta.json 仍是小文件(<64KB):byExt 全量 + skippedReasons 封顶 50 条后", () => {
    const root = tmp();
    saveIndex(root, sampleIndex(root, sampleCoverage()));
    const bytes = statSync(indexMetaPath(root)).size;
    expect(bytes).toBeLessThan(64 * 1024);
 // 冷启动读它就是读这一小块:顺手钉住量级(合理上限 16KB,超标说明有人往里塞逐文件数据)
    expect(bytes).toBeLessThan(16 * 1024);
    expect(JSON.parse(readFileSync(indexMetaPath(root), "utf-8")).coverage).toBeTruthy();
  });

  it("旧 meta(无 coverage)回读不炸,coverage 缺席而非伪造", () => {
    const root = tmp();
    writeIndexMeta(root, { version: 1, root, builtAt: 1, nodes: 2, edges: 3 });
    const meta = readIndexMeta(root);
    expect(meta).not.toBeNull();
    expect(meta!.coverage).toBeUndefined();
    expect(meta!.nodes).toBe(2);
  });

  it("索引无 coverage 时不写该字段(saveIndex 不编造空报告)", () => {
    const root = tmp();
    saveIndex(root, sampleIndex(root, undefined));
    const meta = readIndexMeta(root)!;
    expect(meta.coverage).toBeUndefined();
    expect(meta.fileStatus!.indexed).toBe(1);
  });
});
