/**
 * 质量门确定性测试(零 LLM:全部指标从索引 nodes/edges 算出)。
 * ① 五个面数值与 pass 判定(小夹具:1 trunk 入口 / 1 条 unresolved 边 / 1 孤儿 / 1 不可达);
 * ② 阈值可注入(entryReachMin=0 时 pass.entryReach=true);
 * ③ docRefs:真存在的 README.md:3 通过、假的 nope.ts:999 失败;未给 docText 时显式「未校验」;
 * ④ contractDiffs 的 withSurface 开关(默认空 + note,开启才出配对行);
 * ⑤ renderQualityReport 含五行指标与清单。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeArtifactRefs, computeQuality, renderQualityReport } from "../src/world/quality.js";
import { writeWorldArtifact, type WorldManifest } from "../src/world/store.js";
import type { C2fEdge, C2fIndex, C2fNode } from "../src/callgraph/c2f.js";

function makeIndex(root: string, nodes: C2fNode[], edges: C2fEdge[]): C2fIndex {
  const byFile: Record<string, string[]> = {};
  const byName: Record<string, string[]> = {};
  for (const n of nodes) {
    (byFile[n.file] ??= []).push(n.id);
    (byName[n.name] ??= []).push(n.id);
  }
  return { version: 1, root, gitHead: "", builtAt: 1760000000000, buildMs: 1, nodes, edges, byFile, byName };
}

function node(p: Partial<C2fNode> & Pick<C2fNode, "id" | "name" | "file">): C2fNode {
  return {
    line: 1,
    kind: "regular",
    outCount: 0,
    inCount: 0,
    ...p,
  };
}

function edge(p: Pick<C2fEdge, "from" | "to" | "file" | "line" | "kind">): C2fEdge {
  return { toName: p.to.split("#")[1] ?? "", ...p };
}

let ws = "";
let idx: C2fIndex;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "cs-quality-"));
 // README 共 5 行(末尾换行不算行)——docRefs 的「真存在」锚点
  writeFileSync(join(ws, "README.md"), ["# t", "", "line3", "line4", "line5", ""].join("\n"));
  idx = makeIndex(
    ws,
    [
      node({ id: "src/main.ts#main", name: "main", file: "src/main.ts", line: 1, kind: "trunk", outCount: 2 }),
      node({ id: "src/util.ts#util", name: "util", file: "src/util.ts", line: 3, kind: "leaf", inCount: 1 }),
 // 孤儿:inCount=0 且非 trunk(类=aux → regular)
      node({ id: "src/orphan.ts#Dead", name: "Dead", file: "src/orphan.ts", line: 2, kind: "regular", outCount: 1 }),
 // 不可达:只被孤儿调用
      node({ id: "src/island.ts#island", name: "island", file: "src/island.ts", line: 1, kind: "leaf", inCount: 1 }),
    ],
    [
      edge({ from: "src/main.ts#main", to: "src/util.ts#util", file: "src/main.ts", line: 2, kind: "import" }),
      edge({ from: "src/main.ts#main", to: "", file: "src/main.ts", line: 3, kind: "unresolved" }),
      edge({ from: "src/orphan.ts#Dead", to: "src/island.ts#island", file: "src/orphan.ts", line: 5, kind: "this" }),
    ],
  );
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("computeQuality 五面指标", () => {
  it("入口可达率/未解析边/孤儿/不可达 数值与 pass", () => {
    const r = computeQuality(idx);
    expect(r.total).toBe(4);
    expect(r.reachable).toBe(2); // main + util
    expect(r.entryReachPct).toBe(50);
    expect(r.totalEdges).toBe(3);
    expect(r.unresolvedEdges).toBe(1);
    expect(r.unresolvedRatePct).toBe(33.3);
    expect(r.orphans.map((o) => o.id)).toEqual(["src/orphan.ts#Dead"]);
    expect(r.orphansTotal).toBe(1);
    expect(r.unreachableTotal).toBe(2);
    expect(r.unreachable.map((u) => u.id)).toEqual(["src/island.ts#island", "src/orphan.ts#Dead"]); // inCount 降序
    expect(r.thresholds).toEqual({ entryReachMin: 95, unresolvedMax: 5, docOkRatio: 1 });
    expect(r.pass).toEqual({ entryReach: false, unresolved: false, docRefs: true, all: false });
    expect(r.builtAt).toBe(idx.builtAt);
    expect(r.root).toBe(ws);
 // 未给 docText:显式「未校验」而非假装通过
    expect(r.docRefs.checked).toBe(false);
    expect(r.docRefs.total).toBe(0);
    expect(r.docRefs.note).toContain("未校验");
  });

  it("阈值可注入:entryReachMin=0 时 pass.entryReach=true(其余项独立)", () => {
    const r = computeQuality(idx, { threshold: { entryReachMin: 0 } });
    expect(r.pass.entryReach).toBe(true);
    expect(r.pass.unresolved).toBe(false);
    expect(r.pass.all).toBe(false);
    const all = computeQuality(idx, { threshold: { entryReachMin: 0, unresolvedMax: 100 } });
    expect(all.pass.all).toBe(true);
  });

  it("entryLimit 只截参与 BFS 的入口(截断如实写 note)", () => {
    const r = computeQuality(idx, { entryLimit: 0 });
    expect(r.reachable).toBe(0);
    expect(r.entryReachPct).toBe(0);
    expect(r.notes.some((n) => n.includes("entryLimit"))).toBe(true);
  });
});

describe("docRefs 确定性校验", () => {
  it("真引用通过、假引用失败", () => {
    const r = computeQuality(idx, { docText: "见 README.md:3 与 nope.ts:999 的契约" });
    expect(r.docRefs.checked).toBe(true);
    expect(r.docRefs.total).toBe(2);
    expect(r.docRefs.ok).toBe(1);
    expect(r.docRefs.bad.length).toBe(1);
    expect(r.docRefs.bad[0]!.ref).toBe("nope.ts:999");
    expect(r.docRefs.bad[0]!.reason).toContain("不存在");
    expect(r.pass.docRefs).toBe(false);
  });

  it("行号区间与越界", () => {
    const ok = computeQuality(idx, { docText: "README.md:2-4" });
    expect(ok.docRefs.total).toBe(1);
    expect(ok.docRefs.ok).toBe(1);
    expect(ok.pass.docRefs).toBe(true);
    const over = computeQuality(idx, { docText: "README.md:12" });
    expect(over.docRefs.ok).toBe(0);
    expect(over.docRefs.bad[0]!.reason).toContain("行号越界");
  });

  it("docRoots 可解析带前缀的引用", () => {
    const r = computeQuality(idx, { docText: "`README.md:3`", docRoots: ["./"] });
    expect(r.docRefs.ok).toBe(1);
    expect(r.docRefs.bad.length).toBe(0);
  });
});

describe("contractDiffs(withSurface 开关)", () => {
  const surfaceIdx = makeIndex(
    "/tmp/cs-quality-surface",
    [
      node({ id: "packages/protocol/messages.ts#Msg", name: "Msg", file: "packages/protocol/messages.ts", kind: "leaf", inCount: 1 }),
      node({ id: "apps/gateway/src/server.ts#send", name: "send", file: "apps/gateway/src/server.ts", line: 4, outCount: 1 }),
    ],
    [edge({ from: "apps/gateway/src/server.ts#send", to: "packages/protocol/messages.ts#Msg", file: "apps/gateway/src/server.ts", line: 6, kind: "import" })],
  );

  it("默认不扫描:空数组 + note 注明 --surface", () => {
    const r = computeQuality(surfaceIdx);
    expect(r.contractDiffs).toEqual([]);
    expect(r.notes.some((n) => n.includes("--surface"))).toBe(true);
  });

  it("开启后给出 protocol 面产出/消费配对", () => {
    const r = computeQuality(surfaceIdx, { withSurface: true });
    const p = r.contractDiffs.find((c) => c.category === "protocol");
    expect(p).toBeDefined();
    expect(p!.producers).toBe(1);
    expect(p!.consumers).toBe(1);
    expect(r.contractDiffs.every((c) => c.producers > 0 || c.consumers > 0)).toBe(true);
  });
});

describe("renderQualityReport", () => {
  it("含五行指标、清单与判定", () => {
    const r = computeQuality(idx, { docText: "见 README.md:3 与 nope.ts:999" });
    const text = renderQualityReport(r);
    for (const k of ["入口可达率", "未解析边比例", "孤儿节点", "不可达节点", "文档引用"]) {
      expect(text).toContain(k);
    }
    expect(text).toContain("src/orphan.ts:2");
    expect(text).toContain("src/island.ts");
    expect(text).toContain("FAIL");
    expect(text).toContain("nope.ts:999");
  });

  it("清单超过预览时写 +N(不可达/孤儿)", () => {
    const many = makeIndex(
      "/tmp/cs-quality-many",
      [
        node({ id: "a.ts#main", name: "main", file: "a.ts", kind: "trunk" }),
        ...Array.from({ length: 25 }, (_, i) =>
          node({ id: `z${i}.ts#f${i}`, name: `f${i}`, file: `z${i}.ts`, kind: "leaf" as const }),
        ),
      ],
      [],
    );
    const text = renderQualityReport(computeQuality(many));
    expect(text).toContain("+5 个未列出");
  });
});

describe("computeArtifactRefs 产物锚点校验", () => {
  let good = "";
  let bad = "";
  let empty = "";
  let goodManifest: WorldManifest | null = null;
  beforeAll(() => {
    good = mkdtempSync(join(tmpdir(), "cs-artifact-good-"));
    bad = mkdtempSync(join(tmpdir(), "cs-artifact-bad-"));
    empty = mkdtempSync(join(tmpdir(), "cs-artifact-empty-"));
    for (const w of [good, bad]) {
      mkdirSync(join(w, "src"), { recursive: true });
 // src/a.ts 共 5 行(末尾换行不算行)
      writeFileSync(join(w, "src", "a.ts"), ["l1", "l2", "l3", "l4", "l5", ""].join("\n"));
    }
    goodManifest = writeWorldArtifact(good, {
      skeleton: "# L0\n- 入口 src/a.ts:3\n",
      pages: [{ module: "src", markdown: "# 模块 src\n- 符号 src/a.ts:1-4\n- 入口 src/a.ts:3\n", bytes: 0 }],
      fp: { builtAt: 1760000000000 },
    });
    writeWorldArtifact(bad, {
      skeleton: "# L0\n",
      pages: [{ module: "src", markdown: "# 模块 src\n- 越界 src/a.ts:99\n- 缺失 src/nope.ts:1\n", bytes: 0 }],
      fp: { builtAt: 1760000000000 },
    });
  });
  afterAll(() => {
    for (const w of [good, bad, empty]) rmSync(w, { recursive: true, force: true });
  });

  it("好锚点通过(skeleton+模块页跨文本按 ref 去重)", () => {
    const r = computeArtifactRefs(good);
    expect(r.checked).toBe(true);
    expect(r.total).toBe(2); // src/a.ts:3 + src/a.ts:1-4(重复的 :3 去重)
    expect(r.bad).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("坏行号与文件缺失检出(bad 带 file/line/reason)", () => {
    const r = computeArtifactRefs(bad);
    expect(r.checked).toBe(true);
    expect(r.total).toBe(2);
    expect(r.pass).toBe(false);
    expect(r.bad.length).toBe(2);
    const over = r.bad.find((b) => b.ref === "src/a.ts:99")!;
    expect(over.file).toBe("src/a.ts");
    expect(over.line).toBe(99);
    expect(over.reason).toContain("行号越界");
    const missing = r.bad.find((b) => b.ref === "src/nope.ts:1")!;
    expect(missing.file).toBe("src/nope.ts");
    expect(missing.line).toBe(1);
    expect(missing.reason).toContain("不存在");
  });

  it("空产物:pass=true total=0(显式未校验,不假绿)", () => {
    const r = computeArtifactRefs(empty);
    expect(r.total).toBe(0);
    expect(r.checked).toBe(false);
    expect(r.pass).toBe(true);
    expect(r.bad).toEqual([]);
    expect(r.notes.join(" ")).toContain("未校验");
  });

  it("坏锚点清单封顶 40(真实坏总数在 notes 如实给)", () => {
    const many = mkdtempSync(join(tmpdir(), "cs-artifact-cap-"));
    try {
      const markdown = Array.from({ length: 45 }, (_, i) => `- miss${i}.ts:1`).join("\n");
      writeWorldArtifact(many, { skeleton: "# L0\n", pages: [{ module: "m", markdown, bytes: 0 }], fp: { builtAt: 1 } });
      const r = computeArtifactRefs(many);
      expect(r.total).toBe(45);
      expect(r.bad.length).toBe(40);
      expect(r.pass).toBe(false);
      expect(r.notes.join(" ")).toContain("坏 45 条");
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });

  it("readingTime 确定性估算:ceil(totalBytes/500)", () => {
    expect(goodManifest).not.toBeNull();
    expect(goodManifest!.readingTime).toEqual({ minutes: Math.ceil(goodManifest!.bytes.total / 500) });
    expect(goodManifest!.readingTime.minutes).toBe(1); // 夹具产物远小于 500B
  });
});
