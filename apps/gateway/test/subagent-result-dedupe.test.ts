/**
 * 终态通知投递器回归(2026-10-30,task_output 免独立往返):deliverFinalNotice 的**去重**语义。
 *
 * 为什么要单测:主 result 路径(wiring 后台 result 回调)与 watchdog 死讯现在共用同一个 delivered
 * 集合——去重一旦失效,主 agent 会收到两条同一子代理的 message.system(重复正文=白烧 input)。
 * 本测试用假 journal(只收 append),行为级验证：
 *  ① 同 (sessionId, agentId) 投两次 → journal 只有 1 条 message.system;
 *  ② 不同 sessionId 的同名 agentId → 各 1 条;
 *  ③ 合并窗口(GENIE_SUBAGENT_INJECT_MERGE_MS=500 缺省):同会话同批条目合成 1 条;
 *  ④ 合并窗口=0 → 立即投递,不等定时器。
 * 合并窗口相关断言逐条显式打开/关闭定时器:窗口内条目由 setTimeout(500ms)flush,测试用等定时器
 * (ensureMergeFlushed)而不是靠 sleep 猜——缺省窗口必须在 1s 内收敛,否则视为投递器坏。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFinalNoticeText,
  deliverFinalNotice,
  resetSubagentDeliveryStateForTest,
  wasFinalNoticeDelivered,
  type FinalNoticeItem,
} from "../src/subagent-result-digest.js";

interface Appended {
  kind: string;
  sessionId: string;
  payload: { text?: string };
}

function fakeJournal() {
  const rows: Appended[] = [];
  return { rows, append: (e: unknown) => { rows.push(e as Appended); } };
}

function notices(rows: Appended[]): Appended[] {
  return rows.filter((r) => r.kind === "message.system");
}

/** 等合并窗口 flush:轮询到「消息数到达预期」或超时(缺省窗口 500ms,1.5s 上限足够)。 */
async function waitForNotices(rows: Appended[], n: number, timeoutMs = 1_500): Promise<void> {
  const t0 = Date.now();
  while (notices(rows).length < n && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

const savedEnv = process.env.GENIE_SUBAGENT_INJECT_MERGE_MS;

beforeEach(() => {
  resetSubagentDeliveryStateForTest();
  delete process.env.GENIE_SUBAGENT_INJECT_MERGE_MS; // 用缺省 500ms 窗口
});

afterEach(() => {
  resetSubagentDeliveryStateForTest();
  if (savedEnv === undefined) delete process.env.GENIE_SUBAGENT_INJECT_MERGE_MS;
  else process.env.GENIE_SUBAGENT_INJECT_MERGE_MS = savedEnv;
});

describe("deliverFinalNotice 去重", () => {
  it("同 sessionId + 同 agentId 投两次 → 只有 1 条 message.system(合并窗口内)", async () => {
    const j = fakeJournal();
    const item: FinalNoticeItem = { agentId: "agent_dup", label: "完成", summary: "第一次", outputText: "[result ok=true] 正文一" };
    expect(deliverFinalNotice(j, "sess-1", item)).toBe(true);
    expect(deliverFinalNotice(j, "sess-1", { ...item, label: "失败", summary: "第二次(watchdog 交叉)" })).toBe(false);
    await waitForNotices(j.rows, 1);
    await new Promise((r) => setTimeout(r, 100)); // 再等一小会确认没有第二条
    expect(notices(j.rows).length).toBe(1);
    expect(notices(j.rows)[0]!.sessionId).toBe("sess-1");
    expect(notices(j.rows)[0]!.payload.text).toContain("第一次");
    expect(notices(j.rows)[0]!.payload.text).not.toContain("第二次");
    expect(wasFinalNoticeDelivered("sess-1", "agent_dup")).toBe(true);
  });

  it("去重键含 sessionId:不同会话的同名 agentId 各投 1 条", async () => {
    const j = fakeJournal();
    expect(deliverFinalNotice(j, "sess-A", { agentId: "agent_x", label: "完成", summary: "A 的结果", pointerOnly: true })).toBe(true);
    expect(deliverFinalNotice(j, "sess-B", { agentId: "agent_x", label: "完成", summary: "B 的结果", pointerOnly: true })).toBe(true);
    await waitForNotices(j.rows, 2);
    const ns = notices(j.rows);
    expect(ns.length).toBe(2);
    expect(ns.map((n) => n.sessionId).sort()).toEqual(["sess-A", "sess-B"]);
  });

  it("合并窗口:同会话两条不同 agentId → 合成 1 条 message.system,正文都在", async () => {
    const j = fakeJournal();
    deliverFinalNotice(j, "sess-m", { agentId: "agent_1", label: "完成", summary: "任务一", outputText: "[result ok=true] 一号正文" });
    deliverFinalNotice(j, "sess-m", { agentId: "agent_2", label: "完成", summary: "任务二", outputText: "[result ok=true] 二号正文" });
    await waitForNotices(j.rows, 1);
    await new Promise((r) => setTimeout(r, 100));
    const ns = notices(j.rows);
    expect(ns.length).toBe(1); // 500ms 窗口内合并成一条(不是两条)
    expect(ns[0]!.payload.text).toContain("一号正文");
    expect(ns[0]!.payload.text).toContain("二号正文");
  });

  it("GENIE_SUBAGENT_INJECT_MERGE_MS=0 → 关闭合并窗口,每条立即投递(无需等定时器)", () => {
    process.env.GENIE_SUBAGENT_INJECT_MERGE_MS = "0";
    const j = fakeJournal();
    deliverFinalNotice(j, "sess-z", { agentId: "agent_z1", label: "完成", summary: "一", pointerOnly: true });
    deliverFinalNotice(j, "sess-z", { agentId: "agent_z2", label: "完成", summary: "二", pointerOnly: true });
    const ns = notices(j.rows); // 同步就能看到(无定时器)
    expect(ns.length).toBe(2);
  });
});

describe("buildFinalNoticeText 与投递器口径一致", () => {
  it("投递出去的文本 == 纯函数拼装的文本(不额外加工)", async () => {
    const j = fakeJournal();
    process.env.GENIE_SUBAGENT_INJECT_MERGE_MS = "0";
    const item: FinalNoticeItem = { agentId: "agent_eq", label: "完成", summary: "同一份", outputText: "[result ok=true] 等价正文" };
    deliverFinalNotice(j, "sess-eq", item);
    expect(notices(j.rows)[0]!.payload.text).toBe(buildFinalNoticeText([item]));
  });
});
