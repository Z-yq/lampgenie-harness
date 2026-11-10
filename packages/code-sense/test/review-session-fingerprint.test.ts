/**
 * review session 内容指纹配对(收尾批 H:finding 身份 = file+规则位+内容指纹,
 * 行号绝不进指纹。三形态锚:
 * - 行号移动(顶部插行,内容不变)→ 未变(非「已修复」——旧行号配对的注意误判);
 *  - 真修复(锚内容从当前文件消失)→ 已修复;
 *  - 新增 → 新增。
 * 另:同键重复计数配对不崩溃;行号同/内容异=不同身份。
 */
import { describe, expect, it } from "vitest";
import { compareFindings, findingIdentity } from "../src/review/session";
import type { Finding } from "../src/review/index";

const mk = (over: Partial<Finding>): Finding => ({
  file: "src/a.ts",
  line: 3,
  severity: "warning",
  title: "孤儿导出",
  detail: "export foo 未被任何调用方使用",
  ...over,
});

// v1:foo 在第 3 行;v2:顶部插两行注释 → foo 漂到第 5 行(内容未变)
const V1 = ["const x = 1;", "const y = 2;", "export const foo = 1;", "const z = 3;"].join("\n");
const V2 = ["// pad", "// pad", "const x = 1;", "const y = 2;", "export const foo = 1;", "const z = 3;"].join("\n");

describe("review compare 内容指纹(行号不进身份)", () => {
  it("行号移动+内容未变 → 未变(不是已修复)", () => {
    const before = [mk({ line: 3, anchorText: "export const foo = 1;" })];
    const after = [mk({ line: 5, anchorText: "export const foo = 1;" })];
    const cmp = compareFindings(before, after, [], () => V2);
    expect(cmp.counts).toEqual({ new: 0, resolved: 0, unchanged: 1, reappeared: 0 });
  });

  it("真修复(锚内容从当前文件消失)→ 已修复", () => {
    const before = [mk({ line: 3, anchorText: "export const foo = 1;" })];
    const after: Finding[] = [];
    const fixed = V2.replace("export const foo = 1;", "const foo = 1;");
    const cmp = compareFindings(before, after, [], () => fixed);
    expect(cmp.counts.resolved).toBe(1);
  });

  it("新增问题 → 新增", () => {
    const after = [mk({ line: 6, anchorText: "export const bar = 2;" })];
    const cmp = compareFindings([], after, [], () => V2 + "\nexport const bar = 2;");
    expect(cmp.counts.new).toBe(1);
  });

  it("身份键:同内容不同行号=同身份;同行号不同内容=不同身份", () => {
    const a = mk({ line: 3, anchorText: "export const foo = 1;" });
    const b = mk({ line: 99, anchorText: "export const foo = 1;" });
    const c = mk({ line: 3, anchorText: "export const other = 9;" });
    expect(findingIdentity(a, () => V2)).toBe(findingIdentity(b, () => V2));
    expect(findingIdentity(a, () => V2)).not.toBe(findingIdentity(c, () => V2));
  });

  it("同键一轮内重复:计数配对不崩溃(2 before vs 1 after → 1 未变 1 已修复)", () => {
    const f1 = mk({ anchorText: "export const foo = 1;" });
    const f2 = mk({ anchorText: "export const foo = 1;" });
    const cmp = compareFindings([f1, f2], [mk({ anchorText: "export const foo = 1;" })], [], () => V2);
    expect(cmp.counts.unchanged).toBe(1);
    expect(cmp.counts.resolved).toBe(1);
  });

  it("文件不可读(readFile=null)退化为锚文本指纹:同锚仍可配对", () => {
    const before = [mk({ anchorText: "export const foo = 1;" })];
    const after = [mk({ line: 88, anchorText: "export const foo = 1;" })];
    const cmp = compareFindings(before, after, [], () => null);
    expect(cmp.counts.unchanged).toBe(1);
  });

  it("V1→V2 无编辑基线回归:上下文行进入指纹窗口(±2 行)", () => {
    // 两 finding 锚相同但上下文不同(同名行在不同文件区)→ 不同身份
    const a = mk({ anchorText: "export const dup = 0;" });
    const ctxA = ["a1", "a2", "export const dup = 0;", "a4", "a5"].join("\n");
    const ctxB = ["b1", "b2", "export const dup = 0;", "b4", "b5"].join("\n");
    expect(findingIdentity(a, () => ctxA)).not.toBe(findingIdentity(a, () => ctxB));
  });
});
