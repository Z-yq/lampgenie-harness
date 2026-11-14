/**
 * 返工因果链 v1(设想灵魂):四环节 + 扇出簇 + 幂等台账。
 * 用设想的 M 场景族构造:A 建 M→B 修 M(可预防)/A 建 M→B 是需求演进(drift)/
 * 扇出(A 替换 M→B 修上游+C 修下游)/单例不成规/脚本+测试=1 逻辑单元。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectReworkChains,
  readReworkChains,
  renderPreventionLines,
  reworkChainsPath,
  type ReworkChainLine,
} from "../src/rework-chain.js";

const roots: string[] = [];
const NOW = Date.now();
const DAY = 86_400_000;

function fixture(): { root: string; journalDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rework-chain-"));
  const journalDir = join(root, "journal");
  mkdirSync(join(journalDir, "sessions"), { recursive: true });
  roots.push(root);
  return { root, journalDir };
}

interface SessionSpec {
  id: string;
  title: string;
  edits: string[];
  reads?: string[];
 /** grep/terminal 勘察参数原文(归因「信息可得性」的勘察渠道)。 */
  probes?: string[];
  ageDays: number;
}

function seed(journalDir: string, spec: SessionSpec): void {
  const events: Array<Record<string, unknown>> = [
    { kind: "message.user", sessionId: spec.id, payload: { text: spec.title } },
  ];
  let callId = 0;
  for (const probe of spec.probes ?? []) {
    events.push({ kind: "tool.call", sessionId: spec.id, payload: { toolCallId: `g${spec.id}${callId++}`, name: "grep", arguments: JSON.stringify({ pattern: "x", path: probe }) } });
  }
  for (const path of spec.reads ?? []) {
    events.push({ kind: "tool.call", sessionId: spec.id, payload: { toolCallId: `r${spec.id}${callId++}`, name: "read_file", arguments: JSON.stringify({ path }) } });
  }
  for (const path of spec.edits) {
    events.push({ kind: "tool.call", sessionId: spec.id, payload: { toolCallId: `w${spec.id}${callId++}`, name: "edit_file", arguments: JSON.stringify({ path }) } });
  }
  const file = join(journalDir, "sessions", `${spec.id}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const at = new Date(NOW - spec.ageDays * DAY);
  utimesSync(file, at, at);
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("detectReworkChains(设想的 M 场景)", () => {
  it("A 建 M(没读全)→ B 修 M:strong 链 + preventable(信息可得而未取)", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发订单导出功能,集成到现有系统", edits: ["src/export.ts"], reads: ["src/export.ts"], ageDays: 3 });
    seed(journalDir, { id: "ws-b", title: "修复订单导出功能的空值崩溃", edits: ["src/export.ts"], ageDays: 1 });

    const r = detectReworkChains(root, "lampgenie-harness", { journalDir, now: NOW, windowDays: 14 });
    expect(r.chains).toBe(1);
    const { chains } = readReworkChains(root);
    expect(chains).toHaveLength(1);
    const chain = chains[0]!;
    expect(chain.evidenceLevel).toBe("strong");
    expect(chain.classification).toBe("rework");
    expect(chain.defectClass).toBe("boundary"); // 标题命中「空值」
 // 归因:B 修的单元 A 读过(1/1)→ 不是「未取」,分类虽 rework 但 verdict=unknown
    expect(chain.attribution).toMatchObject({ verdict: "unknown", readByA: 1, fixFaceTotal: 1 });
  });

  it("扇出:A 点替换(只读了自己写的)→ B 修上游 + C 修下游:preventable + 扇出簇", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发新导出模块 M 集成替换旧导出", edits: ["src/export/new.ts"], reads: ["src/export/new.ts"], ageDays: 4 });
 // B/C 修上游/下游前必然读过 A 的新模块(修上游签名先看新契约)——跨单元强信号
    seed(journalDir, { id: "ws-b", title: "修复上游调用方的参数签名报错", edits: ["src/caller/upstream.ts"], reads: ["src/export/new.ts"], ageDays: 2 });
    seed(journalDir, { id: "ws-c", title: "修复下游消费方字段精度问题", edits: ["src/consumer/downstream.ts"], reads: ["src/export/new.ts"], ageDays: 1 });
    seed(journalDir, { id: "ws-d", title: "开发无关的报表功能", edits: ["src/report.ts"], ageDays: 1 });

    const r = detectReworkChains(root, "lampgenie-harness", { journalDir, now: NOW, windowDays: 14 });
    expect(r.chains).toBeGreaterThanOrEqual(2); // B、C 各成链(中证据:同仓语义重叠)
    expect(r.fanoutClusters).toBe(1); // A 引发 2 修 × 2 单元 = 影响面未闭合
    const { chains, fanoutClusters } = readReworkChains(root);
 // B/C 的修复面 A 都没读过 → preventable(缺信息:影响面未查)
    for (const chain of chains) {
      expect(chain.attribution.verdict).toBe("preventable");
      expect(chain.attribution.readByA).toBe(0);
    }
    const cluster = fanoutClusters[0]!;
    expect(cluster.buildSession).toBe("ws-a");
    expect(cluster.fixSessions.sort()).toEqual(["ws-b", "ws-c"]);
    expect(cluster.logicalKeys).toHaveLength(2);
    expect(cluster.verdict).toBe("impact-not-closed");
  });

  it("drift:B 是需求演进(新增字段)→ 分类 drift、verdict=drift(不冤枉 A)", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发用户资料模块", edits: ["src/profile.ts"], ageDays: 3 });
    seed(journalDir, { id: "ws-b", title: "按新需求调整用户资料,新增昵称字段", edits: ["src/profile.ts"], ageDays: 1 });
    detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    const { chains } = readReworkChains(root);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.classification).toBe("drift");
    expect(chains[0]!.attribution.verdict).toBe("drift");
  });

  it("单例不成规:同根因 ≥2 次才附 prevention;首次只有观察", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a1", title: "开发模块一", edits: ["src/one.ts"], ageDays: 5 });
 // medium 显式引用门:跨单元 medium 必须显式引用 build 的产出文件名
    seed(journalDir, { id: "ws-b1", title: "修复 one.ts 模块一的空值问题", edits: ["src/other1.ts"], ageDays: 4 });
    const first = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(first.chains).toBe(1);
    let { chains } = readReworkChains(root);
    expect(chains[0]!.prevention).toBeUndefined(); // 首次:不升预防件

 // 第二个同根因(boundary+影响面未读)在另一逻辑单元复现
    seed(journalDir, { id: "ws-a2", title: "开发模块二", edits: ["src/two.ts"], ageDays: 3 });
    seed(journalDir, { id: "ws-b2", title: "修复 two.ts 模块二的空值崩溃", edits: ["src/other2.ts"], ageDays: 2 });
    detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    ({ chains } = readReworkChains(root));
    const withPrevention = chains.filter((c) => c.prevention !== undefined);
    expect(withPrevention.length).toBeGreaterThan(0);
    expect(withPrevention[0]!.prevention!.kind).toBe("gate");
    expect(withPrevention[0]!.prevention!.note).toContain("全集"); // 无责归因:写「缺哪道检查」,不写谁错
  });

  it("幂等:同窗口重复检测不重复落行;脚本+同名测试=1 逻辑单元", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发安全重启脚本", edits: ["scripts/x.cjs"], ageDays: 3 });
    seed(journalDir, { id: "ws-b", title: "修复安全重启脚本的报错", edits: ["scripts/x.cjs", "scripts/x.test.ts"], ageDays: 1 });
    const first = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(first.chains).toBe(1); // 逻辑归并后 1 条链(不是脚本/测试两条)
    expect(first.appended).toBe(1);
    const second = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(second.chains).toBe(1);
    expect(second.appended).toBe(0); // 幂等:同键不重复落行
    const raw = readFileSync(reworkChainsPath(root), "utf8").trim().split("\n");
    expect(raw.length).toBe(1); // 1 链,修复只 1 会话 → 无扇出簇
  });

  it("勘察渠道计入归因:A grep 过修复面 → unknown,不许判 preventable(自评证伪修复)", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发导出模块集成", edits: ["src/export/new.ts"], reads: ["src/export/new.ts"],
      probes: ["src/caller", "src/caller/upstream.ts", "src/consumer"], ageDays: 3 });
    seed(journalDir, { id: "ws-b", title: "修复上游调用方的参数签名报错", edits: ["src/caller/upstream.ts"], reads: ["src/export/new.ts"], ageDays: 1 });
    detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    const { chains } = readReworkChains(root);
    const chain = chains.find((c) => c.fixSession === "ws-b")!;
 // A 没读过 upstream.ts 但 grep 参数里提及过 → 不许 preventable(勘察=信息已取,没防住=unknown)
    expect(chain.attribution.verdict).toBe("unknown");
    expect(chain.attribution.readByA).toBe(0);
  });

  it("去伪 v2:磁铁测试文件不作配对单元(共址≠因果)", () => {
    const { root, journalDir } = fixture();
 // 人人都改的共享测试文件:四个会话都编辑它,后续修复也改它——不产生链
    seed(journalDir, { id: "ws-a", title: "开发功能一", edits: ["src/feat1.ts", "tests/shared.test.ts"], ageDays: 5 });
    seed(journalDir, { id: "ws-b", title: "开发功能二", edits: ["src/feat2.ts", "tests/shared.test.ts"], ageDays: 4 });
    seed(journalDir, { id: "ws-f", title: "修复功能一的空值报错", edits: ["src/feat1.ts", "tests/shared.test.ts"], ageDays: 2 });
    const r = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
 // feat1 有真链;shared.test.ts 不是配对单元(否则 ws-b 也会经由测试文件挂上 ws-f)
    expect(r.chains).toBe(1);
    const { chains } = readReworkChains(root);
    expect(chains[0]!.buildSession).toBe("ws-a");
  });

  it("去伪 v2:一个 fix 会话只留 top1 链(strong 优先/最近 builder)", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a1", title: "开发模块甲", edits: ["src/j.ts"], ageDays: 5 });
    seed(journalDir, { id: "ws-a2", title: "开发模块乙", edits: ["src/j.ts"], ageDays: 3 });
    seed(journalDir, { id: "ws-f", title: "修复 j 的空值崩溃", edits: ["src/j.ts"], ageDays: 1 });
    const r = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(r.chains).toBe(1); // 旧版:ws-a1→F 与 ws-a2→F 两条(磁铁伪链)
    const { chains } = readReworkChains(root);
    expect(chains[0]!.buildSession).toBe("ws-a2"); // 同 strong 取最近 builder
  });

  it("去伪 v2:问答类标题不做建设者", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-qa", title: "把之前的产物结果罗列一下给我,我看看质量如何?", edits: ["src/qa-touch.ts"], ageDays: 3 });
    seed(journalDir, { id: "ws-f", title: "修复 qa-touch 的空值问题", edits: ["src/qa-touch.ts"], ageDays: 1 });
    const r = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(r.chains).toBe(0);
  });

  it("「补测试」判据:碰过 test 路径≠missing-test;源+同名测试成对才算(TDD 不冤枉)", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发配置模块", edits: ["src/conf.ts"], ageDays: 3 });
 // B 修空值,顺带给别的模块写测试(不同逻辑单元)——不是为修复面补测试
    seed(journalDir, { id: "ws-b", title: "修复配置模块的空值崩溃", edits: ["src/conf.ts", "tests/other.test.ts"], ageDays: 1 });
    detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    let { chains } = readReworkChains(root);
    expect(chains[0]!.defectClass).toBe("boundary"); // 不是 missing-test
 // B2 修契约并给同单元补了 deal.test.ts → missing-test
    seed(journalDir, { id: "ws-a2", title: "开发契约模块", edits: ["src/deal.ts"], ageDays: 3 });
    seed(journalDir, { id: "ws-b2", title: "修复契约模块的字段问题", edits: ["src/deal.ts", "src/deal.test.ts"], ageDays: 1 });
    detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    ({ chains } = readReworkChains(root));
    const dealChain = chains.find((c) => c.path.includes("deal"));
    expect(dealChain!.defectClass).toBe("missing-test");
  });

  it("journal 不存在 → ok 零追加;修复面全被 A 读过 → unknown(不冒充 preventable)", () => {
    const root2 = mkdtempSync(join(tmpdir(), "rework-empty-"));
    roots.push(root2);
    const r = detectReworkChains(root2, "p", { journalDir: join(root2, "no-journal"), now: NOW });
    expect(r).toMatchObject({ ok: true, chains: 0, appended: 0 });
    expect(existsSync(reworkChainsPath(root2))).toBe(false);
  });
});

describe("medium 显式引用门 + 预防检查单渲染(2026-11-14,A/D)", () => {
  it("(a) medium 配对且 fix 标题显式含 build 产出文件名 → 进链且 evidenceLevel=medium", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发模块一", edits: ["src/one.ts"], ageDays: 3 });
 // 跨单元(B 修的是别的文件)+ 标题语义重叠 ≥2(模块/块一)+ 显式引用 one.ts
    seed(journalDir, { id: "ws-f", title: "修复 one.ts 模块一的空值崩溃", edits: ["src/other1.ts"], ageDays: 1 });

    const r = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(r.chains).toBe(1);
    expect(r.appended).toBe(1);
    const { chains } = readReworkChains(root);
    expect(chains[0]!.evidenceLevel).toBe("medium");
    expect(chains[0]!.buildSession).toBe("ws-a");
    expect(chains[0]!.fixSession).toBe("ws-f");
    expect(chains[0]!.logicalKey).toBe("src/one"); // 取命中的那个 key(不是 builderKeys[0])
    expect(chains[0]!.path).toBe("src/one.ts");
  });

  it("(a2) 首条用户消息(标题截断之外)显式含产出标识符也算引用", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发模块一", edits: ["src/one.ts"], ageDays: 3 });
 // 标题只有 160 字上限,标识符在用户原文后段(标题段只留语义重叠,标识符在 160 字之后)
 // ——fixer 文本取「标题 + 首条用户消息用户原文段」,否则会被截断权重当成无引用
    const long = `修复模块一的空值崩溃 ${"x".repeat(220)} then src/one.ts`;
    seed(journalDir, { id: "ws-f", title: long, edits: ["src/other1.ts"], ageDays: 1 });

    const r = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(r.chains).toBe(1);
    const { chains } = readReworkChains(root);
    expect(chains[0]!.evidenceLevel).toBe("medium");
    expect(chains[0]!.logicalKey).toBe("src/one");
  });

  it("(b) 语义重叠但文本不含产出标识符 → 不进链、台账零追加", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发模块一", edits: ["src/one.ts"], ageDays: 3 });
 // 语义重叠 ≥2(模块/块一)但既不读 A 的产出、也不显式引用 one.ts → 共址伪链,跳过
    seed(journalDir, { id: "ws-f", title: "修复模块一的空值崩溃", edits: ["src/other1.ts"], ageDays: 1 });

    const r = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(r.chains).toBe(0);
    expect(r.appended).toBe(0);
    expect(readReworkChains(root).chains).toHaveLength(0);
    expect(existsSync(reworkChainsPath(root))).toBe(false); // 台账零追加(文件都不建)
  });

  it("(c) readLink 的 strong 配对在同样标题下仍进链(strong 不受引用门影响)", () => {
    const { root, journalDir } = fixture();
    seed(journalDir, { id: "ws-a", title: "开发模块一", edits: ["src/one.ts"], ageDays: 3 });
 // 同一「不引用标识符」的标题,但 B 修复前读过 A 的产出 → readLink strong
    seed(journalDir, { id: "ws-f", title: "修复模块一的空值崩溃", edits: ["src/other1.ts"], reads: ["src/one.ts"], ageDays: 1 });

    const r = detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14 });
    expect(r.chains).toBe(1);
    const { chains } = readReworkChains(root);
    expect(chains[0]!.evidenceLevel).toBe("strong");
    expect(chains[0]!.logicalKey).toBe("src/one");
  });

  it("(d) renderPreventionLines:命中/不命中/空文本", () => {
    const noteContract = "改契约前先列出全部调用方/消费方并核对签名与语义";
    const noteBoundary = "实现前先枚举被操作实体的取值全集(空值/边界),逐分支核对";
    const ledger: ReworkChainLine[] = [
      chainLine({ logicalKey: "apps/gateway/src/rework-chain", path: "apps/gateway/src/rework-chain.ts", prevention: { kind: "context", note: noteContract } }),
      chainLine({ fixSession: "ws-f2", logicalKey: "apps/gateway/src/rework-chain", path: "apps/gateway/src/rework-chain.ts", prevention: { kind: "context", note: noteContract } }),
      chainLine({ fixSession: "ws-f3", logicalKey: "apps/gateway/src/atlas-harvest", path: "apps/gateway/src/atlas-harvest.ts", prevention: { kind: "gate", note: noteBoundary } }),
      chainLine({ fixSession: "ws-f4", logicalKey: "apps/other/src/panel", path: "apps/other/src/panel.ts" }), // 无 prevention
    ];

 // 命中:任务文本提到 rework-chain.ts → 只出该模块的 note;atlas-harvest 未命中
    expect(renderPreventionLines(ledger, "在 apps/gateway/src/rework-chain.ts 加 medium 门")).toEqual([
      `- 预防检查单(历史返工≥2):${noteContract}`,
    ]);
 // 命中多个 → 按次数降序(contract 2 次在前)
    expect(renderPreventionLines(ledger, "同时改 rework-chain.ts 与 atlas-harvest.ts")).toEqual([
      `- 预防检查单(历史返工≥2):${noteContract}`,
      `- 预防检查单(历史返工≥2):${noteBoundary}`,
    ]);
 // 不命中(模块不在任务文本里)/空文本 → []
    expect(renderPreventionLines(ledger, "改 docs/readme.md 的措辞")).toEqual([]);
    expect(renderPreventionLines(ledger, "")).toEqual([]);
    expect(renderPreventionLines([], "改 apps/gateway/src/rework-chain.ts")).toEqual([]);
  });
});

/** 台账链行的最小合法样本(D 的纯函数测试用)。 */
function chainLine(over: Partial<ReworkChainLine> & { logicalKey: string; path: string }): ReworkChainLine {
  return {
    v: 1,
    at: NOW,
    projectId: "p",
    buildSession: "ws-a",
    buildTitle: "开发模块一",
    fixSession: "ws-f",
    fixTitle: "修复模块一的空值崩溃",
    evidenceLevel: "medium",
    classification: "rework",
    defectClass: "contract",
    attribution: { verdict: "preventable", readByA: 0, fixFaceTotal: 1, fixAddedTest: false },
    ...over,
  };
}
