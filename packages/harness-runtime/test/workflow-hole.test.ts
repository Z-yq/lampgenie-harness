/**
 * 工作流留白与填充:扫描 / 停驻 / 填充(splice + 重编译 + 漂移校验)/ 记忆命中 / 尾链 / 草稿路径。
 * 全部纯数据 + 固定时间戳(at 注入),不碰文件与真实时钟。
 */
import { describe, expect, it } from "vitest";
import {
  HOLE_CODES,
  chainTail,
  draftPath,
  fillHole,
  memoryHit,
  reachHole,
  roughCompileCheck,
  scanHoles,
} from "../src/agent/workflow-hole.ts";
import type { HoleSite, HoleState } from "../src/agent/workflow-hole.ts";

const T0 = 1_700_000_000_000;
const T1 = 1_700_000_100_000;

/** 含两个 hole 的脚本:第 2 行双引号、第 4 行单引号(hole 作独立语句)。 */
const SCRIPT = [
  'const ctx = await load("task");',
  'hole("plan", "决定下一步做什么");',
  "await run(ctx.plan);",
  "hole('label', '给结果起名');",
  "await finish(ctx.label);",
].join("\n");

const BODY_PLAN = "const plan = choose(ctx);";
const BODY_LABEL = "const label = `r-${ctx.id}`;";

/** 扫一次并拿第一个 waiting site。 */
function firstSite(state: HoleState): { siteId: string; line: number } {
  const ids = Object.keys(state.sites);
  const siteId = ids[0]!;
  return { siteId, line: state.sites[siteId]!.line };
}

/** 按 name 取 siteId。 */
function siteByName(state: HoleState, name: string): string {
  const found = Object.values(state.sites).find((s) => s.name === name);
  if (found === undefined) throw new Error(`site 不存在: ${name}`);
  return found.siteId;
}

describe("scanHoles", () => {
  it("扫出两个 hole,行号 1-based 且 name/prompt 正确", () => {
    const result = scanHoles(SCRIPT);
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_SCANNED"]);
    expect(result.count).toBe(2);
    const sites = Object.values(result.state.sites);
    expect(sites).toHaveLength(2);
    expect(sites.map((s) => s.name).sort()).toEqual(["label", "plan"]);
    expect(sites.find((s) => s.name === "plan")!.prompt).toBe("决定下一步做什么");
    expect(sites.find((s) => s.name === "plan")!.line).toBe(2);
    expect(sites.find((s) => s.name === "label")!.line).toBe(4);
    expect(sites.every((s) => s.status === "waiting")).toBe(true);
  });

  it("同输入两次扫描 siteId 完全一致", () => {
    const a = scanHoles(SCRIPT).state;
    const b = scanHoles(SCRIPT).state;
    expect(Object.keys(a.sites)).toEqual(Object.keys(b.sites));
  });

  it("行号变化会让 siteId 变化", () => {
    const shifted = `// 前插一行\n${SCRIPT}`;
    const a = siteByName(scanHoles(SCRIPT).state, "plan");
    const b = siteByName(scanHoles(shifted).state, "plan");
    expect(a).not.toBe(b);
    expect(b).toHaveLength(8);
  });

  it("siteId 是 8 位十六进制", () => {
    const { siteId } = firstSite(scanHoles(SCRIPT).state);
    expect(siteId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("不含 hole 的脚本也 ok,count=0 且 codes 带 HOLE_SCANNED", () => {
    const result = scanHoles("const a = 1;\nawait run(a);\n");
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("HOLE_SCANNED");
    expect(result.count).toBe(0);
    expect(result.state.sites).toEqual({});
  });

  it("state 里没有任何执行记录 / node row 字段", () => {
    const state = scanHoles(SCRIPT).state;
    expect(Object.keys(state).sort()).toEqual(["memory", "script", "sites"]);
    for (const key of ["nodeRow", "rows", "executed", "records", "runs"]) {
      expect(key in state).toBe(false);
    }
  });

  it("script.hash 是 source 的 12 位 sha256,source 变则 hash 变", () => {
    const a = scanHoles(SCRIPT).state.script;
    const b = scanHoles(`${SCRIPT}\n// tail`).state.script;
    expect(a.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(a.hash).not.toBe(b.hash);
    expect(a.source).toBe(SCRIPT);
  });

  it("script.id 缺省为 wf-<hash 前 6>,显式 id 优先", () => {
    const auto = scanHoles(SCRIPT).state.script;
    expect(auto.id).toBe(`wf-${auto.hash.slice(0, 6)}`);
    expect(scanHoles(SCRIPT, { id: "wf-fixed" }).state.script.id).toBe("wf-fixed");
  });

  it("识别单引号与多余空白", () => {
    const state = scanHoles(`const a = hole ( 'x' ,  "y" );\n`).state;
    const site = Object.values(state.sites)[0]!;
    expect(site.name).toBe("x");
    expect(site.prompt).toBe("y");
  });
});

describe("reachHole", () => {
  it("成功:设置 stoppedAt 并发 hole-reached 事件(含 draftPath 与行号)", () => {
    const state = scanHoles(SCRIPT, { id: "wf-demo" }).state;
    const siteId = siteByName(state, "plan");
    const result = reachHole(state, siteId);
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_REACHED"]);
    expect(result.state.stoppedAt).toBe(siteId);
    expect(state.stoppedAt).toBeUndefined();
    expect(result.event).toEqual({
      type: "hole-reached",
      siteId,
      draftPath: "./drafts/wf-demo.mjs",
      line: 2,
    });
  });

  it("root 选项进入 draftPath", () => {
    const state = scanHoles(SCRIPT, { id: "wf-demo" }).state;
    const result = reachHole(state, siteByName(state, "plan"), { root: "/tmp/wh" });
    expect(result.event!.draftPath).toBe("/tmp/wh/drafts/wf-demo.mjs");
  });

  it("site 不存在 → HOLE_SITE_DRIFT 且 state 原样", () => {
    const state = scanHoles(SCRIPT).state;
    const result = reachHole(state, "deadbeef");
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_SITE_DRIFT"]);
    expect(result.state).toBe(state);
    expect(result.state.stoppedAt).toBeUndefined();
    expect(result.event).toBeUndefined();
  });

  it("site 已 filled → HOLE_INVALID 且不再停驻", () => {
    const scanned = scanHoles(SCRIPT).state;
    const siteId = siteByName(scanned, "plan");
    const filled = fillHole(scanned, { siteId, body: BODY_PLAN, at: T0 }).state;
    const result = reachHole(filled, siteId);
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_INVALID"]);
  });
});

describe("fillHole", () => {
  const base = scanHoles(SCRIPT, { id: "wf-fill" }).state;

  it("合法填充:filled / hash 变化 / stoppedAt 清空 / memory 写入 / resumed", () => {
    const siteId = siteByName(base, "plan");
    const reached = reachHole(base, siteId).state;
    const result = fillHole(reached, { siteId, body: BODY_PLAN, at: T1 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_FILLED"]);
    expect(result.resumed).toBe(true);
    const next = result.state;
    expect(next.sites[siteId]!.status).toBe("filled");
    expect(next.sites[siteId]!.bodyHash).toMatch(/^[0-9a-f]{8}$/);
    expect(next.script.hash).not.toBe(base.script.hash);
    expect(next.script.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(next.stoppedAt).toBeUndefined();
    expect(next.memory[siteId]).toEqual({ body: BODY_PLAN, at: T1 });
    expect(next.script.source).toContain(BODY_PLAN);
    expect(next.script.source).not.toContain('hole("plan"');
    expect(result.site!.name).toBe("plan");
  });

  it("填充不改原 state(纯函数)", () => {
    const siteId = siteByName(base, "plan");
    const before = JSON.stringify(base);
    fillHole(base, { siteId, body: BODY_PLAN, at: T1 });
    expect(JSON.stringify(base)).toBe(before);
  });

  it("独立语句 hole 整行替换,不残留原有绑定前缀", () => {
    const siteId = siteByName(base, "plan");
    const result = fillHole(base, { siteId, body: BODY_PLAN, at: T1 });
    const lines = result.state.script.source.split("\n");
    expect(lines[1]).toBe(BODY_PLAN);
    expect(result.state.script.source).not.toContain("const plan = const plan");
    expect(result.state.script.source.split("\n")).toHaveLength(SCRIPT.split("\n").length);
  });

  it("嵌在表达式里的 hole 只替换调用本身", () => {
    const expr = scanHoles('const p = hole("p", "x");\nawait run(p);\n').state;
    const siteId = Object.keys(expr.sites)[0]!;
    const result = fillHole(expr, { siteId, body: "choose()", at: T1 });
    expect(result.ok).toBe(true);
    expect(result.state.script.source.split("\n")[0]).toBe("const p = choose();");
  });

  it("独立语句 `await hole(...)` 连带 await 一起替换,不拼出 await const", () => {
    const src = 'async function f(ctx) {\n  await hole("s", "p");\n  await ctx.end();\n}\n';
    const st = scanHoles(src).state;
    const siteId = Object.keys(st.sites)[0]!;
    const result = fillHole(st, { siteId, body: "const v = await read();", at: T1 });
    expect(result.ok).toBe(true);
    const out = result.state.script.source;
    expect(out).not.toContain("await const");
    expect(out.split("\n")[1]).toBe("const v = await read();");
  });

  it("at 缺省用 Date.now()", () => {
    const siteId = siteByName(base, "label");
    const result = fillHole(base, { siteId, body: BODY_LABEL });
    expect(result.state.memory[siteId]!.at).toBeGreaterThan(1_600_000_000_000);
  });

  it("空体 → HOLE_INVALID_BODY 且 site 仍 waiting", () => {
    const siteId = siteByName(base, "plan");
    const result = fillHole(base, { siteId, body: "   \n  " });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_INVALID_BODY"]);
    expect(result.state.sites[siteId]!.status).toBe("waiting");
  });

  it("体内含 hole( → HOLE_INVALID_BODY", () => {
    const siteId = siteByName(base, "plan");
    const result = fillHole(base, { siteId, body: 'const p = hole("x","y");' });
    expect(result.codes).toEqual(["HOLE_INVALID_BODY"]);
  });

  it("体内含 function → HOLE_INVALID_BODY", () => {
    const siteId = siteByName(base, "plan");
    const result = fillHole(base, { siteId, body: "const f = function () { return 1; };" });
    expect(result.codes).toEqual(["HOLE_INVALID_BODY"]);
  });

  it("体内含顶层 => → HOLE_INVALID_BODY", () => {
    const siteId = siteByName(base, "plan");
    const result = fillHole(base, { siteId, body: "const f = () => 1;" });
    expect(result.codes).toEqual(["HOLE_INVALID_BODY"]);
  });

  it("嵌套在括号里的 => 允许(只拦顶层)", () => {
    const siteId = siteByName(base, "plan");
    const result = fillHole(base, { siteId, body: "const names = items.map((i) => i.name);" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_FILLED"]);
  });

  it("siteId 不存在 → HOLE_SITE_DRIFT(codes 只含它)", () => {
    const result = fillHole(base, { siteId: "deadbeef", body: BODY_PLAN });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_SITE_DRIFT"]);
    expect(result.codes).toHaveLength(1);
    expect(result.state).toBe(base);
  });

  it("源里已找不到该调用(漂移)→ HOLE_SITE_DRIFT 且不改 state", () => {
    const siteId = siteByName(base, "plan");
    const edited: HoleState = { ...base, script: { ...base.script, source: base.script.source.replace("plan", "plan2") } };
    const result = fillHole(edited, { siteId, body: BODY_PLAN });
    expect(result.codes).toEqual(["HOLE_SITE_DRIFT"]);
    expect(result.state).toBe(edited);
    expect(result.state.sites[siteId]!.status).toBe("waiting");
  });

  it("括号不配对 → HOLE_COMPILE_FAILED + reason,site 仍 waiting,停点保留", () => {
    const siteId = siteByName(base, "plan");
    const reached = reachHole(base, siteId).state;
    const result = fillHole(reached, { siteId, body: "const plan = choose(ctx", at: T1 });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_COMPILE_FAILED"]);
    expect(typeof result.reason).toBe("string");
    expect(result.reason).toBeTruthy();
    const next = result.state;
    expect(next.sites[siteId]!.status).toBe("waiting");
    expect(next.script.hash).toBe(reached.script.hash);
    expect(next.stoppedAt).toBe(siteId);
    expect(next.memory[siteId]).toBeUndefined();
  });

  it("引号未闭合 → HOLE_COMPILE_FAILED", () => {
    const siteId = siteByName(base, "plan");
    const result = fillHole(base, { siteId, body: 'const p = `open;' });
    expect(result.codes).toEqual(["HOLE_COMPILE_FAILED"]);
  });

  it("已 filled 的 site 再填合法体 → HOLE_INVALID,原状态不变", () => {
    const siteId = siteByName(base, "plan");
    const filled = fillHole(base, { siteId, body: BODY_PLAN, at: T0 }).state;
    const again = fillHole(filled, { siteId, body: "const plan = other();", at: T1 });
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual(["HOLE_INVALID"]);
    expect(again.state).toBe(filled);
  });

  it("已 filled 的 site 再填坏体 → 已填判定优先返回 HOLE_INVALID", () => {
    const siteId = siteByName(base, "plan");
    const filled = fillHole(base, { siteId, body: BODY_PLAN, at: T0 }).state;
    const again = fillHole(filled, { siteId, body: "const f = function () {};" });
    expect(again.codes).toEqual(["HOLE_INVALID"]);
    expect(filled.sites[siteId]!.status).toBe("filled");
  });

  it("填不存在的 site 且 body 也坏 → 仍先判 HOLE_SITE_DRIFT(漂移优先于坏体)", () => {
    const drifted = fillHole(base, { siteId: "deadbeef", body: "const f = function () {};" });
    expect(drifted.ok).toBe(false);
    expect(drifted.codes).toEqual(["HOLE_SITE_DRIFT"]);
    expect(drifted.state).toBe(base);
  });
});

describe("chainTail", () => {
  it("尾部追加后 sites+1 且新 site waiting、hash 更新", () => {
    const base = scanHoles(SCRIPT).state;
    const result = chainTail(base, { name: "review", prompt: "谁来做评审" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_CHAINED"]);
    expect(Object.keys(result.state.sites)).toHaveLength(Object.keys(base.sites).length + 1);
    const site = result.site!;
    expect(site.name).toBe("review");
    expect(site.prompt).toBe("谁来做评审");
    expect(site.status).toBe("waiting");
    expect(site.line).toBe(SCRIPT.split("\n").length + 1);
    expect(result.state.sites[site.siteId]).toEqual(site);
    expect(result.state.script.hash).not.toBe(base.script.hash);
    expect(result.state.script.source).toContain('hole("review","谁来做评审")');
    expect(base.script.source).toBe(SCRIPT);
  });

  it("新 site 可以立刻 reach + fill", () => {
    const base = scanHoles(SCRIPT).state;
    const chained = chainTail(base, { name: "review", prompt: "p" }).state;
    const siteId = siteByName(chained, "review");
    const reached = reachHole(chained, siteId);
    expect(reached.ok).toBe(true);
    const filled = fillHole(reached.state, { siteId, body: "const review = await ask();", at: T0 });
    expect(filled.ok).toBe(true);
    expect(filled.codes).toEqual(["HOLE_FILLED"]);
  });

  it("空 name → HOLE_INVALID 且 state 不变", () => {
    const base = scanHoles(SCRIPT).state;
    const result = chainTail(base, { name: "  ", prompt: "x" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_INVALID"]);
    expect(result.state).toBe(base);
    expect(result.site).toBeUndefined();
  });

  it("同 name 链两次不去重(不同位置是不同事实)", () => {
    const base = scanHoles(SCRIPT).state;
    const once = chainTail(base, { name: "review", prompt: "a" }).state;
    const twice = chainTail(once, { name: "review", prompt: "b" }).state;
    const names = Object.values(twice.sites).filter((s) => s.name === "review");
    expect(names).toHaveLength(2);
    expect(new Set(names.map((s) => s.siteId)).size).toBe(2);
  });
});

describe("chain 后的 siteId 稳定性(回归)", () => {
  it("chain 不改既有 site 的 siteId / line / status", () => {
    const base = scanHoles(SCRIPT).state;
    const before = Object.values(base.sites).map((s) => [s.siteId, s.name, s.line, s.status] as const);
    const chained = chainTail(base, { name: "review", prompt: "谁来做评审" }).state;
    for (const [siteId, name, line, status] of before) {
      const site = chained.sites[siteId]!;
      expect(site).toBeTruthy();
      expect([site.siteId, site.name, site.line, site.status]).toEqual([siteId, name, line, status]);
    }
  });

  it("chain 后填原 site 成功,尾部新留白仍在源里", () => {
    const base = scanHoles(SCRIPT).state;
    const planId = siteByName(base, "plan");
    const chained = chainTail(base, { name: "review", prompt: "谁来做评审" }).state;
    const reviewId = siteByName(chained, "review");
    const result = fillHole(chained, { siteId: planId, body: BODY_PLAN, at: T1 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_FILLED"]);
    expect(result.resumed).toBe(true);
    expect(result.state.sites[planId]!.status).toBe("filled");
    expect(result.state.memory[planId]).toEqual({ body: BODY_PLAN, at: T1 });
    expect(result.state.sites[reviewId]!.status).toBe("waiting");
    expect(result.state.script.source).toContain('hole("review"');
  });

  it("填原 site 后尾部新留白仍可 fill(旧留白与尾链互不影响)", () => {
    const base = scanHoles(SCRIPT).state;
    const chained = chainTail(base, { name: "review", prompt: "p" }).state;
    const planId = siteByName(chained, "plan");
    const reviewId = siteByName(chained, "review");
    const afterPlan = fillHole(chained, { siteId: planId, body: BODY_PLAN, at: T1 }).state;
    const result = fillHole(afterPlan, { siteId: reviewId, body: "await review(ctx);", at: T1 });
    expect(result.ok).toBe(true);
    expect(result.state.sites[reviewId]!.status).toBe("filled");
    expect(result.state.sites[siteByName(result.state, "label")]!.status).toBe("waiting");
  });
});

describe("memoryHit", () => {
  it("命中:返回上次函数体与时间,带 HOLE_MEMORY_HIT", () => {
    const base = scanHoles(SCRIPT).state;
    const siteId = siteByName(base, "plan");
    const filled = fillHole(base, { siteId, body: BODY_PLAN, at: T1 }).state;
    const result = memoryHit(filled, siteId);
    expect(result.ok).toBe(true);
    expect(result.hit).toBe(true);
    expect(result.codes).toEqual(["HOLE_MEMORY_HIT"]);
    expect(result.body).toBe(BODY_PLAN);
    expect(result.at).toBe(T1);
  });

  it("未命中:ok 但 hit=false 且 codes 为空", () => {
    const base = scanHoles(SCRIPT).state;
    const result = memoryHit(base, siteByName(base, "plan"));
    expect(result).toEqual({ ok: true, hit: false, codes: [] });
  });
});

describe("draftPath", () => {
  const state = scanHoles(SCRIPT, { id: "wf-demo" }).state;

  it("缺省 root 用 .", () => {
    expect(draftPath(state)).toBe("./drafts/wf-demo.mjs");
  });

  it("root 尾斜杠不会拼出双斜杠", () => {
    expect(draftPath(state, "/tmp/wh/")).toBe("/tmp/wh/drafts/wf-demo.mjs");
    expect(draftPath(state, "/")).toBe("/drafts/wf-demo.mjs");
  });

  it("相对 root 保持单斜杠", () => {
    expect(draftPath(state, "runs/2026")).toBe("runs/2026/drafts/wf-demo.mjs");
  });
});

describe("roughCompileCheck", () => {
  it("配对合法 → ok", () => {
    expect(roughCompileCheck("const a = [1, {b: 2}];").ok).toBe(true);
  });

  it("空源 / 括号多闭合 / 未闭合 / 引号未闭合 → not ok 且有 reason", () => {
    expect(roughCompileCheck("").ok).toBe(false);
    expect(roughCompileCheck("const a = (1));").ok).toBe(false);
    expect(roughCompileCheck("const a = (1;").ok).toBe(false);
    const quote = roughCompileCheck('const a = "x;');
    expect(quote.ok).toBe(false);
    expect(quote.reason).toBeTruthy();
  });
});

describe("稳定 siteId(chain/fill 后不漂移)", () => {
  it("chain 前后旧 siteId 与 stoppedAt 都不变", () => {
    const scanned = scanHoles(SCRIPT, { id: "wf-stable" }).state;
    const planId = siteByName(scanned, "plan");
    const reached = reachHole(scanned, planId).state;
    const chained = chainTail(reached, { name: "review", prompt: "谁来做评审" }).state;
    expect(siteByName(chained, "plan")).toBe(planId);
    expect(siteByName(chained, "label")).toBe(siteByName(reached, "label"));
    expect(chained.stoppedAt).toBe(planId);
    expect(chained.sites[planId]!.status).toBe("waiting");
  });

  it("chain 后 fill 停驻的旧 site → FILLED(回归 #32)", () => {
    const scanned = scanHoles(SCRIPT).state;
    const planId = siteByName(scanned, "plan");
    const reached = reachHole(scanned, planId).state;
    const chained = chainTail(reached, { name: "review", prompt: "p" }).state;
    const filled = fillHole(chained, { siteId: planId, body: BODY_PLAN, at: T1 });
    expect(filled.ok).toBe(true);
    expect(filled.codes).toEqual(["HOLE_FILLED"]);
    expect(filled.state.sites[planId]!.status).toBe("filled");
    expect(filled.state.sites[siteByName(chained, "label")]!.status).toBe("waiting");
    expect(filled.state.sites[siteByName(chained, "review")]!.status).toBe("waiting");
    expect(filled.state.script.source).not.toContain('hole("plan"');
    expect(filled.state.script.hash).not.toBe(chained.script.hash);
  });

  it("同名不同行 → 两个不同 siteId", () => {
    const src = 'hole("same", "a");\nawait step();\nhole("same", "b");\n';
    const state = scanHoles(src).state;
    const byLine: HoleSite[] = Object.values(state.sites).sort((a, b) => a.line - b.line);
    expect(byLine).toHaveLength(2);
    expect(byLine[0]!.siteId).not.toBe(byLine[1]!.siteId);
    expect(byLine[0]!.siteId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("同名同行重复(构造)→ #k 后缀、确定且可逐个填", () => {
    const src = 'hole("dup", "a"); hole("dup", "b");\n';
    const a = scanHoles(src).state;
    const b = scanHoles(src).state;
    const ids = Object.keys(a.sites).sort();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}#0$/);
    expect(ids[1]).toMatch(/^[0-9a-f]{8}#1$/);
    expect(Object.keys(b.sites).sort()).toEqual(ids);
    const first = ids[0]!;
    const second = ids[1]!;
    const f2 = fillHole(a, { siteId: second, body: "const second = 2;", at: T1 });
    expect(f2.ok).toBe(true);
    expect(f2.state.sites[first]!.status).toBe("waiting");
    expect(f2.state.script.source).toContain('hole("dup", "a")');
    expect(f2.state.script.source).toContain("const second = 2;");
    const f1 = fillHole(f2.state, { siteId: first, body: "const first = 1;", at: T1 });
    expect(f1.ok).toBe(true);
    expect(f1.state.script.source).not.toContain("hole(");
  });

  it("memoryHit 在 chain 后仍命中(键不变)", () => {
    const scanned = scanHoles(SCRIPT).state;
    const labelId = siteByName(scanned, "label");
    const filled = fillHole(scanned, { siteId: labelId, body: BODY_LABEL, at: T0 }).state;
    const chained = chainTail(filled, { name: "review", prompt: "p" }).state;
    const hit = memoryHit(chained, labelId);
    expect(hit.ok).toBe(true);
    expect(hit.hit).toBe(true);
    expect(hit.body).toBe(BODY_LABEL);
    expect(hit.at).toBe(T0);
  });

  it("源码整体位移(该 (name,line) 已不存在)→ 仍判 HOLE_SITE_DRIFT", () => {
    const scanned = scanHoles(SCRIPT).state;
    const planId = siteByName(scanned, "plan");
    const shifted: HoleState = {
      ...scanned,
      script: { ...scanned.script, source: `// 前插一行\n${SCRIPT}` },
    };
    const result = fillHole(shifted, { siteId: planId, body: BODY_PLAN });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_SITE_DRIFT"]);
    expect(result.state).toBe(shifted);
  });
});
