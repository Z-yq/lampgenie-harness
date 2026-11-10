/**
 * J4 侧栏会话完整性与活动时间排序(面板侧契约:
 *  「有的时候会展示不全,时不时漏掉一些最近的执行 session;排序要按 session 有动作更新时间」
 * 口径:
 *  ①列表行集合不静默丢:桶内有「显示更多(还有 N 条)」,折叠桶显式给「已折叠 N 条」;
 *  ②排序键 = max(会话最近活动时间, 任务 updatedAt):会话有动作(消息/工具/白板/子代理)即上浮,
 *    与 Task.updatedAt 是否刷新无关;活动时间缺失时逐字回落旧行为(不排错);
 *  ③hello 带 sessionActivity 快照、session.status.changed 带 lastActivityAt 时写入本地索引并重渲侧栏;
 *  ④活动时间只用于比较/展示,绝不回写进任务对象 updatedAt(时间戳是事实)。
 * 做法:从 servePanel 的 HTML 里抽出真实函数源码(不是抄一份),在最小沙箱里真跑排序;
 * 其余用字面断言(零反斜杠纪律)。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 纯静态:不接 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

/** 用页面真实源码组装沙箱:sessionActivity Map + noteSessionAct/actOf/runFirstCmp。 */
function sortSandbox(html: string) {
  const code = [
    "var settings = { sortBy: 'updated' };",
    "var sessionActivity = new Map();",
    extractFn(html, "noteSessionAct"),
    extractFn(html, "actOf"),
    extractFn(html, "runFirstCmp"),
    "return { settings: settings, sessionActivity: sessionActivity, noteSessionAct: noteSessionAct, actOf: actOf, runFirstCmp: runFirstCmp };",
  ].join("chars".length ? "\n" : "\n");
  return new Function(code)() as {
    settings: { sortBy: string };
    sessionActivity: Map<string, number>;
    noteSessionAct: (sid: string, at: number) => void;
    actOf: (t: Record<string, unknown>) => number;
    runFirstCmp: (a: Record<string, unknown>, b: Record<string, unknown>) => number;
  };
}

const T0 = 1_700_000_000_000;

describe("侧栏会话排序与完整性(J4)", () => {
  it("①活动时间缺失时逐字回落旧键(Task.updatedAt 降序)", async () => {
    await withPanel(7971, (html) => {
      const sb = sortSandbox(html);
      const rows = [
        { sessionId: "old", state: "done", updatedAt: T0 + 100, createdAt: T0 },
        { sessionId: "new", state: "done", updatedAt: T0 + 900, createdAt: T0 + 500 },
        { sessionId: "mid", state: "done", updatedAt: T0 + 500, createdAt: T0 + 100 },
      ];
      expect(rows.slice().sort(sb.runFirstCmp).map((r) => r.sessionId)).toEqual(["new", "mid", "old"]);
    });
  }, 30_000);

  it("②会话有动作即上浮:活动时间新于所有任务的 updatedAt 时排最前(不靠 Task.updatedAt)", async () => {
    await withPanel(7972, (html) => {
      const sb = sortSandbox(html);
      // 12 个会话:任务时间都停在 T0 附近(状态迁移很早),只有 s-ide 刚刚还在干活
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < 12; i++) {
        rows.push({ sessionId: "s" + i, state: "done", updatedAt: T0 + i, createdAt: T0 });
      }
      rows.push({ sessionId: "s-ide", state: "done", updatedAt: T0, createdAt: T0 });
      sb.noteSessionAct("s-ide", T0 + 60_000);
      const sorted = rows.slice().sort(sb.runFirstCmp).map((r) => r.sessionId);
      expect(sorted[0]).toBe("s-ide"); // 最近有动作的会话置顶
      // 活动时间不进 updatedAt:actOf 是纯计算,行对象未被改写
      expect(rows[12]!.updatedAt).toBe(T0);
      expect(sb.actOf(rows[12]!)).toBe(T0 + 60_000);
    });
  }, 30_000);

  it("③单调:旧活动帧不把会话推回底部(活动时间取 max)", async () => {
    await withPanel(7973, (html) => {
      const sb = sortSandbox(html);
      sb.noteSessionAct("a", T0 + 5000);
      sb.noteSessionAct("a", T0 + 1000); // 乱序到达的旧帧
      expect(sb.sessionActivity.get("a")).toBe(T0 + 5000);
      const rows = [
        { sessionId: "a", state: "done", updatedAt: T0, createdAt: T0 },
        { sessionId: "b", state: "done", updatedAt: T0 + 2000, createdAt: T0 },
      ];
      expect(rows.slice().sort(sb.runFirstCmp)[0]!.sessionId).toBe("a");
    });
  }, 30_000);

  it("④运行中(running/queued)仍整体置顶,与活动时间无关", async () => {
    await withPanel(7974, (html) => {
      const sb = sortSandbox(html);
      sb.noteSessionAct("done-recent", T0 + 99_000);
      const rows = [
        { sessionId: "done-recent", state: "done", updatedAt: T0, createdAt: T0 },
        { sessionId: "running", state: "running", updatedAt: T0, createdAt: T0 },
        { sessionId: "queued", state: "queued", updatedAt: T0, createdAt: T0 },
      ];
      const sorted = rows.slice().sort(sb.runFirstCmp).map((r) => r.sessionId);
      expect(sorted.indexOf("running")).toBeLessThan(sorted.indexOf("done-recent"));
      expect(sorted.indexOf("queued")).toBeLessThan(sorted.indexOf("done-recent"));
    });
  }, 30_000);

  it("⑤数据链路:hello 读 sessionActivity;status 帧写 lastActivityAt 并重渲侧栏", async () => {
    await withPanel(7975, (html) => {
      // hello 首帧快照
      expect(html).toContain("if (m.sessionActivity && typeof m.sessionActivity === \"object\")");
      expect(html).toContain("noteSessionAct(sid, m.sessionActivity[sid])");
      // 增量帧
      expect(html).toContain("if (typeof m.lastActivityAt === \"number\")");
      expect(html).toContain("noteSessionAct(m.sessionId, m.lastActivityAt)");
      expect(html).toContain("scheduleSidebarRefresh()");
      // 行时间显示活动时间
      expect(html).toContain("ago(actOf(t))");
    });
  }, 30_000);

  it("⑥长列表不静默截断:分页有剩余计数,折叠桶显式给被隐藏条数", async () => {
    await withPanel(7976, (html) => {
      // 桶内分页:保留 ZCode 每页 5 条 + 「显示更多(还有 N 条)」出口
      expect(html).toContain("显示更多(还有");
      expect(html).toContain("b.items.length - lim");
      // 折叠桶不再静默吞行
      expect(html).toContain("已折叠 ' + hiddenCt + ' 条");
      expect(html).toContain("const hiddenCt = collapsed ? Math.max(0, b.items.length - shown.length) : 0;");
      // 任务区仍有「显示更多」出口
      expect(html).toContain("sec:tasks");
    });
  }, 30_000);

  it("⑦负面:活动时间不回写进任务对象 updatedAt", async () => {
    await withPanel(7977, (html) => {
      expect(html.includes("updatedAt: m.lastActivityAt")).toBe(false);
      expect(html.includes("updatedAt: actAt")).toBe(false);
      expect(html.includes("updatedAt: lastActivityAt")).toBe(false);
      // actOf 只读 sessionActivity/updatedAt/createdAt
      const actOf = extractFn(html, "actOf");
      expect(actOf).toContain("sessionActivity.get(t.sessionId)");
      expect(actOf.includes("t.updatedAt =")).toBe(false);
    });
  }, 30_000);
});
