import { describe, it, expect } from "vitest";
import { parseClientMessage } from "@lampgenie/protocol";
import { fileSymbolsOf } from "@lampgenie/code-sense";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");

describe("档案文件钻取", () => {
  it("协议:profile.file 双向", () => {
    expect(parseClientMessage('{"v":1,"type":"profile.file","projectId":"p","file":"a.ts"}')?.type).toBe("profile.file");
    expect(parseClientMessage('{"type":"profile.file"}')).toBeNull();
  });

  it("fileSymbolsOf:文件内函数清单(带行号)+调用边(含跨文件标记)", async () => {
    const r = await fileSymbolsOf(REPO, "apps/gateway/src/companion.ts");
    const names = r.symbols.map((s) => s.name);
    expect(names).toContain("companionSessionId");
    expect(names).toContain("runCompanionTurn");
    expect(names).toContain("buildCompanionTools");
    expect(r.symbols.every((s) => typeof s.line === "number" && s.line > 0)).toBe(true);
    // runCompanionTurn 内调用 companionSessionId(同文件)→ 应有边
    const edge = r.edges.find((e) => e.fromName === "runCompanionTurn");
    expect(edge).toBeTruthy();
    expect(r.edges.every((e) => typeof e.crossFile === "boolean")).toBe(true);
  }, 60_000);

  it("八期定位:profile.file 服务端附 modules(档案工作流化组织数据源)", async () => {
    // 直接走 server 侧同款组装逻辑(与 case 内一致):loadIndex+fileToModules
    const { loadIndex, fileToModules } = await import("@lampgenie/code-sense");
    const idx = loadIndex(REPO);
    if (!idx) return; // 索引缺席(构建产物)skip
    const mods = fileToModules(idx, "apps/gateway/src/board-store.ts");
    expect(mods.nodes.length).toBeGreaterThanOrEqual(8);
    expect(mods.nodes.every((n) => n.kind && n.symbolRef.line > 0)).toBe(true);
    expect(mods.edges.length).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
