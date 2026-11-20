/**
 * world_model 工具测试( super agent 管理世界模型):
 * 参数面判定 / 相似度治理 / 读渲染 / 全链写(goal_add→progress→close)/ 去重拒立线 /
 * goalId 缺省自动补全 / goal_close 强制证据 / derived 层跨写保真。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  dispatchWorldModelArgs,
  jaccard,
  overlapCoeff,
  goalIdFor,
  renderWorldModelRead,
  titleTokens,
  worldModelTool,
} from "../src/world-model-tool";
import { atlasEntriesPath, atlasJsonPath, getAtlas, addGoal } from "../src/direction-atlas-store";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-wm-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("world-model-tool / 参数面与治理辅助", () => {
  it("dispatch:缺 action=read;未知 action 拒;goal_add 缺 title 拒;close 的 status 枚举校验", () => {
    expect(dispatchWorldModelArgs({})).toEqual({ kind: "read" });
    expect(dispatchWorldModelArgs({ action: "read" }).kind).toBe("read");
    expect(dispatchWorldModelArgs({ action: "nope" }).kind).toBe("invalid");
    expect(dispatchWorldModelArgs({ action: "goal_add" }).kind).toBe("invalid");
    const ok = dispatchWorldModelArgs({ action: "goal_add", title: "测试主线", detail: "为什么" });
    expect(ok).toMatchObject({ kind: "goal_add", title: "测试主线", detail: "为什么" });
    expect(dispatchWorldModelArgs({ action: "goal_close", goalId: "g", status: "paused", reason: "r" }).kind).toBe("invalid");
    expect(dispatchWorldModelArgs({ action: "goal_progress", goalId: "g" }).kind).toBe("invalid"); // 缺 note
    expect(dispatchWorldModelArgs({ action: "change", kind: "nope", reason: "r" }).kind).toBe("invalid");
 // evidence 单字符串容错成数组
    expect(dispatchWorldModelArgs({ action: "goal_progress", goalId: "g", note: "n", evidence: "task:1" }).evidence).toEqual(["task:1"]);
  });

  it("titleTokens/jaccard/overlap:同主线加词稀释 Jaccard 但包含度仍高;无关标题双低", () => {
    const a = titleTokens("RSI 经验编译闭环");
    const b = titleTokens("RSI 经验编译生产闭环");
    const c = titleTokens("面板性能优化");
    expect(jaccard(a, b)).toBeCloseTo(0.56, 1); // 同主线加词,Jaccard 被稀释
    expect(overlapCoeff(a, b)).toBeGreaterThanOrEqual(0.6); // 去重判据:包含度
    expect(overlapCoeff(a, c)).toBeLessThan(0.6);
    expect(jaccard(a, c)).toBeLessThan(0.6);
    expect(overlapCoeff(new Set(), b)).toBe(0); // 空集安全
  });

  it("goalIdFor:slug+日期;冲突追加序号", () => {
    const existing = new Set(["goal-rsi-主线-20261116"]);
    expect(goalIdFor("RSI 主线", "20261116", new Set())).toBe("goal-rsi-主线-20261116");
    expect(goalIdFor("RSI 主线", "20261116", existing)).toBe("goal-rsi-主线-20261116-2");
  });
});

describe("world-model-tool / execute 全链(真实临时仓)", () => {
  it("goal_add → goal_progress → goal_close:台账三事件,快照即时重建,derived 保真", async () => {
    const root = await tmpRoot();
    const tool = worldModelTool(root, "agent:test-1");
 // 预置 derived 层(模拟夜间 refresh 已跑)
    const added = await tool.execute({ action: "goal_add", title: "RSI 经验编译闭环", detail: "把会话轨迹编译成行为约束" });
    expect(String(added)).toContain("已立主线 goal-rsi-经验编译闭环-");
 // 写一个 derived 层(直接改快照)
    const snapPath = atlasJsonPath(root, basename(root));
    const snap = JSON.parse(await readFile(snapPath, "utf8"));
    snap.derived = { themes: [{ id: "RSI", sessions: 6, titles: ["t"] }] };
    await writeFile(snapPath, JSON.stringify(snap));

    const goalId = "goal-rsi-经验编译闭环-" + new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const progressed = await tool.execute({ action: "goal_progress", goalId, note: "完成采集与归因切分", nextStep: "接入注入编排", evidence: ["task:t1"] });
    expect(String(progressed)).toContain("已登记推进");
 // derived 层没被增量重建洗掉
    expect((getAtlas(root, basename(root)).atlas as any).derived.themes[0].id).toBe("RSI");
    expect((getAtlas(root, basename(root)).atlas as any).goalProgress[goalId][0].nextStep).toBe("接入注入编排");

    const closed = await tool.execute({ action: "goal_close", goalId, status: "achieved", reason: "五段管线生产闭环", evidence: ["task:t9"] });
    expect(String(closed)).toContain("已收口为 achieved");
    const after = getAtlas(root, basename(root)).atlas as any;
    expect(after.goals[0].status).toBe("achieved");
    expect(after.derived.themes[0].id).toBe("RSI"); // 重建同样保真
    const kinds = (await readFile(atlasEntriesPath(root), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l).kind);
    expect(kinds).toEqual(["goal", "goal_progress", "goal_close"]);
  });

  it("goal_add 与活跃主线相似 → 拒并指路 goal_progress;不写台账", async () => {
    const root = await tmpRoot();
    const tool = worldModelTool(root, "agent:t");
    await tool.execute({ action: "goal_add", title: "RSI 经验编译闭环" });
    const dup = await tool.execute({ action: "goal_add", title: "RSI 经验编译生产闭环" });
    expect(String(dup)).toContain("拒立线");
    expect(String(dup)).toContain("goal_progress");
    const lines = (await readFile(atlasEntriesPath(root), "utf8")).split("\n").filter(Boolean);
    expect(lines.length).toBe(1); // 只有一条 goal 事件
  });

  it("恰一条活跃主线时 goal_progress 缺 goalId 自动补全;多条时列出候选", async () => {
    const root = await tmpRoot();
    const tool = worldModelTool(root, "agent:t");
    await tool.execute({ action: "goal_add", title: "唯一主线" });
    const auto = await tool.execute({ action: "goal_progress", note: "自动补全 goalId" });
    expect(String(auto)).toContain("已登记推进");
    await tool.execute({ action: "goal_add", title: "面板交互打磨" });
    const multi = await tool.execute({ action: "goal_progress", note: "该选哪条" });
    expect(String(multi)).toContain("多条活跃主线");
  });

  it("goal_close 强制 evidence;无活跃主线给可操作提示", async () => {
    const root = await tmpRoot();
    const tool = worldModelTool(root, "agent:t");
    const empty = await tool.execute({ action: "goal_progress", goalId: "g", note: "n" });
    expect(String(empty)).toContain("无活跃主线");
    await tool.execute({ action: "goal_add", title: "主线甲" });
    const noEvidence = await tool.execute({ action: "goal_close", goalId: "goal-主线甲-20261116", status: "achieved", reason: "r" });
    expect(String(noEvidence)).toContain("需要 evidence");
  });

  it("read:渲染主线全景(进度/下一步/已收口/derived 摘要)", async () => {
    const root = await tmpRoot();
    const tool = worldModelTool(root, "agent:t");
    await tool.execute({ action: "goal_add", title: "RSI 经验编译闭环" });
    await tool.execute({ action: "goal_progress", goalId: "goal-rsi-经验编译闭环-" + new Date().toISOString().slice(0, 10).replace(/-/g, ""), note: "采集面完成", nextStep: "接注入编排" });
    await tool.execute({ action: "decision", decision: "世界模型由 super agent 维护", rationale: "2026-11-16", impact: "high", evidence: ["user:2026-11-16"] });
    const text = String(await tool.execute({ action: "read" }));
    expect(text).toContain("主线全景");
    expect(text).toContain("RSI 经验编译闭环");
    expect(text).toContain("进度 1 条");
    expect(text).toContain("下一步:接注入编排");
    expect(text).toContain("决策[high]");
 // 空仓 read:快照不存在 → 可操作提示
    const emptyRoot = await tmpRoot();
    const emptyText = String(await worldModelTool(emptyRoot, "agent:t").execute({ action: "read" }));
    expect(emptyText).toContain("世界模型快照不存在");
  });

  it("change:登记方向转向(kind 枚举内),台账 kind=change", async () => {
    const root = await tmpRoot();
    const tool = worldModelTool(root, "agent:t");
    const out = await tool.execute({ action: "change", reason: "从机制验证转向生产闭环", kind: "pivot", from: "机制验证", to: "生产闭环" });
    expect(String(out)).toContain("方向转向已登记");
    const lines = (await readFile(atlasEntriesPath(root), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l).kind);
    expect(lines).toEqual(["change"]);
  });
});

describe("world-model-tool / renderWorldModelRead(纯渲染)", () => {
  it("无 goal → 「活跃主线:无」指引;已收口聚合一行", () => {
    const text = renderWorldModelRead({ goals: [{ id: "g1", title: "旧线", status: "achieved" }] });
    expect(text).toContain("活跃主线:无");
    expect(text).toContain("已收口:1 条");
  });
});

describe("world-model-tool / 与既有台账共存", () => {
  it("夜间晋升的 goal(tool 外写入)同样可被 progress/close 操作", async () => {
    const root = await tmpRoot();
    await addGoal(root, basename(root), { id: "theme-rsi", title: "主题「RSI」(6 会话在近期活跃)", status: "active", since: "2026-11-01T00:00:00.000Z", evidenceRefs: ["proposed-goals:theme-rsi"] });
    const tool = worldModelTool(root, "agent:t");
    const out = await tool.execute({ action: "goal_progress", goalId: "theme-rsi", note: "推进夜间晋升的主线" });
    expect(String(out)).toContain("已登记推进");
  });
});
