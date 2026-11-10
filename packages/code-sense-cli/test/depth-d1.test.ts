/**
 * A4 回归:querySymbolDeep 的 d1 完整性不被深层封顶回噬。
 * 旧版全局 CAP=24 被 d1 吃满即 return——`callers cn --depth 2` 直接关系 35→24 缩水且零 d2 行
 * (三仓评测注意)。修复后:d1 恒完整(与 querySymbol 同语义),d≥2 每层各自封顶 24。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildC2fIndex, saveIndex } from "@lampgenie/code-sense";
import { createCodeIndexMcp, type CodeIndexMcp } from "../src/mcp-core.js";

let ws = "";
let mcp: CodeIndexMcp;

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "csd1cap-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  const lines: string[] = ["export function hubFn(): number { return 1; }"];
  // 30 个直接调用方,其中 26 个再被唯一父级调用(d2 候选 26 > 24 封顶线)
  for (let i = 0; i < 30; i++) {
    lines.push(`export function caller${i}(): number { return hubFn() + ${i}; }`);
    if (i < 26) lines.push(`export function grand${i}(): number { return caller${i}() + 1; }`);
  }
  writeFileSync(join(ws, "src", "fan.ts"), lines.join("\n") + "\n");
  saveIndex(ws, await buildC2fIndex(ws));
  mcp = createCodeIndexMcp(ws, { autoBuild: false });
}, 180_000);

afterAll(() => { rmSync(ws, { recursive: true, force: true }); }, 60_000);

describe("querySymbolDeep d1 完整性( A4)", () => {
  it("depth=2 时直接关系 30 条全量(不被 24 封顶回噬),d2 行在场且封顶 24", () => {
    const out = text(mcp.dispatchTool("code_index_symbol", { name: "hubFn", depth: 2 }));
    expect(out).toContain("被调用(30)");       // d1 完整:30 条(旧版此处=24)
    expect(out).toContain("(d2)");              // 间接层在场(旧版零 d2 行)
    expect(out).toContain("封顶已截断");         // 截断如实标注
    // d2 逐条计数:26 候选截到 24
    const d2Lines = out.split("\n").filter((l) => l.trim().startsWith("(d2)"));
    expect(d2Lines).toHaveLength(24);
  });

  it("depth=1 输出与缺省一致:d1 完整无截断", () => {
    const d1 = text(mcp.dispatchTool("code_index_symbol", { name: "hubFn", depth: 1 }));
    expect(d1).toContain("被调用(30)");
    expect(d1).not.toContain("(d2)");
  });
});
