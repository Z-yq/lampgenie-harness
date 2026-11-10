/**
 * 代码级落目标机制(step-137)单测:
 * ① 协议向后兼容(旧板无 phase/accept/evidence 照常读写);
 * ② 落板门(phase=P0 缺 accept → 拒收并点名);
 * ③ 收口门(status=done 且 P0 无证据 → 拒收);
 * ④ evidence 回填 + 覆盖率计算 + audit 只读核对;
 * ⑤ 用户旅程冒烟模板存在且含负面断言(禁 echo/llm=off);
 * ⑥ 主链路:AgentLoop 每 N 步注入 P0 再锚定提醒(ephemeral 不落 journal)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { BoardDocZ } from "@lampgenie/protocol";
import { AgentLoop, type Message, type Tool } from "@lampgenie/runtime/agent/loop";
import { saveBoard, loadBoard, captureEvidenceFiles } from "../src/board-store.js";
import { boardUpsertTool, boardReadTool } from "../src/agent-wiring.js";
import {
  validateP0Accepts, computeP0Coverage, renderP0Status, markDoneFromEvidence,
  SMOKE_TEMPLATE, PACKAGING_PREFLIGHT,
} from "../src/board-accept.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-goal-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const baseDoc = {
  version: 1 as const, taskId: "t1", sessionId: "s1", title: "落目标板", status: "draft" as const,
  rev: 0, nodes: [{ id: "n1", kind: "module" as const, label: "落盘", summary: "白板落盘", change: "add" as const }],
  edges: [], planned_files: [], updatedAt: 0,
};
const p0Node = {
  id: "p0a", kind: "tool" as const, label: "首启引导", summary: "无 API Key 首启有引导", change: "add" as const,
  phase: "P0" as const, targets: ["apps/desktop/src/main.ts"],
  accept: [
    { cmd: "pnpm vitest run test/boot.test.ts", expect: "3 passed" },
    { cmd: "启动桌面端确认出现引导页", expect: "首启显示引导" },
  ],
};

describe("① 协议向后兼容(step-137 新字段全可选)", () => {
  it("旧板(无 phase/targets/accept/evidence)解析通过且字段保持 undefined", () => {
    const p = BoardDocZ.safeParse(baseDoc);
    expect(p.success).toBe(true);
    if (p.success) {
      const n = p.data.nodes[0]!;
      expect(n.phase).toBeUndefined();
      expect(n.accept).toBeUndefined();
      expect(n.evidence).toBeUndefined();
      expect(n.targets).toBeUndefined();
    }
  });
  it("旧板读写回路零影响(store 层不提门)", () => {
    const r = tmp();
    const saved = saveBoard(r, { ...baseDoc });
    expect(saved.ok).toBe(true);
    const d = loadBoard(r, "s1", "t1");
    expect(d?.nodes[0]?.label).toBe("落盘");
    expect(computeP0Coverage(d!).total).toBe(0); // 无 P0 = 无门要过
    expect(computeP0Coverage(d!).rate).toBe(1);
  });
  it("新节点新字段原样往返(at 缺省补 0)", () => {
    const r = tmp();
    const ok = saveBoard(r, { ...baseDoc, nodes: [p0Node] });
    expect(ok.ok).toBe(true);
    const d = loadBoard(r, "s1", "t1")!;
    expect(d.nodes[0]!.phase).toBe("P0");
    expect(d.nodes[0]!.accept).toHaveLength(2);
    expect(d.nodes[0]!.evidence).toBeUndefined();
  });
  it("坏 phase 值被 schema 拒收(枚举之外)", () => {
    const bad = BoardDocZ.safeParse({ ...baseDoc, nodes: [{ ...baseDoc.nodes[0], phase: "P9" }] });
    expect(bad.success).toBe(false);
  });
});

describe("② 落板门:P0 缺 accept 拒收并点名", () => {
  it("validateP0Accepts:缺 accept / cmd 空串都点名", () => {
    const v = validateP0Accepts([
      { ...p0Node, id: "a", label: "缺验收", accept: undefined },
      { ...p0Node, id: "b", label: "空命令", accept: [{ cmd: "  " }] },
      { ...p0Node, id: "c", label: "合格" },
    ] as never);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toContain("a「缺验收」 缺 accept");
    expect(v.problems.join("\n")).toContain("b「空命令」 的 accept 第 1 条 cmd 为空字符串");
    expect(v.problems.some((p) => p.includes("c「合格」"))).toBe(false);
  });
  it("saveBoard 拒收 P0 缺 accept(旧板不受影响;P1 不强制)", () => {
    const r = tmp();
    const bad = saveBoard(r, { ...baseDoc, nodes: [{ ...p0Node, accept: undefined }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("P0 落目标缺可执行验收");
    // P1 节点不强制 accept
    const p1 = saveBoard(r, { ...baseDoc, nodes: [{ ...p0Node, phase: "P1", accept: undefined }] });
    expect(p1.ok).toBe(true);
  });
  // 2026-11-05 白板适用面收口:composition(作业思路板)是表达结构不是代码契约,不出命令级验收——
  // P0 accept 门跳过;覆盖率门/收口门不动(code 板照旧拒)。
  it("composition 板跳过 P0 accept 门;code 板照旧拒(门只对表达结构<>代码契约分流)", () => {
    const r1 = tmp();
    const comp = saveBoard(r1, { ...baseDoc, boardType: "composition", nodes: [{ ...p0Node, accept: undefined }] } as never);
    expect(comp.ok, "composition P0 缺 accept 不再拒收").toBe(true);
    const r2 = tmp();
    const code = saveBoard(r2, { ...baseDoc, boardType: "code", nodes: [{ ...p0Node, accept: undefined }] } as never);
    expect(code.ok, "code 板仍要求 P0 accept").toBe(false);
    // 收口门不动:composition 置 done 且 P0 无证据仍拒
    const r3 = tmp();
    const done = saveBoard(r3, { ...baseDoc, boardType: "composition", status: "done", nodes: [{ ...p0Node, accept: undefined }] } as never);
    expect(done.ok, "composition 收口门不受本次改动影响").toBe(false);
    if (!done.ok) expect(done.reason).toContain("P0 落目标证据未覆盖");
  });

  it("P0 accept 缺 type 仍收录(optional 不升格硬门),仅契约自检软提示", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({
      title: "缺 type 兼容板",
      nodes: [{ ...p0Node, accept: [{ cmd: "echo ok", expect: "ok" }] }],
    }));
    expect(out).toContain("设计白板已更新");
    expect(out).toContain("P0 accept 1 未标 type");
  });

  it("board_upsert:拒收回执点名节点并给补救路径,journal 不落 board.update", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    const out = String(await tool.execute({ title: "落目标板", nodes: [{ ...p0Node, accept: [] }] }));
    expect(out).toContain("P0 落目标缺可执行验收");
    expect(out).toContain("p0a「首启引导」");
    expect(out).toContain("action=evidence");
    expect(j.readAll().filter((e) => e.kind === "board.update")).toHaveLength(0);
  });
});

describe("③ 收口门:done 必须有 P0 证据", () => {
  it("status=done 且 P0 无证据 → 拒收,列出未覆盖节点", () => {
    const r = tmp();
    const r1 = saveBoard(r, { ...baseDoc, status: "done", nodes: [p0Node] });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.reason).toContain("P0 落目标证据未覆盖(0/1)");
      expect(r1.reason).toContain("p0a「首启引导」缺 2 条证据");
    }
  });
  it("证据全绿后 done 放行;ok=false 不算通过", () => {
    const r = tmp();
    const withPartial = {
      ...baseDoc, status: "done" as const,
      nodes: [{ ...p0Node, evidence: [{ cmd: p0Node.accept[0]!.cmd, ok: true, at: 1 }] }],
    };
    const p1 = saveBoard(r, withPartial);
    expect(p1.ok).toBe(false); // 第二条验收还没有证据
    const withAll = {
      ...baseDoc, status: "done" as const,
      nodes: [{ ...p0Node, evidence: [
        { cmd: p0Node.accept[0]!.cmd, ok: true, at: 1 },
        { cmd: p0Node.accept[1]!.cmd, ok: false, at: 1 },
      ] }],
    };
    const p2 = saveBoard(r, withAll);
    expect(p2.ok).toBe(false); // 有证据但有一条失败 → 不算通过
    const withPass = {
      ...baseDoc, status: "done" as const,
      nodes: [{ ...p0Node, evidence: [
        { cmd: p0Node.accept[0]!.cmd, ok: true, at: 1 },
        { cmd: p0Node.accept[1]!.cmd, ok: true, at: 1 },
      ] }],
    };
    expect(saveBoard(r, withPass).ok).toBe(true);
  });
  it("人工改板/系统回填 skipGates:不因验收门丢拖动结果", () => {
    const r = tmp();
    expect(saveBoard(r, { ...baseDoc, status: "done", nodes: [{ ...p0Node, accept: undefined }] }, { skipGates: true }).ok).toBe(true);
  });
});

describe("④ evidence 回填 + 覆盖率 + audit", () => {
  it("computeP0Coverage:covered/passed/rate 三态", () => {
    const doc = {
      nodes: [
        { ...p0Node, id: "a", evidence: [{ cmd: p0Node.accept[0]!.cmd, ok: true, at: 1 }] },        // 部分
        { ...p0Node, id: "b", evidence: [
          { cmd: p0Node.accept[0]!.cmd, ok: true, at: 1 }, { cmd: p0Node.accept[1]!.cmd, ok: true, at: 1 },
        ] },                                                                                          // 全绿
        { ...p0Node, id: "c" },                                                                       // 无证据
        { ...baseDoc.nodes[0] },                                                                      // 非 P0 不计
      ],
    } as never;
    const cov = computeP0Coverage(doc);
    expect(cov.total).toBe(3);
    expect(cov.covered).toBe(2);
    expect(cov.passed).toBe(1);
    expect(cov.rate).toBeCloseTo(1 / 3, 5);
    const a = cov.nodes.find((n) => n.id === "a")!;
    expect(a.covered).toBe(true);
    expect(a.passed).toBe(false);
    expect(a.missing).toEqual([p0Node.accept[1]!.cmd]);
  });
  it("markDoneFromEvidence:全 cmd ok=true 才置 done", () => {
    expect(markDoneFromEvidence({ ...p0Node, evidence: [{ cmd: p0Node.accept[0]!.cmd, ok: true, at: 1 }] } as never)).toBe(false);
    expect(markDoneFromEvidence({ ...p0Node, evidence: [
      { cmd: p0Node.accept[0]!.cmd, ok: true, at: 1 }, { cmd: p0Node.accept[1]!.cmd, ok: true, at: 1 },
    ] } as never)).toBe(true);
  });
  it("board_upsert action=evidence:服务端补 at、同 cmd 覆盖、回执带覆盖率、节点自动 done", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    await tool.execute({ title: "落目标板", nodes: [p0Node] });
    const out1 = String(await tool.execute({
      action: "evidence", nodeId: "p0a",
      evidence: [{ cmd: p0Node.accept[0]!.cmd, ok: false, output: "1 failed", at: 999 }],
    }));
    expect(out1).toContain("已回填 p0a 的 1 条证据(0 通过)");
    expect(out1).toContain("P0 落目标覆盖率 0/1(0%)");
    const d1 = loadBoard(r, "s1", "t1")!;
    expect(d1.nodes[0]!.evidence?.[0]?.at).not.toBe(999); // 客户端 at 被服务端覆盖
    expect(d1.nodes[0]!.done).toBe(false);
    // 同 cmd 重跑成功 → 覆盖旧证据(不累积)
    await tool.execute({ action: "evidence", nodeId: "p0a", evidence: [{ cmd: p0Node.accept[0]!.cmd, ok: true }] });
    await tool.execute({ action: "evidence", nodeId: "p0a", evidence: [{ cmd: p0Node.accept[1]!.cmd, ok: true }] });
    const d2 = loadBoard(r, "s1", "t1")!;
    expect(d2.nodes[0]!.evidence).toHaveLength(2);
    expect(d2.nodes[0]!.done).toBe(true);
    const cov = computeP0Coverage(d2);
    expect(cov.passed).toBe(1);
    // 回填后 done 门放行
    const done = await tool.execute({ title: "落目标板", nodes: d2.nodes, status: "done" });
    expect(String(done)).toContain("P0 落目标 1/1 已通过验收");
  });
  it("planner 独立板:主 agent 用 targetTaskId 回填 evidence/audit,全绿时置 done", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const planner = boardUpsertTool(j, "s1", "t1", r, r, "cmp", { partition: true });
    const main = boardUpsertTool(j, "s1", "t1", r, r);
    // planner 落独立板(scope 自动给节点 id 加 cmp- 前缀)
    expect(String(await planner.execute({ title: "planner 板", nodes: [p0Node] }))).toContain("设计白板已更新");
    const d0 = loadBoard(r, "s1", "t1-cmp")!;
    expect(d0).toBeTruthy();
    expect(loadBoard(r, "s1", "t1")).toBeNull(); // 主任务板不存在=证据没有被复制到另一块板
    const nid = d0.nodes[0]!.id;
    expect(nid.startsWith("cmp-")).toBe(true);
    // 主 agent 审计 planner 板
    const a0 = String(await main.execute({ action: "audit", targetTaskId: "t1-cmp" }));
    expect(a0).toContain("P0 覆盖率合计 0/1");
    // 第一条证据 + 试图 done:证据落盘但 status 不得置 done
    const m1 = String(await main.execute({
      action: "evidence", targetTaskId: "t1-cmp", nodeId: nid,
      evidence: [{ cmd: p0Node.accept[0]!.cmd, ok: true }], status: "done",
    }));
    expect(m1).toContain("已回填");
    expect(m1).toContain("P0 未全绿(0/1)");
    expect(loadBoard(r, "s1", "t1-cmp")!.status).toBe("draft");
    // 第二条证据 + done:全绿后置 done
    const m2 = String(await main.execute({
      action: "evidence", targetTaskId: "t1-cmp", nodeId: nid,
      evidence: [{ cmd: p0Node.accept[1]!.cmd, ok: true }], status: "done",
    }));
    expect(m2).toContain("已回填");
    expect(m2).not.toContain("P0 未全绿");
    const d1 = loadBoard(r, "s1", "t1-cmp")!;
    expect(d1.status).toBe("done");
    expect(d1.nodes[0]!.evidence).toHaveLength(2);
    expect(d1.nodes[0]!.done).toBe(true);
    const a1 = String(await main.execute({ action: "audit", targetTaskId: "t1-cmp" }));
    expect(a1).toContain("1/1");
  });
  it("targetTaskId 可指向本会话上一任务的 planner 板(新一轮任务继续验收)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const planner0 = boardUpsertTool(j, "s1", "t0", r, r, "cmp", { partition: true });
    await planner0.execute({ title: "上一任务 planner 板", nodes: [p0Node] });
    const main1 = boardUpsertTool(j, "s1", "t1", r, r);
    const d0 = loadBoard(r, "s1", "t0-cmp")!;
    const nid = d0.nodes[0]!.id;
    const out = String(await main1.execute({
      action: "evidence", targetTaskId: "t0-cmp", nodeId: nid,
      evidence: [{ cmd: p0Node.accept[0]!.cmd, ok: true }],
    }));
    expect(out).toContain("已回填");
    expect(out).toContain("目标板:t0-cmp");
    expect(loadBoard(r, "s1", "t0-cmp")!.nodes[0]!.evidence).toHaveLength(1);
    expect(loadBoard(r, "s1", "t1")).toBeNull(); // 不复制到当前任务板
  });
  it("targetTaskId 越界:不能写/审别的任务的板", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const main = boardUpsertTool(j, "s1", "t1", r, r);
    const ev = String(await main.execute({
      action: "evidence", targetTaskId: "other-9", nodeId: "x", evidence: [{ cmd: "x", ok: true }],
    }));
    expect(ev).toContain("越界");
    const au = String(await main.execute({ action: "audit", targetTaskId: "other-9" }));
    expect(au).toContain("越界");
    expect(loadBoard(r, "s1", "other-9")).toBeNull();
  });
  it("action=evidence 错误面:缺 nodeId / 空 evidence / 节点不存在 都 fail-soft 且不写盘", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    await tool.execute({ title: "落目标板", nodes: [p0Node] });
    const rev0 = loadBoard(r, "s1", "t1")!.rev;
    expect(String(await tool.execute({ action: "evidence" }))).toContain("需要 nodeId");
    expect(String(await tool.execute({ action: "evidence", nodeId: "p0a", evidence: [] }))).toContain("非空 evidence");
    expect(String(await tool.execute({ action: "evidence", nodeId: "nope", evidence: [{ cmd: "x", ok: true }] }))).toContain("板上没有节点 nope");
    expect(loadBoard(r, "s1", "t1")!.rev).toBe(rev0);
  });
  it("board_upsert action=audit:只读返回覆盖率与未覆盖项,不写盘", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    await tool.execute({ title: "落目标板", nodes: [p0Node] });
    const rev0 = loadBoard(r, "s1", "t1")!.rev;
    const out = String(await tool.execute({ action: "audit" }));
    expect(out).toContain("收口核对:P0 覆盖率合计 0/1(0%)");
    expect(out).toContain("禁止宣称任务完成");
    expect(out).toContain("p0a「首启引导」");
    expect(out).toContain("待跑:");
    expect(loadBoard(r, "s1", "t1")!.rev).toBe(rev0); // 只读
    // all=true 扫会话全部板
    const all = String(await tool.execute({ action: "audit", all: true }));
    expect(all).toContain("收口核对");
  });
  it("board_read:显示 P0 档位、验收条数与覆盖率行", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    await boardUpsertTool(j, "s1", "t1", r, r).execute({ title: "落目标板", nodes: [p0Node] });
    const txt = String(await boardReadTool(j, "s1", r).execute({}));
    expect(txt).toContain("P0 落目标 0/1 已通过验收");
    expect(txt).toContain("· P0(无证据)");
    expect(txt).toContain("验收 2 条:");
  });
  it("renderP0Status:全绿时给「可进入收尾汇报」", () => {
    const txt = renderP0Status({
      title: "t", status: "done",
      nodes: [{ ...p0Node, evidence: [
        { cmd: p0Node.accept[0]!.cmd, ok: true, at: 1 }, { cmd: p0Node.accept[1]!.cmd, ok: true, at: 1 },
      ] }] as never,
    });
    expect(txt).toContain("1/1(100%)");
    expect(txt).toContain("全部 P0 节点已通过验收");
  });
});

/* ---- M107:证据指纹与过期判定(2026-11-06) ---- */
describe("④b 证据指纹:落账捕获 / 读时 stale / 重提交刷新 / 旧证据兼容", () => {
  const oneAccept = [{ cmd: "npx vitest run test/x.test.ts", expect: "1 passed", type: "command" as const }];
  const evDoc = (extra: Record<string, unknown> = {}) => ({
    ...baseDoc,
    nodes: [{
      id: "p0a", kind: "tool" as const, label: "落目标", summary: "证据绑指纹", change: "add" as const,
      phase: "P0" as const, targets: ["fileA.ts"], accept: oneAccept,
      evidence: [{ cmd: oneAccept[0]!.cmd, ok: true, at: 1 }],
    }],
    ...extra,
  });
  const covOf = (r: string) => computeP0Coverage(loadBoard(r, "s1", "t1")!);

  it("落账捕获指纹(sha256/mtimeMs/size + capturedAt),覆盖率通过", () => {
    const r = tmp();
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    expect(saveBoard(r, evDoc()).ok).toBe(true);
    const ev = loadBoard(r, "s1", "t1")!.nodes[0]!.evidence![0]!;
    expect(ev.files).toHaveLength(1);
    expect(ev.files![0]!.path).toBe(join(r, "fileA.ts"));
    expect(ev.files![0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.files![0]!.size).toBe(20);
    expect(typeof ev.capturedAt).toBe("number");
    expect(covOf(r).passed).toBe(1);
    expect(covOf(r).stale).toEqual([]);
  });

  it("改内容后 stale:不算覆盖/通过,audit 文本点名「证据过期」", () => {
    const r = tmp();
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    saveBoard(r, evDoc());
    writeFileSync(join(r, "fileA.ts"), "export const a = 22;\n"); // 内容与 size 都变
    const cov = covOf(r);
    expect(cov.passed).toBe(0);
    expect(cov.covered).toBe(0);
    expect(cov.stale).toHaveLength(1);
    expect(cov.stale[0]).toMatchObject({ nodeId: "p0a", reason: "changed" });
    expect(cov.nodes[0]!.missing).toEqual([oneAccept[0]!.cmd]);
    const txt = renderP0Status(loadBoard(r, "s1", "t1")!);
    expect(txt).toContain(`证据过期:${oneAccept[0]!.cmd} ← ${join(r, "fileA.ts")} 在证据后变更`);
  });

  it("board_read 摘要点出过期证据(与 audit 同源);无 stale 时不多出该行", async () => {
    const r = tmp();
    const p = join(r, "fileA.ts");
    writeFileSync(p, "export const a = 1;\n");
    saveBoard(r, evDoc());
    // 每次新建 tool 实例:board_read 自带同 rev 去重,复用实例第二次会拿到存根而非全文。
    const fresh = String(await boardReadTool(new MemoryJournal(), "s1", r).execute({}));
    expect(fresh).toContain("P0 落目标 1/1");
    expect(fresh).not.toContain("证据过期");
    writeFileSync(p, "export const a = 22;\n");
    const txt = String(await boardReadTool(new MemoryJournal(), "s1", r).execute({}));
    expect(txt).toContain("⚠ 证据过期 1 条");
    expect(txt).toContain(`证据过期:${oneAccept[0]!.cmd} ← ${p} 在证据后变更`);
  });

  it("size 未变但内容变(sha256 兜底):mtime 也被还原同样识别为过期", () => {
    const r = tmp();
    const p = join(r, "fileA.ts");
    writeFileSync(p, "AAAA");
    saveBoard(r, evDoc());
    const before = statSync(p);
    writeFileSync(p, "BBBB");
    utimesSync(p, before.atime, before.mtime); // mtime 还原到捕获时刻
    const st = statSync(p);
    expect(st.size).toBe(before.size);
    const cov = covOf(r);
    expect(cov.stale).toHaveLength(1);
    expect(cov.stale[0]!.reason).toBe("changed");
  });

  it("目标文件被删除 → 过期(reason=missing)", () => {
    const r = tmp();
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    saveBoard(r, evDoc());
    rmSync(join(r, "fileA.ts"));
    const cov = covOf(r);
    expect(cov.passed).toBe(0);
    expect(cov.stale[0]!.reason).toBe("missing");
    expect(renderP0Status(loadBoard(r, "s1", "t1")!)).toContain("在证据后被删除");
  });

  it("同 cmd 重新提交 → 重新捕获指纹并恢复 passed;其它 cmd 旧指纹原样保留", () => {
    const r = tmp();
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    saveBoard(r, evDoc());
    writeFileSync(join(r, "fileA.ts"), "export const a = 22;\n");
    expect(covOf(r).passed).toBe(0);
    // 重跑后回填:at 由服务端刷新(=新条目),指纹重新采集
    const doc = loadBoard(r, "s1", "t1")!;
    const resub = {
      ...evDoc(),
      nodes: [{ ...doc.nodes[0]!, evidence: [{ cmd: oneAccept[0]!.cmd, ok: true, at: 2 }] }],
    };
    expect(saveBoard(r, resub).ok).toBe(true);
    const cov = covOf(r);
    expect(cov.passed).toBe(1);
    expect(cov.stale).toEqual([]);
    const fresh = loadBoard(r, "s1", "t1")!.nodes[0]!.evidence![0]!;
    expect(fresh.capturedAt! >= 1).toBe(true);
    expect(fresh.files![0]!.size).toBe(21);
  });

  it("未重新提交(整板重存、证据逐字未变)不刷新指纹,过期状态保持", () => {
    const r = tmp();
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    saveBoard(r, evDoc());
    writeFileSync(join(r, "fileA.ts"), "export const a = 22;\n");
    const before = loadBoard(r, "s1", "t1")!.nodes[0]!.evidence![0]!;
    // 只改标题再存:证据条目逐字相同 → 保留原指纹(含旧 size),仍判过期
    expect(saveBoard(r, { ...loadBoard(r, "s1", "t1")!, title: "换个标题" }).ok).toBe(true);
    const after = loadBoard(r, "s1", "t1")!.nodes[0]!.evidence![0]!;
    expect(after.files![0]!.size).toBe(before.files![0]!.size);
    expect(after.capturedAt).toBe(before.capturedAt);
    expect(covOf(r).passed).toBe(0);
  });

  it("旧 evidence 无 files 字段 → 永远不 stale(兼容),且不被补字段", () => {
    const r = tmp();
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    const doc = evDoc();
    // 手工写盘(绕过指纹捕获):模拟旧板
    mkdirSync(join(r, ".genie", "boards", "s1"), { recursive: true });
    writeFileSync(join(r, ".genie", "boards", "s1", "t1.json"), JSON.stringify({ ...doc, updatedAt: 0 }));
    writeFileSync(join(r, "fileA.ts"), "export const a = 22;\n");
    const cov = covOf(r);
    expect(cov.passed).toBe(1);
    expect(cov.stale).toEqual([]);
    expect(computeP0Coverage({ nodes: (doc as never as { nodes: never[] }).nodes }).stale).toEqual([]);
  });

  it("文件不存在 / 目录 / glob / 符号链接 → 不记指纹且不崩(空 files 不写字段)", () => {
    const r = tmp();
    mkdirSync(join(r, "dirA"));
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    symlinkSync(join(r, "fileA.ts"), join(r, "linkA.ts"));
    const doc = {
      ...baseDoc,
      nodes: [{
        ...evDoc().nodes[0]!,
        targets: ["missing.ts", "dirA", "src/**/*.ts", "linkA.ts"],
      }],
    };
    expect(saveBoard(r, doc as never).ok).toBe(true);
    const ev = loadBoard(r, "s1", "t1")!.nodes[0]!.evidence![0]!;
    expect(ev.files).toBeUndefined(); // 全部不可 stat → 不编造指纹
    expect(covOf(r).passed).toBe(1); // 无 files = 不判 stale
    // 目录用带尾斜杠形态同样跳过
    expect(captureEvidenceFiles(r, ["dirA/"])).toEqual([]);
    expect(captureEvidenceFiles(r, ["../outside.ts"])).toEqual([]); // 越界不记
    // "file#symbol" 指向该文件本身 → 解析到文件记指纹
    expect(captureEvidenceFiles(r, ["fileA.ts#sym"]).map((f) => f.path)).toEqual([join(r, "fileA.ts")]);
  });

  it("置 done 的收口门按 stale=未通过拒绝,reason 点名证据过期", () => {
    const r = tmp();
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    saveBoard(r, evDoc());
    writeFileSync(join(r, "fileA.ts"), "export const a = 22;\n");
    const bad = saveBoard(r, { ...loadBoard(r, "s1", "t1")!, status: "done" } as never);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toContain("P0 落目标证据未覆盖(0/1)");
      expect(bad.reason).toContain("证据过期");
      expect(bad.reason).toContain("fileA.ts");
    }
    // 重跑后回填 → 收口门放行
    const doc = loadBoard(r, "s1", "t1")!;
    const ok = saveBoard(r, {
      ...doc, status: "done",
      nodes: [{ ...doc.nodes[0]!, evidence: [{ cmd: oneAccept[0]!.cmd, ok: true, at: 9 }] }],
    } as never);
    expect(ok.ok).toBe(true);
  });

  it("board_upsert action=evidence 端到端:改文件后 audit 报过期,重填后恢复", async () => {
    const r = tmp();
    writeFileSync(join(r, "fileA.ts"), "export const a = 1;\n");
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    await tool.execute({ title: "落目标板", nodes: [{ ...evDoc().nodes[0]!, evidence: undefined }] });
    const back = String(await tool.execute({
      action: "evidence", nodeId: "p0a", evidence: [{ cmd: oneAccept[0]!.cmd, ok: true, output: "1 passed" }],
    }));
    expect(back).toContain("P0 落目标覆盖率 1/1");
    expect(loadBoard(r, "s1", "t1")!.nodes[0]!.evidence![0]!.files).toHaveLength(1);
    writeFileSync(join(r, "fileA.ts"), "export const a = 22;\n");
    const au = String(await tool.execute({ action: "audit" }));
    expect(au).toContain("证据过期");
    expect(au).toContain("fileA.ts");
    expect(au).toContain("收口核对:P0 覆盖率合计 0/1(0%)");
    const back2 = String(await tool.execute({
      action: "evidence", nodeId: "p0a", evidence: [{ cmd: oneAccept[0]!.cmd, ok: true, output: "1 passed" }],
    }));
    expect(back2).toContain("P0 落目标覆盖率 1/1");
    expect(String(await tool.execute({ action: "audit" }))).not.toContain("证据过期");
  });
});

describe("⑤ 用户旅程冒烟模板(P0-4)", () => {
  it("冒烟模板存在:phase=P0、四条验收、含负面断言(禁 echo 回显/llm=off)", () => {
    expect(SMOKE_TEMPLATE.phase).toBe("P0");
    expect(SMOKE_TEMPLATE.accept).toHaveLength(4);
    const neg = SMOKE_TEMPLATE.accept.find((a) => a.cmd.includes("负面断言"))!;
    expect(neg).toBeTruthy();
    expect(neg.cmd).toContain("echo");
    expect(neg.cmd).toContain("llm=off");
    // 模板自身能过落板门(否则模板是空话)
    expect(validateP0Accepts([SMOKE_TEMPLATE] as never).ok).toBe(true);
  });
  it("环境预检模板存在:P1、提到 wine32/NSIS 与替代交付形态", () => {
    expect(PACKAGING_PREFLIGHT.phase).toBe("P1");
    const cmd = PACKAGING_PREFLIGHT.accept[0]!.cmd;
    expect(cmd).toContain("wine32");
    expect(cmd).toContain("NSIS");
    expect(PACKAGING_PREFLIGHT.accept[0]!.expect).toContain("win-unpacked");
  });
  it("冒烟节点可直接落板(模板即契约)", () => {
    const r = tmp();
    const ok = saveBoard(r, { ...baseDoc, nodes: [SMOKE_TEMPLATE, p0Node] });
    expect(ok.ok).toBe(true);
    expect(computeP0Coverage(loadBoard(r, "s1", "t1")!).total).toBe(2);
  });
  it("board_upsert template=smoke:模板节点并进本板;已有同 id 不重复加", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    const out = String(await tool.execute({ title: "产品冒烟板", nodes: [baseDoc.nodes[0]], template: "smoke" }));
    expect(out).toContain("设计白板已更新");
    const d = loadBoard(r, "s1", "t1")!;
    expect(d.nodes.map((n) => n.id)).toEqual(["n1", "smoke"]);
    const smoke = d.nodes.find((n) => n.id === "smoke")!;
    expect(smoke.phase).toBe("P0");
    expect(smoke.accept?.some((a) => a.cmd.includes("llm=off"))).toBe(true);
    // 再落一次(板上已有 smoke)→ 不重复
    await tool.execute({ title: "产品冒烟板", nodes: d.nodes, template: "smoke" });
    expect(loadBoard(r, "s1", "t1")!.nodes.filter((n) => n.id === "smoke")).toHaveLength(1);
    // preflight(P1)也可并
    await tool.execute({ title: "产品冒烟板", nodes: d.nodes, template: "preflight" });
    const d2 = loadBoard(r, "s1", "t1")!;
    expect(d2.nodes.find((n) => n.id === "preflight")?.phase).toBe("P1");
    expect(computeP0Coverage(d2).total).toBe(1); // 只有 smoke 算 P0
  });
});

describe("⑥ 主链路:P0 再锚定提醒(step-137 P1,ephemeral)", () => {
  it("每 N 步注入 P0 清单;不落 journal;boardReminder 返回 null 时不注入", async () => {
    const seen: Message[][] = [];
    let called = 0;
    let i = 0;
    const llm = {
      async chat(messages: Message[]) {
        seen.push(messages.map((m) => ({ ...m })));
        i++;
        if (i <= 2) return { content: "", toolCalls: [{ id: "c" + i, name: "noop", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const noop: Tool = {
      name: "noop", description: "stub", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { return "ok"; },
    };
    const journal = new MemoryJournal();
    await new AgentLoop({
      journal, sessionId: "s-goal", system: "s", llm, tools: [noop], maxSteps: 4,
      boardReminderSteps: 1,
      boardReminder: () => { called++; return "<system-reminder>P0 落目标尚未全部通过验收(0/1):p0a「首启引导」</system-reminder>"; },
    }).runTurn("做");
    expect(called).toBeGreaterThan(0);
    // step 0 不注入(step>0 才注入)
    expect(seen[0]!.some((m) => m.content.includes("P0 落目标尚未全部通过验收"))).toBe(false);
    expect(seen[1]!.some((m) => m.content.includes("p0a「首启引导」"))).toBe(true);
    // ephemeral:journal 里没有这段文本
    expect(journal.readAll().some((e) => JSON.stringify(e.payload ?? {}).includes("p0a「首启引导」"))).toBe(false);
  });
  it("boardReminder 抛异常不打断主链;返回 null 不注入", async () => {
    const seen: Message[][] = [];
    let i = 0;
    const llm = {
      async chat(messages: Message[]) {
        seen.push(messages.map((m) => ({ ...m })));
        i++;
        if (i === 1) return { content: "", toolCalls: [{ id: "c1", name: "noop", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const noop: Tool = {
      name: "noop", description: "stub", parameters: { type: "object", properties: {} },
      isConcurrencySafe: () => true,
      async execute() { return "ok"; },
    };
    const journal = new MemoryJournal();
    let n = 0;
    await new AgentLoop({
      journal, sessionId: "s-goal2", system: "s", llm, tools: [noop], maxSteps: 2,
      boardReminderSteps: 1, boardReminder: () => { n++; throw new Error("boom"); },
    }).runTurn("做");
    expect(n).toBeGreaterThan(0);
    expect(seen[1]).toBeTruthy(); // 第二轮照常组装(未被异常打断)
    const nullReminder = new AgentLoop({
      journal: new MemoryJournal(), sessionId: "s-goal3", system: "s",
      llm: { async chat() { return { content: "done" }; } }, tools: [], maxSteps: 2,
      boardReminderSteps: 1, boardReminder: () => null,
    });
    await nullReminder.runTurn("做"); // 不抛
  });
});