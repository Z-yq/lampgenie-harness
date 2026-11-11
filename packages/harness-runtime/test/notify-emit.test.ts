import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_KINDS,
  buildNotification,
  renderForChannel,
  summarizeNotification,
  type BuildResult,
  type Notification,
} from "../src/notify/emit.ts";

/** 断言成功并取出 notification(失败时打印 reason,便于定位)。 */
function must(result: BuildResult): Notification {
  if (!result.ok) throw new Error(`期望 OK,实际 ${result.code}:${result.reason}`);
  return result.notification;
}

describe("NOTIFICATION_KINDS 封闭注册表", () => {
  it("注册表恰好是 8 个 kind", () => {
    expect([...NOTIFICATION_KINDS]).toEqual([
      "task.done",
      "task.failed",
      "task.blocked",
      "subagent.final",
      "ask.pending",
      "security.alert",
      "team.activity",
      "custom",
    ]);
  });

  it("未知 kind 返回 UNKNOWN_KIND 且不产出 notification(fail-closed)", () => {
    const r = buildNotification("task.exploded", { taskId: "t1" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("UNKNOWN_KIND");
    expect("notification" in r).toBe(false);
  });

  it("kind 非字符串也不 throw,按 UNKNOWN_KIND 拒绝", () => {
    expect(buildNotification(123 as unknown as string, {})).toMatchObject({ ok: false, code: "UNKNOWN_KIND" });
    expect(buildNotification(undefined as unknown as string)).toMatchObject({ ok: false, code: "UNKNOWN_KIND" });
  });

  it("opts.kinds 只能收窄:被收窄排除的已登记 kind 也判未知", () => {
    const r = buildNotification("task.done", { taskId: "t1", sessionId: "s1", status: "done" }, { kinds: ["custom"] });
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_KIND" });
    expect(buildNotification("custom", { label: "x" }, { kinds: ["custom"] }).ok).toBe(true);
  });
});

describe("task.done / task.failed / task.blocked 必填校验", () => {
  it("task.done 完整 → OK,payload 保留结构化原值", () => {
    const n = must(buildNotification("task.done", { taskId: "t-1", sessionId: "s-1", status: "done", extra: 7 }));
    expect(n.kind).toBe("task.done");
    expect(n.payload).toEqual({ taskId: "t-1", sessionId: "s-1", status: "done", extra: 7 });
  });

  it("task.done 缺 taskId → INVALID(探针 B)", () => {
    const r = buildNotification("task.done", { sessionId: "s-1", status: "done" });
    expect(r).toMatchObject({ ok: false, code: "INVALID" });
    expect(r.ok ? "" : r.reason).toContain("taskId");
  });

  it("task.done 字段类型不是 string → INVALID", () => {
    expect(buildNotification("task.done", { taskId: 1, sessionId: "s", status: "done" })).toMatchObject({
      ok: false,
      code: "INVALID",
    });
  });

  it("task.done text 是稳定人读句(含 taskId/sessionId/status)", () => {
    const n = must(buildNotification("task.done", { taskId: "t-9", sessionId: "s-9", status: "done" }));
    expect(n.text).toBe("任务 t-9 已完成(done;会话 s-9)");
 // 稳定 = 同样输入再构造逐字相同
    expect(must(buildNotification("task.done", { taskId: "t-9", sessionId: "s-9", status: "done" })).text).toBe(n.text);
  });

  it("task.done gui 从结构化字段派生,不来自 text", () => {
    const n = must(buildNotification("task.done", { taskId: "t-9", sessionId: "s-9", status: "done" }));
    expect(n.gui).toEqual({ title: "任务完成", body: "t-9 · done", severity: "info" });
 // gui.body 是「id · status」形式,text 里没有这个分隔形式 → 证明不是从 text 反解析
    expect(n.text).not.toContain(" · ");
  });

  it("task.failed → severity=error 且 error 字段进文本", () => {
    const n = must(buildNotification("task.failed", { taskId: "t-2", sessionId: "s-2", status: "failed", error: "boom" }));
    expect(n.gui.severity).toBe("error");
    expect(n.text).toContain("boom");
    expect(n.gui.body).toBe("t-2 · boom");
  });

  it("task.blocked 缺 reason → INVALID;有 reason → OK 且 severity=warn", () => {
    expect(buildNotification("task.blocked", { taskId: "t-3", sessionId: "s-3" })).toMatchObject({
      ok: false,
      code: "INVALID",
    });
    const n = must(buildNotification("task.blocked", { taskId: "t-3", sessionId: "s-3", reason: "等审批" }));
    expect(n.gui.severity).toBe("warn");
    expect(n.text).toContain("等审批");
  });
});

describe("subagent / ask / security / team / custom", () => {
  it("subagent.final 失败态 → severity=error,完成态 → info", () => {
    const bad = must(buildNotification("subagent.final", { agentId: "a1", status: "failed", summary: "超时" }));
    expect(bad.gui.severity).toBe("error");
    const good = must(buildNotification("subagent.final", { agentId: "a1", status: "done", summary: "完成" }));
    expect(good.gui.severity).toBe("info");
    expect(good.text).toBe("子代理 a1 done:完成");
  });

  it("subagent.final 缺 summary → INVALID", () => {
    expect(buildNotification("subagent.final", { agentId: "a1", status: "done" })).toMatchObject({
      ok: false,
      code: "INVALID",
    });
  });

  it("ask.pending → severity=warn 且问题进 gui.body", () => {
    const n = must(buildNotification("ask.pending", { askId: "q-1", question: "继续吗?" }));
    expect(n.gui).toEqual({ title: "需要你确认", body: "继续吗?", severity: "warn" });
    expect(n.text).toBe("待确认(q-1):继续吗?");
  });

  it("ask.pending 缺 askId → INVALID", () => {
    expect(buildNotification("ask.pending", { question: "x" })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("security.alert 缺省 severity=error;显式合法 severity 优先", () => {
    expect(must(buildNotification("security.alert", { message: "私钥泄露" })).gui.severity).toBe("error");
    expect(must(buildNotification("security.alert", { message: "可疑登录", severity: "warn" })).gui.severity).toBe("warn");
 // 非法 severity 回落缺省(不抛错)
    expect(must(buildNotification("security.alert", { message: "x", severity: "urgent" })).gui.severity).toBe("error");
  });

  it("security.alert 缺 message → INVALID", () => {
    expect(buildNotification("security.alert", { severity: "warn" })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("team.activity 必填 projectId/category/type:缺 type → INVALID", () => {
    expect(buildNotification("team.activity", { projectId: "p", category: "task" })).toMatchObject({
      ok: false,
      code: "INVALID",
    });
  });

  it("team.activity 空 projectId 是合法数据事实(网关任务活动没有项目归属)", () => {
    const n = must(buildNotification("team.activity", { projectId: "", category: "task", type: "running", summary: "开始:x" }));
    expect(n.payload.projectId).toBe("");
    expect(n.text).toBe("团队活动:task/running — 开始:x");
  });

  it("team.activity 高风险 type → severity=warn,普通 type → info", () => {
    expect(must(buildNotification("team.activity", { projectId: "p", category: "task", type: "failed" })).gui.severity).toBe("warn");
    expect(must(buildNotification("team.activity", { projectId: "p", category: "task", type: "submitted" })).gui.severity).toBe("info");
  });

  it("team.activity gui.body 直接用 summary 原值(不从 text 反解析)", () => {
    const n = must(buildNotification("team.activity", { projectId: "p1", category: "task", type: "done", summary: "完成:接口联调" }));
    expect(n.gui).toEqual({ title: "团队活动 · done", body: "完成:接口联调", severity: "info" });
  });

  it("custom 带 label → OK(探针 E),detail 进 text 与 gui.body", () => {
    const n = must(buildNotification("custom", { label: "部署完成", detail: "v1.2.3", at: 123 }));
    expect(n.kind).toBe("custom");
    expect(n.text).toBe("部署完成:v1.2.3");
    expect(n.gui).toEqual({ title: "部署完成", body: "v1.2.3", severity: "info" });
    expect(n.payload).toEqual({ label: "部署完成", detail: "v1.2.3", at: 123 });
  });

  it("custom 缺 label / label 为空串 / label 非 string → INVALID", () => {
    expect(buildNotification("custom", { detail: "x" })).toMatchObject({ ok: false, code: "INVALID" });
    expect(buildNotification("custom", { label: "   " })).toMatchObject({ ok: false, code: "INVALID" });
    expect(buildNotification("custom", { label: 42 })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("data 不是普通对象(null/数组/字符串)→ INVALID", () => {
    for (const bad of [undefined, null, [], "x", 1]) {
      expect(buildNotification("custom", bad)).toMatchObject({ ok: false, code: "INVALID" });
    }
  });
});

describe("不可变 / 确定性 / 纯数据", () => {
  it("返回的 notification 与 payload/gui 深冻结", () => {
    const n = must(buildNotification("custom", { label: "L", nested: { a: [1, 2] } }));
    expect(Object.isFrozen(n)).toBe(true);
    expect(Object.isFrozen(n.payload)).toBe(true);
    expect(Object.isFrozen(n.payload.nested)).toBe(true);
    expect(Object.isFrozen((n.payload.nested as { a: number[] }).a)).toBe(true);
    expect(Object.isFrozen(n.gui)).toBe(true);
  });

  it("构造后改动入参不影响已产出通知(深拷贝)", () => {
    const data = { label: "L", nested: { a: 1 } };
    const n = must(buildNotification("custom", data));
    data.nested.a = 2;
    data.label = "changed";
    expect(n.payload.label).toBe("L");
    expect((n.payload.nested as { a: number }).a).toBe(1);
  });

  it("payload 不含 text 键(文本只走 text 字段,避免双源)", () => {
    const n = must(buildNotification("team.activity", { projectId: "p", category: "task", type: "done", summary: "s" }));
    expect(Object.keys(n.payload).includes("text")).toBe(false);
    expect("text" in n.payload).toBe(false);
  });

  it("确定性:同输入两次构造结果深等", () => {
    const a = must(buildNotification("task.failed", { taskId: "t", sessionId: "s", status: "failed", error: "e" }));
    const b = must(buildNotification("task.failed", { taskId: "t", sessionId: "s", status: "failed", error: "e" }));
    expect(a).toEqual(b);
    expect(renderForChannel(a, "webhook")).toEqual(renderForChannel(b, "webhook"));
  });

  it("payload 是纯数据:JSON 往返后与原 payload 深等(可落 journal)", () => {
    const n = must(buildNotification("team.activity", { projectId: "p", category: "task", type: "done", summary: "s", n: 1 }));
    expect(JSON.parse(JSON.stringify(n.payload))).toEqual({ ...n.payload });
  });

  it("超长字段使 text 被截断到 500 字内(带省略号)", () => {
    const n = must(buildNotification("task.done", { taskId: "t".repeat(600), sessionId: "s", status: "done" }));
    expect(n.text.length).toBe(500);
    expect(n.text.endsWith("…")).toBe(true);
    expect(n.payload.taskId).toBe("t".repeat(600)); // 原值不被截断
  });

  it("入参含不可克隆的奇怪值时也不 throw(纯函数兜底)", () => {
    const weird = { label: "L", fn: () => 1 };
    const r = buildNotification("custom", weird);
    expect(r.ok).toBe(true);
    expect(() => summarizeNotification(must(r))).not.toThrow();
  });
});

describe("renderForChannel / summarizeNotification", () => {
  const n = must(buildNotification("team.activity", { projectId: "p1", category: "task", type: "done", summary: "完成:x" }));

  it("text 通道 → 人读文本(探针 D)", () => {
    expect(renderForChannel(n, "text")).toBe(n.text);
  });

  it("gui 通道 → 卡片投影(探针 D)", () => {
    expect(renderForChannel(n, "gui")).toEqual({ title: "团队活动 · done", body: "完成:x", severity: "info" });
  });

  it("webhook 通道 → {kind, ...payload, text}(探针 D)", () => {
    expect(renderForChannel(n, "webhook")).toEqual({
      kind: "team.activity",
      projectId: "p1",
      category: "task",
      type: "done",
      summary: "完成:x",
      text: n.text,
    });
  });

  it("webhook 投影冻结且与 payload 隔离(改返回对象不影响 notification)", () => {
    const w = renderForChannel(n, "webhook") as Record<string, unknown>;
    expect(Object.isFrozen(w)).toBe(true);
    expect(() => { w.projectId = "hacked"; }).toThrow();
    expect(n.payload.projectId).toBe("p1");
  });

  it("未知渠道退回人读文本,不抛错", () => {
    expect(renderForChannel(n, "sms" as unknown as "text")).toBe(n.text);
  });

  it("摘要单行、含 kind 与文本、≤200 字", () => {
    const s = summarizeNotification(n);
    expect(s).toBe(`[team.activity] ${n.text}`);
    expect(s).not.toContain("\n");
    expect(s.length).toBeLessThanOrEqual(200);
  });

  it("摘要超 200 字被截断且总长恰好 200(含省略号)", () => {
    const long = must(buildNotification("custom", { label: "L".repeat(400) }));
    const s = summarizeNotification(long);
    expect(s.length).toBe(200);
    expect(s.endsWith("…")).toBe(true);
  });

  it("摘要把文本里的换行压成单行", () => {
    const multi = must(buildNotification("custom", { label: "第一行\n第二行" }));
    expect(summarizeNotification(multi)).toBe("[custom] 第一行 第二行");
  });
});
