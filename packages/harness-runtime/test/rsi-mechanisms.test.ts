/**
 * RSI 机制目录 + brief 纯逻辑( P0-1)。
 * 钉住四件事:
 * ① 12 个 id 齐全且顺序与协议面 sections 一致;
 * ② 12 个中文标题与 rsi-status.ts 的 RSI_SECTION_TITLES 逐字全等(面板/派单共用一份短名,漂移即错);
 * ③ brief 含标题/目标/数据源绝对路径/结果路径/schema 这些不可缺的段(agent 靠它才能不编数据);
 * ④ 覆盖层(override)生效、未知 id 返回 undefined 而不是 throw。
 */
import { describe, expect, it } from "vitest";
import {
  RSI_MECHANISMS,
  RSI_MECHANISM_IDS,
  RSI_RESULT_STATUSES,
  buildAgentBrief,
  mechanismSpec,
  resolveMechanismConfig,
} from "../src/agent/rsi-mechanisms";

/** 与 apps/gateway/src/rsi-status.ts:72 的 RSI_SECTION_TITLES 逐字一致(硬断言防漂移)。 */
const TITLES: Record<string, string> = {
  nightly: "夜间任务",
  evidence: "证据图",
  experiments: "实验",
  cost: "成本与熔断",
  injection: "注入防护",
  tools: "数据工具",
  changeRequests: "变更请求",
  cohort: "同批指标",
  negativeKb: "负面知识",
  prompts: "提示词版本",
  atlas: "方向图",
  pathology: "病理目录",
};

const ROOT = "/repo/lampgenie-harness";

describe("RSI_MECHANISM_IDS / RSI_MECHANISMS 目录", () => {
  it("12 个 id 齐全且顺序与协议面 sections 一致", () => {
    expect([...RSI_MECHANISM_IDS]).toEqual(Object.keys(TITLES));
    expect(RSI_MECHANISM_IDS).toHaveLength(12);
  });

  it("RSI_MECHANISMS 恰好 12 个键,且键集与 id 列表全等", () => {
    expect(Object.keys(RSI_MECHANISMS)).toHaveLength(12);
    expect(new Set(Object.keys(RSI_MECHANISMS))).toEqual(new Set(RSI_MECHANISM_IDS));
  });

  it("12 个中文标题与字面量逐字全等", () => {
    for (const id of RSI_MECHANISM_IDS) {
      expect(RSI_MECHANISMS[id].title, id).toBe(TITLES[id]);
      expect(RSI_MECHANISMS[id].id, id).toBe(id);
    }
  });

  it("每条都带 goal / dataSources / resultHint,且缺省 driver=agent / enabled=true", () => {
    for (const id of RSI_MECHANISM_IDS) {
      const spec = RSI_MECHANISMS[id];
      expect(spec.goal.length, id).toBeGreaterThan(10);
      expect(spec.resultHint.length, id).toBeGreaterThan(5);
      expect(spec.dataSources.length, id).toBeGreaterThan(0);
      for (const source of spec.dataSources) expect(source.startsWith(".genie/"), `${id}:${source}`).toBe(true);
      expect(spec.defaultDriver).toBe("agent");
      expect(spec.defaultEnabled).toBe(true);
    }
  });

  it("数据源覆盖已知的真实台账路径(取自各 store 的路径常量)", () => {
    const all = RSI_MECHANISM_IDS.flatMap((id) => RSI_MECHANISMS[id].dataSources);
    expect(all).toContain(".genie/evidence/graph.jsonl");
    expect(all).toContain(".genie/experiments/ledger.jsonl");
    expect(all).toContain(".genie/rsi/cost.jsonl");
    expect(all).toContain(".genie/rsi/injection.jsonl");
    expect(all).toContain(".genie/rsi/negkb.jsonl");
    expect(all).toContain(".genie/rsi/pathology.jsonl");
    expect(all).toContain(".genie/rsi/change-requests.jsonl");
  });
});

describe("mechanismSpec / resolveMechanismConfig", () => {
  it("已知 id 返回 spec,未知 id 返回 undefined", () => {
    expect(mechanismSpec("nightly")?.title).toBe("夜间任务");
    expect(mechanismSpec("nope")).toBeUndefined();
    expect(mechanismSpec("")).toBeUndefined();
  });

  it("无覆盖时用目录缺省", () => {
    expect(resolveMechanismConfig("atlas")).toEqual({
      id: "atlas",
      title: "方向图",
      enabled: true,
      driver: "agent",
    });
  });

  it("override 生效:enabled=false / driver=code 覆盖缺省", () => {
    expect(resolveMechanismConfig("atlas", { enabled: false })?.enabled).toBe(false);
    expect(resolveMechanismConfig("atlas", { driver: "code" })?.driver).toBe("code");
    expect(resolveMechanismConfig("atlas", { enabled: false, driver: "code" })).toEqual({
      id: "atlas",
      title: "方向图",
      enabled: false,
      driver: "code",
    });
  });

  it("非法 override 值回落缺省;未知 id 返回 undefined", () => {
    const bogus = { enabled: "yes", driver: "llm" } as unknown as { enabled: boolean; driver: "agent" };
    expect(resolveMechanismConfig("pathology", bogus)).toEqual({
      id: "pathology",
      title: "病理目录",
      enabled: true,
      driver: "agent",
    });
    expect(resolveMechanismConfig("nope", { enabled: true })).toBeUndefined();
  });
});

describe("buildAgentBrief", () => {
  const brief = buildAgentBrief({
    id: "negativeKb",
    root: ROOT,
    resultPath: `${ROOT}/.genie/rsi/agent-runs/negativeKb/run_1.result.json`,
  });

  it("含标题与目标", () => {
    expect(brief).toContain("负面知识");
    expect(brief).toContain("negativeKb");
    expect(brief).toContain(RSI_MECHANISMS.negativeKb.goal);
    expect(brief).toContain("goal");
  });

  it("含数据源绝对路径(root + 相对路径)", () => {
    expect(brief).toContain("dataSources");
    expect(brief).toContain(`${ROOT}/.genie/rsi/negkb.jsonl`);
    expect(brief).toContain(".genie/rsi/negkb.jsonl");
  });

  it("含 resultPath 与逐字 schema 关键字", () => {
    expect(brief).toContain("resultPath");
    expect(brief).toContain(`${ROOT}/.genie/rsi/agent-runs/negativeKb/run_1.result.json`);
    expect(brief).toContain('{"items":[{"id":"kebab-id","title":"≤30字主张","summary":"≤200字结论+为什么重要","evidence":"file:line 或 字段=值","impact":"不处理的后果","action":"最小可执行动作","status":"ok|warn|bad|info"}]}');
    expect(brief).toContain("schema");
    expect(brief).toContain("1~6");
    expect(brief).toContain('{"items":[]}');
  });

  it("含红线与允许的采集方式", () => {
    expect(brief).toContain("红线");
    expect(brief).toContain("禁止编造");
    expect(brief).toContain("scripts/*.mts");
    expect(brief).toContain("不得修改任何源码");
    for (const status of RSI_RESULT_STATUSES) expect(brief).toContain(status);
  });

  it("root 尾斜杠被剥掉,不拼出双斜杠", () => {
    const withSlash = buildAgentBrief({ id: "cost", root: `${ROOT}/`, resultPath: "x.result.json" });
    expect(withSlash).toContain(`${ROOT}/.genie/rsi/cost.jsonl`);
    expect(withSlash).not.toContain(`${ROOT}//`);
  });

  it("resultPath 缺省时给出 agent-runs 下的缺省结果文件路径", () => {
    const fallback = buildAgentBrief({ id: "prompts", root: ROOT, resultPath: "" });
    expect(fallback).toContain(`${ROOT}/.genie/rsi/agent-runs/prompts/`);
    expect(fallback).toContain(".result.json");
  });

  it("未知 id 返回简短说明且不 throw", () => {
    const text = buildAgentBrief({ id: "does-not-exist", root: ROOT, resultPath: "/tmp/x.json" });
    expect(text).toContain("未知 RSI 机制 id");
    expect(text).toContain("does-not-exist");
    expect(text).toContain("nightly");
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
  });
});

describe("2026-11-13 RSI-SELF-DRIVE:分析职责与预算小节", () => {
  it("12 条 spec 都声明 analyzesSessions;轨迹类=true,台账类=false", () => {
    for (const id of RSI_MECHANISM_IDS) {
      expect(typeof RSI_MECHANISMS[id].analyzesSessions, id).toBe("boolean");
    }
    for (const id of ["nightly", "tools", "negativeKb", "pathology"] as const) {
      expect(RSI_MECHANISMS[id].analyzesSessions, id).toBe(true);
    }
    for (const id of ["evidence", "experiments", "cost", "injection", "changeRequests", "cohort", "prompts", "atlas"] as const) {
      expect(RSI_MECHANISMS[id].analyzesSessions, id).toBe(false);
    }
  });

  it("传 budgetTokens 才插预算小节;不传/非法值旧行为逐字不变", () => {
    const base = { id: "cost", root: ROOT, resultPath: "/tmp/x.json" };
    const withBudget = buildAgentBrief({ ...base, budgetTokens: 250000 });
    expect(withBudget).toContain("本次运行预算");
    expect(withBudget).toContain("250000");
    const without = buildAgentBrief(base);
    expect(without).not.toContain("本次运行预算");
    const bogus = buildAgentBrief({ ...base, budgetTokens: 0 });
    expect(bogus).not.toContain("本次运行预算");
  });

  it("experimentQuotaFactor 只进 experiments 机制 brief(0<f<1 才插)", () => {
    const base = { root: ROOT, resultPath: "/tmp/x.json" };
    const brief = buildAgentBrief({ ...base, id: "experiments", experimentQuotaFactor: 0.5 });
    expect(brief).toContain("实验配额(ROI 降频生效中)");
    expect(brief).toContain("x0.5");
    expect(brief).toContain("不许静默丢弃");
 // 其它机制不插
    const costBrief = buildAgentBrief({ ...base, id: "cost", experimentQuotaFactor: 0.5 });
    expect(costBrief).not.toContain("实验配额");
 // 因子 >=1 / 非法 → 不插(旧行为)
    expect(buildAgentBrief({ ...base, id: "experiments", experimentQuotaFactor: 1 })).not.toContain("实验配额");
    expect(buildAgentBrief({ ...base, id: "experiments" })).not.toContain("实验配额");
  });

  it("分析小节给出「每个读过的会话至少 1 条条目」硬规则", () => {
    const brief = buildAgentBrief({
      id: "nightly",
      root: ROOT,
      resultPath: "/tmp/x.json",
      analysis: { windowDays: 3, candidates: [{ sessionId: "web-1", projectId: "__harness__" }] },
    });
    expect(brief).toContain("已分析会话:");
    expect(brief).toContain("每个真正读过的候选会话至少贡献 1 条结果条目");
    expect(brief).toContain("web-1");
  });
});

describe("2026-11-13 质量契约 v2:brief 四件套与条数上限", () => {
  it("brief 含 1~6 条上限、四件套字段与禁流水账规则", () => {
    const brief = buildAgentBrief({ id: "nightly", root: ROOT, resultPath: "/tmp/q.json" });
    expect(brief).toContain("1~6");
    expect(brief).toContain("结果质量");
    expect(brief).toContain("主张 → 证据 → 影响 → 建议");
    expect(brief).toContain('"evidence"');
    expect(brief).toContain('"impact"');
    expect(brief).toContain('"action"');
    expect(brief).toContain("禁止流水账");
  });
});
