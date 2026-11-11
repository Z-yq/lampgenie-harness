/**
 *  压缩保留段组对齐 —— 纯逻辑单测 + 端到端探针。
 * 断言口径:tail 只能整组保留(assistant 与其 tool 回执是同一个交换的两半),
 * 切点永不落在组中间;探针 E 走 autoCompact 真路径,验证 compact.done 真的记下了
 * tailStartId / tailGroupCount / groupAligned。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import {
  alignTailGroups,
  messageStableId,
  validateTailGrouping,
  type GroupableMessage,
} from "../src/agent/compact-groups";
import { autoCompact } from "../src/agent/auto-compact";
import type { LlmProvider } from "../src/agent/loop";

const dirs: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "m46-groups-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const u = (text: string): GroupableMessage => ({ role: "user", content: text });
const s = (text: string): GroupableMessage => ({ role: "system", content: text });
const a = (text: string, ...ids: string[]): GroupableMessage => ({
  role: "assistant",
  content: text,
  ...(ids.length > 0 ? { toolCalls: ids.map((id) => ({ id, name: "read_file", arguments: "{}" })) } : {}),
});
const t = (id: string, content = "结果"): GroupableMessage => ({ role: "tool", toolCallId: id, content });

describe("messageStableId 稳定 id", () => {
  it("同输入同 id(确定性)", () => {
    const m = a("内容", "c1");
    expect(messageStableId(m, 3)).toBe(messageStableId(a("内容", "c1"), 3));
    expect(messageStableId(m, 3)).toMatch(/^m3:assistant:[0-9a-f]{8}$/);
  });

  it("index / role / content 任一变化 → id 变化", () => {
    const base = messageStableId(u("x"), 0);
    expect(messageStableId(u("x"), 1)).not.toBe(base);
    expect(messageStableId(a("x"), 0)).not.toBe(base);
    expect(messageStableId(u("y"), 0)).not.toBe(base);
  });

  it("toolCalls 参与摘要:同 content 不同 toolCalls → id 不同", () => {
    expect(messageStableId(a("", "c1"), 0)).not.toBe(messageStableId(a("", "c2"), 0));
    expect(messageStableId(a("", "c1", "c2"), 0)).not.toBe(messageStableId(a("", "c1"), 0));
  });

  it("空/缺字段消息不 throw,role 记 unknown", () => {
    expect(messageStableId(undefined, 0)).toMatch(/^m0:unknown:[0-9a-f]{8}$/);
    expect(messageStableId({}, 1)).toMatch(/^m1:unknown:[0-9a-f]{8}$/);
 // content 是对象也不炸(安全字符串化)
    expect(() => messageStableId({ role: "user", content: { k: 1 } }, 2)).not.toThrow();
  });
});

describe("组定义", () => {
  it("assistant + 匹配 toolCallId 的 tool 回执成一组:keep=1 时整组 2 条一起保留", () => {
    const r = alignTailGroups([u("任务"), a("调工具", "c1"), t("c1")], 1);
    expect(r.tail).toHaveLength(2);
    expect(r.tail[0]!.role).toBe("assistant");
    expect(r.groupCount).toBe(1);
    expect(r.tailStartIndex).toBe(1);
  });

  it("toolCallId 不匹配的 tool 不被吞进 assistant 组(成 orphan,向前并组)", () => {
    const r = alignTailGroups([a("调工具", "c1"), t("c2")], 1);
    expect(r.warnings).toContain("orphan-tool");
    expect(r.tail[0]!.role).toBe("assistant");
    expect(r.tail).toHaveLength(2);
  });

  it("一条 assistant 的多条 tool 回执全部并入同一组", () => {
    const r = alignTailGroups([u("任务"), a("并行调", "c1", "c2"), t("c1"), t("c2"), a("收尾")], 2);
 // 最后两组 = [assistant 并行调 + 两回执] + [assistant 收尾] → 4 条
    expect(r.tail).toHaveLength(4);
    expect(r.groupCount).toBe(2);
    expect(r.tail[0]!.role).toBe("assistant");
  });

  it("user / system 各自成组", () => {
    const r = alignTailGroups([s("sys"), u("u1"), u("u2")], 2);
    expect(r.tail).toHaveLength(2);
    expect(r.groupCount).toBe(2);
    expect(r.tailStartIndex).toBe(1);
  });

  it("无 toolCalls 的 assistant 不吞并紧随其后的 tool(该 tool 成 orphan 组)", () => {
    const r = alignTailGroups([a("空 assistant"), t("c1")], 1);
    expect(r.warnings).toContain("orphan-tool");
    expect(r.tail[0]!.role).toBe("assistant");
    expect(r.groupCount).toBe(2);
  });
});

describe("切点扩展(探针 A)", () => {
  it("A:assistant(tool_use)+tool_result 同组,keep=2 原本会切在 tool → 扩到 assistant 起点", () => {
    const messages = [u("任务"), a("调工具", "c1"), t("c1"), a("收尾")];
 // 旧实现 slice(-2) = [tool, 收尾] → tail 首条是孤立 tool(非法形态)
    const legacy = messages.slice(-2);
    expect(legacy[0]!.role).toBe("tool");
    const r = alignTailGroups(messages, 2);
    expect(r.tail[0]!.role).toBe("assistant");
    expect(r.tailStartIndex).toBe(1);
    expect(r.tail).toHaveLength(3);
    expect(r.groupCount).toBe(2);
  });

  it("keep 小于组大小:整组保留,tail 条数可以多于 keep", () => {
    const r = alignTailGroups([u("任务"), a("调", "c1", "c2"), t("c1"), t("c2")], 1);
    expect(r.tail).toHaveLength(3);
    expect(r.groupCount).toBe(1);
    expect(r.tail.length).toBeGreaterThan(1);
  });

  it("B:连续 3 组 keep=2 → 返回完整的最后一组;keep=4 → 两组", () => {
    const messages = [
      u("任务"),
      a("组1", "c1"), t("c1"),
      a("组2", "c2"), t("c2"),
      a("组3", "c3"), t("c3"),
    ];
    const r = alignTailGroups(messages, 2);
    expect(r.groupCount).toBe(1);
    expect(r.tail).toHaveLength(2);
    expect(r.tail.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(r.tailStartIndex).toBe(5);
 // keep=4 时正好吃满两组,每组仍完整(不从组中间切)
    const r2 = alignTailGroups(messages, 4);
    expect(r2.groupCount).toBe(2);
    expect(r2.tail).toHaveLength(4);
    expect(r2.tail.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
    expect(r2.tailStartIndex).toBe(3);
  });

  it("keep 大于消息数 → 全量 tail,起点 0,groupCount=全部组数", () => {
    const messages = [u("任务"), a("组1", "c1"), t("c1")];
    const r = alignTailGroups(messages, 99);
    expect(r.tailStartIndex).toBe(0);
    expect(r.tail).toHaveLength(3);
    expect(r.groupCount).toBe(2);
  });

  it("keep=0 → tail 空、tailStartId=null、groupCount=0", () => {
    const r = alignTailGroups([u("a"), a("b")], 0);
    expect(r.tail).toEqual([]);
    expect(r.tailStartId).toBeNull();
    expect(r.groupCount).toBe(0);
    expect(r.tailStartIndex).toBe(2);
  });

  it("keep 非有限值(undefined/NaN)→ 空 tail,不 throw", () => {
    for (const keep of [Number.NaN, undefined as unknown as number, Number.POSITIVE_INFINITY]) {
      const r = alignTailGroups([u("a"), a("b")], keep);
      expect(r.tail).toEqual([]);
      expect(r.tailStartId).toBeNull();
    }
  });

  it("tailStartIndex + tail.length === 原数组长度(切点自洽)", () => {
    const messages = [u("任务"), a("组1", "c1"), t("c1"), a("组2")];
    const r = alignTailGroups(messages, 2);
    expect(r.tailStartIndex + r.tail.length).toBe(messages.length);
  });

  it("tailStartId = messageStableId(tail[0], tailStartIndex)", () => {
    const messages = [u("任务"), a("组1", "c1"), t("c1"), a("组2")];
    const r = alignTailGroups(messages, 2);
    expect(r.tailStartId).toBe(messageStableId(messages[r.tailStartIndex], r.tailStartIndex));
  });
});

describe("orphan 与结构异常(探针 C/D)", () => {
  it("C:孤立 tool(前有 user 无 assistant)→ 向前并入一组,warnings 含 orphan-tool", () => {
    const r = alignTailGroups([u("任务"), t("c-orphan")], 1);
    expect(r.tail[0]!.role).toBe("user");
    expect(r.warnings).toContain("orphan-tool");
    expect(r.tail).toHaveLength(2);
  });

  it("孤立 tool 在数组头(无处可并)→ 保留并告警,validate 判非法", () => {
    const r = alignTailGroups([t("c-orphan"), a("收尾")], 2);
    expect(r.tail[0]!.role).toBe("tool");
    expect(r.warnings).toContain("orphan-tool");
    expect(validateTailGrouping(r.tail).ok).toBe(false);
    expect(validateTailGrouping(r.tail).issues).toContain("first-message-is-tool");
  });

  it("结构异常消息(缺 role)在 tail → warning=group-corrupt 且再向前扩一组", () => {
    const messages: GroupableMessage[] = [u("任务"), s("提醒"), { content: "无 role" }, a("收尾")];
    const r = alignTailGroups(messages, 2);
    expect(r.warnings).toContain("group-corrupt");
 // keep=2 本来取 [corrupt, assistant];保守再向前扩一组 → 3 条,首条是 system
    expect(r.tail).toHaveLength(3);
    expect(r.tail[0]!.role).toBe("system");
    expect(r.groupCount).toBe(3);
  });

  it("结构异常消息落在 head 段(不在 tail)→ 不告警", () => {
    const messages: GroupableMessage[] = [{ content: "无 role" }, u("任务"), a("收尾")];
    const r = alignTailGroups(messages, 1);
    expect(r.warnings).toEqual([]);
    expect(r.tail).toHaveLength(1);
  });

  it("D:空数组 → tail 空、tailStartId=null、groupCount=0、warnings 空", () => {
    const r = alignTailGroups([], 5);
    expect(r).toEqual({ tailStartIndex: 0, tail: [], groupCount: 0, tailStartId: null, warnings: [] });
  });

  it("messages 非数组(undefined)→ 空结果,不 throw", () => {
    const r = alignTailGroups(undefined as unknown as GroupableMessage[], 3);
    expect(r.tail).toEqual([]);
    expect(r.tailStartId).toBeNull();
  });
});

describe("不可变与健壮", () => {
  it("不修改入参数组与元素(深比较前后一致),返回新数组", () => {
    const messages = [u("任务"), a("调", "c1"), t("c1")];
    const snapshot = structuredClone(messages);
    const r = alignTailGroups(messages, 1);
    expect(messages).toEqual(snapshot);
    expect(r.tail).not.toBe(messages);
    expect(r.tail[0]).toBe(messages[1]); // 元素引用不变(浅拷贝)
  });

  it("传入 frozen 数组与 frozen 消息对象不 throw", () => {
    const messages = Object.freeze([Object.freeze(u("任务")), Object.freeze(a("调", "c1")), Object.freeze(t("c1"))]);
    expect(() => alignTailGroups(messages, 2)).not.toThrow();
    expect(alignTailGroups(messages, 2).tail).toHaveLength(2);
  });
});

describe("validateTailGrouping 边界自检", () => {
  it("空 tail 合法", () => {
    expect(validateTailGrouping([])).toEqual({ ok: true, issues: [] });
  });

  it("首条是 tool → first-message-is-tool,ok=false", () => {
    const v = validateTailGrouping([t("c1"), a("收尾")]);
    expect(v.ok).toBe(false);
    expect(v.issues).toContain("first-message-is-tool");
  });

  it("完整 assistant 组 → ok", () => {
    expect(validateTailGrouping([a("调", "c1"), t("c1")])).toEqual({ ok: true, issues: [] });
  });

  it("assistant 的 tool 回执被切在 tail 外 → assistant-tool-split", () => {
    const v = validateTailGrouping([a("调", "c1"), a("收尾")]);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.startsWith("assistant-tool-split@0:c1"))).toBe(true);
  });

  it("tool 缺 toolCallId → tool-without-toolCallId", () => {
    const v = validateTailGrouping([a("调", "c1"), { role: "tool", content: "x" }]);
    expect(v.ok).toBe(false);
    expect(v.issues).toContain("tool-without-toolCallId@1");
  });

  it("issues 确定性排序(同输入两次相等)", () => {
    const tail = [t("c1"), { role: "tool", content: "x" }];
    expect(validateTailGrouping(tail)).toEqual(validateTailGrouping(tail));
  });
});

describe("探针 E:autoCompact 真路径写组对齐 payload", () => {
  const fakeLlm: LlmProvider = { async chat() { return { content: "摘要:组对齐探针" }; } };

  it("E:compact.done 含 tailStartId/tailGroupCount/groupAligned,tail 首条非 tool", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "任务:压缩组对齐" } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "长历史" + "冗".repeat(3000) } });
    j.append({
      kind: "message.agent", sessionId: "s",
      payload: { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
    });
    j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c1", content: "工具结果" } });

    const r = await autoCompact(j, "s", {
      thresholdTokens: 1, keepRecentMessages: 2, compactLlm: fakeLlm, devlogDir: tmpDir(), force: true,
    });
    expect(r.compacted).toBe(true);

    const done = j.readAll().find((e) => e.kind === "compact.done")!;
    const p = done.payload as {
      tail?: { role: string }[];
      tailStartId?: string | null;
      tailGroupCount?: number;
      groupAligned?: boolean;
      headCount?: number;
      tailKept?: number;
    };
    expect(p.groupAligned).toBe(true);
    expect(p.tailGroupCount).toBe(1);
    expect(p.tail?.[0]?.role).toBe("assistant"); // tail 不是从 tool 起切
    expect(p.tail?.[0]?.role).not.toBe("tool");
    expect(p.tailStartId).toMatch(/^m2:assistant:[0-9a-f]{8}$/);
 // tailStartId 必须与 tail 首条同源(投影/冷恢复按它复用边界)
    expect(p.tailStartId).toBe(messageStableId(p.tail![0]!, 2));
    expect(p.headCount).toBe(2);
    expect(p.tailKept).toBe(2);
  });

  it("E2:compact.start 无告警时不写 tailWarnings(旧读方零影响)", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s2", payload: { text: "任务" } });
    for (let i = 0; i < 6; i += 1) {
      j.append({ kind: "message.agent", sessionId: "s2", payload: { text: `步${i}` + "冗".repeat(800) } });
    }
    await autoCompact(j, "s2", { thresholdTokens: 1, keepRecentMessages: 2, compactLlm: fakeLlm, devlogDir: tmpDir(), force: true });
    const start = j.readAll().find((e) => e.kind === "compact.start")!;
    expect((start.payload as { tailWarnings?: unknown }).tailWarnings).toBeUndefined();
  });
});
