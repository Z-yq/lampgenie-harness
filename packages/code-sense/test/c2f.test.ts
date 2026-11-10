import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { buildC2fIndex, loadIndex, saveIndex, querySymbol, queryEntryPoints, queryEntryPointsMeta, renderNeighborhood, renderFile, indexStale, srcFingerprint, isSampledIndex, samplingNote, type C2fIndex } from "../src/callgraph/c2f";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
let idx: C2fIndex;

beforeAll(async () => {
  // 小夹具:hub 调 leaf,entry 调 hub;Class 容器方法
  const dir = mkdtempSync(join(tmpdir(), "gh-c2f-"));
  writeFileSync(join(dir, "hub.ts"), [
    "export function hubFn(): number {",
    "  return leafFn() + 1;",
    "}",
    "export function leafFn(): number {",
    "  return 42;",
    "}",
    "export class Svc {",
    "  run(): number { return this.step(); }",
    "  step(): number { return leafFn(); }",
    "}",
    "export function entry(): number { return hubFn() + new Svc().run(); }",
  ].join("\n"));
  idx = await buildC2fIndex(dir);
}, 120_000);

describe("c2f 静态索引(2026-10-12 三改)", () => {
  it("节点三分类:entry/hub=trunk 或 regular,leafFn=leaf", () => {
    const leaf = idx.nodes.find((n) => n.name === "leafFn");
    expect(leaf?.kind).toBe("leaf");
    const hub = idx.nodes.find((n) => n.name === "hubFn");
    expect(hub).toBeTruthy();
    expect(["trunk", "regular"]).toContain(hub!.kind);
  });
  it("Class 容器进节点(container=Svc)", () => {
    const run = idx.nodes.find((n) => n.name === "Svc.run");
    expect(run?.container).toBe("Svc");
  });
  it("querySymbol:hubFn 的 callers 含 entry,callees 含 leafFn", () => {
    const hits = querySymbol(idx, "hubFn");
    expect(hits.length).toBe(1);
    expect(hits[0]!.callers.map((c) => c.name)).toContain("entry");
    expect(hits[0]!.callees.map((c) => c.name)).toContain("leafFn");
  });
  it("indexStale 采样档:采样索引 count 口径不同不误报;取样集删除/编辑仍判过期", () => {
    const r = mkdtempSync(join(tmpdir(), "gh-c2f-sampled-"));
    try {
      // 磁盘 3 个源文件,索引记的 srcCount 是「采样 2 个」——旧逻辑 fp.count(3) !== srcCount(2) 恒 stale
      writeFileSync(join(r, "a.py"), "def a():\n    return 1\n");
      writeFileSync(join(r, "b.py"), "def b():\n    return 2\n");
      writeFileSync(join(r, "c.py"), "def c():\n    return 3\n");
      const fp = srcFingerprint(r);
      const idx: C2fIndex = {
        version: 1, root: r, gitHead: "", builtAt: 0, buildMs: 0,
        nodes: [{ id: "a.py#a", name: "a", file: "a.py", line: 1, kind: "trunk", outCount: 0, inCount: 0 }],
        edges: [], byFile: {}, byName: {},
        headSha: "", srcMtime: fp.maxMtime, srcCount: 2,
        coverage: { byExt: {}, totalDisk: 0, totalIndexed: 0, truncated: { reason: "扫描达文件上限 2(磁盘实见 3,按语言配额公平采样),可能存在未扫描文件", limit: 2 } },
        srcSampled: { limit: 2, totalSeen: 3, checkSet: [{ rel: "a.py", mtime: fp.maxMtime }] },
      };
      expect(isSampledIndex(idx)).toBe(true);
      expect(samplingNote(idx)).toContain("采样索引");
      expect(indexStale(r, idx)).toBe(false); // 采样版不再永久误报
      // 取样文件被编辑(mtime 变大)→ 仍检出过期
      writeFileSync(join(r, "a.py"), "def a():\n    return 11\n");
      const later = Date.now() + 5000;
      utimesSync(join(r, "a.py"), new Date(later), new Date(later));
      expect(indexStale(r, idx)).toBe(true);
      // 取样文件被删除 → 仍检出过期
      rmSync(join(r, "a.py"));
      expect(indexStale(r, idx)).toBe(true);
      srcFingerprint(r, true); // 清指纹缓存,免影响后续用例
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("旧采样索引(coverage.truncated 字样,无 srcSampled 字段)也判为采样:poly-grafana 实测形态", () => {
    const r = mkdtempSync(join(tmpdir(), "gh-c2f-sampled-legacy-"));
    try {
      writeFileSync(join(r, "x.ts"), "export function x(): number { return 1; }\n");
      const fp = srcFingerprint(r);
      const idx: C2fIndex = {
        version: 1, root: r, gitHead: "", builtAt: 0, buildMs: 0,
        nodes: [{ id: "x.ts#x", name: "x", file: "x.ts", line: 1, kind: "trunk", outCount: 0, inCount: 0 }],
        edges: [], byFile: {}, byName: {},
        headSha: "", srcMtime: fp.maxMtime, srcCount: 1219,
        coverage: { byExt: {}, totalDisk: 0, totalIndexed: 0, truncated: { reason: "堆预算自适应采样(估算 1478MB > 预算 858MB,降数 1218)" } },
      };
      expect(isSampledIndex(idx)).toBe(true);
      expect(indexStale(r, idx)).toBe(false);
      srcFingerprint(r, true);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("entrypoints 非产品路径过滤( P1-1):docs/examples 入口默认过滤,--all 可见,过滤条数如实", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-eps-filter-"));
    try {
      mkdirSync(join(dir, "docs_src", "tutorial"), { recursive: true });
      mkdirSync(join(dir, "app"), { recursive: true });
      writeFileSync(join(dir, "docs_src", "tutorial", "t00.ts"),
        "export function tutorialEntry(): number { return helperA() + helperB() + 1; }\nexport function helperA(): number { return 1; }\nexport function helperB(): number { return 2; }\n");
      writeFileSync(join(dir, "app", "main.ts"),
        "export function appEntry(): number { return leaf() + 1; }\nexport function leaf(): number { return 3; }\n");
      const i = await buildC2fIndex(dir);
      const kept = queryEntryPoints(i, 10).map((n) => n.file);
      expect(kept).toContain("app/main.ts");
      expect(kept.some((f) => f.startsWith("docs_src/"))).toBe(false); // 教程入口不进清单
      const meta = queryEntryPointsMeta(i, 10);
      expect(meta.filtered).toBeGreaterThan(0);
      expect(meta.note).toContain("已过滤");
      const all = queryEntryPointsMeta(i, 10, { all: true });
      expect(all.kept.some((n) => n.file.startsWith("docs_src/"))).toBe(true); // 逃生口
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("queryEntryPoints:entry 为 trunk(无人调用)", () => {
    const eps = queryEntryPoints(idx);
    const names = eps.map((n) => n.name);
    expect(names).toContain("entry");
  });
  it("邻域图:code2flow 形态(File 子图+Class 子图+分类 classDef)", () => {
    const mer = renderNeighborhood(idx, "hubFn");
    expect(mer).toContain("flowchart TD");
    expect(mer).toContain("subgraph");
    expect(mer).toContain("classDef leaf");
    expect(mer).toContain("hubFn");
  });
  it("文件图:renderFile 含本文件符号", () => {
    const files = Object.keys(idx.byFile);
    const mer = renderFile(idx, files[0]!);
    expect(mer).toContain("flowchart TD");
    expect(mer).toContain("leafFn");
  });
  it("save/load 往返一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-save-"));
    const p = saveIndex(dir, idx);
    const loaded = loadIndex(dir);
    expect(loaded).toBeTruthy();
    expect(loaded!.nodes.length).toBe(idx.nodes.length);
    void p;
  });
});

describe("c2f 本仓真图(慢,标记手动)", () => {
  it.skip("REPO 全图构建", async () => {
    const real = await buildC2fIndex(REPO);
    expect(real.nodes.length).toBeGreaterThan(100);
  });
});

describe("c2f 全图索引收结构语言(2026-10-14 修复:此前 listSourceFiles 不列 .py/.go/.java,Python 仓索引全空)", () => {
  it("py 文件经 adapter 进全图索引:符号+边+trunk/leaf 分类;venv/ 跳过;.py 不喂 ts-morph 产垃圾", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-py-"));
    try {
      mkdirSync(join(dir, "venv", "lib"), { recursive: true });
      writeFileSync(join(dir, "venv", "lib", "sitepkg.py"), "def venv_noise():\n    return 1\n");
      writeFileSync(join(dir, "svc.py"), [
        "def hub_fn():",
        "    return leaf_fn()",
        "",
        "",
        "def leaf_fn():",
        "    return 1",
        "",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const names = i.nodes.map((n) => n.name);
      expect(names).toContain("hub_fn");
      expect(names).toContain("leaf_fn");
      expect(names).not.toContain("venv_noise"); // venv/ 目录跳过
      expect(i.nodes.every((n) => n.file === "svc.py")).toBe(true); // 全部来自 py adapter,ts-morph 零垃圾
      expect(i.nodes.find((n) => n.name === "leaf_fn")?.kind).toBe("leaf");
      expect(querySymbol(i, "hub_fn")[0]!.callees.map((c) => c.name)).toContain("leaf_fn");
      expect(queryEntryPoints(i).map((n) => n.name)).toContain("hub_fn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("ts+py 混合仓:两类语言符号共存于同一索引", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-mixed-"));
    try {
      writeFileSync(join(dir, "a.ts"), "export function tsEntry(): number { return 1; }\n");
      writeFileSync(join(dir, "b.py"), "def py_entry():\n    return 1\n");
      const i = await buildC2fIndex(dir);
      const names = i.nodes.map((n) => n.name);
      expect(names).toContain("tsEntry");
      expect(names).toContain("py_entry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("indexStale 自愈档:0 节点索引+仓有源文件=过期(重建);真空仓=稳定不抖动", () => {
    const r1 = mkdtempSync(join(tmpdir(), "gh-c2f-heal-"));
    try {
      writeFileSync(join(r1, "m.py"), "def a():\n    return 1\n");
      const fp1 = srcFingerprint(r1);
      const emptyIdx: C2fIndex = {
        version: 1, root: r1, gitHead: "", builtAt: 0, buildMs: 0,
        nodes: [], edges: [], byFile: {}, byName: {},
        headSha: "", srcMtime: fp1.maxMtime, srcCount: fp1.count,
      };
      expect(indexStale(r1, emptyIdx)).toBe(true); // 残缺空索引自愈
      const r2 = mkdtempSync(join(tmpdir(), "gh-c2f-void-"));
      try {
        const fp2 = srcFingerprint(r2); // count=0
        const voidIdx: C2fIndex = { ...emptyIdx, root: r2, srcMtime: fp2.maxMtime, srcCount: fp2.count };
        expect(indexStale(r2, voidIdx)).toBe(false); // 真空仓不抖动
      } finally {
        rmSync(r2, { recursive: true, force: true });
      }
    } finally {
      rmSync(r1, { recursive: true, force: true });
    }
  });

  it("indexStale 确定性空:覆盖报告证明支持语言全零符号=不再永久自愈抖动;旧格式无 coverage 仍自愈", () => {
    const r = mkdtempSync(join(tmpdir(), "gh-c2f-detempty-"));
    try {
      // php-laravel/ruby-jekyll 形态:磁盘只剩零函数 js 资源脚本,索引 0 节点 + coverage 诚实登记
      writeFileSync(join(r, "assets.js"), "// vendored runtime shim\nwindow.__x = 1;\n");
      const fp = srcFingerprint(r);
      const detEmpty: C2fIndex = {
        version: 1, root: r, gitHead: "", builtAt: 0, buildMs: 0,
        nodes: [], edges: [], byFile: {}, byName: {},
        headSha: "", srcMtime: fp.maxMtime, srcCount: fp.count,
        coverage: { byExt: { ".js": { diskFiles: 1, indexedFiles: 0 } }, totalDisk: 1, totalIndexed: 0 },
      };
      expect(indexStale(r, detEmpty)).toBe(false); // 重建结果确定相同 → 不再永久 stale
      // 无 coverage 的旧格式空索引仍走自愈(旧版不收 py/go/java 的残缺索引必须重建)
      const { coverage: _drop, ...noCov } = detEmpty;
      expect(indexStale(r, noCov as C2fIndex)).toBe(true);
      // 采样/截断的空索引也不算确定性空(可能真有文件没扫到)
      const truncatedEmpty: C2fIndex = { ...detEmpty, coverage: { ...detEmpty.coverage!, truncated: { reason: "扫描达文件上限 1" } } };
      expect(indexStale(r, truncatedEmpty)).toBe(true);
      srcFingerprint(r, true);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("indexStale:旧格式索引(无 srcMtime)=过期(升级重建;旧分支名档让残缺索引永久新鲜)", () => {
    const r = mkdtempSync(join(tmpdir(), "gh-c2f-legacy-"));
    try {
      writeFileSync(join(r, "x.py"), "def a():\n    return 1\n");
      const legacy: C2fIndex = {
        version: 1, root: r, gitHead: "ref: refs/heads/master", builtAt: 0, buildMs: 0,
        nodes: [], edges: [], byFile: {}, byName: {},
      };
      expect(indexStale(r, legacy)).toBe(true);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

describe("模块级调用归含+图边合并(2026-10-14 校验轮:组合根调用丢失/hub 边爆炸)", () => {
  it("模块级调用归到 <module> 虚调用方:callers 可见;仅模块级调用的组合根仍是 trunk(入口判定只看具名调用方)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-mod-"));
    try {
      writeFileSync(join(dir, "main.ts"), [
        "const app = createApp({});",
        "export function createApp(o: object): number { return helper(); }",
        "function helper(): number { return 1; }",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const hits = querySymbol(i, "createApp");
      expect(hits.length).toBe(1);
      const mod = hits[0]!.callers.find((c) => c.name === "<module>");
      expect(mod).toBeTruthy();
      expect(mod!.file).toBe("main.ts");
      // 组合根只被模块级调用 → 仍是 trunk 入口(从 main.ts 开始读它);但 callers 如实可见
      expect(i.nodes.find((n) => n.name === "createApp")?.kind).toBe("trunk");
      // helper 的 callers 仍是 createApp(函数内调用不受影响)
      expect(querySymbol(i, "helper")[0]!.callers.map((c) => c.name)).toContain("createApp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("邻域图:模块级调用方上图(◆ <module> 伪节点)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-modg-"));
    try {
      writeFileSync(join(dir, "main.ts"), [
        "const app = createApp({});",
        "export function createApp(o: object): number { return 1; }",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const mer = renderNeighborhood(i, "createApp");
      expect(mer).toContain("(module)"); // escLabel:<module> 裸拼会被 mermaid 当 HTML 标签吞掉
      expect(mer).toContain("createApp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("同对多调用点合并:3 个调用点=1 条边标 ×3(此前 90+ 重复边炸图)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-merge-"));
    try {
      writeFileSync(join(dir, "loop.ts"), [
        "export function loop(n: number): number {",
        "  if (n <= 0) return 0;",
        "  return send(n) + send(n - 1) + send(n - 2);",
        "}",
        "function send(x: number): number { return x; }",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const mer = renderNeighborhood(i, "loop");
      expect(mer).toContain("send");
      const edgeLines = mer.split("\n").filter((l) => l.includes("-->"));
      expect(edgeLines.length).toBe(1); // 3 个调用点合并成 1 条边
      expect(edgeLines[0]).toContain("×3");
      // querySymbol callers/callees 按符号去重(同调用方多调用点不再重复条目)
      expect(querySymbol(i, "send")[0]!.callers.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("文件图:renderFile 含本文件 <module> 伪节点及其出边", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-modf-"));
    try {
      writeFileSync(join(dir, "main.ts"), [
        "const a = boot();",
        "const b = boot();",
        "export function boot(): number { return 1; }",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const mer = renderFile(i, "main.ts");
      expect(mer).toContain("(module)");
      const edges = mer.split("\n").filter((l) => l.includes("-->"));
      expect(edges.length).toBe(1); // 两个模块级调用点合并成一条
      expect(edges[0]).toContain("×2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("python 跨文件调用边解析(2026-10-14 校验轮:import 收集了没消费,跨文件 0/11)", () => {
  it("from b import f + 裸调用:全图唯一名解析连边,被调方不再误标 trunk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-xpy-"));
    try {
      writeFileSync(join(dir, "a.py"), [
        "from b import render_block",
        "",
        "",
        "def render_page(r):",
        "    return render_block(r)",
        "",
      ].join("\n"));
      writeFileSync(join(dir, "b.py"), [
        "def render_block(x):",
        "    return x",
        "",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const callees = querySymbol(i, "render_page")[0]!.callees.map((c) => c.name);
      expect(callees).toContain("render_block");
      expect(i.nodes.find((n) => n.name === "render_block")?.kind).not.toBe("trunk");
      expect(queryEntryPoints(i).map((n) => n.name)).toContain("render_page");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("跨语言同名不幻连:py 裸调用同名 ts 函数不解析(同语言闸)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-xlang-"));
    try {
      writeFileSync(join(dir, "a.py"), [
        "from util import process",
        "",
        "",
        "def run(x):",
        "    return process(x)",
        "",
      ].join("\n"));
      writeFileSync(join(dir, "util.py"), "pass\n"); // import 落空:util.py 没有该函数
      writeFileSync(join(dir, "util.ts"), "export function process(x: number): number { return x; }\n");
      const i = await buildC2fIndex(dir);
      expect(querySymbol(i, "run")[0]!.callees.map((c) => c.name)).not.toContain("process");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("裸方法名查询(2026-10-14 校验轮:方法登记名 Class.method,裸名查不到)", () => {
  it("querySymbol 用裸方法名可命中类方法(多命中分别列出)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-bare-"));
    try {
      writeFileSync(join(dir, "a.py"), [
        "class A:",
        "    def run(self):",
        "        return 1",
        "",
      ].join("\n"));
      writeFileSync(join(dir, "b.py"), [
        "class B:",
        "    def run(self):",
        "        return 2",
        "",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const hits = querySymbol(i, "run");
      expect(hits.length).toBe(2);
      expect(hits.map((h) => h.symbol.name).sort()).toEqual(["A.run", "B.run"]);
      expect(querySymbol(i, "A.run").length).toBe(1); // 限定名照常
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("entrypoints 测试文件降权(2026-10-14 校验轮:pytest 方法把真实入口挤出 top-N)", () => {
  it("生产入口排前,测试入口靠后不隐瞒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-ep-"));
    try {
      writeFileSync(join(dir, "server.py"), [
        "def dispatch(msg):",
        "    return handle_a(msg) + handle_b(msg)",
        "",
        "def handle_a(m):",
        "    return 1",
        "",
        "def handle_b(m):",
        "    return 2",
        "",
      ].join("\n"));
      mkdirSync(join(dir, "tests"), { recursive: true });
      writeFileSync(join(dir, "tests", "test_big.py"), [
        "class TestHuge:",
        "    def test_many(self):",
        "        return t1() + t2() + t3() + t4()",
        "",
        "def t1(): return 1",
        "def t2(): return 1",
        "def t3(): return 1",
        "def t4(): return 1",
        "",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const eps = queryEntryPoints(i, 4);
      // dispatch(下游 2,生产)必须排在 test_many(下游 4,测试)前面
      expect(eps[0]!.name).toBe("dispatch");
      expect(eps.map((n) => n.name)).toContain("TestHuge.test_many");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("原型名符号(qwen-audio-agent 实证:function valueOf 崩整仓索引构建)", () => {
  it("buildByMaps 无原型对象:valueOf/toString 符号不炸构建;查询原型名不炸", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-proto-"));
    try {
      writeFileSync(join(dir, "consensus.mjs"), [
        "export function rank(items) {",
        "  return valueOf(items[0]) + items.length;",
        "}",
        "function valueOf(item) {",
        "  return item.weight;",
        "}",
        "export function hasOwnProperty(x) { return x; }",
      ].join("\n"));
      const i = await buildC2fIndex(dir); // 修复前:TypeError byName[n.name].push is not a function
      const vo = querySymbol(i, "valueOf");
      expect(vo.length).toBe(1);
      expect(vo[0]!.callers.map((c) => c.name)).toContain("rank");
      // 查询未索引的原型名:守卫后返回空,不抛
      expect(querySymbol(JSON.parse(JSON.stringify(i)), "toString")).toEqual([]);
      expect(querySymbol(JSON.parse(JSON.stringify(i)), "constructor")).toEqual([]);
      // JSON 往返后已索引的原型名仍可查
      expect(querySymbol(JSON.parse(JSON.stringify(i)), "valueOf").length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("属性调用证据闸(qwen/teamai/gitdiagram 实证:arr.push/fs.pathExists 吸到仓内唯一同名)", () => {
  it("无证据属性调用不解析;new 接收者/命名空间 import/同文件静态调用恢复;裸调用注入全局除外", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-deny-"));
    try {
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "fsextra.ts"), "export function pathExists(p: string): boolean { return p.length > 0; }\n");
      writeFileSync(join(dir, "repo.ts"), [
        "import * as fx from \"./lib/fsextra\";",
        "export class Repo {",
        "  static load(): number { return 1; }",
        "  push(x: number): number { return x; }",
        "  drain(): number { return this.push(1); }",
        "}",
        "export function flood(arr: number[]): void {",
        "  arr.push(1); // 无证据:不得解析到 Repo.push",
        "}",
        "export function fsCaller(p: string): boolean {",
        "  return fx.pathExists(p); // 命名空间 import:解析到 lib/fsextra.pathExists,不落到 Repo 同名",
        "}",
        "export function newCaller(): number {",
        "  const r = new Repo();",
        "  return r.push(2); // new 接收者证据:解析到 Repo.push",
        "}",
        "export function staticCaller(): number {",
        "  return Repo.load(); // 同文件类静态:解析",
        "}",
        "export function paramCaller(r: Repo): number {",
        "  return r.drain(); // 参数接收者无类型证据:不解析(宁缺勿错)",
        "}",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const pushHit = querySymbol(i, "Repo.push");
      expect(pushHit.length).toBe(1);
      const pushCallers = pushHit[0]!.callers.map((c) => c.name);
      expect(pushCallers).toContain("Repo.drain"); // this.push 保留
      expect(pushCallers).toContain("newCaller"); // new 证据恢复
      expect(pushCallers).not.toContain("flood"); // 无证据不解析
      expect(pushCallers).not.toContain("<module>");
      // 命名空间 import:解析到来源模块符号,不被同仓同名方法吸走
      const pe = querySymbol(i, "pathExists");
      expect(pe.length).toBe(1);
      expect(pe[0]!.callers.map((c) => c.name)).toContain("fsCaller");
      expect(pe[0]!.callers.map((c) => c.name)).not.toContain("flood");
      // 同文件类静态
      const load = querySymbol(i, "Repo.load");
      expect(load[0]!.callers.map((c) => c.name)).toContain("staticCaller");
      // new Cls() 进类符号 callers(newCl 是 new 表达式所在函数)
      const cls = querySymbol(i, "Repo");
      expect(cls.length).toBe(1);
      expect(cls[0]!.callers.map((c) => c.name)).toContain("newCaller");
      // 参数接收者:无类型证据不解析(不虚报)
      const drain = querySymbol(i, "Repo.drain");
      expect(drain[0]!.callers.map((c) => c.name)).not.toContain("paramCaller");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("裸调用注入全局除外:仓内本地 function test() 不吸收全仓 test() 调用(opencode test-debug.ts 实证)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-injected-"));
    try {
      writeFileSync(join(dir, "test-debug.ts"), [
        "async function test() { return 1; }",
        "export async function main() { await test(); }",
      ].join("\n"));
      writeFileSync(join(dir, "suite.test.ts"), [
        "test('case a', () => {});",
        "describe('suite', () => { test('case b', () => {}); });",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const t = querySymbol(i, "test");
      expect(t.length).toBe(1);
      const callers = t[0]!.callers.map((c) => c.name);
      expect(callers).toContain("main"); // 本文件真实调用保留
      expect(t[0]!.symbol.inCount).toBe(1); // 其它文件的 test(...) 调用不被吸收
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("new 表达式接收者恢复真调用:const s=new Store(); s.values() 解析;参数接收者不解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-c2f-newtype-"));
    try {
      writeFileSync(join(dir, "store.ts"), [
        "export class Store {",
        "  values(): number[] { return [1]; }",
        "}",
        "export function useStore(): number {",
        "  const s = new Store();",
        "  return s.values().length; // new 证据:恢复解析到 Store.values",
        "}",
        "export function readStore(store: Store): number {",
        "  return store.values().length; // 参数接收者无 new 证据:不解析(不虚报)",
        "}",
      ].join("\n"));
      const i = await buildC2fIndex(dir);
      const vals = querySymbol(i, "Store.values");
      expect(vals.length).toBe(1);
      const callers = vals[0]!.callers.map((c) => c.name);
      expect(callers).toContain("useStore"); // new 证据恢复
      expect(callers).not.toContain("readStore"); // 无证据不猜
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
