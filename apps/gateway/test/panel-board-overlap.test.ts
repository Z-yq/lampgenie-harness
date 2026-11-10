/** step-1010 K:白板「图例条/工具条压住卡片」的源码契约断言。
 *  问题:①.cv-legend 曾是画布底部绝对定位浮层(position:absolute;bottom:10px),适配被
 *  fitMinK 可读下限一夹就溢到图例底下被盖住;②「添加模块/整理」是画布右上绝对定位浮层压顶排卡。
 *  修法(选 A):图例与工具条都移出画布,改为画布外底部占位条 #cvRail(.cv-rail),
 *  #cvHost 在 flex 列表里 flex:1 自然收缩,cvFitNow 不再重复预留 legendReserve。
 *  源码字符串级断言(panel.ts 是内联模板,真实遮挡走 Playwright 证据 render-matrix)。 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src", "panel.ts"), "utf-8");

/** 取一条 CSS 规则的正文(行首 `  .sel{` → 首个 `}`),用于「这条规则里不该再有绝对定位」。
 *  用换行+缩进前缀定位,避免 `.cv-rail .cv-legend{` 这类后代规则被误命中。 */
function rule(sel: string): string {
  const i = src.indexOf("\n  " + sel + "{");
  expect(i, `缺少 CSS 规则 ${sel}{`).toBeGreaterThan(0);
  const j = src.indexOf("}", i);
  expect(j).toBeGreaterThan(i);
  return src.slice(i, j + 1);
}

describe("白板图例/工具条不再覆盖画布内容(step-1010 K)", () => {
  it("图例改为画布外底部占位条:.cv-legend 不再是绝对定位浮层", () => {
    const r = rule(".cv-legend");
    expect(r).not.toContain("position:absolute");
    expect(r).not.toContain("bottom:10px");
    // 视觉样式保留(仍是一枚带边框的浅底 chip 条)
    expect(r).toContain("var(--bcv-legend-bg)");
    expect(r).toContain("display:flex");
    // 专用图例也不许再靠 left/bottom 定位
    expect(rule(".cv-legend-code")).not.toContain("bottom:10px");
    expect(src).not.toContain(".cv-legend-flow{left:168px}");
  });

  it("新增底部占位条 .cv-rail:画布外的 flex 项(非 absolute,不叠在画布上)", () => {
    const r = rule(".cv-rail");
    expect(r).toContain("flex:0 0 auto");
    expect(r).not.toContain("position:absolute");
    expect(src).toContain('class="cv-rail"');
  });

  it("「添加模块/整理」工具条不再是右上角绝对定位浮层", () => {
    const r = rule(".cv-addbar");
    expect(r).not.toContain("position:absolute");
    expect(r).not.toContain("top:8px");
    // 工具条落在占位条右端
    expect(r).toContain("margin-left:auto");
    // 按钮 id 与委托仍要保留(点击走 document 级委托,不受挪位影响)
    expect(src).toContain('id="cvAddBtn"');
    expect(src).toContain('id="cvArrangeBtn"');
  });

  it("图例与工具条都渲染在 #cvHost 之外(占位条拼在画布闭合之后)", () => {
    // 模板结尾:画布 `"</div>"` 之后接 cvRailHtml(2026-11-05:中间插入了层 chip 条 lbarHtml,故用正则而非逐字)
    expect(src).toMatch(/wbarHtml \+ (lbarHtml \+ )?"<\/div>" \+ cvRailHtml;/);
    // 四条图例全在占位条变量里,不再是 cvHost 内的兄弟浮层
    const rail = src.slice(src.indexOf("const cvRailLegends"), src.indexOf("const cvRailHtml"));
    expect(rail).toContain("cv-legend-flow");
    expect(rail).toContain("cv-legend-code");
    expect(rail).toContain("lg-virtual"); // 关系图例仍在
    expect(rail).toContain("lg-lane"); // 泳道图例仍在
    expect(src).not.toContain('style="left:10px;bottom:34px"'); // 关系图例的浮层定位已删
  });

  it("cvFitNow 不再重复预留图例高度(画布 rect 已自然扣掉)", () => {
    expect(src).not.toContain("const legendReserve");
    expect(src).not.toContain("legendReserve = legendH");
    expect(src).toContain("const availH = Math.max(120, r.height - topReserve);");
    // 底部溢出仍靠可读下限 + 平移,不许用缩字号/overflow 掩盖
    expect(src).toContain("const fitMinK = forceAll ? 0.06 :");
  });

  it("三宿主(主白板/浮窗/档案灯箱)都按 flex 列分摊画布与占位条", () => {
    // 主白板与浮窗宿主本来就是 flex 列
    expect(rule(".board-graph")).toContain("flex-direction:column");
    expect(rule(".bf-graph")).toContain("flex-direction:column");
    // 档案灯箱宿主原先写死 .bf-canvas{height:100%},占位条会被裁掉 → 改 flex
    expect(src).toContain("#arcCv{display:flex;flex-direction:column}");
    expect(src).toContain("#arcCv .bf-canvas{flex:1;min-height:0;height:auto}");
    expect(src).not.toContain("#arcCv .bf-canvas{height:100%}");
  });
});
