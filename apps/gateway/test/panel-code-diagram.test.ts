/** code 板工程师图形态(2026-10-26):C4 类型/技术行、容器边界、decision/start/end 形状、
 *  call/data/verify 线型与 C4 图例。只做源码契约断言;真实渲染走 Playwright 证据。 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { servePanel } from "../src/panel.js";

const src = readFileSync(join(process.cwd(), "src", "panel.ts"), "utf-8");

describe("code 板工程师图形态", () => {
  it("code 分支启用 cv-code-world/cv-code-node，并解析 [Component: tech] 摘要", () => {
    // 2026-10-26 测试类型接入 code flow:test 板带 start/end 复用同一套工程师 flow 渲染
    expect(src).toContain('const wantTestFlow = cvBoardType === "test"');
    // 2026-10-29 perf 板与 code/test 同列(用户:「性能优化的 flow 还差点意思」):白名单三型同列,
    // 各型进门条件不变(code 恒进 / test 要 start-end / perf 走 cvCodeFlowWanted 同口径)。
    expect(src).toContain('const cvCodeInfo = (cvBoardType === "code" || cvBoardType === "test" || cvBoardType === "perf")');
    expect(src).toContain('const wantPerfFlow = cvBoardType === "perf" && cvCodeFlowWanted(doc.nodes || [])');
    expect(src).toContain('(cvBoardType === "code" || wantTestFlow || wantPerfFlow) && !isPageDoc');
    expect(src).toContain('" cv-code-world"');
    expect(src).toContain('const codeCls = c4 ? " cv-code-node" : ""');
    expect(src).toContain("function cvC4Info(n)");
    expect(src).toContain("function cvC4Html(n)");
    expect(src).toContain('cv-c4-kind');
    expect(src).toContain('cv-c4-tech');
  });

  it("C4 类型/形状:Person/System/Container/Component/Store/Decision/Start/End + 线型", () => {
    for (const s of [
      'c4-person', 'c4-system', 'c4-container', 'c4-component', 'c4-store', 'c4-decision',
      'k-decision', 'k-start', 'k-end', 'k-agent', 'k-io',
      '.cv-code-world .bf-cv-edges path.bfe-call', '.cv-code-world .bf-cv-edges path.bfe-data',
      '.cv-code-world .bf-cv-edges path.bfe-verify', 'cv-legend-code',
    ]) expect(src, s).toContain(s);
  });

  it("code 板只出 C4 图例，不与 flow/关系图例叠底", () => {
    expect(src).toContain("cvFlowInfo && !cvCodeInfo");
    expect(src).toContain("relLegend && !cvCodeInfo");
    expect(src).toContain("cv-legend-code");
  });

  it("可读性:现状基线+变更主图、验收/风险侧栏、大卡、默认 90% 下限", () => {
    expect(src).toContain("function cvCodeSide(n)");
    expect(src).toContain("function cvCodeSideHtml(nodes)");
    expect(src).toContain("cv-code-side");
    expect(src).toContain("cv-code-side-sec");
    expect(src).toContain("cvCodeSideNodes");
    expect(src).toContain("__cv_current");
    expect(src).toContain("现状链路(基线)");
    expect(src).toContain("cv-code-baseline-tag");
    expect(src).toContain("wrap: cvCodeInfo ? 3 : undefined");
    expect(src).toContain("nodeW: tprof ? (cvCodeInfo ? 260 : 228)");
    expect(src).toContain("cvActiveDoc.boardType === \"code\") ? 0.9");
  });

  it("flow 形态:正交连线(横平竖直),decision 端口落菱形顶点,回边绕底部", () => {
    expect(src).toContain("function cvCodeOrthoRoute(a, b, sa, sb, kindA, kindB, bounds, ei)");
    expect(src).toContain('return (i ? "L " : "M ")');
    expect(src).toContain("fl.codeFlow = !!cvCodeFlowMode");
    expect(src).toContain("const ortho = isDocsDeckEdges || !!(pgInfo && pgInfo.codeFlow && isFlow)");
    // decision 菱形 132×132 居中:端口必须按内框算,不能按 260×176 卡片外框
    expect(src).toContain('if (nk !== "decision") return { x: p.x, y: p.y, w: w, h: h }');
    expect(src).toContain("Math.min(132, w - 6)");
    // 回边/左向边绕世界底部
    expect(src).toContain("bounds.y + bounds.h + 24");
    // code flow 主线实心,不闪动(step-1010:主线色改走 --bcv-flow-main 令牌,字面值降级为 var() 兜底)
    expect(src).toContain(".cv-code-world .bf-cv-edges path.bfe-main{stroke:var(--bcv-flow-main,#4fbf7a)!important");
    expect(src).toContain("stroke-dasharray:none!important;animation:none!important");
  });

  it("flow 形态:方法/阶段分组实色容器 + 卡片内代码行(flow 步骤)", () => {
    expect(src).toContain("const CV_CODE_LANE_HUES");
    expect(src).toContain('codeLane ? " cv-code-lane" : ""');
    expect(src).toContain("function cvCodeLines(n)");
    expect(src).toContain("function cvCodeFlowBodyHtml(n, c4)");
    // flow 侧栏只剥离 note/aggregate/io;「安装回滚」end 必须留在主图(否则 decision 否分支消失)
    expect(src).toContain("function cvCodeFlowSide(n)");
    expect(src).toContain('if (k === "start" || k === "end" || k === "decision") return false;');
    expect(src).toContain("mainNodes = fdoc0.nodes.filter((n) => !cvCodeFlowSide(n))");
    // 单写者板不显示 [pdhay] 前缀
    expect(src).toContain("const laneLabelOf = (label)");
    expect(src).toContain("esc(laneLabelOf(lane.label))");
    expect(src).toContain('cvFlowInfo && cvFlowInfo.codeFlow');
    expect(src).toContain("cv-code-lines");
    expect(src).toContain("cvCodeFlowBodyHtml(n, c4)");
    // 步骤行数/字数上限与 planner 技能口径一致
    expect(src).toContain("out.length < 4");
    expect(src).toContain("slice(0, 58)");
    // code flow 卡片更高(176)容纳代码行
    expect(src).toContain("cvCodeFlowMode ? 176");
  });

  it("flow 判定放宽:无 start/end 也能进 codeFlow(decision / ≥50% flow 步骤)", async () => {
    // 判据(与 assets/board-type-profile.js 的 codeFlowWanted 同口径):
    // ①有 start/end ②有 decision ③步骤节点 ≥50% 带 flow 行
    expect(src).toContain("const cvCodeFlowMode = !!cvCodeInfo && cvCodeFlowWanted(fdoc0.nodes)");
    expect(src).toContain("function cvCodeFlowWanted(nodes)");
    expect(src).toContain("withFlow * 2 >= steps.length");
    expect(src).toContain("fl.codeFlow = !!cvCodeFlowMode");
    expect(src).toContain("preserveLanes: doc.boardType === \"refactor\" || cvCodeFlowMode");
    const f = await flowWantedFn();
    // (a) 只有模块 + decision、没有 start/end 的 code 板 → 进 flow 形态
    expect(f([{ kind: "module" }, { kind: "decision" }])).toBe(true);
    // 步骤节点半数带 flow 行也算「想画逻辑」
    expect(f([{ kind: "function", flow: [{ type: "step", text: "a" }] }, { kind: "function", flow: [] }])).toBe(true);
    expect(f([{ kind: "function", flow: [{ type: "step", text: "a" }] }, { kind: "function", flow: [] }, { kind: "function", flow: [] }])).toBe(false);
    // 变更契约板(无 flow 步骤、无 decision/start/end)行为不变
    expect(f([{ kind: "module", flow: [] }, { kind: "function", flow: [] }])).toBe(false);
    expect(f([])).toBe(false);
  }, 30_000);

  it("perf 板接入 code flow:与 code 同列,perf 流程图判定走同一 cvCodeFlowWanted", async () => {
    // 源码判定:perf 与 code/test 同列进工程师 flow 渲染;perf 进门条件是 codeFlowWanted 同口径
    expect(src).toContain("const wantPerfFlow = cvBoardType === \"perf\" && cvCodeFlowWanted(doc.nodes || [])");
    expect(src).toContain("const cvCodeFlowMode = !!cvCodeInfo && cvCodeFlowWanted(fdoc0.nodes)");
    const f = await flowWantedFn();
    // perf 板真形态:start + 采样基线 + 定位瓶颈 + 改动 + 复测 + decision + end(步骤带 flow 行)
    const perfBoard = [
      { kind: "start", label: "触发:GET /api/list" },
      { kind: "function", label: "采样基线 bench", flow: [{ type: "step", text: "bench 10 次取 P95" }] },
      { kind: "function", label: "定位瓶颈", flow: [{ type: "step", text: "profile → opts 深比较占 62%" }] },
      { kind: "function", label: "改动:浅比较快路", flow: [{ type: "step", text: "if (a === b) return true" }] },
      { kind: "function", label: "复测", flow: [{ type: "step", text: "同口径复跑 bench" }] },
      { kind: "decision", label: "P95 ≤ 300ms?" },
      { kind: "end", label: "收工:门禁固化" },
    ];
    expect(f(perfBoard)).toBe(true);
    // 旧 perf 三卡板(无 start/end/decision/flow 行)→ 不进 flow 形态,渲染逐字不变
    expect(f([
      { kind: "module", label: "基线 P95 850ms", flow: [] },
      { kind: "module", label: "热点函数", flow: [] },
      { kind: "module", label: "灰度门禁", flow: [] },
    ])).toBe(false);
  }, 30_000);

  it("flow 形态走正交路由:cvCodeOrthoRoute 只出 M/L 折线,无贝塞尔 C/Q", async () => {
    const r = await orthoFn();
    // decision(菱形 132×132 内框)→ 下方步骤卡:竖线直下
    const down = r({ x: 100, y: 0 }, { x: 100, y: 400 }, { w: 260, h: 176 }, { w: 260, h: 176 }, "decision", "function", { x: 0, y: 0, w: 800, h: 900 }, 0);
    expect(down.d).toMatch(/^M -?\d+ -?\d+( L -?\d+ -?\d+)+$/);
    expect(down.d).not.toContain("C ");
    // 跨泳道分支(是/否)→ 折线拐直角
    const diag = r({ x: 100, y: 0 }, { x: 560, y: 320 }, { w: 260, h: 176 }, { w: 260, h: 176 }, "decision", "function", { x: 0, y: 0, w: 900, h: 900 }, 1);
    expect(diag.d).toMatch(/^M -?\d+ -?\d+( L -?\d+ -?\d+)+$/);
    expect(diag.d).not.toContain("C ");
    expect(diag.d).not.toContain("Q ");
  }, 30_000);

  it("仓库关系上屏:卡脚 .cv-file-foot 出 targets 文件名 + 变更徽标", async () => {
    expect(src).toContain("function cvFileFootHtml(n)");
    expect(src).toContain("function cvFileNameOf(t)");
    expect(src).toContain(".cv-file-foot{");
    expect(src).toContain(".cv-file-name{");
    // 卡内接线:只在 code flow 卡上出(其它板型/契约板逐字不变)
    expect(src).toContain('cvCodeInfo && cvFlowInfo && cvFlowInfo.codeFlow ? cvFileFootHtml(n) : ""');
    const g = await fileFootFn();
    expect(g.name("apps/gateway/src/panel.ts")).toBe("src/panel.ts");
    expect(g.name("panel.ts")).toBe("panel.ts");
    expect(g.name("a/b/c/d/e-very-long-file-name-for-mid-ellipsis.ts").length).toBeLessThan(40);
    expect(g.name("")).toBe("");
    const foot = g.foot({ id: "n1", change: "modify", targets: ["apps/gateway/src/panel.ts", "apps/gateway/src/assets/board-type-profile.js", "docs/x.md"] });
    expect(foot).toContain('class="cv-file-foot"');
    expect(foot).toContain('class="cv-file-name"');
    expect(foot).toContain("board-type-profile.js");
    expect(foot).toContain("cv-chg");
    // 2026-10-29 口径同步:code flow 用 CV_CHG_LABEL(modify=「改」),不再用面板通用 BD_CHANGE 的「修改」
    expect(foot).toContain("改");
    expect(foot).not.toContain("修改");
    expect(foot).toContain("+1");
    // 两个文件名之间有可见分隔符(治「a.tsb.ts」粘连)
    expect(foot).toContain('class="cv-file-sep"');
    expect(g.foot({ id: "n3", change: "keep", targets: ["apps/gateway/src/panel.ts"] })).toContain("复用");
    // 无 targets → 空串(调用方退回原有页脚)
    expect(g.foot({ id: "n2", change: "add", targets: [] })).toBe("");
  }, 30_000);

  it("2026-11-05「看得懂」:卡脚出符号锚 chip(name@basename:line)+ 板头层统计", async () => {
    // (a) 源码层:符号 chip 类与接线在
    expect(src).toContain(".cv-sym-name");
    expect(src).toContain("代码锚");
    expect(src).toContain("function cvLayerStats(doc)");
    expect(src).toContain("function cvLayerStats(doc)"); // 板头统计实时算,不写死数字
    expect(src).toContain("function cvDefaultBoardId(items)");
    // 卡高是 176 的布局常量:chip 行不得换行(靠 nowrap + ellipsis,不新增第二行)
    const symCss = src.slice(src.indexOf(".cv-sym-name{"), src.indexOf(".cv-sym-name{") + 420);
    expect(symCss).toContain("white-space:nowrap");
    expect(symCss).toContain("text-overflow:ellipsis");
    // (b) 真实形态节点:targets 纯路径 + symbolRef{name,file,line}
    const g = await fileFootFn();
    const node = {
      id: "s9", change: "modify",
      targets: ["apps/gateway/src/task-manager.ts"],
      symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 },
    };
    const foot = g.foot(node);
    expect(foot).toContain("task-manager.ts");
    expect(foot).toContain("TaskSupervisor.submit@task-manager.ts:60");
    expect(foot).toContain('data-cvsym="TaskSupervisor.submit"');
    // 悬浮给全路径 + 行号 + 符号名
    expect(foot).toContain("apps/gateway/src/task-manager.ts:60 · TaskSupervisor.submit");
    // 无 symbolRef → 不出符号 chip(旧卡视觉只多 title 信息)
    expect(g.foot({ id: "x1", change: "keep", targets: ["apps/gateway/src/task-manager.ts"] })).not.toContain(".cv-sym-name");
    expect(g.foot({ id: "x1", change: "keep", targets: ["apps/gateway/src/task-manager.ts"] })).not.toContain("cv-sym-name");
    // 两者都无 → 空串(调用方退回原卡脚)
    expect(g.foot({ id: "x2", change: "add" })).toBe("");
    // 只有 symbolRef 没有 targets 也要出(锚信息优先于文件清单)
    const onlySym = g.foot({ id: "x3", change: "add", symbolRef: { name: "f", file: "a/b/c.ts", line: 7 } });
    expect(onlySym).toContain("f@c.ts:7");
  }, 30_000);

  it("2026-11-05「看得懂」:层统计口径(排除 ph-*/合成基线节点)", async () => {
    const f = await layerStatsFn();
    const doc = {
      nodes: [
        { id: "a", change: "keep", targets: ["x/y.ts"] },
        { id: "b", change: "modify", symbolRef: { name: "n", file: "x/y.ts", line: 1 } },
        { id: "c" }, // change 缺失 = 现状
        { id: "d", change: "add" }, // 无锚
        { id: "ph-1", change: "keep" }, // 阶段卡:不计
        { id: "__cv_current", change: "keep", targets: [] }, // 合成基线:不计
      ],
    };
    expect(f(doc)).toEqual({ keep: 2, chg: 2, anchor: 2, total: 4 });
    expect(f({ nodes: [] })).toEqual({ keep: 0, chg: 0, anchor: 0, total: 0 });
  }, 30_000);

  it("start/end 药丸与 decision 菱形补 change 徽标(小号、绝对定位不撑破几何)", async () => {
    expect(src).toContain('const chgPill = cvChangeBadge(n, "cv-chg", true)');
    expect(src).toContain("function cvChangeBadge(n, extra, ctrlOnly)");
    // 药丸/菱形都挂上徽标
    const pillAt = src.indexOf("cv-code-pill");
    expect(pillAt).toBeGreaterThan(0);
    expect(src).toContain("chgPill + '<span class=\"cv-pill-label\">'");
    expect(src).toContain("chgPill + '<div class=\"cv-dia\"></div>");
    // 徽标走绝对定位小号,不参与药丸/菱形列布局预算
    expect(src).toContain(".cv-code-pill .bd-tag.cv-chg{position:absolute");
    expect(src).toContain(".cv-decision-diamond .bd-tag.cv-chg{position:absolute");
    const b = await changeBadgeFn();
    expect(b({ change: "add" }, "cv-chg")).toContain("cv-chg");
    expect(b({ change: "add" }, "cv-chg")).toContain("新增");
    // 2026-10-29 口径:code flow 徽标用 CV_CHG_LABEL(delete=「删」/keep=「复用」),不是 BD_CHANGE 的「删除/涉及」
    expect(b({ change: "delete" }, "cv-chg")).toContain(">删<");
    expect(b({ change: "keep" }, "cv-chg")).toContain("复用");
    expect(b({ change: "keep" }, "cv-chg")).not.toContain("涉及");
    expect(b({}, "cv-chg")).toBe("");
    // 药丸/菱形(ctrlOnly=true):keep 不出徽标——触发/判断/出口点标「复用」会被读成「这个控制点要改」
    expect(b({ change: "keep" }, "cv-chg", true)).toBe("");
    expect(b({ change: "add" }, "cv-chg", true)).toContain("新增");
    expect(b({ change: "modify" }, "cv-chg", true)).toContain("改");
  }, 30_000);

  it("2026-10-29 逻辑层口径:modify/delete 卡加一行 .cv-before(「现状:…」),keep/add 不出", async () => {
    // 渲染函数存在 + 卡内接入位置(代码框下方、卡脚 cv-file-foot 之上)
    expect(src).toContain("function cvBeforeHtml(n)");
    expect(src).toContain("cvBeforeHtml(n) : \"\") +\n      // 2026-10-29 仓库关系上屏");
    // 带 before 的卡把代码行显示从 4 降到 3(卡高 176 不变,before 不挤掉 flow 行;cvCodeLines 上限不动)
    expect(src).toContain("cvCodeLines(n).slice(0, cvBeforeHtml(n) ? 3 : 4)");
    // 样式:字号 ≥10px、颜色走已有令牌
    expect(src).toContain(".cv-before{margin:3px 10px 0");
    expect(src).toContain("font-size:11px;line-height:15px;color:var(--bcv-side-fg-dim)");
    const f = await beforeFn();
    // modify 有值
    const mod = f({ id: "n1", change: "modify", before: "直接 return null" });
    expect(mod).toContain('class="cv-before"');
    expect(mod).toContain("现状:直接 return null");
    // keep / add 空串;无 before 空串
    expect(f({ id: "n2", change: "keep", before: "直接 return null" })).toBe("");
    expect(f({ id: "n3", change: "add", before: "直接 return null" })).toBe("");
    expect(f({ id: "n4", change: "modify", before: "   " })).toBe("");
    expect(f({ id: "n5", change: "delete", before: "走缓存直读" })).toContain("现状:走缓存直读");
    // 长度截断:正文 ≤48 字,截断处以 … 收尾;多行折成一行
    const long = f({ id: "n6", change: "modify", before: "读".repeat(80) });
    const inner = long.slice(long.indexOf(">") + 1, long.indexOf("</div>"));
    expect(inner.slice(0, 3)).toBe("现状:");
    expect(inner.length).toBeLessThanOrEqual(3 + 48);
    expect(inner).toContain("…");
    const multi = f({ id: "n7", change: "modify", before: "旧:两步\n先查\n再写" });
    expect(multi.slice(multi.indexOf(">") + 1, multi.indexOf("</div>"))).toBe("现状:旧:两步 先查 再写");
  }, 30_000);
});

describe("code flow 测试文件锚点剥到侧栏(2026-10-29)", () => {
  it("测试路径 + 无调用形 flow 的 function/module/io/tool 剥侧栏;decision/start/普通源码卡留主图", async () => {
    // 源码契约:判定谓词存在且被 cvCodeFlowSide 在 note/aggregate/io 规则之前接入
    expect(src).toContain("function cvCodeFlowTestAnchor(n)");
    expect(src).toContain("if (cvCodeFlowTestAnchor(n)) return true;");
    const f = await flowSideFn();
    // 正例:function + 测试路径 + 空 flow(实测 tm-t1「board-read 单测」形态)
    expect(f({ kind: "function", targets: ["apps/gateway/test/board-read-dedup.test.ts"], flow: [] })).toBe(true);
    // 正例:module + __tests__ + 有 flow 但不是函数调用形(断言式文本)
    expect(f({ kind: "module", symbolRef: { file: "src/__tests__/x.ts" }, flow: [{ type: "step", text: "expect(a).toBe(1)" }] })).toBe(true);
    // 正例:fileRef 走 tests/ 目录 + tool/io kind 同样剥
    expect(f({ kind: "io", fileRef: "tests/cli.spec.ts" })).toBe(true);
    expect(f({ kind: "tool", targets: ["packages/gateway/__tests__/run.ts"] })).toBe(true);
    // 反例:流程三态永不剥(decision 出边否则会消失)
    expect(f({ kind: "decision", targets: ["a/b.test.ts"] })).toBe(false);
    expect(f({ kind: "start", targets: ["a/b.test.ts"] })).toBe(false);
    expect(f({ kind: "end", targets: ["a/b.test.ts"] })).toBe(false);
    // 反例:有真实函数调用形 → 画的是被测逻辑本身,留主图
    expect(f({ kind: "function", targets: ["apps/gateway/test/x.test.ts"], flow: [{ type: "step", text: "runSuite(name)" }] })).toBe(false);
    // 反例:普通源码卡
    expect(f({ kind: "function", targets: ["apps/gateway/src/panel.ts"] })).toBe(false);
    // 反例:非测试路径的 note 仍由文字规则管(此处无侧栏词 → false,证明新规则不误伤)
    expect(f({ kind: "note", targets: ["apps/gateway/src/panel.ts"], label: "读超时那行" })).toBe(false);
  }, 30_000);
});
/** 从真实面板 HTML 里取函数源码 + 用 new Function 跑语义(不启浏览器)。 */
let panelHtmlCache = "";
async function panelHtml(): Promise<string> {
  if (panelHtmlCache) return panelHtmlCache;
  const srv = servePanel(7893, () => { /* 纯静态:不接 WS */ });
  try {
    const res = await fetch("http://127.0.0.1:7893/");
    expect(res.status).toBe(200);
    panelHtmlCache = await res.text();
    return panelHtmlCache;
  } finally { await srv.close(); }
}
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
async function orthoFn(): Promise<(a: unknown, b: unknown, sa: unknown, sb: unknown, ka: string, kb: string, bounds: unknown, ei: number) => { d: string }> {
  const html = await panelHtml();
  const src = extractFn(html, "cvCodeOrthoRoute");
  return new Function(src + String.fromCharCode(10) + "return cvCodeOrthoRoute;")() as (a: unknown, b: unknown, sa: unknown, sb: unknown, ka: string, kb: string, bounds: unknown, ei: number) => { d: string };
}
async function flowWantedFn(): Promise<(nodes: unknown[]) => boolean> {
  const html = await panelHtml();
  const src = extractFn(html, "cvCodeFlowWanted");
  return new Function(src + String.fromCharCode(10) + "return cvCodeFlowWanted;")() as (nodes: unknown[]) => boolean;
}
async function fileFootFn(): Promise<{ name: (t: unknown) => string; foot: (n: unknown) => string }> {
  const html = await panelHtml();
  const src = [
    extractFn(html, "cvFileNameOf"), extractFn(html, "cvChangeBadge"),
    extractFn(html, "cvTargetTitle"), extractFn(html, "cvFileBaseOf"), extractFn(html, "cvFileFootHtml"),
    // 2026-11-05:E1 回归暴露——cvFileFootHtml 新增 targets 悬浮全文(cvTargetTitle)与 symbolRef chip
    // basename(cvFileBaseOf)两个同文件依赖;沙箱没抽它们就 ReferenceError(不是功能坏了)。
    extractFn(html, "cvTargetTitle"), extractFn(html, "cvFileBaseOf"),
  ].join(String.fromCharCode(10));
  return new Function("esc", "CV_CHG_LABEL", src + String.fromCharCode(10) + "return { name: cvFileNameOf, foot: cvFileFootHtml };")(
    (s: unknown) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    { add: "新增", modify: "改", delete: "删", keep: "复用" },
  ) as { name: (t: unknown) => string; foot: (n: unknown) => string };
}
async function changeBadgeFn(): Promise<(n: unknown, extra?: string, pillOnly?: boolean) => string> {
  const html = await panelHtml();
  const src = extractFn(html, "cvChangeBadge");
  return new Function("esc", "CV_CHG_LABEL", src + String.fromCharCode(10) + "return cvChangeBadge;")(
    (s: unknown) => String(s == null ? "" : s),
    { add: "新增", modify: "改", delete: "删", keep: "复用" },
  ) as (n: unknown, extra?: string, pillOnly?: boolean) => string;
}
/** 2026-10-29 测试文件锚点:真跑 cvCodeFlowSide(内含 cvCodeFlowTestAnchor)。 */
async function flowSideFn(): Promise<(n: unknown) => boolean> {
  const html = await panelHtml();
  const src = [
    extractFn(html, "cvCodeFlowTestAnchor"), extractFn(html, "cvCodeFlowSide"),
  ].join(String.fromCharCode(10));
  return new Function(src + String.fromCharCode(10) + "return cvCodeFlowSide;")() as (n: unknown) => boolean;
}
/** 2026-10-29 逻辑层口径:`.cv-before` 渲染(modify/delete 才出、1 行 ≤48 字截断)。 */
async function beforeFn(): Promise<(n: unknown) => string> {
  const html = await panelHtml();
  const src = extractFn(html, "cvBeforeHtml");
  return new Function("esc", src + String.fromCharCode(10) + "return cvBeforeHtml;")(
    (s: unknown) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  ) as (n: unknown) => string;
}

/** 2026-11-05 板头层统计(排除 ph- 阶段卡与 __cv_current 合成基线的口径) */
async function layerStatsFn(): Promise<(d: unknown) => { keep: number; chg: number; anchor: number; total: number }> {
  const html = await panelHtml();
  const src = extractFn(html, "cvLayerStats");
  return new Function(src + String.fromCharCode(10) + "return cvLayerStats;")() as (d: unknown) => { keep: number; chg: number; anchor: number; total: number };
}
