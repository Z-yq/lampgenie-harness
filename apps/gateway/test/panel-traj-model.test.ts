/**
 * 会话轨迹建模层纯函数契约(panel 轨迹卡数据面)。
 * 事件形状核准自真实 emit 侧:llm.trace(apps/gateway/src/llm-trace.ts:145)、tool.call(loop.ts:2034)、
 * tool.result(loop.ts:1792)、compact.done(auto-compact.ts:222)、compact.skipped(auto-compact.ts:151)、
 * custom type=task.phase(agent-wiring.ts:5155)、context.prune(loop.ts:1407)、context.model.score(loop.ts:1088)。
 * 断言一律给精确数字/字符串,模糊处用 toBeCloseTo。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildTrajRows, groupTrajTurns, summarizeTraj, filterTrajRows, capTrajRows,
  fmtTokens, fmtDuration, TRAJ_ROW_CAP, commonPrefixLen, splitCachedInput, approxTokens,
  type TrajRow,
} from "../src/panel-traj-model.js";

/** 事件工厂:只给关键字段,其余缺省(防御式读取的对照组)。 */
function ev(seq: number, kind: string, time: number, payload: unknown, sessionId = "s1") {
  return { seq, kind, time, sessionId, payload };
}

// 两轮真实形状:user → trace/tool → agent → user → trace → agent
const twoTurns = [
  ev(1, "message.user", 1000, { text: "修一下 panel.ts 的轨迹卡" }),
  ev(2, "llm.trace", 1500, {
    turn: 1, step: 1, model: "claude-x", durationMs: 500,
    usage: { inputTokens: 600, outputTokens: 60, cachedTokens: 540 },
    responseHead: "我先读 panel.ts\n第二行不显示", toolCalls: ["read_file"],
  }),
  ev(3, "tool.call", 1600, { toolCallId: "c1", name: "read_file", arguments: '{"path":"a.ts"}', turn: 1, step: 1 }),
  ev(4, "tool.result", 1750, { toolCallId: "c1", name: "read_file", content: "ok", durationMs: 150, turn: 1, step: 1 }),
  ev(5, "message.agent", 2000, { text: "读完了", turn: 1, step: 1 }),
  ev(6, "message.user", 3000, { text: "继续" }),
  ev(7, "llm.trace", 3600, {
    turn: 2, step: 1, model: "claude-x", durationMs: 600,
    usage: { inputTokens: 400, outputTokens: 60, cachedTokens: 406 },
    responseHead: "改好了",
  }),
  ev(8, "message.agent", 4000, { text: "改好了", turn: 2, step: 1 }),
];

describe("① 轮分组:calls/wallMs/turn 号", () => {
  it("两轮 → 2 turn,turn 号来自 llm.trace,wallMs=轮内首末事件差", () => {
    const rows = buildTrajRows(twoTurns);
    const turns = groupTrajTurns(rows);
    expect(turns.length).toBe(2);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    // 轮 1:1000(user) → 2000(agent),1 次工具调用,0 错误
    expect(turns[0]).toMatchObject({ turn: 1, startAt: 1000, endAt: 2000, wallMs: 1000, calls: 1, errors: 0 });
    // 轮 2:3000(user) → 4000(agent),无工具
    expect(turns[1]).toMatchObject({ turn: 2, startAt: 3000, endAt: 4000, wallMs: 1000, calls: 0, errors: 0 });
    // 轮 1 工具直方图:read_file ×1
    expect(turns[0]!.toolHistogram).toEqual([{ name: "read_file", count: 1 }]);
    // 行按 seq 稳定升序 + idx 连续
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 5, 6, 7, 8]); // seq4 的 tool.result 并进 seq3 行
    expect(rows.map((r) => r.idx)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("缺 payload.turn 时按 message.user 递增兜底", () => {
    const rows = buildTrajRows([
      ev(1, "message.user", 10, { text: "a" }),
      ev(2, "message.agent", 20, { text: "aaa" }),
      ev(3, "message.user", 30, { text: "b" }),
      ev(4, "message.agent", 40, { text: "bbb" }),
    ]);
    expect(rows.map((r) => r.turn)).toEqual([1, 1, 2, 2]);
  });
});

describe("② token 汇总精确", () => {
  it("input 1000 / cached 946 / output 120 → cacheHitRate≈0.946", () => {
    const rows = buildTrajRows([
      ev(1, "message.user", 1000, { text: "go" }),
      ev(2, "llm.trace", 1500, { turn: 1, step: 1, model: "m", durationMs: 10, usage: { inputTokens: 1000, cachedTokens: 946, outputTokens: 120 } }),
    ]);
    const turns = groupTrajTurns(rows);
    const s = summarizeTraj(rows, turns);
    expect(s.inputTokens).toBe(1000);
    expect(s.cachedTokens).toBe(946);
    expect(s.outputTokens).toBe(120);
    expect(s.cacheHitRate).toBeCloseTo(0.946, 3);
    expect(turns[0]!.inputTokens).toBe(1000);
    expect(turns[0]!.cachedTokens).toBe(946);
    // message.agent 的 usage 不参与(同一次调用双计防线)
    const rows2 = buildTrajRows([
      ev(1, "llm.trace", 1, { turn: 1, step: 1, usage: { inputTokens: 100 } }),
      ev(2, "message.agent", 2, { text: "x", turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 5 } }),
    ]);
    expect(summarizeTraj(rows2, groupTrajTurns(rows2)).inputTokens).toBe(100);
  });
});

describe("③ tool.call + tool.result 同 toolCallId 合成一行", () => {
  it("1 行、durationMs 与 error 回填;找不到 call 的 result 自成一行", () => {
    const rows = buildTrajRows([
      ev(1, "tool.call", 100, { toolCallId: "c9", name: "run_tests", arguments: '{"cmd":"vitest"}', turn: 1 }),
      ev(2, "tool.result", 900, { toolCallId: "c9", name: "run_tests", content: "1 failed", durationMs: 800, turn: 1 }),
      // 孤儿 result(跨会话截断)→ 自成一行
      ev(3, "tool.result", 1000, { toolCallId: "gone", name: "shell", content: "boom", durationMs: 12, error: { origin: "threw", message: "boom" }, turn: 1 }),
    ]);
    const toolRows = rows.filter((r) => r.kind === "tool");
    expect(toolRows.length).toBe(2);
    const c9 = toolRows[0]!;
    expect(c9.label).toBe("run_tests");
    expect(c9.toolCallId).toBe("c9");
    expect(c9.durationMs).toBe(800);
    expect(c9.status).toBe("ok");
    expect(c9.summary).toBe('{"cmd":"vitest"}'); // 调用行摘要保留参数,不被结果覆盖
    const orphan = toolRows[1]!;
    expect(orphan.toolName).toBe("shell");
    expect(orphan.durationMs).toBe(12);
    expect(orphan.status).toBe("error");
    expect(orphan.error).toBe("boom");
    // 未等到 result 的 call 保持 pending
    const pend = buildTrajRows([ev(1, "tool.call", 5, { toolCallId: "p1", name: "read_file", arguments: "{}" })]);
    expect(pend[0]!.status).toBe("pending");
  });
});

describe("④ 错误态", () => {
  it("llm.trace payload.error → status=error 且 errors+1;失败态 ms 也认", () => {
    const rows = buildTrajRows([
      ev(1, "message.user", 100, { text: "go" }),
      ev(2, "llm.trace", 200, { turn: 1, step: 1, model: "m", ms: 300, error: "502 Bad Gateway" }),
      ev(3, "llm.trace", 400, { turn: 1, step: 2, model: "m", durationMs: 100, usage: { inputTokens: 10 } }),
    ]);
    const trace1 = rows.find((r) => r.seq === 2)!;
    expect(trace1.status).toBe("error");
    expect(trace1.error).toBe("502 Bad Gateway");
    expect(trace1.durationMs).toBe(300); // 失败态字段名是 ms(llm-trace.ts 的失败分支)
    const turns = groupTrajTurns(rows);
    const s = summarizeTraj(rows, turns);
    expect(s.errors).toBe(1);
    expect(turns[0]!.errors).toBe(1);
  });
});

describe("⑤ compact / task.phase 映射", () => {
  it("compact.done/skipped → kind=compact;custom type=task.phase → kind=phase", () => {
    const rows = buildTrajRows([
      ev(1, "message.user", 10, { text: "go" }),
      ev(2, "compact.done", 20, { summary: "前面讨论了轨迹卡布局", trigger: "auto", tokensBefore: 90000 }),
      ev(3, "compact.skipped", 30, { reason: "上下文基线过大,已暂停自动压缩", trigger: "auto" }),
      ev(4, "custom", 40, { type: "task.phase", phase: "plan", note: "落板" }),
      ev(5, "custom", 50, { type: "task.phase", phase: "verify", note: "", skip: true }),
      ev(6, "step.start", 60, { turn: 1, step: 1 }), // 未列举 kind → other
    ]);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(["user", "compact", "compact", "phase", "phase", "other"]);
    expect(rows[1]!.summary).toBe("auto · 前面讨论了轨迹卡布局");
    expect(rows[2]!.summary).toBe("跳过 · 上下文基线过大,已暂停自动压缩");
    expect(rows[3]!.label).toBe("plan");
    expect(rows[3]!.summary).toBe("落板");
    expect(rows[4]!.label).toBe("verify");
    expect(rows[4]!.summary).toBe("skip");
    expect(rows[5]!.label).toBe("step.start");
  });
});

describe("⑥ 空/字段全缺 → 零值不抛错", () => {
  it("空数组与非数组输入", () => {
    for (const bad of [[], null, undefined, 42, "x", {}]) {
      const rows = buildTrajRows(bad as never);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
      const turns = groupTrajTurns(rows);
      expect(turns).toEqual([]);
      const s = summarizeTraj(rows, turns);
      expect(s).toEqual({
        calls: 0, turns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheHitRate: 0,
        tools: 0, errors: 0, wallMs: 0, localScores: 0, prunes: 0, rows: 0,
      });
      expect(s.cacheHitRate).toBe(0); // 除零防线:input=0 → 0 而非 NaN
    }
  });

  it("元素形状全缺/垃圾 payload 不抛错,行字段为零值兜底", () => {
    const rows = buildTrajRows([
      null, 42, {},
      { kind: "llm.trace" },                                   // 无 payload/time/seq
      { kind: "tool.call", payload: null },
      { kind: "tool.result", payload: { toolCallId: 42 } },     // 非字符串 id
      { kind: "buildTrajRows" },
    ]);
    expect(rows.length).toBe(5); // null/42 非对象被跳过;{} 也成一行(空 kind)
    const s = summarizeTraj(rows, groupTrajTurns(rows));
    expect(s.cacheHitRate).toBe(0);
    expect(Number.isFinite(s.wallMs)).toBe(true);
    expect(s.rows).toBe(5);
  });
});

describe("⑦ 行数上限 1500", () => {
  it("1501 行 → 保留最近 1500、truncated=true、total=1501,且首行是第 2 条", () => {
    const evs = Array.from({ length: 1501 }, (_, i) => ev(i + 1, "message.user", 1000 + i, { text: "u" + (i + 1) }));
    const rows = buildTrajRows(evs);
    expect(rows.length).toBe(1501);
    const capped = capTrajRows(rows);
    expect(capped.total).toBe(1501);
    expect(capped.truncated).toBe(true);
    expect(capped.rows.length).toBe(TRAJ_ROW_CAP);
    expect(capped.rows[0]!.seq).toBe(2);
    expect(capped.rows[capped.rows.length - 1]!.seq).toBe(1501);
    // 未超上限:原样返回且 truncated=false
    const small = capTrajRows(rows.slice(0, 1500));
    expect(small).toMatchObject({ truncated: false, total: 1500 });
    expect(small.rows.length).toBe(1500);
  });
});

describe("⑧ filter:四种 mode + 搜索词", () => {
  const rows: TrajRow[] = buildTrajRows([
    ev(1, "message.user", 10, { text: "修 panel.ts 的轨迹卡" }),
    ev(2, "llm.trace", 20, { turn: 1, step: 1, model: "Claude-X", responseHead: "先读文件" }),
    ev(3, "tool.call", 30, { toolCallId: "c1", name: "read_file", arguments: '{"path":"panel.ts"}' }),
    ev(4, "tool.result", 40, { toolCallId: "c1", name: "read_file", durationMs: 5 }),
    ev(5, "tool.call", 50, { toolCallId: "c2", name: "shell", arguments: '{"cmd":"ls"}' }),
    ev(6, "tool.result", 60, { toolCallId: "c2", name: "shell", durationMs: 7, error: { origin: "threw", message: "ENOENT" } }),
    ev(7, "llm.trace", 70, { turn: 1, step: 2, model: "claude-x", error: "timeout" }),
  ]);

  it("mode 过滤计数精确", () => {
    // 7 条事件 → 5 行(两条 tool.result 各并进对应 tool.call)
    expect(filterTrajRows(rows, "all").length).toBe(5); // 1 user + 2 model + 2 tool
    expect(filterTrajRows(rows, "model").length).toBe(2);
    expect(filterTrajRows(rows, "tool").length).toBe(2);
    expect(filterTrajRows(rows, "error").length).toBe(2); // shell 结果 error + timeout trace
  });

  it("query 大小写不敏感匹配 label/summary/toolName", () => {
    expect(filterTrajRows(rows, "all", "CLAUDE").length).toBe(2); // label=model 名
    expect(filterTrajRows(rows, "tool", "SHELL").length).toBe(1); // toolName
    expect(filterTrajRows(rows, "all", "panel.ts").length).toBe(2); // user 文本 + read_file 参数
    // query 只查 label/summary/toolName(口径见任务书),error 文本不进匹配面:
    // error 行里按模型名(label)仍可命中
    expect(filterTrajRows(rows, "error", "claude").length).toBe(1);
    expect(filterTrajRows(rows, "error", "timeout").length).toBe(0);
    expect(filterTrajRows(rows, "all", "   ").length).toBe(filterTrajRows(rows, "all").length);
    expect(filterTrajRows(rows, "tool", "no-such-thing").length).toBe(0);
  });
});

describe("⑨ 汇总口径:localScores / prunes / tools / wallMs", () => {
  it("context.model.score 计数;context.prune 按 items 求和;无 prune 时回落 compact.skipped", () => {
    const rows = buildTrajRows([
      ev(1, "message.user", 1000, { text: "go" }),
      ev(2, "context.model.score", 1010, { step: 1, mode: "single", decisions: [{}, {}] }),
      ev(3, "context.model.score", 1020, { step: 2, mode: "single" }),
      ev(4, "context.prune", 1030, { reason: "big", savedTokens: 500, items: [{ toolCallId: "a" }, { toolCallId: "b" }, { toolCallId: "c" }] }),
      ev(5, "tool.call", 1040, { toolCallId: "t1", name: "read_file", arguments: "{}" }),
      ev(6, "tool.call", 1050, { toolCallId: "t2", name: "read_file", arguments: "{}" }),
      ev(7, "tool.call", 1060, { toolCallId: "t3", name: "shell", arguments: "{}" }),
      ev(8, "message.agent", 2000, { text: "done" }),
    ]);
    const turns = groupTrajTurns(rows);
    const s = summarizeTraj(rows, turns);
    expect(s.localScores).toBe(2);
    expect(s.prunes).toBe(3);      // Σ items.length
    expect(s.calls).toBe(3);
    expect(s.tools).toBe(2);       // read_file / shell 去重
    expect(s.wallMs).toBe(1000);   // 单轮 1000→2000
    expect(s.rows).toBe(8);
    expect(s.turns).toBe(1);

    // 回落:无 context.prune 但有 compact.skipped → prunes=跳过数
    const rows2 = buildTrajRows([
      ev(1, "compact.skipped", 10, { reason: "r1" }),
      ev(2, "compact.skipped", 20, { reason: "r2" }),
    ]);
    expect(summarizeTraj(rows2, groupTrajTurns(rows2)).prunes).toBe(2);
  });
});

describe("⑩ fmtTokens / fmtDuration", () => {
  it("token 速览", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000)).toBe("1.0K");
    expect(fmtTokens(1234)).toBe("1.2K");
    expect(fmtTokens(1234567)).toBe("1.23M");
    expect(fmtTokens(Number.NaN)).toBe("0");
  });

  it("耗时速览", () => {
    expect(fmtDuration(123)).toBe("123ms");
    expect(fmtDuration(999)).toBe("999ms");
    expect(fmtDuration(1000)).toBe("1.0s");
    expect(fmtDuration(1234)).toBe("1.2s");
    expect(fmtDuration(59999)).toBe("60.0s");
    expect(fmtDuration(60000)).toBe("1m00s");
    expect(fmtDuration(65000)).toBe("1m05s");
    expect(fmtDuration(-5)).toBe("0ms");
    expect(fmtDuration(Number.NaN)).toBe("0ms");
  });
});

describe("⑪ 真实 journal 样本回放", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const jdir = join(here, "..", "..", "..", ".genie", "journals", "sessions");
  const pick = (): { file: string; events: unknown[] } | null => {
    if (!existsSync(jdir)) return null;
    // 取含 llm.trace 最多的一个会话文件(最能压到轨迹映射的所有分支)
    let best: { file: string; events: unknown[] } | null = null;
    for (const f of readdirSync(jdir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(jdir, f);
      // journal 里有真实截断行(停电/并发写),逐行 try 解析、坏行跳过——
      // 与 core journal.load 的容错口径一致,样本才能取到「事件最多」那个文件
      const events: unknown[] = [];
      for (const line of readFileSync(p, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line) as unknown); } catch { /* 坏行跳过 */ }
      }
      const n = events.filter((e) => (e as { kind?: string }).kind === "llm.trace").length;
      if (n > 0 && (!best || n > best.events.filter((e) => (e as { kind?: string }).kind === "llm.trace").length)) best = { file: p, events };
    }
    return best;
  };
  const sample = pick();

  it.skipIf(!sample || sample.events.length === 0)("真实事件 → 行非空、不抛错、字段自洽", () => {
    const rows = buildTrajRows(sample ? sample.events : []);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.seq).toBe("number");
      expect(Number.isFinite(r.turn)).toBe(true);
      expect(["user", "model", "tool", "compact", "phase", "other"]).toContain(r.kind);
      expect(["ok", "error", "pending"]).toContain(r.status);
    }
    const turns = groupTrajTurns(rows);
    const s = summarizeTraj(rows, turns);
    expect(s.rows).toBe(rows.length);
    expect(s.cacheHitRate).toBeGreaterThanOrEqual(0);
    expect(s.cacheHitRate).toBeLessThanOrEqual(1);
    expect(Number.isFinite(s.wallMs)).toBe(true);
    expect(turns.length).toBeGreaterThan(0);
  });

  it("样本缺失判定口径:目录/事件皆可缺,不因样本缺席而红", () => {
    expect(sample === null || sample.events.length >= 0).toBe(true);
  });
});

describe("⑫ 公共前缀切分(step-1026:已命中前缀只给一行)", () => {
  const SYS = { role: "system", content: "sys prompt" };
  const U1 = { role: "user", content: "第一问" };
  const A1 = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] };
  const T1 = { role: "tool", toolCallId: "c1", content: "file body" };

  it("首调:prev 缺失/空数组 → 0,全部消息进未命中段", () => {
    expect(commonPrefixLen(undefined, [SYS, U1])).toBe(0);
    expect(commonPrefixLen([], [SYS, U1])).toBe(0);
    const sp = splitCachedInput([], [SYS, U1]);
    expect(sp.hitCount).toBe(0);
    expect(sp.miss.length).toBe(2);
    expect(sp.total).toBe(2);
  });

  it("全同:整段命中,未命中为空", () => {
    expect(commonPrefixLen([SYS, U1, A1, T1], [SYS, U1, A1, T1])).toBe(4);
    expect(splitCachedInput([SYS, U1, A1, T1], [SYS, U1, A1, T1]).miss.length).toBe(0);
  });

  it("尾部新增:命中旧段,只有新消息进未命中", () => {
    const cur = [SYS, U1, A1, T1, { role: "user", content: "继续" }];
    expect(commonPrefixLen([SYS, U1, A1, T1], cur)).toBe(4);
    const sp = splitCachedInput([SYS, U1, A1, T1], cur);
    expect(sp.miss.length).toBe(1);
    expect((sp.miss[0] as { content: string }).content).toBe("继续");
    expect(sp.hitTokens).toBeGreaterThan(0);
  });

  it("中途分叉:公共前缀必须连续(第 3 条不同即停)", () => {
    const cur = [SYS, U1, { role: "assistant", content: "换了回答" }, T1];
    expect(commonPrefixLen([SYS, U1, A1, T1], cur)).toBe(2);
  });

  it("工具结果新增:toolCallId 参与逐字比较(同 role 不同 id 不算命中)", () => {
    const other = { role: "tool", toolCallId: "c2", content: "file body" };
    expect(commonPrefixLen([SYS, U1, A1, T1], [SYS, U1, A1, other])).toBe(3);
    // toolCalls 也参与:同一 id 名字变了也算分叉
    const a2 = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "grep", arguments: "{}" }] };
    expect(commonPrefixLen([SYS, U1, A1], [SYS, U1, a2])).toBe(2);
  });

  it("空 content:空串与非空串不算同一条;approxTokens 对中文按字计", () => {
    expect(commonPrefixLen([{ role: "assistant", content: "" }], [{ role: "assistant", content: "x" }])).toBe(0);
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("中文四字")).toBe(4);
    expect(approxTokens("abcd")).toBe(1);
  });
});
