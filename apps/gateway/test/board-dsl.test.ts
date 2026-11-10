import { describe, it, expect } from "vitest";
import { BoardNodeZ } from "@lampgenie/protocol";
import { parseBoardDsl, mergeDslWithNodes } from "../src/board-dsl.js";

/** 紧凑白板 DSL 解析器。用例 2 的 DSL 常量是真实板
 * .genie/boards/web-1793201081634/e8359219-73b3-4220-a21e-cce658f6cfe1-p90b1.json
 * (Office 预览深度增强:18 节点 / 37 边)的手工转写,逐字硬编码(不运行时读盘:板目录不在包内)。
 * 字节比断言就是本 DSL 的存在理由:该 JSON = 40164 字节。 */
const REAL_BOARD_JSON_BYTES = 40164;
const REAL_BOARD_NODES = 18;
const REAL_BOARD_EDGES = 37;
/** 真实板每个 P0 节点的 accept 条数(逐条核对,防 DSL 丢验收契约)。 */
const REAL_BOARD_P0_ACCEPT: Record<string, number> = {
  'p90b1-ofx-ast': 3,
  'p90b1-ofx-theme': 2,
  'p90b1-ofx-tbl': 2,
  'p90b1-ofx-fx': 2,
  'p90b1-ofx-grp': 2,
  'p90b1-ofx-rev': 3,
  'p90b1-ofx-cap': 2,
  'p90b1-ofx-fe': 3,
  'p90b1-ofx-tst': 1,
  'p90b1-ofx-tstfe': 1,
};

const REAL_BOARD_DSL = `
%% board v1
title: Office 预览深度增强:AST v2 契约 + 8 项解析扩展(PPT 主题/表格/渐变/组合/图表/SmartArt + Word 修订批注 + 体积上限)
type: code
scale: L
kind: design
lane 01 现状:解析入口 : p90b1-ofx-k1 p90b1-ofx-k2
lane 02 现状:PPT 管线 : p90b1-ofx-k3
lane 03 现状:DOCX 管线 : p90b1-ofx-k4
lane 04 现状:前端渲染 : p90b1-ofx-k5
lane 05 变更:契约层 : p90b1-ofx-ast
lane 06 变更:PPT 深度 : p90b1-ofx-theme p90b1-ofx-tbl p90b1-ofx-fx p90b1-ofx-grp p90b1-ofx-chart p90b1-ofx-dgm
lane 07 变更:DOCX 深度 : p90b1-ofx-rev
lane 08 变更:上限 : p90b1-ofx-cap
lane 09 变更:前端 : p90b1-ofx-fe
lane 10 验收 : p90b1-ofx-tst p90b1-ofx-tstfe
lane 11 风险 : p90b1-ofx-risk

node p90b1-ofx-k1 function keep "解析入口与体积门" | [Component: TS] parseOffice 校验 ext/空包/上限后解 zip 分派
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/test/office-ooxml.test.ts
  sym: parseOffice@apps/gateway/src/office-ooxml.ts:54
node p90b1-ofx-k2 function keep "PPT 纯色填充解析" | [Component: TS] solidFillColor 只认 srgbClr/末位 sysClr
  targets: apps/gateway/src/office-ooxml.ts
  sym: solidFillColor@apps/gateway/src/office-ooxml.ts:287
node p90b1-ofx-k3 function keep "PPT 形状遍历" | [Component: TS] spTree 递归出 shapes,grpSp 终止于 unsupported
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/test/office-ooxml.test.ts
  sym: pptxShapeList@apps/gateway/src/office-ooxml.ts:444
node p90b1-ofx-k4 function keep "Word 段落流解析" | [Component: TS] body 顺序遍历 w:p/w:tbl/sdt 出 blocks
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/test/office-writeback.test.ts
  sym: docxBlocksFromBody@apps/gateway/src/office-ooxml.ts:592
node p90b1-ofx-k5 function keep "前端 render 契约" | [Component: JS] IdeOffice.render:百分比定位 + textContent 零 innerHTML
  targets: apps/gateway/src/assets/ide-office.js, apps/gateway/test/ide-office.test.ts
  sym: shapeNode@apps/gateway/src/assets/ide-office.js:505
node p90b1-ofx-ast module modify P0 "01 AST v2 契约扩展" | [Contract: TS] 加性扩展 shape/run/block/ast 字段,旧字段不收窄 | OfficeShape.fill 只有 string;无 shadow/stroke/table/chart/diagram;OfficeRun 无 revised;OfficeBlock 无 comments;OfficeAst docx 只有 blocks
  accept: pnpm --filter @lampgenie/gateway typecheck => tsc --noEmit 零错误;新增字段全部带 ? 可选,消费侧不强制改
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => 9 个既有用例全绿(纯加性扩展不破旧契约)
  accept: 人工核对 git diff apps/gateway/src/office-ooxml.ts 的 interface 段:既有字段(fill:string/rows/src/runs)不得删除或类型收窄 => 无删除行、无类型收窄行;fill 从 string 放宽为 union(放宽不算收窄)
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/src/assets/ide-office.js, apps/gateway/test/office-ooxml.test.ts
  sym: OfficeShape@apps/gateway/src/office-ooxml.ts:20
node p90b1-ofx-theme function modify P0 "02 PPT 主题色母版" | [Component: TS] clrScheme + clrMap + lumMod/lumOff → #RRGGBB | solidFillColor 只认 a:srgbClr 与 a:sysClr@lastClr;schemeClr(accent1..)与 lumMod/lumOff 一律 undefined,主题色形状无底色无字色
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => 新增用例:accent1 + lumMod=60000/lumOff=20000 折算成确定 #RRGGBB;slide 形状继承母版底色与字号
  accept: 构造一份删掉 ppt/theme/theme1.xml 的 pptx 送 parseOffice => 仍返回 kind:'pptx' 不抛错;schemeClr 回退 undefined 或原 srgbClr,不出现 NaN/#undefined
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/test/office-ooxml.test.ts
  sym: solidFillColor@apps/gateway/src/office-ooxml.ts:287
node p90b1-ofx-tbl function modify P0 "03 PPT 表格结构化" | [Component: TS] a:tbl → table{rows,cells,colWidthsEmu} | pptxGraphicFrame 把 a:tbl 拍平成文本:每行 cells.join('  ')、行间换行,列宽与单元格边界全丢
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => 3×2 表格产出 type:'table'、rows.length=3、每行 2 格文本、colWidthsEmu.length=2
  accept: 构造含 a:tbl 但 0 个 a:tr 的 pptx => 不抛错;不产出无 rows 字段的 table 形状(要么 rows:[] 要么保持 unsupported)
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/src/assets/ide-office.js, apps/gateway/test/office-ooxml.test.ts, apps/gateway/test/ide-office.test.ts
  sym: pptxGraphicFrame@apps/gateway/src/office-ooxml.ts:421
node p90b1-ofx-fx function modify P0 "04 渐变阴影描边" | [Component: TS] gradFill→gradient / outerShdw→shadow / ln→stroke | pptxSp 只读 solidFillColor;gradFill、effectLst/outerShdw、a:ln(w/solidFill)全部忽略,渐变形状渲染成透明块
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => gradFill 双 stop → fill.gradient.stops.length=2 且 pos 单调;outerShdw → shadow.dxEmu/dyEmu 与 dir/dist 换算一致;ln w=12700 → stroke.widthEmu=12700
  accept: 构造无 a:ln、无 effectLst 的普通矩形 => 输出形状不含 shadow/stroke 字段(fill 仍为纯色字符串),前端不因此多画 1px 黑边
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/src/assets/ide-office.js, apps/gateway/test/office-ooxml.test.ts, apps/gateway/test/ide-office.test.ts
  sym: pptxSp@apps/gateway/src/office-ooxml.ts:391
node p90b1-ofx-grp function modify P0 "05 组合形状展开" | [Component: TS] xfrm 仿射缩放+平移到绝对坐标 | pptxShapeList 遇 grpSp 直接产出 {type:'unsupported',unsupportedKind:'group'},子形状从不解析(组合内容整块丢失)
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => 组合 2 子形状展开为 2 个绝对定位 shape,坐标 = 父 off + 子相对 * 缩放;不再出现 unsupportedKind:'group'
  accept: 构造 grpSpPr 有 off/ext 但缺 chOff/chExt 的组合 => 子形状 x/y/cx/cy 全为有限数(非 NaN/Infinity),不抛错
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/test/office-ooxml.test.ts
  sym: pptxShapeList@apps/gateway/src/office-ooxml.ts:444
node p90b1-ofx-chart function modify P1 "06 PPT 图表数据" | [Component: TS] chartN.xml c:ser/c:cat/c:val → chart | graphicFrame 的 chart 分支固定返回 {type:'unsupported',unsupportedKind:'chart'},数据从不解析
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => 柱状图样例产出带 chart:{kind:'bar',series:[{name,cats,vals}]};series[0].vals 与 XML 数值逐项相等
  accept: 构造 chart 部件存在但 c:ser 为空的 pptx => chart 占位(series:[]),不抛错、不产出 undefined 数组给前端
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/src/assets/ide-office.js, apps/gateway/test/office-ooxml.test.ts
  sym: pptxGraphicFrame@apps/gateway/src/office-ooxml.ts:421
node p90b1-ofx-dgm function modify P1 "07 SmartArt 树" | [Component: TS] dataN.xml dgm:pt + cxn → diagram.nodes | graphicFrame 的 diagram 分支返回 {unsupportedKind:'smartart'},ppt/diagrams/dataN.xml 从不读取
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => 3 节点 SmartArt → diagram.nodes.length=3,子节点 parentId 指向父 modelId
  accept: 构造 data1.xml 存在但 dgm:pt 为空的 SmartArt => diagram.nodes=[] 或该形状仍 unsupported;不得抛错
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/src/assets/ide-office.js, apps/gateway/test/office-ooxml.test.ts
  sym: pptxGraphicFrame@apps/gateway/src/office-ooxml.ts:421
node p90b1-ofx-rev function modify P0 "08 Word 修订批注" | [Component: TS] w:ins/w:del 标 revised;comments/页眉脚注成块 | docxRuns 对 w:del/w:moveFrom 整段跳过(文本静默消失);w:ins 递归但不带标记;commentRangeStart 与 word/comments.xml 完全忽略;header*/footer*/footnotes 不产出块
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => 含 w:ins/w:del 的段落产出 revised:'ins'/'del' run 且 delText 文本在 runs 里(不丢);批注 block.comments 含作者+内容;headers 块非空
  accept: pnpm --filter @lampgenie/gateway test test/office-writeback.test.ts => 9 个回写用例全绿:block 下标与 shape 下标语义未因新增块/新字段漂移
  accept: 对含 w:del 的 docx 断言:runs.some(r=>r.revised==='del' && r.text 含被删除原文) 为真 => 被删除的 delText 内容不得为空且必须出现在 runs 中
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/src/assets/ide-office.js, apps/gateway/test/office-ooxml.test.ts, apps/gateway/test/office-writeback.test.ts
  sym: docxRuns@apps/gateway/src/office-ooxml.ts:543
node p90b1-ofx-cap module modify P0 "09 体积上限提升" | [Component: TS] OFFICE_MAX_BYTES 128MB + asset 分级阈值 | OFFICE_MAX_BYTES=64MB(office-ooxml.ts:45),超限抛「文件过大(>64MB)」;/ide/asset 单一 IDE_ASSET_MAX_BYTES=16MB(panel.ts:25619),视频一律 413
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts test/panel-ide-asset.test.ts => 上限用例更新为 office 128MB / asset 分级(图32 音128 视频512)并全绿;超限仍 413 或抛错,文案含新上限数字
  accept: 对 /ide/asset 请求 100MB 视频(本机)与 100MB .ts 文件 => 视频 200/206 可播;.ts 仍 403「仅图片/媒体类型可取」
  targets: apps/gateway/src/office-ooxml.ts, apps/gateway/src/panel.ts, apps/gateway/test/office-ooxml.test.ts, apps/gateway/test/panel-ide-asset.test.ts
  sym: OFFICE_MAX_BYTES@apps/gateway/src/office-ooxml.ts:45
node p90b1-ofx-fe function modify P0 "10 前端渲染扩展" | [Component: JS] 渐变/表格/图表/修订徽标/批注角标 | plainShape 只 safeColor(shape.fill);无 table 渲染;chart/diagram 走 unsupportedShape 占位;docx 无 revised 样式与批注展示
  accept: pnpm --filter @lampgenie/gateway test test/ide-office.test.ts => 22 个既有用例全绿(safeColor/safeSrc/shapeKind 契约未破)
  accept: 浏览器打开 IDE 预览一份含渐变+表格+柱状图+修订的 pptx/docx,截图对比 => 渐变可见、表格有网格与列宽、柱状图有柱子、删除修订显示删除线;控制台无异常
  accept: 把 fill 构造成 {"gradient":{"angle":"0;background:url(javascript:alert(1))","stops":[{"pos":0,"color":"red;position:fixed"}]}} 送 render => 输出 style 里不含 url(、不含 javascript:、不含未白名单颜色;角度被夹成纯数字
  targets: apps/gateway/src/assets/ide-office.js, apps/gateway/test/ide-office.test.ts
  sym: plainShape@apps/gateway/src/assets/ide-office.js:481
node p90b1-ofx-tst function add P0 "解析层补测" | [Component: TS] 8 项各 1 正例 + 1 负例,含坏包
  accept: pnpm --filter @lampgenie/gateway test test/office-ooxml.test.ts => 既有 9 条 + 新增 ≥16 条(每项正负各一)全绿,失败数为 0
  targets: apps/gateway/test/office-ooxml.test.ts
node p90b1-ofx-tstfe function add P0 "前端层补测" | [Component: JS] safeGradient/表格/图表/修订渲染断言
  accept: pnpm --filter @lampgenie/gateway test test/ide-office.test.ts => 22 条既有 + 新增 ≥8 条全绿
  targets: apps/gateway/test/ide-office.test.ts
node p90b1-ofx-risk note keep P1 "仍不可达项清单" | 字体度量/SmartArt 布局/径向渐变/图表样式 不承诺 | 同左(这是如实登记,不是待办)

edge p90b1-ofx-k1 ->> p90b1-ofx-ast : OfficeAst v1 [JSON]
edge p90b1-ofx-k2 -> p90b1-ofx-theme : srgbClr 基色分支复用
edge p90b1-ofx-k3 -> p90b1-ofx-tbl : graphicFrame/a:tbl [XNode]
edge p90b1-ofx-k3 -> p90b1-ofx-fx : sp@spPr [XNode]
edge p90b1-ofx-k3 -> p90b1-ofx-grp : grpSp@grpSpPr [XNode]
edge p90b1-ofx-k3 -> p90b1-ofx-chart : graphicData uri=/chart
edge p90b1-ofx-k3 -> p90b1-ofx-dgm : relIds/dm [r:id]
edge p90b1-ofx-k4 -> p90b1-ofx-rev : w:p/w:r 子树 [XNode]
edge p90b1-ofx-k1 -> p90b1-ofx-cap : buf.length > 上限 → 抛错
edge p90b1-ofx-theme ->> p90b1-ofx-ast : clrScheme 表 + 继承字号
edge p90b1-ofx-tbl ->> p90b1-ofx-ast : table{rows,colWidthsEmu}
edge p90b1-ofx-fx ->> p90b1-ofx-ast : fill.gradient/shadow/stroke
edge p90b1-ofx-grp -> p90b1-ofx-k3 : 递归展平 depth+1
edge p90b1-ofx-chart ->> p90b1-ofx-ast : chart{kind,series}
edge p90b1-ofx-dgm ->> p90b1-ofx-ast : diagram{nodes}
edge p90b1-ofx-dgm ->> p90b1-ofx-risk : 布局算法不可还原
edge p90b1-ofx-rev ->> p90b1-ofx-ast : revised/comments/headers
edge p90b1-ofx-ast ->> p90b1-ofx-fe : OfficeAst v2 [JSON /ide/office]
edge p90b1-ofx-k5 -> p90b1-ofx-fe : render({host,ast}) 契约不变
edge p90b1-ofx-fe ->> p90b1-ofx-k5 : 渲染结果交回 host 面板
edge p90b1-ofx-theme ~> p90b1-ofx-tst : tests:test/office-ooxml.test.ts
edge p90b1-ofx-tbl ~> p90b1-ofx-tst : tests:test/office-ooxml.test.ts
edge p90b1-ofx-fx ~> p90b1-ofx-tst : tests:test/office-ooxml.test.ts
edge p90b1-ofx-grp ~> p90b1-ofx-tst : tests:test/office-ooxml.test.ts
edge p90b1-ofx-chart ~> p90b1-ofx-tst : tests:test/office-ooxml.test.ts
edge p90b1-ofx-dgm ~> p90b1-ofx-tst : tests:test/office-ooxml.test.ts
edge p90b1-ofx-rev ~> p90b1-ofx-tst : tests:test/office-writeback.test.ts
edge p90b1-ofx-cap ~> p90b1-ofx-tst : tests:test/panel-ide-asset.test.ts
edge p90b1-ofx-ast ~> p90b1-ofx-tst : tests:test/office-ooxml.test.ts
edge p90b1-ofx-fe ~> p90b1-ofx-tstfe : tests:test/ide-office.test.ts
edge p90b1-ofx-k1 => p90b1-ofx-k2 : 同组次序
edge p90b1-ofx-theme => p90b1-ofx-tbl : 同组次序
edge p90b1-ofx-tbl => p90b1-ofx-fx : 同组次序
edge p90b1-ofx-fx => p90b1-ofx-grp : 同组次序
edge p90b1-ofx-grp => p90b1-ofx-chart : 同组次序
edge p90b1-ofx-chart => p90b1-ofx-dgm : 同组次序
edge p90b1-ofx-tst => p90b1-ofx-tstfe : 同组次序
`;

describe("parseBoardDsl", () => {
  it("解析小段 DSL:nodes/edges/accept/targets/sym 全部到位", () => {
    const text = [
      "%% board v1",
      "title: 演示板",
      "type: code",
      "scale: M",
      "kind: design",
      "lane 01 入口 : a b",
      "lane 02 改造 : c",
      "node a function keep \"读文件\" | 读入配置",
      "node b function keep \"校验 schema\"",
      "  accept: pnpm test => 全绿",
      "node c module modify P0 \"改写入器\" | 新写入路径 | 旧写入路径",
      "  accept: node -e ok",
      "  accept: curl /health => {ok:true}",
      "  targets: src/writer.ts, test/writer.test.ts",
      "  sym: writeBoard@src/writer.ts:42",
      "edge a -> b : 调用",
      "edge b ->> c : JSON",
      "edge c ~> a : 回归",
    ].join("\n");
    const r = parseBoardDsl(text);
    expect(r.ok).toBe(true);
    expect(r.diags).toEqual([]);
    expect(r.meta).toEqual({ title: "演示板", boardType: "code", scale: "M", docKind: "design" });
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    const a = r.nodes[0]!;
    const b = r.nodes[1]!;
    const c = r.nodes[2]!;
    expect(a.group).toBe("01 入口");
    expect(a.summary).toBe("读入配置");
    expect(a.kind).toBe("function");
    expect(a.change).toBe("keep");
    expect(b.group).toBe("01 入口");
    // summary 省略 → 回退 label
    expect(b.summary).toBe("校验 schema");
    expect(b.accept).toEqual([{ cmd: "pnpm test", expect: "全绿" }]);
    expect(c.group).toBe("02 改造");
    expect(c.phase).toBe("P0");
    expect(c.summary).toBe("新写入路径");
    expect(c.before).toBe("旧写入路径");
    // expect 省略 → 默认「通过」
    expect(c.accept).toEqual([
      { cmd: "node -e ok", expect: "通过" },
      { cmd: "curl /health", expect: "{ok:true}" },
    ]);
    expect(c.targets).toEqual(["src/writer.ts", "test/writer.test.ts"]);
    expect(c.symbolRef).toEqual({ name: "writeBoard", file: "src/writer.ts", line: 42 });
    expect(r.edges).toEqual([
      { from: "a", to: "b", kind: "call", label: "调用" },
      { from: "b", to: "c", kind: "data", label: "JSON" },
      { from: "c", to: "a", kind: "verify", label: "回归" },
    ]);
  });

  it("type: composition(作业思路板)不报 W_META_ENUM,章节/关系词原样落", () => {
    const text = [
      "%% board v1",
      "title: 季度汇报思路",
      "type: composition",
      "node t1 note keep \"主题\" | 三条数据证明迁移收益大于停机成本",
      "node s1 section keep \"01 为什么要迁\" | 现状成本已超迁移预算",
      "node s2 section keep \"02 怎么迁\" | 双写窗口 3 周可零停机",
      "edge s1 ->> s2 : 递进",
    ].join("\n");
    const r = parseBoardDsl(text);
    expect(r.ok).toBe(true);
    expect(r.diags.filter((d) => d.code === "W_META_ENUM")).toEqual([]);
    expect(r.diags).toEqual([]);
    expect(r.meta.boardType).toBe("composition");
    expect(r.nodes.map((n) => n.kind)).toEqual(["note", "section", "section"]);
    expect(r.edges).toEqual([{ from: "s1", to: "s2", kind: "data", label: "递进" }]);
  });

  it("真实板转写:节点/边/accept 不丢,且字节数 ≤ JSON×0.5", () => {
    const r = parseBoardDsl(REAL_BOARD_DSL);
    expect(r.diags).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.nodes.length).toBe(REAL_BOARD_NODES);
    expect(r.edges.length).toBe(REAL_BOARD_EDGES);
    // 节点顺序 = 板上顺序
    expect(r.nodes[0]!.id).toBe("p90b1-ofx-k1");
    expect(r.nodes[r.nodes.length - 1]!.id).toBe("p90b1-ofx-risk");
    expect(r.meta.title).toContain("Office 预览深度增强");
    expect(r.meta.boardType).toBe("code");
    expect(r.meta.scale).toBe("L");
    expect(r.meta.docKind).toBe("design");
    // 每个 P0 节点 accept 条数逐个核对
    expect(Object.keys(REAL_BOARD_P0_ACCEPT).length).toBe(10);
    for (const id of Object.keys(REAL_BOARD_P0_ACCEPT)) {
      const node = r.nodes.find((n) => n.id === id);
      expect(node, "P0 节点应存在:" + id).toBeTruthy();
      expect((node!.accept || []).length, "accept 条数:" + id).toBe(REAL_BOARD_P0_ACCEPT[id]);
    }
    // targets / symbolRef / before / group 抽样核对真实值
    const ast = r.nodes.find((n) => n.id === "p90b1-ofx-ast")!;
    expect(ast.change).toBe("modify");
    expect(ast.phase).toBe("P0");
    expect(ast.group).toBe("05 变更:契约层");
    expect(ast.before).toContain("OfficeShape.fill 只有 string");
    expect(ast.targets).toEqual([
      "apps/gateway/src/office-ooxml.ts",
      "apps/gateway/src/assets/ide-office.js",
      "apps/gateway/test/office-ooxml.test.ts",
    ]);
    expect(ast.symbolRef).toEqual({ name: "OfficeShape", file: "apps/gateway/src/office-ooxml.ts", line: 20 });
    const k1 = r.nodes.find((n) => n.id === "p90b1-ofx-k1")!;
    expect(k1.phase).toBeUndefined();
    expect(k1.change).toBe("keep");
    // 边 kind 与真实板一致
    expect(new Set(r.edges.map((e) => e.kind))).toEqual(new Set(["call", "data", "verify", "nav"]));
    // 核心指标:DSL 字节数 ≤ JSON 的 50%
    const dslBytes = Buffer.byteLength(REAL_BOARD_DSL, "utf8");
    expect(dslBytes).toBeLessThanOrEqual(REAL_BOARD_JSON_BYTES * 0.5);
  });

  it("未知行 / 重复 id / 悬空边:各出正确 code 与行号,不抛错", () => {
    const text = [
      "%% board v1",
      "node a function keep \"A\" | a 的说明",
      "garbage 这不是合法行",
      "node a function keep \"A2\"",
      "node b function keep \"B\"",
      "edge a -> b",
      "edge a -> zzz : 悬空",
    ].join("\n");
    let r: ReturnType<typeof parseBoardDsl> | undefined;
    expect(() => { r = parseBoardDsl(text); }).not.toThrow();
    const res = r!;
    const unknown = res.diags.find((x) => x.code === "E_UNKNOWN_LINE")!;
    expect(unknown.line).toBe(3);
    expect(unknown.severity).toBe("error");
    const dup = res.diags.find((x) => x.code === "E_DUP_ID")!;
    expect(dup.line).toBe(4);
    expect(dup.severity).toBe("error");
    const dangling = res.diags.find((x) => x.code === "W_DANGLING_EDGE")!;
    expect(dangling.line).toBe(7);
    expect(dangling.severity).toBe("warn");
    // 悬空边丢弃、合法边保留、重复 id 节点丢弃
    expect(res.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(res.edges).toEqual([{ from: "a", to: "b", kind: "call" }]);
    expect(res.ok).toBe(true);
  });

  it("残缺 node 行(缺引号)丢弃该节点,其余照常解析", () => {
    const text = [
      "%% board v1",
      "node a function keep \"A\"",
      "node b function keep B没有引号",
      "node c function keep \"C\" | c 说明",
      "edge a -> c",
    ].join("\n");
    const r = parseBoardDsl(text);
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(r.edges).toEqual([{ from: "a", to: "c", kind: "call" }]);
    const err = r.diags.find((x) => x.severity === "error")!;
    expect(err.code).toBe("E_NODE_SYNTAX");
    expect(err.line).toBe(3);
    expect(r.ok).toBe(true);
  });

  it("解析结果喂 zod:BoardNodeZ 逐节点 safeParse 全通过", () => {
    const r = parseBoardDsl(REAL_BOARD_DSL);
    const bad: string[] = [];
    for (const node of r.nodes) {
      const parsed = BoardNodeZ.safeParse(node);
      if (!parsed.success) bad.push(node.id + ": " + parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; "));
    }
    expect(bad).toEqual([]);
    // 缺省字段由 zod default 补齐
    const k1 = r.nodes.find((n) => n.id === "p90b1-ofx-k1")!;
    const parsed = BoardNodeZ.parse(k1);
    expect(parsed.kind).toBe("function");
    expect(parsed.change).toBe("keep");
    expect(parsed.done).toBe(false);
    expect(parsed.flow).toEqual([]);
    // 超长字段 → warn + 截断(不静默超限导致落盘被 zod 拒)
    const long = "node x function keep \"lbl\" | " + "y".repeat(600);
    const lr = parseBoardDsl(long + "\n  targets: " + "z".repeat(500));
    const x = lr.nodes[0]!;
    expect(x.summary.length).toBe(500);
    expect(x.targets![0]!.length).toBe(400);
    expect(lr.diags.some((s) => s.code === "W_TRUNCATE_SUMMARY" && s.severity === "warn")).toBe(true);
    expect(lr.diags.some((s) => s.code === "W_TRUNCATE_TARGET")).toBe(true);
    expect(BoardNodeZ.safeParse(x).success).toBe(true);
  });

  it("accept 的 type:四类都可写,[type] 前缀落进 type 字段", () => {
    const text = [
      "%% board v1",
      "node a function keep \"A\"",
      "  accept: [command] pnpm test => 全绿",
      "  accept: [browser] 打开首页 => 引导层可见",
      "  accept: [manual] 人工核对导出图 => 无遮挡",
      "  accept: [negative] curl /health => 不得回 200",
    ].join("\n");
    const r = parseBoardDsl(text);
    expect(r.diags).toEqual([]);
    expect(r.nodes[0]!.accept).toEqual([
      { cmd: "pnpm test", expect: "全绿", type: "command" },
      { cmd: "打开首页", expect: "引导层可见", type: "browser" },
      { cmd: "人工核对导出图", expect: "无遮挡", type: "manual" },
      { cmd: "curl /health", expect: "不得回 200", type: "negative" },
    ]);
    // 全部通过 zod(BoardAcceptZ 的 type 枚举四类)
    expect(BoardNodeZ.safeParse(r.nodes[0]).success).toBe(true);
  });

  it("accept 省略 type → 不写 type 字段(旧板逐字节等价,不默认 command);note 走最后一个未转义 ` | `", () => {
    const text = [
      "%% board v1",
      "node a function keep \"A\"",
      "  accept: pnpm test => 全绿",
      "  accept: [command] pnpm lint => 零告警 | 告警会挡住 CI",
      "  accept: [manual] 看板截图 => 三层都对 | 用 \\| 转义后的竖线不打头",
    ].join("\n");
    const r = parseBoardDsl(text);
    expect(r.diags).toEqual([]);
    const a = r.nodes[0]!.accept!;
    // 省略 type:结构里根本没有 type 键(undefined 且不含该键)
    expect(a[0]).toEqual({ cmd: "pnpm test", expect: "全绿" });
    expect("type" in a[0]!).toBe(false);
    expect("note" in a[0]!).toBe(false);
    expect(a[1]).toEqual({ cmd: "pnpm lint", expect: "零告警", type: "command", note: "告警会挡住 CI" });
    expect(a[2]!.cmd).toBe("看板截图");
    expect(a[2]!.note).toBe("用 | 转义后的竖线不打头");
    expect(BoardNodeZ.safeParse(r.nodes[0]).success).toBe(true);
  });

  it("accept 非法 type → 只 W_ACCEPT_TYPE_UNKNOWN 并省略 type(不抛错、不阻断)", () => {
    const text = [
      "%% board v1",
      "node a function keep \"A\"",
      "  accept: [e2e] pnpm test => 全绿",
    ].join("\n");
    const r = parseBoardDsl(text);
    const w = r.diags.find((d) => d.code === "W_ACCEPT_TYPE_UNKNOWN")!;
    expect(w).toBeTruthy();
    expect(w.severity).toBe("warn");
    expect(w.line).toBe(3);
    expect(r.diags.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.nodes[0]!.accept).toEqual([{ cmd: "pnpm test", expect: "全绿" }]);
  });

  it("accept 的 cmd 自带 ` => ` 时按最后一个切分(不会把 cmd 切断)", () => {
    const r = parseBoardDsl("node a function keep \"A\"\n  accept: grep 'x => y' result.txt => x");
    expect(r.nodes[0]!.accept).toEqual([{ cmd: "grep 'x => y' result.txt", expect: "x" }]);
  });

  it("flow: step/branch/loop 三形态按行序落数组,branch 的 else 可省", () => {
    const text = [
      "%% board v1",
      "node a function keep \"A\"",
      "  flow: step 读文件",
      "  flow: branch size > 0 ? 走解析 : 直接短路",
      "  flow: branch 有缓存 ? 复用缓存",
      "  flow: loop over blocks | body 逐块渲染; 收集告警",
    ].join("\n");
    const r = parseBoardDsl(text);
    expect(r.diags).toEqual([]);
    const flow = r.nodes[0]!.flow!;
    expect(flow).toHaveLength(4);
    expect(flow[0]).toEqual({ type: "step", text: "读文件" });
    expect(flow[1]).toEqual({
      type: "branch",
      cond: "size > 0",
      then: [{ type: "step", text: "走解析" }],
      else: [{ type: "step", text: "直接短路" }],
    });
    expect(flow[2]).toEqual({ type: "branch", cond: "有缓存", then: [{ type: "step", text: "复用缓存" }] });
    expect(flow[3]).toEqual({
      type: "loop",
      over: "blocks",
      body: [{ type: "step", text: "逐块渲染" }, { type: "step", text: "收集告警" }],
    });
    // 落到 BoardNodeZ 的 flow 结构(schema 只读不改,必须吃得下)
    expect(BoardNodeZ.safeParse(r.nodes[0]).success).toBe(true);
    expect(BoardNodeZ.parse(r.nodes[0]).flow.length).toBe(4);
  });

  it("flow 不可表达/字段缺失 → E_FLOW_SYNTAX(error,整板不落)", () => {
    const cases = [
      "  flow: 不知道什么形态",
      "  flow: step",
      "  flow: branch 没有问号",
      "  flow: branch cond ? ",
      "  flow: loop blocks",
      "  flow: loop over blocks",
      "  flow:",
    ];
    for (const line of cases) {
      const r = parseBoardDsl(["%% board v1", "node a function keep \"A\"", line].join("\n"));
      const err = r.diags.find((d) => d.code === "E_FLOW_SYNTAX");
      expect(err, "应报 E_FLOW_SYNTAX:" + line).toBeTruthy();
      expect(err!.severity).toBe("error");
      expect(err!.line).toBe(3);
    }
    // 合法与非法的分界:只写合法形态时零诊断
    const okText = ["%% board v1", "node a function keep \"A\"", "  flow: loop over xs | body 逐个试"].join("\n");
    expect(parseBoardDsl(okText).diags).toEqual([]);
  });

  it("mergeDslWithNodes:dsl 为基底,JSON 只补 flow/evidence,dsl 字段不被覆盖,JSON 独有 id 不并入", () => {
    const r = parseBoardDsl([
      "%% board v1",
      "node a function keep \"A\" | a 说明",
      "  accept: pnpm test => 全绿",
      "node b function keep \"B\"",
    ].join("\n"));
    const jsonNodes = [
      // a:补 flow/evidence,并试图改写 dsl 已有字段(kind/label/summary → 必须被忽略)
      { id: "a", kind: "decision", label: "JSON 想改", summary: "JSON 想改", flow: [{ type: "step", text: "补的 flow" }], evidence: [{ cmd: "pnpm test", ok: true, at: 0 }], done: true },
      // b:不给任何白名单字段 → 不补
      { id: "b" },
      // 独有 id:不并入
      { id: "solo", kind: "function", label: "多余", summary: "多余" },
    ];
    const merged = mergeDslWithNodes(r.nodes, jsonNodes);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.filled).toBe(1);
    const a = merged.nodes[0]!;
    expect(a.id).toBe("a");
    expect(a.kind).toBe("function");
    expect(a.label).toBe("A");
    expect(a.summary).toBe("a 说明");
    expect(a.accept).toEqual([{ cmd: "pnpm test", expect: "全绿" }]);
    expect(a.flow).toEqual([{ type: "step", text: "补的 flow" }]);
    expect((a.evidence as unknown[]).length).toBe(1);
    expect(a.done).toBe(true);
    expect(merged.nodes[1]!.id).toBe("b");
    expect(merged.nodes[1]!.flow).toBeUndefined();
    // 无 JSON / 非数组:原样返回,长度恒等
    expect(mergeDslWithNodes(r.nodes, undefined).nodes).toHaveLength(2);
    expect(mergeDslWithNodes(r.nodes, undefined).filled).toBe(0);
    // 入参不被修改(纯函数)
    expect(r.nodes[0]!.flow).toBeUndefined();
    // 落 zod:合并结果可直接喂 BoardNodeZ
    expect(BoardNodeZ.safeParse(merged.nodes[0]).success).toBe(true);
  });

  it("旧 DSL 逐字节等价:REAL_BOARD_DSL 解析结果无 type/note/flow 新字段", () => {
    const r = parseBoardDsl(REAL_BOARD_DSL);
    for (const node of r.nodes) {
      expect(node.flow, "旧板不该凭空长出 flow:" + node.id).toBeUndefined();
      for (const acc of node.accept ?? []) {
        expect("type" in acc, "旧板 accept 不该有 type:" + node.id).toBe(false);
        expect("note" in acc, "旧板 accept 不该有 note:" + node.id).toBe(false);
      }
    }
    expect(r.diags).toEqual([]);
  });
});
