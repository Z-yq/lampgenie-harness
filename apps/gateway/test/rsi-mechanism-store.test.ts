/**
 * RSI 机制开关 + 结果覆盖层持久层( P0-2)。
 * 钉住四类事实:
 * ① 开关:缺省 12 条不写盘、未知 id 拒、原子落盘后读回、坏文件容错、缺条目补齐;
 * ② 覆盖层:upsert/update/delete 重放、墓碑默认隐藏、改不存在的条目拒;
 * ③ 运行记录:起止、扫目录升序、坏文件跳过、结果文件容错与 `<runId>:` 全局 id 前缀;
 * ④ 合并视图:覆盖层命中基础条目即生效,孤儿墓碑不凭空长条目。
 * 全部用例只写 os.tmpdir 下的临时根,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendResultEvent,
  collectMechanismItems,
  deleteResultItem,
  finishRun,
  getRun,
  listRuns,
  loadMechanisms,
  mechanismsPath,
  newRunId,
  projectResults,
  readRunResults,
  resultFilePath,
  resultsPath,
  setMechanism,
  startRun,
  updateResultItem,
} from "../src/rsi-mechanism-store";

const tempDirs: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsi-mech-store-"));
  tempDirs.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 直接写一个 run 结果文件(模拟 agent 产物)。 */
async function writeRunResult(
  root: string,
  mechanismId: string,
  runId: string,
  payload: unknown): Promise<string> {
  const file = resultFilePath(root, mechanismId, runId);
  await mkdir(join(root, ".genie", "rsi", "agent-runs", mechanismId), { recursive: true });
  await writeFile(file, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return file;
}

/** 直接写一个 run 记录文件(指定 startedAt,便于钉住排序)。 */
async function writeRunRecord(
  root: string,
  mechanismId: string,
  runId: string,
  startedAt: number,
  status: "running" | "done" | "failed" = "done",
): Promise<void> {
  const dir = join(root, ".genie", "rsi", "agent-runs", mechanismId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${runId}.json`), JSON.stringify({ runId, mechanismId, status, startedAt }), "utf8");
}

describe("机制开关 loadMechanisms", () => {
  it("无 mechanisms.json → 12 条 catalog 缺省,且不写盘", async () => {
    const root = await freshRoot();
    const states = await loadMechanisms(root);
    expect(Object.keys(states)).toHaveLength(12);
    expect(states.nightly).toEqual({ id: "nightly", enabled: true, driver: "agent", updatedAt: 0 });
    expect(states.pathology?.enabled).toBe(true);
    expect(states.pathology?.driver).toBe("agent");
    expect(await exists(mechanismsPath(root))).toBe(false);
  });

  it("坏 mechanisms.json → 容错回 12 条缺省", async () => {
    const root = await freshRoot();
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    await writeFile(mechanismsPath(root), "{ this is not json", "utf8");
    const states = await loadMechanisms(root);
    expect(Object.keys(states)).toHaveLength(12);
    expect(states.cost?.enabled).toBe(true);
  });

  it("文件缺条目 → 用 catalog 缺省补齐(同时保留已有条目)", async () => {
    const root = await freshRoot();
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    await writeFile(
      mechanismsPath(root),
      JSON.stringify({ atlas: { id: "atlas", enabled: false, driver: "code", updatedAt: 123 } }),
      "utf8",
    );
    const states = await loadMechanisms(root);
    expect(Object.keys(states)).toHaveLength(12);
    expect(states.atlas).toEqual({ id: "atlas", enabled: false, driver: "code", updatedAt: 123 });
    expect(states.nightly?.enabled).toBe(true);
  });
});

describe("setMechanism", () => {
  it("未知 id → UNKNOWN_MECHANISM,不写盘", async () => {
    const root = await freshRoot();
    const res = await setMechanism(root, "not-a-mechanism", { enabled: false });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("UNKNOWN_MECHANISM");
    expect(await exists(mechanismsPath(root))).toBe(false);
  });

  it("非法 patch 值 → INVALID_PATCH", async () => {
    const root = await freshRoot();
    const badDriver = await setMechanism(root, "cost", { driver: "llm" as unknown as "agent" });
    expect(badDriver.reason).toBe("INVALID_PATCH");
    const badEnabled = await setMechanism(root, "cost", { enabled: "no" as unknown as boolean });
    expect(badEnabled.reason).toBe("INVALID_PATCH");
  });

  it("原子落盘后读回:enabled/driver/by 都保住,其余 11 条不受影响", async () => {
    const root = await freshRoot();
    const res = await setMechanism(root, "evidence", { enabled: false, driver: "code" }, "human:alice");
    expect(res.ok).toBe(true);
    expect(res.mechanism).toMatchObject({ id: "evidence", enabled: false, driver: "code", by: "human:alice" });
    const onDisk = JSON.parse(await readFile(mechanismsPath(root), "utf8")) as Record<string, { enabled: boolean }>;
    expect(onDisk.evidence?.enabled).toBe(false);
    const states = await loadMechanisms(root);
    expect(states.evidence).toMatchObject({ enabled: false, driver: "code", by: "human:alice" });
    expect(typeof states.evidence?.updatedAt).toBe("number");
    expect(states.evidence?.updatedAt).toBeGreaterThan(0);
    expect(states.nightly?.enabled).toBe(true);
 // 原子写不留 tmp 残留
    expect(await exists(`${mechanismsPath(root)}.tmp`)).toBe(false);
  });

  it("只改 driver 时 enabled 保持上次值", async () => {
    const root = await freshRoot();
    await setMechanism(root, "cohort", { enabled: false });
    await setMechanism(root, "cohort", { driver: "code" });
    const states = await loadMechanisms(root);
    expect(states.cohort).toMatchObject({ enabled: false, driver: "code" });
  });
});

describe("覆盖层 appendResultEvent / projectResults", () => {
  it("upsert → update → delete 重放:最终只剩 tombstone,按 at 升序", async () => {
    const root = await freshRoot();
    await appendResultEvent(root, {
      type: "upsert",
      mechanismId: "evidence",
      itemId: "a",
      item: { title: "缺口 A", summary: "s", status: "warn", source: "agent", at: 10 },
      at: 10,
    });
    await appendResultEvent(root, {
      type: "upsert",
      mechanismId: "evidence",
      itemId: "b",
      item: { title: "缺口 B", at: 20 },
      at: 20,
    });
    await appendResultEvent(root, { type: "update", mechanismId: "evidence", itemId: "a", patch: { title: "改后 A", status: "bad" }, at: 30 });
    await appendResultEvent(root, { type: "delete", mechanismId: "evidence", itemId: "b", at: 40 });

    const live = await projectResults(root, "evidence");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: "a", title: "改后 A", status: "bad", summary: "s" });

    const all = await projectResults(root, "evidence", { includeDeleted: true });
    expect(all.map((item) => item.id)).toEqual(["a", "b"]);
    expect(all[1]?.deleted).toBe(true);
    expect(all.every((item, index) => index === 0 || (all[index - 1]?.at ?? 0) <= item.at)).toBe(true);
  });

  it("坏行跳过,不影响其它行;跨机制隔离", async () => {
    const root = await freshRoot();
    await mkdir(join(root, ".genie", "rsi"), { recursive: true });
    const file = resultsPath(root);
    await writeFile(
      file,
      [
        '{"v":1,"type":"upsert","mechanismId":"cost","itemId":"c1","item":{"title":"花费异常"},"at":5}',
        "{ broken json",
        '{"v":1,"type":"unknown","mechanismId":"cost","itemId":"c2","at":6}',
        '{"v":1,"type":"upsert","mechanismId":"cost","at":7}',
        '{"v":1,"type":"upsert","mechanismId":"atlas","itemId":"a1","item":{"title":"方向漂移"},"at":8}',
        "",
      ].join("\n"),
      "utf8",
    );
    const cost = await projectResults(root, "cost");
    expect(cost.map((item) => item.id)).toEqual(["c1"]);
    const all = await projectResults(root);
    expect(all.map((item) => item.id).sort()).toEqual(["a1", "c1"]);
  });

  it("update 命中不存在的条目 → 建占位;非法事件入参 → TypeError", async () => {
    const root = await freshRoot();
    await appendResultEvent(root, { type: "update", mechanismId: "atlas", itemId: "ghost", patch: { summary: "占位" }, at: 1 });
    const items = await projectResults(root, "atlas");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "ghost", summary: "占位" });
    await expect(
      appendResultEvent(root, { type: "wat" as unknown as "upsert", mechanismId: "atlas", itemId: "x" }),
    ).rejects.toThrow(TypeError);
    await expect(
      appendResultEvent(root, { type: "upsert", mechanismId: "", itemId: "x" }),
    ).rejects.toThrow(TypeError);
  });

  it("updateResultItem:命中则打 patch,不存在则 ITEM_NOT_FOUND", async () => {
    const root = await freshRoot();
    await appendResultEvent(root, {
      type: "upsert",
      mechanismId: "prompts",
      itemId: "p1",
      item: { title: "v3 更好", summary: "依据 …", status: "ok" },
      at: 100,
    });
    const ok = await updateResultItem(root, "prompts", "p1", { title: "v3 明显更好", status: "info" }, "human:bob");
    expect(ok.ok).toBe(true);
    expect(ok.item).toMatchObject({ id: "p1", title: "v3 明显更好", status: "info" });
    const missing = await updateResultItem(root, "prompts", "nope", { title: "x" });
    expect(missing).toEqual({ ok: false, reason: "ITEM_NOT_FOUND" });
    const after = await projectResults(root, "prompts");
    expect(after[0]?.title).toBe("v3 明显更好");
  });

  it("deleteResultItem:默认隐藏,includeDeleted 可见;重复删 → ITEM_NOT_FOUND", async () => {
    const root = await freshRoot();
    await appendResultEvent(root, {
      type: "upsert",
      mechanismId: "injection",
      itemId: "i1",
      item: { title: "误报规则" },
      at: 1,
    });
    const del = await deleteResultItem(root, "injection", "i1", "human:carol", "误报");
    expect(del.ok).toBe(true);
    expect(await projectResults(root, "injection")).toHaveLength(0);
    const withDeleted = await projectResults(root, "injection", { includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deleted).toBe(true);
    const again = await deleteResultItem(root, "injection", "i1");
    expect(again).toEqual({ ok: false, reason: "ITEM_NOT_FOUND" });
  });
});

describe("运行记录 startRun / finishRun / listRuns", () => {
  it("newRunId 形状稳定且各不相同", () => {
    const a = newRunId(1_700_000_000_000);
    const b = newRunId(1_700_000_000_000);
    expect(a).toMatch(/^run_[0-9a-z]+_[0-9a-z]+$/);
    expect(a).not.toBe(b);
  });

  it("startRun → running;finishRun → done + finishedAt;getRun 读回", async () => {
    const root = await freshRoot();
    const record = await startRun(root, { mechanismId: "nightly", taskId: "task_1", sessionId: "sess_1" });
    expect(record.status).toBe("running");
    expect(record.mechanismId).toBe("nightly");
    expect(record.taskId).toBe("task_1");
    expect(await exists(join(root, ".genie", "rsi", "agent-runs", "nightly", `${record.runId}.json`))).toBe(true);

    await finishRun(root, "nightly", record.runId, "failed", "MODEL_UNAVAILABLE");
    const after = await getRun(root, "nightly", record.runId);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("MODEL_UNAVAILABLE");
    expect(typeof after?.finishedAt).toBe("number");
    expect(after?.startedAt).toBe(record.startedAt);
  });

  it("listRuns 扫目录按 startedAt 升序,坏文件跳过,结果文件不算 run", async () => {
    const root = await freshRoot();
    await writeRunRecord(root, "cost", "run_b", 200);
    await writeRunRecord(root, "cost", "run_a", 100);
    const dir = join(root, ".genie", "rsi", "agent-runs", "cost");
    await writeFile(join(dir, "broken.json"), "{ not json", "utf8");
    await writeFile(join(dir, "run_a.result.json"), JSON.stringify({ items: [] }), "utf8");
    const runs = await listRuns(root, "cost");
    expect(runs.map((run) => run.runId)).toEqual(["run_a", "run_b"]);
    const all = await listRuns(root);
    expect(all.map((run) => run.runId)).toEqual(["run_a", "run_b"]);
    expect(await listRuns(root, "empty-mech")).toEqual([]);
  });

  it("getRun 缺文件 → undefined", async () => {
    const root = await freshRoot();
    expect(await getRun(root, "cost", "run_missing")).toBeUndefined();
  });
});

describe("readRunResults 容错 + 全局 id 前缀", () => {
  it("坏文件 / 缺 items → []", async () => {
    const root = await freshRoot();
    expect(await readRunResults(root, "tools", "run_x")).toEqual([]);
    await writeRunResult(root, "tools", "run_x", "{ broken");
    expect(await readRunResults(root, "tools", "run_x")).toEqual([]);
    await writeRunResult(root, "tools", "run_x", { nope: true });
    expect(await readRunResults(root, "tools", "run_x")).toEqual([]);
  });

  it("id 缺省 i<index>、全局 id = <runId>:<id>、title/summary 截断、非法 status 省略", async () => {
    const root = await freshRoot();
    const longTitle = "长".repeat(400);
    await writeRunResult(root, "tools", "run_y", {
      items: [
        { id: "Tool-Gap 1", title: longTitle, summary: "s", status: "nonsense" },
        { title: "无 id 条目", summary: longTitle, status: "ok", detail: "细节" },
        "垃圾条目",
      ],
    });
    const items = await readRunResults(root, "tools", "run_y");
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("run_y:tool-gap-1");
    expect(items[0]?.title.length).toBe(300);
    expect(items[0]?.status).toBeUndefined();
    expect(items[0]?.mechanismId).toBe("tools");
    expect(items[0]?.runId).toBe("run_y");
    expect(items[1]?.id).toBe("run_y:i1");
    expect(items[1]?.summary.length).toBe(300);
    expect(items[1]?.status).toBe("ok");
    expect(items[1]?.detail).toBe("细节");
    expect(typeof items[0]?.at).toBe("number");
  });

  it("resultFilePath 指向 agent-runs/<mech>/<runId>.result.json", async () => {
    expect(resultFilePath("/r", "atlas", "run_1")).toBe("/r/.genie/rsi/agent-runs/atlas/run_1.result.json");
    expect(resultsPath("/r")).toBe("/r/.genie/rsi/results.jsonl");
    expect(mechanismsPath("/r")).toBe("/r/.genie/rsi/mechanisms.json");
  });
});

describe("collectMechanismItems 基础层 + 覆盖层", () => {
  it("覆盖层 update/delete 命中基础条目,upsert 新条目并入;run 取最近一次", async () => {
    const root = await freshRoot();
    await writeRunRecord(root, "pathology", "run_1", 100);
    await writeRunResult(root, "pathology", "run_1", {
      items: [
        { id: "p1", title: "旧标题", summary: "旧摘要", status: "warn" },
        { id: "p2", title: "该删的", summary: "删", status: "bad" },
      ],
    });

    await appendResultEvent(root, {
      type: "update",
      mechanismId: "pathology",
      itemId: "run_1:p1",
      patch: { title: "人工改过的标题", status: "ok" },
      by: "human:dan",
    });
    await appendResultEvent(root, { type: "delete", mechanismId: "pathology", itemId: "run_1:p2", by: "human:dan" });
    await appendResultEvent(root, {
      type: "upsert",
      mechanismId: "pathology",
      itemId: "manual-1",
      item: { title: "人工新增条目", summary: "手记", source: "manual", at: 1 },
      at: 1,
    });
 // 孤儿墓碑:不应凭空长条目,也不应计入 overlayApplied
    await appendResultEvent(root, { type: "delete", mechanismId: "pathology", itemId: "run_1:ghost" });

    const merged = await collectMechanismItems(root, "pathology");
 // 被 update 命中的条目 at 刷新为改动时刻,所以它排在更早的 upsert 条目之前(降序)。
    expect(merged.items.map((item) => item.id)).toEqual(["run_1:p1", "manual-1"]);
    expect(merged.items.every((item, index) => index === 0 || (merged.items[index - 1]?.at ?? 0) >= item.at)).toBe(true);
    const p1 = merged.items.find((item) => item.id === "run_1:p1");
    expect(p1?.title).toBe("人工改过的标题");
    expect(p1?.status).toBe("ok");
    expect(merged.overlayApplied).toBe(3);
    expect(merged.run?.runId).toBe("run_1");
    expect(merged.items.some((item) => item.id === "run_1:ghost")).toBe(false);
  });

  it("多 run 基础层合并,按 at 降序,上限 50 条", async () => {
    const root = await freshRoot();
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `n${index}`, title: `条目 ${index}`, summary: "s" }));
    await writeRunRecord(root, "cohort", "run_old", 10);
    await writeRunResult(root, "cohort", "run_old", { items: many.slice(0, 20) });
    await writeRunRecord(root, "cohort", "run_new", 20);
    await writeRunResult(root, "cohort", "run_new", { items: many.slice(20) });

    const merged = await collectMechanismItems(root, "cohort");
    expect(merged.items).toHaveLength(40);
    expect(merged.items.every((item) => item.id.startsWith("run_old:") || item.id.startsWith("run_new:"))).toBe(true);
    expect(merged.overlayApplied).toBe(0);
    expect(merged.run?.runId).toBe("run_new");
    expect(merged.items.every((item, index) => index === 0 || (merged.items[index - 1]?.at ?? 0) >= item.at)).toBe(true);

    const lots = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, title: `多 ${index}`, summary: "s" }));
    await writeRunRecord(root, "cohort", "run_huge", 30);
    await writeRunResult(root, "cohort", "run_huge", { items: lots });
    const capped = await collectMechanismItems(root, "cohort");
    expect(capped.items).toHaveLength(50);
  });

  it("无 run 无覆盖层 → 空结果且无 run", async () => {
    const root = await freshRoot();
    expect(await collectMechanismItems(root, "changeRequests")).toEqual({ items: [], overlayApplied: 0 });
  });
});
