/**
 * 项目世界模型采集器:journal 会话 → derived 层(主题/模块/返工/噪声)
 * + 快照合入 + 开工方向简报渲染。全部临时目录,不碰仓库 .genie。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAtlas, atlasJsonPath } from "../src/direction-atlas-store.js";
import {
  collectWorkSessions,
  harvestAtlas,
  loadProjectRoots,
  matchedDefectGenes,
  createDefectGeneEditHint,
  refreshAtlasSnapshot,
  renderAtlasStartBrief,
} from "../src/atlas-harvest.js";

const roots: string[] = [];

function fixture(): { root: string; journalDir: string } {
  const root = mkdtempSync(join(tmpdir(), "atlas-harvest-"));
  const journalDir = join(root, "journal");
  mkdirSync(join(journalDir, "sessions"), { recursive: true });
  roots.push(root);
  return { root, journalDir };
}

const NOW = Date.now();
const DAY = 86_400_000;

function session(
  journalDir: string,
  name: string,
  events: Array<Record<string, unknown>>,
  ageDays: number): void {
  const file = join(journalDir, "sessions", `${name}.jsonl`);
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(file, events.length > 0 ? body + "\n" : "", "utf8");
  const at = new Date(NOW - ageDays * DAY);
  utimesSync(file, at, at);
}

function user(text: string, sessionId: string): Record<string, unknown> {
  return { kind: "message.user", sessionId, payload: { text } };
}

function edit(path: string, sessionId: string): Record<string, unknown> {
  return { kind: "tool.call", sessionId, payload: { toolCallId: `c-${path}`, name: "edit_file", arguments: JSON.stringify({ path }) } };
}

function trace(totalTokens: number, sessionId: string): Record<string, unknown> {
  return { kind: "llm.trace", sessionId, payload: { model: "m", usage: { inputTokens: 10, outputTokens: 5, totalTokens } } };
}

function delivery(state: string, sessionId: string): Record<string, unknown> {
  return { kind: "delivery.obligation", sessionId, payload: { taskId: `t-${sessionId}`, state } };
}

/** 会话里绑定 payload.projectId(J 兜底测试用)。 */
function bind(projectId: string, sessionId: string): Record<string, unknown> {
  return { kind: "task.created", sessionId, payload: { taskId: `t-${sessionId}`, projectId } };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("harvestAtlas(derived 层采集)", () => {
  it("主题簇/模块活动/返工信号/噪声过滤/跨项目排除/窗口过滤各就位", () => {
    const { journalDir } = fixture();
    session(journalDir, "ws-build-a", [user("开发订单导出功能,集成到现有系统", "ws-build-a"), edit("src/export.ts", "ws-build-a"), trace(1000, "ws-build-a"), delivery("done", "ws-build-a")], 3);
    session(journalDir, "ws-build-b", [user("继续完善订单导出功能的文档", "ws-build-b"), edit("src/export.ts", "ws-build-b")], 2);
    session(journalDir, "ws-fix-c", [user("修复订单导出功能的空值崩溃", "ws-fix-c"), edit("src/export.ts", "ws-fix-c"), delivery("done", "ws-fix-c")], 1);
    session(journalDir, "rsi", [user("机制任务", "rsi"), edit("x.json", "rsi")], 1);
    session(journalDir, "probe-z", [user("探针", "probe-z")], 1);
    session(journalDir, "ws-other-project", [user("别的项目的订单导出", "ws-other-project"), { kind: "custom", sessionId: "ws-other-project", payload: { projectId: "caad-uuid", type: "bind" } }, edit("other/src/a.ts", "ws-other-project")], 1);
    session(journalDir, "ws-old", [user("很早的订单导出会话", "ws-old"), edit("src/export.ts", "ws-old")], 20);

    const harvest = harvestAtlas(journalDir, "lampgenie-harness", { now: NOW, windowDays: 7 });
 // 噪声:rsi + probe 计入 noiseSessions;窗口外 ws-old 完全不看
    expect(harvest.noiseSessions).toBe(2);
 // 扫描数 = 窗口内非噪声会话(含跨项目,归因后才排除)
    expect(harvest.sessionsScanned).toBe(4);
 // 主题:订单导出 bigram 聚类 ≥2 会话(build-a/build-b;fix-c 也在,同簇)
    expect(harvest.themes.length).toBeGreaterThanOrEqual(1);
    expect(harvest.themes[0]!.sessions).toBeGreaterThanOrEqual(2);
 // 模块:export.ts 被 3 个会话编辑;跨项目的 other/src/a.ts 不在
    const exportModule = harvest.moduleActivity.find((m) => m.path === "src/export.ts");
    expect(exportModule?.editSessions).toBe(3);
    expect(harvest.moduleActivity.some((m) => m.path.includes("other/"))).toBe(false);
 // 返工信号:build(-a/-b 非修复标题)→ fix-c 修复标题,同路径窗口内
    expect(harvest.reworkSignals.length).toBe(1);
    expect(harvest.reworkSignals[0]).toMatchObject({ path: "src/export.ts", buildSession: "ws-build-a" });
    expect(harvest.reworkSignals[0]!.fixSessions).toEqual(["ws-fix-c"]);
  });

  it("主题噪声词被停用(missing/工具/task-phase 不再霸榜);脚本+同名测试=1 返工信号", () => {
    const { journalDir } = fixture();
    for (let k = 0; k < 3; k++) {
      session(journalDir, `ws-mech-${k}`, [user(`#31 机制(missing → implemented)修复第 ${k} 批` + "面板切换", `ws-mech-${k}`), edit("src/panel.ts", `ws-mech-${k}`)], 2);
    }
    session(journalDir, "ws-build-srs", [user("开发安全重启脚本", "ws-build-srs"), edit("scripts/srs.cjs", "ws-build-srs")], 3);
    session(journalDir, "ws-fix-srs", [user("修复安全重启脚本的报错", "ws-fix-srs"), edit("scripts/srs.cjs", "ws-fix-srs"), edit("scripts/srs.test.ts", "ws-fix-srs")], 1);
    const harvest = harvestAtlas(journalDir, "lampgenie-harness", { now: NOW, windowDays: 7 });
    const themeIds = harvest.themes.map((t) => t.id);
    expect(themeIds).not.toContain("missing");
    expect(themeIds).not.toContain("task-phase");
 // 脚本与同名测试逻辑归并:只 1 条返工信号(不是 .cjs 与 .test.ts 两条)
    expect(harvest.reworkSignals).toHaveLength(1);
    expect(harvest.reworkSignals[0]).toMatchObject({ buildSession: "ws-build-srs" });
  });

  it("journal 目录不存在 → 空采集不 throw", () => {
    const harvest = harvestAtlas(join(tmpdir(), "no-such-journal"), "p");
    expect(harvest.themes).toEqual([]);
    expect(harvest.sessionsScanned).toBe(0);
  });
});

describe("refreshAtlasSnapshot(生成闭环)", () => {
  it("curated 事件重放 + derived 合入快照;getAtlas 读回带 derived", () => {
    const { root, journalDir } = fixture();
    session(journalDir, "ws-a", [user("开发面板切换功能", "ws-a"), edit("src/panel.ts", "ws-a")], 1);
    session(journalDir, "ws-b", [user("面板切换功能补测试", "ws-b"), edit("src/panel.ts", "ws-b")], 1);
    const refreshed = refreshAtlasSnapshot(root, "lampgenie-harness", { journalDir, now: NOW });
    expect(refreshed.ok).toBe(true);
    expect(existsSync(atlasJsonPath(root, "lampgenie-harness"))).toBe(true);
    const back = getAtlas(root, "lampgenie-harness");
    expect(back.ok).toBe(true);
    const derived = (back.atlas as { derived?: { themes?: unknown[]; moduleActivity?: unknown[] } }).derived;
    expect(derived).toBeDefined();
    expect((derived!.moduleActivity ?? []).length).toBeGreaterThan(0);
 // 幂等性:再刷一次仍是 ok(derived 覆写,curated 不膨胀)
    const again = refreshAtlasSnapshot(root, "lampgenie-harness", { journalDir, now: NOW });
    expect(again.ok).toBe(true);
    const raw = JSON.parse(readFileSync(atlasJsonPath(root, "lampgenie-harness"), "utf8")) as { goals: unknown[]; derived: { harvestedAt: string } };
    expect(Array.isArray(raw.goals)).toBe(true);
    expect(raw.derived.harvestedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("renderAtlasStartBrief(开工方向简报)", () => {
  it("有内容时:方向/转向/冲突/主题/热点/返工各段;空快照 → 空串", () => {
    const atlas = {
      projectId: "lampgenie-harness",
      goals: [
        { title: "RSI 世界模型闭环", status: "active" },
        { title: "已完成的方向", status: "achieved" },
      ],
      timeline: [{ reason: "从机制验证转向生产闭环" }],
      conflicts: [{ status: "open", detail: "A 与 B 的口径冲突" }],
      derived: {
        themes: [{ id: "面板", sessions: 4, titles: ["改面板切换"] }],
        moduleActivity: [{ path: "src/panel.ts", editSessions: 3 }],
        reworkSignals: [{ path: "src/export.ts", gapMs: 5 * 3_600_000 }],
      },
    };
    const brief = renderAtlasStartBrief(atlas);
    expect(brief).toContain("方向简报");
    expect(brief).toContain("RSI 世界模型闭环");
    expect(brief).not.toContain("已完成的方向"); // 非 active 不进
    expect(brief).toContain("从机制验证转向生产闭环");
    expect(brief).toContain("A 与 B 的口径冲突");
    expect(brief).toContain("本周主题");
    expect(brief).toContain("热点模块:src/panel.ts(3 会话在改)");
    expect(brief).toContain("返工信号:src/export.ts(先建后修 5h)");
    expect(brief.length).toBeLessThanOrEqual(620);
    expect(renderAtlasStartBrief({})).toBe("");
    expect(renderAtlasStartBrief(undefined)).toBe("");
  });

 // defectGenes 消费面:任务文本按文件名匹配 module,命中才出行。
  const geneAtlas = {
    projectId: "lampgenie-harness",
    goals: [{ title: "RSI 世界模型闭环", status: "active" }],
    defectGenes: [
      { id: "g1", defectClass: "contract", module: "apps/gateway/src/panel.ts", count: 2, lastAt: "2026-11-14T00:00:00.000Z" },
      { id: "g2", defectClass: "contract", module: "apps/gateway/src/app.ts", count: 1, lastAt: "2026-11-14T00:00:00.000Z" },
      { id: "g3", defectClass: "boundary", module: "apps/gateway/src/panel.ts", count: 1, lastAt: "2026-11-14T00:00:00.000Z" },
      { id: "g4", defectClass: "performance", module: "apps/gateway/src/panel.ts", count: 9, lastAt: "2026-11-14T00:00:00.000Z" },
    ],
  };

  it("任务文本命中模块且快照有该模块基因 → 出「历史缺陷基因」行与提示语", () => {
    const brief = renderAtlasStartBrief(geneAtlas, "改 apps/gateway/src/panel.ts 的切换逻辑");
    expect(brief).toContain("本模块历史缺陷基因");
 // contract 3(panel.ts 2 + app.ts 1,app.ts 由「apps/gateway/src/app.ts」全路径命中不到 →
 // 该文本只含 panel.ts,故 app.ts 不计;仅同模块两基因:contract×2、boundary×1)
    expect(brief).toContain("- 本模块历史缺陷基因:contract×2——先列出全部调用方/消费方并核对签名与语义");
    expect(brief).toContain("- 本模块历史缺陷基因:boundary×1——先枚举被操作实体的取值全集(空值/边界)逐分支核对");
    expect(brief).not.toContain("performance"); // 未映射类别不出行
  });

  it("任务文本无命中 → 不含「历史缺陷基因」行", () => {
    expect(renderAtlasStartBrief(geneAtlas, "改 README 文案")).not.toContain("历史缺陷基因");
 // 省略第二参(旧调用形态)行为零变化
    expect(renderAtlasStartBrief(geneAtlas)).not.toContain("历史缺陷基因");
  });

  it("基因行加入后简报仍 ≤ BRIEF_MAX_CHARS(600)", () => {
    const longAtlas = {
      ...geneAtlas,
      timeline: [{ reason: "从机制验证转向生产闭环".repeat(4) }],
      conflicts: [{ status: "open", detail: "A 与 B 的口径冲突".repeat(4) }],
      derived: {
        themes: [{ id: "面板", sessions: 4, titles: ["改面板切换".repeat(5)] }],
        moduleActivity: [{ path: "src/panel.ts", editSessions: 3 }],
        reworkSignals: [{ path: "src/export.ts", gapMs: 5 * 3_600_000 }],
      },
    };
    const brief = renderAtlasStartBrief(longAtlas, "改 panel.ts");
    expect(brief).toContain("历史缺陷基因");
    expect(brief.length).toBeLessThanOrEqual(600);
  });
});

describe("matchedDefectGenes(2026-11-14 选择器抽取)", () => {
  const atlas = {
    defectGenes: [
      { id: "g1", defectClass: "contract", module: "apps/gateway/src/panel.ts", count: 2 },
      { id: "g2", defectClass: "boundary", module: "apps/gateway/src/panel.ts", count: 3 },
      { id: "g3", defectClass: "contract", module: "apps/gateway/src/panel.ts", count: 4 },
      { id: "g4", defectClass: "performance", module: "apps/gateway/src/panel.ts", count: 9 },
      { id: "g5", defectClass: "concurrency", module: "apps/gateway/src/other.ts", count: 7 },
    ],
  };

  it("命中:按 count 降序返回全部命中,同 (class, module) 汇合,未映射类别剔除", () => {
    const genes = matchedDefectGenes(atlas, "改 apps/gateway/src/panel.ts 的切换逻辑");
    expect(genes).toEqual([
      { defectClass: "contract", module: "apps/gateway/src/panel.ts", count: 6 },
      { defectClass: "boundary", module: "apps/gateway/src/panel.ts", count: 3 },
    ]);
    expect(genes.some((g) => g.defectClass === "performance")).toBe(false);
  });

  it("不命中:任务文本不含模块词 → 空数组", () => {
    expect(matchedDefectGenes(atlas, "改 README 文案")).toEqual([]);
  });

  it("无 class 或类别无提示语 → 不出行", () => {
    const noClass = { defectGenes: [{ id: "x", module: "apps/gateway/src/panel.ts", count: 1 }] };
    expect(matchedDefectGenes(noClass, "改 panel.ts")).toEqual([]);
    expect(matchedDefectGenes({ defectGenes: [{ defectClass: "perf", module: "src/panel.ts" }] }, "改 panel.ts")).toEqual([]);
  });

  it("taskText 空/空白 → 空数组", () => {
    expect(matchedDefectGenes(atlas, "")).toEqual([]);
    expect(matchedDefectGenes(atlas, "   ")).toEqual([]);
    expect(matchedDefectGenes({}, "改 panel.ts")).toEqual([]);
    expect(matchedDefectGenes(undefined, "改 panel.ts")).toEqual([]);
  });
});

describe("createDefectGeneEditHint(B 首次改动提示,2026-11-14)", () => {
  const atlas = {
    defectGenes: [
      { id: "g1", defectClass: "contract", module: "apps/gateway/src/panel.ts", count: 2 },
      { id: "g2", defectClass: "boundary", module: "apps/gateway/src/panel.ts", count: 3 },
      { id: "g3", defectClass: "concurrency", module: "apps/gateway/src/other.ts", count: 7 },
    ],
  };

  it("命中模块首次出提示,同模块第二次静默(每任务每模块一次)", () => {
    const seen: Array<{ path: string; modules: string[] }> = [];
    let snapshot: unknown = atlas;
    const hint = createDefectGeneEditHint(() => snapshot, (info) => seen.push({ path: info.path, modules: info.modules }));
    const first = hint("apps/gateway/src/panel.ts");
    expect(first).toContain("本模块历史缺陷基因");
    expect(first).toContain("contract×2");
    expect(first).toContain("boundary×3");
    expect(hint("apps/gateway/src/panel.ts")).toBeUndefined();
    const other = hint("apps/gateway/src/other.ts"); // 另一模块仍可提示
    expect(other).toContain("concurrency×7");
    expect(seen.map((s) => s.modules[0])).toEqual(["apps/gateway/src/panel.ts", "apps/gateway/src/other.ts"]);
    snapshot = undefined; // 快照未装载/被清空 → 静默
    expect(hint("apps/gateway/src/panel.ts")).toBeUndefined();
  });

  it("不命中模块 / 无快照 → undefined,且不触发留痕", () => {
    let calls = 0;
    const hint = createDefectGeneEditHint(() => undefined, () => { calls++; });
    expect(hint("apps/gateway/src/panel.ts")).toBeUndefined();
    const hint2 = createDefectGeneEditHint(() => atlas, () => { calls++; });
    expect(hint2("README.md")).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("renderAtlasStartBrief(extraLines 插槽,2026-11-14)", () => {
  const withGenesAndDerived = {
    goals: [{ title: "RSI 世界模型闭环", status: "active" }],
    defectGenes: [{ id: "g1", defectClass: "contract", module: "apps/gateway/src/panel.ts", count: 2 }],
    derived: {
      reworkChains: { chains: 1, fanoutClusters: 2, impactNotClosed: [{ buildSession: "s-1", fixes: 3, units: 2 }] },
      themes: [{ id: "面板", sessions: 4, titles: ["改面板切换"] }],
      moduleActivity: [{ path: "src/panel.ts", editSessions: 3 }],
      reworkSignals: [],
    },
  };

  it("插在缺陷基因行之后、影响面未闭合簇之前", () => {
    const extra = ["- 工序纪律:先跑单文件测试"];
    const brief = renderAtlasStartBrief(withGenesAndDerived, "改 apps/gateway/src/panel.ts", extra);
    const geneAt = brief.indexOf("- 本模块历史缺陷基因:");
    const extraAt = brief.indexOf("- 工序纪律:先跑单文件测试");
    const impactAt = brief.indexOf("- 影响面未闭合簇:");
    expect(geneAt).toBeGreaterThan(-1);
    expect(extraAt).toBeGreaterThan(geneAt);
    expect(impactAt).toBeGreaterThan(extraAt);
  });

  it("空行/非串被忽略;只给 extraLines 也能成简报", () => {
    const brief = renderAtlasStartBrief({}, undefined, ["- 外部纪律:先写测试", "", "   "]);
    expect(brief).toContain("- 外部纪律:先写测试");
    expect(renderAtlasStartBrief({}, undefined, [])).toBe("");
  });

  it("不传第三参 → 输出与显式空数组逐字一致(旧调用形态零变化)", () => {
    const taskText = "改 apps/gateway/src/panel.ts";
    expect(renderAtlasStartBrief(withGenesAndDerived, taskText)).toBe(
      renderAtlasStartBrief(withGenesAndDerived, taskText, []),
    );
    expect(renderAtlasStartBrief(withGenesAndDerived, taskText)).not.toContain("工序纪律");
  });
});

describe("collectWorkSessions(项目归因兜底,2026-11-14)", () => {
  it("外部项目绑定 + 全部编辑路径落在 include 项目根下 → 归给该项目并计入", () => {
    const { root, journalDir } = fixture();
    const projRoot = join(root, "proj-a");
    mkdirSync(join(projRoot, "src"), { recursive: true });
    const id = "s-ext-bound";
    session(
      journalDir,
      id,
      [
        user("改面板切换", id),
        bind("other-project", id),
        edit(join(projRoot, "src", "a.ts"), id),
        edit(join(projRoot, "src", "b.ts"), id),
      ],
      1);
    const collected = collectWorkSessions(journalDir, {
      includeProjectIds: ["lampgenie-harness"],
      projectRoots: { "lampgenie-harness": projRoot, "other-project": join(root, "proj-b") },
    });
    expect(collected.sessions.map((s) => s.sessionId)).toEqual([id]);
    expect(collected.sessions[0]!.projectId).toBe("lampgenie-harness");
    expect(collected.unattributedIncluded).toBe(0);
  });

  it("编辑路径混合(一条落在 include 项目根外)→ 维持跳过", () => {
    const { root, journalDir } = fixture();
    const projRoot = join(root, "proj-a");
    const outside = join(root, "proj-b", "src", "c.ts");
    mkdirSync(join(projRoot, "src"), { recursive: true });
    mkdirSync(join(root, "proj-b", "src"), { recursive: true });
    const id = "s-ext-mixed";
    session(
      journalDir,
      id,
      [user("改两处", id), bind("other-project", id), edit(join(projRoot, "src", "a.ts"), id), edit(outside, id)],
      1);
    const collected = collectWorkSessions(journalDir, {
      includeProjectIds: ["lampgenie-harness"],
      projectRoots: { "lampgenie-harness": projRoot },
    });
    expect(collected.sessions).toEqual([]);
    expect(collected.sessionsScanned).toBe(1);
  });

  it("未绑定 projectId → 仍计入(unattributedIncluded 计 1);空编辑路径的外部绑定 → 跳过", () => {
    const { root, journalDir } = fixture();
    const projRoot = join(root, "proj-a");
    mkdirSync(projRoot, { recursive: true });
    session(journalDir, "s-unbound", [user("问答", "s-unbound"), edit(join(projRoot, "x.ts"), "s-unbound")], 1);
    session(journalDir, "s-ext-noedit", [user("只读", "s-ext-noedit"), bind("other-project", "s-ext-noedit")], 1);
    const collected = collectWorkSessions(journalDir, {
      includeProjectIds: ["lampgenie-harness"],
      projectRoots: { "lampgenie-harness": projRoot },
    });
    expect(collected.sessions.map((s) => s.sessionId)).toEqual(["s-unbound"]);
    expect(collected.unattributedIncluded).toBe(1);
 // 不注入 projectRoots → 兜底关闭,外部绑定会话照旧丢弃(旧行为)
    const legacy = collectWorkSessions(journalDir, { includeProjectIds: ["lampgenie-harness"] });
    expect(legacy.sessions.map((s) => s.sessionId)).toEqual(["s-unbound"]);
  });

  it("真源接线:loadProjectRoots 读 <journalDir>/projects.json,远程项目不进映射", () => {
    const { root, journalDir } = fixture();
    const projRoot = join(root, "proj-a");
    mkdirSync(join(projRoot, "src"), { recursive: true });
    writeFileSync(
      join(journalDir, "projects.json"),
      JSON.stringify({
        projects: [
          { id: "lampgenie-harness", path: projRoot, availability: "available" },
          { id: "remote-1", path: "remote:wsl:Ubuntu:/work/x", availability: "unavailable-remote-unverified" },
          { id: "no-path" },
        ],
        activeProjectId: "lampgenie-harness",
      }),
      "utf8",
    );
    const rootsMap = loadProjectRoots(journalDir);
    expect(rootsMap).toEqual({ "lampgenie-harness": projRoot });
    const id = "s-ext-bound";
    session(
      journalDir,
      id,
      [user("改面板", id), bind("other-project", id), edit(join(projRoot, "src", "a.ts"), id)],
      1);
    const collected = collectWorkSessions(journalDir, {
      includeProjectIds: ["lampgenie-harness"],
      projectRoots: rootsMap,
    });
    expect(collected.sessions.map((s) => s.projectId)).toEqual(["lampgenie-harness"]);
 // 文件缺失 → 空映射(不 throw)
    expect(loadProjectRoots(join(root, "no-such-dir"))).toEqual({});
  });
});
