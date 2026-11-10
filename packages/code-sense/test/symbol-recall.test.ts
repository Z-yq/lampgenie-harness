/**
 * 符号优先召回单测(2026-10-21):
 *  - 中文问句分词(停用词剥离/词典最长匹配/无残渣)
 *  - 驼峰/下划线/点号切分
 *  - 中英词典映射(≥40 组、一对多)
 *  - 符号打分排序(多词覆盖/IDF/测试降权/邻居一致性)
 *  - 索引面召回(1 跳邻居扩展)
 *  - 真实仓端到端(索引在场才跑:反例「子代理 spawn 权限审批怎么回到父会话」/
 *    wiki ask「子代理怎么派发」)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CJK_EN_DICT, cjkToEnglish, queryTerms, segmentCjk, splitIdentifier } from "../src/retrieval/cjk";
import {
  applyNeighborCoherence, clearSymbolRecallCache, recallSymbols, scoreSymbols,
  type SymbolDoc, type SymbolScore,
} from "../src/retrieval/symbol-recall";
import { buildC2fIndex, indexDir, saveIndex } from "../src/callgraph/c2f";
import { codeSense } from "../src/index";
import { askWiki } from "../src/wiki/index";

const created: string[] = [];
afterAll(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
  clearSymbolRecallCache();
});

function doc(partial: Partial<SymbolDoc> & { id: string; name: string; file: string; line: number }): SymbolDoc {
  return { inCount: 0, outCount: 0, ...partial };
}

describe("中英开发域词典", () => {
  it("≥40 组,每组至少一个英文词根,键不重复(一对多允许)", () => {
    expect(CJK_EN_DICT.length).toBeGreaterThanOrEqual(40);
    const keys = new Set<string>();
    for (const [cn, ens] of CJK_EN_DICT) {
      expect(cn.length).toBeGreaterThanOrEqual(2);
      expect(ens.length).toBeGreaterThanOrEqual(1);
      expect(keys.has(cn), `重复键: ${cn}`).toBe(false);
      keys.add(cn);
    }
    // 一对多主干
    expect(cjkToEnglish("子代理")).toEqual(expect.arrayContaining(["subagent", "agent", "spawn"]));
    expect(cjkToEnglish("审批")).toEqual(expect.arrayContaining(["approve", "permission", "ask"]));
    expect(cjkToEnglish("权限")).toContain("permission");
    expect(cjkToEnglish("状态机")).toEqual(expect.arrayContaining(["state", "transition"]));
    expect(cjkToEnglish("协议")).toContain("protocol");
    expect(cjkToEnglish("看板")).toEqual(expect.arrayContaining(["board", "dashboard"]));
    expect(cjkToEnglish("追踪")).toEqual(expect.arrayContaining(["trace", "track"]));
    expect(cjkToEnglish("阶段")).toContain("phase");
    expect(cjkToEnglish("召回")).toEqual(expect.arrayContaining(["recall", "retrieve"]));
    expect(cjkToEnglish("开销")).toEqual(expect.arrayContaining(["cost", "token"]));
    expect(cjkToEnglish("派发")).toEqual(expect.arrayContaining(["dispatch", "spawn"]));
  });
});

describe("CJK 分词", () => {
  it("中文问句 → 内容词(停用词/趋向补语剥离,无 2-gram 残渣)", () => {
    expect(segmentCjk("子代理权限审批怎么回到父会话")).toEqual(["子代理", "权限", "审批", "父会话"]);
    expect(segmentCjk("怎么处理")).toEqual(["处理"]);
    expect(segmentCjk("怎么校验")).toEqual(["校验"]);
    const seg = segmentCjk("跨语言桥接边设计");
    expect(seg.length).toBeGreaterThan(0);
    expect(seg.every((w) => w.length >= 2)).toBe(true);
  });

  it("词典最长匹配优先:「状态机」不被切成「状态」+「机」", () => {
    expect(segmentCjk("状态机怎么迁移")).toEqual(["状态机", "迁移"]);
    expect(segmentCjk("总路线")).toEqual(["总路线"]);
  });
});

describe("标识符切分(驼峰/下划线/点号)", () => {
  it("camelCase / snake / dotted / 连续大写", () => {
    expect(splitIdentifier("makeSubagentPermissionAsker")).toEqual(["make", "subagent", "permission", "asker"]);
    expect(splitIdentifier("ANSWER_SUBAGENT_SPEC")).toEqual(["answer", "subagent", "spec"]);
    expect(splitIdentifier("LlmLoopBackend.spawn")).toEqual(["llm", "loop", "backend", "spawn"]);
    expect(splitIdentifier("HTTPServer.handle")).toEqual(["http", "server", "handle"]);
    expect(splitIdentifier("get-user_name")).toEqual(["get", "user", "name"]);
  });
});

describe("queryTerms(查询词表)", () => {
  it("反例 1:中英混合问句 → subagent/permission/approve/parent/spawn", () => {
    const t = queryTerms("子代理 spawn 权限审批怎么回到父会话");
    const terms = t.terms.map((x) => x.term);
    for (const w of ["subagent", "permission", "approve", "parent", "spawn", "session"]) {
      expect(terms, `缺词根 ${w}`).toContain(w);
    }
    // 停用词/趋向补语不得入词
    for (const w of ["怎么", "回到", "父会"]) expect(terms).not.toContain(w);
    // 主词根权重高于次词根
    const weight = (term: string): number => t.terms.find((x) => x.term === term)!.weight;
    expect(weight("permission")).toBeGreaterThan(weight("auth"));
    expect(t.cjkWords).toEqual(["子代理", "权限", "审批", "父会话"]);
  });

  it("直给标识符:整名保留为 identifier 高权重 + 切分 token", () => {
    const t = queryTerms("makeSubagentPermissionAsker 影响面");
    expect(t.identifiers).toContain("makeSubagentPermissionAsker");
    const idTerm = t.terms.find((x) => x.term === "makesubagentpermissionasker")!;
    expect(idTerm.source).toBe("identifier");
    expect(idTerm.weight).toBeGreaterThan(1.5);
    expect(t.terms.map((x) => x.term)).toContain("subagent");
    expect(t.terms.map((x) => x.term)).toContain("impact");
  });
});

describe("符号打分(纯函数)", () => {
  const terms = queryTerms("子代理 spawn 权限审批怎么回到父会话").terms;
  const docs: SymbolDoc[] = [
    doc({ id: "gw/agent-wiring.ts#makeSubagentPermissionAsker", name: "makeSubagentPermissionAsker", file: "apps/gateway/src/agent-wiring.ts", line: 83, inCount: 2, outCount: 11 }),
    doc({ id: "gw/permission-broker.ts#PermissionBroker.ask", name: "PermissionBroker.ask", file: "apps/gateway/src/permission-broker.ts", line: 59, container: "PermissionBroker", inCount: 1, outCount: 5 }),
    doc({ id: "rt/parent-ask-broker.ts#ParentAskBroker", name: "ParentAskBroker", file: "packages/harness-runtime/src/agent/parent-ask-broker.ts", line: 70, inCount: 3 }),
    doc({ id: "ui/table.ts#renderMarkdownTable", name: "renderMarkdownTable", file: "apps/panel/src/table.ts", line: 10, inCount: 8, outCount: 2 }),
    doc({ id: "gw/test/x.test.ts#makeSubagentPermissionAsker", name: "makeSubagentPermissionAsker", file: "apps/gateway/test/x.test.ts", line: 5, inCount: 1 }),
  ];

  it("目标符号置顶;无关符号不出现;同名的测试符号降权", () => {
    const ranked = scoreSymbols(docs, terms);
    expect(ranked[0]!.doc.name).toBe("makeSubagentPermissionAsker");
    expect(ranked[0]!.doc.file).toBe("apps/gateway/src/agent-wiring.ts");
    const names = ranked.map((s) => s.doc.name);
    expect(names).toContain("PermissionBroker.ask");
    expect(names.slice(0, 3)).toContain("ParentAskBroker");
    expect(names).not.toContain("renderMarkdownTable");
    const testIdx = ranked.findIndex((s) => s.doc.file.includes("/test/"));
    const srcIdx = ranked.findIndex((s) => s.doc.file === "apps/gateway/src/agent-wiring.ts");
    expect(srcIdx).toBeLessThan(testIdx);
    // 命中原因可追溯(多词覆盖)
    expect(ranked[0]!.coverage).toBeGreaterThanOrEqual(3);
    expect(ranked[0]!.matched).toContain("subagent");
  });

  it("邻居一致性:名字不含概念词但调用邻居含 → 加分浮出", () => {
    const t = queryTerms("子代理派发").terms;
    const cands: SymbolDoc[] = [
      doc({ id: "a#dispatchX", name: "dispatchX", file: "src/a.ts", line: 1 }),
      doc({ id: "b#LlmLoopBackend.spawn", name: "LlmLoopBackend.spawn", file: "src/b.ts", line: 2 }),
    ];
    const first = scoreSymbols(cands, t);
    const boosted = applyNeighborCoherence(
      first,
      (id) => id === "b#LlmLoopBackend.spawn" ? ["renderSubagentHeavyOpDiscipline", "workerWriteTools"] : [],
      t,
    );
    const spawnRow = boosted.find((s) => s.doc.name === "LlmLoopBackend.spawn")!;
    expect(spawnRow.neighborHits).toBeGreaterThan(0);
    expect(spawnRow.score).toBeGreaterThan(first.find((s) => s.doc.name === "LlmLoopBackend.spawn")!.score);
  });

  it("空词表/空文档不崩", () => {
    expect(scoreSymbols([], terms)).toEqual([]);
    expect(scoreSymbols(docs, [])).toEqual([]);
    expect(applyNeighborCoherence([], () => [], terms)).toEqual([]);
    const empty: SymbolScore[] = [];
    expect(empty.length).toBe(0);
  });
});

describe("索引召回(临时根,含 1 跳扩展)", () => {
  it("中文问句命中目标符号,并扩展定义文件的邻居", async () => {
    const root = mkdtempSync(join(tmpdir(), "gh-symbolrecall-"));
    created.push(root);
    const files: Record<string, string> = {
      "apps/gateway/src/agent-wiring.ts": [
        "export function gateJournal(): string { return \"g\"; }",
        "export function permissionMode(): string { return \"ask\"; }",
        "export function makeSubagentPermissionAsker(): boolean { return permissionMode().length > 0 && gateJournal().length > 0; }",
        "",
      ].join("\n"),
      "apps/gateway/src/permission-broker.ts": [
        "export class PermissionBroker {",
        "  ask(): boolean { return this.respond(); }",
        "  respond(): boolean { return true; }",
        "}",
        "",
      ].join("\n"),
      "apps/panel/src/table.ts": "export function renderMarkdownTable(): string { return \"|\"; }\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    saveIndex(root, await buildC2fIndex(root));
    clearSymbolRecallCache();
    const r = recallSymbols(root, "子代理 spawn 权限审批怎么回到父会话");
    expect(r.indexSize).toBeGreaterThan(0);
    expect(r.degraded).toBeUndefined();
    const names = r.symbols.map((s) => s.name);
    expect(names[0]).toBe("makeSubagentPermissionAsker");
    expect(names).toEqual(expect.arrayContaining(["PermissionBroker.ask", "permissionMode"]));
    expect(names).not.toContain("renderMarkdownTable");
    // gateJournal 名字不含查询词,由第一名候选的 1 跳调用关系扩展进来
    const expanded = r.symbols.find((s) => s.name === "gateJournal");
    expect(expanded?.expanded).toBe(true);
    // 关系面:目标符号的被调方/调用方进输出
    const primary = r.symbols[0]!;
    expect(primary.file).toBe("apps/gateway/src/agent-wiring.ts");
    expect(primary.callees.some((c) => c.name === "permissionMode")).toBe(true);
  }, 180_000);

  it("索引缺失:空 symbols + 显式降级(不编造符号)", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-symbolrecall-empty-"));
    created.push(root);
    writeFileSync(join(root, "a.ts"), "export function nothing(): void {}\n");
    clearSymbolRecallCache();
    const r = recallSymbols(root, "子代理怎么派发");
    expect(r.symbols).toEqual([]);
    expect(r.indexSize).toBe(0);
    expect(r.degraded).toContain("索引");
  });
});

// ---- 真实仓端到端(本仓索引在场才跑;索引过期不重建,只做召回质量断言) ----
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const hasRealIndex = existsSync(join(indexDir(repoRoot), "index.json"));
const real = hasRealIndex ? describe : describe.skip;

real("真实仓索引 e2e(反例回归)", () => {
  it("explore「子代理 spawn 权限审批怎么回到父会话」→ top 候选含权限审批答案", async () => {
    clearSymbolRecallCache();
    const r = await codeSense(repoRoot, "子代理 spawn 权限审批怎么回到父会话", { mode: "explore" });
    const top = (r.symbols ?? []).slice(0, 8).map((s) => s.name);
    expect(top.length).toBeGreaterThan(0);
    expect(
      top.some((n) => /^(makeSubagentPermissionAsker|PermissionBroker|ParentAskBroker|ANSWER_SUBAGENT_SPEC)/.test(n)),
      `top 候选不含权限审批相关符号: ${top.join(", ")}`,
    ).toBe(true);
    expect(top[0]).toBe("makeSubagentPermissionAsker");
    // 既有字段保持:grep 行命中仍在(向后兼容)
    expect(Array.isArray(r.matches)).toBe(true);
  }, 180_000);

  it("wiki ask「子代理怎么派发」→ symbols 非空且命中 agent-wiring/llm-loop-backend", async () => {
    clearSymbolRecallCache();
    const r = await askWiki(repoRoot, "子代理怎么派发");
    const symbols = r.symbols ?? [];
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.some((s) => s.file.includes("agent-wiring") || s.file.includes("llm-loop-backend") || s.file.includes("system-composer"))).toBe(true);
    // 页面零命中时也不再只回「无」:符号兜底说明在场或页面已由符号归属补入
    expect(r.pages.length > 0 || r.note.includes("符号优先召回兜底")).toBe(true);
  }, 180_000);
});
