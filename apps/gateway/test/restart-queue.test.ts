import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeRestartEntry,
  detectRestartNeeded,
  ensureRestartQueue,
  listPendingRestarts,
  listRestartQueue,
  normalizeStatusPoint,
  queueRestart,
  restartQueueExists,
  restartQueuePaths,
  settleRestartQueue,
} from "../src/restart-queue-store.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rq-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("restart-queue-store(待重启队列)", () => {
  it("入队 → pending 可查", () => {
    const r = queueRestart(root, { title: "侧栏 done 点转绿", reason: "需重启网关才生效", taskId: "t1", sessionId: "s1", at: 1000 });
    expect(r.ok).toBe(true);
    expect(r.duplicate).toBeUndefined();
    const list = listRestartQueue(root);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("pending");
    expect(list[0]?.taskId).toBe("t1");
    expect(list[0]?.sessionId).toBe("s1");
    expect(list[0]?.reason).toContain("重启");
    expect(list[0]?.at).toBe(1000);
  });

  it("同状态点重复入队被抑制(标题归一化后一致)", () => {
    const a = queueRestart(root, { title: "修复 侧栏 done 点转绿", at: 1000 });
    const b = queueRestart(root, { title: "[RSI] 修复 侧栏 done 点 转绿 ws-mwka12", at: 2000 });
    expect(a.ok && b.ok).toBe(true);
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
    expect(listPendingRestarts(root)).toHaveLength(1);
  });

  it("重启钩子:settle 全部 pending 并回写 pid/时间;二次 settle 零写入", () => {
    queueRestart(root, { title: "A 修复", at: 1000 });
    queueRestart(root, { title: "B 修复", at: 1001 });
    const settled = settleRestartQueue(root, { pid: 4242, at: 5000 });
    expect(settled).toHaveLength(2);
    const after = listRestartQueue(root);
    expect(after.every((e) => e.status === "settled")).toBe(true);
    expect(after[0]?.settledPid).toBe(4242);
    expect(after[0]?.settledAt).toBe(5000);
    const beforeSize = readFileSync(restartQueuePaths(root).file, "utf8").length;
    expect(settleRestartQueue(root, { pid: 4242, at: 6000 })).toEqual([]);
    expect(readFileSync(restartQueuePaths(root).file, "utf8").length).toBe(beforeSize);
  });

  it("close 后不再 pending;重复 close 幂等", () => {
    const r = queueRestart(root, { title: "C 修复", at: 1000 });
    expect(r.id).toBeDefined();
    expect(closeRestartEntry(root, String(r.id), { by: "super", at: 3000 }).ok).toBe(true);
    expect(listPendingRestarts(root)).toHaveLength(0);
    expect(listRestartQueue(root)[0]?.status).toBe("closed");
    expect(listRestartQueue(root)[0]?.closedBy).toBe("super");
    expect(closeRestartEntry(root, String(r.id), { by: "super" }).ok).toBe(true);
  });

  it("坏行跳过不 throw", () => {
    ensureRestartQueue(root);
    writeFileSync(
      restartQueuePaths(root).file,
      "{bad json\n" + JSON.stringify({ v: 1, type: "add", id: "rq_x", at: 1, title: "X" }) + "\n",
      "utf8",
    );
    const list = listRestartQueue(root);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("rq_x");
  });

  it("detectRestartNeeded 认常见措辞且不误伤", () => {
    expect(detectRestartNeeded("修复已完成,需重启网关才生效、未 commit")).toBe(true);
    expect(detectRestartNeeded("待重启:新增 WS 通道")).toBe(true);
    expect(detectRestartNeeded("restart required after config change")).toBe(true);
    expect(detectRestartNeeded("已改完并通过测试,无需重启")).toBe(false);
    expect(detectRestartNeeded(undefined)).toBe(false);
  });

  it("normalizeStatusPoint 折叠任务 id 与标点数字", () => {
    expect(normalizeStatusPoint("修复 侧栏 done 点转绿 ws-mwka12")).toBe("修复侧栏done点转绿");
    expect(normalizeStatusPoint("[RSI] 修复 侧栏 done 点转绿")).toBe("修复侧栏done点转绿");
  });

  it("ensureRestartQueue 只在缺失时建空文件", () => {
    expect(restartQueueExists(root)).toBe(false);
    expect(ensureRestartQueue(root)).toBe(true);
    expect(restartQueueExists(root)).toBe(true);
    expect(ensureRestartQueue(root)).toBe(false);
    expect(listRestartQueue(root)).toEqual([]);
  });
});
