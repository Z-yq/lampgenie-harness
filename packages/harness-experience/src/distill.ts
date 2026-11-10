/**
 * 提炼器(distill,Hermes background_review prompt 移植):
 * 任务终态→LLM 注入式提炼(fold-in 优先+负面清单)/无 LLM 确定性兜底。
 */
import type { Journal } from "@lampgenie/core";
import type { ExperienceStore } from "./store";

export interface DistillLlm {
  chat(prompt: string): Promise<{ content: string }>;
}

/** 负面清单(Hermes _DO_NOT_CAPTURE_BLOCK 移植)。 */
export const NEGATIVE_LIST = `禁止沉淀为经验的内容:
- 环境性故障(网络抖动/服务未起/权限)——环境问题不是知识
- 已自愈的瞬时错误
- 一次性任务的具体参数(只在本次有意义)
- 未验证成功的尝试(还没跑通的做法写进库会误导未来)
失败本身不写库,除非提炼出了「已验证的通用规则」。`;

export const SKILL_REVIEW_PROMPT = `你是经验提炼员。回看这个任务的执行轨迹,决定是否更新经验库。

## fold-in 优先序(防重复膨胀)
1. 修改已有条目(本次经验是既有条目的修正/补充)
2. 补充既有条目的正文细节
3. 都不合适才新建

${NEGATIVE_LIST}

## 输出(严格 JSON,无值得沉淀则 ops 为空)
{"ops":[{"op":"write","category":"","name":"","description":"≤60字","body":"经验的完整内容:什么场景/怎么做/什么坑"},{"op":"skip","reason":""}]}
只输出 JSON。`;

/** 探针/测试任务甄别(用户用户反馈「经验索引被污染」):e2e/冒烟/手工探针任务的
 *  失败不代表可复用教训——曾沉淀 14 条「失败任务候选经验:回答 1+1 / 派子代理 /
 *  用 browser 工具打开 https://example.com …」,占到经验索引一半,会误导后续任务。
 * 只按特征判,不用长度阈值(经验证「跑测试」「重启服务」这类真实短任务会被长度规则误伤)。 */
export function isProbeTask(instruction: string): boolean {
  const s = String(instruction || "").trim();
  if (/^(你好|您好|嗨|hi|hello)[!！。.~]*$/i.test(s)) return true;
  if (/^(派子代理|派个子代理|派个 agent)$/i.test(s)) return true;
  if (/^.{0,8}\d+\s*[+\-*/×]\s*\d+\s*=?\s*\d*\s*[。.]?$/.test(s)) return true; // 「回答 1+1」
  if (/example\.com/i.test(s)) return true; // 文档示例探针
  if (/^(只回复|请回答|请回复|回复我)/.test(s) && s.length < 40) return true;
  if (/run_workflow\s*工具执行以下\s*workflow\s*脚本/.test(s)) return true; // 工作流板编译产物测试
  if (/^(图里是什么|看看这张图|这是什么图)$/.test(s)) return true;
  return false;
}

/** 基础设施故障甄别:LLM 400/流超时/网关重启这类失败不是任务教训,沉淀下来只会
 * 污染经验索引(经验证:桌面 exe 规划任务因 tool_calls 配对 400 失败,生成了 3 条
 *  「失败任务候选经验:接下来规划一下…」「继续？」,全是噪声)。 */
export function isInfraFailure(result?: string): boolean {
  const s = String(result || "");
  return /LLM\s*\d{3}:|invalid_parameter_error|must be followed by tool messages|MODEL_STREAM_IDLE_TIMEOUT|ECONNRESET|EADDRINUSE|网关重启中断/.test(s);
}

/** 提炼入口:任务终态调用。LLM 缺席走确定性兜底。 */
export async function distillFromTask(
  store: ExperienceStore,
  journal: Journal,
  task: { id: string; sessionId: string; instruction: string; state: string; result?: string },
  llm?: DistillLlm,
  opts?: { project?: string },
): Promise<{ distilled: number; skipped: string[] }> {
  // 探针任务不沉淀(LLM 与确定性兜底同门槛:省 LLM 调用,也防索引污染)。
  if (isProbeTask(task.instruction)) {
    return { distilled: 0, skipped: ["探针/测试任务不沉淀(指令特征命中 isProbeTask)"] };
  }
  // 基础设施故障不沉淀(LLM 4xx/流超时/网关重启=环境问题,不是可复用教训)
  if (task.state === "failed" && isInfraFailure(task.result)) {
    return { distilled: 0, skipped: ["基础设施故障(LLM 4xx/超时/重启)不沉淀"] };
  }
  // 轨迹:该会话的事件摘要
  const events = journal.readAll().filter((e) => e.sessionId === task.sessionId);
  const trace = events.slice(-60).map((e) => `${e.kind} ${JSON.stringify(e.payload).slice(0, 120)}`).join("\n");

  if (llm) {
    const prompt = `${SKILL_REVIEW_PROMPT}\n\n---\n任务:${task.instruction}\n终态:${task.state}${task.result ? `\n结果:${task.result.slice(0, 400)}` : ""}\n轨迹:\n${trace.slice(0, 12_000)}`;
    try {
      const r = await llm.chat(prompt);
      const parsed = JSON.parse(r.content.trim().replace(/^```json\s*|\s*```$/g, "")) as {
        ops: { op: string; category?: string; name?: string; description?: string; body?: string; reason?: string }[];
      };
      const skipped: string[] = [];
      let distilled = 0;
      for (const op of parsed.ops ?? []) {
        if (op.op === "write" && op.category && op.name && op.description && op.body) {
          await store.write(
            { category: op.category, name: op.name, description: op.description, created_by: "agent", status: "active", ...(opts?.project ? { project: opts.project } : {}) },
            op.body);
          distilled++;
        } else if (op.reason) {
          skipped.push(op.reason);
        }
      }
      return { distilled, skipped };
    } catch {
      // LLM 输出解析失败:落确定性兜底
    }
  }
  return deterministicDistill(store, task, trace, opts?.project);
}

/** 确定性兜底(无 LLM):failed 任务从 journal 提取错误模式→candidate 条目。 */
async function deterministicDistill(
  store: ExperienceStore,
  task: { id: string; instruction: string; state: string },
  trace: string,
  project?: string): Promise<{ distilled: number; skipped: string[] }> {
  if (task.state !== "failed") {
    return { distilled: 0, skipped: ["非失败任务且无 LLM——不沉淀(避免把普通完成误当经验)"] };
  }
  if (isInfraFailure((task as { result?: string }).result)) {
    return { distilled: 0, skipped: ["基础设施故障(LLM 4xx/超时/重启)不沉淀(确定性兜底)"] };
  }
  if (isProbeTask(task.instruction)) {
    return { distilled: 0, skipped: ["探针/测试任务不沉淀(确定性兜底同门槛)"] };
  }
  // 错误信号提取(粗粒度,标 candidate 等确认)
  const errMatch = /(错误|Error|failed|cannot|ENOENT|timeout|超时)/i.exec(trace);
  if (!errMatch) {
    return { distilled: 0, skipped: ["轨迹中无可提取的错误模式"] };
  }
  const name = `task-${task.id.slice(0, 8)}`;
  if (store.read("incidents", name)) return { distilled: 0, skipped: ["已存在"] };
  await store.write(
    { category: "incidents", name, description: `失败任务候选经验:${task.instruction.slice(0, 50)}`, created_by: "agent", status: "candidate", ...(project ? { project } : {}) },
    `## 场景\n任务「${task.instruction}」以 failed 终态。\n\n## 现象\n${trace.slice(-800)}\n\n(确定性兜底产出,待人工/LLM 确认为通用规则后转 active)\n`,
  );
  return { distilled: 1, skipped: [] };
}
