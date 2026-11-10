import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildC2fIndex, queryFile } from "@lampgenie/code-sense";
import { formatFileNodes, type RepoState } from "../src/mcp-core.js";

/** 2026-10-21 file 动作输出面:类型声明/箭头/嵌套符号如实标注(symKind + parent 限定名)。 */
describe("file 文本面:符号表补全", () => {
  it("formatFileNodes 标出 {interface}/{type}/{enum}/{variable}/{arrow}/{class},嵌套符号带父限定名", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-cli-filesym-"));
    try {
      writeFileSync(join(dir, "model.ts"), [
        "export interface HostDeps { name: string }",
        'export type Mode = "a" | "b";',
        "export enum State { Idle, Busy }",
        "export const DEFAULT_LIMIT = 10;",
        "export const topArrow = (x: number): number => leafFn(x);",
        "export function leafFn(x: number): number { return x + 1; }",
        "export function createHost(deps: HostDeps): number {",
        "  const answer = (n: number): number => leafFn(n);",
        "  return answer(1);",
        "}",
        "export class Host { run(): number { return leafFn(1); } }",
        "export function entry(): number { return topArrow(1) + createHost({ name: 'n' }); }",
      ].join("\n"));
      const idx = await buildC2fIndex(dir);
      const nodes = queryFile(idx, "model.ts");
      const st: RepoState = { root: dir, name: basename(dir), index: idx, stale: false };
      const text = formatFileNodes(st, nodes);
      expect(text).toContain("HostDeps :1 {interface}");
      expect(text).toContain("Mode :2 {type}");
      expect(text).toContain("State :3 {enum}");
      expect(text).toContain("DEFAULT_LIMIT :4 {variable}");
      expect(text).toContain("topArrow :5 {arrow}");
      expect(text).toContain("createHost.answer :8 {arrow}"); // 嵌套箭头带父限定名
      expect(text).toContain("Host :11 {class}");
      expect(text).toContain("Host.run :11"); // 方法:container 限定名,无冗余 symKind
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
