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
    expect(brief).toContain('{"items":[{"id":"kebab-id","title":"≤30字","summary":"≤200字","detail":"可选","status":"ok|warn|bad|info"}]}');
    expect(brief).toContain("schema");
    expect(brief).toContain("1~20");
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
