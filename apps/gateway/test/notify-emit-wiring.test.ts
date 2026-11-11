/**
 *  接入测试:relay.activity 双写结构化 + app.ts 入队点接 buildNotification。
 * 口径:
 * - handler 层:有 notifyStructured 先调它、旧 notifyActivity 仍然调用(旧消费端零改动);
 * 只有旧方法时不得抛错;无 sink 时零调用(旧行为)。
 * - app 层:入队 payload 必须同时保留旧四字段与 structured/gui,summary 仍是旧文本;
 * 静态比对 app.ts 源码,防止接线被回退。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNotification } from "@lampgenie/runtime/notify/emit";
import { createEffectQueue, relayActivityHandler, type EffectHandlerCtx, type TeamActivityPayload } from "../src/effect-queue.js";

class FakeJournal {
  events: any[] = [];
  append(ev: any): any {
    const full = { ...ev, seq: this.events.length, time: 0 };
    this.events.push(full);
    return full;
  }
  readAll(): any[] {
    return [...this.events];
  }
  async flushStrict(): Promise<void> {}
}

const ctx: EffectHandlerCtx = { id: "ef-1", attempt: 1, later: () => {} };

function ticks(n = 3): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, n));
}

/** 网关 app.ts 里 relay.activity 入队 payload 的等价构造(与 app.ts:331-350 同源逻辑)。 */
function appEnqueuePayload(state: "running" | "done" | "failed", instruction: string) {
  const legacySummary = `${state === "running" ? "开始" : state === "done" ? "完成" : "失败"}:${instruction}`;
  const note = buildNotification("team.activity", { projectId: "", category: "task", type: state, summary: legacySummary });
  return {
    projectId: "",
    category: "task",
    type: state,
    summary: legacySummary,
    ...(note.ok ? { structured: note.notification.payload, gui: note.notification.gui } : {}),
    note,
  };
}

describe("relayActivityHandler 结构化双写", () => {
  it("sink 同时实现两法 → notifyStructured 先调、notifyActivity 仍调(旧字段逐字)", () => {
    const order: string[] = [];
    const structured: TeamActivityPayload[] = [];
    const legacy: unknown[][] = [];
    const sink = {
      notifyStructured: (a: TeamActivityPayload) => { order.push("structured"); structured.push(a); },
      notifyActivity: (...args: unknown[]) => { order.push("legacy"); legacy.push(args); },
    };
    const payload = {
      projectId: "p1",
      category: "task",
      type: "done",
      summary: "完成:x",
      structured: { projectId: "p1", category: "task", type: "done", summary: "完成:x" },
      gui: { title: "团队活动 · done", body: "完成:x", severity: "info" as const },
    };
    relayActivityHandler(() => sink)(payload, ctx);

    expect(order).toEqual(["structured", "legacy"]);
    expect(structured).toHaveLength(1);
    expect(structured[0]).toMatchObject({
      projectId: "p1", category: "task", type: "done", summary: "完成:x",
      structured: { type: "done" }, gui: { title: "团队活动 · done", severity: "info" },
    });
    expect(legacy).toEqual([["p1", "task", "done", "完成:x"]]);
  });

  it("旧 sink 只实现 notifyActivity → 不抛错,仍收到四参数(team-view 兼容)", () => {
    const legacy: unknown[][] = [];
    const sink = { notifyActivity: (...args: unknown[]) => { legacy.push(args); } };
    expect(() => relayActivityHandler(() => sink)(appEnqueuePayload("done", "接口联调"), ctx)).not.toThrow();
    expect(legacy).toEqual([["", "task", "done", "完成:接口联调"]]);
  });

  it("旧 payload(无 structured/gui)→ notifyStructured 收到的活动不含这两个键", () => {
    const structured: TeamActivityPayload[] = [];
    const sink = {
      notifyStructured: (a: TeamActivityPayload) => { structured.push(a); },
      notifyActivity: () => {},
    };
    relayActivityHandler(() => sink)({ projectId: "", category: "task", type: "running", summary: "开始:x" }, ctx);
    expect("structured" in structured[0]).toBe(false);
    expect("gui" in structured[0]).toBe(false);
  });

  it("无 sink(team 关闭)→ 两法都不调、也不抛错(旧行为)", () => {
    let calls = 0;
    const sink = { notifyStructured: () => { calls += 1; }, notifyActivity: () => { calls += 1; } };
    relayActivityHandler(() => undefined)(appEnqueuePayload("done", "x"), ctx);
    expect(calls).toBe(0);
 // 旁证:sink 存在时同样的 payload 会调两次(排除「handler 本身没跑」)
    relayActivityHandler(() => sink)(appEnqueuePayload("done", "x"), ctx);
    expect(calls).toBe(2);
  });

  it("脏 payload:structured/gui 非对象不透传,旧四字段照旧兜底", () => {
    const structured: TeamActivityPayload[] = [];
    const legacy: unknown[][] = [];
    const sink = {
      notifyStructured: (a: TeamActivityPayload) => { structured.push(a); },
      notifyActivity: (...args: unknown[]) => { legacy.push(args); },
    };
    relayActivityHandler(() => sink)({ projectId: 7, category: null, type: undefined, summary: 42, structured: "nope", gui: 1 }, ctx);
    expect(structured[0]).toEqual({ projectId: "", category: "task", type: "", summary: "42" });
    expect(legacy).toEqual([["", "task", "", "42"]]);
  });

  it("经持久效果队列执行时双写仍成立(先落账后执行)", async () => {
    const journal = new FakeJournal();
    const queue = createEffectQueue({ journal, sleep: async () => {} });
    const seen: string[] = [];
    const sink = {
      notifyStructured: () => { seen.push("structured"); },
      notifyActivity: () => { seen.push("legacy"); },
    };
    queue.register("relay.activity", relayActivityHandler(() => sink));
    queue.start();
    await queue.enqueue({ kind: "relay.activity", key: "t-1", payload: appEnqueuePayload("done", "x") });
    await ticks();
    expect(seen).toEqual(["structured", "legacy"]);
    expect(journal.events.filter((e) => e.kind === "effect.done")).toHaveLength(1);
  });
});

describe("app.ts 入队点接线(静态 + 等价构造)", () => {
  const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

  it("静态:入队点用 buildNotification(\"team.activity\") 生成结构化面(探针 F)", () => {
    expect(appSource).toContain('buildNotification("team.activity"');
    expect(appSource).toContain("structured: note.notification.payload");
    expect(appSource).toContain("gui: note.notification.gui");
    expect(appSource).toContain("...(note.ok ?");
  });

  it("静态:旧四字段与旧 summary 表达式仍在(兼容不回退)", () => {
    expect(appSource).toContain("summary: legacySummary");
    expect(appSource).toContain('projectId: ""');
    expect(appSource).toContain('category: "task"');
    expect(appSource).toContain("type: task.state");
    expect(appSource).toContain('"开始" : task.state === "done" ? "完成" : "失败"');
  });

  it("等价构造:payload 保留旧四字段 + 新增 structured/gui,同源一致", () => {
    const { note, ...payload } = appEnqueuePayload("done", "接口联调");
    expect(payload.projectId).toBe("");
    expect(payload.category).toBe("task");
    expect(payload.type).toBe("done");
    expect(payload.summary).toBe("完成:接口联调");
    if (!note.ok) throw new Error("note 应为 OK");
    expect(payload.structured).toEqual({ projectId: "", category: "task", type: "done", summary: "完成:接口联调" });
    expect(payload.gui).toEqual({ title: "团队活动 · done", body: "完成:接口联调", severity: "info" });
 // text 与 summary 同源:旧文本出现在人读句里
    expect(note.notification.text).toContain(payload.summary);
  });

  it("等价构造:payload 是纯数据(落 journal 可 JSON 往返)且不含 text 双源", () => {
    const { note: _note, ...payload } = appEnqueuePayload("running", "x");
    expect(JSON.parse(JSON.stringify(payload))).toEqual({ ...payload });
    expect("text" in (payload.structured as Record<string, unknown>)).toBe(false);
  });

  it("等价构造:buildNotification 失败时入队 payload 只留旧四字段(不炸主链)", () => {
 // 模拟缺 type 的非法数据:note.ok=false → 展开为空对象
    const note = buildNotification("team.activity", { projectId: "", category: "task" } as never);
    expect(note.ok).toBe(false);
    const payload = {
      projectId: "", category: "task", type: "done", summary: "完成:x",
      ...(note.ok ? { structured: note.notification.payload } : {}),
    };
    expect(Object.keys(payload).sort()).toEqual(["category", "projectId", "summary", "type"]);
  });
});
