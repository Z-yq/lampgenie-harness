import { describe, it, expect } from "vitest";
import { locateFinding } from "../src/review/resolver";
import { multiroundReview } from "../src/review/rounds";

const DIFF = [
  "diff --git a/x.ts b/x.ts",
  "@@ -1,3 +1,5 @@",
  " export const a = 1;",
  "+export const b = compute(a);",
  "+",
  "+export const c = 3;",
  " export const d = 4;",
].join("\n");
const FILES = [{ path: "x.ts", diffText: DIFF }, { path: "y.ts", diffText: DIFF.replace(/x\.ts/g, "y.ts") }];

const MISS = { file: "x.ts", anchorText: "根本不存在的锚", fallbackLine: 500 }; // 三档全失

describe("LLM 重定位第四级(纯 opt-in)", () => {
  it("未注入回调:行为与三档版完全一致(同步 unresolved)", () => {
    const r = locateFinding(MISS, FILES);
    expect(r).toEqual({ file: "x.ts", line: 1, resolution: "unresolved" });
  });

  it("confidence>=0.5 且 path 在候选集 → 采纳 resolution=llm", async () => {
    const calls: unknown[] = [];
    const r = await locateFinding(MISS, FILES, {
      llmRelocate: async (finding, files) => {
        calls.push({ finding, files });
        return { path: "y.ts", line: 3, confidence: 0.8 };
      },
    });
    expect(r).toEqual({ file: "y.ts", line: 3, resolution: "llm" });
    // 回调拿到 finding 上下文与候选文件摘要(snippet 非空)
    expect(calls[0]).toMatchObject({ finding: { file: "x.ts", fallbackLine: 500 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((calls[0] as any).files.map((f: any) => f.path).sort()).toEqual(["x.ts", "y.ts"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((calls[0] as any).files[0].snippet).toContain("@@");
  });

  it("低置信/坏 path/非法行号/回调抛错 → 一律保持 unresolved", async () => {
    const low = await locateFinding(MISS, FILES, { llmRelocate: async () => ({ path: "y.ts", line: 3, confidence: 0.49 }) });
    expect(low.resolution).toBe("unresolved");
    const badPath = await locateFinding(MISS, FILES, { llmRelocate: async () => ({ path: "z.ts", line: 3, confidence: 0.9 }) });
    expect(badPath.resolution).toBe("unresolved");
    const badLine = await locateFinding(MISS, FILES, { llmRelocate: async () => ({ path: "y.ts", line: 0, confidence: 0.9 }) });
    expect(badLine.resolution).toBe("unresolved");
    const boom = await locateFinding(MISS, FILES, { llmRelocate: async () => { throw new Error("llm down"); } });
    expect(boom).toEqual({ file: "x.ts", line: 1, resolution: "unresolved" });
    const nullRet = await locateFinding(MISS, FILES, { llmRelocate: async () => null });
    expect(nullRet.resolution).toBe("unresolved");
  });

  it("rounds.ts 接线:llmRelocate 透传,located 带四级结果", async () => {
    const llm = { async chat() { return { content: JSON.stringify({ findings: [
      { file: "x.ts", line: 500, severity: "warning", title: "T1", detail: "无法锚定的发现" },
    ], summary: "" }) }; } };
    const r = await multiroundReview({
      files: FILES.map((f) => ({ ...f, status: "modified" })),
      llm,
      diffContext: DIFF,
      llmRelocate: async () => ({ path: "y.ts", line: 4, confidence: 0.9 }),
    });
    const loc = r.located.find((f) => f.title === "T1")!;
    expect(loc.resolution).toBe("llm");
    expect(loc.file).toBe("y.ts");
    expect(loc.line).toBe(4);
  });

  it("rounds.ts 未注入回调:定位行为不变", async () => {
    const llm = { async chat() { return { content: JSON.stringify({ findings: [
      { file: "x.ts", line: 2, severity: "warning", title: "T1", detail: "export const b = compute(a);" },
    ], summary: "" }) }; } };
    const r = await multiroundReview({
      files: FILES.map((f) => ({ ...f, status: "modified" })),
      llm,
      diffContext: DIFF,
    });
    expect(r.located.find((f) => f.title === "T1")!.resolution).toBe("anchor");
  });
});
