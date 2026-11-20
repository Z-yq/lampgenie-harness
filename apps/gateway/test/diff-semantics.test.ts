/**
 * diff 语义缺陷定位(设计稿 34):hunk 分类器 + 接线开关行为。
 * 钉住五类判定(首命中定类/降级闸/证据必带)+ 三档开关(off 影子/on 决定/veto 补类)。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiffSet, classifyDiffSemantics, type WriteHunk } from "../src/diff-semantics.js";
import { detectReworkChains, readReworkChains, diffSemanticsMode } from "../src/rework-chain.js";

const NOW = Date.now();
const DAY = 86_400_000;
const roots: string[] = [];

function fixture(): { root: string; journalDir: string } {
  const root = mkdtempSync(join(tmpdir(), "diffsem-"));
  const journalDir = join(root, "journal");
  mkdirSync(join(journalDir, "sessions"), { recursive: true });
  roots.push(root);
  return { root, journalDir };
}

function sessionWithFix(journalDir: string, id: string, edits: Array<[string, string, string]>, ageDays = 1): void {
  const events: Array<Record<string, unknown>> = [
    { kind: "message.user", sessionId: id, payload: { text: `修复 ${id} 的空值崩溃` } },
  ];
  let call = 0;
  for (const [path, oldS, newS] of edits) {
    events.push({ kind: "tool.call", sessionId: id, payload: { toolCallId: `e${call++}`, name: "edit_file", arguments: JSON.stringify({ path, old_string: oldS, new_string: newS }) } });
  }
  const file = join(journalDir, "sessions", `${id}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const at = new Date(NOW - ageDays * DAY);
  utimesSync(file, at, at);
}

function sessionBuild(journalDir: string, id: string, path: string, ageDays = 3): void {
  const events = [
    { kind: "message.user", sessionId: id, payload: { text: `开发 ${id} 功能模块` } },
    { kind: "tool.call", sessionId: id, payload: { toolCallId: "b1", name: "edit_file", arguments: JSON.stringify({ path, old_string: "x", new_string: "y" }) } },
  ];
  const file = join(journalDir, "sessions", `${id}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const at = new Date(NOW - ageDays * DAY);
  utimesSync(file, at, at);
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("classifyDiffSemantics(hunk 分类器)", () => {
  it("boundary:补空值守卫(del 有对应上下文,add 是新增 ?? 检查)", () => {
    const hunks: WriteHunk[] = [{
      tool: "edit_file", path: "src/a.ts",
      oldText: "const v = getConfig();\nreturn v;",
      newText: "const v = getConfig();\nif (v == null) return null;\nreturn v;",
    }];
    const r = classifyDiffSemantics({ hunks, editedPaths: ["src/a.ts"], fixAddedTest: false });
    expect(r.cls).toBe("boundary");
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.evidence[0]!.sig).toContain("boundary");
  });

  it("contract:签名参数集变化(增参)", () => {
    const hunks: WriteHunk[] = [{
      tool: "edit_file", path: "src/b.ts",
      oldText: "export function submit(task: Task): Result {",
      newText: "export function submit(task: Task, opts?: SubmitOpts): Result {",
    }];
    const r = classifyDiffSemantics({ hunks, editedPaths: ["src/b.ts"], fixAddedTest: false });
    expect(r.cls).toBe("contract");
  });

  it("contract 升级:跨行签名拼接(参数续行)与泛型变化", () => {
 // 跨行签名:参数列表折到第二行
    const multi = classifyDiffSemantics({
      hunks: [{
        tool: "edit_file", path: "src/m.ts",
        oldText: "export function submit(\n  task: Task\n): Result {",
        newText: "export function submit(\n  task: Task,\n  opts?: SubmitOpts\n): Result {",
      }],
      editedPaths: [], fixAddedTest: false,
    });
    expect(multi.cls).toBe("contract");
 // 泛型变化:type 别名泛型参数增加
    const generic = classifyDiffSemantics({
      hunks: [{
        tool: "edit_file", path: "src/g.ts",
        oldText: "export type Handler<T> = (v: T) => void;",
        newText: "export type Handler<T, E = Error> = (v: T, err?: E) => void;",
      }],
      editedPaths: [], fixAddedTest: false,
    });
    expect(generic.cls).toBe("contract");
 // 类方法签名(修饰符前缀)
    const method = classifyDiffSemantics({
      hunks: [{
        tool: "edit_file", path: "src/c.ts",
        oldText: "  private run(task: Task): void {",
        newText: "  private run(task: Task, mode: RunMode): Promise<void> {",
      }],
      editedPaths: [], fixAddedTest: false,
    });
    expect(method.cls).toBe("contract");
  });

  it("contract 反例:跨行拼接后参数未变(仅格式化折行)不算契约变化", () => {
    const r = classifyDiffSemantics({
      hunks: [{
        tool: "edit_file", path: "src/f.ts",
        oldText: "export function calc(a: number, b: number): number {",
        newText: "export function calc(\n  a: number,\n  b: number\n): number {",
      }],
      editedPaths: [], fixAddedTest: false,
    });
    expect(r.cls).toBe("uncategorized"); // 拼接后 token 集相同——纯格式化
  });

  it("concurrency:新增锁原语(del 无同构)", () => {
    const hunks: WriteHunk[] = [{
      tool: "edit_file", path: "src/c.ts",
      oldText: "doWork();",
      newText: "await withLock(mutex, () => doWork());",
    }];
    const r = classifyDiffSemantics({ hunks, editedPaths: ["src/c.ts"], fixAddedTest: false });
    expect(r.cls).toBe("concurrency");
  });

  it("uncategorized:纯文案/无信号 + 搬运行不算 boundary + 降级闸(>20 hunks)", () => {
    const plain = classifyDiffSemantics({ hunks: [{ tool: "edit_file", path: "a.ts", oldText: "标题旧", newText: "标题新" }], editedPaths: [], fixAddedTest: false });
    expect(plain.cls).toBe("uncategorized");
    expect(plain.evidence).toHaveLength(0);
 // 搬运(del/add 同构行)不算新增守卫
    const moved = classifyDiffSemantics({ hunks: [{ tool: "edit_file", path: "a.ts", oldText: "if (x == null) {", newText: "if (x == null) {" }], editedPaths: [], fixAddedTest: false });
    expect(moved.cls).toBe("uncategorized");
 // 降级闸:21 个 hunk 的大重构即使有信号也退 uncategorized
    const many: WriteHunk[] = Array.from({ length: 21 }, (_, i) => ({ tool: "edit_file" as const, path: `s${i}.ts`, oldText: "a", newText: "b ?? c" }));
    expect(classifyDiffSemantics({ hunks: many, editedPaths: [], fixAddedTest: false }).cls).toBe("uncategorized");
  });

  it("missing-test 最高优先(fixAddedTest 压过其它类)", () => {
    const r = classifyDiffSemantics({ hunks: [{ tool: "edit_file", path: "src/x.ts", oldText: "a", newText: "a ?? b" }], editedPaths: [], fixAddedTest: true });
    expect(r.cls).toBe("missing-test");
  });

  it("buildDiffSet:公共前后缀剥离 + 行统计", () => {
    const { hunks, stats } = buildDiffSet([{ tool: "edit_file", path: "a.ts", oldText: "head\nconst a = 1;\ntail", newText: "head\nconst a = 2;\nconst b = 3;\ntail" }]);
    expect(hunks[0]!.del).toEqual(["const a = 1;"]);
    expect(hunks[0]!.add).toEqual(["const a = 2;", "const b = 3;"]);
    expect(stats).toMatchObject({ hunks: 1, addedLines: 2, deletedLines: 1, paths: ["a.ts"] });
  });
});

describe("接线三档(off 影子/on 决定/veto 补类)", () => {
  const save = process.env.GENIE_REWORK_DIFF_SEMANTICS;
  afterEach(() => {
    if (save === undefined) delete process.env.GENIE_REWORK_DIFF_SEMANTICS;
    else process.env.GENIE_REWORK_DIFF_SEMANTICS = save;
  });

  function readHunksFactory(journalDir: string) {
    return (sessionId: string): WriteHunk[] => {
      const out: WriteHunk[] = [];
      const text = readFileSyncSafe(join(journalDir, "sessions", `${sessionId}.jsonl`));
      if (text === "") return out;
      for (const raw of text.split("\n")) {
        try {
          const e = JSON.parse(raw) as { kind?: string; payload?: { name?: string; arguments?: string } };
          if (e.kind === "tool.call" && e.payload?.name === "edit_file") {
            const a = JSON.parse(e.payload.arguments ?? "{}") as Record<string, string>;
            out.push({ tool: "edit_file", path: a.path ?? "", oldText: a.old_string ?? "", newText: a.new_string ?? "" });
          }
        } catch { /* 坏行跳过 */ }
      }
      return out;
    };
  }

  it("off(缺省):主台账 defectClass 仍标题词表,新行带 defectShadow=diff 类", () => {
    delete process.env.GENIE_REWORK_DIFF_SEMANTICS;
    expect(diffSemanticsMode()).toBe("off");
    const { root, journalDir } = fixture();
    sessionBuild(journalDir, "ws-a", "src/mod.ts");
    sessionWithFix(journalDir, "ws-f", [["src/mod.ts", "const v = load();", "const v = load();\nif (v == null) return;"]]);
    detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14, readWriteHunks: readHunksFactory(journalDir) });
    const { chains } = readReworkChains(root);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.defectClass).toBe("boundary"); // 标题「空值崩溃」命中词表
    expect(chains[0]!.defectShadow).toBe("boundary"); // diff 也判 boundary(影子一致)
    expect(chains[0]!.defectSource).toBe("title-fallback");
  });

  it("on:diff 决定(标题说 contract 但 diff 说 boundary → boundary+证据)", () => {
    process.env.GENIE_REWORK_DIFF_SEMANTICS = "on";
    const { root, journalDir } = fixture();
    sessionBuild(journalDir, "ws-a", "src/m2.ts");
    sessionWithFix(journalDir, "ws-f2", [["src/m2.ts", "const u = get();\nreturn u;", "const u = get();\nif (u === undefined) return null;\nreturn u;"]]);
 // 会话标题是「空值崩溃」(boundary 词表)——再造一个标题说 contract 的:
    const file = join(journalDir, "sessions", "ws-f2.jsonl");
    const lines = readFileSyncSafe(file).split("\n").filter((l) => l.trim() !== "");
    lines[0] = JSON.stringify({ kind: "message.user", sessionId: "ws-f2", payload: { text: "修复接口签名参数问题" } });
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14, readWriteHunks: readHunksFactory(journalDir) });
    const { chains } = readReworkChains(root);
    expect(chains[0]!.defectClass).toBe("boundary"); // on:diff 压过标题
    expect(chains[0]!.defectSource).toBe("diff");
    expect(chains[0]!.defectEvidence!.length).toBeGreaterThan(0);
  });

  it("veto:标题已给类则不覆盖;标题 uncategorized 才用 diff 补", () => {
    process.env.GENIE_REWORK_DIFF_SEMANTICS = "veto";
    const { root, journalDir } = fixture();
    sessionBuild(journalDir, "ws-a", "src/m3.ts");
    sessionWithFix(journalDir, "ws-f3", [["src/m3.ts", "const w = load();", "const w = load() ?? {};"]]);
 // 标题「空值崩溃」→ 词表 boundary;veto 不覆盖 → defectClass=boundary,source=title-fallback
    detectReworkChains(root, "p", { journalDir, now: NOW, windowDays: 14, readWriteHunks: readHunksFactory(journalDir) });
    const { chains } = readReworkChains(root);
    expect(chains[0]!.defectClass).toBe("boundary");
    expect(chains[0]!.defectSource).toBe("title-fallback");
  });
});

function readFileSyncSafe(path: string): string {
  try {
    return require("node:fs").readFileSync(path, "utf8") as string;
  } catch {
    return "";
  }
}
