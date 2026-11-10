/**
 * 工具配对自愈(用户用户反馈「失败一次就一直卡住一直失败」)。
 * 注意:后台子代理完成通知(message.system→user 角色)插在 assistant(tool_calls) 与其 tool 结果
 * 之间 → 阿里云/OpenAI 协议 400("must be followed by tool messages"),坏历史被无限重放。
 * 自愈契约:①被夹的 tool 结果前移到 assistant 紧随(保持原序) ②真缺失补显式占位 ③正常序列零改动。
 */
import { describe, it, expect } from "vitest";
import { deriveMessages, repairToolPairing } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { Message } from "../src/agent/loop";

const A = (ids: string[]): Message => ({ role: "assistant", content: "", toolCalls: ids.map((id) => ({ id, name: "grep", arguments: "{}" })) });
const T = (id: string, c = "ok"): Message => ({ role: "tool", toolCallId: id, content: c });
const U = (c: string): Message => ({ role: "user", content: c });

describe("repairToolPairing", () => {
  it("① 系统提醒夹在中间→tool 结果前移,提醒顺延(原序保持)", () => {
    const msgs = [U("任务"), A(["c1", "c2"]), U("[系统提醒] [后台子代理完成]"), T("c1"), T("c2"), A([])];
    const out = repairToolPairing(msgs);
    expect(out.map((m) => m.role === "tool" ? "tool:" + m.toolCallId : m.role === "user" ? "user:" + m.content.slice(0, 6) : "assistant"))
      .toEqual(["user:任务", "assistant", "tool:c1", "tool:c2", "user:[系统提醒]", "assistant"]);
  });

  it("② 真缺失结果→补显式占位(标注结果缺失),不再 400", () => {
    const out = repairToolPairing([U("x"), A(["c1", "c2"]), T("c1"), U("下一轮")]);
    const tools = out.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.find((m) => m.role === "tool" && m.toolCallId === "c2")!.content).toContain("结果缺失");
    // 占位紧跟 assistant(在用户消息之前)
    const ai = out.findIndex((m) => m.role === "assistant");
    expect(out[ai + 1]!.role).toBe("tool");
    expect(out[ai + 2]!.role).toBe("tool");
  });

  it("⑤ 孤儿 tool 结果(其 assistant 已丢失)→ 丢弃,不留 400 形态", () => {
 // 注意形态:assistant 消息在历史里丢失(双写/重启去重),只剩两条 tool 结果。
    const msgs = [U("任务"), A(["c1"]), T("c1"), T("orphan-1", "grep 输出"), T("orphan-2", "glob 输出"), A([])];
    const out = repairToolPairing(msgs);
    expect(out.filter((m) => m.role === "tool").map((m) => m.role === "tool" && m.toolCallId)).toEqual(["c1"]);
    // 每个 tool 消息都能被最近的前置 assistant 认领(协议硬约束)
    for (let i = 0; i < out.length; i++) {
      const m = out[i]!;
      if (m.role !== "tool") continue;
      let j = i - 1;
      while (j >= 0 && out[j]!.role !== "assistant") j--;
      expect(j).toBeGreaterThanOrEqual(0);
      const a = out[j]!;
      expect(a.role === "assistant" && a.toolCalls?.some((c) => c.id === (m as { toolCallId: string }).toolCallId)).toBe(true);
    }
  });

  it("⑥ user 之后的孤儿 tool 结果也丢弃(顺序已非法)", () => {
    const out = repairToolPairing([U("x"), A(["c1"]), T("c1"), U("插话"), T("late-orphan")]);
    expect(out.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("⑦ 重复 toolCallId(重启双写实测确认形态)→ 保首条丢重复,不再 400", () => {
 // 注意形态(llm-trace):同一 toolCallId 两条 tool 消息——严格端点
    // (DeepSeek)对重复 tool 响应报「must be a response to a preceding message」。
    const dup = T("c1", "重复副本");
    const msgs = [U("任务"), A(["c1", "c2"]), T("c1", "原结果"), T("c2"), dup, A([])];
    const out = repairToolPairing(msgs);
    const toolIds = out.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId);
    expect(toolIds).toEqual(["c1", "c2"]); // 重复 c1 副本被丢,保首条
    const firstC1 = out.find((m) => m.role === "tool" && (m as { content?: string }).content === "原结果");
    expect(firstC1).toBeTruthy();
  });

  it("⑧ 孤儿+重复混合(重启风暴复合形态)→ 两遍各治各的", () => {
    const out = repairToolPairing([
      U("任务"), A(["c1"]), T("c1", "首"), T("c1", "重"), T("orphan"), T("c2", "孤儿无主"), A([]),
    ]);
    const toolIds = out.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId);
    expect(toolIds).toEqual(["c1"]);
  });

  it("③ 正常序列零改动(幂等)", () => {
    const msgs = [U("x"), A(["c1"]), T("c1"), A([]), U("y")];
    expect(repairToolPairing(msgs)).toEqual(msgs);
    expect(repairToolPairing(repairToolPairing(msgs))).toEqual(msgs);
  });

  it("④ 多条 assistant 各自配对:只动被夹的那一组", () => {
    const msgs = [A(["a1"]), T("a1"), U("提醒"), A(["b1"]), T("b1")];
    const out = repairToolPairing(msgs);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "user", "assistant", "tool"]);
  });
});

describe("repairToolPairing 第 0 遍:重复 assistant 去重(2026-10-22 生产 400 实测确认)", () => {
 // 注意形态(web-1792639728612 call-0133):ProxyJournal 回声双入(网关落账重赋 time,
  // 回声去重键含 time 永不命中)→ 同一 message.agent(带 toolCalls)在副本出现两次。
  // 旧版:第一遍给重复副本补占位、第三遍又按同 id 删占位 → 重复 assistant 裸奔 →
  // 端点 400 "insufficient tool messages following tool_calls" 且坏历史无限重放。
  const dupA = (): Message => ({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "board_upsert", arguments: "{}" }, { id: "c2", name: "terminal", arguments: "{}" }] });

  it("⑨ 回声形态 [A,t*,A']:重复副本删除,不裸奔(保首个——tool 结果总配在首个之后)", () => {
    const out = repairToolPairing([U("任务"), dupA(), T("c1", "r1"), T("c2", "r2"), dupA(), U("提醒"), A([])]);
    const assistants = out.filter((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(assistants).toHaveLength(1); // 重复副本被第 0 遍去掉
    // 每个在场的 tool_calls assistant 后紧跟其全部 tool 结果(端点契约)
    const ai = out.findIndex((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(out[ai + 1]!.role).toBe("tool");
    expect(out[ai + 2]!.role).toBe("tool");
    expect(out.map((m) => m.role).join(",")).not.toContain("assistant,assistant");
  });

  it("⑩ 双入形态 [A,A',t*](推送先于 tool append):同样归约为 [A,t*]", () => {
    const out = repairToolPairing([U("任务"), dupA(), dupA(), T("c1", "r1"), T("c2", "r2"), A([])]);
    const assistants = out.filter((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(assistants).toHaveLength(1);
    const ai = out.findIndex((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(out[ai + 1]!.role).toBe("tool");
    expect(out[ai + 2]!.role).toBe("tool");
  });

  it("⑪ 不同调用的 assistant 不受影响(签名=callId 全集,只有完全相同才去重)", () => {
    const out = repairToolPairing([A(["c1"]), T("c1"), A(["c2"]), T("c2"), A([])]);
    expect(out.filter((m) => m.role === "assistant").length).toBe(3);
  });

  it("⑫ 幂等:修复后的序列再跑一遍零变化", () => {
    const once = repairToolPairing([U("x"), dupA(), T("c1"), T("c2"), dupA(), A([])]);
    expect(repairToolPairing(once)).toEqual(once);
  });
});

describe("deriveMessages 不消费 system.prompt(token 轮 P1 negative)", () => {
  it("写 system.prompt 快照后 deriveMessages 输出条数与内容逐字节不变", () => {
    const journal = new MemoryJournal();
    const sid = "derive-sysprompt";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "任务" } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "回执", toolCalls: [{ id: "c1", name: "grep", arguments: "{}" }] } });
    journal.append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: "c1", content: "ok" } });
    const before = deriveMessages(journal, sid);
    journal.append({
      kind: "system.prompt", sessionId: sid,
      payload: { sha: "abc123def456", text: "SYS-SNAPSHOT " + "s".repeat(300), chars: 313 },
    });
    const after = deriveMessages(journal, sid);
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
