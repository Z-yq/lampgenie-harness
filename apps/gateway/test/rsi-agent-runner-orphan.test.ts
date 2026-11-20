/**
 * 孤儿判据矩阵:run.gatewayPid × taskState 在册 × result 落盘 三维。
 * 判据唯一权威 = orphanVerdict(pid 真变化且不在册才 orphaned;同 pid 查不到=missing,
 * 按 journal 证据收尾;result 已落盘的 run 不得标 failed——1597 pathology 序缺陷)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotateRsiSections,
  ORPHAN_GRACE_MS,
  orphanVerdict,
  startMechanismRun,
} from "../src/rsi-agent-runner.js";
import { getRun, resultFilePath, runFilePath } from "../src/rsi-mechanism-store.js";
import type { RsiStatusSection } from "../src/rsi-status.js";

function section(id: string, title: string): RsiStatusSection {
  return { id, title, ok: true, metrics: [{ label: "候选", value: 1 }], warnings: [] };
}

describe("orphanVerdict(纯函数矩阵)", () => {
  const base = { status: "running", taskId: "t1", startedAt: 1_000, gatewayPid: 111 };
  const late = 1_000 + ORPHAN_GRACE_MS + 1;

  it("pid 变 + 不在册 + 超宽限 → orphaned(带 from/to pid)", () => {
    expect(orphanVerdict(base, undefined, 222, late)).toEqual({ kind: "orphaned", fromPid: 111, toPid: 222 });
  });
  it("pid 变 + 不在册 + 宽限内 → pending", () => {
    expect(orphanVerdict(base, undefined, 222, 1_000 + 1000)).toMatchObject({ kind: "pending" });
  });
  it("pid 同 + 不在册 → missing(session-worker 持有,不判孤儿)", () => {
    expect(orphanVerdict(base, undefined, 111, late)).toEqual({ kind: "missing" });
  });
  it("旧记录无 gatewayPid + 不在册 → missing(1597 误杀口径修复)", () => {
    const legacy = { status: "running", taskId: "t1", startedAt: 1_000 };
    expect(orphanVerdict(legacy, undefined, 999_999, late)).toEqual({ kind: "missing" });
  });
  it("任务在册或 run 已终态 → alive", () => {
    expect(orphanVerdict(base, "running", 222, late)).toEqual({ kind: "alive" });
    expect(orphanVerdict({ ...base, status: "done" }, undefined, 222, late)).toEqual({ kind: "alive" });
  });
});

describe("settleRunRecord ①b(journal 证据收尾)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rsi-orphan-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("同 pid 查不到 + result 已落盘 → 按 done 结算不标 failed(修 pathology 序缺陷)", async () => {
    const r = await startMechanismRun({ root, submit: () => ({ id: "t-path" }) }, "pathology");
    const file = runFilePath(root, "pathology", r.runId!);
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.startedAt = Date.now() - (ORPHAN_GRACE_MS + 60_000); // 远超宽限
 // gatewayPid 不写 = 旧记录口径(视同当前 pid,网关未重启)
    await writeFile(file, JSON.stringify(rec), "utf8");
 // result.json 已由 agent 写出(1597 pathology 实况)
    await writeFile(
      resultFilePath(root, "pathology", r.runId!),
      JSON.stringify({ items: [{ id: "p1", title: "病理一", status: "bad", summary: "复发形态", detail: "证据", evidence: ["sessionId:s1"] }] }),
      "utf8",
    );
    const res = await annotateRsiSections({
      root,
      sections: [section("pathology", "病理形态")],
      taskState: () => undefined,
    });
    expect(res.finalized).toBe(1);
    const after = await getRun(root, "pathology", r.runId!);
    expect(after?.status).toBe("done"); // 关键断言:result 在 → done
    expect(after?.error).toBeUndefined();
  });

  it("同 pid 查不到 + journal 任务已 done → 收 done(terminal 事件证据)", async () => {
    const r = await startMechanismRun({ root, submit: () => ({ id: "t-live" }) }, "cost");
    const file = runFilePath(root, "cost", r.runId!);
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.startedAt = Date.now() - (ORPHAN_GRACE_MS + 60_000);
    await writeFile(file, JSON.stringify(rec), "utf8");
    const events = [
      { kind: "task.start", payload: { id: "t-live" } },
      { kind: "message.agent", payload: { text: "分析完成" } },
      { kind: "task.done", payload: { id: "t-live" } },
    ];
    const res = await annotateRsiSections({
      root,
      sections: [section("cost", "成本与熔断")],
      taskState: () => undefined,
      readSession: () => events,
    });
    expect(res.finalized).toBe(1);
    expect((await getRun(root, "cost", r.runId!))?.status).toBe("done");
  });

  it("同 pid 查不到 + 无任何证据 → 前 2 轮保持 running,第 3 轮 failed(no progress evidence)", async () => {
    const r = await startMechanismRun({ root, submit: () => ({ id: "t-void" }) }, "evidence");
    const file = runFilePath(root, "evidence", r.runId!);
    const rec = JSON.parse(await readFile(file, "utf8"));
    rec.startedAt = Date.now() - (ORPHAN_GRACE_MS + 60_000);
    await writeFile(file, JSON.stringify(rec), "utf8");
    const settle = () =>
      annotateRsiSections({ root, sections: [section("evidence", "证据图")], taskState: () => undefined });
    expect((await settle()).finalized).toBe(0);
    expect((await settle()).finalized).toBe(0);
    expect((await getRun(root, "evidence", r.runId!))?.status).toBe("running"); // 不再按宽限误杀
    expect((await settle()).finalized).toBe(1);
    const after = await getRun(root, "evidence", r.runId!);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("no progress evidence");
  });
});
