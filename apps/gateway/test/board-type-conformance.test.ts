/** 板型一致性门(2026-10-25 13 类规范)单测:每类一张合格板 + 至少一张反例。
 * 纯函数零 IO;反例断言 [类型门] 点名到具体缺口。 */
import { describe, it, expect } from "vitest";
import { validateBoardTypeConformance, validateChangeContract } from "../src/board-contract/index.js";

const N = (over: Record<string, unknown>) => ({
  id: "n1", kind: "module", label: "节点", summary: "说明", change: "modify", targets: ["a.ts"], ...over,
}) as never;
const E = (from: string, to: string, kind: string, label: string) => ({ from, to, kind, label });
const P = (r: { problems: string[] }[]) => r.map((i) => i.problems.join("\n")).join("\n");
const check = (nodes: unknown[], edges: unknown[], boardType: string, docKind = "design") =>
  validateBoardTypeConformance(nodes as never, edges as never, boardType, docKind);
const checkStrict = (nodes: unknown[], edges: unknown[], boardType: string, docKind = "design") =>
  validateBoardTypeConformance(nodes as never, edges as never, boardType, docKind, { scale: "M" });
const checkGenre = (nodes: unknown[], edges: unknown[], boardType: string, docGenre: string, docKind = "design") =>
  validateBoardTypeConformance(nodes as never, edges as never, boardType, docKind, { scale: "M", docGenre });

describe("板型一致性门:13 类合格样例", () => {
  it("code(2026-10-29 强制 flow):start→步骤→decision 是/否→end,步骤 targets 指仓库真实文件 + change 标注", () => {
    const nodes = [
      N({ id: "theme-1", kind: "note", group: "主题", label: "主题:board 超时配置校验流程", change: "keep", targets: ["apps/gateway/src/board-contract/rules/type-conformance.ts"] }),
      N({ id: "s", kind: "start", group: "01 触发", label: "用户要改超时", change: "keep", targets: ["apps/gateway/src/board-contract/rules/type-conformance.ts"] }),
      N({ id: "n1", kind: "function", group: "01 触发", label: "读现有超时配置", change: "keep",
        targets: ["apps/gateway/src/board-contract/rules/type-conformance.ts#flowBoardMissing"],
        flow: [{ type: "step", text: "const t = CONFIG.timeout" }] }),
      N({ id: "d", kind: "decision", group: "02 判定", label: "配置项存在?", change: "keep",
        targets: ["apps/gateway/src/board-contract/rules/type-conformance.ts"],
        flow: [{ type: "branch", cond: "cfg", then: [{ type: "step", text: "复用" }], else: [{ type: "step", text: "新建" }] }] }),
      N({ id: "n2", kind: "function", group: "02 判定", label: "写回 timeout", change: "modify", before: "timeout=3000",
        targets: ["apps/gateway/src/board-contract/rules/type-conformance.ts#validateBoardTypeConformance"],
        flow: [{ type: "step", text: "cfg.timeout = 30_000" }] }),
      N({ id: "e", kind: "end", group: "03 结果", label: "面板超时 30s", change: "keep", targets: ["apps/gateway/src/board-contract/rules/type-conformance.ts"] }),
      N({ id: "e2", kind: "end", group: "03 结果", label: "保持默认 3s", change: "keep", targets: ["apps/gateway/src/board-contract/rules/type-conformance.ts"] }),
    ];
    const edges = [
      E("theme-1", "s", "data", "板首主题"), E("s", "n1", "data", "触发"), E("n1", "d", "data", "读到配置"),
      E("d", "n2", "data", "是：有配置"), E("d", "e2", "data", "否：无配置"), E("n2", "e", "data", "写回"),
    ];
    expect(check(nodes, edges, "code")).toEqual([]);
  });

  it("code flow(start/end):方法分组 + decision 是/否双出口 + 步骤 flow,不再要求现状/变更双泳道", () => {
    const nodes = [
      N({ id: "theme-1", kind: "note", group: "主题", label: "主题:插件安装流程", change: "keep", targets: ["a.ts"] }),
      N({ id: "s", kind: "start", group: "01 install()", label: "安装", change: "keep", targets: ["a.ts"] }),
      N({ id: "f", kind: "function", group: "01 install()", label: "复制资产", change: "modify", before: "旧行为", targets: ["a.ts"], flow: [{ type: "step", text: "copyDir()" }] }),
      N({ id: "d", kind: "decision", group: "02 register()", label: "带技能?", change: "keep", targets: ["a.ts"], flow: [{ type: "branch", cond: "has", then: [{ type: "step", text: "注册" }], else: [] }] }),
      N({ id: "e", kind: "end", group: "02 register()", label: "聊天窗可用", change: "keep", targets: ["a.ts"] }),
      N({ id: "e2", kind: "end", group: "02 register()", label: "保持旧两组", change: "keep", targets: ["a.ts"] }),
      N({ id: "t", kind: "note", group: "03 验收", label: "测试:安装后候选", change: "keep", targets: ["test.ts"] }),
    ];
    // decision 的否分支必须落到真实 end/步骤,不能落到会被侧栏剥离的 note
    const ok = [
      E("theme-1", "s", "data", "板首主题"),
      E("s", "f", "data", "触发"), E("f", "d", "data", "资产"),
      E("d", "e", "data", "是：有资产"), E("d", "e2", "data", "否：无资产"),
      E("e", "t", "verify", "tests:安装后候选"),
    ];
    expect(check(nodes, ok, "code")).toEqual([]);
    const bad = ok.filter((e) => e.label !== "否：无资产");
    expect(P(check(nodes, bad, "code"))).toContain("是/否");
  });

  it("code flow 全 keep(纯分析):不强制变更类型/上游 caller,仍绿", () => {
    const nodes = [
      N({ id: "theme-1", kind: "note", group: "主题", label: "主题:插件安装后注册流程", change: "keep", targets: ["a.ts"] }),
      N({ id: "s", kind: "start", group: "01 install()", label: "安装", change: "keep", targets: ["a.ts"] }),
      N({ id: "d", kind: "decision", group: "02 register()", label: "成功?", change: "keep", targets: ["a.ts"], flow: [{ type: "branch", cond: "ok", then: [{ type: "step", text: "yes" }], else: [{ type: "step", text: "no" }] }] }),
      N({ id: "e", kind: "end", group: "02 register()", label: "完成", change: "keep", targets: ["a.ts"] }),
      N({ id: "e2", kind: "end", group: "02 register()", label: "失败出口", change: "keep", targets: ["a.ts"] }),
      N({ id: "t", kind: "note", group: "03 验收", label: "测试:回归", change: "keep", targets: ["t.ts"] }),
    ];
    const edges = [E("theme-1", "s", "data", "板首主题"), E("s", "d", "data", "触发"), E("d", "e", "data", "是：ok"), E("d", "e2", "data", "否：fail"), E("e", "t", "verify", "测试:回归")];
    expect(check(nodes, edges, "code")).toEqual([]);
  });

  it("code flow: decision 分支不完整(第三条无 label/落侧栏)点名", () => {
    const nodes = [
      N({ id: "s", kind: "start", group: "01 install()", label: "安装", change: "keep", targets: ["a.ts"] }),
      N({ id: "d", kind: "decision", group: "02 register()", label: "成功?", change: "keep", targets: ["a.ts"], flow: [{ type: "branch", cond: "ok", then: [{ type: "step", text: "yes" }], else: [{ type: "step", text: "no" }] }] }),
      N({ id: "e", kind: "end", group: "02 register()", label: "完成", change: "keep", targets: ["a.ts"] }),
      N({ id: "e2", kind: "end", group: "02 register()", label: "失败出口", change: "keep", targets: ["a.ts"] }),
      N({ id: "x", kind: "note", group: "04 风险", label: "验收口径", change: "keep", targets: ["x.ts"] }),
    ];
    const base = [E("s", "d", "data", "触发"), E("d", "e", "data", "是：ok"), E("d", "e2", "data", "否：fail")];
    expect(P(check(nodes, [...base, E("d", "x", "data", "异常")], "code"))).toContain("decision 出边不完整");
    expect(P(check(nodes, [...base, E("d", "e", "data", "")], "code"))).toContain("decision 出边不完整");
  });

  it("test:正常/边界/异常 + decision + 断言 + verify 连逻辑", () => {
    const nodes = [
      N({ id: "d1", kind: "io", label: "正常输入", change: "keep", group: "01 测试数据" }),
      N({ id: "d2", kind: "io", label: "边界空板", change: "keep", group: "01 测试数据" }),
      N({ id: "d3", kind: "io", label: "异常缺状态", change: "keep", group: "01 测试数据" }),
      N({ id: "dec", kind: "decision", label: "分支覆盖", change: "keep" }),
      N({ id: "logic", kind: "function", label: "被测逻辑", change: "keep", symbolRef: { name: "validate" } }),
      N({ id: "as1", kind: "note", label: "断言:整板点名", summary: "期望 issues", change: "keep" }),
    ];
    expect(check(nodes, [E("d1", "logic", "verify", "输入→被测"), E("dec", "as1", "verify", "分支→断言")], "test")).toEqual([]);
  });

  it("test flow(接入 code flow):主线被测链路逐函数 + 断言 decision 是/否 + 回归锚;无用例卡层", () => {
    const nodes = [
      N({ id: "s", kind: "start", group: "01 夹具", label: "运行 spec", change: "keep", targets: ["a.spec.ts"] }),
      N({ id: "f", kind: "function", group: "01 夹具", label: "准备夹具", change: "keep", targets: ["a.spec.ts"], flow: [{ type: "step", text: "mkPlugin()" }] }),
      N({ id: "c1", kind: "function", group: "02 被测链路", label: "PluginSystem.install 落盘", change: "keep", targets: ["plugins.ts"], flow: [{ type: "step", text: "writeFileSync(cmd.md)" }] }),
      N({ id: "c2", kind: "function", group: "02 被测链路", label: "slashFilter 打分截断", change: "keep", targets: ["panel.ts"], flow: [{ type: "step", text: "slice(0, 12)" }] }),
      N({ id: "d", kind: "decision", group: "03 断言", label: "断言:候选含 hi?", change: "keep", targets: ["a.spec.ts"], flow: [{ type: "branch", cond: "expect(menu).toContain('hi')", then: [{ type: "step", text: "绿" }], else: [{ type: "step", text: "红灯" }] }] }),
      N({ id: "e", kind: "end", group: "03 断言", label: "通过:候选可见", change: "keep", targets: ["a.spec.ts"] }),
      N({ id: "x", kind: "end", group: "04 失败定位", label: "红灯→三步定位", change: "keep", targets: ["a.spec.ts"] }),
      N({ id: "r", kind: "note", group: "05 回归锚", label: "回归:fullstack 复跑", change: "keep", targets: ["fullstack.spec.cjs"] }),
    ];
    const edges = [
      E("s", "f", "data", "启动"), E("f", "c1", "data", "plugins.install [WS]"), E("c1", "c2", "data", "commands.list.result"),
      E("c2", "d", "data", "候选数组"), E("d", "e", "data", "是：含 hi"), E("d", "x", "data", "否：红灯"), E("e", "r", "verify", "绿→复跑回归锚"),
    ];
    expect(check(nodes, edges, "test")).toEqual([]);
    // 缺回归锚点名
    const noReg = nodes.filter((n) => (n as { id: string }).id !== "r");
    expect(P(check(noReg, edges.filter((e) => e.to !== "r"), "test"))).toContain("回归锚");
  });

  it("docs:大骨架(章)+逐章丰富(页 contains 进章)+ data 边,无代码节点", () => {
    const nodes = [
      N({ id: "s1", kind: "section", label: "01 架构分层清晰", group: "01 章节" }),
      N({ id: "p1a", kind: "page", label: "三层结构成立", group: "01 章节", summary: "证据 service/app.py:20" }),
      N({ id: "p1b", kind: "page", label: "目录职责单一", group: "01 章节", summary: "证据 dialogue_memory/" }),
      N({ id: "s2", kind: "section", label: "02 耦合是主要风险", group: "02 章节" }),
      N({ id: "p2a", kind: "page", label: "服务层伸手私有成员", group: "02 章节", summary: "证据 app.py:44" }),
      N({ id: "s3", kind: "section", label: "03 测试覆盖失衡", group: "03 章节" }),
      N({ id: "p3a", kind: "page", label: "两层零测试", group: "03 章节", summary: "grep 全仓零命中" }),
    ];
    const edges = [
      E("s1", "s2", "data", "承接"), E("s2", "s3", "data", "承接"),
      E("s1", "p1a", "contains", ""), E("s1", "p1b", "contains", ""),
      E("s2", "p2a", "contains", ""), E("s3", "p3a", "contains", ""),
    ];
    expect(check(nodes, edges, "docs")).toEqual([]);
    // 反例:章没有页(大骨架未丰富)
    const bare = nodes.filter((n) => (n as { id: string }).id !== "p1a" && (n as { id: string }).id !== "p1b");
    const bareEdges = edges.filter((e) => e.to !== "p1a" && e.to !== "p1b");
    expect(P(check(bare, bareEdges, "docs"))).toContain("没有页");
  });

  it("docs 体裁覆盖(通用机制):docGenre 在场时缺必答维度点名,齐了才绿", () => {
    // 方案评审板:只有质量发现章,没有定位/架构/流程/决策/结论 → 体裁门逐维度点名
    const nodes = [
      N({ id: "s1", kind: "section", label: "01 密码硬编码风险", group: "01 章", summary: "证据 mysql_store.py:44" }),
      N({ id: "p1", kind: "page", label: "三套明文密码", group: "01 章", summary: "mysql_store.py:41-64" }),
      N({ id: "s2", kind: "section", label: "02 测试缺失", group: "02 章", summary: "grep 零命中" }),
      N({ id: "p2", kind: "page", label: "两层零测试", group: "02 章", summary: "grep 全仓" }),
      N({ id: "s3", kind: "section", label: "03 修复建议", group: "03 章", summary: "结论:先密钥后测试" }),
      N({ id: "p3", kind: "page", label: "三步走", group: "03 章", summary: "先换密码再补测试" }),
    ];
    const edges = [
      E("s1", "s2", "data", "承接"), E("s2", "s3", "data", "承接"),
      E("s1", "p1", "contains", ""), E("s2", "p2", "contains", ""), E("s3", "p3", "contains", ""),
    ];
    const issues = P(checkGenre(nodes, edges, "docs", "review-solution"));
    expect(issues).toContain("缺必答维度");
    expect(issues).toContain("定位与目标");
    expect(issues).toContain("总体架构");
    expect(issues).toContain("核心流程/pipeline");
    // 补齐维度章(定位/架构/流程/决策)后通过——数据驱动,同一条门对任何体裁生效
    const full = nodes.concat([
      N({ id: "s0", kind: "section", label: "00 定位与目标:面向长对话的记忆服务", group: "00 结论", summary: "解决对话记忆;目标用户与场景" }),
      N({ id: "p0", kind: "page", label: "系统职责", group: "00 章", summary: "用途与背景" }),
      N({ id: "sA", kind: "section", label: "04 总体架构:三层组件", group: "04 章", summary: "架构组件清单" }),
      N({ id: "pA", kind: "page", label: "组件组成", group: "04 章", summary: "架构分层与模块" }),
      N({ id: "sF", kind: "section", label: "05 核心流程与 pipeline", group: "05 章", summary: "流程链路时序" }),
      N({ id: "pF", kind: "page", label: "处理步骤", group: "05 章", summary: "数据流 pipeline 步骤" }),
      N({ id: "sD", kind: "section", label: "06 关键设计决策", group: "06 章", summary: "选型权衡" }),
      N({ id: "pD", kind: "page", label: "取舍与代价", group: "06 章", summary: "决策与替代方案" }),
    ]);
    const fullEdges = edges.concat([
      E("s0", "s1", "data", "承接"),
      E("s0", "p0", "contains", ""),
      E("s3", "sA", "data", "承接"), E("sA", "pA", "contains", ""),
      E("sA", "sF", "data", "承接"), E("sF", "pF", "contains", ""),
      E("sF", "sD", "data", "承接"), E("sD", "pD", "contains", ""),
    ]);
    expect(checkGenre(full, fullEdges, "docs", "review-solution")).toEqual([]);
  });

  it("ui:docKind=page + 页面/区块/组件 + nav 触发 label + 五态;纯 UI 无 targets/逻辑", () => {
    const nodes = [
      N({ id: "pg", kind: "page", label: "设置页", change: "modify", targets: [] }),
      N({ id: "sec", kind: "section", label: "结果态区", change: "keep", targets: [] }),
      N({ id: "btn", kind: "component", label: "添加按钮", summary: "点击弹窗", change: "add", targets: [] }),
      N({ id: "st", kind: "section", label: "五态:空/加载/错误/禁用/权限", change: "keep", targets: [] }),
    ];
    expect(check(nodes, [E("pg", "sec", "contains", "区块"), E("btn", "pg", "nav", "点击弹窗")], "ui", "page")).toEqual([]);
  });

  it("ui 多屏:页面间 nav + 每屏可达;孤屏/零跨页跳转点名", () => {
    const nodes = [
      N({ id: "p1", kind: "page", label: "首页", change: "keep", targets: [] }),
      N({ id: "s1", kind: "section", label: "列表区", change: "keep", targets: [] }),
      N({ id: "c1", kind: "component", label: "卡片", summary: "点击进详情", change: "keep", targets: [] }),
      N({ id: "p2", kind: "page", label: "详情页", change: "keep", targets: [] }),
      N({ id: "s2", kind: "section", label: "五态:空/加载/错误/禁用/权限", change: "keep", targets: [] }),
      N({ id: "c2", kind: "component", label: "返回", summary: "点击回首页", change: "keep", targets: [] }),
    ];
    const good = [
      E("p1", "s1", "contains", "页面"), E("p1", "c1", "contains", "列表"),
      E("p2", "s2", "contains", "页面"), E("p2", "c2", "contains", "操作"),
      E("c1", "p2", "nav", "点击卡片跳详情"),
      E("c2", "p1", "nav", "点击返回首页"),
    ];
    expect(check(nodes, good, "ui", "page")).toEqual([]);
    // 没有任何跨屏 nav(只剩 contains):交互图的两个屏连不起来
    const noCross = good.filter((e) => e.kind !== "nav");
    expect(P(check(nodes, noCross, "ui", "page"))).toContain("缺跨屏 nav 跳转");
    // 第三屏没有任何 nav 进出:孤屏
    const isolated = nodes.concat([N({ id: "p3", kind: "page", label: "孤屏", change: "keep", targets: [] })]);
    expect(P(check(isolated, good, "ui", "page"))).toContain("页面没有交互连线:p3");
    // 3 屏只有 1 屏有区块:空白屏过多
    const sparse = [
      N({ id: "q1", kind: "page", label: "首页", change: "keep", targets: [] }),
      N({ id: "q2", kind: "page", label: "空屏一", change: "keep", targets: [] }),
      N({ id: "q3", kind: "page", label: "空屏二", change: "keep", targets: [] }),
      N({ id: "qs", kind: "section", label: "五态:空/加载/错误/禁用/权限", change: "keep", targets: [] }),
    ];
    const sparseEdges = [E("q1", "qs", "contains", "区块"), E("q1", "q2", "nav", "跳转空屏一"), E("q2", "q3", "nav", "跳转空屏二")];
    expect(P(check(sparse, sparseEdges, "ui", "page"))).toContain("空白屏过多");
  });

  it("ui-func:UI nav→逻辑 + 逻辑 call/data + 五态", () => {
    const nodes = [
      N({ id: "pg", kind: "page", label: "页面", change: "keep", targets: [] }),
      N({ id: "sec", kind: "section", label: "区块", change: "keep", targets: [] }),
      N({ id: "btn", kind: "component", label: "提交", summary: "点击提交", change: "keep", targets: [] }),
      N({ id: "fn", kind: "function", label: "提交逻辑", change: "keep", targets: [] }),
      N({ id: "svc", kind: "function", label: "网关分支", change: "keep", targets: [] }),
      N({ id: "st", kind: "section", label: "空/加载/错误/禁用/权限", change: "keep", targets: [] }),
    ];
    expect(check(nodes, [
      E("pg", "sec", "contains", "页面"),
      E("btn", "fn", "nav", "点提交→逻辑"),
      E("fn", "svc", "call", "逻辑→网关"),
    ], "ui-func", "page")).toEqual([]);
  });

  it("fault:6 段 + 具体根因 + 修复/回归", () => {
    const nodes = [
      N({ id: "f1", label: "复现", group: "01 复现", change: "keep" }),
      N({ id: "f2", label: "异常点", group: "02 异常点", change: "keep" }),
      N({ id: "f3", label: "假设", group: "03 假设", change: "keep" }),
      N({ id: "f4", label: "根因:同步全量重放阻塞事件循环", group: "04 根因", change: "keep" }),
      N({ id: "f5", label: "修复:异步分片", group: "05 修复", change: "keep" }),
      N({ id: "f6", label: "防复发:回归门", group: "06 防复发", change: "keep" }),
    ];
    expect(check(nodes, [], "fault")).toEqual([]);
  });

  it("refactor:现状/目标 + 1:1 映射 + 序号 + 兼容/回滚", () => {
    const nodes = [
      N({ id: "r1", label: "01 现状入口", group: "01 现状", change: "keep" }),
      N({ id: "r2", label: "02 目标入口", group: "02 目标", change: "add" }),
      N({ id: "r3", label: "03 回滚点", group: "02 目标", change: "add", summary: "兼容窗口/回滚" }),
    ];
    expect(check(nodes, [E("r1", "r2", "data", "1:1 映射")], "refactor")).toEqual([]);
  });

  it("perf(2026-10-29 强制 flow):start→采样基线→瓶颈→改动→复测→decision 是/否→end", () => {
    const F = "apps/gateway/src/board-contract/rules/type-conformance.ts";
    const nodes = [
      N({ id: "s", kind: "start", group: "01 采样与基线", label: "保存变慢:P95 850ms→画布转圈 3s", change: "keep", targets: [F] }),
      N({ id: "b", kind: "function", group: "01 采样与基线", label: "采样与基线 P95 850ms", summary: "同环境 同负载 baseline 30 次采样",
        change: "keep", targets: [`${F}#validateBoardTypeConformance`],
        flow: [{ type: "step", text: "for (let i = 0; i < 30; i++) await bench(save)" }, { type: "step", text: "p95(samples) // 单位 ms" }] }),
      N({ id: "p", kind: "function", group: "02 定位瓶颈", label: "瓶颈:全量扫描 nodes", summary: "profiling 火焰图热点 62%",
        change: "keep", targets: [`${F}#allText`],
        flow: [{ type: "step", text: "nodes.map(allText)" }, { type: "step", text: "if (n.flow) join('\\n')" }] }),
      N({ id: "c", kind: "function", group: "03 改动", label: "改动:先查缓存再全量", summary: "热点函数加缓存短路", change: "modify", before: "每次都全量扫描",
        targets: [`${F}#allText`],
        flow: [{ type: "step", text: "if (cache.has(id)) return cache.get(id)" }, { type: "step", text: "cache.set(id, compute(n))" }] }),
      N({ id: "r", kind: "function", group: "04 复测", label: "复测 P95 280ms", summary: "同环境 同负载 同口径 复测 30 次",
        change: "keep", targets: [F], flow: [{ type: "step", text: "await bench(save) // 同口径 30 次" }] }),
      N({ id: "d", kind: "decision", group: "04 复测", label: "P95 ≤ 300ms 达标?", summary: "达标判定", change: "keep", targets: [F],
        flow: [{ type: "branch", cond: "p95 <= 300", then: [{ type: "step", text: "上线" }], else: [{ type: "step", text: "回改动再优化一轮" }] }] }),
      N({ id: "e", kind: "end", group: "05 验收", label: "目标 P95 ≤300ms 上线", summary: "阈值同口径", change: "keep", targets: [F], phase: "P0",
        accept: [{ cmd: "npm run bench", expect: "P95 ≤ 300ms", type: "command" }, { cmd: "过载 2 倍", expect: "P95 退化 ≤5%", type: "negative" }] }),
    ];
    const edges = [
      E("s", "b", "data", "触发"), E("b", "p", "data", "基线"), E("p", "c", "data", "热点"),
      E("c", "r", "data", "改动"), E("r", "d", "data", "复测"),
      E("d", "e", "data", "是：达标"), E("d", "c", "data", "否：未达标回改动"),
    ];
    expect(check(nodes, edges, "perf")).toEqual([]);
  });

  it("perf 负例:3 张并列模块卡(0 边、无 start/decision/end)→ 判不合规并点名流程图", () => {
    const bad = check([
      N({ id: "b1", group: "基线", label: "01 并行基线 P95 850ms", summary: "baseline bench 同环境 复测 P95", change: "keep" }),
      N({ id: "b2", group: "改动", label: "02 批量改动", summary: "profiling 热点 复测 P95 目标 ≤300ms", change: "keep", phase: "P0",
        accept: [{ cmd: "bench", expect: "P95 ≤ 300ms", type: "command" }, { cmd: "过载", expect: "P95 退化 ≤5%", type: "negative" }] }),
      N({ id: "b3", group: "回归", label: "03 回归 P95 280ms", summary: "同环境 复测 百分位 P95", change: "keep" }),
    ], [], "perf");
    expect(bad.length).toBeGreaterThan(0);
    const p = P(bad);
    expect(p).toContain("缺 start");
    expect(p).toContain("缺 decision");
    expect(p).toContain("流程图");
    expect(p).toContain("b1,b2,b3");
  });

  it("data:输入→输出 + dry-run + 幂等 + 样本 + 脏数据分支", () => {
    const nodes = [
      N({ id: "in", kind: "io", label: "输入文件清单", summary: "102 个文件", change: "keep" }),
      N({ id: "dry", label: "dry-run 先行", summary: "只报不写", change: "keep" }),
      N({ id: "tr", label: "清洗转换", summary: "幂等", change: "keep" }),
      N({ id: "bad", label: "脏数据/部分失败", summary: "失败表", change: "keep" }),
      N({ id: "out", kind: "io", label: "输出", summary: "输入→清洗→输出", change: "keep" }),
    ];
    expect(check(nodes, [E("in", "tr", "data", "输入→清洗"), E("tr", "out", "data", "输出"), E("tr", "bad", "data", "脏数据")], "data")).toEqual([]);
  });

  it("contract:字段/消费者/版本弃用,无占位", () => {
    const nodes = [
      N({ id: "c1", label: "契约字段 accept.type", summary: "schema", change: "keep" }),
      N({ id: "c2", label: "消费者清单", summary: "protocol/网关/panel", change: "keep" }),
      N({ id: "c3", label: "版本策略", summary: "type 永久 optional,无弃用窗口", change: "keep" }),
    ];
    expect(check(nodes, [], "contract")).toEqual([]);
  });

  it("deploy:preflight + smoke 接线 + 回滚", () => {
    const nodes = [
      N({ id: "preflight", label: "打包环境预检", change: "add", targets: [] }),
      N({ id: "smoke", label: "用户旅程冒烟", change: "add", targets: [] }),
      N({ id: "rollback", label: "回滚与降级", change: "add" }),
    ];
    expect(check(nodes, [E("preflight", "smoke", "verify", "预检→冒烟"), E("smoke", "rollback", "verify", "失败→回滚")], "deploy")).toEqual([]);
  });

  it("research:候选×维度 + 每格证据 + 结论/放弃理由", () => {
    const nodes = [
      N({ id: "a", label: "候选A 手写TS", summary: "成本0/风险中/维护集中/证据a.ts", change: "keep" }),
      N({ id: "b", label: "候选B AJV", summary: "成本高/风险低/维护双轨/证据b.ts", change: "keep" }),
      N({ id: "m", kind: "section", label: "决策矩阵:候选×维度", summary: "成本/风险/可维护性/证据", change: "keep" }),
      N({ id: "v", kind: "decision", label: "结论:推荐A,放弃B", summary: "推荐/放弃理由", change: "keep" }),
    ];
    expect(check(nodes, [E("a", "m", "data", "证据"), E("m", "v", "data", "结论")], "research")).toEqual([]);
  });

  it("matrix:更多板型,复用 research 矩阵规则", () => {
    const nodes = [
      N({ id: "a", label: "候选A", summary: "成本0/风险低/维护集中/证据a.ts", change: "keep" }),
      N({ id: "b", label: "候选B", summary: "成本高/风险低/维护双轨/证据b.ts", change: "keep" }),
      N({ id: "m", kind: "section", label: "决策矩阵:候选×维度", summary: "成本/风险/可维护性/证据", change: "keep" }),
      N({ id: "v", kind: "decision", label: "结论:推荐A,放弃B", summary: "推荐/放弃理由", change: "keep" }),
    ];
    expect(check(nodes, [E("a", "m", "data", "证据"), E("m", "v", "data", "结论")], "matrix")).toEqual([]);
  });

  it("orchestration:agent 拓扑 + 超时/失败/重试/回收", () => {
    const nodes = [
      N({ id: "main", kind: "agent", label: "主编排", summary: "派发/回收", change: "keep" }),
      N({ id: "worker", kind: "agent", label: "worker", summary: "失败重试/超时回收", change: "keep" }),
      N({ id: "reviewer", kind: "agent", label: "reviewer", summary: "只读复核", change: "keep" }),
    ];
    expect(check(nodes, [E("main", "worker", "call", "spawn"), E("worker", "reviewer", "data", "结果")], "orchestration")).toEqual([]);
  });
});

describe("板型一致性门:反例点名", () => {
  it("test 只有代码变更层 → 点名数据/decision/断言", () => {
    const bad = check([N({ id: "it", label: "新增测试 it", change: "add" }), N({ id: "cur", label: "被测入口", change: "keep" })], [], "test");
    expect(P(bad)).toContain("测试数据组");
    expect(P(bad)).toContain("decision 节点");
    expect(P(bad)).toContain("断言/通过标准");
    expect(P(bad)).toContain("verify 边");
  });
  it("ui 混代码 targets/逻辑且非 page → 点名", () => {
    const bad = check([N({ id: "pg", kind: "page", label: "页", change: "modify", targets: ["a.ts"] }), N({ id: "fn", kind: "function", label: "逻辑", change: "keep" })], [], "ui", "design");
    expect(P(bad)).toContain("docKind=page");
    expect(P(bad)).toContain("targets/symbolRef");
    expect(P(bad)).toContain("逻辑节点");
  });
  it("fault 根因占位 → 点名到节点", () => {
    const bad = check([
      N({ id: "root", label: "根因", group: "04 根因", summary: "预期 H1+H2,写结论", change: "keep" }),
      N({ id: "fix", label: "修复", group: "05 修复", change: "keep" }),
      N({ id: "prev", label: "回归", group: "06 防复发", change: "keep" }),
    ], [], "fault");
    expect(bad.some((i) => i.nodeId === "root" && i.problems.join("").includes("占位"))).toBe(true);
  });
  it("deploy smoke 未接线 → 点名", () => {
    const bad = check([N({ id: "preflight", label: "预检", change: "keep" }), N({ id: "smoke", label: "冒烟", change: "keep" })], [], "deploy");
    expect(bad.some((i) => i.nodeId === "smoke" && i.problems.join("").includes("未接线"))).toBe(true);
  });
  it("research 纯线性流程 → 点名矩阵/维度", () => {
    const bad = check([N({ id: "a", label: "现状" }), N({ id: "b", label: "候选A" }), N({ id: "c", label: "结论" })], [], "research");
    expect(P(bad)).toContain("候选方案不足");
    expect(P(bad)).toContain("评估维度");
    expect(P(bad)).toContain("决策矩阵");
  });
  it("contract 占位消费者 → 点名", () => {
    const bad = check([N({ id: "panel", label: "panel 渲染", summary: "待 glob 定位 panel 包", targets: ["(待 glob 定位 panel 包)"] }), N({ id: "c", label: "消费者", summary: "字段 optional" })], [], "contract");
    expect(P(bad)).toContain("未定位/待定占位");
  });
  it("perf 缺基线数字 → 点名", () => {
    const bad = check([N({ id: "x", label: "优化一下", summary: "bench" })], [], "perf");
    expect(P(bad)).toContain("基线指标");
    expect(P(bad)).toContain("目标数字阈值");
  });
});

describe("2026-10-26 通用硬规则(scale 显式的新板)", () => {
  it("code 严格合格(flow 形):上游 caller + 测试边 + before/P0 四类 + 无孤儿", () => {
    const nodes = [
      N({ id: "theme-1", kind: "note", group: "主题", label: "主题:面板超时配置读写流程", change: "keep", targets: ["apps/gateway/src/main.ts"] }),
      N({ id: "s", kind: "start", group: "01 触发", label: "改超时入口", change: "keep", targets: ["apps/gateway/src/main.ts"] }),
      N({ id: "cur", kind: "function", group: "01 触发", label: "读现有配置", change: "keep", targets: ["apps/gateway/src/main.ts#readConfig"],
        flow: [{ type: "step", text: "const cfg = await readConfig()" }] }),
      N({ id: "chg", kind: "function", group: "02 判定", label: "写回 timeout=30s", change: "add", targets: ["apps/gateway/src/new.ts"], phase: "P0",
        accept: [{ cmd: "npm test", expect: "exit 0", type: "command" }, { cmd: "bad input", expect: "不崩溃", type: "negative" }],
        flow: [{ type: "step", text: "cfg.timeout = 30_000" }] }),
      N({ id: "d", kind: "decision", group: "02 判定", label: "写回成功?", change: "keep", targets: ["apps/gateway/src/new.ts"],
        flow: [{ type: "branch", cond: "ok", then: [{ type: "step", text: "继续" }], else: [{ type: "step", text: "回滚" }] }] }),
      N({ id: "e", kind: "end", group: "02 判定", label: "面板 30s", change: "keep", targets: ["apps/gateway/src/new.ts"] }),
      N({ id: "e2", kind: "end", group: "02 判定", label: "保持 3s", change: "keep", targets: ["apps/gateway/src/new.ts"] }),
      N({ id: "test1", group: "03 测试", label: "测试断言", summary: "期望 issues", change: "keep", targets: ["test/board-type-conformance.test.ts"] }),
    ];
    const edges = [
      E("theme-1", "s", "data", "板首主题"), E("s", "cur", "data", "触发"), E("cur", "chg", "call", "入口→新增"), E("chg", "d", "data", "写回"),
      E("d", "e", "data", "是：成功"), E("d", "e2", "data", "否：失败"), E("chg", "test1", "verify", "测试:断言"),
    ];
    expect(checkStrict(nodes, edges, "code")).toEqual([]);
  });

  it("fault 严格合格:≥2 假设 + 根因证据边 + 排除依据 + owner 防复发", () => {
    const nodes = [
      N({ id: "repro", label: "复现条件", summary: "环境/输入/版本", change: "keep" }),
      N({ id: "obs", label: "观测异常点", summary: "日志 trace", change: "keep" }),
      N({ id: "h1", label: "假设 A 全量重放", summary: "可证伪", change: "keep" }),
      N({ id: "h2", label: "假设 B 锁竞争", summary: "排除依据:压测无锁等待", change: "keep" }),
      N({ id: "root", label: "根因:同步全量重放阻塞事件循环", summary: "trace 证据", change: "keep" }),
      N({ id: "fix", label: "修复:异步分片", change: "keep" }),
      N({ id: "prev", label: "防复发:owner=平台, 回归门", change: "keep" }),
    ];
    const edges = [
      E("repro", "obs", "data", "复现→日志"), E("obs", "root", "data", "trace 证据"),
      E("h1", "root", "data", "假设→根因"), E("h2", "root", "data", "排除依据"),
      E("root", "fix", "data", "修复"), E("fix", "prev", "data", "回归"),
    ];
    expect(checkStrict(nodes, edges, "fault")).toEqual([]);
  });

  it("perf 严格合格:flow 形 + 同环境 + 改动→指标 verify + CI 门禁 + negative", () => {
    const F = "apps/gateway/src/board-contract/rules/type-conformance.ts";
    const nodes = [
      N({ id: "s", kind: "start", group: "01 采样与基线", label: "落盘变慢 P95 850ms", change: "keep", targets: [F] }),
      N({ id: "b", kind: "function", group: "01 采样与基线", label: "基线 P95 850ms", summary: "同环境 同负载 baseline 复测 百分位 P95",
        change: "keep", targets: [F], flow: [{ type: "step", text: "await bench(save) // 30 次" }] }),
      N({ id: "p", kind: "function", group: "02 定位瓶颈", label: "瓶颈:全量扫描", summary: "profiling 火焰图 耗时 热点",
        change: "keep", targets: [F], flow: [{ type: "step", text: "nodes.map(allText)" }] }),
      N({ id: "c", kind: "function", group: "03 改动", label: "改动:异步分片", summary: "热点分片写", change: "modify", before: "syncWriteAll(nodes) 每次全量同步写",
        targets: [F], flow: [{ type: "step", text: "await Promise.all(chunks.map(write))" }] }),
      N({ id: "d", kind: "decision", group: "04 复测", label: "P95 ≤300ms 达标?", change: "keep", targets: [F],
        flow: [{ type: "branch", cond: "p95 <= 300", then: [{ type: "step", text: "上线" }], else: [{ type: "step", text: "回改动" }] }] }),
      N({ id: "t", kind: "end", group: "04 复测", label: "目标 P95 ≤300ms", summary: "同环境 阈值 复测", change: "add", targets: [F], phase: "P0",
        accept: [{ cmd: "bench", expect: "P95 ≤ 300ms", type: "command" }, { cmd: "过载", expect: "P95 退化 ≤5%", type: "negative" }] }),
      N({ id: "g", group: "05 验收", label: "CI 门禁 预算", summary: "阈值固化", change: "keep", targets: [F] }),
    ];
    const edges = [
      E("s", "b", "data", "触发"), E("b", "p", "data", "指标"), E("p", "c", "data", "热点"),
      E("c", "t", "verify", "同环境指标"), E("t", "d", "data", "复测"),
      E("d", "g", "data", "是：达标固化门禁"), E("d", "c", "data", "否：未达标回改动"),
    ];
    expect(checkStrict(nodes, edges, "perf")).toEqual([]);
  });

  it("research 严格合格:权重 + 可信度 + 放弃理由 + 结论证据入边", () => {
    const nodes = [
      N({ id: "a", label: "候选A 手写", summary: "成本30% [高];风险低;可维护性集中;证据 file:a.ts", change: "keep" }),
      N({ id: "b", label: "候选B AJV", summary: "成本高 [中];风险低;可维护性双轨;证据 file:b.ts", change: "keep" }),
      N({ id: "m", kind: "section", label: "决策矩阵:候选×维度", summary: "权重:成本30% 风险30% 可维护性20% 可测试性10% 证据10%", change: "keep" }),
      N({ id: "v", kind: "decision", label: "结论:推荐A 放弃B", summary: "放弃理由:迁移成本高", change: "keep" }),
    ];
    const edges = [E("a", "m", "data", "证据"), E("b", "m", "data", "证据"), E("m", "v", "data", "结论证据")];
    expect(checkStrict(nodes, edges, "research")).toEqual([]);
  });

  it("orchestration 严格合格:agent 四字段 + timeout/retry + fan-in + 共享存储", () => {
    const nodes = [
      N({ id: "main", kind: "agent", label: "主编排", summary: "职责:派发;输入 schema;输出 schema;工具面;共享存储引用", change: "keep" }),
      N({ id: "worker", kind: "agent", label: "worker", summary: "职责:执行;输入 schema;输出 schema;工具面", change: "keep" }),
      N({ id: "fail", label: "失败:timeout/retry/补偿降级", change: "keep" }),
      N({ id: "collect", label: "fan-in 回收", summary: "终态聚合;共享存储引用", change: "keep" }),
    ];
    const edges = [
      E("main", "worker", "call", "dispatch 条件:x;传参 y"), E("worker", "fail", "data", "timeout/retry"),
      E("fail", "collect", "data", "补偿降级"), E("worker", "collect", "data", "终态回收 fan-in"), E("collect", "main", "data", "结果回收"),
    ];
    expect(checkStrict(nodes, edges, "orchestration")).toEqual([]);
  });

  it("严格反例:modify 缺 before / 边缺 label / P0 缺 expect / 模糊承诺 / 孤儿节点都点名", () => {
    const nodes = [
      N({ id: "bad", label: "改逻辑", summary: "尽快完成", change: "modify", phase: "P0", accept: [{ cmd: "x", type: "command", expect: "" }] }),
      N({ id: "orphan", label: "孤立节点", change: "keep" }),
    ];
    const bad = checkStrict(nodes, [E("bad", "x", "call", "")], "code");
    const txt = P(bad);
    expect(txt).toContain("缺 before");
    expect(txt).toContain("边缺显式 label");
    expect(txt).toContain("P0 accept 缺四类 type 或 expect");
    expect(txt).toContain("尽快");
    expect(txt).toContain("孤儿节点");
  });

  it("旧板(无 scale)不启用新硬规则:flow 形成立但 modify 缺 before 不报新规", () => {
    // 形态迁移(2026-10-29 门强制 flow):本条断言的是「无 scale 不启用 2026-10-26 硬规则」,
    // 所以夹具先满足 code 板强制 flow 形,再让 modify 节点缺 before 看新规不触发。
    const nodes = [
      N({ id: "theme-1", kind: "note", group: "主题", label: "主题:面板启动读配置流程", change: "keep", targets: ["apps/gateway/src/panel.ts"] }),
      N({ id: "s", kind: "start", group: "01 现状", label: "现有入口", change: "keep", targets: ["apps/gateway/src/panel.ts"] }),
      N({ id: "cur", kind: "function", group: "01 现状", label: "读配置", change: "modify", targets: ["apps/gateway/src/panel.ts#boot"],
        flow: [{ type: "step", text: "const c = boot()" }] }),
      N({ id: "d", kind: "decision", group: "02 变更", label: "有配置?", change: "keep", targets: ["apps/gateway/src/panel.ts"],
        flow: [{ type: "branch", cond: "c", then: [{ type: "step", text: "复用" }], else: [{ type: "step", text: "新建" }] }] }),
      N({ id: "chg", kind: "function", group: "02 变更", label: "新增分支", change: "add", targets: ["apps/gateway/src/new.ts"],
        flow: [{ type: "step", text: "c.timeout = 30_000" }] }),
      N({ id: "e", kind: "end", group: "02 变更", label: "生效", change: "keep", targets: ["apps/gateway/src/new.ts"] }),
      N({ id: "e2", kind: "end", group: "02 变更", label: "保持默认", change: "keep", targets: ["apps/gateway/src/new.ts"] }),
    ];
    const edges = [
      E("theme-1", "s", "data", "板首主题"),
      E("s", "cur", "data", "入口→读"), E("cur", "d", "data", "配置"), E("d", "chg", "data", "是：无配置"),
      E("d", "e2", "data", "否：有配置"), E("chg", "e", "data", "写回"),
    ];
    const issues = check(nodes, edges, "code");
    expect(P(issues)).not.toContain("缺 before");
    expect(issues).toEqual([]);
  });

  it("负例:模块清单式 code 板(全 function 卡 + call 边,无 start/decision)判不合规", () => {
    // p-v1-neg 有效性自检:把这条期望写成 0 必须变红。
    const nodes = [
      N({ id: "m1", kind: "function", group: "01 采集", label: "CLI 入口", change: "keep", targets: ["apps/gateway/src/panel.ts"], flow: [{ type: "step", text: "main()" }] }),
      N({ id: "m2", kind: "function", group: "01 采集", label: "配置读取", change: "keep", targets: ["apps/gateway/src/panel.ts"], flow: [{ type: "step", text: "load()" }] }),
      N({ id: "m3", kind: "function", group: "02 输出", label: "面板渲染", change: "keep", targets: ["apps/gateway/src/panel.ts"], flow: [{ type: "step", text: "render()" }] }),
    ];
    const edges = [E("m1", "m2", "call", "读取"), E("m2", "m3", "call", "渲染")];
    const issues = check(nodes, edges, "code");
    const txt = P(issues);
    expect(issues.length).toBeGreaterThan(0);
    expect(txt).toContain("必须是流程图");
    expect(txt).toContain("缺 start");
    expect(txt).toContain("缺 end");
    expect(txt).toContain("缺 decision");
  });

  it("负例(2026-10-29):全待办节点板(label=实现X/修复Y,无 flow)判不合规并点名 id", () => {
    const TS = "apps/gateway/src/panel.ts";
    const nodes = [
      N({ id: "s", kind: "start", group: "01 入口", label: "用户要改超时", change: "keep", targets: [TS] }),
      N({ id: "n1", kind: "function", group: "01 入口", label: "实现超时配置", change: "modify", before: "无超时配置项", targets: [TS] }),
      N({ id: "n2", kind: "function", group: "02 写回", label: "修复默认值", change: "add", targets: [TS] }),
      N({ id: "n3", kind: "note", group: "02 写回", label: "验证入口", change: "keep", targets: [TS] }),
      N({ id: "d", kind: "decision", group: "02 写回", label: "有配置?", change: "keep", targets: [TS],
        flow: [{ type: "branch", cond: "cfg", then: [{ type: "step", text: "复用" }], else: [{ type: "step", text: "新建" }] }] }),
      N({ id: "e", kind: "end", group: "03 结果", label: "生效", change: "keep", targets: [TS] }),
      N({ id: "e2", kind: "end", group: "03 结果", label: "保持默认", change: "keep", targets: [TS] }),
    ];
    const edges = [
      E("s", "n1", "data", "触发"), E("n1", "d", "data", "读到"), E("d", "e", "data", "是：有配置"),
      E("d", "e2", "data", "否：无配置"), E("n2", "e", "data", "写回"),
    ];
    const issues = check(nodes, edges, "code");
    const txt = P(issues);
    expect(issues.length).toBeGreaterThan(0);
    expect(txt).toContain("agent 的待办");
    expect(txt).toContain("n1「实现超时配置」");
    expect(txt).toContain("n2「修复默认值」");
    // 保守口径:change=keep 的动词 label 不判(可能是在描述现有动作)
    expect(txt).not.toContain("n3「");
  });

  it("正例(2026-10-29):全 keep 逻辑板 0 issue,keep 节点缺 accept 也合法", () => {
    const TS = "apps/gateway/src/panel.ts";
    const nodes = [
      N({ id: "theme-1", kind: "note", group: "主题", label: "主题:面板超时配置读取与写回流程", change: "keep", targets: [TS] }),
      N({ id: "s", kind: "start", group: "01 触发", label: "用户改超时", change: "keep", targets: [TS], phase: "P0" }),
      N({ id: "n1", kind: "function", group: "01 触发", label: "读超时配置", change: "keep", targets: [TS + "#readConfig"], phase: "P0",
        flow: [{ type: "step", text: "const cfg = await readConfig()" }] }),
      N({ id: "d", kind: "decision", group: "02 判定", label: "有配置?", change: "keep", targets: [TS], phase: "P0",
        flow: [{ type: "branch", cond: "cfg == null", then: [{ type: "step", text: "createCfg()" }], else: [{ type: "step", text: "merge(cfg)" }] }] }),
      N({ id: "n2", kind: "function", group: "02 判定", label: "写回 timeout", change: "modify", before: "timeout = 3000",
        targets: [TS + "#writeTimeout"], flow: [{ type: "step", text: "cfg.timeout = 30_000" }] }),
      N({ id: "e", kind: "end", group: "03 结果", label: "面板超时 30s", change: "keep", targets: [TS], phase: "P0" }),
      N({ id: "e2", kind: "end", group: "03 结果", label: "保持默认 3s", change: "keep", targets: [TS] }),
      N({ id: "t", kind: "note", group: "04 验证", label: "测试断言", summary: "期望 issues 为空", change: "keep", targets: ["test/board-type-conformance.test.ts"] }),
    ];
    const edges = [
      E("theme-1", "s", "data", "板首主题"),
      E("s", "n1", "data", "触发"), E("n1", "n2", "call", "读到配置"), E("n2", "d", "data", "写回"),
      E("d", "e", "data", "是：有配置"), E("d", "e2", "data", "否：无配置"), E("n2", "t", "verify", "测试:断言"),
    ];
    // 板型门(无 scale 与 scale 两条口径)都为 0
    expect(check(nodes, edges, "code")).toEqual([]);
    expect(checkStrict(nodes, edges, "code")).toEqual([]);
    // 变更契约门:P0 全 keep → 缺 accept 不报(逻辑快照没有可验收物)
    expect(validateChangeContract(nodes as never, "design", edges as never, { boardType: "code" }).issues).toEqual([]);
    // 对照:同一个 P0 节点改成 modify 且 accept 缺 expect → 仍必须报(豁免只给 keep,不放大)
    const flipped = nodes.map((n) => {
      const o = n as unknown as Record<string, unknown>;
      return o.id === "n1"
        ? { ...o, change: "modify", before: "无超时配置项", accept: [{ cmd: "npm test", expect: "", type: "command" }] }
        : o;
    });
    const txt = validateChangeContract(flipped as never, "design", edges as never, { boardType: "code" }).issues
      .map((i) => i.problems.join("\n")).join("\n");
    expect(txt).toContain("P0 accept 1 缺 expect");
  });

  it("负例:步骤节点缺 targets / targets 非仓库路径 / 未标 change 都点名节点 id", () => {
    const nodes = [
      N({ id: "s", kind: "start", group: "01 入口", label: "触发", change: "keep", targets: ["apps/gateway/src/panel.ts"] }),
      N({ id: "n1", kind: "function", group: "01 入口", label: "改超时", targets: [], change: undefined,
        flow: [{ type: "step", text: "cfg.timeout = 30_000" }] }),
      N({ id: "n3", kind: "function", group: "02 判定", label: "写回配置", change: "modify", targets: ["写回配置项"],
        flow: [{ type: "step", text: "write(cfg)" }] }),
      N({ id: "d", kind: "decision", group: "02 判定", label: "写回成功?", change: "keep", targets: ["apps/gateway/src/panel.ts"],
        flow: [{ type: "branch", cond: "ok", then: [{ type: "step", text: "是" }], else: [{ type: "step", text: "否" }] }] }),
      N({ id: "e", kind: "end", group: "02 判定", label: "生效", change: "keep", targets: ["apps/gateway/src/panel.ts"] }),
      N({ id: "e2", kind: "end", group: "02 判定", label: "保持默认", change: "keep", targets: ["apps/gateway/src/panel.ts"] }),
    ];
    const edges = [
      E("s", "n1", "data", "触发"), E("n1", "d", "data", "读到"), E("d", "n3", "data", "是：写回"),
      E("d", "e2", "data", "否：不写"), E("n3", "e", "data", "完成"),
    ];
    const txt = P(check(nodes, edges, "code"));
    expect(txt).toContain("步骤节点缺 targets");
    expect(txt).toContain("n1");
    expect(txt).toContain("不是仓库相对路径");
    expect(txt).toContain("n3");
    expect(txt).toContain("未标 change");
  });
});

describe("内容来源层二期(2026-11-04 用户口径「板上的现状必须是真实结构,不是模型印象」)", () => {
  const F = "apps/gateway/src/board-contract/rules/type-conformance.ts";
  const ACC = [
    { cmd: "npx vitest run test/board-type-conformance.test.ts", expect: "全绿", type: "command" },
    { cmd: "构造印象 keep", expect: "被点名拦下", type: "negative" },
  ];
  /** 合格 code flow 板(start→读配置→decision→写回→双 end),外加一张 keep 旁注卡承载四态变量。 */
  const board = (keepSum: string, keepTargets: string[] = [], before = "readConfig() 读不到 CFG.timeout,默认 3s", keepSymbol?: unknown) => ({
    nodes: [
      N({ id: "theme-1", kind: "note", group: "主题", label: "主题:board 超时配置校验流程", change: "keep", targets: [F] }),
      N({ id: "s", kind: "start", group: "01 触发", label: "改超时", change: "keep", targets: [F] }),
      N({ id: "n1", kind: "function", group: "01 触发", label: "读超时配置", change: "keep", targets: [`${F}#hasEvidenceAnchor`],
        flow: [{ type: "step", text: "await readConfig()" }] }),
      N({ id: "d", kind: "decision", group: "02 判定", label: "有配置?", change: "keep", targets: [F],
        flow: [{ type: "branch", cond: "cfg == null", then: [{ type: "step", text: "createCfg()" }], else: [{ type: "step", text: "merge(cfg)" }] }] }),
      N({ id: "m", kind: "function", group: "02 判定", label: "写回 timeout", change: "modify", before, targets: [`${F}#strictCommonIssues`],
        phase: "P0", accept: ACC, flow: [{ type: "step", text: "cfg.timeout = 30_000" }] }),
      N({ id: "e", kind: "end", group: "02 判定", label: "面板 30s", change: "keep", targets: [F] }),
      N({ id: "e2", kind: "end", group: "02 判定", label: "保持 3s", change: "keep", targets: [F] }),
      N({ id: "k", kind: "note", group: "03 旁注", label: "现状说明", summary: keepSum, change: "keep", targets: keepTargets, ...(keepSymbol ? { symbolRef: keepSymbol } : {}) }),
      N({ id: "t", kind: "note", group: "04 验证", label: "测试:锚四态", summary: "expect issues", change: "keep", targets: ["test/board-type-conformance.test.ts"] }),
    ],
    edges: [
      E("theme-1", "s", "data", "板首主题"), E("s", "n1", "data", "触发"), E("n1", "d", "data", "读到配置"),
      E("d", "m", "data", "是：有配置"), E("d", "e2", "data", "否：无配置"),
      E("m", "e", "data", "写回"), E("m", "k", "verify", "证据:type-conformance.ts:146"),
      E("m", "t", "verify", "测试:board-type-conformance.test.ts"),
    ],
  });

  it("keep 只写 summary file:line(无 targets/symbolRef)→ 2026-11-04 收紧后点名「锚不可见」", () => {
    const { nodes, edges } = board("锚判定 hasEvidenceAnchor 三条件任一(type-conformance.ts:146)");
    const txt = P(checkStrict(nodes, edges, "code"));
    expect(txt).toContain("keep(现状)节点锚不可见");
    expect(txt).toContain("targets=['仓库相对路径#符号名']");
    expect(txt).toContain("k「现状说明」");
  });

  it("keep 带 targets(仓库相对路径)→ 过;带 symbolRef → 过", () => {
    const withTargets = board("锚判定 hasEvidenceAnchor(type-conformance.ts:146)", [F]);
    expect(checkStrict(withTargets.nodes, withTargets.edges, "code")).toEqual([]);
    const withSymbol = board("锚判定 hasEvidenceAnchor(type-conformance.ts:146)", [],
      "readConfig() 读不到 CFG.timeout,默认 3s",
      { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 });
    expect(checkStrict(withSymbol.nodes, withSymbol.edges, "code")).toEqual([]);
  });

  it("印象 keep(纯抽象描述、无 targets/symbolRef)→ 点名「keep(现状)节点锚不可见」", () => {
    const { nodes, edges } = board("处理逻辑优化,提升可读性");
    const txt = P(checkStrict(nodes, edges, "code"));
    expect(txt).toContain("keep(现状)节点锚不可见");
    expect(txt).toContain("k「现状说明」");
  });

  it("带锚 before(现有符号名)→ 过;无锚 before(「旧行为」)→ 点名", () => {
    const ok = board("证据见 type-conformance.ts:146", [F]);
    expect(P(checkStrict(ok.nodes, ok.edges, "code"))).not.toContain("before 缺真实锚");
    const weak = board("证据见 type-conformance.ts:146", [F], "旧行为");
    const txt = P(checkStrict(weak.nodes, weak.edges, "code"));
    expect(txt).toContain("before 缺真实锚");
    expect(txt).toContain("m「旧行为」");
  });

  it("空 before → 仍报「缺 before」(两条检查不互相顶替)", () => {
    const { nodes, edges } = board("证据见 type-conformance.ts:146", [F], "");
    expect(P(checkStrict(nodes, edges, "code"))).toContain("缺 before");
  });

  it("旧板(无 scale / 不 strict)不背新锚检查", () => {
    const { nodes, edges } = board("处理逻辑优化");
    expect(P(check(nodes, edges, "code"))).not.toContain("锚不可见");
  });
});
describe("纯计划步骤板检测(2026-11-04 用户口径:板偏计划步骤而非实际开发内容逻辑)", () => {
  it("零 targets/symbolRef/accept/数据的步骤序列 → 点名「纯计划步骤板」", () => {
    const r = check([
      N({ id: "s1", label: "梳理近两日轨迹", summary: "先看轨迹", targets: [] }),
      N({ id: "s2", label: "归因拒答根因", summary: "找出原因", targets: [] }),
      N({ id: "s3", label: "复测三面", summary: "回归验证", targets: [] }),
    ], [E("s1", "s2", "flow", "之后"), E("s2", "s3", "flow", "之后")], "code");
    expect(P(r)).toContain("纯计划步骤板");
    expect(P(r)).toContain("TODO");
  });
  it("v1/v2 验证型步骤板(实测长尾形态)→ 点名", () => {
    const r = check([
      N({ id: "v1", label: "确认新网关在跑", summary: "看进程", targets: [] }),
      N({ id: "v2", label: "验会话检索", summary: "跑一次", targets: [] }),
    ], [E("v1", "v2", "flow", "然后")], "perf");
    expect(P(r)).toContain("纯计划步骤板");
  });
  it("有内容节点(targets/指标数字/accept)→ 步骤节点合法,不点名", () => {
    const withTargets = check([
      N({ id: "s1", label: "梳理轨迹", summary: "先看", targets: [] }),
      N({ id: "m1", label: "修 buildLlmFromConfig 守卫", summary: "无 config 回退 undefined", targets: ["apps/gateway/src/app.ts"] }),
    ], [E("s1", "m1", "flow", "之后")], "code");
    expect(P(withTargets)).not.toContain("纯计划步骤板");
    const withMetric = check([
      N({ id: "p1", label: "token 构成拆解", summary: "注入块 13.8M 字符/1.59 亿 input", targets: [] }),
      N({ id: "p2", label: "砍最大项", summary: "审批块 273 万 token/日", targets: [] }),
    ], [E("p1", "p2", "flow", "之后")], "perf");
    expect(P(withMetric)).not.toContain("纯计划步骤板");
    const withAccept = check([
      N({ id: "a1", label: "部署校验", summary: "跑起来看", targets: [], accept: [{ cmd: "curl -sf :7700/", expect: "200" }] }),
      N({ id: "a2", label: "指标对比", summary: "看数字", targets: [] }),
    ], [E("a1", "a2", "flow", "然后")], "deploy");
    expect(P(withAccept)).not.toContain("纯计划步骤板");
  });
  it("单节点板不点名(≥2 节点才判;轻量单点板由 plan-gate 内容判据管)", () => {
    const r = check([N({ id: "s1", label: "梳理", summary: "只此一件", targets: [] })], [], "code");
    expect(P(r)).not.toContain("纯计划步骤板");
  });
});

describe("composition 作业思路板(2026-11-04 用户口径「办公任务在白板上画作业思路」)", () => {
  // 章节节点用既有 kind=section,章间关系用既有 data 边(label 写关系词);
  // 板内不带任何代码契约字段(targets/symbolRef/before),顺序由节点声明序表达。
  const S = (over: Record<string, unknown>) => ({ kind: "section", change: "keep", ...over }) as never;
  const goodNodes = () => [
    S({ id: "topic", kind: "note", label: "主题:Q4 复盘怎么写", summary: "主题说明:回顾三个月交付与改进" }),
    S({ id: "aud", kind: "note", label: "受众:Q4 复盘读者/技术团队", summary: "面向读者:研发与管理层" }),
    S({ id: "s1", group: "01 背景", label: "第一章 本季度交付盘点" }),
    S({ id: "s2", group: "02 改进", label: "第二章 下季度改进项" }),
  ];
  const goodEdges = () => [
    E("topic", "s1", "data", "主题引出"),
    E("s1", "s2", "data", "递进"),
    E("aud", "s2", "data", "按受众取舍"),
  ];

  it("正例:主题 note + 受众 note + s1/s2 section + s1→s2 递进 → 无 issue(含 strict)", () => {
    expect(checkGenre(goodNodes(), goodEdges(), "composition", "docs")).toEqual([]);
    expect(checkStrict(goodNodes(), goodEdges(), "composition")).toEqual([]);
  });

  it("反例 1:删受众 → 点名缺受众", () => {
    const nodes = goodNodes().filter((n) => (n as unknown as { id: string }).id !== "aud");
    expect(P(check(nodes, goodEdges(), "composition"))).toContain("缺受众");
  });

  it("反例 2:只有一个 section → 点名章节不足", () => {
    const nodes = goodNodes().filter((n) => ["topic", "aud", "s1"].includes((n as unknown as { id: string }).id));
    const txt = P(check(nodes, goodEdges(), "composition"));
    expect(txt).toContain("章节不足");
    expect(txt).toContain("缺关系");
  });

  it("反例 3:s1 带 targets → 节点级点名 id,不带代码契约", () => {
    const nodes = goodNodes().map((n) => ((n as unknown as { id: string }).id === "s1"
      ? S({ id: "s1", group: "01 背景", label: "第一章 本季度交付盘点", targets: ["apps/gateway/src/panel.ts"] })
      : n));
    const issues = check(nodes, goodEdges(), "composition");
    const txt = P(issues);
    expect(txt).toContain("不应带 targets/symbolRef/before");
    // 节点级点名(id + label 在 issue 字段上,不在 problems 文本里)
    expect(issues.some((i) => i.nodeId === "s1" && i.label === "第一章 本季度交付盘点")).toBe(true);
  });

  it("回归:docKind=page 早退与纯计划步骤板判据不受影响", () => {
    // 早期 page/workflow 早退照旧
    const planNodes = [N({ id: "s1", label: "梳理轨迹", targets: [] }), N({ id: "s2", label: "归因", targets: [] })];
    expect(P(check(planNodes, [E("s1", "s2", "flow", "然后")], "code", "page"))).not.toContain("纯计划步骤板");
    expect(P(check(planNodes, [E("s1", "s2", "flow", "然后")], "code"))).toContain("纯计划步骤板");
    // 纯计划步骤板文案不会漏到 composition 板(它的内容判据改由 composition 分支兜)
    const t = P(check(
      [{ id: "n1", kind: "note", label: "主题:复盘", summary: "主题", change: "keep" }],
      [], "composition",
    ));
    expect(t).not.toContain("纯计划步骤板");
  });
});

describe("白板看得懂(2026-11-04):keep 结构化锚 + 板首主题节点", () => {
  const F = "apps/gateway/src/board-contract/rules/type-conformance.ts";
  /** 一张合格 code flow 板:theme 主题节点 + start→步骤→decision→双 end。 */
  const mk = (over: { theme?: boolean; keep?: Record<string, unknown> } = {}) => {
    const nodes = [
      ...(over.theme === false ? [] : [N({ id: "theme-1", kind: "note", group: "主题", label: "主题:board 超时配置校验流程", change: "keep", targets: [F] })]),
      N({ id: "s", kind: "start", group: "01 触发", label: "改超时", change: "keep", targets: [F] }),
      N({ id: "d", kind: "decision", group: "02 判定", label: "有配置?", change: "keep", targets: [F],
        flow: [{ type: "branch", cond: "cfg == null", then: [{ type: "step", text: "createCfg()" }], else: [{ type: "step", text: "merge(cfg)" }] }] }),
      N({ id: "e", kind: "end", group: "02 判定", label: "面板 30s", change: "keep", targets: [F] }),
      N({ id: "e2", kind: "end", group: "02 判定", label: "保持 3s", change: "keep", targets: [F] }),
      N({ id: "k", kind: "function", group: "02 判定", label: "读 task-manager", change: "keep", targets: [], flow: [{ type: "step", text: "tm.submit(task)" }], ...(over.keep ?? {}) }),
      N({ id: "t", kind: "note", group: "04 验证", label: "测试:锚", summary: "expect issues", change: "keep", targets: ["test/board-type-conformance.test.ts"] }),
    ];
    const edges = [
      E("theme-1", "s", "data", "板首主题"),
      E("s", "d", "data", "触发"), E("d", "e", "data", "是：有配置"), E("d", "e2", "data", "否：无配置"),
      E("d", "k", "data", "读到配置"), E("k", "t", "verify", "测试:board-type-conformance.test.ts"),
    ];
    return { nodes, edges };
  };

  it("a. keep 只在 summary 写 task-manager.ts:60 文本锚 → 报「锚不可见」", () => {
    const { nodes, edges } = mk({ keep: { summary: "task-manager.ts:60 里 submit 的超时判定" } });
    const txt = P(checkStrict(nodes, edges, "code"));
    expect(txt).toContain("keep(现状)节点锚不可见");
    expect(txt).toContain("k「读 task-manager」");
  });

  it("b. 同节点带 symbolRef{name,file,line} → 不报锚问题", () => {
    const { nodes, edges } = mk({ keep: { summary: "task-manager.ts:60 里 submit 的超时判定",
      symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 } } });
    expect(P(checkStrict(nodes, edges, "code"))).not.toContain("锚不可见");
  });

  it("c. keep 节点带 targets=[仓库相对路径] → 不报锚问题", () => {
    const { nodes, edges } = mk({ keep: { targets: ["apps/gateway/src/task-manager.ts"] } });
    expect(checkStrict(nodes, edges, "code")).toEqual([]);
  });

  it("d. code 板无 theme 节点 → 报「主题节点」;补 theme 节点后不报", () => {
    const noTheme = mk({ theme: false });
    expect(P(check(noTheme.nodes, noTheme.edges, "code"))).toContain("code 板缺板首主题节点");
    const withTheme = mk();
    expect(P(check(withTheme.nodes, withTheme.edges, "code"))).not.toContain("主题节点");
    // group=主题 也算主题节点(不要求 id 前缀)
    const byGroup = mk({ theme: false });
    byGroup.nodes.unshift(N({ id: "head", kind: "note", group: "主题", label: "这流程干什么用", change: "keep", targets: [F] }));
    expect(P(check(byGroup.nodes, byGroup.edges, "code"))).not.toContain("主题节点");
  });

  it("e. composition 板缺 targets/symbolRef → 不报 targets/锚类问题", () => {
    const nodes = [
      { id: "theme-1", kind: "note", label: "主题:Q4 复盘怎么写", summary: "主题说明", change: "keep" },
      { id: "aud", kind: "note", label: "受众:Q4 复盘读者", summary: "面向读者", change: "keep" },
      { id: "s1", kind: "section", group: "01 背景", label: "第一章 交付盘点", change: "keep" },
      { id: "s2", kind: "section", group: "02 改进", label: "第二章 改进项", change: "keep" },
    ];
    const edges = [E("theme-1", "s1", "data", "主题引出"), E("s1", "s2", "data", "递进"), E("aud", "s2", "data", "按受众取舍")];
    const txt = P(checkStrict(nodes, edges, "composition"));
    expect(txt).not.toContain("targets");
    expect(txt).not.toContain("锚");
    expect(txt).not.toContain("主题节点");
  });

  // 2026-11-05 code review 补:空壳锚不能蒙混过门(门宣称「画布画得出来」,强度必须对得上)
  it("f. 垃圾锚不放行:targets=[''] / symbolRef:{} / targets=['随便写的']", () => {
    const t1 = mk({ keep: { targets: [""] } });
    expect(P(checkStrict(t1.nodes, t1.edges, "code"))).toContain("锚不可见");
    const t2 = mk({ keep: { symbolRef: {} } });
    expect(P(checkStrict(t2.nodes, t2.edges, "code"))).toContain("锚不可见");
    const t3 = mk({ keep: { targets: ["随便写的"] } });
    expect(P(checkStrict(t3.nodes, t3.edges, "code"))).toContain("锚不可见");
  });

  it("g. 主题节点豁免 keep 结构化锚(不逼模型给主题塞假 targets)", () => {
    const nodes = [
      N({ id: "theme-1", kind: "note", group: "主题", label: "主题:这流程干什么用", change: "keep" }),
      N({ id: "s", kind: "start", group: "01 触发", label: "改超时", change: "keep", targets: [F] }),
      N({ id: "d", kind: "decision", group: "02 判定", label: "有配置?", change: "keep", targets: [F],
        flow: [{ type: "branch", cond: "cfg == null", then: [{ type: "step", text: "createCfg()" }], else: [{ type: "step", text: "merge(cfg)" }] }] }),
      N({ id: "e", kind: "end", group: "02 判定", label: "面板 30s", change: "keep", targets: [F] }),
      N({ id: "e2", kind: "end", group: "02 判定", label: "保持 3s", change: "keep", targets: [F] }),
    ];
    const edges = [E("theme-1", "s", "data", "板首主题"), E("s", "d", "data", "触发"),
      E("d", "e", "data", "是：有配置"), E("d", "e2", "data", "否：无配置")];
    const txt = P(checkStrict(nodes, edges, "code"));
    expect(txt).not.toContain("锚不可见");   // theme-1 无 targets 也不报锚
    expect(txt).not.toContain("主题节点");   // 主题节点本身到位
  });
});

describe("isCompositionStructure 结构判据(board-content-predicate 单一真源)", () => {
  it("①两 section + 关系边 → true;②两 section 无边 → false;③两条 section 间边但 label 无关系词 → false", async () => {
    const { isCompositionStructure, COMPOSITION_RELATIONS, isContentNode } = await import("../src/board-content-predicate.js");
    expect([...COMPOSITION_RELATIONS]).toEqual(["承接", "递进", "并列", "对照", "因果"]);
    const nodes = [{ id: "s1", kind: "section" }, { id: "s2", kind: "section" }, { id: "n", kind: "note" }];
    // ① 关系边(且允许 label 前后带其它词:「01→02 递进」)
    expect(isCompositionStructure(nodes, [{ from: "s1", to: "s2", label: "01→02 递进" }])).toBe(true);
    expect(isCompositionStructure(nodes, [{ from: "s1", to: "s2", label: "对比后承接上文" }])).toBe(true);
    // ② 两 section 无边
    expect(isCompositionStructure(nodes, [])).toBe(false);
    // ③ 两条 section 间边,label 都无关系词
    expect(isCompositionStructure(nodes, [{ from: "s1", to: "s2", label: "然后" }, { from: "s2", to: "s1", label: "再说" }])).toBe(false);
    // 端点必须两端都是 section:note 参与的边不算
    expect(isCompositionStructure(nodes, [{ from: "s1", to: "n", label: "递进" }])).toBe(false);
    // section 不足 2 个时无论边如何都是 false
    expect(isCompositionStructure([{ id: "s1", kind: "section" }], [{ from: "s1", to: "s1", label: "递进" }])).toBe(false);
    // isContentNode 行为不变(零回归锚):section 无 targets → false,note 带 targets → true
    expect(isContentNode({})).toBe(false);
    expect(isContentNode({ targets: ["a.ts"] })).toBe(true);
  });
});
