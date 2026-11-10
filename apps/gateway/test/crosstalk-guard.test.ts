import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBoardWriteEvidence, isCrosstalk, isProtocolLeak, relevanceTokens, LlmLoopBackend } from "../src/llm-loop-backend.js";

const ESIGN_TASK = "只读勘察,不要修改任何文件。目标:判断在一个新网页(电子签网页)应该放在工作区哪个位置、用什么技术栈。需要查清并逐条给出证据:仓库根目录结构、现有前端技术栈、路由注册方式。";

describe("串台守卫", () => {
  it("异题结果(Excel 商品导入)判串台", () => {
    const foreign = '请确保您使用"strict"模式调用工具,请根据任务书及以下具体任务书,最后输出调查报告。\n\n探索仓库,定位 Excel 商品导入相关的代码,重点回答:\n1. 仓库根目录结构\n2. 是否已有 Excel 导入相关实现(排查 services/excel 目录)';
    expect(isCrosstalk(ESIGN_TASK, foreign)).toBe(true);
  });

  it("相关结果(电子签勘察报告)不判串台", () => {
    const relevant = "调查报告:电子签网页建议放在 apps/web-sign/(工作区尚无前端目录)。\n" +
      "技术栈:仓库根目录结构为 pnpm monorepo,packages/ 有 core/runtime;路由注册方式:网关 panel.ts 单页;电子签涉及签署流程,建议 vite+react。\n" +
      "证据:package.json workspaces;apps/ 目录清单;电子签名词在任务书中出现,网页与签署技术栈如上。";
    expect(isCrosstalk(ESIGN_TASK, relevant)).toBe(false);
  });

  it("任务书特征 <6 时宁纵勿枉(不判串台)", () => {
    expect(isCrosstalk("看一下日志", "完全无关的回答内容")).toBe(false);
  });

  it("relevanceTokens:CJK 二元组+拉丁词,停用词滤除", () => {
    const t = relevanceTokens("电子签网页 技术栈 the task 探索仓库");
    expect(t.has("电子")).toBe(true);
    expect(t.has("子签")).toBe(true);
    expect(t.has("技术")).toBe(true);
    expect(t.has("the")).toBe(false);
    expect(t.has("探索")).toBe(false); // 停用词
  });
});

describe("hasBoardWriteEvidence(planner 串台误杀豁免)", () => {
  it("board_upsert 成功回执 → true(落板证明结果与任务相关)", () => {
    expect(hasBoardWriteEvidence([
      { kind: "tool.call", payload: { name: "board_upsert" } },
      { kind: "tool.result", payload: { name: "board_upsert", content: "设计白板已更新:「页面契约」17 节点/33 边" } },
    ])).toBe(true);
  });
  it("board_upsert 拒收/失败 → false(不能拿失败回执豁免)", () => {
    expect(hasBoardWriteEvidence([
      { kind: "tool.result", payload: { name: "board_upsert", content: "白板已拒收:P0 节点缺 accept" } },
      { kind: "tool.result", payload: { name: "board_upsert", content: "落板失败:写盘异常" } },
    ])).toBe(false);
  });
  it("非 board_upsert 工具/非 tool.result → false", () => {
    expect(hasBoardWriteEvidence([
      { kind: "tool.result", payload: { name: "grep", content: "设计白板已更新" } },
      { kind: "message.agent", payload: { text: "设计白板已更新" } },
    ])).toBe(false);
  });
});

describe("isProtocolLeak(协议泄漏检测)", () => {
  it("DSML 工具标签泄漏 → 判泄漏", () => {
    expect(isProtocolLeak("调查仓库架构", '<｜DSML｜ parameter name="input" string="true">请调查本仓库')).toBe(true);
  });
  it("think 推理段泄漏 → 判泄漏", () => {
    expect(isProtocolLeak("调查仓库架构", "Let me start by exploring the repository structure.</think>I'll start exploring.")).toBe(true);
  });
  it("任务书头部复述 → 判泄漏", () => {
    const task = "总结仓库结构并定位关键入口。请先阅读仓库根目录,识别项目类型、构建/配置、源码目录与文档。总结仓库结构并定位关键入口。";
    expect(isProtocolLeak(task, "总结仓库结构并定位关键入口。请先阅读仓库根目录,识别项目类型、构建/配置、源码目录与文档。 总结仓库结构并定位关键入口。 Let me start")).toBe(true);
  });
  it("同域串扰的提示词形态(真实泄漏样例) → 判泄漏", () => {
    const leaked = "请系统盘查本仓库,回答下述问题;只依据真实文件与检索结果作答,不得编造。\n仓库路径: /workspace/repo\n问题:本仓库的构建/打包系统是什么?入口脚本/配置文件在哪里?如何编译、测试、打包与分发?\n回答要求:先做整体结构速览,再列出关键文件,给出可复现的命令,最后给结论;并回答上述问题。";
    expect(isProtocolLeak("总结仓库结构并定位关键入口:请先阅读仓库根目录,识别项目类型、构建/配置、源码目录与文档。", leaked)).toBe(true);
  });
  it("正常报告 → 不判", () => {
    expect(isProtocolLeak("调查仓库架构", "架构报告:monorepo 结构,核心包为 core 与 runtime,入口在 main.ts。")).toBe(false);
  });
});

/**
 * P1-5 串台重派前置兜底:判据不放宽,但重派前先看子 journal——
 * 有 ≥200 字且非串台/非泄漏的 agent 文本就直接采用(省一轮重派);拿不到才走原整轮重派。
 */
describe("串台重派前置兜底(P1-5)", () => {
  const TASK = "只读勘察,不要修改任何文件。目标:判断电子签网页应该放在工作区哪个位置、用什么技术栈。需要查清并逐条给出证据:仓库根目录结构、现有前端技术栈、路由注册方式。";
  /** 首跑吐异题内容(判串台),后续步骤吐 journal 里的可用文本或继续异题。 */
  const scripted = (steps: Array<{ content: string; toolCalls?: { id: string; name: string; arguments: string }[] }>) => {
    let i = 0;
    return { async chat() { const r = steps[Math.min(i, steps.length - 1)]!; i++; return r; } } as never;
  };
  const dir = () => mkdtempSync(join(tmpdir(), "p15-"));
  const noop = () => ({ id: "c", name: "list_dir", arguments: JSON.stringify({ path: "." }) });
  /** 结果事件异步落(spawn 返回 ≠ 完成):等终态事件。 */
  const waitFor = async <T,>(fn: () => T | undefined, timeoutMs: number): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v !== undefined) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
      await new Promise((r) => setTimeout(r, 30));
    }
  };

  it("子 journal 有 ≥200 字相关文本 → 直接采用,不发起重派(note 含 crosstalk-guard)", async () => {
    const d = dir();
    const usable = "调查报告:电子签网页建议放在 apps/web-sign/ 目录(工作区当前尚无前端目录)。技术栈取 vite+react,路由注册方式沿用网关 panel.ts 单页挂载。\n"
      + "证据:package.json workspaces 声明;apps/ 目录清单;电子签涉及签署流程与网页路由注册方式如上,仓库根目录结构为 pnpm monorepo。";
    const backend = new LlmLoopBackend({
      llm: scripted([
        { content: "", toolCalls: [noop()] },
        { content: usable, toolCalls: [noop()] }, // 中间有可用产出
        { content: "商品导入 Excel 请联系服务商;本段与任务书主题无关,纯异题内容占位。" }, // 终稿被判串台
      ]),
      roots: [d], workdir: d, role: "explore", maxSteps: 6,
    });
    const notes: string[] = [];
    let result: { ok?: boolean; finalText?: string; note?: string } | undefined;
    await backend.spawn({ taskId: "p15-hit", instructions: TASK, workdir: d, permissions: "readonly" }, (e) => {
      if (e.type === "progress") notes.push(String(e.note ?? ""));
      if (e.type === "result") result = e.result as typeof result;
    });
    await waitFor(() => result, 15_000);
    expect(result?.note).toContain("[crosstalk-guard]");
 // 文案在 改为带「筛选保留 N 段/丢弃 M 段」的计数,断言按其不变部分匹配
    expect(result?.finalText).toContain("[串台守卫] 首跑结果被判为可疑,但子 journal 内有可用产出");
    expect(result?.finalText).toContain("未重派");
    expect(result?.finalText).toContain("apps/web-sign");
    expect(notes.some((n) => n.includes("自动重派")), "有可用产出时不得发起重派").toBe(false);
    expect(notes.some((n) => n.includes("[crosstalk-guard]"))).toBe(true);
  }, 30_000);

  it("negative:子 journal 无可用文本(<200 字) → 仍发起整轮重派", async () => {
    const d = dir();
    const backend = new LlmLoopBackend({
      llm: scripted([
        { content: "短", toolCalls: [noop()] },
        { content: "商品导入 Excel 请联系服务商;本段与任务书主题无关,纯异题内容占位。" }, // 终稿判串台,且子 journal 无 ≥200 字可用文本
      ]),
      roots: [d], workdir: d, role: "explore", maxSteps: 6,
    });
    const notes: string[] = [];
    let result: { ok?: boolean; finalText?: string; note?: string } | undefined;
    await backend.spawn({ taskId: "p15-miss", instructions: TASK, workdir: d, permissions: "readonly" }, (e) => {
      if (e.type === "progress") notes.push(String(e.note ?? ""));
      if (e.type === "result") result = e.result as typeof result;
    });
    await waitFor(() => result, 15_000);
    expect(notes.some((n) => n.includes("自动重派")), "无可用产出时必须仍走重派(不能把兜底变成免检)").toBe(true);
    expect(result?.note ?? "").not.toContain("[crosstalk-guard]");
    expect(result?.note).toContain("[串台守卫]");
  }, 30_000);
});
