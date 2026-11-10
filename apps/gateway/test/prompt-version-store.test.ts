/**
 * RSI #209 提示词版本治理持久层:落盘/冲突不写盘/钉扎/history/默认升级两态/prune/report/坏文件/
 * 真调 #196 自我修改门。全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acceptDefault,
  diffWithDefault,
  history,
  initBook,
  keepOverride,
  loadBook,
  pinSession,
  promptBookPath,
  promptPinsPath,
  pruneRedundant,
  reportPrompts,
  resolve,
  resolveForSession,
  saveRevision,
  updateBuiltin,
} from "../src/prompt-version-store";

const T0 = 1_700_000_000_000;
const BUILTINS = { "system.coding": "你是编码助手\n工具:{{tools}}", "user.summary": "总结:{{text}}" };
const V2 = "你是编码助手\n工具:{{tools}}\n语气:简洁";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prompt-version-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  const res = await initBook(root, { builtins: BUILTINS, at: T0 });
  expect(res.codes).toEqual([]);
}

function readBookFile(): string {
  return readFileSync(promptBookPath(root), "utf8");
}

describe("init / save / resolve", () => {
  it("initBook 落盘:每 key revision 1 builtin", async () => {
    await seed();
    expect(existsSync(promptBookPath(root))).toBe(true);
    const onDisk = JSON.parse(readBookFile()) as { schema: number; keys: Record<string, { current: number; builtin: string }> };
    expect(onDisk.schema).toBe(1);
    expect(Object.keys(onDisk.keys).sort()).toEqual(["system.coding", "user.summary"]);
    expect(onDisk.keys["system.coding"]!.current).toBe(1);
    expect(onDisk.keys["system.coding"]!.builtin).toBe(BUILTINS["system.coding"]);
  });

  it("saveRevision 落 v2 并 resolve 到 v2", async () => {
    await seed();
    const saved = await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", author: "zhq", at: T0 + 10 });
    expect(saved.ok).toBe(true);
    expect(saved.codes).toEqual(["PROMPT_SAVED"]);
    expect(saved.revision).toMatchObject({ revision: 2, predecessor: 1, origin: "user", baseRevision: 1, author: "zhq", timestamp: T0 + 10 });
    const resolved = await resolve(root, "system.coding");
    expect(resolved).toMatchObject({ ok: true, text: V2, revision: 2 });
    const onDisk = JSON.parse(readBookFile()) as { keys: Record<string, { current: number; revisions: unknown[] }> };
    expect(onDisk.keys["system.coding"]!.current).toBe(2);
    expect(onDisk.keys["system.coding"]!.revisions).toHaveLength(2);
  });

  it("base 冲突:不写盘,回 draft", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    const before = readBookFile();
    const conflict = await saveRevision(root, { key: "system.coding", text: "{{tools}} 冲突稿", baseRevision: 1, origin: "user", at: T0 + 20 });
    expect(conflict.ok).toBe(false);
    expect(conflict.codes).toEqual(["PROMPT_CONFLICT"]);
    expect(conflict.draft).toBe("{{tools}} 冲突稿");
    expect(readBookFile()).toBe(before);
  });

  it("placeholder 缺失拒写", async () => {
    await seed();
    const res = await saveRevision(root, { key: "system.coding", text: "没有占位符", baseRevision: 1, origin: "user", at: T0 + 10 });
    expect(res.ok).toBe(false);
    expect(res.codes).toEqual(["PROMPT_PLACEHOLDER_MISSING"]);
    expect((await resolve(root, "system.coding")).revision).toBe(1);
  });

  it("保存与默认相同的覆盖:自动删覆盖并落盘(current 回 1)", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    const pruned = await saveRevision(root, { key: "system.coding", text: BUILTINS["system.coding"], baseRevision: 2, origin: "user", at: T0 + 20 });
    expect(pruned.ok).toBe(true);
    expect(pruned.codes).toEqual(["PROMPT_NOOP_SAME_AS_DEFAULT", "PROMPT_PRUNED"]);
    expect(pruned.revision).toBeUndefined();
    const reread = await history(root, "system.coding");
    expect(reread.current).toBe(1);
    expect((await resolve(root, "system.coding")).text).toBe(BUILTINS["system.coding"]);
  });

  it("未知 key / 保留名拒不写", async () => {
    await seed();
    const unknown = await saveRevision(root, { key: "nope", text: "x", baseRevision: 1, origin: "user" });
    expect(unknown.codes).toEqual(["PROMPT_UNKNOWN_KEY"]);
    const reserved = await saveRevision(root, { key: "admin.x", text: "x", baseRevision: 1, origin: "user" });
    expect(reserved.codes).toEqual(["PROMPT_RESERVED_NAME"]);
  });
});

describe("会话钉扎", () => {
  it("pin 落盘 pins.json,resolveForSession 读钉扎版本", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    const pinned = await pinSession(root, "s1", { at: T0 + 20 });
    expect(pinned.ok).toBe(true);
    expect(pinned.pins?.revisions).toEqual({ "system.coding": 2, "user.summary": 1 });
    const onDisk = JSON.parse(readFileSync(promptPinsPath(root), "utf8")) as { sessions: Record<string, { revisions: Record<string, number> }> };
    expect(onDisk.sessions["s1"]!.revisions["system.coding"]).toBe(2);
    expect(await resolveForSession(root, "s1", "system.coding")).toMatchObject({ ok: true, revision: 2, text: V2 });
  });

  it("钉扎后保存 v3:会话仍 v2,默认 v3", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    await pinSession(root, "s1", { at: T0 + 20 });
    await saveRevision(root, { key: "system.coding", text: "{{tools}} v3", baseRevision: 2, origin: "user", at: T0 + 30 });
    expect(await resolveForSession(root, "s1", "system.coding")).toMatchObject({ revision: 2, text: V2 });
    expect(await resolve(root, "system.coding")).toMatchObject({ revision: 3, text: "{{tools}} v3" });
  });

  it("未钉扎的会话 → REVISION_NOT_FOUND", async () => {
    await seed();
    const res = await resolveForSession(root, "ghost", "system.coding");
    expect(res.ok).toBe(false);
    expect(res.codes).toEqual(["PROMPT_REVISION_NOT_FOUND"]);
  });
});

describe("历史与默认升级", () => {
  it("history 回读完整版本序列", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", author: "zhq", at: T0 + 10 });
    const res = await history(root, "system.coding");
    expect(res.ok).toBe(true);
    expect(res.current).toBe(2);
    expect(res.status).toBe("active");
    expect(res.revisions?.map((rev) => rev.revision)).toEqual([1, 2]);
    expect(res.revisions?.[1]).toMatchObject({ origin: "user", baseRevision: 1, author: "zhq" });
  });

  it("history 未知 key", async () => {
    await seed();
    expect((await history(root, "nope")).codes).toEqual(["PROMPT_UNKNOWN_KEY"]);
  });

  it("updateBuiltin → default-updated + affected,不混入序列;diff 出行", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    const updated = await updateBuiltin(root, { key: "system.coding", text: "你是编码助手\n工具:{{tools}}\n请多解释", at: T0 + 20 });
    expect(updated.ok).toBe(true);
    expect(updated.codes).toEqual(["PROMPT_DEFAULT_UPDATED"]);
    expect(updated.affected).toEqual(["system.coding@2"]);
    const record = updated.book.keys["system.coding"]!;
    expect(record.status).toBe("default-updated");
    expect(record.revisions).toHaveLength(2);
    expect(record.current).toBe(2);
    const diff = await diffWithDefault(root, "system.coding");
    expect(diff.same).toBe(false);
    expect(diff.lines.some((line) => line.kind === "add" && line.text.includes("请多解释"))).toBe(true);
    expect(diff.lines.some((line) => line.kind === "del" && line.text.includes("语气"))).toBe(true);
  });

  it("acceptDefault 用新默认(current 回 1)", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    await updateBuiltin(root, { key: "system.coding", text: "{{tools}} 新默认", at: T0 + 20 });
    const accepted = await acceptDefault(root, "system.coding");
    expect(accepted.ok).toBe(true);
    expect(accepted.codes).toEqual(["PROMPT_PRUNED"]);
    expect((await resolve(root, "system.coding")).text).toBe("{{tools}} 新默认");
    const reread = await history(root, "system.coding");
    expect(reread.status).toBe("active");
    expect(reread.current).toBe(1);
  });

  it("keepOverride 保留我的文本与版本号,status 回 active", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    await updateBuiltin(root, { key: "system.coding", text: "{{tools}} 新默认", at: T0 + 20 });
    const kept = await keepOverride(root, "system.coding");
    expect(kept.ok).toBe(true);
    const reread = await history(root, "system.coding");
    expect(reread.status).toBe("active");
    expect(reread.current).toBe(2);
    expect(reread.revisions).toHaveLength(2);
    expect((await resolve(root, "system.coding")).text).toBe(V2);
  });

  it("pruneRedundant 清掉与默认相同的覆盖", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    // 把默认改成与覆盖逐字相同 → 覆盖成为冗余
    await updateBuiltin(root, { key: "system.coding", text: V2, at: T0 + 20 });
    const pruned = await pruneRedundant(root);
    expect(pruned.pruned).toEqual(["system.coding"]);
    expect(pruned.codes).toEqual(["PROMPT_PRUNED"]);
    expect((await history(root, "system.coding")).current).toBe(1);
  });
});

describe("report 与坏文件", () => {
  it("reportPrompts 汇总 keys/revisions/pins/status", async () => {
    await seed();
    await saveRevision(root, { key: "system.coding", text: V2, baseRevision: 1, origin: "user", at: T0 + 10 });
    await pinSession(root, "s1", { at: T0 + 20 });
    await pinSession(root, "s2", { at: T0 + 30 });
    const report = await reportPrompts(root);
    expect(report.ok).toBe(true);
    expect(report.keys).toBe(2);
    expect(report.revisions).toBe(3);
    expect(report.pins).toBe(2);
    expect(report.status).toEqual({ active: 2 });
    expect(report.entries.find((entry) => entry.key === "system.coding")).toMatchObject({ current: 2, revisions: 2 });
    expect(report.pinnedSessions.map((item) => item.sessionId)).toEqual(["s1", "s2"]);
  });

  it("坏 book.json → 空书 + PROMPT_INVALID,不 throw", async () => {
    mkdirSync(dirname(promptBookPath(root)), { recursive: true });
    writeFileSync(promptBookPath(root), "{ 这不是 JSON", "utf8");
    const loaded = await loadBook(root);
    expect(loaded.codes).toEqual(["PROMPT_INVALID"]);
    expect(loaded.book.keys).toEqual({});
    const report = await reportPrompts(root);
    expect(report.ok).toBe(false);
    expect(report.codes).toEqual(["PROMPT_INVALID"]);
  });

  it("坏 pins.json 被折叠成空钉扎", async () => {
    await seed();
    mkdirSync(dirname(promptPinsPath(root)), { recursive: true });
    writeFileSync(promptPinsPath(root), "not-json", "utf8");
    const res = await resolveForSession(root, "s1", "system.coding");
    expect(res.codes).toEqual(["PROMPT_REVISION_NOT_FOUND"]);
  });
});

describe("#196 自我修改门集成", () => {
  it("origin=rsi 无审批:真调门 → 透传 MOD_* 码且不写盘", async () => {
    await seed();
    const before = readBookFile();
    const res = await saveRevision(root, { key: "system.coding", text: "{{tools}} rsi 稿", baseRevision: 1, origin: "rsi", at: T0 + 10 });
    expect(res.ok).toBe(false);
    expect(res.codes).toContain("PROMPT_NEEDS_APPROVAL");
    expect(res.codes.some((code) => code.startsWith("MOD_"))).toBe(true);
    expect(res.codes).toContain("MOD_RSI_NEEDS_HUMAN");
    expect(res.draft).toBe("{{tools}} rsi 稿");
    expect(res.decision).toBe("need-approval");
    expect(readBookFile()).toBe(before);
  });

  it("origin=rsi 带 human 审批:门放行后落序列 origin=rsi", async () => {
    await seed();
    const res = await saveRevision(root, {
      key: "system.coding",
      text: "{{tools}} rsi 稿",
      baseRevision: 1,
      origin: "rsi",
      approval: { ok: true, by: "zhq" },
      author: "rsi",
      at: T0 + 10,
    });
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual(["PROMPT_SAVED"]);
    expect(res.decision).toBe("allow");
    expect(res.revision).toMatchObject({ revision: 2, origin: "rsi", author: "rsi" });
    expect((await resolve(root, "system.coding")).revision).toBe(2);
  });

  it("origin=rsi 审批未声明 ok:连门都不放行(审批缺失码在前)", async () => {
    await seed();
    const res = await saveRevision(root, {
      key: "system.coding",
      text: "{{tools}} rsi 稿",
      baseRevision: 1,
      origin: "rsi",
      approval: { ok: false, by: "zhq" },
      at: T0 + 10,
    });
    expect(res.ok).toBe(false);
    expect(res.codes).toContain("PROMPT_NEEDS_APPROVAL");
    expect((await history(root, "system.coding")).current).toBe(1);
  });
});
