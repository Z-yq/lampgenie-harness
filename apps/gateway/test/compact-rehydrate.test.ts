/**
 * M48 压缩后文件正文补回(compact-rehydrate)单测:
 * 名额/排序、单文件截断、总量预算、读失败、deny vs ask、enabled=false 接线、journal 字段。
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "@lampgenie/experience";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { clearReadFiles, readFilesOf, recordFileRead } from "@lampgenie/runtime/agent/read-file-state";
import {
  makeDenyMatcher,
  planRehydrate,
  rehydrateAfterCompact,
  type RehydrateEntry,
} from "../src/compact-rehydrate.js";
import { makeCompactHook } from "../src/compact-hook.js";

const base = mkdtempSync(join(tmpdir(), "compact-rehydrate-test-"));

function tmpRoot(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function put(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

const SID = "s-rehydrate";

function entry(path: string, readAt: number, mtimeMs = 0): RehydrateEntry {
  return { path, readAt, mtimeMs };
}

describe("compact-rehydrate(planRehydrate)", () => {
  it("按 readAt 降序取最近 N;超 maxFiles 的不进候选", () => {
    const plan = planRehydrate([entry("a.ts", 1000), entry("b.ts", 3000), entry("c.ts", 2000), entry("d.ts", 500)], { maxFiles: 3 });
    expect(plan.map((p) => p.path)).toEqual(["b.ts", "c.ts", "a.ts"]);
    // 缺省 5;显式越界钳到 3
    expect(planRehydrate([entry("x", 1)]).length).toBe(1);
    expect(planRehydrate(Array.from({ length: 10 }, (_, i) => entry(`f${i}.ts`, i)), { maxFiles: 1 })).toHaveLength(3);
    expect(planRehydrate(Array.from({ length: 10 }, (_, i) => entry(`f${i}.ts`, i)), { maxFiles: 8 })).toHaveLength(8);
  });
});

describe("compact-rehydrate(rehydrateAfterCompact)", () => {
  it("3 文件台账 → 补回块含全部正文与 mtime、readAt 降序、超名额不进", () => {
    const root = tmpRoot("basic");
    put(root, "a.ts", "export const a = 1;\n");
    put(root, "b.md", "# b\n正文 B\n");
    put(root, "c.json", '{"c":true}\n');
    put(root, "d.ts", "SHOULD_NOT_APPEAR\n");
    const j = new MemoryJournal();
    const r = rehydrateAfterCompact({
      journal: j,
      sessionId: SID,
      repoRoot: root,
      caps: { maxFiles: 3 },
      deny: () => false,
      entries: [entry("a.ts", 1000), entry("b.md", 3000), entry("c.json", 2000), entry("d.ts", 500)],
    });
    expect(r.files.map((f) => f.path)).toEqual(["b.md", "c.json", "a.ts"]);
    expect(r.message).toContain("## 压缩后文件正文补回(重读磁盘;3 个)");
    expect(r.message).toContain("### b.md(mtime ");
    expect(r.message).toContain("正文 B");
    expect(r.message).toContain('{"c":true}');
    expect(r.message).toContain("export const a = 1;");
    expect(r.message).not.toContain("SHOULD_NOT_APPEAR");
    // mtime 与行数都渲染在标题里
    expect(r.message).toMatch(/### b\.md\(mtime \d{4}-\d{2}-\d{2}T[\d:.]+Z,3 行\)/);
    // 语言按扩展名
    expect(r.message).toContain("```md");
    expect(r.message).toContain("```json");
    expect(r.message).toContain("```ts");
  });

  it("大文件超单文件 5k token → 头部截断 + partialView + 「原文件 N 行」", () => {
    const root = tmpRoot("big");
    const big = Array.from({ length: 200 }, () => "X".repeat(200)).join("\n"); // 40k ASCII ≈ 10k tok
    put(root, "big.ts", big);
    const j = new MemoryJournal();
    const r = rehydrateAfterCompact({
      journal: j, sessionId: SID, repoRoot: root, deny: () => false,
      entries: [entry("big.ts", 1000)],
      caps: { maxFileTokens: 5000, maxTotalTokens: 50_000 },
    });
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.partialView).toBe(true);
    expect(r.files[0]!.tokens).toBeLessThanOrEqual(5000);
    expect(r.totalChars).toBeLessThan(big.length);
    expect(r.partialView).toBe(true);
    expect(r.message).toContain("partialView: 已截断到");
    expect(r.message).toContain("原文件 200 行");
  });

  it("总量超 50k token → 后续文件 budget skipped + partialView(不补位)", () => {
    const root = tmpRoot("budget");
    put(root, "one.ts", "A".repeat(60_000)); // ≈15k tok
    put(root, "two.ts", "B".repeat(60_000)); // ≈15k tok
    const j = new MemoryJournal();
    const r = rehydrateAfterCompact({
      journal: j, sessionId: SID, repoRoot: root, deny: () => false,
      caps: { maxFileTokens: 20_000, maxTotalTokens: 20_000 },
      entries: [entry("one.ts", 2000), entry("two.ts", 1000)],
    });
    expect(r.files.map((f) => f.path)).toEqual(["one.ts"]);
    expect(r.skipped).toEqual([{ path: "two.ts", reason: "budget" }]);
    expect(r.partialView).toBe(true);
    expect(r.message).toContain("partialView: 总量预算已满");
    expect(r.message).not.toContain("BBBB");
  });

  it("文件已删除/读失败 → read-failed partialView,不抛异常", () => {
    const root = tmpRoot("missing");
    const j = new MemoryJournal();
    const r = rehydrateAfterCompact({
      journal: j, sessionId: SID, repoRoot: root, deny: () => false,
      entries: [entry("gone.ts", 1000)],
    });
    expect(r.files).toHaveLength(0);
    expect(r.skipped).toEqual([{ path: "gone.ts", reason: "read-failed" }]);
    expect(r.partialView).toBe(true);
    // 空补回块不注入 message.system(只留审计事件)
    expect(j.readAll().filter((e) => e.kind === "message.system")).toHaveLength(0);
  });

  it("deny 规则命中 → 不读、skipped(deny);ask 规则 → 照读", () => {
    const root = tmpRoot("deny");
    put(root, "secret/x.ts", "TOPSECRET_BODY\n");
    put(root, "ask/y.ts", "ASK_BODY\n");
    const readPaths: string[] = [];
    const deny = makeDenyMatcher([
      { permission: "read_file", pattern: "secret/**", action: "deny" },
      { permission: "read_file", pattern: "ask/**", action: "ask" },
    ]);
    const j = new MemoryJournal();
    const r = rehydrateAfterCompact({
      journal: j, sessionId: SID, repoRoot: root, deny,
      entries: [entry("secret/x.ts", 2000), entry("ask/y.ts", 1000)],
      readFile: (abs) => {
        readPaths.push(abs.replace(/\\/g, "/"));
        return readFileSync(abs, "utf-8");
      },
    });
    expect(r.skipped).toEqual([{ path: "secret/x.ts", reason: "deny" }]);
    expect(r.files.map((f) => f.path)).toEqual(["ask/y.ts"]);
    expect(readPaths.some((p) => p.endsWith("secret/x.ts"))).toBe(false);
    expect(r.message).not.toContain("TOPSECRET_BODY");
    expect(r.message).toContain("ASK_BODY");
    // deny 不算 partialView(是主动跳过)
    expect(r.partialView).toBe(false);
  });

  it("journal 事件 compact.rehydrate 字段齐全", () => {
    const root = tmpRoot("event");
    put(root, "e.md", "# event\n");
    const j = new MemoryJournal();
    rehydrateAfterCompact({
      journal: j, sessionId: SID, repoRoot: root, deny: () => false,
      entries: [entry("e.md", 1000)],
      now: () => 1_700_000_000_000,
    });
    const ev = j.readAll().find((e) => e.kind === "custom");
    const p = ev?.payload as Record<string, unknown> | undefined;
    expect(p?.type).toBe("compact.rehydrate");
    expect(p?.sessionId).toBe(SID);
    expect(Array.isArray(p?.files)).toBe(true);
    const f = (p!.files as Array<Record<string, unknown>>)[0]!;
    expect(f.path).toBe("e.md");
    expect(typeof f.chars).toBe("number");
    expect(typeof f.tokens).toBe("number");
    expect(f.partialView).toBe(false);
    expect(Array.isArray(p?.skipped)).toBe(true);
    expect(typeof p?.totalChars).toBe("number");
    expect(typeof p?.totalTokens).toBe("number");
    expect(p?.at).toBe(1_700_000_000_000);
  });
});

// ---- compact-hook 接线 ----

function stubLlm(reply: string): LlmProvider {
  return { chat: async () => ({ content: reply }) } as unknown as LlmProvider;
}

/** 造一个会真压缩的会话(与 compact-hook.test.ts 同形态)。 */
function compactionJournal(j: MemoryJournal, sid: string): void {
  j.append({ kind: "message.user", sessionId: sid, payload: { text: "任务素材".repeat(20_000) } });
  j.append({ kind: "message.agent", sessionId: sid, payload: { text: "第0步", usage: { inputTokens: 7000 } } });
  j.append({ kind: "message.user", sessionId: sid, payload: { text: "素材".repeat(20_000) } });
  j.append({ kind: "message.agent", sessionId: sid, payload: { text: "第1步", usage: { inputTokens: 7000 } } });
  j.append({ kind: "message.user", sessionId: sid, payload: { text: "素材".repeat(20_000) } });
  j.append({ kind: "message.agent", sessionId: sid, payload: { text: "第2步", usage: { inputTokens: 7000 } } });
}

describe("compact-hook 接线(enabled)", () => {
  it("enabled=false → 零补回 message.system、台账仍被清空", async () => {
    const root = tmpRoot("hook-off");
    put(root, "read-me.ts", "READ_ME_BODY\n");
    const sid = "s-off";
    recordFileRead(sid, "read-me.ts", Date.now());
    const j = new MemoryJournal();
    compactionJournal(j, sid);
    const hook = makeCompactHook({
      contextWindow: 8192,
      compactLlm: stubLlm("摘要"),
      devlogDir: root,
      taskId: "t-off",
      fallbackInstruction: "",
      store: new ExperienceStore(join(root, "exp")),
      repoRoot: root,
      compactRehydrate: { enabled: false },
    });
    await hook(j, sid);
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(true);
    expect(j.readAll().some((e) => e.kind === "message.system" && String((e.payload as { text?: string }).text).includes("压缩后文件正文补回"))).toBe(false);
    expect(readFilesOf(sid)).toHaveLength(0);
    expect(j.readAll().some((e) => (e.payload as { type?: string }).type === "compact.rehydrate")).toBe(false);
  });

  it("缺省启用 → 先取台账补回正文,再清台账", async () => {
    const root = tmpRoot("hook-on");
    put(root, "read-me.ts", "READ_ME_BODY\n");
    const sid = "s-on";
    recordFileRead(sid, "read-me.ts", Date.now());
    const j = new MemoryJournal();
    compactionJournal(j, sid);
    const hook = makeCompactHook({
      contextWindow: 8192,
      compactLlm: stubLlm("摘要"),
      devlogDir: root,
      taskId: "t-on",
      fallbackInstruction: "",
      store: new ExperienceStore(join(root, "exp")),
      repoRoot: root,
    });
    await hook(j, sid);
    const sys = j.readAll().filter((e) => e.kind === "message.system").map((e) => String((e.payload as { text?: string }).text));
    expect(sys.some((t) => t.includes("压缩后文件正文补回(重读磁盘;1 个)") && t.includes("READ_ME_BODY"))).toBe(true);
    expect(j.readAll().some((e) => (e.payload as { type?: string }).type === "compact.rehydrate")).toBe(true);
    expect(readFilesOf(sid)).toHaveLength(0);
    clearReadFiles(sid);
  });
});
