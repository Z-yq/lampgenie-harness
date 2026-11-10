/**
 * system 提示词 in-history(token 轮 P1,designs/token-opt-round3-p1 §3/§5):
 * 改前 loop 每步用当轮 system 原地重写 node0 → system 一变(任务类别切换/AGENTS.md 摘要刷新/
 * 技能索引新增/memory revision/计划文件注入)整段前缀缓存从 token 0 失效。
 * 改后:node0 = 该 session 首条 system.prompt 快照(冻结);变更改为在历史之后追加一条 user
 * 消息([系统提示更新]),且只在「历史够长」时才追加(成本守卫,短历史退回旧行为)。
 * 快照缺席(旧 journal/测试直接构造 loop)时消息序列与改前逐字一致。
 */
import { describe, it, expect } from "vitest";
import { AgentLoop, deriveMessages } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { LlmProvider, LlmResponse, Message, Tool } from "../src/agent/loop";

const UPDATE_PREFIX = "[系统提示更新] 以下为本轮生效的系统提示,与此前冲突时以本条为准:\n";

/** 落一条 system.prompt 快照(loop 消费侧的写入侧替身;真实写入在 gateway agent-wiring)。 */
function snapshot(journal: MemoryJournal, sessionId: string, text: string, extra?: { truncated?: boolean }): void {
  journal.append({
    kind: "system.prompt",
    sessionId,
    payload: { sha: `sha-${text.length}`, text, chars: text.length, ...(extra?.truncated ? { truncated: true } : {}) },
  });
}

/** 抓取每次 chat 请求的 messages;plan 决定第 n 次返回什么。 */
function capturingLlm(sink: Message[][], plan: (n: number) => LlmResponse): LlmProvider {
  let n = 0;
  return {
    async chat(messages: Message[]): Promise<LlmResponse> {
      sink.push(messages.map((m) => ({ ...m })));
      return plan(n++);
    },
  };
}

const noTool = { async execute() { return "ok"; }, isConcurrencySafe: () => true };
const mkTool = (name: string, out: string): Tool => ({
  name, description: "d", parameters: { type: "object", properties: {} },
  ...noTool,
  async execute() { return out; },
});

const isUpdate = (m: Message): boolean => m.content.startsWith("[系统提示更新]");
const updates = (msgs: Message[]): Message[] => msgs.filter(isUpdate);

describe("node0 冻结 + system 变更转追加(system 提示词 in-history)", () => {
  it("① 首步:有 system.prompt 快照时 messages[0] === 快照 text,且无追加消息", async () => {
    const journal = new MemoryJournal();
    const sid = "sih-1";
    const sys = "SYS-A " + "a".repeat(500);
    snapshot(journal, sid, sys);
    const sink: Message[][] = [];
    const loop = new AgentLoop({
      journal, sessionId: sid, system: sys, llm: capturingLlm(sink, () => ({ content: "ok" })),
    });
    await loop.runTurn("跑");

    const req = sink[0]!;
    expect(req[0]).toEqual({ role: "system", content: sys });
    expect(req[0]!.content).toBe(snapshotTextOf(journal, sid)); // 来源就是那条快照
    expect(updates(req)).toHaveLength(0);
    expect(req.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("② negative 无快照事件:node0 === opts.system,消息序列与改前逐字一致", async () => {
    const journal = new MemoryJournal();
    const sid = "sih-2";
    const sys = "SYS-COMPAT";
    const sink: Message[][] = [];
    const loop = new AgentLoop({
      journal, sessionId: sid, system: sys, llm: capturingLlm(sink, () => ({ content: "ok" })),
    });
    await loop.runTurn("go");

    // 逐字节:P1 之前请求体就是 [system(opts.system), ...deriveMessages(journal)]
    expect(JSON.stringify(sink[0])).toBe(JSON.stringify([
      { role: "system", content: sys },
      { role: "user", content: "go" },
    ]));
  });

  it("③ 第二个 turn 换了 system 且历史够长:node0 仍旧快照文本,末尾恰好 1 条 [系统提示更新]", async () => {
    const journal = new MemoryJournal();
    const sid = "sih-3";
    const sysOld = "SYS-OLD " + "o".repeat(900);
    const sysNew = "SYS-NEW " + "n".repeat(900);
    snapshot(journal, sid, sysOld);

    // turn 1:系统提示还是旧版(与快照一致)
    const sink1: Message[][] = [];
    await new AgentLoop({
      journal, sessionId: sid, system: sysOld, llm: capturingLlm(sink1, () => ({ content: "ok" })),
    }).runTurn("go");
    expect(updates(sink1[0]!)).toHaveLength(0);

    // 长历史:两条各 3000 字符(≈1500 tokens)> 门 ceil(908*0.6)=545
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(3000) } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "a".repeat(3000) } });

    // turn 2:换 system(新任务/摘要刷新后重建 loop,与 gateway 每任务新建 loop 同形)
    const sink2: Message[][] = [];
    await new AgentLoop({
      journal, sessionId: sid, system: sysNew, llm: capturingLlm(sink2, () => ({ content: "ok" })),
    }).runTurn("go");

    const req = sink2[0]!;
    expect(req[0]).toEqual({ role: "system", content: sysOld }); // node0 冻结在首条快照
    const up = updates(req);
    expect(up).toHaveLength(1);
    expect(up[0]!.content).toBe(UPDATE_PREFIX + sysNew);
    expect(up[0]!.role).toBe("user");
    // 追加消息不落 journal(落账会被 deriveMessages 重放成第二条=二次注入)
    expect(journal.readSession(sid).some((e) => JSON.stringify(e.payload).includes("[系统提示更新]"))).toBe(false);
  });

  it("④ 同 turn 连跑 3 步:node0 逐字节相同,追加恒 1 条,历史只增不改(前缀稳定)", async () => {
    const journal = new MemoryJournal();
    const sid = "sih-4";
    const sysOld = "SYS-OLD " + "o".repeat(380);
    const sysNew = "SYS-NEW " + "n".repeat(380);
    snapshot(journal, sid, sysOld);
    const sink: Message[][] = [];
    let n = 0;
    const loop = new AgentLoop({
      journal, sessionId: sid, system: sysNew,
      tools: [mkTool("noop", "x".repeat(3000))],
      llm: capturingLlm(sink, () => {
        n++;
        return n <= 2
          ? { content: "", toolCalls: [{ id: `c${n}`, name: "noop", arguments: "{}" }] }
          : { content: "done" };
      }),
    });
    // 首步历史就得过门:user 文本 3000 字符 = 750 tokens > ceil(388*0.6)=233
    await loop.runTurn("go" + "y".repeat(3000));

    expect(sink).toHaveLength(3);
    for (const req of sink) {
      expect(req[0]).toEqual({ role: "system", content: sysOld });
      expect(updates(req)).toHaveLength(1);
      expect(updates(req)[0]!.content).toBe(UPDATE_PREFIX + sysNew);
    }
    // 前缀稳定:上一请求(去掉临时追加)逐条是请求序列的前缀,且 node0 逐字节相同
    const strip = (msgs: Message[]): Message[] => msgs.filter((m) => !isUpdate(m));
    const isPrefix = (short: Message[], long: Message[]): boolean =>
      short.length <= long.length
      && JSON.stringify(long.slice(0, short.length)) === JSON.stringify(short);
    expect(isPrefix(strip(sink[0]!), strip(sink[1]!))).toBe(true);
    expect(isPrefix(strip(sink[1]!), strip(sink[2]!))).toBe(true);
    expect(new Set(sink.map((req) => JSON.stringify(req[0]))).size).toBe(1);
  });

  it("⑤ negative 历史很短(< 门):不追加,node0 === 当前 system(退回旧行为)", async () => {
    const journal = new MemoryJournal();
    const sid = "sih-5";
    const sysOld = "SYS-OLD " + "o".repeat(990);
    const sysNew = "SYS-NEW " + "n".repeat(990);
    snapshot(journal, sid, sysOld);
    // 历史 2 条各 200 字符 ≈ 100 tokens < 门 ceil(998*0.6)=599
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(200) } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "a".repeat(200) } });

    const sink: Message[][] = [];
    await new AgentLoop({
      journal, sessionId: sid, system: sysNew, llm: capturingLlm(sink, () => ({ content: "ok" })),
    }).runTurn("go");

    const req = sink[0]!;
    expect(req[0]).toEqual({ role: "system", content: sysNew }); // 旧行为:原地重写 node0
    expect(updates(req)).toHaveLength(0);
  });

  it("⑥ negative truncated 快照不得用作 node0:退回 opts.system(即便历史够长也不追加)", async () => {
    const journal = new MemoryJournal();
    const sid = "sih-6";
    const sysNew = "SYS-CUR " + "c".repeat(990);
    snapshot(journal, sid, "TRUNCATED-HEAD", { truncated: true });
    // 历史够长(4000 字符 ≈1000 tokens > 门 ceil(998*0.6)=599),确保「不追加」不是因为被门拦下
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(4000) } });

    const sink: Message[][] = [];
    await new AgentLoop({
      journal, sessionId: sid, system: sysNew, llm: capturingLlm(sink, () => ({ content: "ok" })),
    }).runTurn("go");

    const req = sink[0]!;
    expect(req[0]).toEqual({ role: "system", content: sysNew });
    expect(updates(req)).toHaveLength(0);
  });
});

describe("deriveMessages 不消费 system.prompt(旁路记录,零上下文影响)", () => {
  it("写 system.prompt 后 deriveMessages 输出条数与内容不变", () => {
    const journal = new MemoryJournal();
    const sid = "sih-derive";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "任务" } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "回执" } });
    const before = deriveMessages(journal, sid);
    snapshot(journal, sid, "SYS-SNAPSHOT " + "s".repeat(100));
    const after = deriveMessages(journal, sid);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after).toHaveLength(2);
  });

  it("⑦ negative 决策按 turn 冻结:长 turn 中途历史越门,node0 不得中途翻转、追加不得半路出现", async () => {
 // code_review:门用「当前历史 tokens」判定,而历史随 step 增长。若每步重算,
    // 首步不过门(退回旧行为,node0=当轮 system)、后面步骤越门后会突然把 node0 换成冻结快照
    // 并开始追加 —— 同一 turn 内 node0 身份翻转 = 又打碎一次前缀(正是本改动要消除的病)。
    // 这里刻意让首步**不过门**、第二步**越门**:断言整 turn node0 恒定且从无追加。
    const journal = new MemoryJournal();
    const sid = "sih-7";
    const sysOld = "SYS-OLD";
    // 门 = ceil(system.length/4 * 2);4004 字符 → 门 2002 tokens
    const sysNew = "SYS-NEW " + "n".repeat(3996);
    snapshot(journal, sid, sysOld);
    const sink: Message[][] = [];
    let n = 0;
    const loop = new AgentLoop({
      journal, sessionId: sid, system: sysNew,
      tools: [mkTool("big", "B".repeat(9000))], // 第二步灌入 ≈2250 tokens,单独就越门
      llm: capturingLlm(sink, () => {
        n++;
        return n === 1
          ? { content: "", toolCalls: [{ id: "c1", name: "big", arguments: "{}" }] }
          : { content: "done" };
      }),
    });
    await loop.runTurn("hi"); // 首步历史 ≈ 2 tokens,远低于门 2002

    expect(sink.length).toBe(2);
    // 整 turn node0 恒为「当轮 system」(首步定案=不追加),不得中途翻成 sysOld
    for (const req of sink) expect(req[0]).toEqual({ role: "system", content: sysNew });
    for (const req of sink) expect(updates(req)).toHaveLength(0);
  });
});

describe("system 提示节级增量注入(2026-10-29 token 轮 04)", () => {
  const SECTION_PREFIX = "[系统提示更新] 以下小节已变更,与此前冲突时以本条为准(未列出的小节保持原样):\n";
 /** 节尺寸按**生产环境经验证**构造(analysis/analyze7 经验证:identity 2.4K / AGENTS.md 1.5K /
   *  skill-index 13.6K / user_memory 8.1K / date 22),总数≈26K——不是随手造的等分节。
   *  这样断言的「省多少」才对得上真实场景。 */
  const mkSections = (over: Record<string, string> = {}) => [
    { name: "identity", content: over["identity"] ?? "IDENT " + "i".repeat(2400) },
    { name: "agents-md", content: over["agents-md"] ?? "AGENTS " + "a".repeat(1500) },
    { name: "skill-index", content: over["skill-index"] ?? "SKILLS " + "s".repeat(13600) },
    { name: "memory", content: over["memory"] ?? "MEMORY " + "m".repeat(8100) },
    { name: "date", content: over["date"] ?? "DATE 2026-10-29(周四)" },
  ];
  const joinSections = (secs: { content: string }[]): string => secs.map((s) => s.content).join("\n\n");

  it("section-diff:只有 agents-md 变了 → 只带这一节(<3000 字符,全量≈25.6K)", async () => {
    const journal = new MemoryJournal();
    const sid = "sec-1";
    snapshot(journal, sid, joinSections(mkSections())); // node0 冻结的是首版
    // 长历史过门:门 = ceil(system.length/4 * 2) ≈ 12800 tokens;60,000 字符 ≈ 15000 tokens
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(60_000) } });

    // 第一次(新任务=新 loop):无基线 → 落基线 + 付一次全文(无从知道差在哪)
    const sink1: Message[][] = [];
    const secs2 = mkSections({ "agents-md": "AGENTS-CHANGED " + "a".repeat(1500) });
    await new AgentLoop({
      journal, sessionId: sid, system: joinSections(secs2), systemSections: secs2,
      llm: capturingLlm(sink1, () => ({ content: "ok" })),
    }).runTurn("t1");
    const up1 = updates(sink1[0]!);
    expect(up1).toHaveLength(1);
    expect(up1[0]!.content.startsWith(UPDATE_PREFIX)).toBe(true); // 全文(基线未知)

    // 第二个任务(又是新 loop,实例缓存已丢——靠 journal 里的基线):memory 变更 → 只该节
    const sink2: Message[][] = [];
    const secs3 = mkSections({ "agents-md": "AGENTS-CHANGED " + "a".repeat(1500), memory: "MEMORY-NEW " + "m".repeat(8100) });
    await new AgentLoop({
      journal, sessionId: sid, system: joinSections(secs3), systemSections: secs3,
      llm: capturingLlm(sink2, () => ({ content: "ok" })),
    }).runTurn("t2");

    const up2 = updates(sink2[0]!);
    expect(up2).toHaveLength(1);
    const c = up2[0]!.content;
    expect(c.startsWith(SECTION_PREFIX)).toBe(true);
    expect(c).toContain("## memory");
    expect(c).toContain("MEMORY-NEW");
    // 未变更的节**不得**出现(这正是省下 20K 的地方)
    expect(c).not.toContain("## skill-index");
    expect(c).not.toContain("## identity");
    expect(c).not.toContain("## agents-md");
    expect(c).not.toContain("SKILLS ");
    // 体量对照:全量约 25.6K 字符,增量 ≈ memory 一节 8.1K(省 68%;旧口径是 100% 重发)
    const full = joinSections(secs3).length;
    expect(full).toBeGreaterThan(25_000);
    expect(c.length).toBeLessThan(full * 0.4);
  });

  it("negative no-sections-legacy:未传 systemSections → 追加内容逐字节等于旧行为(全文)", async () => {
    const journal = new MemoryJournal();
    const sid = "sec-2";
    const sysOld = "SYS-OLD " + "o".repeat(900);
    const sysNew = "SYS-NEW " + "n".repeat(900);
    snapshot(journal, sid, sysOld);
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(3000) } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "a".repeat(3000) } });

    const sink: Message[][] = [];
    await new AgentLoop({
      journal, sessionId: sid, system: sysNew, llm: capturingLlm(sink, () => ({ content: "ok" })),
    }).runTurn("go");

    const up = updates(sink[0]!);
    expect(up).toHaveLength(1);
    // 逐字节等于旧全文口径,且**不是**节级前缀
    expect(up[0]!.content).toBe(UPDATE_PREFIX + sysNew);
    expect(up[0]!.content.startsWith(SECTION_PREFIX)).toBe(false);
  });

  it("zero-append:同一 loop 内 sections 无变化 → 第二步零追加(不 push 空壳)", async () => {
    const journal = new MemoryJournal();
    const sid = "sec-3";
    const secs = mkSections();
    const sys = joinSections(secs);
    snapshot(journal, sid, sys);
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(60_000) } });

    const sink: Message[][] = [];
    let n = 0;
    const loop = new AgentLoop({
      journal, sessionId: sid, system: sys, systemSections: secs,
      tools: [mkTool("noop", "x".repeat(100))],
      llm: capturingLlm(sink, () => {
        n++;
        return n === 1
          ? { content: "", toolCalls: [{ id: "c1", name: "noop", arguments: "{}" }] }
          : { content: "done" };
      }),
    });
    // 注意:这里 headSystem === system(快照与当轮一致)→ systemDecision 为 false,本来就不追加;
    // 该用例只断言「零追加」这个结果,不依赖走的是哪条分支(negative 语义:绝不出现空壳)。
    await loop.runTurn("go");
    expect(sink).toHaveLength(2);
    for (const req of sink) {
      const up = updates(req);
      // 要么没有,要么有内容——绝不能是只有一个前缀的空壳
      for (const u of up) expect(u.content.trim().length).toBeGreaterThan(UPDATE_PREFIX.length);
    }
  });

  it("节标题去重:内容自带 `## ` 标题的节不再加 `## name`(2026-10-30 修 f2)", async () => {
 // 经验证缺陷(本轮系统提示更新现场):dateBlock 内容本身就是 "\n\n## 当前日期\n2026-10-30(周五)",
    // 旧渲染固定拼 `## ${name}\n${content}` → 产出
    //   ## date
    //            ← 空行
    //   ## 当前日期
    // 既多花字符,也让模型看到两个标题、不确定哪个是节名。
    // 三 turn 是必须的(基线建立机制):turn1 node0==当轮 system → systemDecision=false,不落基线;
    // turn2 首次变更 → 落基线但**无从 diff**,付一次全文;turn3 起才真正走节 diff。
    const mk = (dateText: string) => [
      { name: "identity", content: "IDENT " + "i".repeat(3000) },
      { name: "date", content: `\n\n## 当前日期\n${dateText}` },
    ];
    const journal = new MemoryJournal();
    const sid = "sec-title";
    const s1 = mk("2026-10-30(周五)");
    snapshot(journal, sid, s1.map((x) => x.content).join("\n\n"));
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(60_000) } });

    const run = async (secs: { name: string; content: string }[]) => {
      const sink: Message[][] = [];
      await new AgentLoop({
        journal, sessionId: sid, system: secs.map((x) => x.content).join("\n\n"), systemSections: secs,
        llm: capturingLlm(sink, () => ({ content: "ok" })),
      }).runTurn("t");
      return updates(sink[0]!);
    };

    await run(s1);                        // turn1:无追加
    const u2 = await run(mk("2026-10-31(周六)")); // turn2:落基线 → 全文
    expect(u2[0]!.content.startsWith(UPDATE_PREFIX)).toBe(true);

    // turn3:真正的节 diff 路径(只发 date 节)
    const u3 = await run(mk("2026-11-01(周日)"));
    expect(u3).toHaveLength(1);
    const c = u3[0]!.content;
    expect(c.startsWith(SECTION_PREFIX)).toBe(true);
    expect(c).toContain("## 当前日期");
    expect(c).toContain("2026-11-01");
    // negative:不得把内部节名当标题
    expect(c).not.toContain("## date");
    // negative:整段只能有一个 markdown 标题行
    expect(c.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(1);
  });

  it("negative 内容不自带标题的节仍加 `## name`(去重不误伤常规节)", async () => {
    const journal = new MemoryJournal();
    const sid = "sec-title2";
    const s1 = [{ name: "identity", content: "IDENT-1 " + "i".repeat(3000) }];
    snapshot(journal, sid, s1[0]!.content);
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(60_000) } });

    const run = async (secs: { name: string; content: string }[]) => {
      const sink: Message[][] = [];
      await new AgentLoop({ journal, sessionId: sid, system: secs[0]!.content, systemSections: secs, llm: capturingLlm(sink, () => ({ content: "ok" })) }).runTurn("t");
      return updates(sink[0]!);
    };
    await run(s1);                                                   // turn1
    await run([{ name: "identity", content: "IDENT-2 " + "i".repeat(3000) }]); // turn2:落基线→全文
    const u3 = await run([{ name: "identity", content: "IDENT-3 " + "i".repeat(3000) }]); // turn3:节 diff
    const c = u3[0]!.content;
    expect(c.startsWith(SECTION_PREFIX)).toBe(true);
    expect(c).toContain("## identity"); // 常规节照旧带节名
    expect(c).toContain("IDENT-3");
  });
});

describe("ephemeral 注入位置(2026-10-30 核查回滚)", () => {
  it("a) 该块追加在历史末尾;历史部分逐字节稳定(前置到 index 1 会使块变动→整条历史失效)", async () => {
    const journal = new MemoryJournal();
    const sid = "eph-a";
    const sysOld = "SYS-OLD " + "o".repeat(900);
    const sysNew = "SYS-NEW " + "n".repeat(900);
    snapshot(journal, sid, sysOld);
    // 历史过门
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(3000) } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "a".repeat(3000) } });

    const sink: Message[][] = [];
    let n = 0;
    await new AgentLoop({
      journal, sessionId: sid, system: sysNew,
      tools: [mkTool("noop", "r".repeat(50))],
      llm: capturingLlm(sink, () => {
        n++;
 // 两步:第一步派工具(历史增长),第二步
        return n === 1 ? { content: "", toolCalls: [{ id: "c1", name: "noop", arguments: "{}" }] } : { content: "done" };
      }),
    }).runTurn("go");

    expect(sink.length).toBeGreaterThanOrEqual(2);
    const [first, second] = [sink[0]!, sink[1]!];
    // 第二步历史更长(多了 assistant+tool 两条)
    expect(second.length).toBeGreaterThan(first.length);
    // 块在**末尾**(紧跟历史):块变动时失效区域只有「块+本步新增」,不是整条历史
    expect(updates(first)).toHaveLength(1);
    expect(updates(second)).toHaveLength(1);
    expect(first[first.length - 1]!.content.startsWith("[系统提示更新]")).toBe(true);
    expect(second[second.length - 1]!.content.startsWith("[系统提示更新]")).toBe(true);
 // negative:块不得出现在 system 之后(index 1)——那是已经验证回滚的错误方向
    // (todoReminderSteps=3 探针:前置时 9 步里 5 步公共前缀塌到 1 条、覆盖率 2.4%)
    expect(first[1]!.content.startsWith("[系统提示更新]")).toBe(false);
    // 历史部分(除去末尾块)逐字节稳定:第二步以第一步的历史为前缀
    const h1 = first.slice(0, -1);
    const h2 = second.slice(0, -1);
    expect(h2.slice(0, h1.length)).toEqual(h1);
  });

  it("b) 第二 turn 仍重发该块(negative:不得因内容相同被跳过)", async () => {
    const journal = new MemoryJournal();
    const sid = "eph-b";
    const sysOld = "SYS-OLD " + "o".repeat(900);
    const sysNew = "SYS-NEW " + "n".repeat(900);
    snapshot(journal, sid, sysOld);
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(3000) } });
    journal.append({ kind: "message.agent", sessionId: sid, payload: { text: "a".repeat(3000) } });

    // 用同一 loop 跑两个 turn,逐 turn 抓请求
    const collected: Message[][] = [];
    let k = 0;
    const loop = new AgentLoop({
      journal, sessionId: sid, system: sysNew,
      llm: { async chat(messages: Message[]) { collected.push(messages.map((m) => ({ ...m }))); k++; return { content: "ok" }; } },
    });
    await loop.runTurn("t1");
    await loop.runTurn("t2");
    expect(collected).toHaveLength(2);
    for (const req of collected) {
      const up = updates(req);
      expect(up).toHaveLength(1); // 每 turn 都重发(ephemeral 不落 journal)
 // 位置=历史末尾(核查回滚:前置到 index 1 会让块变动即令整条历史失效)
      expect(req[req.length - 1]).toBe(up[0]);
    }
    expect(collected[1]![1]!.content.startsWith("[系统提示更新]")).toBe(false); // 不得前置
    expect(collected[1]![collected[1]!.length - 1]!.content).toBe(collected[0]![collected[0]!.length - 1]!.content); // 逐字节相同也不跳过
  });
});

describe("delta 持久化(2026-11 token 轮 P2:内容不变不再重投)", () => {
  /** 节级增量前缀(与 loop 内 SYSTEM_SECTION_UPDATE_PREFIX 逐字一致;describe 块作用域独立声明)。 */
  const SECTION_PREFIX = "[系统提示更新] 以下小节已变更,与此前冲突时以本条为准(未列出的小节保持原样):\n";
  /** 两节制:identity 恒固定,date 可变——变更粒度=单节,便于断言 delta 全文。 */
  const mk = (dateText: string) => [
    { name: "identity", content: "IDENT " + "i".repeat(2400) },
    { name: "date", content: `\n\n## 当前日期\n${dateText}` },
  ];
  const join = (secs: { content: string }[]): string => secs.map((s) => s.content).join("\n\n");
  /** 建一个「基线已就位」的 journal:先跑一轮拿基线(首见=全文一次),返回 sessionId。 */
  const seed = (sid: string): { journal: MemoryJournal; s2: { name: string; content: string }[] } => {
    const journal = new MemoryJournal();
    const s1 = mk("2026-11-01(周日)");
    snapshot(journal, sid, join(s1)); // node0 冻结首版
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "u".repeat(60_000) } }); // 历史过门
    return { journal, s2: mk("2026-11-02(周一)") };
  };

  it("a) 同内容不重发:连续 3 步 system 不变 → 每步请求里 delta 恰好 1 条", async () => {
    const sid = "delta-a";
    const { journal, s2 } = seed(sid);
    // 轮一:无基线 → 落基线 + 全文一次(既有口径,不经 delta 落账)
    await new AgentLoop({
      journal, sessionId: sid, system: join(s2), systemSections: s2,
      llm: capturingLlm([], () => ({ content: "ok" })),
    }).runTurn("t1");

    const s3 = mk("2026-11-03(周二)");
    const sink: Message[][] = [];
    let n = 0;
    await new AgentLoop({
      journal, sessionId: sid, system: join(s3), systemSections: s3,
      tools: [mkTool("noop", "x".repeat(200))],
      llm: capturingLlm(sink, () => {
        n++;
        return n <= 2 ? { content: "", toolCalls: [{ id: `c${n}`, name: "noop", arguments: "{}" }] } : { content: "done" };
      }),
    }).runTurn("go");

    expect(sink).toHaveLength(3);
    for (const req of sink) {
      const up = updates(req);
      expect(up).toHaveLength(1); // 每步恰好 1 条:落账后既不再 push,也不得与重放叠加成 2 条
      expect(up[0]!.content.startsWith(SECTION_PREFIX)).toBe(true);
      expect(up[0]!.content).toContain("2026-11-03");
    }
    // 3 步内容逐字节相同(不变就不该出现第二个版本)
    expect(new Set(sink.map((r) => updates(r)[0]!.content)).size).toBe(1);
    // 落账条数=1:同内容只落一条 journal 事件(不是每步一条)
    const landed = journal.readSession(sid).filter(
      (e) => e.kind === "custom" && (e.payload as { what?: string }).what === "system.delta",
    );
    expect(landed).toHaveLength(1);
  });

  it("b) 内容变化才新增:中途改 sections → 出现第 2 条且内容不同", async () => {
    const sid = "delta-b";
    const { journal, s2 } = seed(sid);
    await new AgentLoop({
      journal, sessionId: sid, system: join(s2), systemSections: s2,
      llm: capturingLlm([], () => ({ content: "ok" })),
    }).runTurn("t1");

    const s3 = mk("2026-11-03(周二)");
    await new AgentLoop({
      journal, sessionId: sid, system: join(s3), systemSections: s3,
      llm: capturingLlm([], () => ({ content: "ok" })),
    }).runTurn("t2");

    // 第三轮:date 再变 → 新 delta 追加;旧 delta 仍在历史里被重放(共 2 条)
    const s4 = mk("2026-11-04(周三)");
    const sink: Message[][] = [];
    await new AgentLoop({
      journal, sessionId: sid, system: join(s4), systemSections: s4,
      llm: capturingLlm(sink, () => ({ content: "done" })),
    }).runTurn("t3");

    const up = updates(sink[0]!);
    expect(up).toHaveLength(2);
    expect(up[0]!.content).toContain("2026-11-03");
    expect(up[1]!.content).toContain("2026-11-04");
    expect(up[0]!.content).not.toBe(up[1]!.content);
    // 顺序=落账顺序(历史末尾按 seq 追加),不得倒置
    expect(up[1]!.content.startsWith(SECTION_PREFIX)).toBe(true);
  });

  it("c) compact 后重发:带 summary 的 compact.done 抹掉旧 delta → 下一步仍带 delta(不得静默失忆)", async () => {
    const sid = "delta-c";
    const { journal, s2 } = seed(sid);
    await new AgentLoop({
      journal, sessionId: sid, system: join(s2), systemSections: s2,
      llm: capturingLlm([], () => ({ content: "ok" })),
    }).runTurn("t1");

    const s3 = mk("2026-11-03(周二)");
    await new AgentLoop({
      journal, sessionId: sid, system: join(s3), systemSections: s3,
      llm: capturingLlm([], () => ({ content: "ok" })),
    }).runTurn("t2");

    // 真压缩:summary 非空 → deriveMessages 走 out.length=0 硬截断,delta 事件被一并抹掉。
    journal.append({
      kind: "compact.done",
      sessionId: sid,
      payload: { summary: "压缩摘要", tail: [{ role: "user", content: "t".repeat(6000) }] },
    });
    // 压缩后历史只有 tail(6000 字符≈1500 tok)过门(门 ≈ ceil(system/4*2) ≈ 1213 tok)
    expect(deriveMessages(journal, sid).some((m) => m.content.includes("2026-11-03"))).toBe(false);

    // 下一轮:system 未变,但压缩边界晚于 delta 落账 → 必须强制重落 + 本次带上
    const sink: Message[][] = [];
    await new AgentLoop({
      journal, sessionId: sid, system: join(s3), systemSections: s3,
      llm: capturingLlm(sink, () => ({ content: "done" })),
    }).runTurn("t3");

    const up = updates(sink[0]!);
    expect(up).toHaveLength(1);
    expect(up[0]!.content).toContain("2026-11-03"); // 压缩前的内容没有静默丢失
    // 重落后 deriveMessages 能重放它(下步零重投的持久面)
    expect(deriveMessages(journal, sid).filter((m) => m.content.startsWith(SECTION_PREFIX))).toHaveLength(1);
    // 合计落账 2 条(压缩前 1 条 + 压缩后重落 1 条),不是每步一条
    expect(journal.readSession(sid).filter(
      (e) => e.kind === "custom" && (e.payload as { what?: string }).what === "system.delta",
    )).toHaveLength(2);
  });
it("d) negative 二次注入:compact 的 tail 已保留该 delta → 仍恰好 1 条(既不 push 也不重落)", async () => {
    const sid = "delta-d";
    const { journal, s2 } = seed(sid);
    await new AgentLoop({
      journal, sessionId: sid, system: join(s2), systemSections: s2,
      llm: capturingLlm([], () => ({ content: "ok" })),
    }).runTurn("t1");

    const s3 = mk("2026-11-03(周二)");
    await new AgentLoop({
      journal, sessionId: sid, system: join(s3), systemSections: s3,
      llm: capturingLlm([], () => ({ content: "ok" })),
    }).runTurn("t2");
    const landedDelta = journal.readSession(sid).find(
      (e) => e.kind === "custom" && (e.payload as { what?: string }).what === "system.delta",
    )!;
    const deltaText = (landedDelta.payload as { text: string }).text;

    // 真压缩,且 tail 恰好把这条 delta 原文保了下来(rollover 后 derive 会重放它)
    journal.append({
      kind: "compact.done",
      sessionId: sid,
      payload: {
        summary: "压缩摘要",
        tail: [
          { role: "user", content: "t".repeat(6000) },
          { role: "user", content: deltaText },
        ],
      },
    });
    expect(deriveMessages(journal, sid).filter((m) => m.content === deltaText)).toHaveLength(1);

    const sink: Message[][] = [];
    await new AgentLoop({
      journal, sessionId: sid, system: join(s3), systemSections: s3,
      llm: capturingLlm(sink, () => ({ content: "done" })),
    }).runTurn("t3");

    // 恰好 1 条:历史重放的那条;不得再 push/再重落成第 2 条
    expect(updates(sink[0]!).filter((m) => m.content.startsWith(SECTION_PREFIX))).toHaveLength(1);
    expect(updates(sink[0]!).filter((m) => m.content === deltaText)).toHaveLength(1);
  });
});

/** 读出该 session 第一条快照的 text(断言 node0 来源用)。 */
function snapshotTextOf(journal: MemoryJournal, sessionId: string): string | undefined {
  const ev = journal.readSession(sessionId).find((e) => e.kind === "system.prompt");
  return (ev?.payload as { text?: string } | undefined)?.text;
}
