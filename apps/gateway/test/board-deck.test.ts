/**
 * board→pptx 第三版:按 ZCode pptx skill 规范重做渲染层。
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
import { parseDeckMd, validateDeck, planDeck, humanize, boardToDeckTemplate, boardToCompositionTemplate, deckToPptx, regenSimilarity, DEFAULT_THEME, THEME_NAMES } from "../src/board-pptx.mjs";
import { COMPOSITION_RELATIONS } from "../src/board-content-predicate.js";
import { boardExportPptxTool } from "../src/board-export-pptx-tool.js";
import { boardPath } from "../src/board-store.js";

const MD = readFileSync(new URL("./fixtures/deck.md", import.meta.url), "utf8");

describe("parseDeckMd", () => {
  const d = parseDeckMd(MD) as any;
  it("章/页/元数据", () => {
    expect(d.title).toBe("记忆服务方案评审");
    expect(d.verdict).toBe("有条件通过");
    expect(d.chapters.map((c: any) => [c.no, c.title])).toEqual([["01", "定位与目标"], ["02", "核心流程"], ["03", "术语表（附录）"]]);
    expect(d.chapters[0].pages.map((p: any) => p.title)).toEqual(["这是什么系统", "系统边界"]);
    expect(d.chapters[1].pages.map((p: any) => p.title)).toEqual(["写入链", "判定与建议", "死代码验证"]);
    expect(d.chapters[2].pages.map((p: any) => p.title)).toEqual(["自造词速查"]);
  });
  it("stats/compare/flow/quote/术语表(附录) 五类块都解析", () => {
    const kinds = d.chapters.flatMap((c: any) => c.pages.map((p: any) => p.blocks.map((b: any) => b.kind)));
    expect(kinds.flat()).toEqual(["stats", "bullets", "compare", "bullets", "flow", "bullets", "quote", "bullets", "code", "bullets", "table", "bullets"]);
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
    expect(msgs).toMatch(/解读 6 条过多/);
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
  it("封面 + 内容页(含术语表章),章名进页眉", () => {
    expect(plan[0].kind).toBe("cover");
    expect(plan.filter((s) => s.kind === "chapter")).toHaveLength(0);
    expect(plan.filter((s) => s.kind === "content")).toHaveLength(6);
    expect(plan[1].chapterNo).toBe("01");
    expect(plan[1].kicker).toContain("记忆服务");
    expect(plan[2].kicker).toBe("");
    expect(plan[6].chapterNo).toBe("03");
    expect(plan[6].layout).toBe("table");
  });
  it("版式:table(术语表)/stats/compare/flow/quote/code", () => {
    expect(plan.filter((s) => s.kind === "content").map((s) => s.layout)).toEqual(["stats", "compare", "visual", "quote", "code", "table"]);
  });
  it("页码与总数", () => {
    expect(plan[0].pageIndex).toBe(1);
    expect(plan[0].total).toBe(7);
    expect(plan[6].pageIndex).toBe(7);
  });
});

describe("boardToDeckTemplate", () => {
  const doc = {
    title: "记忆服务方案评审 PPT 骨架(逐章扩页终版)",
    nodes: [
      { id: "agg", kind: "aggregate", label: "【总评】有条件通过", summary: "回答维度①:分层清晰" },
      { id: "s1", kind: "section", label: "01 定位与目标" },
      { id: "p1", kind: "page", label: "这是什么系统", summary: "回答维度①:迁移来的记忆服务" },
    ],
    edges: [{ from: "s1", to: "p1", kind: "contains" }],
  };
  const md = boardToDeckTemplate(doc);
  it("标题清洗 + 结构照板 + 视觉版式提示", () => {
    expect(md.split("\n")[0]).toBe("# 记忆服务方案评审");
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
  "spine: Q3 客户为什么流失,现在怎么办",
  "dataPolicy: 账单与调研为实测,运营目标为设计目标",
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
  "- **价格敏感** — 三季度续费统一提价百分之八,当季流失率立刻环比上升五个百分点,时间点与幅度都对得上流失拐点,可作为主因归因",
  "- **竞品替代** — 竞品新版上线后,协同编辑场景的存量客户被成批分流到对家,分流趋势至今没有止住的迹象,属第二主因",
  "> 素材: 客服访谈 20 条 · 账单系统导出",
  "> 结论: 提价与竞品上线的时间点都对得上流失拐点",
  "",
  "## 02 对策建议",
  "claim: 分层挽留优先,产品补齐跟上",
  "",
  "### 对策建议 · 开篇",
  "```stats",
  "85% | 高价值客户续费率目标 | 运营方案",
  "2项 | 本季补齐的场景能力 | 产品路线",
  "```",
  "- **分层挽留** — 高价值客户给专属折扣加专属服务,先把续费基本盘稳住,再谈后续增长空间与投入产出边界在哪",
  "- **产品补齐** — 本季补上被竞品分流的协同编辑能力,把核心场景的存量客户留在本产品内不掉队,效果可按场景留存数据验证",
  "> 素材: 运营挽留方案 v2 · 产品路线图",
  "> 结论: 挽留先行稳续费,补能力止住协同场景分流",
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

describe("v4 设计/文案门(2026-11-15)", () => {
  it("theme/kicker 元数据:缺省 editorial/REPORT;composition 缺省 BRIEFING;未知 theme 拒导", () => {
    const d = parseDeckMd(MD) as any;
    expect(d.theme).toBe("");
    const cover = planDeck(d)[0] as any;
    expect(cover.theme).toBe(DEFAULT_THEME);
    expect(cover.kicker).toBe("REPORT");
    expect(THEME_NAMES).toEqual(["editorial", "technical", "executive", "warm"]);

    const themed = MD.replace("subtitle:", "theme: warm\nkicker: BRIEFING\nsubtitle:");
    const d2 = parseDeckMd(themed) as any;
    expect(d2.theme).toBe("warm");
    expect((planDeck(d2)[0] as any).kicker).toBe("BRIEFING");

    const bad = MD.replace("subtitle:", "theme: neon\nsubtitle:");
    expect(validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n")).toMatch(/未知 theme/);
  });

  it("agent 报告腔被 voice 门拒(首先/其次/综上)", () => {
    const bad = MD.replace(
      "- **服务面不小** — 30 余条路由挂在同一个 FastAPI 实例上,边界全部集中在 service 层",
      "- **服务面** — 首先看路由,其次看边界,综上所述服务面不小",
    );
    const msgs = validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/VOICE_CONNECTOR/);
  });

  it("单条要点超过 64 字被 voice 门拒(关键词不是段落)", () => {
    const long = "这条说明写得像一段报告而不是关键词所以它超过了单行上限并且应该被拆成两条或者删掉解释性从句只留下判断和数字以及对应的证据来源与负责人和截止时间";
    const bad = MD.replace(
      "- **服务面不小** — 30 余条路由挂在同一个 FastAPI 实例上,边界全部集中在 service 层",
      `- **服务面** — ${long}`,
    );
    const msgs = validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/VOICE_LONG/);
  });
});

describe("v5 叙事门(2026-11-15 「每页不知道想表达什么」)", () => {
  it("缺 spine/claim/结论行都点名", () => {
    const noSpine = MD.replace("spine: memory-service 能不能独立部署并守住记忆质量\n", "");
    let msgs = validateDeck(parseDeckMd(noSpine)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/缺 `spine:`/);

    const noClaim = MD.replace("claim: 它是记忆服务,不是对话服务\n", "");
    msgs = validateDeck(parseDeckMd(noClaim)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/章缺 `claim:`/);

    const noTake = MD.replace("> 结论: 服务面与配置面都压在 service 层,扩路由先扩这层的边界\n", "");
    msgs = validateDeck(parseDeckMd(noTake)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/缺 `> 结论:`/);
  });
  it("结论行:太短/太长/与标题逐字相同都拒", () => {
    const short = MD.replace("> 结论: 服务面与配置面都压在 service 层,扩路由先扩这层的边界", "> 结论: 边界集中");
    let msgs = validateDeck(parseDeckMd(short)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/结论只有 \d+ 字/);

    const long = MD.replace("> 结论: 服务面与配置面都压在 service 层,扩路由先扩这层的边界", `> 结论: ${"这句结论写得像一段报告而不是一句判断所以它超过了结论带的单行上限需要压缩到四十二字以内".repeat(2)}`);
    msgs = validateDeck(parseDeckMd(long)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/超 42/);

    const same = MD.replace("> 结论: 服务面与配置面都压在 service 层,扩路由先扩这层的边界", "> 结论: 这是什么系统");
    msgs = validateDeck(parseDeckMd(same)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/结论与标题逐字相同/);
  });
  it("结论行也过 voice 门(报告腔不因位置不同而豁免)", () => {
    const bad = MD.replace("> 结论: 服务面与配置面都压在 service 层,扩路由先扩这层的边界", "> 结论: 综上所述,服务面不小,这意味着边界要收敛,赋能下游");
    const msgs = validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/VOICE_/);
  });
  it("大数字说明 >16 字 / 来源 >20 字拒(v5.1 实测病灶:四列副标折三行压到来源行)", () => {
    const badLabel = MD.replace("8 | 份维度配置", "8 | 一份一份手写的维度配置文件目录结构");
    expect(validateDeck(parseDeckMd(badLabel)).map((i) => i.msg).join("\n")).toMatch(/大数字说明超 16 字/);
    const badSource = MD.replace("dimensions/ 目录", "dialogue_memory/dimensions/ 目录下全部配置");
    expect(validateDeck(parseDeckMd(badSource)).map((i) => i.msg).join("\n")).toMatch(/大数字来源超 20 字/);
  });
  it("流程图回边:缺标签/同义反复标签都拒,条件语义放行", () => {
 // 给 fixture 的写入链加一条回边:seg -> recv
    const noLabel = MD.replace("seg -> memcell", "seg -> memcell\nseg -> recv");
    let msgs = validateDeck(parseDeckMd(noLabel)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/回边 seg→recv 缺标签/);

    const tauto = MD.replace("seg -> memcell", "seg -> memcell\nseg -> recv: 回边");
    msgs = validateDeck(parseDeckMd(tauto)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/同义反复/);

    const ok = MD.replace("seg -> memcell", "seg -> memcell\nseg -> recv: 段失败重切");
    expect(validateDeck(parseDeckMd(ok))).toEqual([]);
  });
});

describe("v7 就地拆解契约(2026-11-16 「解释要跟内容放在一起,开局术语表=文档地图;点名不拆解」)", () => {
  it("开局放术语表=地图风格拒;收尾附录放行(fixture 即附录)", () => {
    const front = MD.replace("## 01 定位与目标", "## 00 术语与概念\nclaim: 先看词表\n\n### 词表\n| 术语 | 是什么 |\n|---|---|\n| 甲词 | 一句说清它是什么的样例定义,长度要够十个字 |\n\n## 01 定位与目标");
    expect(validateDeck(parseDeckMd(front)).map((i) => i.msg).join("\n")).toMatch(/术语表是附录不是开场/);
  });
  it("自造词首用页缺定义带拒;当页补 `> 定义:` 放行", () => {
    const jargon = MD.replace("- **服务面不小** — 30 余条路由挂在同一个 FastAPI 实例上,边界全部集中在 service 层", "- **世界模型不小** — 30 余条路由挂在同一个 FastAPI 实例上,边界全部集中在 service 层");
    const msgs = validateDeck(parseDeckMd(jargon)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/自造词「世界模型」首次出现在这页/);
    const fixed = jargon.replace("> 证据: service/app.py:318 · README.md:20", "> 定义: 世界模型=对整个仓符号与调用关系的持久索引画像,查它代替逐文件探索\n> 证据: service/app.py:318 · README.md:20");
    expect(validateDeck(parseDeckMd(fixed))).toEqual([]);
  });
  it("词条(附录)定义超长仍拒", () => {
    const longDef = MD.replace(
      "| MemCell | 切分对话得到的最小记忆单元,带维度与层级标签 |",
      `| MemCell | ${"这是一个写得非常长的定义它把类比例子机制和历史全都塞进一格远远超过六十字的单行上限".repeat(2)} |`,
    );
    expect(validateDeck(parseDeckMd(longDef)).map((i) => i.msg).join("\n")).toMatch(/定义 \d+ 字/);
  });
  it("点名即枚举:标题承诺「N 个 X」当页必须摆出 N 项", () => {
    const ok = MD.replace("### 写入链", "### 写入链:五个环节逐个过");
    expect(validateDeck(parseDeckMd(ok)).map((i) => i.msg).join("\n")).not.toMatch(/点名即枚举/);
    const bad = MD.replace("### 写入链", "### 写入链:七个环节逐个过");
    expect(validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n")).toMatch(/承诺「七个」但主体只摆了 5 项/);
 // 数字带小数不算枚举承诺(46.6 步不该要求 46 项)
    const decimal = MD.replace("> 结论: 写入链的失败被圈在单条,批级吞吐靠并发闸兜住", "> 结论: 平均要走 46.6 步才轮到落账,别小看这一圈");
    expect(validateDeck(parseDeckMd(decimal)).map((i) => i.msg).join("\n")).not.toMatch(/点名即枚举/);
  });
  it("每页解读 2–4 条、总字数 ≥100(藏信息=片面式写作,拒;v13 起下限 100)", () => {
    const d = parseDeckMd(MD) as any;
    const bl = d.chapters[1].pages[0].blocks.find((b: any) => b.kind === "bullets");
    bl.items = [...bl.items, { lead: "第四条", text: "批内消息全部落库后才算这一批完成" }, { lead: "第五条", text: "再多一条用来触发上限" }];
    expect(validateDeck(d).map((i) => i.msg).join("\n")).toMatch(/解读 5 条过多/);

    const thin = MD.replace(
      "- **并发闸** — 写入判定批内有界并发 4,防止历史回放一次性压垮 LLM 端点,超界请求排队等待而不是被丢弃",
      "- **并发闸** — 批内有界并发,超界排队",
    ).replace("- **失败语义** — 判定失败重试一次才抛错,单条坏数据不会中断整批消息入库,给下游抖动留出一次缓冲窗口", "- **失败语义** — 重试一次才抛错");
    expect(validateDeck(parseDeckMd(thin)).map((i) => i.msg).join("\n")).toMatch(/<100/);
  });
});

describe("v9 构建思路/内容质量/UI 设计门(2026-11-17)", () => {
  it("成稿(≥8 页)缺 notCovering 拒;带了放行", () => {
    const big = MD.replace("## 01 定位与目标", "notCovering: 各家 UI、模型选型、评测排名\n\n## 01 定位与目标") + "\n" + MD.slice(MD.indexOf("## 02 核心流程")).replace("## 02 核心流程", "## 04 核心流程复本");
    const bigNo = MD + "\n" + MD.slice(MD.indexOf("## 02 核心流程")).replace("## 02 核心流程", "## 04 核心流程复本");
    expect(parseDeckMd(bigNo).chapters.reduce((n: number, c: any) => n + c.pages.length, 0)).toBeGreaterThanOrEqual(8);
    expect(validateDeck(parseDeckMd(bigNo)).map((i) => i.msg).join("\n")).toMatch(/缺 `notCovering:`/);
    expect(validateDeck(parseDeckMd(big)).map((i) => i.msg).join("\n")).not.toMatch(/缺 `notCovering:`/);
  });
  it("≥2 页大数字缺 dataPolicy 拒", () => {
    const statsPage = "### 第二张数字页\n```stats\n8 | 份维度配置 | dimensions/\n3 | 层记忆 | README.md:20\n```\n- **要点甲** — 这段说明写得够长够长够长够长够长够长\n- **要点乙** — 这段说明写得够长够长够长够长够长够长\n> 证据: README.md:20\n> 结论: 第二张数字页用来验证三档纪律";
    const twoStats = MD.replace("## 02 核心流程", statsPage + "\n\n## 02 核心流程");
    const msgs = validateDeck(parseDeckMd(twoStats)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/缺 `dataPolicy:`/);
  });
  it("同一要点在两页逐字重复拒(递进不是复读)", () => {
    const dup = MD.replace("### 判定与建议", "### 判定与建议\n- **服务面不小** — 30 余条路由挂在同一个 FastAPI 实例上,边界全部集中在 service 层,扩路由先过这层的闸");
    expect(validateDeck(parseDeckMd(dup)).map((i) => i.msg).join("\n")).toMatch(/逐字重复/);
  });
  it("同章连续 3 页同一版式拒(视觉节奏塌)", () => {
    const rhythm = MD.replace("## 02 核心流程", "## 02 核心流程\nnota: x").replace("### 判定与建议", "### 判定与建议").replace("### 死代码实证", "### 死代码实证");
    const three = MD.slice(0, MD.indexOf("## 02 核心流程")) + "## 02 核心流程\nclaim: 三页同版式测试\n\n" +
      ["### 流程甲", "### 流程乙", "### 流程丙"].map((t) => `${t}\n\`\`\`flow\na: 甲\nb: 乙\na -> b\n\`\`\`\n- **要点一** — 说明文字够长够长够长够长够长\n- **要点二** — 说明文字够长够长够长够长够长\n> 证据: x\n> 结论: 三页同版式应该被拒掉`).join("\n\n") +
      "\n\n## 03 附录\nclaim: 附录章\n\n### 对比\n\`\`\`compare\nA: 一 | 二\nB: 三 | 四\n\`\`\`\n- **要点三** — 说明文字够长够长够长够长够长\n- **要点四** — 说明文字够长够长够长够长够长\n> 证据: y\n> 结论: 附录对比页用于隔离节奏测试";
    const msgs = validateDeck(parseDeckMd(three)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/连续 3 页同一版式/);
  });
  it("状态徽标取值校验:非法值拒,四种合法值放行", () => {
    const bad = MD.replace("> 证据: service/app.py:318 · README.md:20", "> 状态: 做了一半\n> 证据: service/app.py:318 · README.md:20");
    expect(validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n")).toMatch(/状态「做了一半」不合法/);
    for (const good of ["已落地", "部分落地", "设计目标", "未测"]) {
      const ok = MD.replace("> 证据: service/app.py:318 · README.md:20", `> 状态: ${good}\n> 证据: service/app.py:318 · README.md:20`);
      expect(validateDeck(parseDeckMd(ok)).map((i) => i.msg).join("\n")).not.toMatch(/状态/);
    }
  });
});



// ---- v10 叙事弧门 fixture:≥20 页合规稿(全部单行字符串拼接,避免转义坑) ----
function v10Page(i: number, kind: string, title: string, layout?: string): string {
  const kits: Record<string, string[]> = {
    cards: ["```cards", `甲卡 | 第 ${i} 页的结构说明,一句话讲清它是什么 | 子项一;子项二`, `乙卡 | 第 ${i} 页的边界说明,一句话讲清它不做什么 | 子项三;子项四`, "```"],
    flow: ["```flow", `a: 起手 :: 第 ${i} 页从这里开始`, "b: 推进 :: 中间动作", "c: 收口 :: 停在这里", "a -> b", "b -> c", "```"],
    steps: ["```steps", `第一步 | 第 ${i} 页第一个动作,写清它产出什么`, "第二步 | 第二个动作,写清它判定什么", "第三步 | 第三个动作,写清它落什么账", "```"],
    pseudo: ["```pseudo", `if (ready) {`, `  run(${i})  // 第 ${i} 页的核心分支`, `}`, "```"],
    table: ["| 甲 | 乙 |", "|---|---|", `| 第 ${i} 页甲行 | 乙行说明 |`, "| 丙行 | 丁行说明 |"],
    compare: ["```compare", `方案甲: 第 ${i} 页做法一 | 做法二`, "方案乙: 另一做法一 | 另一做法二", "```"],
  };
  return [
    `### ${title}`,
    ...kits[kind],
    i % 2 === 0
      ? `- **机制${i}** — 机制怎么转、谁受影响、边界在哪;实测开销约 12ms、命中率 98%(2026-11 实测口径),与其余页不重复`
      : `- **机制${i}** — 第 ${i} 页的机制说明要写够一百个字符上下,交代机制怎么转、谁受影响、边界在哪,保证与其它页不重复并且稳稳过掉字数门`,
    i % 3 === 0
      ? `- **影响${i}** — 谁受益、谁付代价、何时结论不成立;代价与边界展开见第 03 章走读,补足长度与论证密度要求`
      : `- **影响${i}** — 第 ${i} 页的影响说明同样写够长度,讲清谁受益、谁付出代价、代价怎么量化、什么条件下结论不结束`,
    `> 证据: 0${(i % 5) + 1}-harness-doc.md §${(i % 7) + 1};09-harness-basics.md §9.${(i % 9) + 1}`,
    `> 结论: 第 ${i} 页的独立结论,长度合规`,
    ...(layout ? [`> 版式: ${layout}`] : []),
    "",
  ].join("\n");
}

function v10Deck(opts: { conceptTitle?: string; noBridge?: boolean; deepAllCards?: boolean } = {}): string {
  const concept = opts.conceptTitle || "harness 是什么";
  const bridge = opts.noBridge ? [v10Page(20, "cards", "实现开场的交代")] : [
    "### 从通用骨架到实现:带着底线走一遍",
    "```flow",
    "a: 通用 :: 骨架先立起来",
    "b: 落地 :: 骨架逐格对应",
    "c: 收口 :: 带着底线进实现",
    "a -> b",
    "b -> c",
    "```",
    "- **只做过渡** — 把前章骨架的五条底线带进后面的实现走读,这一页只交代从哪儿进、按什么顺序展开、每章对应骨架哪一格",
    "- **一页就够** — 过渡页不占正文篇幅,读者带着地图进入具体做法,后面每一页都对应骨架里的一格来拆解,不迷路",
    "> 证据: 09-harness-basics.md §9.3",
    "> 结论: 骨架是地图,实现是走法",
    "",
  ];
  const deepBody = opts.deepAllCards
    ? [v10Page(41, "cards", "走读甲", "左图右文"), v10Page(42, "table", "走读乙", "右图左文"), v10Page(43, "cards", "走读丙", "左图右文"), v10Page(44, "table", "走读丁", "右图左文"), v10Page(45, "cards", "走读戊", "左图右文"), v10Page(46, "table", "走读己", "右图左文")]
    : [v10Page(21, "flow", "走读一:请求怎么组装", "左图右文"), v10Page(22, "steps", "走读二:逐格动作", "右图左文"), v10Page(23, "pseudo", "走读三:压缩怎么选档"), v10Page(24, "flow", "走读四:循环怎么走", "左图右文"), v10Page(25, "steps", "走读五:落账怎么判", "右图左文"), v10Page(26, "pseudo", "走读六:缓存断在哪")];
  return [
    "# v10 叙事弧测试稿",
    "subtitle: 通用→具体→深拆",
    "spine: 同一套骨架,为什么四家实现走法不同",
    "notCovering: 本次不讲模型选型、不讲评测排名",
    "",
    `## 01 ${concept}`,
    "claim: 读完能判断一个系统算不算 harness,并说出它的三道边界",
    v10Page(1, "cards", "每件事各有落点"),
    v10Page(2, "flow", "一条请求怎么流过", "左图右文"),
    v10Page(3, "steps", "内层动作怎么排", "右图左文"),
    v10Page(4, "cards", "底线的判定", "大字结论"),
    "## 02 从骨架到实现",
    "claim: 把骨架带进实现,逐格看一家怎么落地",
    ...bridge,
    "## 03 ZCode 走读",
    "claim: 读完能对着代码说出这一家一圈请求怎么组装",
    ...deepBody,
    "## 04 问题与对策",
    "claim: 读完能把通病认成机制缺口,并说出对策的证据强度",
    v10Page(27, "cards", "问题一与问题二", "左图右文"),
    v10Page(28, "compare", "问题三与问题四"),
    v10Page(29, "table", "对策对照表", "右图左文"),
    v10Page(30, "steps", "对策怎么落地", "左图右文"),
    v10Page(31, "cards", "代价与边界"),
    "## 05 收口",
    "claim: 读完能分清已落地与设计目标,并知道下一步做什么",
    v10Page(32, "table", "状态总表", "右图左文"),
    v10Page(33, "cards", "这次不讲什么", "大字结论"),
    v10Page(34, "compare", "下一步做什么"),
    v10Page(35, "steps", "复评怎么做"),
    "",
  ].join("\n");
}

describe("v10 叙事弧门(2026-11-17 「先讲通用,再讲实现,再详细拆解;深拆配 flow」)", () => {
  it("合规 20+ 页稿零问题", () => {
    const deck = parseDeckMd(v10Deck());
    expect(deck.chapters.reduce((n: number, c: any) => n + c.pages.length, 0)).toBeGreaterThanOrEqual(20);
    expect(validateDeck(deck)).toEqual([]);
  });
  it("首章不是概念/通用/骨架拒绝", () => {
    const msgs = validateDeck(parseDeckMd(v10Deck({ conceptTitle: "总览" }))).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/叙事弧缺概念首章/);
  });
  it("缺承上启下过渡页拒绝", () => {
    const msgs = validateDeck(parseDeckMd(v10Deck({ noBridge: true }))).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/缺承上启下过渡页/);
  });
  it("深拆章过程示意不足半数拒绝", () => {
    const msgs = validateDeck(parseDeckMd(v10Deck({ deepAllCards: true }))).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/深拆章过程化不足/);
  });
});

describe("v11 人类阅读门(2026-11-18 「要符合人类阅读习惯,不是 agent coding 思维/平铺证据;看不出 zcode 循环有哪些步骤、每步干什么」)", () => {
  const TEN = ["Idle 空闲 | 没有活干,等用户来", "处理输入 | 把用户输入接进来,判不收就直接退", "等模型 | 请求已发出,等模型开口说话", "流式接收 | 边收边攒,模型想调的工具记成清单", "排计划 | 定这批工具谁先谁后、谁能并行", "执行工具 | 真正动手干活的一步", "等审批 | 要人点头的工具先挂起", "聚合结果 | 把这批工具的收成汇总", "收口 | 写结论与账目,这轮结束", "出错终态 | 哪步炸了都落到这里"];
  const v11Deck = (opts: any = {}) => {
    const stepsBlock = opts.tenRows === false
      ? ["Idle 空闲 | 没有活干,等用户来", "处理输入 | 把用户输入接进来", "等模型 | 请求已发出", "流式接收 | 边收边攒", "排计划 | 定先后与并行"]
      : TEN;
    const stepsTail = opts.tenRows === false ? `
### 后五相把工具变副作用

\`\`\`steps
执行工具 | 真正动手干活的一步
等审批 | 要人点头的工具先挂起
聚合结果 | 把这批工具的收成汇总
收口 | 写结论与账目,这轮结束
出错终态 | 哪步炸了都落到这里
\`\`\`
- **下一相由结果决定** — 有失败直接收口,全成功才回等模型,任何情况都不留半截状态把会话卡死在环里
- **终态只有两个** — 正常收口与出错收尾,其余相位都还有出口,出口设计决定会话会不会僵在环上
> 证据: 走读笔记 §3
> 结论: 后五相决定副作用与终态,漏掉失败分支调度器就少一个名额
` : "";
    const tableBlock = opts.tableCodeCol
      ? `| 相位 | 到达时在干什么 | 代码位置 |\n| --- | --- | --- |\n| Idle | 等用户来 | turn-state.ts:196 |\n| Streaming | 攒工具清单 | turn-machine.ts:152 |`
      : `| 相位 | 到达时在干什么 |\n| --- | --- |\n| Idle | 等用户来,没有活干 |\n| Streaming | 边收边攒,记下要调的工具 |`;
    const bulletA = opts.refBullets
      ? "- **配对校验** — transition() 先做 canTransitionTo 校验,非法迁移直接抛异常"
      : "- **配对校验** — 工具请求与工具结果必须成对出现,历史里坏一条就锁死整个会话,修复只能靠自愈逻辑回填配对消息才行";
    const bulletB = opts.refBullets
      ? "- **请求组装** — prepareRuntimeProviderRequest 出一次性 messages,不回写 state"
      : "- **请求组装** — 每圈重新拼一份完整请求发给模型,历史只追加不改写前段,开头不动缓存才能命中预算档,这是省钱关键";
    return `# 十相状态机走读
spine: 十相循环怎么把一次输入变成终态
notCovering: 模型选型与界面
## 01 骨架
claim: 十相是状态标签,循环才是引擎
### 十相一页走完:主干加两条支线

\`\`\`steps
${stepsBlock.join("\n")}
\`\`\`
- **一圈是一次模型调用** — 模型还要工具就再转一圈,不要了才收口,转多少圈由模型是否还想要工具决定,不是相位数决定
- **两个终态盖住所有出口** — 正常结束与出错都必须落账关单,失败不处理就会留无人认领的悬空任务,排障也找不到现场
> 定义: 回边=从循环尾指回循环头的那条边,表示还要再转一圈
> 证据: 走读笔记 §2
> 结论: 看懂这一页就看懂了整个循环,深拆只是把格子放大${stepsTail}
### 相位与动作对照

${tableBlock}
- ${bulletA.slice(2)}
- ${bulletB.slice(2)}
> 证据: 走读笔记 §3
> 结论: 每个相位只做一件事,职责混了排障就找不到格子
## 02 深拆
claim: 深拆挑执行与聚合两格,其余结构不展开
### 执行工具这一格放大

\`\`\`steps
${(opts.badExec ? ["执行工具 | ExecutingTools 置 running 并盖 startedAt,再起执行"] : ["执行工具 | 真正动手干活,超时与失败都要留下记录"]).join("\n")}
排队 | 要人点头的先挂起,批内其余照跑
回收 | 结果落账,决定回等模型还是直接收口
\`\`\`
- **审批不挡道** — 需要授权的工具单走一条等待通道,批内其它工具照常执行,不用整批陪着等一次授权往返的时间,授权等待不阻塞别的调用
- **失败也是产出** — 出错走同一条收口路径落账,不留无人认领的任务,排障时才有账可查、有现场可回放定位,定位根因不用翻全量日志
> 证据: 走读笔记 §4
> 结论: 执行格的关键是隔离与回收,不是并行度`;
  };
  it("合规稿(十相一页走完+人话职责+证据页脚)零问题", () => {
    const issues = validateDeck(parseDeckMd(v11Deck()));
    expect(issues).toEqual([]);
  });
  it("点名十相但没有一页走完(前五相/后五相拆页)拒绝", () => {
    const msgs = validateDeck(parseDeckMd(v11Deck({ tenRows: false }))).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/没有一页把它走完/);
    expect(msgs).toMatch(/全流程总览/);
  });
  it("拆页补上总览页后放行(总览是补充的必要条件,不是禁拆页)", () => {
    const withBoth = v11Deck({ tenRows: false }).replace(
      "### 相位与动作对照",
      `### 十相总览(一页走完)\n\n\`\`\`steps\n${TEN.join("\n")}\n\`\`\`\n- **一圈是一次模型调用** — 模型还要工具就再转一圈,不要了才收口,圈数由模型要工具的意愿决定\n- **终态盖住所有出口** — 正常结束与出错都落账,失败不处理就留悬空任务,排障无账可查\n> 证据: 走读笔记 §2\n> 结论: 这一页就是整个循环的地图,后面分段只是放大镜\n### 相位与动作对照`,
    );
    const msgs = validateDeck(parseDeckMd(withBoth)).map((i) => i.msg).join("\n");
    expect(msgs).not.toMatch(/没有一页把它走完/);
  });
  it("步骤说明复述代码赋值(置 running 盖 startedAt)拒绝——那是 agent 对话不是给读者的", () => {
    const msgs = validateDeck(parseDeckMd(v11Deck({ badExec: true }))).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/复述代码赋值/);
  });
  it("步骤说明含代码引用(file:line/函数调用)拒绝", () => {
    const bad = v11Deck().replace("真正动手干活,超时与失败都要留下记录", "起执行见 turn-machine.ts:152 的 runBatch()");
    const msgs = validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/含代码引用/);
  });
  it("步骤说明实现腔(≥2 个字段/函数名)拒绝", () => {
    const bad = v11Deck().replace("真正动手干活,超时与失败都要留下记录", "drain 队列再按 configMap 分发到 workerPool");
    const msgs = validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/实现腔/);
  });
  it("表格放「代码位置」列 / 单元格写行号拒绝(证据进页脚)", () => {
    const msgs = validateDeck(parseDeckMd(v11Deck({ tableCodeCol: true }))).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/表格放了「代码位置」列/);
    expect(msgs).toMatch(/表格单元格含代码引用/);
  });
  it("要点平铺代码位置(2/2 条报函数名)拒绝——人类读者先看懂行为", () => {
    const msgs = validateDeck(parseDeckMd(v11Deck({ refBullets: true }))).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/平铺证据/);
  });
  it("steps 容量:>14 行拒;名 >16 字拒;说明 >46 字拒(渲染上限,防静默截断)", () => {
    const rows15 = Array.from({ length: 15 }, (_, i) => `第${i + 1}格 | 干什么`).join("\n");
    const msgs15 = validateDeck(parseDeckMd(v11Deck().replace(TEN.join("\n"), rows15))).map((i) => i.msg).join("\n");
    expect(msgs15).toMatch(/超一页/);
    const longName = v11Deck().replace("Idle 空闲", "这一格的名字已经长到超过十六个字了吧");
    expect(validateDeck(parseDeckMd(longName)).map((i) => i.msg).join("\n")).toMatch(/超 16 字/);
    const longDetail = v11Deck().replace("没有活干,等用户来", "这一句人话职责写得实在太长太长了以至于一行根本放不下需要两行还多好几个字才勉强凑够四十七个字以上");
    expect(validateDeck(parseDeckMd(longDetail)).map((i) => i.msg).join("\n")).toMatch(/说明超 46 字/);
  });
  it("≥7 步渲染走两行回绕(deckToPptx 出 12 步页不炸,文件落地)", async () => {
    const rows12 = Array.from({ length: 12 }, (_, i) => [`第${i + 1}步 名字`, "这步干什么,为什么需要"][0] + " | 干什么").join("\n");
    const md = v11Deck().replace(TEN.join("\n"), rows12);
    const deck = parseDeckMd(md) as any;
    expect(validateDeck(deck)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "v11-wrap-"));
    const out = join(dir, "wrap.pptx");
    const r = await deckToPptx(deck, out);
    expect(r.slides).toBeGreaterThan(0);
    expect(statSync(out).size).toBeGreaterThan(5000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("标题承诺「回边」但版式是 steps 拒(steps 画不出回边,承诺兑现不了)", () => {
    const bad = v11Deck().replace("### 十相一页走完:主干加两条支线", "### 十相一页走完,回边只回发请求");
    const msgs = validateDeck(parseDeckMd(bad)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/steps 画不出回边|没有 flow/);
  });
});

describe("v12 版式引擎(2026-11-18 「每页从上往下一个模子;要左右布局、大框凸显」,借鉴 ref/ZCode pptx SKILL §3)", () => {
  it("`> 版式:` 行解析进 pageLayout 并透传 planDeck", () => {
    const md = `# 版式解析验证稿
spine: 版式怎么声明怎么渲染
notCovering: 无
## 01 章
claim: 这一章验证版式行的解析与透传
### 左右页

\`\`\`flow
a: 起
b: 承
a -> b
\`\`\`
- **要点一** — 说明写够长度,保证字数门稳稳通过不被误伤
- **要点二** — 说明同样写够长度,讲清机制与影响的对应关系
> 证据: 走读笔记 §1
> 结论: 左右布局由源稿声明,渲染器按版式重排
> 版式: 左图右文
`;
    const deck = parseDeckMd(md) as any;
    expect(deck.chapters[0].pages[0].pageLayout).toBe("左图右文");
    const plan = planDeck(deck) as any[];
    expect(plan.find((x) => x.kind === "content").pageLayout).toBe("左图右文");
  });
  it("版式合法性:非法值拒;大字结论页要点>2 拒、结论<14 字拒;左右页无主体拒、要点>3 拒、steps>8 拒、stats 页标左右拒", () => {
    const bad1 = v10Deck().replace("> 版式: 左图右文", "> 版式: 三栏").replace("> 版式: 右图左文", "");
    expect(validateDeck(parseDeckMd(bad1)).map((i) => i.msg).join("\n")).toMatch(/版式「三栏」不合法/);
    const focus = v10Deck().replace("> 版式: 大字结论", "").replace(`> 版式: 左图右文`, `> 版式: 大字结论`);
    const focusDeck = parseDeckMd(focus) as any;
 // v10Page 每页 2 条要点,大字结论合法;把其中一页加到 3 条要点 → 拒
    const pg = focusDeck.chapters[0].pages[1];
    pg.blocks.find((b: any) => b.kind === "bullets").items.push({ lead: "第三条", text: "焦点页不许铺第三条解读说明文字长度合规" });
    const msgs = validateDeck(focusDeck).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/大字结论页解读 3 条/);
    const focusShort = parseDeckMd(v10Deck().replace(/> 版式: 大字结论/, "").replace("> 版式: 左图右文", "> 版式: 大字结论")) as any;
    focusShort.chapters[0].pages[1].takeaway = "太短";
    expect(validateDeck(focusShort).map((i) => i.msg).join("\n")).toMatch(/大字结论页的结论 <14 字/);
 // 左右页无主体(纯要点)
    const noMain = parseDeckMd(v10Deck().replace(/```flow[\s\S]*?```/, "").replace("> 版式: 右图左文", "")) as any;
    noMain.chapters[0].pages[1].pageLayout = "左图右文";
    noMain.chapters[0].pages[1].blocks = [{ kind: "bullets", items: [{ lead: "甲", text: "说明一写够长度保证过门" }, { lead: "乙", text: "说明二写够长度保证过门" }] }];
    expect(validateDeck(noMain).map((i) => i.msg).join("\n")).toMatch(/没有图\/表\/码主版式块/);
 // stats 页标左右
    const statsSplit = parseDeckMd(v10Deck()) as any;
    statsSplit.chapters[0].pages[0].pageLayout = "左图右文";
    statsSplit.chapters[0].pages[0].blocks = [{ kind: "stats", data: { stats: [{ value: "3", label: "个数字", source: "口径" }, { value: "4", label: "条说明", source: "口径" }] } }, { kind: "bullets", items: [{ lead: "甲", text: "说明一写够长度保证过门" }, { lead: "乙", text: "说明二写够长度保证过门" }] }];
    expect(validateDeck(statsSplit).map((i) => i.msg).join("\n")).toMatch(/自带整页版式/);
  });
  it("多样性门:≥10 页全通栏=版式单调拒;连续同结构版式 >4 页拒", () => {
    const allWide = v10Deck().replace(/> 版式: [^\n]+\n/g, "");
    const msgs = validateDeck(parseDeckMd(allWide)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/版式单调/);
    const runDeck = parseDeckMd(v10Deck()) as any;
 // 把全部版式行改成通栏之外的一种(全部 大字结论) → 连续 run>4
    for (const c of runDeck.chapters) for (const pg of c.pages) pg.pageLayout = "大字结论";
    const msgs2 = validateDeck(runDeck).map((i) => i.msg).join("\n");
    expect(msgs2).toMatch(/连续 \d+ 页同一结构版式/);
  });
  it("渲染冒烟:左右布局(窄幅步骤竖排)与大字结论页 deckToPptx 落地不炸", async () => {
    const rows4 = ["一步 | 干什么的一句人话职责", "二步 | 干什么的另一句人话职责", "三步 | 第三句人话职责讲清产出", "四步 | 第四句人话职责讲清判定"].join("\n");
    const md = `# 版式渲染冒烟
spine: 左右与大字两种版式渲染不炸
notCovering: 不讲模型选型
## 01 章
claim: 这一章验证左右布局与大字结论的渲染路径
### 左右页

\`\`\`steps
${rows4}
\`\`\`
- **侧栏一** — 要点进侧栏卡而不是永远沉底,读者视线在图与要点之间左右横移,一段读完一段论证,侧栏与主体互为呼应,左右各承担一半论证
- **侧栏二** — 第二条侧栏要点补齐机制与影响,让侧栏自成一栏可独立读完不必回看主体区就能带走结论本身
> 证据: 走读笔记 §1
> 结论: 左右布局渲染路径的冒烟验证
> 版式: 左图右文
### 大字页

\`\`\`flow
a: 起 :: 从这里开始
b: 承 :: 中间推进一格
c: 收 :: 停在这里
a -> b
b -> c
\`\`\`
- **焦点补充** — 大字结论页的一条补充说明,交代结论成立的条件、适用范围与前提条件,不超限而且可独立成立并交代反例情形
- **焦点边界** — 第二条补充讲清边界之外的情形、代价与超出后的处理方式,长度同样满足下限要求且不重复,两条互补不啰嗦
> 证据: 走读笔记 §2
> 结论: 大字结论是唯一视觉焦点,标题退后让位
> 版式: 大字结论
## 02 收尾
claim: 占位章保证两章结构,不参与渲染验证
### 占位页

| 甲 | 乙 |
|---|---|
| 一行 | 说明一 |
| 二行 | 说明二 |
- **结构甲** — 这一条保证两章结构完整并写够字数下限,不误伤渲染验证流程本身也满足字数门槛的要求,并给断言留足余量
- **结构乙** — 同样保证字数下限,内容与两个验证页互不重复避免触发判重门造成额外的干扰项出现,保证结构断言稳定通过
> 证据: 走读笔记 §3
> 结论: 占位章只管结构,不影响冒烟结论
`;
    const deck = parseDeckMd(md);
    expect(validateDeck(deck)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "v12-layout-"));
    const out = join(dir, "layout.pptx");
    const r = await deckToPptx(deck, out);
    expect(r.slides).toBeGreaterThan(0);
    expect(statSync(out).size).toBeGreaterThan(5000);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("v13 轨迹分析门(2026-11-18 session 轨迹实测确认:重生成照抄旧稿 41/42 页只换版式、内容文档 20 份只读 2 份、11/42 页密度 <100)", () => {
  it("regenSimilarity:自比全雷同;每页换文案后雷同归零(版式行不算文字)", () => {
    const deck = parseDeckMd(v10Deck()) as any;
    const self = regenSimilarity(deck, v10Deck());
    expect(self.twin).toBe(self.matched);
    const rewritten = v10Deck()
      .replace(/机制说明要写够一百个字符上下/g, "机制叙事换了一个角度重写")
      .replace(/影响说明同样写够长度/g, "影响从另一个利益方重算一遍")
      .replace(/- \*\*机制/g, "- **新机制")
      .replace(/- \*\*影响/g, "- **新影响")
      .replace(/独立结论,长度合规/g, "重写后的结论换了论证角度");
    const sim = regenSimilarity(parseDeckMd(rewritten), v10Deck());
    expect(sim.twin / Math.max(1, sim.matched)).toBeLessThan(0.4);
    expect(sim.twin).toBeLessThan(8);
  });
  it("导出带 regenOf=逐字旧稿 → 换皮拒;regenOf 读不到 → 点名", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v13-regen-"));
    const src = join(dir, "a.deck.md");
    writeFileSync(src, FILLED_COMP, "utf8");
    const tool = boardExportPptxTool("s-v13", "t-v13", dir, dir);
    const r1 = String(await tool.execute({ mode: "export", source: src, regenOf: src } as never));
    expect(r1).toMatch(/换皮/);
    expect(r1).toContain("本次未产出文件");
    const r2 = String(await tool.execute({ mode: "export", source: src, regenOf: join(dir, "nope.md") } as never));
    expect(r2).toMatch(/读不到/);
 // 内容重写后(regenOf 指向原稿)放行
    const src2 = join(dir, "b.deck.md");
    writeFileSync(src2, FILLED_COMP
      .replace("价格敏感", "续费涨价是主因")
      .replace("三季度续费统一提价百分之八,当季流失率立刻环比上升五个百分点,时间点与幅度都对得上流失拐点,可作为主因归因", "涨价当季流失率环比抬了五个点,时点与幅度都对得上拐点,把流失的第一因坐实在价格策略上,证据链完整")
      .replace("竞品替代", "对手分流是次因")
      .replace("竞品新版上线后,协同编辑场景的存量客户被成批分流到对家,分流趋势至今没有止住的迹象,属第二主因", "对手新版把协同编辑场景的客户成批带走,分流至今没有止住的迹象,坐实第二个主因在产品能力缺口上")
      .replace("分层挽留", "先稳高价值")
      .replace("高价值客户给专属折扣加专属服务,先把续费基本盘稳住,再谈后续增长空间与投入产出边界在哪", "高价值客户给折扣与服务双保留,先把续费基本盘稳住不流失,再谈后续增长与投入产出的边界在哪一档")
      .replace("产品补齐", "再补能力缺口")
      .replace("本季补上被竞品分流的协同编辑能力,把核心场景的存量客户留在本产品内不掉队,效果可按场景留存数据验证", "本季补齐被分流的协同编辑能力,把核心场景客户留在产品内不掉队,效果按场景留存数据验收不靠感觉"), "utf8");
    const r3 = String(await tool.execute({ mode: "export", source: src2, regenOf: src } as never));
    expect(r3).toContain("已导出");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
  it("内容源覆盖门:≥20 页稿证据行只引 1 份内容文档 → 拒(推动从内容源重读)", () => {
    const one = v10Deck().replace(/0\d-harness-doc\.md §\d+;/g, "");
    const msgs = validateDeck(parseDeckMd(one)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/内容源覆盖不足/);
    expect(validateDeck(parseDeckMd(v10Deck())).map((i) => i.msg).join("\n")).not.toMatch(/内容源覆盖不足/);
  });
  it("密度下限 v13 起 100(75 是骨架级不是论证级)", () => {
    const thin = parseDeckMd(v10Deck()) as any;
    const pg = thin.chapters[0].pages[0];
    const bl = pg.blocks.find((b: any) => b.kind === "bullets");
    bl.items[0] = { lead: "短甲", text: "说明太短" };
    bl.items[1] = { lead: "短乙", text: "说明同样太短" };
    expect(validateDeck(thin).map((i) => i.msg).join("\n")).toMatch(/解读总字数 \d+<100/);
  });
});

describe("v14 内容质量门(2026-11-18 文本对比实测确认:wb 625字/页+126 个带单位数字 vs v11 370字/页+6 个;源文档单份 162 个数字,写作端零挖掘)", () => {
  it("具体性:≥20 页稿带单位数字的页 <40% 拒;达标放行(v10Deck 即达标)", () => {
 // 负向:把 v10Deck 全部数字子句与 XREF 尾都换成无数字表述后,需触发具体性门
    const noNum = v10Deck()
      .replace(/实测开销约[^,;]*[,;]?/g, ";")
      .replace(/机制怎么转、谁受影响、边界在哪;/g, "机制怎么转、谁受影响、边界在哪,说明写够一百字符上下保证密度门通过并且不与其余页重复,");
    const msgs = validateDeck(parseDeckMd(noNum)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/具体性不足|交叉引用只有/, );
    expect(validateDeck(parseDeckMd(v10Deck())).map((i) => i.msg).join("\n")).not.toMatch(/具体性不足/);
  });
  it("交叉引用:<5 页拒(读者要知道话题在哪章展开/回扣)", () => {
    const noXref = v10Deck().replace(/;代价与边界展开见第 03 章走读,补足长度与论证密度要求/g, ",不在此页展开,细节另述并写够长度与论证密度的要求");
    const msgs = validateDeck(parseDeckMd(noXref)).map((i) => i.msg).join("\n");
    expect(msgs).toMatch(/交叉引用只有/);
  });
  it("重复定义拒(首用页定义是正路径,同一术语全稿只定义一次)", () => {
    const twice = v10Deck().replace("> 结论: 第 5 页的独立结论,长度合规", "> 结论: 第 5 页的独立结论,长度合规\n> 定义: 缓存断点=请求里最后一个不变块之后的位置");
    const deck = parseDeckMd(twice) as any;
    const pages = deck.chapters.flatMap((c: any) => c.pages);
    pages[0].definitions.push({ term: "缓存断点", def: "第一次定义" });
    pages[3].definitions.push({ term: "缓存断点", def: "第二次定义是复述撑行" });
    expect(validateDeck(deck).map((i) => i.msg).join("\n")).toMatch(/已定义过/);
  });
  it("页构成节奏:连续 ≥3 页 block 构成完全相同拒(模板感)", () => {
    const deck = parseDeckMd(v10Deck()) as any;
    const ch = deck.chapters[deck.chapters.length - 1];
 // 把收尾章做成 3 页完全同构成(bullets+table)
    ch.pages = [1, 2, 3].map((k) => ({
      title: `同构页${k}`,
      blocks: [
        { kind: "table", headers: ["甲", "乙"], rows: [["一", "二"], ["三", "四"]] },
        { kind: "bullets", items: [
          { lead: `构成${k}甲`, text: "说明写够长度保证字数下限不被密度门误伤并且互不重复的表述" },
          { lead: `构成${k}乙`, text: "第二条说明同样写够长度保证下限,内容互不重复避免判重门干扰" },
        ] },
      ],
      takeaway: `同构页${k} 的独立结论要写够八个字符以上的完整判断`,
      definitions: [], status: "", pageLayout: "", evidence: "09-harness-basics.md §9.1",
    }));
    expect(validateDeck(deck).map((i) => i.msg).join("\n")).toMatch(/页面构成完全相同/);
  });
});
