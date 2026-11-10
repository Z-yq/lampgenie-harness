/**
 * board→pptx 第三版(step-1013):按 ZCode pptx skill 规范重做渲染层。
 * 回归锚(用户三次否定的具体事由,任一条退回即交付不合格):
 * - 每页必须有视觉版式(图/表格/对比/大数字/引言),纯文字页拒导;
 * - 版式互斥,要点只能配图(≤3)或引言(≤2);
 * - 字号阶梯:正文 ≥16、标题 32、页脚 12;不画标题装饰线/色条由渲染层保证;
 * - 章页不再单独出页(规范:不许大面积留白),章 claim 做本章首屏导语。
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parseDeckMd, validateDeck, planDeck, humanize, boardToDeckTemplate, boardToCompositionTemplate } from "../src/board-pptx.mjs";
import { COMPOSITION_RELATIONS } from "../src/board-content-predicate.js";
import { boardExportPptxTool } from "../src/board-export-pptx-tool.js";
import { boardPath } from "../src/board-store.js";

const MD = readFileSync(new URL("./fixtures/deck.md", import.meta.url), "utf8");

describe("parseDeckMd", () => {
  const d = parseDeckMd(MD) as any;
  it("章/页/元数据", () => {
    expect(d.title).toBe("genie-memory 方案评审");
    expect(d.verdict).toBe("有条件通过");
    expect(d.chapters.map((c: any) => [c.no, c.title])).toEqual([["01", "定位与目标"], ["02", "核心流程"]]);
    expect(d.chapters[0].pages.map((p: any) => p.title)).toEqual(["这是什么系统", "系统边界"]);
    expect(d.chapters[1].pages.map((p: any) => p.title)).toEqual(["写入链", "判定与建议", "死代码实证"]);
  });
  it("stats/compare/flow/quote 四类块都解析", () => {
    const kinds = d.chapters.flatMap((c: any) => c.pages.map((p: any) => p.blocks.map((b: any) => b.kind)));
    expect(kinds.flat()).toEqual(["stats", "bullets", "compare", "bullets", "flow", "bullets", "quote", "bullets", "code", "bullets"]);
    const st = d.chapters[0].pages[0].blocks[0].data.stats;
    expect(st).toHaveLength(3);
    expect(st[0]).toEqual({ value: "20+", label: "条 HTTP 路由", source: "service/app.py:318" });
    const fl = d.chapters[1].pages[0].blocks[0].data;
    expect(fl.edges.find((e: any) => e.label === "否").to).toBe("drop");
  });
});

describe("validateDeck(质量门)", () => {
  it("合格源稿零问题", () => {
    expect(validateDeck(parseDeckMd(MD))).toEqual([]);
  });
  it("未知版式块 fail-closed:```kpi 这类未登记块拒导并点名(以前静默 ignore,导出后内容凭空消失)", () => {
    const bad = MD.replace("```stats", "```kpi");
    const it2 = parseDeckMd(bad) as any;
    expect(it2.unknownBlocks.map((b: any) => b.kind)).toEqual(["kpi"]);
    const msgs = validateDeck(it2).map((i: any) => i.msg).join("\n");
    expect(msgs).toMatch(/未登记版式块/);
    expect(msgs).toMatch(/kpi/);
  });
  it("纯文字页拒导(规范:不许 text-only)", () => {
    const d = parseDeckMd(MD) as any;
    d.chapters[0].pages[0].blocks = [{ kind: "bullets", items: [{ lead: "甲", text: "说明一" }, { lead: "乙", text: "说明二" }] }];
    expect(validateDeck(d).map((i) => i.msg).join("\n")).toMatch(/纯文字页/);
  });
  it("每页必须有 ≥2 条解读(深度门)", () => {
    const d = parseDeckMd(MD) as any;
    d.chapters[1].pages[0].blocks = d.chapters[1].pages[0].blocks.filter((b: any) => b.kind !== "bullets");
    expect(validateDeck(d).map((i) => i.msg).join("\n")).toMatch(/解读只有 0 条/);
    const d2 = parseDeckMd(MD) as any;
    const bl = d2.chapters[1].pages[0].blocks.find((b: any) => b.kind === "bullets");
    bl.items = [{ lead: "并发", text: "批内有界并发4" }, { lead: "失败", text: "重试一次才抛错" }];
    expect(validateDeck(d2).map((i) => i.msg).join("\n")).toMatch(/总字数/);
  });
  it("code 摘录:来源必填、行数与行长受限", () => {
    const d = parseDeckMd(MD) as any;
    const cb = d.chapters.flatMap((c: any) => c.pages).map((p: any) => p.blocks.find((b: any) => b.kind === "code")).find(Boolean);
    expect(cb.data.source).toBe("service/recall_engine.py:20-25");
    expect(cb.data.lines).toHaveLength(5);
    const bad = parseDeckMd(MD) as any;
    const pg2 = bad.chapters.flatMap((c: any) => c.pages).find((p: any) => p.blocks.some((b: any) => b.kind === "code"));
    // 该页同时保留 2 条解读,避免深度门先报
    const cbBad = pg2.blocks.find((b: any) => b.kind === "code");
    cbBad.data.lines = Array.from({ length: 10 }, () => "x".repeat(100));
    pg2.blocks = pg2.blocks.filter((b: any) => b.kind !== "code");
    pg2.blocks.push({ kind: "code", data: cbBad.data });
    expect(validateDeck(bad).map((i) => i.msg).join("\n")).toMatch(/超 8 行|超 92 字符/);
  });
  it("版式混排与要点超配都拒", () => {
    const d = parseDeckMd(MD) as any;
    d.chapters[1].pages[0].blocks.push({ kind: "table", headers: ["a", "b"], rows: [["1", "2"], ["3", "4"]] });
    const quotePage = d.chapters[1].pages.find((p: any) => p.blocks.some((b: any) => b.kind === "quote"));
    quotePage.blocks.push({ kind: "bullets", items: [{ lead: "一", text: "说明一" }, { lead: "二", text: "说明二" }, { lead: "三", text: "说明三" }] });
    const msgs = validateDeck(d).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/同页混排/);
    expect(msgs).toMatch(/解读 5 条过多/);
  });
  it("长句/内部术语/缺证据都点名", () => {
    const d = parseDeckMd(MD) as any;
    d.chapters[1].pages[0].blocks[1].items[0].text = "回答维度①:".padEnd(70, "长");
    d.chapters[1].pages[1].evidence = "";
    const msgs = validateDeck(d).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/超过一行 64 字|内部术语/);
    expect(msgs).toMatch(/缺 `> 证据:`/);
  });
});

describe("planDeck(不再有章节页)", () => {
  const plan = planDeck(parseDeckMd(MD)) as any[];
  it("封面 + 内容页,章名进页眉", () => {
    expect(plan[0].kind).toBe("cover");
    expect(plan.filter((s) => s.kind === "chapter")).toHaveLength(0);
    expect(plan.filter((s) => s.kind === "content")).toHaveLength(5);
    expect(plan[1].chapterNo).toBe("01");
    expect(plan[1].kicker).toContain("记忆服务");
    expect(plan[2].kicker).toBe("");
  });
  it("版式:stats/compare/flow/quote/code", () => {
    expect(plan.filter((s) => s.kind === "content").map((s) => s.layout)).toEqual(["stats", "compare", "visual", "quote", "code"]);
  });
  it("页码与总数", () => {
    expect(plan[0].pageIndex).toBe(1);
    expect(plan[0].total).toBe(6);
    expect(plan[5].pageIndex).toBe(6);
  });
});

describe("boardToDeckTemplate", () => {
  const doc = {
    title: "genie-memory 方案评审 PPT 骨架(逐章扩页终版)",
    nodes: [
      { id: "agg", kind: "aggregate", label: "【总评】有条件通过", summary: "回答维度①:分层清晰" },
      { id: "s1", kind: "section", label: "01 定位与目标" },
      { id: "p1", kind: "page", label: "这是什么系统", summary: "回答维度①:迁移来的记忆服务" },
    ],
    edges: [{ from: "s1", to: "p1", kind: "contains" }],
  };
  const md = boardToDeckTemplate(doc);
  it("标题清洗 + 结构照板 + 视觉版式提示", () => {
    expect(md.split("\n")[0]).toBe("# genie-memory 方案评审");
    expect(md).toContain("## 01 定位与目标");
    expect(md).toContain("### 这是什么系统");
    expect(md).toContain("layers");
  });
  it("未填正文必被质量门挡住", () => {
    const iss = validateDeck(parseDeckMd(md));
    expect(iss.length).toBeGreaterThan(0);
    expect(iss.map((i) => i.msg).join("\n")).toMatch(/模板注释未填|纯文字页|缺 `> 证据:`/);
  });
});

// ---- composition 板(办公/产出类「作业思路板」)→ 汇报骨架源稿 ----

/** composition 板 fixture:1 主题 + 1 受众 + 3 章,章间关系边乱序给(s2→s1 承接、s1→s3 递进)。 */
const compBoard = {
  title: "Q3 客户调研汇报(草稿)",
  boardType: "composition",
  nodes: [
    { id: "th", kind: "note", label: "主题:Q3 客户流失分析", summary: "向管理层说明 Q3 流失原因与对策" },
    { id: "au", kind: "note", label: "受众:管理层月度会", summary: "管理层月度会 · 2026-11" },
    { id: "s1", kind: "section", label: "现状盘点", summary: "流失率与收入影响的现状" },
    { id: "s2", kind: "section", label: "原因分析", summary: "价格与竞品两条主因" },
    { id: "s3", kind: "section", label: "对策建议", summary: "分层挽留与产品补齐" },
  ],
  edges: [
    { from: "s2", to: "s1", kind: "data", label: "承接" },
    { from: "s1", to: "s3", kind: "data", label: "递进" },
  ],
};

/** 已填好的 composition 源稿:2 章、每页 1 视觉版式(stats)+ 2 条解读、无 TODO、无任何 `> 证据:` 行。 */
const FILLED_COMP = [
  "# Q3 客户调研汇报",
  "subtitle: 向管理层说明三季度客户流失的原因与对策",
  "genre: composition",
  "verdict: 流失可解释且可干预",
  "verdict_note: 两个主因两条对策,先稳续费再补能力",
  "meta: 管理层月度会 · 2026-11",
  "",
  "## 01 原因分析",
  "claim: 价格与竞品替代是流失的两个主因",
  "",
  "### 原因分析 · 开篇",
  "```stats",
  "12% | 当季流失率 | 账单系统",
  "3.2分 | NPS 环比下降 | 客户调研",
  "```",
  "- **价格敏感** — 三季度续费统一提价百分之八,当季流失率立刻环比上升了五个百分点",
  "- **竞品替代** — 竞品新版上线后,协同编辑场景里的存量客户被成批分流到对家产品",
  "> 素材: 客服访谈 20 条 · 账单系统导出",
  "",
  "## 02 对策建议",
  "claim: 分层挽留优先,产品补齐跟上",
  "",
  "### 对策建议 · 开篇",
  "```stats",
  "85% | 高价值客户续费率目标 | 运营方案",
  "2项 | 本季补齐的场景能力 | 产品路线",
  "```",
  "- **分层挽留** — 高价值客户给专属折扣加专属服务,先把续费基本盘稳住再谈增长",
  "- **产品补齐** — 补上被竞品分流的协同编辑能力,把场景护城河重新筑起来不再被动",
  "> 素材: 运营挽留方案 v2 · 产品路线图",
  "",
].join("\n");

describe("boardToCompositionTemplate(composition 板→汇报骨架)", () => {
  const md = boardToCompositionTemplate(compBoard, { relations: COMPOSITION_RELATIONS });
  it("genre 行 + 章序按关系边拓扑排(s2→s1 承接、s1→s3 递进 ⇒ s2,s1,s3)", () => {
    expect(md).toContain("genre: composition");
    const i1 = md.indexOf("## 01 原因分析");
    const i2 = md.indexOf("## 02 现状盘点");
    const i3 = md.indexOf("## 03 对策建议");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });
  it("outline 一行目录线索,关系词来自边 label", () => {
    expect(md).toContain("outline: 01 原因分析 --承接--> 02 现状盘点 --递进--> 03 对策建议");
  });
  it("主题/受众节点回填 subtitle 与 meta,TODO 要点与素材行在场", () => {
    expect(md).toContain("subtitle: 向管理层说明 Q3 流失原因与对策");
    expect(md).toContain("meta: 管理层月度会 · 2026-11");
    expect(md).toContain("### 原因分析 · 开篇");
    expect(md).toContain("- <!-- **小标题** — 一句话说明 -->");
    expect(md).toContain("> 素材: <!-- 数据/引用/案例来源(可选) -->");
  });
  it("视觉版式提示保留(每页一种版式的门不放松)", () => {
    expect(md).toContain("layers");
    expect(md).toContain("compare");
    expect(md).toContain("quote");
  });
});

describe("validateDeck 宽松档(composition:免证据行,结构门保留)", () => {
  it("已填好的 composition 源稿(无任何 `> 证据:` 行)零问题", () => {
    const iss = validateDeck(parseDeckMd(FILLED_COMP));
    expect(iss.map((i) => i.msg).join("\n")).not.toMatch(/缺 `> 证据:`/);
    expect(iss).toEqual([]);
  });
  it("纯文字页仍拒(删掉某页的视觉版式)", () => {
    const plain = FILLED_COMP.replace(/```stats[\s\S]*?```/, "");
    const msgs = validateDeck(parseDeckMd(plain)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/纯文字页/);
  });
  it("TODO 残留仍拒(加一处 <!-- -->)", () => {
    const todo = FILLED_COMP.replace("### 原因分析 · 开篇", "### 原因分析 · 开篇\n<!-- x -->");
    const msgs = validateDeck(parseDeckMd(todo)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/模板注释未填/);
  });
  it("docs 档(无 genre 行)仍要求证据行——宽松只给 composition", () => {
    const noGenre = FILLED_COMP.replace("genre: composition\n", "");
    const msgs = validateDeck(parseDeckMd(noGenre)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/缺 `> 证据:`/);
  });
});

describe("board_export_pptx × composition 板(端到端)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  it("mode=template 生成含 genre: composition 的源稿;填好后 mode=export 落 .pptx(size>0)", async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "gh-comp-store-"));
    const taskRoot = mkdtempSync(join(tmpdir(), "gh-comp-task-"));
    dirs.push(storeRoot, taskRoot);
    const sid = "s-comp";
    const tid = "t-comp";
    // 板存储布局同 boardPath(root, sessionId, taskId)=.genie/boards/<sid>/<tid>.json(board-store.ts:26-30)
    const p = boardPath(storeRoot, sid, tid);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({
      version: 1, taskId: tid, sessionId: sid, status: "draft", rev: 1,
      title: "Q3 客户调研汇报(草稿)", boardType: "composition",
      nodes: compBoard.nodes, edges: compBoard.edges,
    }, null, 1), "utf8");
    const tool = boardExportPptxTool(sid, tid, taskRoot, storeRoot);
    const r1 = String(await tool.execute({ mode: "template", targetTaskId: tid } as never));
    expect(r1).toContain("已生成汇报骨架源稿");
    expect(r1).toContain("素材");
    const src = join(taskRoot, "docs", "review", `${tid}.deck.md`);
    expect(existsSync(src), "源稿已落盘").toBe(true);
    expect(readFileSync(src, "utf8")).toContain("genre: composition");
    // 往源稿填最简合格内容(2 章、每页 1 视觉版式 + 2 条解读、无 TODO)后导出
    writeFileSync(src, FILLED_COMP, "utf8");
    const r2 = String(await tool.execute({ mode: "export", source: src } as never));
    expect(r2).toContain("已导出");
    const pptx = join(taskRoot, "docs", "review", `${tid}.pptx`);
    expect(existsSync(pptx), "pptx 已落盘").toBe(true);
    expect(statSync(pptx).size).toBeGreaterThan(0);
  }, 60_000);
});
