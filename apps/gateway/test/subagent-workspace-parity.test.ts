/**
 * 子代理工作区与主会话渲染同构(2026-10-20 用户口径:「子 agent 应和 coding agent 一样的工作
 * 模式,消息渲染一样,所有轨迹要追踪」)。面板是单文件内嵌脚本,契约用源码标记锚定
 * (与 panel-model-pill-groups 同方法):流式尾块/轨迹行/转向门禁三类标记缺一即回归。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../src/panel.ts"), "utf8");

describe("子代理工作区渲染同构(面板契约)", () => {
  it("流式:subStreams 按 subagent-<taskId> 收流,工作区渲染 live 草稿(与主会话 stStream 同形态)", () => {
    expect(src).toContain('const subStreams = new Map()');
    expect(src).toContain('function subAgentDraftOf(agentEvents)');
    expect(src).toContain('String(m.sessionId || "").indexOf("subagent-") === 0');
    // 让位:真 subagent.event message.agent 到达即删草稿(与主会话 stStream 让位同语义)。
    expect(src).toContain('e.payload.kind === "message.agent"');
    expect(src).toContain('subStreams.delete(sid)');
    // 渲染形态:打字光标(与主历史 stStream 尾块同 markup)。
    expect(src).toContain("subAgentDraftOf(all)");
    expect(src).toContain("st-cursor");
  });

  it("轨迹:工作区渲染结构化 llm.trace 速览行(可点击复制路径),头部带轨迹计数", () => {
    expect(src).toContain('p.kind === "llm.trace"');
    expect(src).toContain('data-trace-file');
    expect(src).toContain("LLM 轨迹 ");
    expect(src).toContain("全文在轨迹文件(点击复制路径)");
  });

  it("消息:首条 message.user=任务书不再误渲染为「转向」;只渲染 [steer] 注入", () => {
    expect(src).toContain('String(p.text || "").indexOf("[steer]") === 0');
  });
});