/**
 * 链路图 chain:在临时玩具仓造「同文件跨类别命中 + 测试覆盖源码 + 二进制资产 + 部署/数据/多语言
 * 路径」四类落点,断言:
 *  ① 两跑 id/edges/order 逐字一致(确定性);
 *  ② 同文件跨类别 flow 边按层序连;
 *  ③ tests/docs 与源码按 stem 连 verify 边;
 *  ④ 索引不可用 → 不抛错、withCallChain=false、knownLimits 有话说;
 *  ⑤ 手写索引在场 → call 边挂上 upstream/downstream 且 withCallChain=true;
 *  ⑥ 路径名通道:二进制 .mp4 内容扫不到,文件名就是落点(line=0);
 *  ⑦ deploy/db/i18n 三类路径分类 + SURFACE_CATEGORIES 与层序表逐字相同。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SURFACE_CATEGORIES,
  buildSurfaceChainMap,
  classifySurfacePath,
  classifySurfaceHit,
  renderSurfaceChainMarkdown,
  scanSurface,
} from "../src/surface/index.js";
import { SURFACE_LAYER_ORDER } from "../src/surface/chain.js";
import type { SurfaceCategory, SurfaceChainMap, SurfaceReport } from "../src/surface/index.js";
import { saveIndex } from "../src/callgraph/c2f.js";
import type { C2fEdge, C2fIndex, C2fNode } from "../src/callgraph/c2f.js";

const CONCEPT = "demoFlag";
let root = "";
let report: SurfaceReport;
let map: SurfaceChainMap;

function put(rel: string, content: string): void {
  putAt(root, rel, content);
}

function putAt(base: string, rel: string, content: string): void {
  const abs = join(base, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "surface-chain-"));
  // symbol:普通源码(也是调用链的起点);字面量必须是带引号的形态,refs 通道才收
  put("src/demo-flag.ts", `export function demoFlag(): string {\n  return "demoFlag";\n}\n`);
  // 同文件跨类别:kind 行落 journal、普通赋值行落 symbol → 同文件 flow 边
  put("src/demo-store.ts", `export const K = { kind: "demoFlag" };\nexport const NAME = "demoFlag";\n`);
  // tests:覆盖 src/demo-flag.ts(stem 相同)
  put("src/demo-flag.test.ts", `expect("demoFlag").toBe("on");\n`);
  // docs:提到源码文件名
  put("docs/demo-flag.md", `# demoFlag\n\n见 src/demo-flag.ts。\n`);
  // 二进制资产:内容不可读,只有文件名是落点
  put("assets/demoFlag-promo.mp4", "\u0000\u0001binary\u0000");
  // deploy / db / i18n 三类路径
  put("scripts/deploy.sh", `echo "demoFlag"\n`);
  put("db/migrations/001_init.sql", "-- demoFlag\ninsert into t values ('demoFlag');\n");
  put("locales/en/messages.json", `{ "demoFlag": "on" }\n`);
  report = await scanSurface(root, [CONCEPT]);
  map = await buildSurfaceChainMap(root, report);
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("buildSurfaceChainMap 确定性", () => {
  it("两跑 id/edges/order 逐字一致", async () => {
    const again = await buildSurfaceChainMap(root, report);
    expect(again.nodes.map((n) => n.id)).toEqual(map.nodes.map((n) => n.id));
    expect(again.order).toEqual(map.order);
    expect(again.edges).toEqual(map.edges);
    expect(again.layers).toEqual(map.layers);
    expect(again.stats).toEqual(map.stats);
  });

  it("order 与 layers 层序一致,同层内按 file:line", () => {
    const layerPos = new Map<SurfaceCategory, number>(map.layers.map((l, i) => [l.category, i]));
    let prevLayer: number = -1;
    for (const id of map.order) {
      const node = map.nodes.find((n) => n.id === id)!;
      const pos = layerPos.get(node.category) ?? 99;
      expect(pos, `${id} 不应回到更早的层`).toBeGreaterThanOrEqual(prevLayer);
      prevLayer = pos;
    }
    expect(map.order).toEqual(map.nodes.map((n) => n.id));
  });

  it("空层不输出:layers 只含真有命中的类别", () => {
    for (const l of map.layers) expect(l.hits).toBeGreaterThan(0);
    expect(map.stats.layers).toBe(map.layers.length);
    expect(map.layers.map((l) => l.category)).toEqual(
      SURFACE_LAYER_ORDER.filter((c) => map.layers.some((l) => l.category === c)),
    );
  });
});

describe("确定性边", () => {
  it("同文件跨类别 → flow 边(label=目标类别,方向按层序)", () => {
    const flows = map.edges.filter((e) => e.kind === "flow");
    expect(flows.length).toBeGreaterThan(0);
    for (const e of flows) {
      const from = map.nodes.find((n) => n.id === e.from)!;
      const to = map.nodes.find((n) => n.id === e.to)!;
      expect(from.file).toBe(to.file);
      expect(from.category).not.toBe(to.category);
      expect(SURFACE_LAYER_ORDER.indexOf(from.category))
        .toBeLessThan(SURFACE_LAYER_ORDER.indexOf(to.category));
      expect(e.label).toBe(to.category);
    }
    // src/demo-store.ts:kind 行(journal)+ 普通串行(symbol)同文件 → 至少一条 flow
    const inStore = flows.filter((e) => e.from.includes("src/demo-store.ts"));
    expect(inStore.length).toBeGreaterThan(0);
    expect(flows.some((e) => e.from.includes("src/demo-store.ts") && e.label === "symbol")).toBe(true);
  });

  it("tests → 源码按 stem 连 verify 边", () => {
    const verifies = map.edges.filter((e) => e.kind === "verify");
    const pair = verifies.find((e) =>
      e.from.includes("src/demo-flag.test.ts") && e.to.includes("src/demo-flag.ts"));
    expect(pair, `应存在 demo-flag.test.ts → demo-flag.ts 的 verify 边: ${JSON.stringify(verifies)}`).toBeTruthy();
    expect(pair!.label).toBe("covers");
  });

  it("verify 边不连自己、不重复", () => {
    const keys = map.edges.map((e) => `${e.kind}|${e.from}|${e.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of map.edges) expect(e.from).not.toBe(e.to);
  });
});

describe("索引不可用 → 诚实降级", () => {
  it("无索引:不抛错、withCallChain=false、knownLimits 点名「未含调用链」", () => {
    expect(map.stats.withCallChain).toBe(false);
    expect(map.stats.impactNodes).toBe(0);
    expect(map.knownLimits.some((l) => l.includes("未含调用链"))).toBe(true);
    expect(map.knownLimits.some((l) => l.includes("索引不可用") || l.includes("索引读取失败"))).toBe(true);
  });
});

describe("索引在场 → call 边", () => {
  it("upstream=callers / downstream=callees,withCallChain=true", async () => {
    const idxRoot = mkdtempSync(join(tmpdir(), "surface-chain-idx-"));
    try {
      const node = (id: string, name: string, file: string, line: number): C2fNode => ({
        id, name, file, line, kind: "regular", outCount: 0, inCount: 0,
      });
      const edge = (from: string, to: string, toName: string, file: string, line: number): C2fEdge => ({
        from, to, toName, file, line, kind: "import",
      });
      const nodes: C2fNode[] = [
        node("src/demo-flag.ts#demoFlag", "demoFlag", "src/demo-flag.ts", 1),
        node("src/caller.ts#main", "main", "src/caller.ts", 3),
      ];
      const edges: C2fEdge[] = [edge("src/caller.ts#main", "src/demo-flag.ts#demoFlag", "demoFlag", "src/caller.ts", 3)];
      const index: C2fIndex = {
        version: 1, root: idxRoot, gitHead: "", builtAt: 1, buildMs: 1,
        nodes, edges,
        byFile: { "src/demo-flag.ts": ["src/demo-flag.ts#demoFlag"], "src/caller.ts": ["src/caller.ts#main"] },
        byName: { demoFlag: ["src/demo-flag.ts#demoFlag"], main: ["src/caller.ts#main"] },
      };
      saveIndex(idxRoot, index);
      // 同一棵树:源码与索引都落在 idxRoot(索引目录 .genie 被排除,不影响扫描)
      putAt(idxRoot, "src/caller.ts", "export function main() { return demoFlag(); }\n");
      putAt(idxRoot, "src/demo-flag.ts", `export function demoFlag(): string {\n  return "demoFlag";\n}\n`);
      const rep = await scanSurface(idxRoot, [CONCEPT], { pathNames: false });
      const m = await buildSurfaceChainMap(idxRoot, rep);

      expect(m.stats.withCallChain, `knownLimits=${JSON.stringify(m.knownLimits)} edges=${JSON.stringify(m.edges)}`).toBe(true);
      expect(m.stats.impactNodes).toBeGreaterThanOrEqual(1);
      const calls = m.edges.filter((e) => e.kind === "call");
      expect(calls.length, `应有 call 边: ${JSON.stringify(m.edges)}`).toBeGreaterThan(0);
      const up = calls.find((e) => e.label === "upstream")!;
      expect(up).toBeTruthy();
      const fromNode = m.nodes.find((n) => n.id === up.from)!;
      expect(fromNode.file).toBe("src/caller.ts");
      expect(fromNode.via).toBe("impact");
      expect(fromNode.label).toContain("caller.ts:3");
    } finally {
      rmSync(idxRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("路径名通道", () => {
  it("二进制 .mp4 内容扫不到,文件名产出 assets 命中(line=0)", () => {
    const hits = report.hits.filter((h) => h.file === "assets/demoFlag-promo.mp4");
    expect(hits.length, `应有路径名命中: ${JSON.stringify(report.hits.map((h) => `${h.category} ${h.file}:${h.line}`))}`)
      .toBe(1);
    expect(hits[0]!.category).toBe("assets");
    expect(hits[0]!.line).toBe(0);
    expect(hits[0]!.text).toBe("assets/demoFlag-promo.mp4");
    // 与内容命中按 file+line 去重:同一文件不会出现两条 line=0
    expect(report.hits.filter((h) => h.file === "assets/demoFlag-promo.mp4" && h.line === 0).length).toBe(1);
  });

  it("concept 短于 3 字不进路径名通道(避免处处命中)", async () => {
    const r = await scanSurface(root, ["on"]);
    expect(r.hits.some((h) => h.line === 0)).toBe(false);
  });

  it("classifySurfacePath 纯函数:大小写不敏感、短 concept 返回 null", () => {
    expect(classifySurfacePath("assets/DH-Video.MP4", "dh-video")).toBe("assets");
    expect(classifySurfacePath("assets/dh-video.mp4", "dh")).toBeNull();
    expect(classifySurfacePath("assets/other.png", "dh-video")).toBeNull();
    expect(classifySurfacePath("db/migrations/001_dh_video.sql", "dh_video")).toBe("db");
    expect(classifySurfacePath(".github/workflows/dh-video.yml", "dh-video")).toBe("deploy");
  });
});

describe("足迹类别扩展", () => {
  it("deploy/db/i18n 路径分类", () => {
    expect(classifySurfaceHit("Dockerfile", "x")).toBe("deploy");
    expect(classifySurfaceHit("docker-compose.prod.yml", "x")).toBe("deploy");
    expect(classifySurfaceHit(".github/workflows/ci.yml", "x")).toBe("deploy");
    expect(classifySurfaceHit(".gitlab-ci.yml", "x")).toBe("deploy");
    expect(classifySurfaceHit("Jenkinsfile", "x")).toBe("deploy");
    expect(classifySurfaceHit("k8s/deploy.yaml", "x")).toBe("deploy");
    expect(classifySurfaceHit("helm/chart/values.yaml", "x")).toBe("deploy");
    expect(classifySurfaceHit("charts/app/templates/x.yaml", "x")).toBe("deploy");
    expect(classifySurfaceHit("scripts/deploy.sh", "x")).toBe("deploy");
    expect(classifySurfaceHit("fly.toml", "x")).toBe("deploy");
    expect(classifySurfaceHit("Procfile", "x")).toBe("deploy");
    expect(classifySurfaceHit("vercel.json", "x")).toBe("deploy");
    expect(classifySurfaceHit("netlify.toml", "x")).toBe("deploy");
    expect(classifySurfaceHit(".dockerignore", "x")).toBe("deploy");

    expect(classifySurfaceHit("db/migrations/001.sql", "x")).toBe("db");
    expect(classifySurfaceHit("migration/002.sql", "x")).toBe("db");
    expect(classifySurfaceHit("src/query.sql", "x")).toBe("db");
    expect(classifySurfaceHit("prisma/schema.prisma", "x")).toBe("db");
    expect(classifySurfaceHit("db/schema.ts", "x")).toBe("db");
    expect(classifySurfaceHit("seed_users.sql", "x")).toBe("db");

    expect(classifySurfaceHit("locales/zh-CN.json", "x")).toBe("i18n");
    expect(classifySurfaceHit("locale/en.yaml", "x")).toBe("i18n");
    expect(classifySurfaceHit("i18n/strings.ts", "x")).toBe("i18n");
    expect(classifySurfaceHit("translations/fr.json", "x")).toBe("i18n");
    expect(classifySurfaceHit("messages/en.json", "x")).toBe("i18n");
    expect(classifySurfaceHit("po/zh.po", "x")).toBe("i18n");
    expect(classifySurfaceHit("po/base.pot", "x")).toBe("i18n");
  });

  it("优先级:测试路径里的 deploy/db 文件仍判 tests", () => {
    expect(classifySurfaceHit("db/migrations/test/001.test.ts", "x")).toBe("tests");
    expect(classifySurfaceHit("test/migrations/001.sql", "x")).toBe("tests");
  });

  it("SURFACE_CATEGORIES 与链路图层序逐字相同,且含全部 11 类", () => {
    expect([...SURFACE_CATEGORIES]).toEqual([...SURFACE_LAYER_ORDER]);
    expect(SURFACE_CATEGORIES.length).toBe(11);
    for (const c of ["deploy", "db", "i18n"] as const) expect(SURFACE_CATEGORIES).toContain(c);
    expect(Object.keys(report.byCategory).sort()).toEqual([...SURFACE_CATEGORIES].sort());
  });

  it("报告里 deploy/db/i18n 各有命中(玩具仓三处)", () => {
    for (const c of ["deploy", "db", "i18n"] as const) {
      expect(report.byCategory[c], `分类 ${c} 应有命中`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("renderSurfaceChainMarkdown", () => {
  it("含分层表/建议改动顺序/边清单分组/已知边界,且不写 :0", () => {
    const md = renderSurfaceChainMarkdown(map);
    expect(md).toContain("分层(改动依赖顺序");
    expect(md).toContain("建议改动顺序");
    expect(md).toContain("边清单");
    expect(md).toContain("已知边界");
    expect(md).toContain("| 层 | 命中 | 文件 |");
    expect(md).not.toContain(":0 ");
    expect(md).toContain("assets/demoFlag-promo.mp4");
    // 每个节点在顺序清单里出现一次
    for (const n of map.nodes) {
      expect(md).toContain(n.file);
      expect(md.split(n.label).length - 1).toBeGreaterThanOrEqual(1);
    }
  });

  it("零命中:给空态说明而不是抛错", async () => {
    const empty = await buildSurfaceChainMap(root, await scanSurface(root, ["noSuchConceptZzz"]));
    expect(empty.nodes).toEqual([]);
    expect(empty.layers).toEqual([]);
    expect(empty.stats).toEqual({ layers: 0, nodes: 0, edges: 0, impactNodes: 0, withCallChain: false });
    expect(empty.knownLimits.some((l) => l.includes("零命中"))).toBe(true);
    expect(renderSurfaceChainMarkdown(empty)).toContain("零节点");
  });

  it("零命中:标题与零节点说明都带上入参概念(不回落「(无 concept)」)", async () => {
    const empty = await buildSurfaceChainMap(root, await scanSurface(root, ["xyzNoSuch"]));
    expect(empty.concepts).toEqual(["xyzNoSuch"]);
    const md = renderSurfaceChainMarkdown(empty);
    const title = md.split("\n").find((l) => l.startsWith("### 概念链路图 chain"))!;
    expect(title).toContain("xyzNoSuch");
    expect(title).not.toContain("(无 concept)");
    expect(md).toContain("概念「xyzNoSuch」未出现或被过滤");
  });

  it("有命中:标题按 concepts 去重且保持入参顺序", async () => {
    const rep = await scanSurface(root, [CONCEPT, "noSuchConceptYyy", CONCEPT]);
    const m = await buildSurfaceChainMap(root, rep);
    expect(m.concepts).toEqual(rep.concepts);
    const title = renderSurfaceChainMarkdown(m).split("\n").find((l) => l.startsWith("### 概念链路图 chain"))!;
    expect(title).toContain(CONCEPT);
    expect(title.split(CONCEPT).length - 1).toBe(1);
  });
});
