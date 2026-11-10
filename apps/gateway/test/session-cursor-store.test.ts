/**
 * 会话查询游标持久层。
 * 断言全部按 session-cursor-store.ts 的真实行为:缺省 generation=1、原子写后无 .tmp 残留、
 * bump 后旧游标 STALE(且与改 query 同时发生时仍是 STALE)、reconcile 单事务去重、
 * report 计数一致、坏 JSON 兜底不抛、root 非法才 throw。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CURSOR_STORE_CODES,
  bump,
  currentGeneration,
  cursorStatePath,
  issue,
  reconcile,
  report,
  validate,
} from "../src/session-cursor-store.ts";
import { queryFingerprint } from "@lampgenie/runtime/agent/session-cursor";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cursor-"));
  roots.push(root);
  return root;
}

function rsiDir(root: string): string {
  return join(root, ".genie", "rsi");
}

/** 手工写 state 文件(含目录创建),用于坏文件/坏版本等负面用例。 */
function writeStateFile(root: string, text: string): void {
  mkdirSync(rsiDir(root), { recursive: true });
  writeFileSync(cursorStatePath(root), text, "utf8");
}

function leftoverTmpFiles(root: string): string[] {
  const dir = rsiDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("currentGeneration 缺省口径", () => {
  it("state 文件不存在时为 1", () => {
    expect(currentGeneration(makeRoot())).toBe(1);
  });

  it("state 文件坏 JSON 时回落 1 且不抛", () => {
    const root = makeRoot();
    writeStateFile(root, "{ not json");
    expect(currentGeneration(root)).toBe(1);
  });

  it("state 文件 v 不是 1 时回落 1", () => {
    const root = makeRoot();
    writeStateFile(root, JSON.stringify({ v: 2, generation: 9, issued: [], bumps: [] }));
    expect(currentGeneration(root)).toBe(1);
  });

  it("root 为空字符串时 throw(参数错误)", () => {
    expect(() => currentGeneration("")).toThrow();
    expect(() => currentGeneration("   ")).toThrow();
  });
});

describe("issue 签发与落盘", () => {
  it("首次签发 generation=1 且信封可解析", () => {
    const root = makeRoot();
    const result = issue(root, { query: { text: "foo" }, position: { beforeSeq: 5 } });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("CURSOR_ISSUED");
    expect(result.generation).toBe(1);
    expect(result.envelope?.payload.generation).toBe(1);
    expect(result.envelope?.payload.nextBeforeSeq).toBe(5);
    expect(result.envelope?.payload.queryFingerprint).toBe(queryFingerprint({ text: "foo" }));
  });

  it("落盘后 state 文件可 JSON.parse 且无 .tmp 残留", () => {
    const root = makeRoot();
    issue(root, { query: { text: "foo" } });
    const state = JSON.parse(readFileSync(cursorStatePath(root), "utf8")) as {
      v: number;
      generation: number;
      issued: Array<{ id: string; generation: number; queryFingerprint: string; at: number }>;
      bumps: unknown[];
    };
    expect(state.v).toBe(1);
    expect(state.generation).toBe(1);
    expect(state.issued.length).toBe(1);
    expect(state.issued[0]?.generation).toBe(1);
    expect(state.bumps).toEqual([]);
    expect(leftoverTmpFiles(root)).toEqual([]);
  });

  it("多次签发累计台账条数", () => {
    const root = makeRoot();
    issue(root, { query: { text: "a" } });
    issue(root, { query: { text: "b" } });
    expect(report(root).issued).toBe(2);
  });
});

describe("validate 四码(经持久层)", () => {
  it("未 bump 时同 query → OK", () => {
    const root = makeRoot();
    const issued = issue(root, { query: { text: "foo" } });
    const verdict = validate(root, issued.envelope, { query: { text: "foo" } });
    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBe("CURSOR_OK");
    expect(verdict.generation).toBe(1);
  });

  it("bump 后旧信封 → STALE", () => {
    const root = makeRoot();
    const issued = issue(root, { query: { text: "foo" } });
    bump(root, { cause: "index-rebuild" });
    const verdict = validate(root, issued.envelope, { query: { text: "foo" } });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("CURSOR_STALE");
    expect(verdict.generation).toBe(2);
  });

  it("bump 后同时改 query → 仍是 STALE 而非 QUERY_MISMATCH", () => {
    const root = makeRoot();
    const issued = issue(root, { query: { text: "foo", filters: { a: 1 } } });
    bump(root, { cause: "corpus-change" });
    const verdict = validate(root, issued.envelope, { query: { text: "foo", filters: { a: 2 } } });
    expect(verdict.code).toBe("CURSOR_STALE");
  });

  it("同 generation 改 query → QUERY_MISMATCH", () => {
    const root = makeRoot();
    const issued = issue(root, { query: { text: "foo", filters: { a: 1 } } });
    const verdict = validate(root, issued.envelope, { query: { text: "foo", filters: { a: 2 } } });
    expect(verdict.code).toBe("CURSOR_QUERY_MISMATCH");
  });

  it("bump 后新签发同 query → OK", () => {
    const root = makeRoot();
    issue(root, { query: { text: "foo" } });
    bump(root, { cause: "index-rebuild" });
    const fresh = issue(root, { query: { text: "foo" } });
    expect(fresh.generation).toBe(2);
    const verdict = validate(root, fresh.envelope, { query: { text: "foo" } });
    expect(verdict.code).toBe("CURSOR_OK");
  });

  it("非游标 JSON 当信封 → INVALID", () => {
    const root = makeRoot();
    issue(root, { query: { text: "foo" } });
    const verdict = validate(root, { text: "foo", filters: { a: 1 } }, { query: { text: "foo" } });
    expect(verdict.code).toBe("CURSOR_INVALID");
  });

  it("篡改签名 → INVALID(不是 STALE)", () => {
    const root = makeRoot();
    const issued = issue(root, { query: { text: "foo" } });
    bump(root, { cause: "restart" });
    const envelope = issued.envelope;
    if (envelope === undefined) throw new Error("签发未返回信封");
    const tampered = { payload: envelope.payload, signature: `${"f".repeat(15)}0` };
    expect(validate(root, tampered, { query: { text: "foo" } }).code).toBe("CURSOR_INVALID");
  });
});

describe("bump / reconcile 推进", () => {
  it("bump 记录 from/to 并把 generation 落盘", () => {
    const root = makeRoot();
    const result = bump(root, { cause: "index-rebuild" });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("CURSOR_GENERATION_BUMPED");
    expect(result.from).toBe(1);
    expect(result.to).toBe(2);
    expect(currentGeneration(root)).toBe(2);
    expect(leftoverTmpFiles(root)).toEqual([]);
  });

  it("reconcile 去重同一 cause,只推进一格", () => {
    const root = makeRoot();
    const result = reconcile(root, { causes: ["reconcile", "reconcile"] });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual(["reconcile"]);
    expect(result.generation).toBe(2);
    expect(currentGeneration(root)).toBe(2);
    expect(report(root).bumps).toBe(1);
  });

  it("reconcile 多 cause 顺序稳定且 generation = 原 + applied.len", () => {
    const root = makeRoot();
    bump(root, { cause: "restart" });
    const result = reconcile(root, { causes: ["reconcile", "index-rebuild", "reconcile"] });
    expect(result.applied).toEqual(["reconcile", "index-rebuild"]);
    expect(result.generation).toBe(4);
  });

  it("reconcile 空 causes 不推进也不留痕", () => {
    const root = makeRoot();
    const result = reconcile(root, { causes: [] });
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.generation).toBe(1);
    expect(report(root).bumps).toBe(0);
  });

  it("reconcile 后旧信封 STALE", () => {
    const root = makeRoot();
    const issued = issue(root, { query: { text: "foo" } });
    reconcile(root, { causes: [{ cause: "corpus-change" }] });
    expect(validate(root, issued.envelope, { query: { text: "foo" } }).code).toBe("CURSOR_STALE");
  });
});

describe("report 报表", () => {
  it("空 root 计数全 0 且 generation=1", () => {
    const result = report(makeRoot());
    expect(result).toEqual({ generation: 1, issued: 0, bumps: 0, stale: 0, causes: [], codes: [] });
  });

  it("计数与签发/推进次数一致", () => {
    const root = makeRoot();
    issue(root, { query: { text: "a" } });
    issue(root, { query: { text: "b" } });
    bump(root, { cause: "index-rebuild" });
    reconcile(root, { causes: ["reconcile", "reconcile", "corpus-change"] });
    const result = report(root);
    expect(result.generation).toBe(4);
    expect(result.issued).toBe(2);
    expect(result.bumps).toBe(3);
    // 两条游标都签在 generation=1,当前已是 4 → 全部过期。
    expect(result.stale).toBe(2);
    expect(result.causes).toEqual(["index-rebuild", "reconcile", "corpus-change"]);
  });

  it("坏 state 文件时 report 不抛并带 BAD_STATE 码", () => {
    const root = makeRoot();
    writeStateFile(root, "null");
    const result = report(root);
    expect(result.generation).toBe(1);
    expect(result.issued).toBe(0);
    expect(result.codes).toEqual(["CURSOR_STORE_BAD_STATE"]);
  });
});

describe("重启语义与稳定码", () => {
  it("bump 后重新读文件(模拟重启)仍是新 generation,旧游标 STALE", () => {
    const root = makeRoot();
    const issued = issue(root, { query: { text: "foo" } });
    bump(root, { cause: "restart" });
    // 每次调用都重新 readState(无进程内缓存),等价于重启后重读。
    expect(currentGeneration(root)).toBe(2);
    expect(validate(root, issued.envelope, { query: { text: "foo" } }).code).toBe("CURSOR_STALE");
  });

  it("store 码表含三个自产码", () => {
    expect(CURSOR_STORE_CODES.length).toBe(3);
    expect(CURSOR_STORE_CODES).toContain("CURSOR_STORE_ERROR");
    expect(CURSOR_STORE_CODES).toContain("CURSOR_STORE_WRITE_FAILED");
  });
});
