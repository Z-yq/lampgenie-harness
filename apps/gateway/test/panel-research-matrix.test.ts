/**
 * 白板渲染层三件(2026-10-25 任务 A/B/C)契约测试:
 *  A. 宽设计板列换行(面板侧裁决 cvFlowWrapWanted:refactor 不强扭 / page 不折 / 小板不折);
 *  B. research 板决策矩阵纯函数 researchMatrixRows(从真实面板内联脚本提取执行):
 *     候选×五维、flow 优先 summary 兜底、矩阵/结论注脚、无候选/无维度优雅降级;
 *  C. 窄视口/窄卡片板头余量(结构断言:板名 meta 去内联 nowrap、container query、
 *     浮窗头可换行——不启动浏览器也能守住回归)。
 * 页面函数从真实面板 HTML 提取(extractFn 花括号配平,与 panel-canvas-fixes.test.ts 同构)后 new Function 执行。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

const NL = String.fromCharCode(10);

/** 从面板 HTML 里切出顶层函数源码(花括号配平)。 */
function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}
/** 切出 `const NAME = [ ... ];`(BD_MX_DIMS 无嵌套 `];`,首个 `];` 即终点)。 */
function extractConstArray(html: string, name: string): string {
  const head = "const " + name + " = [";
  const i = html.indexOf(head);
  expect(i, "未找到常量 " + name).toBeGreaterThan(0);
  const end = html.indexOf("];", i);
  expect(end, "常量 " + name + " 未闭合").toBeGreaterThan(i);
  return html.slice(i, end + 2);
}

type MxCell = { text: string; source: "flow" | "summary" };
type MxRow = { id: string; label: string; summary: string; cells: Record<string, MxCell>; cellCount: number };
type MxRes = {
  ok: boolean;
  candidates: MxRow[];
  dims: { key: string; label: string }[];
  matrix: { id: string; label: string; summary: string } | null;
  conclusion: { id: string; label: string; summary: string } | null;
  filled: number;
  hint: string;
};

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 不需要 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

/** 只读真实 research 板的数据形态(不写盘、不依赖该文件存在——夹具内联在测试里)。 */
const researchDoc = {
  version: 1,
  taskId: "t-research",
  sessionId: "s-research",
  title: "board 校验规则引擎选型决策矩阵",
  status: "done",
  docKind: "design",
  boardType: "research",
  rev: 1,
  nodes: [
    {
      id: "r1-base", kind: "module", label: "现状:zod+手写门", group: "01 基线证据",
      summary: "结构校验 + 跨字段门", change: "keep",
      flow: [{ type: "step", text: "结构层:BoardDocZ zod schema(saveBoard 经 safeParse)" }],
    },
    {
      id: "r1-cand-ts", kind: "module", label: "候选A 手写TS", group: "02 候选评估", change: "keep",
      // 摘要:research 板常见的一行五维写法(无冒号也能解析)
      summary: "成本0;风险 strip/版本漂移;维护集中 schema;可测25+ tests;证据 zod 事故",
      flow: [
        { type: "step", text: "成本:迁移 0(现状即此);改 schema 即得 TS 类型" },
        { type: "step", text: "风险:zod 默认 strip 未知字段;运行中旧网关版本漂移" },
        { type: "step", text: "可维护性:schema 集中 index.ts;语义门散在 saveBoard" },
        { type: "step", text: "可测试性:vitest 直接 import schema 实例断言" },
      ],
    },
    {
      id: "r1-cand-json", kind: "module", label: "候选B AJV校验", group: "02 候选评估", change: "add",
      summary: "成本 861 行重写+类型生成;风险 低;证据 对照 strip 事故",
      flow: [
        // 嵌套 branch 里的文本也要能读(flow 递归展平)
        { type: "branch", text: "成本:861 行 schema 全量重写", then: [{ type: "step", text: "可测试性:AJV 编译缓存快" }] },
      ],
    },
    {
      id: "mx-matrix", kind: "section", label: "决策矩阵:候选×维度", group: "02 候选评估",
      summary: "A/B × 成本/风险/维护/证据", flow: [],
    },
    {
      id: "r1-verdict", kind: "decision", label: "结论:留zod混合", group: "03 结论",
      summary: "推荐 A;AJV 类型断裂/DSL 自研过重,均放弃", flow: [], phase: "P0",
    },
  ],
  edges: [],
};

describe("research 板决策矩阵 researchMatrixRows(纯函数)", () => {
  it("真实板形态:候选×五维,flow 优先/summary 兜底,结论与矩阵节点就位", async () => {
    await withPanel(7871, (html) => {
      const src = [
        extractConstArray(html, "BD_MX_DIMS"),
        extractFn(html, "bdMxStripLead"),
        extractFn(html, "bdMxSplitAny"),
        extractFn(html, "bdMxFlowTexts"),
        extractFn(html, "bdMxCellOf"),
        extractFn(html, "researchMatrixRows"),
      ].join(NL);
      const rows: (d: unknown) => MxRes = new Function(src + NL + "return researchMatrixRows;")() as (d: unknown) => MxRes;
      const r = rows(researchDoc);

      expect(r.ok).toBe(true);
      // 候选只认候选节点(基线/矩阵/结论都不是候选行)
      expect(r.candidates.map((c) => c.label)).toEqual(["候选A 手写TS", "候选B AJV校验"]);
      expect(r.dims.map((d) => d.label)).toEqual(["成本", "风险", "可维护性", "可测试性", "证据"]);

      const a = r.candidates[0]!;
      // flow 优先:成本/风险/可维护性/可测试性都来自「维度:文本」步骤
      expect(a.cells.cost).toMatchObject({ source: "flow" });
      expect(a.cells.cost!.text).toContain("迁移 0");
      expect(a.cells.risk!.text).toContain("zod 默认 strip");
      expect(a.cells.maint!.text).toContain("schema 集中");
      expect(a.cells.test!.text).toContain("vitest");
      // 证据只在 summary 里有 → summary 兜底
      expect(a.cells.evidence).toMatchObject({ source: "summary" });
      expect(a.cells.evidence!.text).toContain("zod 事故");
      expect(a.cellCount).toBe(5);

      const b = r.candidates[1]!;
      // 嵌套 branch 文本可读;summary 无冒号写法「成本 861 行…」也能解析
      expect(b.cells.cost!.text).toContain("861 行");
      expect(b.cells.test!.text).toContain("AJV 编译缓存快");
      expect(b.cells.risk!.text.length).toBeGreaterThan(0);
      expect(b.cells.evidence!.text).toContain("strip 事故");

      expect(r.matrix?.id).toBe("mx-matrix");
      expect(r.conclusion?.id).toBe("r1-verdict");
      expect(r.conclusion?.label).toContain("结论");
      expect(r.filled).toBeGreaterThanOrEqual(8);
      expect(r.hint).toBe(""); // 有数据不打扰
    });
  }, 30_000);

  it("优雅降级:无候选 → ok:false + 提示;候选无维度文本 → ok:true 但 hint 指路", async () => {
    await withPanel(7872, (html) => {
      const src = [
        extractConstArray(html, "BD_MX_DIMS"),
        extractFn(html, "bdMxStripLead"),
        extractFn(html, "bdMxSplitAny"),
        extractFn(html, "bdMxFlowTexts"),
        extractFn(html, "bdMxCellOf"),
        extractFn(html, "researchMatrixRows"),
      ].join(NL);
      const rows: (d: unknown) => MxRes = new Function(src + NL + "return researchMatrixRows;")() as (d: unknown) => MxRes;

      const none = rows({ nodes: [{ id: "x", label: "随便一个节点", summary: "无维度", flow: [] }] });
      expect(none.ok).toBe(false);
      expect(none.candidates).toEqual([]);
      expect(none.hint).toContain("未识别到候选");

      const empty = rows({ nodes: [{ id: "c", label: "候选C 空壳", summary: "只有一句描述", flow: [] }] });
      expect(empty.ok).toBe(true); // 表格仍可展示(单元格全是 —)
      expect(empty.candidates.length).toBe(1);
      expect(empty.candidates[0]!.cellCount).toBe(0);
      expect(empty.filled).toBe(0);
      expect(empty.hint).toContain("维度文本");

      // 空板不抛错
      const zero = rows({});
      expect(zero.ok).toBe(false);
      expect(zero.candidates).toEqual([]);
    });
  }, 30_000);
});

describe("白板渲染层结构契约(A 折行接入 / B 矩阵入口 / C 窄视口板头)", () => {
  it("A:面板按板型/规模裁决 wrap(refactor 双泳道不强扭,page 不折,小板不折),渲染与整理同口径", async () => {
    await withPanel(7873, (html) => {
      const fnSrc = extractFn(html, "cvFlowWrapWanted");
      const want: (doc: unknown, fdoc: unknown) => boolean =
        new Function(fnSrc + NL + "return cvFlowWrapWanted;")() as (doc: unknown, fdoc: unknown) => boolean;
      // refactor:现状/目标双泳道并排是核心语义 → 永不折
      expect(want({ boardType: "refactor", nodes: new Array(8).fill({ id: "n" }) }, null)).toBe(false);
      // page 板永远走页面语义布局
      expect(want({ docKind: "page", nodes: new Array(8).fill({ id: "n" }) }, null)).toBe(false);
      // 小板不折(横排读得下);≥6 才交给引擎 autoWrap
      expect(want({ nodes: new Array(5).fill({ id: "n" }) }, null)).toBe(false);
      expect(want({ nodes: new Array(6).fill({ id: "n" }) }, null)).toBe(true);
      // research 板照常折(决策矩阵是另一条腿,不互斥)
      expect(want({ boardType: "research", nodes: new Array(6).fill({ id: "n" }) }, null)).toBe(true);
      // 写者过滤后的子集按子集规模裁决
      expect(want({ nodes: new Array(20).fill({ id: "n" }) }, { nodes: new Array(4).fill({ id: "n" }) })).toBe(false);

      // 渲染与「整理」都走同一 opts(否则点整理会得到另一种排布)
      expect(html).toContain("autoWrap: cvFlowWrapWanted(doc, fdoc)");
      expect(html).toContain("autoWrap: cvFlowWrapWanted(t, t)");
      // 折行段框渲染/图例口径在场
      expect(html).toContain("lane.boxes && lane.boxes.length ? lane.boxes : [lane]");
      expect(html).toContain("cv-flow-wrap");
    });
  }, 30_000);

  it("B:research 板才出「矩阵」入口;表格容器/单元格点选/降级提示结构齐全", async () => {
    await withPanel(7874, (html) => {
      expect(html).toContain('(doc.boardType === "research" || doc.boardType === "matrix") && cvMatrixOn');
      expect(html).toContain('id="cvMatrixBtn"');
      expect(html).toContain('const mxProbe');
      expect(html).toContain('cvMatrixOn = !!(mxProbe && mxProbe.ok)'); // 有候选默认直接矩阵;无候选回画布
      expect(html).toContain("mxBtnEl.onclick = () => { cvMatrixOn = true;");
      expect(html).toContain('id="cvMxBack"');
      expect(html).toContain("data-mx-node=");
      expect(html).toContain("data-mx-dim=");
      expect(html).toContain("bd-mx-sel");
      expect(html).toContain("bd-mx-empty");
      // 无候选/无维度都有提示,不抛错
      expect(html).toContain("未识别到候选节点");
      expect(html).toContain("没有可识别的维度文本");
      // 纯 UI 态:不写板(函数体里不出现 board.save / boardDoc 赋值)
      const fnSrc = extractFn(html, "renderResearchMatrix");
      expect(fnSrc).not.toContain("board.save");
      expect(fnSrc).toContain("renderBoardDetail()");
    });
  }, 30_000);

  it("C:窄视口/窄卡片板头余量(板名 meta 去内联 nowrap + container query + 浮窗头换行)", async () => {
    await withPanel(7875, (html) => {
      // 板名 meta 不再内联 white-space:nowrap(它会把 320~620px 宽的卡片头部横穿)
      expect(html).not.toContain("style='position:absolute;left:10px;top:8px;white-space:nowrap'");
      expect(html).toContain("bd-meta-canvas");
      expect(html).toContain(".bd-meta-canvas{position:absolute;left:10px;top:8px;");
      expect(html).toContain("white-space:normal");
      // 按卡片自身宽度裁决(视口宽 != 卡片宽)
      expect(html).toContain("@container (max-width:720px)");
      expect(html).toContain("@container (max-width:760px)");
      expect(html).toContain("#view-board{container-type:inline-size}");
      expect(html).toContain(".bf-canvas{container-type:inline-size}");
      // 浮窗头:按钮可换行 + 板名/进度不被挤出卡片
      expect(html).toContain(".bf-head{flex-wrap:wrap;row-gap:4px}");
      expect(html).toContain(".bf-spacer{flex:1 1 8px;min-width:0}");
      expect(html).toContain('<span class="bf-spacer"></span>');
      expect(html).toContain(".bf-prog{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
    });
  }, 30_000);
});

describe("research 矩阵硬规则:权重/可信度/未知", () => {
  it("维度权重可复算、单元格可信度、空证据显式未知", async () => {
    await withPanel(7875, async (html) => {
      const src = [
        extractConstArray(html, "BD_MX_DIMS"),
        extractFn(html, "bdMxStripLead"),
        extractFn(html, "bdMxSplitAny"),
        extractFn(html, "bdMxFlowTexts"),
        extractFn(html, "bdMxCellOf"),
        extractFn(html, "researchMatrixRows"),
      ].join(NL);
      const rows: (d: unknown) => MxRes & { dims: { key: string; label: string; weight: number | null }[]; weightsKnown: number } =
        new Function(src + NL + "return researchMatrixRows;")() as never;
      const doc = {
        nodes: [
          { id: "mx-matrix", kind: "section", label: "决策矩阵:候选×维度", summary: "权重:成本30% 风险30% 可维护性20% 可测试性10% 证据10%", flow: [] },
          { id: "a", label: "候选A", summary: "成本 10 [高];风险 2 [中];可维护性 集中;可测试性 vitest;证据 file:a.ts", flow: [] },
        ],
        edges: [],
      };
      const r = rows(doc);
      expect(r.weightsKnown).toBe(5);
      expect(r.dims.find((d) => d.key === "cost")!.weight).toBe(30);
      const a = r.candidates[0]!;
      expect(a.cells.cost!.confidence).toBe("高");
      expect(a.cells.risk!.confidence).toBe("中");
      expect(html).toContain("bd-mx-cell empty unknown");
      expect(html).toContain("bd-mx-weight");
      expect(html).toContain("bd-mx-conf");
      expect(html).toContain("未知");
    });
  }, 30_000);
});
