/**
 * 工作流留白持久层:scan 落盘/幂等/reach 停驻落盘/fill 成功与拒绝/chain/report/坏 JSON 容错/原子写。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chainHoleAt,
  draftsDir,
  fillHoleAt,
  getState,
  holesPath,
  listStates,
  reachHoleAt,
  reportHoles,
  scanScript,
} from "../src/workflow-hole-store";

const SCRIPT = [
  'const ctx = await load("task");',
  'hole("plan", "决定下一步做什么");',
  "await run(ctx.plan);",
  "hole('label', '给结果起名');",
  "await finish(ctx.label);",
].join("\n");

const roots: string[] = [];

/** 建一个真实 root 并把脚本写进去。 */
function makeRoot(source = SCRIPT): { root: string; scriptFile: string } {
  const root = mkdtempSync(join(tmpdir(), "genie-workflow-hole-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  const scriptFile = join(root, "src", "flow.mjs");
  writeFileSync(scriptFile, source, "utf8");
  return { root, scriptFile };
}

/** 读 states 文件原文(断言「没落盘」用)。 */
function rawStates(root: string): string {
  return existsSync(holesPath(root)) ? readFileSync(holesPath(root), "utf8") : "";
}

/** 载入 json 后的 state 快照。 */
function stateOf(root: string, id: string): { sites: Record<string, { status: string; line: number }>; stoppedAt?: string } {
  const parsed = JSON.parse(rawStates(root)) as { states: Record<string, never> };
  return parsed.states[id] as unknown as { sites: Record<string, { status: string; line: number }>; stoppedAt?: string };
}

/** 按 name 取 siteId。 */
function siteIdOfName(root: string, id: string, name: string): string {
  const state = stateOf(root, id) as unknown as { sites: Record<string, { name: string }> };
  const entry = Object.entries(state.sites).find(([, site]) => site.name === name);
  if (entry === undefined) throw new Error(`site 不存在:${name}`);
  return entry[0];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scanScript", () => {
  it("scan 文件:落盘 holes.json 与 drafts/<id>.mjs(内容为新源)", () => {
    const { root, scriptFile } = makeRoot();
    const result = scanScript(root, { file: scriptFile, id: "wf-a" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_SCANNED"]);
    expect(result.count).toBe(2);
    expect(result.draftPath).toBe(join(root, "drafts", "wf-a.mjs"));
    expect(existsSync(holesPath(root))).toBe(true);
    expect(readFileSync(result.draftPath!, "utf8")).toBe(SCRIPT);
    const parsed = JSON.parse(rawStates(root)) as { v: number; states: Record<string, unknown> };
    expect(parsed.v).toBe(1);
    expect(Object.keys(parsed.states)).toEqual(["wf-a"]);
    expect(Object.keys(stateOf(root, "wf-a").sites)).toHaveLength(2);
  });

  it("scan source 直给也落盘,幂等(同源两次结果一致)", () => {
    const { root } = makeRoot();
    const first = scanScript(root, { source: SCRIPT, id: "wf-b" });
    const firstRaw = rawStates(root);
    const firstDraft = readFileSync(join(root, "drafts", "wf-b.mjs"), "utf8");
    const second = scanScript(root, { source: SCRIPT, id: "wf-b" });
    expect(second.ok).toBe(true);
    expect(rawStates(root)).toBe(firstRaw);
    expect(readFileSync(join(root, "drafts", "wf-b.mjs"), "utf8")).toBe(firstDraft);
    expect(Object.keys(second.state!.sites)).toEqual(Object.keys(first.state!.sites));
  });

  it("既无 source 也无 file → WORKFLOW_HOLE_INVALID_INPUT", () => {
    const { root } = makeRoot();
    const result = scanScript(root, { id: "wf-c" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["WORKFLOW_HOLE_INVALID_INPUT"]);
    expect(existsSync(holesPath(root))).toBe(false);
  });

  it("文件不存在 → WORKFLOW_HOLE_STORE_ERROR 且不落盘", () => {
    const { root } = makeRoot();
    const result = scanScript(root, { file: join(root, "nope.mjs"), id: "wf-d" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["WORKFLOW_HOLE_STORE_ERROR"]);
    expect(existsSync(holesPath(root))).toBe(false);
  });
});

describe("reachHoleAt", () => {
  it("reach 成功后 stoppedAt 落盘(重新载入可见)并有 hole-reached 事件", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-r" });
    const siteId = siteIdOfName(root, "wf-r", "plan");
    const result = reachHoleAt(root, "wf-r", siteId);
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_REACHED"]);
    expect(result.event).toEqual({
      type: "hole-reached",
      siteId,
      draftPath: join(root, "drafts", "wf-r.mjs"),
      line: 2,
    });
    expect(stateOf(root, "wf-r").stoppedAt).toBe(siteId);
    expect(getState(root, "wf-r").state!.stoppedAt).toBe(siteId);
  });

  it("id 不存在 → NOT_FOUND;site 不存在 → SITE_DRIFT 且不落盘", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-r2" });
    expect(reachHoleAt(root, "wf-missing", "x").codes).toEqual(["WORKFLOW_HOLE_NOT_FOUND"]);
    const before = rawStates(root);
    const drift = reachHoleAt(root, "wf-r2", "deadbeef");
    expect(drift.ok).toBe(false);
    expect(drift.codes).toEqual(["HOLE_SITE_DRIFT"]);
    expect(rawStates(root)).toBe(before);
  });

  it("空 siteId → INVALID_INPUT", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-r3" });
    expect(reachHoleAt(root, "wf-r3", "").codes).toEqual(["WORKFLOW_HOLE_INVALID_INPUT"]);
  });
});

describe("fillHoleAt", () => {
  it("fill 成功:hash 变化、draft 同步成新源、memory 落盘", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-f" });
    const siteId = siteIdOfName(root, "wf-f", "plan");
    reachHoleAt(root, "wf-f", siteId);
    const before = getState(root, "wf-f").state!;
    const result = fillHoleAt(root, "wf-f", { siteId, body: "const plan = choose(ctx);", at: 1_700_000_000_000 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_FILLED"]);
    expect(result.resumed).toBe(true);
    const after = getState(root, "wf-f").state!;
    expect(after.script.hash).not.toBe(before.script.hash);
    expect(after.sites[siteId]!.status).toBe("filled");
    expect(after.stoppedAt).toBeUndefined();
    expect(after.memory[siteId]).toEqual({ body: "const plan = choose(ctx);", at: 1_700_000_000_000 });
    const draft = readFileSync(join(root, "drafts", "wf-f.mjs"), "utf8");
    expect(draft).toBe(after.script.source);
    expect(draft).toContain("const plan = choose(ctx);");
    expect(draft).not.toContain('hole("plan"');
  });

  it("fill 坏体(含 function):ok:false 且 status 仍 waiting、文件未变", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-f2" });
    const siteId = siteIdOfName(root, "wf-f2", "plan");
    const before = rawStates(root);
    const result = fillHoleAt(root, "wf-f2", { siteId, body: "const f = function () { return 1; };" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_INVALID_BODY"]);
    expect(rawStates(root)).toBe(before);
    expect(stateOf(root, "wf-f2").sites[siteId]!.status).toBe("waiting");
  });

  it("fill 编译失败(括号不配对):ok:false 且不落盘、site 仍 waiting", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-f3" });
    const siteId = siteIdOfName(root, "wf-f3", "label");
    const before = rawStates(root);
    const result = fillHoleAt(root, "wf-f3", { siteId, body: "const label = pick(" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_COMPILE_FAILED"]);
    expect(result.reason).toBeTruthy();
    expect(rawStates(root)).toBe(before);
    expect(stateOf(root, "wf-f3").sites[siteId]!.status).toBe("waiting");
  });

  it("fill 漂移(siteId 已不在源里):HOLE_SITE_DRIFT 且不落盘", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-f4" });
    const before = rawStates(root);
    const result = fillHoleAt(root, "wf-f4", { siteId: "deadbeef", body: "const plan = 1;" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_SITE_DRIFT"]);
    expect(rawStates(root)).toBe(before);
  });

  it("fill 已 filled 的 site:HOLE_INVALID 且不覆盖原状态", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-f5" });
    const siteId = siteIdOfName(root, "wf-f5", "plan");
    fillHoleAt(root, "wf-f5", { siteId, body: "const plan = choose(ctx);" });
    const before = rawStates(root);
    const again = fillHoleAt(root, "wf-f5", { siteId, body: "const plan = other();" });
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual(["HOLE_INVALID"]);
    expect(rawStates(root)).toBe(before);
  });

  it("id 不存在 → NOT_FOUND", () => {
    const { root } = makeRoot();
    expect(fillHoleAt(root, "wf-none", { siteId: "x", body: "const a = 1;" }).codes).toEqual([
      "WORKFLOW_HOLE_NOT_FOUND",
    ]);
  });
});

describe("chainHoleAt", () => {
  it("chain 后 states 多一个 waiting site 且 draft 同步", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-c1" });
    const before = Object.keys(stateOf(root, "wf-c1").sites).length;
    const result = chainHoleAt(root, "wf-c1", { name: "review", prompt: "谁来做评审" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["HOLE_CHAINED"]);
    expect(result.site!.status).toBe("waiting");
    const after = stateOf(root, "wf-c1");
    expect(Object.keys(after.sites)).toHaveLength(before + 1);
    expect(after.sites[result.site!.siteId]!.status).toBe("waiting");
    const draft = readFileSync(join(root, "drafts", "wf-c1.mjs"), "utf8");
    expect(draft).toContain('hole("review","谁来做评审")');
    expect(draft).toBe(getState(root, "wf-c1").state!.script.source);
  });

  it("chain 空 name → HOLE_INVALID 且不落盘", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-c2" });
    const before = rawStates(root);
    const result = chainHoleAt(root, "wf-c2", { name: "", prompt: "p" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["HOLE_INVALID"]);
    expect(rawStates(root)).toBe(before);
  });
});

describe("reportHoles / listStates / 容错", () => {
  it("report 计数:total / byStatus / waitingSites / memoryHits / drafts", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-p1" });
    const siteId = siteIdOfName(root, "wf-p1", "plan");
    fillHoleAt(root, "wf-p1", { siteId, body: "const plan = choose(ctx);" });
    const report = reportHoles(root);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(1);
    expect(report.byStatus).toEqual({ waiting: 1, filled: 1 });
    expect(report.waitingSites).toBe(1);
    expect(report.memoryHits).toBe(1);
    expect(report.drafts).toBe(1);
    expect(report.parseErrors).toBe(0);
  });

  it("listStates 出摘要(不吐整份 source)", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-l1" });
    scanScript(root, { file: scriptFile, id: "wf-l2" });
    const list = listStates(root);
    expect(list.ok).toBe(true);
    expect(list.states.map((s) => s.id)).toEqual(["wf-l1", "wf-l2"]);
    expect(list.states[0]!.sites).toBe(2);
    expect(list.states[0]!.waiting).toBe(2);
    expect(list.states[0]!.filled).toBe(0);
    expect(list.states[0]!.draftPath).toBe(join(root, "drafts", "wf-l1.mjs"));
    expect(JSON.stringify(list)).not.toContain("await load");
  });

  it("坏 JSON 容错:report 仍 ok 且 parseErrors 计数,随后 scan 能覆盖修好", () => {
    const { root, scriptFile } = makeRoot();
    mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
    writeFileSync(holesPath(root), "{ 不是 json", "utf8");
    const report = reportHoles(root);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(0);
    expect(report.parseErrors).toBeGreaterThanOrEqual(1);
    expect(listStates(root).parseErrors).toBeGreaterThanOrEqual(1);
    expect(getState(root, "wf-x").codes).toEqual(["WORKFLOW_HOLE_NOT_FOUND"]);
    const rescanned = scanScript(root, { file: scriptFile, id: "wf-x" });
    expect(rescanned.ok).toBe(true);
    expect(reportHoles(root).parseErrors).toBe(0);
  });

  it("getState 不存在 → WORKFLOW_HOLE_NOT_FOUND", () => {
    const { root } = makeRoot();
    const result = getState(root, "wf-absent");
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["WORKFLOW_HOLE_NOT_FOUND"]);
    expect(result.state).toBeUndefined();
  });

  it("原子写不留 .tmp 残留(states 与 drafts 目录都干净)", () => {
    const { root, scriptFile } = makeRoot();
    scanScript(root, { file: scriptFile, id: "wf-t1" });
    const siteId = siteIdOfName(root, "wf-t1", "plan");
    reachHoleAt(root, "wf-t1", siteId);
    fillHoleAt(root, "wf-t1", { siteId, body: "const plan = choose(ctx);" });
    chainHoleAt(root, "wf-t1", { name: "review", prompt: "p" });
    const rsiDir = readdirSync(join(root, ".genie", "rsi"));
    const draftEntries = readdirSync(draftsDir(root));
    expect(rsiDir.some((name) => name.includes("tmp-"))).toBe(false);
    expect(draftEntries.some((name) => name.includes("tmp-"))).toBe(false);
    expect(draftEntries).toEqual(["wf-t1.mjs"]);
    expect(rsiDir).toEqual(["holes.json"]);
  });
});
