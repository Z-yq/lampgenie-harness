/**
 * 对话渲染 P0-1/P0-2/P0-3/P0-4/P0-5/P1-4 的纯函数单测(无浏览器)。
 * 口径同 panel-collapse-state.test.ts:面板 UI 全在分片源码里,这里用 PANEL_SRC 切真实代码段、
 * 桩求值(不复制实现),再断行为——纯逻辑(TSV/CSV、错误行、动词表、折叠判定、状态徽标)在 node 里
 * 就能锁死,不必起 chromium;浏览器/DOM 层由 chat-render-p0.spec.cjs 覆盖。
 */
import { describe, it, expect } from "vitest";
import { PANEL_SRC } from "./panel-source.js";

/** 从聚合源码切一个顶层函数的完整源码(按花括号配平;跳过字符串字面量与行注释)。 */
function sliceFn(name: string): string {
  const marker = "function " + name + "(";
  const start = PANEL_SRC.indexOf(marker);
  if (start < 0) throw new Error("PANEL_SRC 中未找到函数:" + name);
  let depth = 0;
  let quote = "";
  for (let i = start; i < PANEL_SRC.length; i++) {
    const c = PANEL_SRC.charAt(i);
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && PANEL_SRC.charAt(i + 1) === "/") { const nl = PANEL_SRC.indexOf("\n", i); i = nl < 0 ? PANEL_SRC.length : nl; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return PANEL_SRC.slice(start, i + 1);
    }
  }
  throw new Error("函数未闭合:" + name);
}

const FN_NAMES = [
  "roundOpenAll", "roundUserOpen", "roundRemember", "roundShouldOpen",
  "verbOf", "verbIcon", "verbSvg", "errLineRe",
  "rgPlain", "roundIsProc", "roundCountToolCards", "rgCut", "rgSum", "rgFirstNum",
  "roundStepState", "roundStepLabel", "roundGroupHtml",
  "tblCellText", "tableToTsv", "tableToCsv", "csvSlug", "mdBadgeHtml",
];

const SRC = [
  "let roundOpenMap = null;",
  'const ROUND_LS = "genie.round.open";',
  'let runLineVerb = "";',
  ...FN_NAMES.map((n) => sliceFn(n)),
].join("\n");

const EXPORTS = "return {" + FN_NAMES.join(",") + "};";
// eslint-disable-next-line no-new-func
const FACTORY = new Function("localStorage", "ic", "esc", SRC + "\n" + EXPORTS) as (
  ls: unknown,
  ic: (name: string, cls?: string) => string,
  esc: (s: unknown) => string,
) => Record<string, any>;

function escStub(s: unknown): string {
  return String(s == null ? "" : s)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;");
}

function memLs() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => (m.has(k) ? String(m.get(k)) : null),
    setItem: (k: string, v: unknown) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

/** 每次 load 一个全新闭包(roundOpenMap/localStorage 不串味)。 */
function load() {
  return FACTORY(memLs(), () => "<svg></svg>", escStub);
}

/** tableToTsv/tableToCsv 吃的假表元素:querySelectorAll("tr") → 行,行内 querySelectorAll("th,td") → 格。 */
function fakeTable(rows: string[][]) {
  return {
    querySelectorAll: (sel: string) => {
      if (sel !== "tr") return [];
      return rows.map((cells) => ({
        querySelectorAll: (s: string) => (s === "th,td" ? cells.map((t) => ({ textContent: t })) : []),
      }));
    },
  };
}

describe(" P0/P1 纯函数契约(源码切片桩求值)", () => {
  it("P0-5 verbOf 四态文案与语义色类", () => {
    const { verbOf } = load();
    expect(verbOf("run")).toEqual({ t: "正在执行", i: "spin", c: "v-run" });
    expect(verbOf("wait", "T1")).toEqual({ t: "任务输出 T1 等待超时", i: "doc", c: "v-wait" });
    expect(verbOf("fail")).toEqual({ t: "失败", i: "fail", c: "v-fail" });
    expect(verbOf("done")).toEqual({ t: "已执行", i: "doc", c: "v-done" });
    expect(verbOf(undefined).c, "缺省按已完成").toBe("v-done");
  });

  it("P0-4 errLineRe 只标错误行(<error>/超时/Error: 开头)", () => {
    const { errLineRe } = load();
    expect(errLineRe("<error>boom")).toBe("code-err-line");
    expect(errLineRe("<error code=1>boom")).toBe("code-err-line");
    expect(errLineRe("Command timed out after 600s")).toBe("code-err-line");
    expect(errLineRe("Error: nope")).toBe("code-err-line");
    expect(errLineRe("all good, no error here")).toBe("");
    expect(errLineRe("   ")).toBe("");
  });

  it("P0-5 roundStepState/roundStepLabel 三态 + 思考段措辞", () => {
    const { roundStepState, roundStepLabel } = load();
    const runTool = '<details data-det-key="tool-call:c1"><summary><span class="tc-state tc-run">运行中</span>bash</summary></details>';
    const failTool = '<details data-det-key="tool-call:c2"><summary><span class="tc-state tc-err">失败</span>bash</summary></details>';
    const doneTool = '<details data-det-key="tool-call:c3"><summary><span class="tc-state tc-ok">完成</span>read_file</summary></details>';
    const waitLine = '<div class="sys-line">任务输出 T9 等待超时</div>';
    const think = '<div class="think-card"><summary>思考 · 12 秒</summary></div>';
    expect(roundStepState(runTool)).toBe("run");
    expect(roundStepLabel(runTool)).toBe("正在执行 bash");
    expect(roundStepState(failTool)).toBe("fail");
    expect(roundStepLabel(failTool)).toBe("失败 bash");
    expect(roundStepState(doneTool)).toBe("done");
    expect(roundStepLabel(doneTool)).toBe("已执行 read_file");
    expect(roundStepState(waitLine)).toBe("wait");
    expect(roundStepLabel(waitLine)).toBe("任务输出 T9 等待超时");
    expect(roundStepLabel(think)).toBe("思考 持续了 12 秒");
    expect(roundStepState(think)).toBe("done");
  });

  it("P0-3 roundShouldOpen:终态收起,手动展开过则保持", () => {
    const { roundShouldOpen, roundRemember } = load();
    expect(roundShouldOpen("round:a", true), "terminal 且未手动展开").toBe(false);
    expect(roundShouldOpen("round:a", false), "非终态默认也收起").toBe(false);
    roundRemember("round:a", true);
    expect(roundShouldOpen("round:a", true), "手动展开过的终态不自动收起").toBe(true);
    roundRemember("round:a", false);
    expect(roundShouldOpen("round:a", true), "手动收起后回到收起").toBe(false);
    roundRemember("", true); // 空 key 不写
    expect(roundShouldOpen("", true)).toBe(false);
  });

  it("P0-2 roundGroupHtml:摘要计命令数、行数、默认收起/记忆展开", () => {
    const { roundGroupHtml, roundRemember } = load();
    const seg = [
      '<div class="tool-card" data-det-key="tool-call:a"></div>',
      '<div class="tool-card" data-det-key="tool-call:b"></div>',
      '<div class="think-card"><summary>思考 · 5 秒</summary></div>',
    ];
    const html = roundGroupHtml(seg.slice(), "round:g1", true);
    expect(html).toContain('class="round-group"');
    expect(html.indexOf("已执行 2 命令")).toBeGreaterThan(0);
    expect(html.indexOf("3 步")).toBeGreaterThan(0);
    expect(/\sopen/.test(html), "未记忆 + terminal → 无 open").toBe(false);
    expect(html.split('class="round-step"').length - 1, "每段一个 round-step").toBe(3);
    expect(html).toContain("思考 持续了 5 秒");
    roundRemember("round:g1", true);
    const html2 = roundGroupHtml(seg.slice(), "round:g1", true);
    expect(/class="round-group"[^>]*\sopen/.test(html2), "记忆展开 → 带 open").toBe(true);
  });

  it("P0-1 tableToTsv/tableToCsv:空表、逗号引号换行、单元格内换行折叠", () => {
    const { tableToTsv, tableToCsv } = load();
    expect(tableToTsv(fakeTable([]))).toBe("");
    expect(tableToCsv(fakeTable([]))).toBe("");
    const t = fakeTable([
      ["名称", "值", "说明"],
      ["x,1", 'he said "hi"', "l1\nl2"],
    ]);
    expect(tableToTsv(t)).toBe('名称\t值\t说明\nx,1\the said "hi"\tl1 l2');
    expect(tableToCsv(t)).toBe('名称,值,说明\n"x,1","he said ""hi""",l1 l2');
 // 空单元格也保留列位(不塌列)
    expect(tableToTsv(fakeTable([["a", "", "c"]]))).toBe("a\t\tc");
    expect(tableToCsv(fakeTable([["a", "", "c"]]))).toBe("a,,c");
  });

  it("P0-1 csvSlug:表头首格前 8 字 + 非法字符换 - + 空则 table", () => {
    const { csvSlug } = load();
    expect(csvSlug("名称/值:测试*表")).toBe("名称-值-测试-");
    expect(csvSlug("中文表头列名甲乙丙丁")).toBe("中文表头列名甲乙");
    expect(csvSlug("a\tb"), "控白换 -").toBe("a-b");
    expect(csvSlug("   ")).toBe("table");
    expect(csvSlug(null)).toBe("table");
  });

  it("P1-4 mdBadgeHtml:整格状态词 → st-*,长句原样(不全文替换)", () => {
    const { mdBadgeHtml } = load();
    expect(mdBadgeHtml("✅")).toBe('<span class="md-badge st-ok" data-md-badge="1">✅</span>');
    expect(mdBadgeHtml("⚠️"), "变体选择符剥掉后同义").toContain("st-warn");
    expect(mdBadgeHtml("失败")).toContain("st-err");
    expect(mdBadgeHtml("运行中")).toContain("st-run");
    expect(mdBadgeHtml(" 待验 "), "两端空白先 trim").toContain("st-idle");
    expect(mdBadgeHtml("这是一句很长的话,里面提到完成")).toBe("");
    expect(mdBadgeHtml("")).toBe("");
  });
});