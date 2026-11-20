/**
 * 改前链路闸:未查→提醒+自动附符号表;已查→不打扰;每文件一次;非源码跳过;fail-soft。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSenseEditGuard } from "../src/sense-edit-guard.js";
import { createSenseQueryLedger } from "../src/sense-query-ledger.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "sense-guard-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export function foo() { return 1; }\n", "utf8");
  writeFileSync(join(root, "notes.txt"), "纯文本\n", "utf8");
  return root;
}

describe("createSenseEditGuard", () => {
  it("未查链路 → 提醒 + 自动附符号表", async () => {
    const root = fixture();
    const guard = createSenseEditGuard({
      root,
      ledger: createSenseQueryLedger(),
      fileSymbols: async () => "foo @ src/a.ts:1 (调用 3 / 被调 2)",
    });
    const hint = await guard("src/a.ts");
    expect(hint).toContain("改前链路未查");
    expect(hint).toContain("src/a.ts");
    expect(hint).toContain("action=impact");
    expect(hint).toContain("foo @ src/a.ts:1");
  });

  it("每任务每文件只提示一次", async () => {
    const root = fixture();
    const guard = createSenseEditGuard({ root, ledger: createSenseQueryLedger() });
    expect(await guard("src/a.ts")).toBeTruthy();
    expect(await guard("src/a.ts")).toBeUndefined();
  });

  it("已查链路(impact 命中符号)→ 不打扰", async () => {
    const root = fixture();
    const ledger = createSenseQueryLedger();
    ledger.record("impact", "foo");
    const guard = createSenseEditGuard({ root, ledger });
    expect(await guard("src/a.ts")).toBeUndefined();
  });

  it("已查链路(file 动作)→ 不打扰", async () => {
    const root = fixture();
    const ledger = createSenseQueryLedger();
    ledger.record("file", "src/a.ts");
    const guard = createSenseEditGuard({ root, ledger });
    expect(await guard("src/a.ts")).toBeUndefined();
  });

  it("非源码扩展名跳过", async () => {
    const root = fixture();
    const guard = createSenseEditGuard({ root, ledger: createSenseQueryLedger() });
    expect(await guard("notes.txt")).toBeUndefined();
  });

  it("符号表取数失败 → 降级纯提醒(fail-soft)", async () => {
    const root = fixture();
    const guard = createSenseEditGuard({
      root,
      ledger: createSenseQueryLedger(),
      fileSymbols: async () => { throw new Error("索引缺失"); },
    });
    const hint = await guard("src/a.ts");
    expect(hint).toContain("改前链路未查");
    expect(hint).not.toContain("符号表(自动带出");
  });

  it("文件不存在(新建)→ 不提示", async () => {
    const root = fixture();
    const guard = createSenseEditGuard({ root, ledger: createSenseQueryLedger() });
    expect(await guard("src/new.ts")).toBeUndefined();
  });

  it("onHint 留痕回调被调用", async () => {
    const root = fixture();
    const seen: Array<{ path: string; symbolsAttached: boolean }> = [];
    const guard = createSenseEditGuard({
      root,
      ledger: createSenseQueryLedger(),
      fileSymbols: async () => "table",
      onHint: (i) => seen.push({ path: i.path, symbolsAttached: i.symbolsAttached }),
    });
    await guard("src/a.ts");
    expect(seen).toEqual([{ path: "src/a.ts", symbolsAttached: true }]);
  });
});
