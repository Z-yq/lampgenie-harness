/**
 * P0-1 回归核验:ephemeral 块前置到 index 1 后,
 * 「块存在性/内容每步变化」是否让历史起点漂移 → 整条历史前缀失效。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type Message, type Tool } from "../src/agent/loop";

function mtxt(m: Message): string {
  const c = (m as { content?: unknown }).content;
  return typeof c === "string" ? c : JSON.stringify(c ?? "");
}

function mkTool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      return "tool-ok";
    },
  } as unknown as Tool;
}

describe("P0-1 回归核验", () => {
  it("todo 提醒按步周期出现/消失时,相邻请求公共前缀覆盖历史的比例", async () => {
    const journal = new MemoryJournal();
    const sid = "chk-eph-v2";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(20000) } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "a".repeat(20000) } });
    journal.append({
      kind: "todo.updated", sessionId: sid,
      payload: { items: [{ content: "待办A", status: "pending" }] },
    });

    const sink: Message[][] = [];
    let n = 0;
    await new AgentLoop({
      journal, sessionId: sid, system: "SYS " + "s".repeat(1000),
      tools: [mkTool("noop")],
      // 关键:每 3 步注入一次 todo 提醒 → 存在性周期翻转
      todoReminderSteps: 3,
      llm: {
        async chat(messages: Message[]) {
          sink.push(messages.map((m) => ({ ...m })));
          n++;
          if (n >= 10) return { content: "done" };
          return { content: "", toolCalls: [{ id: `c${n}`, name: "noop", arguments: "{}" }] };
        },
      },
    }).runTurn("go");

    const lines: string[] = [];
    let bad = 0;
    for (let i = 1; i < sink.length; i++) {
      const a = sink[i - 1]!;
      const b = sink[i]!;
      const nmin = Math.min(a.length, b.length);
      let k = 0;
      while (k < nmin && a[k]!.role === b[k]!.role && mtxt(a[k]!) === mtxt(b[k]!)) k++;
      const prefixChars = a.slice(0, k).reduce((s, m) => s + mtxt(m).length, 0);
      const totalChars = b.reduce((s, m) => s + mtxt(m).length, 0);
      const ratio = prefixChars / Math.max(totalChars, 1);
      if (ratio < 0.9) bad++;
      const head = b.slice(0, 3).map((m) => `${m.role}:${mtxt(m).slice(0, 14).replace(/\n/g, " ")}`).join(" ‖ ");
      lines.push(
        `step${i}: ${a.length}->${b.length} msgs, 公共前缀=${k}, 覆盖 ${(ratio * 100).toFixed(1)}%` +
        ` | 本次前3条: ${head}`,
      );
    }
    console.log("\n" + lines.join("\n"));
    console.log(`\n[判定] 覆盖 <90% 的步数: ${bad}/${sink.length - 1}`);
    expect(sink.length).toBeGreaterThan(1);
  });
});