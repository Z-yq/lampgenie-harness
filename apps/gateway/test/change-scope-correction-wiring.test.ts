import { AGENT_WIRING_SRC } from "./panel-source.js";
/**
 * :更正路径的接线验收——两条线:
 * 1) 纯路径:surfaceGateVerdict 吃 correction(双向覆盖 / 非法回落旧行为);
 * 2) 工具路径:change_surface action=classify 落 journal + 回执带纪律 hint;
 * 3) 源码接线:agent-wiring 在 gate 调用前读更正并按水位缓存(不真起 gateway)。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeChangeSurfaceTool, surfaceGateVerdict } from "../src/change-surface-tool.js";
import { readChangeScopeCorrection, type ChangeScopeCorrection } from "../src/change-scope-correction.js";

const SURFACE_INSTRUCTION = "把 SuperAgent 整体替换成新的数字人";
const NORMAL_INSTRUCTION = "加个按钮";

const correction = (over: Partial<ChangeScopeCorrection> = {}): ChangeScopeCorrection => ({
  scope: "normal",
  by: "agent",
  reason: "只是单点改文案",
  at: 1_700_000_000_000,
  ...over,
});

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

/** 最小假 journal:只实现工具用到的 append/readAll,事件按真实 envelope 形状累积。 */
function makeJournal() {
  const events: { kind: "custom"; sessionId: string; payload: Record<string, unknown> }[] = [];
  return {
    events,
    append(e: { kind: "custom"; sessionId: string; payload: Record<string, unknown> }) {
      events.push(e);
      return e;
    },
    readAll() {
      return events;
    },
  };
}

describe("surfaceGateVerdict × correction(纯路径)", () => {
  it("启发式 surface + 更正 normal → 放行,不再要求清单", () => {
    const v = surfaceGateVerdict({
      taskClass: "coding",
      instruction: SURFACE_INSTRUCTION,
      hasManifest: false,
      exempt: false,
      correction: correction(),
    });
    expect(v.scope).toBe("normal");
    expect(v.matched).toEqual([]);
    expect(v.needsManifest).toBe(false);
    expect(v.deny).toBe(false);
  });

  it("启发式 normal + 更正 surface → 拒绝,reason 指缺盘点", () => {
    const v = surfaceGateVerdict({
      taskClass: "coding",
      instruction: NORMAL_INSTRUCTION,
      hasManifest: false,
      exempt: false,
      correction: correction({ scope: "surface", reason: "其实是换代" }),
    });
    expect(v.scope).toBe("surface");
    expect(v.needsManifest).toBe(true);
    expect(v.deny).toBe(true);
    expect(v.reason).toBe("no-change-surface");
    expect(v.hint).toContain("change_surface");
  });

  it("无更正 → 旧行为逐字不变(surface 拒、matched 保留启发式命中)", () => {
    const v = surfaceGateVerdict({ taskClass: "coding", instruction: SURFACE_INSTRUCTION, hasManifest: false, exempt: false });
    expect(v.scope).toBe("surface");
    expect(v.matched).toContain("替换");
    expect(v.deny).toBe(true);
    expect(v.reason).toBe("no-change-surface");
  });

  it("非法更正(空 reason)→ 回落启发式,不放宽也不收紧", () => {
    const v = surfaceGateVerdict({
      taskClass: "coding",
      instruction: SURFACE_INSTRUCTION,
      hasManifest: false,
      exempt: false,
      correction: correction({ reason: "" }),
    });
    expect(v.scope).toBe("surface");
    expect(v.deny).toBe(true);
  });

  it("更正 surface 且已豁免 → 放行(其余判据不变)", () => {
    const v = surfaceGateVerdict({
      taskClass: "coding",
      instruction: NORMAL_INSTRUCTION,
      hasManifest: false,
      exempt: true,
      correction: correction({ scope: "surface" }),
    });
    expect(v.deny).toBe(false);
  });

  it("更正 surface 且有带链路图的清单 → 放行", () => {
    const v = surfaceGateVerdict({
      taskClass: "coding",
      instruction: NORMAL_INSTRUCTION,
      hasManifest: true,
      hasChain: true,
      exempt: false,
      correction: correction({ scope: "surface" }),
    });
    expect(v.deny).toBe(false);
  });

  it("qa 类任务即便被更正成 surface 也不拦(任务类别先于 scope)", () => {
    const v = surfaceGateVerdict({
      taskClass: "qa",
      instruction: NORMAL_INSTRUCTION,
      hasManifest: false,
      exempt: false,
      correction: correction({ scope: "surface" }),
    });
    expect(v.deny).toBe(false);
  });
});

describe("change_surface action=classify(工具路径)", () => {
  const tool = (journal: ReturnType<typeof makeJournal>, instruction: string) =>
    makeChangeSurfaceTool({ journal, sessionId: "s1", taskId: "t1", root: process.cwd(), instruction });

  it("合法更正:回执 ok/source/hint/audit,journal 落 change.scope.correction", async () => {
    const j = makeJournal();
    const out = JSON.parse(String(await tool(j, SURFACE_INSTRUCTION).execute({ action: "classify", scope: "normal", reason: "只改一处文案" })));
    expect(out).toEqual({
      ok: true,
      scope: "normal",
      source: "corrected",
      hint: "已降级为普通变更：不再要求全链路盘点，但仍需收尾审计标记",
      audit: "change.scope.correction",
    });
    expect(j.events).toHaveLength(1);
    expect(j.events[0]!.kind).toBe("custom");
    expect(j.events[0]!.sessionId).toBe("s1");
    expect(j.events[0]!.payload).toMatchObject({ type: "change.scope.correction", scope: "normal", by: "agent", reason: "只改一处文案" });
    expect(typeof j.events[0]!.payload.at).toBe("number");
  });

  it("反向更正 normal → surface:hint 指向 scan", async () => {
    const j = makeJournal();
    const out = JSON.parse(String(await tool(j, NORMAL_INSTRUCTION).execute({ action: "classify", scope: "surface", reason: "其实是整体换代", by: "小飞" })));
    expect(out.ok).toBe(true);
    expect(out.scope).toBe("surface");
    expect(out.hint).toBe("已升级为全链路变更：先 change_surface scan 再改");
    expect(j.events[0]!.payload.by).toBe("小飞");
  });

  it("非法 scope → INVALID,不写 journal", async () => {
    const j = makeJournal();
    const out = JSON.parse(String(await tool(j, SURFACE_INSTRUCTION).execute({ action: "classify", scope: "surf", reason: "x" })));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("INVALID");
    expect(j.events).toHaveLength(0);
  });

  it("缺 reason / reason 超 300 字 → INVALID,不写 journal", async () => {
    const j = makeJournal();
    const t = tool(j, SURFACE_INSTRUCTION);
    expect(JSON.parse(String(await t.execute({ action: "classify", scope: "normal" }))).code).toBe("INVALID");
    expect(JSON.parse(String(await t.execute({ action: "classify", scope: "normal", reason: "长".repeat(301) }))).code).toBe("INVALID");
    expect(j.events).toHaveLength(0);
  });

  it("重复更正:journal 累积两条,读取取最后一条", async () => {
    const j = makeJournal();
    const t = tool(j, SURFACE_INSTRUCTION);
    await t.execute({ action: "classify", scope: "normal", reason: "先降级" });
    await t.execute({ action: "classify", scope: "surface", reason: "又想起来了" });
    expect(j.events).toHaveLength(2);
    expect(readChangeScopeCorrection(j.readAll(), "s1")?.scope).toBe("surface");
  });

  it("工具描述点明分类有误时可更正", () => {
    const t = makeChangeSurfaceTool({ journal: makeJournal(), sessionId: "s1", taskId: "t1", root: process.cwd() });
    expect(t.description).toContain("action=classify");
    const params = t.parameters as { properties: { action: { enum: string[] }; scope: { enum: string[] } } };
    expect(params.properties.action.enum).toContain("classify");
    expect(params.properties.scope.enum).toEqual(["surface", "normal"]);
  });
});

describe("agent-wiring 源码接线(gate 传 correction)", () => {
  const wiring = AGENT_WIRING_SRC;

  it("读更正走 readChangeScopeCorrection(journal.readSession(...), sessionId)", () => {
    expect(wiring).toContain("readChangeScopeCorrection(journal.readSession(task.sessionId), task.sessionId)");
  });

  it("surfaceGateVerdict 调用点传入 correction", () => {
    expect(wiring).toContain("correction: currentScopeCorrection() ?? undefined");
  });

  it("按 journal 水位缓存(不每步全扫)", () => {
    expect(wiring).toContain("const watermark = journal.length");
    expect(wiring).toContain("scopeCorrectionCache.watermark === watermark");
  });

  it("工具装配带 instruction(classify 才能算出 previous)", () => {
    expect(wiring).toContain('instruction: String(task.instruction ?? "")');
  });
});
