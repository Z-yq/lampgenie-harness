/** 板型画像引擎单测(2026-10-26):13 类非 page 板型的阶段/角色/硬规则徽标/flow 分支。
 * 纯函数零 IO;不依赖盘上板文件。 */
import { describe, it, expect } from "vitest";
import BTP from "../src/assets/board-type-profile.js";

const N = (over: Record<string, unknown> = {}) => ({
  id: "n", kind: "module", label: "节点", summary: "说明", change: "modify", flow: [], ...over,
}) as never;

describe("board-type-profile 板型画像", () => {
  it("12 类非 UI 板型画像齐全;ui/未知板型返回 null(走 UI 专用渲染)", () => {
    expect(Object.keys(BTP.PROFILES).sort()).toEqual([
      "code", "composition", "contract", "data", "deploy", "docs", "fault", "orchestration", "perf", "refactor", "research", "test",
    ]);
    expect(BTP.profileOf({ boardType: "fault" })).toBeTruthy();
    expect(BTP.profileOf({ boardType: "ui" })).toBeNull();
    expect(BTP.profileOf({})).toBeNull();
  });

  it("fault:六段阶段可识别,缺段可见,根因/证据徽标可读", () => {
    const p = BTP.profileOf({ boardType: "fault" });
    const nodes = [
      N({ id: "repro", label: "复现条件", group: "01 复现" }),
      N({ id: "obs", label: "观测异常点", group: "02 异常点", summary: "日志 trace" }),
      N({ id: "hyp", label: "候选假设 A", group: "03 假设" }),
      N({ id: "root", label: "根因:全量重放阻塞事件循环", group: "04 根因", evidence: [{ at: "x", cmd: "log", expect: "grep" }] }),
      N({ id: "fix", label: "修复:异步分片", group: "05 修复" }),
    ];
    const s = BTP.summaryOf({ boardType: "fault", scale: "M", nodes, edges: [] }, null);
    expect(s.stages.map((x: { label: string }) => x.label)).toEqual(["复现条件", "观测异常", "候选假设", "根因", "修复点", "防复发"]);
    expect(s.missing).toEqual(["防复发"]);
    expect(BTP.stageOf(nodes[3], p)!.label).toBe("根因");
    const badges = BTP.badgesOf(nodes[3], p, { boardType: "fault" }, []);
    expect(badges.some((b: { text: string }) => b.text === "根因")).toBe(true);
    expect(badges.some((b: { text: string }) => b.text === "证据")).toBe(true);
  });

  it("code:上游/下游/测试边计数 + flow if/else 展开", () => {
    const p = BTP.profileOf({ boardType: "code" });
    const chg = N({
      id: "chg", label: "新增分支", group: "02 变更",
      flow: [{ type: "branch", cond: "x > 0", then: [{ type: "step", text: "走 A" }], else: [{ type: "step", text: "走 B" }] }],
    });
    const edges = [
      { from: "caller", to: "chg", kind: "call", label: "caller→chg" },
      { from: "chg", to: "callee", kind: "call", label: "chg→callee" },
      { from: "chg", to: "test1", kind: "verify", label: "测试:断言" },
    ];
    const b = BTP.badgesOf(chg, p, { boardType: "code" }, edges);
    expect(b.some((x: { text: string }) => x.text === "上游 1")).toBe(true);
    expect(b.some((x: { text: string }) => x.text === "下游 1")).toBe(true);
    expect(b.some((x: { text: string }) => x.text === "测试 1")).toBe(true);
    expect(BTP.flowLines(chg, 2).join(" ")).toContain("if x > 0");
    expect(BTP.flowLines(chg, 2).join(" ")).toContain("走 B");
  });

  it("test:数据分区/判定/断言;perf/data/contract/deploy/research/orchestration 有专属徽标", () => {
    const t = BTP.profileOf({ boardType: "test" });
    const tn = N({ id: "d", kind: "io", label: "边界空板", summary: "异常缺状态", group: "01 测试数据", flow: [] });
    const tb = BTP.badgesOf(tn, t, { boardType: "test" }, []).map((x: { text: string }) => x.text);
    expect(tb).toContain("边界");
    expect(tb).toContain("异常");

    const perf = BTP.badgesOf(N({ label: "基线 P95 850ms", summary: "目标 P95 ≤ 300ms" }), BTP.profileOf({ boardType: "perf" }), { boardType: "perf" }, []);
    expect(perf.some((x: { text: string }) => /850ms|300ms/.test(x.text))).toBe(true);

    const data = BTP.badgesOf(N({ label: "dry-run", summary: "幂等 upsert" }), BTP.profileOf({ boardType: "data" }), { boardType: "data" }, []);
    expect(data.some((x: { text: string }) => x.text === "dry-run")).toBe(true);
    expect(data.some((x: { text: string }) => x.text === "幂等")).toBe(true);

    const contract = BTP.badgesOf(N({ label: "版本策略", summary: "弃用至 2026-12-31;消费者 panel" }), BTP.profileOf({ boardType: "contract" }), { boardType: "contract" }, []);
    expect(contract.some((x: { text: string }) => x.text.indexOf("弃用 2026-12-31") === 0)).toBe(true);

    const deploy = BTP.badgesOf(N({ label: "preflight", summary: "smoke 冒烟;回滚" }), BTP.profileOf({ boardType: "deploy" }), { boardType: "deploy" }, []);
    expect(deploy.map((x: { text: string }) => x.text)).toEqual(expect.arrayContaining(["preflight", "smoke", "回滚"]));

    const research = BTP.badgesOf(N({ label: "候选A", summary: "成本 30% 证据 file:a.ts" }), BTP.profileOf({ boardType: "research" }), { boardType: "research" }, []);
    expect(research.map((x: { text: string }) => x.text)).toEqual(expect.arrayContaining(["候选", "权重", "证据"]));

    const orch = BTP.badgesOf(N({ kind: "agent", label: "worker", summary: "输入/输出 schema;工具面;timeout;retry;fan-in 回收" }), BTP.profileOf({ boardType: "orchestration" }), { boardType: "orchestration" }, []);
    expect(orch.map((x: { text: string }) => x.text)).toEqual(expect.arrayContaining(["agent", "IO", "工具面", "timeout", "retry", "回收"]));
  });

  it("code flow:有 start/end 时切流程阶段(触发/步骤/判断/终点),不套现状层/变更层", () => {
    const flowDoc = {
      boardType: "code",
      nodes: [
        N({ id: "s", kind: "start", label: "安装插件", group: "01 入口 installPlugin()" }),
        N({ id: "f", kind: "function", label: "读取 plugin.json", group: "01 入口 installPlugin()" }),
        N({ id: "d", kind: "decision", label: "带技能?", group: "02 register()" }),
        N({ id: "e", kind: "end", label: "聊天窗可用", group: "03 结果" }),
        N({ id: "i", kind: "note", label: "影响面:上游 caller", group: "05 影响面" }),
        N({ id: "v", kind: "note", label: "验收:安装→选中", group: "06 验收" }),
      ],
      edges: [],
    };
    const p = BTP.profileOf(flowDoc as never)!;
    expect(p.label).toBe("代码流程");
    expect(p.stages.map((x: { key: string }) => x.key)).toEqual(["start", "step", "decision", "end", "impact", "verify"]);
    // 方法组名里含「入口」:kind=function 必须仍是步骤,不能被组名别名算成触发
    expect(BTP.stageOf(flowDoc.nodes[1] as never, p)!.label).toBe("步骤");
    expect(BTP.stageOf(flowDoc.nodes[2] as never, p)!.label).toBe("判断");
    const s = BTP.summaryOf(flowDoc as never, null);
    expect(s.missing).toEqual([]);
    expect(s.stages.map((x: { count: number }) => x.count)).toEqual([1, 1, 1, 1, 1, 1]);
    // 契约板(无 start/end)仍走原 code 画像
    expect(BTP.profileOf({ boardType: "code", nodes: [N()] } as never)!.label).toBe("代码开发");
  });

  it("test flow:测试任务接入 code flow,画像切测试流程阶段(夹具/被测段/失败定位/判定/回归)", () => {
    const flowDoc = {
      boardType: "test",
      nodes: [
        N({ id: "s", kind: "start", label: "运行 spec", group: "01 夹具" }),
        N({ id: "f", kind: "function", label: "准备插件夹具", group: "01 夹具", summary: "正常输入 mkPlugin" }),
        N({ id: "c", kind: "function", label: "PluginSystem.install 落盘", group: "02 被测链路", summary: "被测:写真实落点" }),
        N({ id: "d", kind: "decision", label: "断言:候选含 hi?", group: "03 断言" }),
        N({ id: "e", kind: "end", label: "通过:候选可见", group: "03 断言" }),
        N({ id: "x", kind: "end", label: "红灯→三步定位", group: "04 失败定位" }),
        N({ id: "r", kind: "note", label: "回归锚", group: "05 回归锚" }),
      ],
      edges: [],
    };
    const p = BTP.profileOf(flowDoc as never)!;
    expect(p.label).toBe("测试流程");
    expect(p.stages.map((x: { key: string }) => x.key)).toEqual(["fixture", "code", "fail", "judge", "reg"]);
    const s = BTP.summaryOf(flowDoc as never, null);
    expect(s.missing).toEqual([]);
    // 六段契约(无 start/end)仍走原 test 画像
    expect(BTP.profileOf({ boardType: "test", nodes: [N()] } as never)!.label).toBe("测试");
  });

  it("perf flow:有 start/end 时切性能流程阶段(触发/采样基线/定位瓶颈/改动/复测/判定)", () => {
    const flowDoc = {
      boardType: "perf",
      nodes: [
        N({ id: "s", kind: "start", label: "触发:GET /api/list", group: "01 触发" }),
        N({ id: "b", kind: "function", label: "采样基线 bench P95=850ms", group: "02 采样基线" }),
        N({ id: "h", kind: "function", label: "定位瓶颈 火焰图", group: "03 定位瓶颈" }),
        N({ id: "c", kind: "function", label: "改 opts 深比较", group: "04 改动" }),
        N({ id: "r", kind: "function", label: "复测 P95", group: "05 复测" }),
        N({ id: "d", kind: "decision", label: "达标?", group: "06 判定" }),
        N({ id: "e", kind: "end", label: "收工:门禁固化", group: "06 判定" }),
      ],
      edges: [],
    };
    const p = BTP.profileOf(flowDoc as never)!;
    expect(p.label).toBe("性能优化流程");
    expect(p.stages.map((x: { key: string }) => x.key)).toEqual(["start", "baseline", "bottleneck", "change", "retest", "verdict"]);
    const names = p.stages.map((x: { label: string }) => x.label).join("/");
    expect(names).toContain("采样");
    expect(names).toContain("复测");
    // kind 兜底与 code flow 同构:start=触发,end/decision=判定(终点),function=改动(步骤)
    expect(BTP.stageOf(flowDoc.nodes[0] as never, p)!.label).toBe("触发");
    expect(BTP.stageOf(flowDoc.nodes[1] as never, p)!.label).toBe("采样基线");
    expect(BTP.stageOf(flowDoc.nodes[2] as never, p)!.label).toBe("定位瓶颈");
    expect(BTP.stageOf(flowDoc.nodes[3] as never, p)!.label).toBe("改动");
    expect(BTP.stageOf(flowDoc.nodes[4] as never, p)!.label).toBe("复测");
    expect(BTP.stageOf(flowDoc.nodes[5] as never, p)!.label).toBe("判定");
    expect(BTP.stageOf(flowDoc.nodes[6] as never, p)!.label).toBe("判定");
    const s = BTP.summaryOf(flowDoc as never, null);
    expect(s.missing).toEqual([]);
    expect(s.stages.map((x: { count: number }) => x.count)).toEqual([1, 1, 1, 1, 1, 2]);
    // 无 start/end/decision/flow 步骤的旧 perf 三卡板 → 仍走原性能画像(不回归)
    const oldPerf = {
      boardType: "perf",
      nodes: [
        N({ id: "a", label: "基线 P95 850ms", group: "01 基线" }),
        N({ id: "b", label: "热点函数 opts 深比较", group: "02 瓶颈" }),
        N({ id: "c", label: "灰度门禁", group: "05 门禁" }),
      ],
      edges: [],
    };
    const po = BTP.profileOf(oldPerf as never)!;
    expect(po.label).toBe("性能优化");
    expect(po.stages.map((x: { key: string }) => x.key)).toEqual(["baseline", "bottleneck", "change", "target", "gate"]);
  });

  it("板型头摘要:规模/边 label/分支/证据计数可见", () => {
    const s = BTP.summaryOf({
      boardType: "code",
      nodes: [N({ id: "a", group: "01 现状" }), N({ id: "b", group: "02 变更", flow: [{ type: "branch", cond: "x", then: [], else: [] }], evidence: [{ at: "x" }] })],
      edges: [{ from: "a", to: "b", kind: "call" }],
    }, null);
    expect(s.scaleMissing).toBe(true);
    expect(s.unlabeledEdges).toBe(1);
    expect(s.branches).toBe(1);
    expect(s.evidenceNodes).toBe(1);
    expect(s.missing).toContain("影响面");
  });
});

describe("板型阶段消歧(文档章节/研究矩阵)", () => {
  it("docs:两层结构 kind 定层(page=页,section=章),证据/行动按词归位", () => {
    const d = {
      boardType: "docs",
      nodes: [
        N({ id: "v", kind: "aggregate", label: "结论:采用方案A", group: "00 结论" }),
        N({ id: "q", kind: "section", label: "02 为什么需要变更契约图", group: "01 章节" }),
        N({ id: "p", kind: "page", label: "耦合是主要风险", group: "01 章节", summary: "证据 app.py:44" }),
        N({ id: "a", kind: "note", label: "行动:先补板再实施", group: "02 行动" }),
      ],
      edges: [],
    };
    const s = BTP.summaryOf(d as never, null);
    expect(s.stages.find((x: { key: string }) => x.key === "chapter")!.count).toBe(1);
    expect(s.stages.find((x: { key: string }) => x.key === "page")!.count).toBe(1);
    expect(s.stages.find((x: { key: string }) => x.key === "action")!.count).toBe(1);
  });

  it("research:矩阵节点不被「候选」字面吃掉;候选/矩阵/证据/结论各 1", () => {
    const d = {
      boardType: "research",
      nodes: [
        N({ id: "a", label: "候选A 手写", summary: "证据 file:a.ts", group: "01 候选" }),
        N({ id: "m", kind: "section", label: "决策矩阵:候选×维度", summary: "权重", group: "02 评估" }),
        N({ id: "e", label: "证据:实测 2026-10-26", group: "02 评估" }),
        N({ id: "v", kind: "decision", label: "结论:推荐A 放弃B", group: "03 结论" }),
      ],
      edges: [],
    };
    const s = BTP.summaryOf(d as never, null);
    for (const key of ["candidate", "matrix", "evidence", "verdict"]) {
      expect(s.stages.find((x: { key: string }) => x.key === key)!.count, key).toBe(1);
    }
  });

  it("composition:section→章节段、受众/主题各归其段;章节边关系词出 chip、缺关系词给 warn", () => {
    const p = BTP.profileOf({ boardType: "composition" });
    expect(p.label).toBe("作业思路");
    expect(p.stages.map((x: { key: string }) => x.key)).toEqual(["theme", "audience", "structure", "chapter", "relation"]);
    // stageOf:section 节点 → chapter 段(即使 label 里有「主题」字面)
    expect(BTP.stageOf(N({ kind: "section", label: "01 主题为什么是现在" }), p).key).toBe("chapter");
    expect(BTP.stageOf(N({ kind: "note", label: "主题", summary: "迁移收益 > 停机成本" }), p).key).toBe("theme");
    expect(BTP.stageOf(N({ kind: "note", label: "读者", summary: "受众:技术负责人(关心停机)" }), p).key).toBe("audience");

    const d = {
      boardType: "composition",
      nodes: [
        N({ id: "t1", kind: "note", change: "keep", label: "主题", summary: "迁移收益 > 停机成本" }),
        N({ id: "t2", kind: "note", change: "keep", label: "受众", summary: "受众:技术负责人(关心停机)" }),
        N({ id: "s1", kind: "section", change: "keep", label: "01 为什么要迁", summary: "现状成本超预算" }),
        N({ id: "s2", kind: "section", change: "keep", label: "02 怎么迁", summary: "双写 3 周零停机" }),
      ],
      edges: [
        { from: "s1", to: "s2", kind: "data", label: "递进" },
        { from: "s2", to: "s1", kind: "data", label: "" },
      ],
    };
    const s = BTP.summaryOf(d as never, null);
    expect(s.stages.find((x: { key: string }) => x.key === "chapter")!.count).toBe(2);
    expect(s.stages.find((x: { key: string }) => x.key === "theme")!.count).toBe(1);
    const s1 = N({ id: "s1", kind: "section", change: "keep", label: "01 为什么要迁", summary: "现状成本超预算" });
    const s2 = N({ id: "s2", kind: "section", change: "keep", label: "02 怎么迁", summary: "双写 3 周零停机" });
    const sb = BTP.badgesOf(s1, p, d, d.edges).map((x: { text: string }) => x.text);
    expect(sb).toContain("递进");
    const warn = BTP.badgesOf(s2, p, d, d.edges).filter((x: { tone: string }) => x.tone === "warn").map((x: { text: string }) => x.text);
    expect(warn.some((t: string) => t.indexOf("缺关系词") === 0)).toBe(true);
  });
});

describe("board-type-profile composition 面板布局(composeLayout)", () => {
  const C = (o: Record<string, unknown> = {}) => ({ id: "n", kind: "section", label: "章", summary: "主张", change: "keep", ...o }) as never;
  type ComposeNode = { id: string; kind: string; label: string; summary: string };
  // 六问样例:1 主题 + 1 受众 + 1 结构 + 4 章节 + 3 关系边,声明序打乱(验证按序号排,不按声明序)
  const sixQ = {
    boardType: "composition",
    nodes: [
      C({ id: "c3", kind: "section", label: "第3章 风险与对策" }),
      C({ id: "a1", kind: "note", label: "受众", summary: "受众:技术负责人" }),
      C({ id: "c1", kind: "section", label: "第1章 为什么要迁" }),
      C({ id: "st", kind: "decision", label: "结构", summary: "问题-分析-结论" }),
      C({ id: "c4", kind: "section", label: "第4章 收口" }),
      C({ id: "t", kind: "note", label: "主题", summary: "迁移收益>停机成本" }),
      C({ id: "c2", kind: "section", label: "第2章 怎么迁" }),
    ] as ComposeNode[],
    edges: [
      { from: "c1", to: "c2", kind: "data", label: "承接" },
      { from: "c2", to: "c3", kind: "data", label: "递进" },
      { from: "c3", to: "c4", kind: "data", label: "对照" },
    ],
  };
  const lay = (d: unknown) => BTP.composeLayout(d as never);

  it("六问齐全:主题带置顶居中、属性卡不占主列、章节按序号 01→04 横排", () => {
    const r = lay(sixQ);
    expect(r.mode).toBe("flow");
    // 主题 y 全板最小,且横贯章节主列宽度(x 居中段:主题带左缘=主列左缘,宽=主列宽)
    const tp = r.pos.get("t")!;
    const ts = r.size.get("t")!;
    const minY = Math.min(...sixQ.nodes.map((n: { id: string }) => r.pos.get(n.id)!.y));
    expect(tp.y).toBe(minY);
    const chXs = ["c1", "c2", "c3", "c4"].map((id) => r.pos.get(id)!.x);
    expect(tp.x + ts.w).toBeGreaterThan(chXs[0]);
    expect(tp.x).toBeLessThan(chXs[3] + 228); // 主题带横跨整个章节列区间
    // 受众/结构进属性 lane(不在章节主列),章节 lane key=chapters
    expect(r.laneOf.get("a1")).toBe("attrs");
    expect(r.laneOf.get("st")).toBe("attrs");
    expect(r.laneOf.get("c1")).toBe("chapters");
    const attrLane = r.lanes.find((l: { key: string }) => l.key === "attrs")!;
    expect(attrLane.label).toContain("受众·结构");
    expect(attrLane.nodes).toContain("a1");
    expect(attrLane.nodes).toContain("st");
    // 章节按序号 01→04:x 严格递增(mainPath 同序)
    expect(r.mainPath).toEqual(["c1", "c2", "c3", "c4"]);
    expect(chXs.every((v, i) => i === 0 || v > chXs[i - 1])).toBe(true);
    // 章间 data 边全部进 mainEdges(主线高亮);entry/exit=首末章
    for (const e of sixQ.edges) expect(r.mainEdges.has(e.from + ">" + e.to)).toBe(true);
    expect(r.entry).toBe("c1");
    expect(r.exit).toBe("c4");
  });

  it("产出字段齐全且与 BoardFlowLayout 同形(lanes/laneOf/no/mainNodes/bounds/pos/size)", () => {
    const r = BTP.composeLayout(sixQ);
    for (const k of ["mode", "pos", "size", "lanes", "laneOf", "no", "mainNodes", "mainEdges", "backEdges", "mainPath", "entry", "exit", "isolated", "orphanCount", "bounds"]) {
      expect(r).toHaveProperty(k);
    }
    expect(r.pos.size).toBe(sixQ.nodes.length); // 节点一个不丢
    expect(r.no.size).toBe(sixQ.nodes.length); // 编号 01..N 连续覆盖
    expect([...r.no.values()]).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
    const b = r.bounds;
    for (const n of sixQ.nodes) {
      const p = r.pos.get(n.id)!, s = r.size.get(n.id)!;
      expect(p.x + s.w).toBeLessThanOrEqual(b.x + b.w + 1); // bounds 覆盖全部节点
      expect(p.y + s.h).toBeLessThanOrEqual(b.y + b.h + 1);
    }
    // 幂等:同输入两次产出一致
    const r2 = lay(sixQ);
    expect(r2.mainPath).toEqual(r.mainPath);
    expect(r2.pos.get("t")).toEqual(r.pos.get("t"));
  });

  it("无序号样例按章间 data 边拓扑序;孤立章节(无边无序号)不丢且殿后", () => {
    const rTopo = BTP.composeLayout({
      boardType: "composition",
      nodes: [
        C({ id: "c1", label: "收口" }), C({ id: "c2", label: "起因" }), C({ id: "c3", label: "展开" }),
      ],
      edges: [
        { from: "c2", to: "c3", kind: "data", label: "递进" },
        { from: "c3", to: "c1", kind: "data", label: "承接" },
      ],
    } as never);
    expect(rTopo.mainPath).toEqual(["c2", "c3", "c1"]); // 拓扑序,不是声明序
    const rIso = BTP.composeLayout({
      boardType: "composition",
      nodes: [
        C({ id: "cA", label: "第1章 开" }), C({ id: "cIso", label: "附:孤立章" }), C({ id: "cB", label: "第2章 承" }),
      ],
      edges: [{ from: "cA", to: "cB", kind: "data", label: "承接" }],
    } as never);
    expect(rIso.isolated).toEqual(["cIso"]);
    expect(rIso.orphanCount).toBe(1);
    expect(rIso.mainPath[rIso.mainPath.length - 1]).toBe("cIso"); // 孤立章节殿后
    expect(rIso.pos.size).toBe(3); // 不丢节点
    expect(rIso.pos.get("cIso")!.x).toBeGreaterThan(rIso.pos.get("cB")!.x); // 摆在主列末尾
  });

  it("label 序号识别覆盖中英形态:第X章 / 01 xxx / 1. / 一、", () => {
    const r = BTP.composeLayout({
      boardType: "composition",
      nodes: [
        C({ id: "ar", label: "1. 展开" }), C({ id: "cn", label: "一、开篇" }),
        C({ id: "nu", label: "03 证据" }), C({ id: "zc", label: "第2章 承接" }),
      ],
      edges: [],
    } as never);
    expect(r.mainPath).toEqual(["ar", "cn", "zc", "nu"]); // 「1.」与「一、」同为 1,tie=声明序(ar 先声明);2 < 3 严格排后
  });
});
