/**
 * board_upsert action=audit format="json" 的结构化收口结果(2026-10-25 code 板 P0):
 * - JSON 主路径:grand/boards/coverage 可 JSON.parse 消费,execute 仍返回 string;
 * - scope 分区只统计本写者前缀节点;
 * - all=true 跨板聚合;
 * - 空态返回 ok:false + reason(不伪造 100%);
 * - 不带 format 的文本路径逐字保持(含变更契约自检文本)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { saveBoard } from "../src/board-store.js";
import { boardUpsertTool } from "../src/agent-wiring.js";

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-audit-json-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const p0 = (id: string, label = "落目标") => ({
  id, kind: "module", label, summary: "验收目标", change: "add" as const,
  group: "02 变更",
  phase: "P0" as const, targets: [`apps/gateway/src/${id}.ts`],
  flow: [{ type: "branch" as const, cond: "条件", then: [{ type: "step" as const, text: "成功" }], else: [{ type: "step" as const, text: "失败" }] }],
  accept: [
    { cmd: `cmd-${id}`, expect: "ok", type: "command" as const },
    { cmd: `bad-${id}`, expect: "不崩溃", type: "negative" as const },
  ],
  evidence: [
    { cmd: `cmd-${id}`, ok: true, at: 1, output: "ok" },
    { cmd: `bad-${id}`, ok: true, at: 1, output: "ok" },
  ],
});

function board(taskId: string, nodes: unknown[], extra: Record<string, unknown> = {}) {
  // 板型门(step-1008,2026-10-29):code 板一律是控制流程图——start→步骤→decision 是/否→end。
  // 审计测试的 fixture 也按合格 flow 板构造(步骤节点带仓库相对路径 targets + change + flow 行)。
  const s = { id: "s", kind: "start", label: "用户发起", summary: "触发入口", change: "keep" as const, group: "01 触发", targets: ["apps/gateway/src/panel.ts"] };
  const cur = { id: "cur", kind: "function", label: "读现状链路", summary: "现状链路", change: "keep" as const, group: "01 触发",
    targets: ["apps/gateway/src/panel.ts#boot"], flow: [{ type: "step" as const, text: "const st = boot()" }] };
  const d = { id: "d", kind: "decision", label: "链路可用?", summary: "分支判定", change: "keep" as const, group: "02 变更",
    targets: ["apps/gateway/src/panel.ts#boot"], flow: [{ type: "branch" as const, cond: "st.ok", then: [{ type: "step" as const, text: "走变更" }], else: [{ type: "step" as const, text: "保持" }] }] };
  const e1 = { id: "e-ok", kind: "end", label: "变更生效", summary: "结果出口", change: "keep" as const, group: "02 变更", targets: ["apps/gateway/src/panel.ts"] };
  const e2 = { id: "e-keep", kind: "end", label: "保持现状", summary: "另一出口", change: "keep" as const, group: "02 变更", targets: ["apps/gateway/src/panel.ts"] };
  const reg = { id: "reg", kind: "function", label: "回归测试断言", summary: "测试:期望 ok", change: "keep" as const, group: "03 测试",
    targets: ["apps/gateway/test/board-audit-json.test.ts"], flow: [{ type: "step" as const, text: "expect(x.ok).toBe(true)" }] };
  // 板首主题节点(2026-11-04「白板看得懂」硬规则):code 板必须有一个 id 以 theme 开头(或 group=主题)
  // 的节点讲清「这流程干什么用 + 本次改哪一环」,否则类型门报「code 板缺板首主题节点」→ audit 的
  // type 桶非 0、ok=false。审计测试要断言「干净板 = 四桶全 0」,fixture 必须带上它(口径与
  // board-type-conformance.test.ts 的 theme-1 一致:kind=note 走侧栏、change=keep=现状描述)。
  // 注意 targets 用 panel.ts:本文件的「targets 真实性」用例已在 tmp 里造出该文件。
  const theme = { id: "theme-1", kind: "note", label: "主题:gateway 板审计收口流程", summary: "一句话:板 audit 从盘上载板到出回执/落遥测的收口链路,本次改的是 JSON 出口", change: "keep" as const, group: "00 主题", targets: ["apps/gateway/src/panel.ts"] };
  const allNodes = [theme, s, cur, ...nodes, d, e1, e2, reg];
  const firstId = (nodes[0] as { id?: string } | undefined)?.id;
  // 主题节点必须连着一条边:类型门对「无任何边的孤儿节点」另有硬规则(theme-1 挂到 start 上)。
  const edges = firstId ? [
    { from: "theme-1", to: "s", kind: "data" as const, label: "板首主题" },
    { from: "s", to: "cur", kind: "data" as const, label: "触发" },
    { from: "cur", to: firstId, kind: "data" as const, label: "现状→变更" },
    { from: firstId, to: "d", kind: "data" as const, label: "写回后判定" },
    { from: "d", to: "e-ok", kind: "data" as const, label: "是：链路可用" },
    { from: "d", to: "e-keep", kind: "data" as const, label: "否：链路不可用" },
    { from: firstId, to: "reg", kind: "verify" as const, label: "测试:断言" },
  ] : [];
  return {
    version: 1 as const, taskId, sessionId: "s1", title: `板 ${taskId}`, status: "draft" as const,
    rev: 0, boardType: "code" as const, scale: "M" as const,
    nodes: allNodes, edges, planned_files: [], updatedAt: 0, ...extra,
  };
}

describe("board_upsert audit format=json", () => {
  it("JSON 主路径:grand/boards/coverage 可解析;execute 仍是字符串", async () => {
    const r = tmp();
    saveBoard(r, board("t1", [p0("p1")]) as never);
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit", format: "json" }));
    expect(typeof out).toBe("string");
    const x = JSON.parse(out);
    expect(x.ok).toBe(true);
    expect(x.grand).toMatchObject({ total: 1, passed: 1, covered: 1, rate: 1 });
    expect(x.boards).toHaveLength(1);
    expect(x.boards[0]).toMatchObject({ taskId: "t1", boardType: "code", scale: "M" });
    expect(x.boards[0].coverage.passed).toBe(1);
    expect(x.boards[0].coverage.nodes[0].id).toBe("p1");
  });

  it("scope 分区:只统计本写者前缀节点", async () => {
    const r = tmp();
    saveBoard(r, board("t1", [p0("a1-p1"), p0("b1-p1")]) as never);
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit", format: "json", scope: "a1" }));
    const x = JSON.parse(out);
    expect(x.grand.total).toBe(1);
    expect(x.grand.passed).toBe(1);
    expect(x.boards[0].coverage.nodes.map((n: { id: string }) => n.id)).toEqual(["a1-p1"]);
  });

  it("all=true 跨板聚合:boards 列出每块板", async () => {
    const r = tmp();
    saveBoard(r, board("t1", [p0("p1")]) as never);
    saveBoard(r, board("t2", [p0("q1")]) as never);
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit", format: "json", all: true }));
    const x = JSON.parse(out);
    expect(x.ok).toBe(true);
    expect(x.boards.map((b: { taskId: string }) => b.taskId).sort()).toEqual(["t1", "t2"]);
    expect(x.grand.total).toBe(2);
    expect(x.grand.passed).toBe(2);
  });

  it("空态:无板时 ok:false + reason,不伪造覆盖率", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit", format: "json" }));
    const x = JSON.parse(out);
    expect(x.ok).toBe(false);
    expect(["no-boards", "no-matching-board"]).toContain(x.reason);
    expect(x.grand).toMatchObject({ total: 0, passed: 0, covered: 0 });
  });

  it("M107:coverage.stale 进 JSON(stale 证据不算通过,nodeId/cmd/file/reason 可消费)", async () => {
    const r = tmp();
    const p = join(r, "staleTarget.ts");
    writeFileSync(p, "export const v = 1;\n");
    const n = { ...p0("p1"), targets: ["staleTarget.ts"] };
    saveBoard(r, board("t1", [n]) as never);
    // 落账时捕获指纹(上面的 saveBoard 已写;证据是 fixture 自带的 → 首次落盘即捕获)
    const d0 = JSON.parse(JSON.stringify(n));
    expect(d0.evidence).toHaveLength(2);
    let x = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", format: "json" })));
    expect(x.grand.passed).toBe(1);
    expect(x.boards[0].coverage.stale).toEqual([]);
    writeFileSync(p, "export const v = 22;\n");
    x = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", format: "json" })));
    expect(x.grand.passed).toBe(0);
    expect(x.boards[0].coverage.stale).toHaveLength(2);
    expect(x.boards[0].coverage.stale[0]).toMatchObject({ nodeId: "p1", cmd: "cmd-p1", reason: "changed" });
    expect(x.boards[0].coverage.stale[0].file).toBe(p);
  });

  it("板型一致性门单列 typeIssues:test 板拿代码变更 fixture → 点名测试数据/decision/断言/verify", async () => {
    const r = tmp();
    // 该用例专测「test 板拿代码变更 fixture」:显式用非 flow 形(无 start/end/decision)的代码变更节点,
    // 让 test 板走「六段契约」分支,点名测试数据组/decision;其余用例用 board() 的合格 flow 形。
    saveBoard(r, board("t1", [p0("p1")], {
      boardType: "test",
      nodes: [
        { id: "p1", kind: "module", label: "改网关入口", summary: "代码变更", change: "modify" as const, group: "01 变更", targets: ["apps/gateway/src/main.ts"] },
        { id: "p2", kind: "module", label: "新增模块", summary: "代码变更", change: "add" as const, group: "01 变更", targets: ["apps/gateway/src/new.ts"] },
      ],
      edges: [{ from: "p1", to: "p2", kind: "call" as const, label: "调用" }],
    }) as never);
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", format: "json" }));
    const x = JSON.parse(out);
    expect(x.ok).toBe(false);
    expect(x.typeIssues.join("\n")).toContain("测试数据组");
    expect(x.boards[0].typeIssues.join("\n")).toContain("decision 节点");
    expect(x.contractIssues.join("\n")).not.toContain("测试数据组"); // 类型门与通用契约自检分开
  });

  it("文本兼容:不带 format 仍走 Markdown 回执,且含契约自检文本", async () => {
    const r = tmp();
    const bad = { ...p0("p1"), change: "modify" as const }; // modify 无 before → 文本自检应点名
    saveBoard(r, board("t1", [bad]) as never);
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit" }));
    expect(out).not.toMatch(/^\{/);
    expect(out).toContain("收口核对");
    expect(out).toContain("变更契约自检");
    expect(out).toContain("缺 before");
  });

  it("JSON 也携带契约自检/symbol 问题清单(不吞失败)", async () => {
    const r = tmp();
    const bad = { ...p0("p1"), change: "modify" as const };
    saveBoard(r, board("t1", [bad]) as never);
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit", format: "json" }));
    const x = JSON.parse(out);
    expect(x.contractIssues.join("\n")).toContain("缺 before");
    expect(Array.isArray(x.symbolIssues)).toBe(true);
    expect(x.boards[0].contractIssues.join("\n")).toContain("缺 before");
  });

  // ---- targets 真实性核对(2026-11-04):只报不判,ok 口径不变 ----
  it("targets 指向真实文件 → targetIssues 为空", async () => {
    const r = tmp();
    mkdirSync(join(r, "apps/gateway/src"), { recursive: true });
    mkdirSync(join(r, "apps/gateway/test"), { recursive: true });
    // board() 的固定节点也带 targets → 一并造真文件,才能断言「全绿=空数组」
    for (const p of ["apps/gateway/src/panel.ts", "apps/gateway/src/p1.ts", "apps/gateway/test/board-audit-json.test.ts"]) {
      writeFileSync(join(r, p), "export const real = 1;\n");
    }
    writeFileSync(join(r, "apps/gateway/src/__real__.ts"), "export const real = 1;\n");
    saveBoard(r, board("t1", [p0("p1")], { root: r }) as never);
    const x = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", format: "json" })));
    expect(x.targetIssues).toEqual([]);
  });

  it("targets 指向不存在的文件 → targetIssues 点名路径,但不影响 ok", async () => {
    const rTargets = tmp();
    // 基线:不带幻影 targets 的同一张板,ok 值应与下面一致
    saveBoard(rTargets, board("t0", [p0("p1")], { root: rTargets }) as never);
    const base = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "t0", rTargets, rTargets).execute({ action: "audit", format: "json" })));

    const r = tmp();
    const ghost = { ...p0("p1"), targets: ["apps/gateway/src/__ghost__.ts"] };
    saveBoard(r, board("t1", [ghost], { root: r }) as never);
    const x = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", format: "json" })));
    expect(x.targetIssues.length).toBeGreaterThanOrEqual(1);
    expect(x.targetIssues.join("\n")).toContain("apps/gateway/src/__ghost__.ts");
    expect(x.targetIssues.join("\n")).toContain("不存在");
    expect(x.ok).toBe(base.ok); // 只报不判
  });

  it("targets 越界(../../ 与绝对路径)→ outside,文案含「越界」", async () => {
    const r = tmp();
    const esc = { ...p0("p1"), targets: ["../../etc/passwd", "/etc/passwd"] };
    saveBoard(r, board("t1", [esc], { root: r }) as never);
    const x = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", format: "json" })));
    const joined = x.targetIssues.join("\n");
    expect(joined).toContain("越界");
    expect(x.targetIssues.filter((l: string) => l.includes("越界")).length).toBe(2);
  });

  // ---- ③ 规划质量字段(2026-11-06,B2 P2):面板结算直接读,不重放板 ----
  it("planQuality 五字段:boardType/节点数/内容节点数/P0 覆盖率/锚密度", async () => {
    const r = tmp();
    saveBoard(r, board("t1", [p0("p1")]) as never);
    const x = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", format: "json" })));
    // fixture:8 个非 ph- 节点(板首 theme-1 + start/cur/p1/decision/两个 end/reg)全部带 targets(=内容节点),
    // p1 是唯一 P0(accept 2 条已全过);theme-1 是 2026-11-04 板首主题硬规则要求的那一个。
    expect(x.planQuality).toEqual({
      boardType: "code", nodes: 8, contentNodes: 8,
      p0: { passed: 1, total: 1, rate: 1 }, anchorDensity: 1,
    });
  });

  // ---- ③ audit 落盘(2026-11-06,N1「9 条清单事后取不到」)----
  it("audit JSON 结果落盘 <storeRoot>/.genie/boards-audit/<taskId>-<ts>.json 且内容与回执同源", async () => {
    const r = tmp();
    saveBoard(r, board("t1", [p0("p1")]) as never);
    const x = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", format: "json" })));
    expect(typeof x.auditPath).toBe("string");
    expect(x.auditPath).toContain(join(r, ".genie/boards-audit"));
    expect(x.auditPath).toMatch(/t1-\d+\.json$/);
    // @ts-expect-error node:fs 动态引入
    const { readFileSync: rf, existsSync: ex } = await import("node:fs");
    expect(ex(x.auditPath)).toBe(true);
    const saved = JSON.parse(rf(x.auditPath, "utf-8"));
    expect(saved.taskId).toBe("t1");
    expect(saved.sessionId).toBe("s1");
    expect(saved.planQuality).toEqual(x.planQuality);
    expect(saved.grand).toEqual(x.grand);
    expect(saved.contractIssues).toEqual(x.contractIssues);
  });

  // ---- bq1(2026-11-05 板质量遥测):audit 旁路落 board.audit journal 事件 ----
  it("audit JSON 后 journal 出现 board.audit:issueCounts 四桶/snapshotFp/skeletonPrefilled/planQuality/auditPath/boards 摘要", async () => {
    const r = tmp();
    // targets 真实性核对只报不判:fixture 路径在 tmp 里不存在会把 target 桶记成 7。
    // 本用例要断言「全干净板 → 四桶全 0」,故按同文件 targets 真实性用例的口径先造真文件。
    mkdirSync(join(r, "apps/gateway/src"), { recursive: true });
    mkdirSync(join(r, "apps/gateway/test"), { recursive: true });
    for (const p of ["apps/gateway/src/panel.ts", "apps/gateway/src/p1.ts", "apps/gateway/test/board-audit-json.test.ts"]) {
      writeFileSync(join(r, p), "export const real = 1;\n");
    }
    saveBoard(r, board("t1", [p0("p1")]) as never);
    const j = new MemoryJournal();
    const x = JSON.parse(String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit", format: "json" })));
    const ev = j.readAll().find((e) => e.kind === "board.audit");
    expect(ev).toBeTruthy();
    expect(ev!.sessionId).toBe("s1");
    const p = ev!.payload as Record<string, unknown>;
    expect(p.taskId).toBe("t1");
    expect(p.boardType).toBe("code");
    expect(p.ok).toBe(x.ok);
    expect(p.grand).toEqual(x.grand);
    expect(p.planQuality).toEqual(x.planQuality);
    expect(p.issueCounts).toEqual({ contract: 0, type: 0, symbol: 0, target: 0 });
    expect(String(p.snapshotFp)).toMatch(/^[0-9a-f]{12}$/);
    expect(p.skeletonPrefilled).toBe(0);
    expect(String(p.auditPath)).toBe(x.auditPath);
    const boards = p.boards as Array<Record<string, unknown>>;
    expect(boards.length).toBe(1);
    expect(boards[0]!.taskId).toBe("t1");
    expect(boards[0]!.title).toBe("板 t1");
    expect(boards[0]!.boardType).toBe("code");
    expect(boards[0]!.coverage).toEqual({ passed: x.grand.passed, total: x.grand.total });
    expect("contractIssues" in boards[0]!).toBe(false); // 摘要裁剪:不带问题清单长字段
  });

  it("text 格式 audit 不落 board.audit 事件(遥测只挂 JSON 结构化路径)", async () => {
    const r = tmp();
    saveBoard(r, board("t1", [p0("p1")]) as never);
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit" }));
    expect(out).toContain("收口核对");
    expect(j.readAll().some((e) => e.kind === "board.audit")).toBe(false);
  });

  it("板含 sk- 前缀节点时 skeletonPrefilled 计数正确(只数 sk-,不数普通节点)", async () => {
    const r = tmp();
    const sk1 = { id: "sk-alpha", kind: "function", label: "骨架 alpha", summary: "现状", change: "keep" as const, group: "01 触发", targets: ["apps/gateway/src/panel.ts"] };
    const sk2 = { id: "sk-beta", kind: "function", label: "骨架 beta", summary: "现状", change: "keep" as const, group: "01 触发", targets: ["apps/gateway/src/panel.ts"] };
    saveBoard(r, board("t1", [p0("p1"), sk1, sk2]) as never);
    const j = new MemoryJournal();
    await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit", format: "json" });
    const ev = j.readAll().find((e) => e.kind === "board.audit");
    expect((ev!.payload as Record<string, unknown>).skeletonPrefilled).toBe(2);
  });

  it("同板两次 audit(节点未变)snapshotFp 相同;改 label 后变化", async () => {
    const r = tmp();
    saveBoard(r, board("t1", [p0("p1")]) as never);
    const j1 = new MemoryJournal();
    await boardUpsertTool(j1, "s1", "t1", r, r).execute({ action: "audit", format: "json" });
    const j2 = new MemoryJournal();
    await boardUpsertTool(j2, "s1", "t1", r, r).execute({ action: "audit", format: "json" });
    const fp1 = (j1.readAll().find((e) => e.kind === "board.audit")!.payload as Record<string, unknown>).snapshotFp;
    const fp2 = (j2.readAll().find((e) => e.kind === "board.audit")!.payload as Record<string, unknown>).snapshotFp;
    expect(fp1).toBe(fp2);
    // 改 label:同 id/边,仅 label 变 → 指纹必须变
    saveBoard(r, board("t1", [{ ...p0("p1"), label: "落目标(改名)" }]) as never);
    const j3 = new MemoryJournal();
    await boardUpsertTool(j3, "s1", "t1", r, r).execute({ action: "audit", format: "json" });
    const fp3 = (j3.readAll().find((e) => e.kind === "board.audit")!.payload as Record<string, unknown>).snapshotFp;
    expect(fp3).not.toBe(fp1);
  });
});
