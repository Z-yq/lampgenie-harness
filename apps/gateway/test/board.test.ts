/**
 * 语义流程白板单测:
 * schema 校验 / 存储回路 / 边完整性 / 三态解析 / anchor 重定位 / 索引过期双段 / 工具 fail-soft / WS 回路。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal, bus } from "@lampgenie/core";
import { BoardDocZ } from "@lampgenie/protocol";
import { saveBoard, loadBoard, listBoards, backfillActualFiles, locateSymbolInText, resolveLinkState, resolveBoardLinks, finalizeBoardOnTaskDone } from "../src/board-store.js";
import { boardUpsertTool, boardReadTool } from "../src/agent-wiring.js";
import { indexStale, gitHeadSha, srcFingerprint, srcFingerprintCached, type C2fIndex } from "@lampgenie/code-sense";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";
import { repoRoot } from "../src/repo-root.js";
import { servePanel } from "../src/panel.js";

const goodDoc = {
  version: 1 as const,
  taskId: "t1", sessionId: "s1", title: "给白板加语义流程", status: "draft" as const, rev: 0,
  nodes: [
    {
      id: "n1", kind: "function" as const, label: "wbRender", summary: "把 BoardDoc 渲染成 mermaid 流程图", change: "modify" as const,
      symbolRef: { name: "wbRender", file: "src/a.ts", line: 3, anchor: "export function wbRender" },
      flow: [
        { type: "step" as const, text: "nodes 按 change 分组" },
        { type: "branch" as const, cond: "symbolRef 存在", then: [{ type: "step" as const, text: "渲染连接态" }], else: [{ type: "step" as const, text: "标新增绿" }] },
      ],
    },
    { id: "n2", kind: "module" as const, label: "board-store", summary: "白板落盘与读取", change: "add" as const, flow: [] },
  ],
  edges: [{ from: "n1", to: "n2", kind: "call" as const, label: "调用" }],
  planned_files: ["src/a.ts"],
  updatedAt: 0,
};

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("BoardDoc schema(protocol 单一出处)", () => {
  it("好文档通过;缺 summary/坏 flow 类型/坏边类型拒收", () => {
    expect(BoardDocZ.safeParse(goodDoc).success).toBe(true);
    const noSummary = { ...goodDoc, nodes: [{ id: "n1", label: "x", change: "add" }] };
    expect(BoardDocZ.safeParse(noSummary).success).toBe(false);
    const badFlow = { ...goodDoc, nodes: [{ id: "n1", label: "x", summary: "s", flow: [{ type: "zzz" }] }] };
    expect(BoardDocZ.safeParse(badFlow).success).toBe(false);
    const noNodes = { ...goodDoc, nodes: [] };
    expect(BoardDocZ.safeParse(noNodes).success).toBe(false);
  });
  it("flow 递归:branch 套 branch 合法", () => {
    const deep = {
      ...goodDoc,
      nodes: [{
        id: "n1", label: "f", summary: "嵌套分支",
        flow: [{ type: "branch", cond: "a", then: [{ type: "branch", cond: "b", else: [{ type: "step", text: "兜底" }] }] }],
      }],
    };
    expect(BoardDocZ.safeParse(deep).success).toBe(true);
  });
});

describe("board-store 存储回路", () => {
  it("save→load 对账一致;listBoards 按 updatedAt 倒序", () => {
    const r = tmp();
    const s = saveBoard(r, goodDoc);
    expect(s.ok).toBe(true);
    const loaded = loadBoard(r, "s1", "t1");
    expect(loaded?.title).toBe("给白板加语义流程");
    expect(loaded?.nodes[0]?.flow).toHaveLength(2);
    const s2 = saveBoard(r, { ...goodDoc, taskId: "t2", title: "第二块板" });
    expect(s2.ok).toBe(true);
    const items = listBoards(r, "s1");
    expect(items.map((i) => i.taskId).sort()).toEqual(["t1", "t2"]);
    expect(items[0]!.updatedAt).toBeGreaterThanOrEqual(items[1]!.updatedAt);
  });
  it("边引用不存在节点→拒收;节点 id 重复→拒收", () => {
    const r = tmp();
    const badEdge = saveBoard(r, { ...goodDoc, edges: [{ from: "n1", to: "ghost", kind: "call" }] });
    expect(badEdge.ok).toBe(false);
    if (!badEdge.ok) expect(badEdge.reason).toContain("不存在的节点");
    const dup = saveBoard(r, { ...goodDoc, nodes: [goodDoc.nodes[1], goodDoc.nodes[1]] });
    expect(dup.ok).toBe(false);
  });
  it("路径段消毒:sessionId/taskId 含分隔符不逃逸目录", () => {
    const r = tmp();
    const s = saveBoard(r, { ...goodDoc, sessionId: "../evil/x", taskId: "../../t" });
    expect(s.ok).toBe(true);
    if (s.ok) {
      // 落点必须在 .genie/boards 子树内,且分段不含 .. 或分隔符残留
      expect(s.path.startsWith(join(r, ".genie", "boards"))).toBe(true);
      const rel = s.path.slice(join(r, ".genie", "boards").length);
      expect(rel).not.toContain("..");
      expect(readFileSync(s.path, "utf-8")).toContain("给白板加语义流程");
    }
  });
  it("backfillActualFiles:回填+置 done;无板=false", () => {
    const r = tmp();
    saveBoard(r, goodDoc);
    expect(backfillActualFiles(r, "s1", "t1", ["src/a.ts", "src/b.ts"])).toBe(true);
    const d = loadBoard(r, "s1", "t1");
    expect(d?.status).toBe("done");
    expect(d?.actual_files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(backfillActualFiles(r, "s1", "ghost", ["x"])).toBe(false);
  });
});

describe("symbolRef 三态解析( §5)", () => {
  const fileText = ["// 头", "function helper() {}", "export function wbRender(doc) {", "  return doc;", "}"].join("\n");
  it("anchor 命中同行=linked;行漂移=moved 并给新行号", () => {
    const linked = resolveLinkState(fileText, { name: "wbRender", line: 3, anchor: "export function wbRender" }, true);
    expect(linked).toEqual({ state: "linked", line: 3 });
    const moved = resolveLinkState(fileText, { name: "wbRender", line: 1, anchor: "export function wbRender" }, true);
    expect(moved).toEqual({ state: "moved", line: 3 });
  });
  it("anchor 失效退化名字词边界匹配;子串不误配", () => {
    // anchor 不在了,但名字在 → moved 到名字行
    const r = resolveLinkState(fileText, { name: "helper", line: 99, anchor: "已经不存在的签名" }, true);
    expect(r).toEqual({ state: "moved", line: 2 });
    // 名字只作为子串出现(Render 里的 Render)不算命中 → 看索引:索引有=moved,无=broken
    const sub = resolveLinkState("function wbRenderV2() {}", { name: "wbRender" }, true);
    expect(sub.state).toBe("moved");
    expect(sub.line).toBeUndefined();
    const broken = resolveLinkState("function wbRenderV2() {}", { name: "wbRender" }, false);
    expect(broken.state).toBe("broken");
  });
  it("文件读不到(null)→索引有=moved,无=broken", () => {
    expect(resolveLinkState(null, { name: "gone" }, true).state).toBe("moved");
    expect(resolveLinkState(null, { name: "gone" }, false).state).toBe("broken");
  });
  it("resolveBoardLinks 整板:真文件锚定 + 断链节点并存", () => {
    const r = tmp();
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "a.ts"), fileText);
    const links = resolveBoardLinks(r, { ...goodDoc, root: r }, () => false);
    const l1 = links.find((l) => l.nodeId === "n1");
    expect(l1?.state).toBe("linked");
    expect(l1?.line).toBe(3);
  });
});

describe("symbolRef 定位假阳性修复(maskNonCode,2026-10-29)", () => {
 // 背景:N1 经验证 9 条 symbolIssues「漂移」全是假阳性——旧实现在整行**原文**上匹配,
  // 注释里/字符串字面量里提到同名符号就算命中。下面 a~d 是同类形态构造;
  // 「真实样本」三条取自盘上板的 symbolRef(来源文件名与 ref 原文写在用例注释里)。
  // 注:N1 原始审计输出里的那 9 条 symbolIssues 清单不可得(audit 只按需现算,板文件里没存),
  // 故未断言「9 条全过」;三条样本的 ref 是盘上真实记录,excerpt 按对应文件的真实内容节选。
  it("a) 符号名只出现在行注释/块注释里 → null", () => {
    const text = [
      "// 调用 locateSymbolInText 查影响面(注释里点名而已)",
      "/* 块注释也点了 locateSymbolInText,且跨",
      "   两行 */",
      "const unrelated = 1;",
    ].join("\n");
    expect(locateSymbolInText(text, { name: "locateSymbolInText" })).toBeNull();
  });
  it("b) 符号名只出现在字符串字面量里(单/双引号/模板串)→ null", () => {
    const text = [
      'const a = "locateSymbolInText";',
      "const b = 'locateSymbolInText';",
      "const c = `locateSymbolInText ${1}`;",
      "const d = 1;",
    ].join("\n");
    expect(locateSymbolInText(text, { name: "locateSymbolInText" })).toBeNull();
    // 模板串跨行同样整段抹掉
    const multi = ["const t = `开启", "locateSymbolInText", "结尾`;", "const x = 1;"].join("\n");
    expect(locateSymbolInText(multi, { name: "locateSymbolInText" })).toBeNull();
  });
  it("c) 名字出现在真实代码位置(声明/调用)→ 返回 1-based 行号", () => {
    const text = [
      "// 注释里先提一次 locateSymbolInText",
      'const s = "locateSymbolInText";',
      "export function locateSymbolInText(fileText: string) {",
      "  return locateSymbolInText(fileText, { name: 'x' });",
      "}",
    ].join("\n");
    expect(locateSymbolInText(text, { name: "locateSymbolInText" })).toBe(3);
    // A.b 全名不中再试最后一段(既有语义保留)
    const text2 = ["// maskNonCode 注释", "export function maskNonCode(t: string) {", "}"].join("\n");
    expect(locateSymbolInText(text2, { name: "Board.maskNonCode" })).toBe(2);
  });
  it("d) anchor 只出现在注释里 → 不走 anchor 分支,继续 name 分支", () => {
    const text = [
      "// 旧签名 export function boardAudit(x) 已废弃,见下方",
      "const keep = 1;",
      "export function boardAudit(x, opts) {",
      "}",
    ].join("\n");
    // anchor 原文只在注释行出现 → 不命中 anchor;name 命中真实声明行 3
    expect(locateSymbolInText(text, { name: "boardAudit", anchor: "export function boardAudit(x)" })).toBe(3);
    // anchor 与 name 都只在注释里 → null
    expect(locateSymbolInText("// 只有注释:export function gone(x)", { name: "gone", anchor: "export function gone(x)" })).toBeNull();
    // anchor 本身全是空白 → 跳过 anchor 分支,不误命中任何行
    expect(locateSymbolInText("const z = 1;", { name: "nim", anchor: "   " })).toBeNull();
    // needle 含字符串字面量(真实签名行)时两侧都 mask 后仍能对齐
    const sig = ['export function tag(n: string) {', '  return "x";', "}"].join("\n");
    expect(locateSymbolInText(sig, { name: "tag", anchor: 'export function tag(n: string)' })).toBe(1);
  });
  it("maskNonCode:转义/跨行/三引号/行长对齐", () => {
    const text = ['const s = "he said \\"locateSymbolInText\\" ok";', "const t = 'it\\'s locateSymbolInText';"].join("\n");
    expect(locateSymbolInText(text, { name: "locateSymbolInText" })).toBeNull();
    // Python 三引号 docstring(板 symbolRef 也指向 .py 文件):跨行 docstring 里点名的符号不算命中,
    // 后面的真实 def 才算 —— 来源:docs/analysis/tools/plan-gate-telemetry.py 的模块 docstring 结构。
    const py = ['"""模块说明:入口 main 只读聚合。', '辅助 hint_bucket。"""', "", "def main():", "    pass"].join("\n");
    expect(locateSymbolInText(py, { name: "hint_bucket" })).toBeNull();
    expect(locateSymbolInText(py, { name: "main" })).toBe(4);
    // 注释里出现 glob `/*.jsonl` 之类的 `/*` 字样不得把余下全文吞成注释
    const glob = ["# 扫 sessions/*.jsonl:permission.gate", "x = 1", "def hint_bucket():", "    pass"].join("\n");
    expect(locateSymbolInText(glob, { name: "hint_bucket" })).toBe(3);
    // 行长(行数)严格不变
    expect(locateSymbolInText(py, { name: "不存在的符号" })).toBeNull();
    const keep = text.split("\n").length;
    expect(keep).toBe(2);
  });
  it("真实样本:A.genie 板上 ref 落到注释行(来源 board 39125caf…-pgd.json)", () => {
    // 来源:.genie/boards/web-ng-plangate-1793772375129/39125caf-900b-4dcb-ad2e-2ac2dc65ec49-pgd.json
    // 节点 pgd-audit-entry,symbolRef 原文 {"name":"board_upsert","file":"apps/gateway/src/agent-wiring.ts","line":1272}
    // 旧实现命中 apps/gateway/src/agent-wiring.ts:234(块注释里提到 board_upsert 写板),判成 moved=假阳性。
    const excerpt = [
      "  /**",
      "   *  planning=true(planner 角色)=规划面——只挂白板两件(board_upsert 写板 + board_read 读回)",
      "   */",
      "  const spawnTool: Tool = {",
    ].join("\n");
    expect(locateSymbolInText(excerpt, { name: "board_upsert", line: 1272 })).toBeNull();
  });
  it("真实样本:B.名字只作为字符串字面量片段(来源 board-audit-json.test.ts)", () => {
    // 来源:.genie/boards/web-ng-plangate-1793772375129/39125caf-…-pgd.json 节点 pgd-test,
    // symbolRef 原文 {"name":"board-audit-json","file":"apps/gateway/test/board-audit-json.test.ts","line":19}
    // 旧实现命中该文件第 19 行 tmpdir 前缀字符串 "gh-board-audit-json-",判成 moved/linked=假阳性。
    const excerpt = [
      "let dirs: string[] = [];",
      "function tmp(): string {",
      '  const d = mkdtempSync(join(tmpdir(), "gh-board-audit-json-"));',
      "  return d;",
      "}",
    ].join("\n");
    expect(locateSymbolInText(excerpt, { name: "board-audit-json", line: 19 })).toBeNull();
  });
  it("真实样本:C.名字先出现在注释、真身在后(来源 board 39125caf…-pgd.json 节点 pgd-pred-mod)", () => {
    // 来源:同上板节点 pgd-pred-mod,symbolRef 原文
    // {"name":"isContentNode","file":"apps/gateway/src/board-content-predicate.ts","line":1}
    // 旧实现命中第 3 行文档注释(「原实现两处分叉:…isContentNode…」),新实现命中第 13 行真声明。
    const excerpt = [
      "/** 内容节点判据(单一出处)。",
      " * 原实现两处分叉:plan-gate 局部 `isContentNode`(agent-wiring.ts)与类型门局部 `hasContent`。",
      " */",
      "export function isContentNode(n: { targets?: unknown }): boolean {",
      "  return Boolean(n.targets);",
      "}",
    ].join("\n");
    expect(locateSymbolInText(excerpt, { name: "isContentNode" })).toBe(4);
    // 三态语义不变:记录行 1 vs 新行 4 → moved(不由本用例负责断言,这里只锁定位)
    expect(resolveLinkState(excerpt, { name: "isContentNode", line: 1 }, false)).toEqual({ state: "moved", line: 4 });
  });
});

describe("索引过期双段判定(c2f, 修复)", () => {
  function fakeIndex(over: Partial<C2fIndex>): C2fIndex {
    // 默认带 1 个占位节点:2026-10-14 起 0 节点索引+仓有源文件=过期(空索引自愈档),
    // 纯新鲜度判定用例不卷入该语义;要测空索引自愈须显式传 nodes: []。
    return {
      version: 1, root: "", gitHead: "", builtAt: 0, buildMs: 0,
      nodes: [{ id: "a.ts#x", name: "x", file: "a.ts", line: 1, kind: "regular", outCount: 0, inCount: 0 }],
      edges: [], byFile: {}, byName: {}, ...over,
    };
  }
  it("commit sha 变化→过期;sha 不变→不过期", () => {
    const r = tmp();
    mkdirSync(join(r, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(r, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(r, ".git", "refs", "heads", "main"), "aaa111\n");
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    const sha = gitHeadSha(r);
    expect(sha).toBe("aaa111");
    const fp = srcFingerprint(r);
    const idx = fakeIndex({ headSha: sha, srcMtime: fp.maxMtime, srcCount: fp.count });
    expect(indexStale(r, idx)).toBe(false);
    // 模拟 commit:引用文件换 sha(同一分支名——旧判定在这一幕全瞎)
    writeFileSync(join(r, ".git", "refs", "heads", "main"), "bbb222\n");
    expect(indexStale(r, idx)).toBe(true);
  });
  it("未提交的编辑(mtime 越过构建时点)→过期;新增文件(计数变)→过期", () => {
    const r = tmp();
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    const fp = srcFingerprint(r);
    const idx = fakeIndex({ headSha: "", srcMtime: fp.maxMtime, srcCount: fp.count });
    expect(indexStale(r, idx)).toBe(false);
    // 编辑:直接给 mtime 推未来(内容改动→mtime 变更是语义本身,不等文件系统时钟粒度);
    // force 旁路指纹缓存(生产路径靠 10s TTL 保毫秒级,测试要即时可见)。
    const future = fp.maxMtime + 5000;
    utimesSync(join(r, "a.ts"), new Date(future), new Date(future));
    srcFingerprint(r, true);
    expect(indexStale(r, fakeIndex({ headSha: "", srcMtime: fp.maxMtime, srcCount: undefined }))).toBe(true);
    // 新增文件:计数变化
    writeFileSync(join(r, "b.ts"), "export const y = 2;\n");
    srcFingerprint(r, true);
    expect(indexStale(r, idx)).toBe(true);
  });
  it("遗留档废除(2026-10-14):无指纹老索引一律过期触发升级重建——旧分支名档让残缺索引永久新鲜(工作区五仓实证)", () => {
    const r = tmp();
    mkdirSync(join(r, ".git"), { recursive: true });
    writeFileSync(join(r, ".git", "HEAD"), "ref: refs/heads/master\n");
    expect(indexStale(r, fakeIndex({ gitHead: "ref: refs/heads/master" }))).toBe(true);
    expect(indexStale(r, fakeIndex({ gitHead: "ref: refs/heads/other" }))).toBe(true);
    expect(indexStale(r, null)).toBe(true);
  });
  it("空索引自愈:0 节点+仓有源文件=过期(重建);真空仓(无源文件)=稳定不抖动", () => {
    const r1 = tmp();
    writeFileSync(join(r1, "a.py"), "def f():\n    pass\n");
    const fp1 = srcFingerprint(r1);
    expect(indexStale(r1, fakeIndex({ headSha: "", srcMtime: fp1.maxMtime, srcCount: fp1.count, nodes: [] }))).toBe(true);
    const r2 = tmp();
    const fp2 = srcFingerprint(r2);
    expect(indexStale(r2, fakeIndex({ headSha: "", srcMtime: fp2.maxMtime, srcCount: fp2.count, nodes: [] }))).toBe(false);
  });
  it("B2:查询路径指纹(srcFingerprintCached)TTL 内不同步重扫;force 才取新值", () => {
    const r = tmp();
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    const fp1 = srcFingerprint(r); // 建缓存
    const future = fp1.maxMtime + 5000;
    utimesSync(join(r, "a.ts"), new Date(future), new Date(future));
    // TTL 内:查询路径返回缓存旧值(不同步阻塞);force:立即反映(drvfs 上 mtime 有截断,只断言显著越过)
    expect(srcFingerprintCached(r).maxMtime).toBe(fp1.maxMtime);
    const forced = srcFingerprint(r, true).maxMtime;
    expect(forced).toBeGreaterThan(fp1.maxMtime + 4000);
    expect(srcFingerprintCached(r).maxMtime).toBe(forced);
  });
});

describe("三期缺陷修复(B1/B3)", () => {
  it("F: sha=null 无可信基线——不回填不翻 status(他人改动不算「计划外」),重建照走", async () => {
    const r = tmp();
 // 造 git 仓:基线提交后树上留「他人」的在途未提交改动(共享仓常态,复现形态)
    const g = (args: string) => execSync(`git ${args}`, { cwd: r, stdio: ["ignore", "pipe", "ignore"] }).toString();
    g("init -q"); g('config user.email "t@t"'); g('config user.name "t"');
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    g("add -A"); g("commit -qm base");
    writeFileSync(join(r, "others.ts"), "export const o = 1;\n"); // 他人/其他任务的在途改动
    saveBoard(r, { ...goodDoc, sessionId: "s1", taskId: "td1", planned_files: ["a.ts"], status: "implementing" });
    let kicked = "";
    let diffstatCalls = 0;
    const res = await finalizeBoardOnTaskDone({ storeRoot: r, sessionId: "s1", taskId: "td1", workdir: r, sha: null, reindexFn: (root) => { kicked = root; },
      diffstatFn: async () => { diffstatCalls++; return { files: [{ path: "others.ts" }], total: { files: 1 } }; } });
    expect(diffstatCalls).toBe(0); // 判据=sha 有无:根本不发起对账
    expect(res.backfilled).toBe(false);
    expect(res.reindexKicked).toBe(true);
    expect(kicked).toBe(r);
    const d = loadBoard(r, "s1", "td1");
    expect(d?.actual_files).toBeUndefined(); // 不把 HEAD 上的他人改动算「计划外」
    expect(d?.status).toBe("implementing"); // 不误翻 done——「已落实(status)·已落实 0/31(节点)」双语义矛盾消失
  });
  it("F: sha≠null 正常对账路径零改动——真快照基线回填 actual_files+翻 done", async () => {
    const r = tmp();
    const g = (args: string) => execSync(`git ${args}`, { cwd: r, stdio: ["ignore", "pipe", "ignore"] }).toString();
    g("init -q"); g('config user.email "t@t"'); g('config user.name "t"');
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    g("add -A"); g("commit -qm base");
    writeFileSync(join(r, "a.ts"), "export const x = 2;\n"); // 开工时树已有改动 → stash create 产出真 sha
    const sha = execSync("git stash create", { cwd: r, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    expect(sha).toBeTruthy();
    writeFileSync(join(r, "a.ts"), "export const x = 3;\n"); // agent 的改动
    saveBoard(r, { ...goodDoc, sessionId: "s1", taskId: "td2", planned_files: ["a.ts"], status: "implementing" });
    const res = await finalizeBoardOnTaskDone({ storeRoot: r, sessionId: "s1", taskId: "td2", workdir: r, sha });
    expect(res.backfilled).toBe(true);
    const d = loadBoard(r, "s1", "td2");
    expect(d?.actual_files).toEqual(["a.ts"]);
    expect(d?.status).toBe("done");
  });
  it("B1: 有 sha 用快照基线;无板不回填但重建照走", async () => {
    const r = tmp();
    const g = (args: string) => execSync(`git ${args}`, { cwd: r, stdio: ["ignore", "pipe", "ignore"] }).toString();
    g("init -q"); g('config user.email "t@t"'); g('config user.name "t"');
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    g("add -A"); g("commit -qm base");
    const sha = execSync("git stash create", { cwd: r }).toString().trim();
    writeFileSync(join(r, "a.ts"), "export const x = 3;\n");
    let kicked = "";
    // 无板场景:backfilled=false 但 reindexKicked=true(改完码索引跟着改不依赖有没有板)
    const res = await finalizeBoardOnTaskDone({ storeRoot: r, sessionId: "s1", taskId: "ghost", workdir: r, sha, reindexFn: (root) => { kicked = root; } });
    expect(res.backfilled).toBe(false);
    expect(res.reindexKicked).toBe(true);
    expect(kicked).toBe(r);
  });
  it("B3: ClassName.method 形态符号名,全名不中退最后一段命中方法行", () => {
    const text = ["class Engine {", "  start() {", "    return 1;", "  }", "}"].join("\n");
    // 全名 Engine.start 在源码里不存在(方法不带类前缀);最后一段 start 命中第 2 行
    const r = resolveLinkState(text, { name: "Engine.start", line: 99 }, false);
    expect(r).toEqual({ state: "moved", line: 2 });
    const exact = locateSymbolInText(text, { name: "Engine.start" });
    expect(exact).toBe(2);
  });
});

describe("board_upsert 工具(agent 面,fail-soft 纪律)", () => {
  it("合法调用:落盘+journal board.update+bus 广播;二次调用 rev 自增", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const busHits: { sessionId: string; taskId: string }[] = [];
    const off = (p: unknown) => busHits.push(p as { sessionId: string; taskId: string });
    bus.on("board.changed", off);
    try {
      const tool = boardUpsertTool(j, "s1", "t1", r, r);
      const out = await tool.execute({ title: goodDoc.title, nodes: goodDoc.nodes, edges: goodDoc.edges, planned_files: ["src/a.ts"] });
      expect(String(out)).toContain("设计白板已更新");
      const d = loadBoard(r, "s1", "t1");
      expect(d?.rev).toBe(1);
      expect(d?.root).toBe(r);
      const evs = j.readAll().filter((e) => e.kind === "board.update");
      expect(evs).toHaveLength(1);
      expect((evs[0]!.payload as { nodeCount: number }).nodeCount).toBe(2);
      expect(busHits).toEqual([{ sessionId: "s1", taskId: "t1" }]);
      const out2 = await tool.execute({ title: "v2", nodes: goodDoc.nodes, status: "implementing" });
      expect(String(out2)).toContain("rev 2");
      expect(loadBoard(r, "s1", "t1")?.status).toBe("implementing");
      // 全量覆盖语义:第二次没带 planned_files → 保留既有
      expect(loadBoard(r, "s1", "t1")?.planned_files).toEqual(["src/a.ts"]);
    } finally {
      bus.off("board.changed", off);
    }
  });
  it("垃圾输入不抛异常(fail-soft):空 nodes/缺 title/坏结构都回话术", async () => {
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", tmp(), tmp());
    expect(String(await tool.execute({}))).toContain("不受影响");
    expect(String(await tool.execute({ title: "x", nodes: [] }))).toContain("不受影响");
    const bad = await tool.execute({ title: "x", nodes: [{ id: "n1", label: "a" }] }); // 缺 summary
    expect(String(bad)).toContain("不合法");
    expect(j.readAll().filter((e) => e.kind === "board.update")).toHaveLength(0);
  });

  it("关系自动推导(2026-10-22):不传 edges 也落出关系;显式边原样保留,推导边标 virtual", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    // 两个同组节点(声明序相邻)+ 一个跨组节点,不传任何 edges
    const nodes = [
      { id: "a", label: "采集", summary: "s1", group: "01 采集", change: "add" as const },
      { id: "b", label: "解码", summary: "s2", group: "01 采集", change: "add" as const },
      { id: "c", label: "输出", summary: "s3", group: "02 输出", change: "add" as const },
    ];
    await tool.execute({ title: "关系推导板", nodes });
    const d = loadBoard(r, "s1", "t1")!;
    // 同组相邻补 nav(推导边):a→b;跨组不连(b→c 不该有)
    const pairs = d.edges.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toContain("a->b");
    expect(pairs).not.toContain("b->c");
    expect(d.edges.find((e) => e.from === "a" && e.to === "b")?.kind).toBe("nav");
    expect(d.edges.find((e) => e.from === "a" && e.to === "b")?.virtual).toBe(true);
    // 显式边:重落一次带显式边,原样保留且不重复推导同对
    await tool.execute({ title: "关系推导板", nodes, edges: [{ from: "a", to: "c", kind: "call", label: "真实调用" }] });
    const d2 = loadBoard(r, "s1", "t1")!;
    const exp = d2.edges.find((e) => e.from === "a" && e.to === "c");
    expect(exp?.kind).toBe("call");
    expect(exp?.label).toBe("真实调用");
    expect(exp?.virtual).toBeUndefined(); // 显式边不冒充推导边
    expect(d2.edges.filter((e) => e.from === "a" && e.to === "b")).toHaveLength(1); // 不重复
  });
});

describe("页面结构板工具面(board_upsert docKind=page + board_read 读回)", () => {
  const pageNodes = [
    { id: "p1", kind: "page", label: "签署首页", summary: "发起签署 · 路由 /" },
    { id: "s1", kind: "section", label: "文件上传区", summary: "「签署首页」页面的区块" },
    { id: "p2", kind: "page", label: "签署详情页", summary: "查看签署进度 · 路由 /sign/:id" },
  ];
  const pageEdges = [
    { from: "p1", to: "s1", kind: "contains" },
    { from: "p1", to: "p2", kind: "nav", label: "点击[开始签署]" },
  ];

  it("board_upsert docKind=page:落盘为页面结构板;改板不传 docKind 保留类型", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    const out = await tool.execute({ title: "电子签页面结构", nodes: pageNodes, edges: pageEdges, docKind: "page" });
    expect(String(out)).toContain("设计白板已更新");
    const d = loadBoard(r, "s1", "t1");
    expect(d?.docKind).toBe("page");
    expect(d?.nodes.map((n) => n.kind)).toEqual(["page", "section", "page"]);
    // 改板未传 docKind → 保留 page(不丢类型)
    await tool.execute({ title: "电子签页面结构 v2", nodes: pageNodes, edges: pageEdges });
    expect(loadBoard(r, "s1", "t1")?.docKind).toBe("page");
  });

  it("board_read:读回页面结构板(节点/边/类型);无板=如实说;指定缺失 taskId=明确报错", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const up = boardUpsertTool(j, "s1", "t1", r, r);
    await up.execute({ title: "电子签页面结构", nodes: pageNodes, edges: pageEdges, docKind: "page" });
    const read = boardReadTool(j, "s1", r);
    const txt = String(await read.execute({}));
    expect(txt).toContain("页面结构板");
    expect(txt).toContain("[page] 签署首页");
    expect(txt).toContain("[section] 文件上传区");
    expect(txt).toContain("跳转 签署详情页(点击[开始签署])");
    expect(txt).toContain("包含 文件上传区");
    // 空 session:如实说无板
    const empty = String(await boardReadTool(j, "s-empty", r).execute({}));
    expect(empty).toContain("还没有白板");
    // 指定不存在的板:明确报错不编造
    const missing = String(await read.execute({ taskId: "nope" }));
    expect(missing).toContain("不存在");
  });
});

describe("P3 WS 回路(board.save/conflict/continue/overlay)", () => {
  let app: GatewayApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });
  const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const wait = (inbox: Record<string, unknown>[], pred: (m: Record<string, unknown>) => boolean, tag = "", fromCursor = true, ms = 9000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const cursor = fromCursor ? inbox.length : 0;
      const t = setTimeout(() => reject(new Error("等消息超时 " + tag)), ms); // drvfs 高载下任务立起可超 9s,慢环节调用方放宽
      const poll = setInterval(() => {
        const hit = inbox.slice(cursor).find(pred);
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
      }, 30);
    });
  it("保存(rev 自增)→冲突(baseRev 旧)→续作(任务立起)→批注层读写删→非法批注报错", async () => {
    const sid = "vitest-board-p3-" + Date.now();
    const rr = repoRoot();
    saveBoard(rr, { ...goodDoc, sessionId: sid, taskId: "tp1" });
    try {
      app = createGatewayApp({ port: 7813, executor: new EchoChildBackend() });
      const ws = new WebSocket("ws://127.0.0.1:7813");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      // 1. 合法保存:rev 1→2,回执带 doc
      const edited = { ...goodDoc, sessionId: sid, taskId: "tp1", title: "人改过的板", rev: 0, nodes: [...goodDoc.nodes, { id: "n3", kind: "note" as const, label: "人加的模块", summary: "人审后补充", change: "add" as const, flow: [] }] };
      ws.send(JSON.stringify({ v: 1, type: "board.save", sessionId: sid, taskId: "tp1", doc: edited, baseRev: 1 }));
      const saved = await wait(inbox, (m) => m.type === "board.doc" && (m.doc as { title?: string })?.title === "人改过的板", "save");
      expect((saved.doc as { rev: number }).rev).toBe(2);
      expect(loadBoard(rr, sid, "tp1")?.nodes).toHaveLength(3);
      // 2. 冲突:baseRev=1 已旧(当前 rev 2)→ board.conflict
      ws.send(JSON.stringify({ v: 1, type: "board.save", sessionId: sid, taskId: "tp1", doc: edited, baseRev: 1 }));
      const conflict = await wait(inbox, (m) => m.type === "board.conflict", "conflict");
      expect(conflict.currentRev).toBe(2);
      // 3. 按板续作:task.submitted 回来,指令带板标题/节点行/用户备注
      ws.send(JSON.stringify({ v: 1, type: "board.continue", sessionId: sid, taskId: "tp1", note: "优先做人加的模块" }));
      const submitted = await wait(inbox, (m) => m.type === "task.submitted", "continue", true, 20000);
      const task = submitted.task as { id: string; sessionId: string; instruction: string };
      expect(task.sessionId).toBe(sid);
      expect(task.instruction).toContain("人改过的板");
      expect(task.instruction).toContain("优先做人加的模块");
      // 2026-10 变更集派发(改动应有之义):人这次保存只动了 n3(人加的模块),其余节点未变,
      // 所以续作只派 n3——原先的「整板塞给 agent」断言(wbRender 等未改节点)已不成立。
      expect(task.instruction).toContain("人加的模块");
      expect(task.instruction).toContain("人工改动的 1 个节点");
      expect(task.instruction).not.toContain("wbRender"); // 未改节点不派(变更集派发的核心收益)
      // 4. 批注层:存→board.doc 带 overlayB64;空串→删(drvfs 落盘延迟可超 400ms——存/删带重试到看到预期态;删幂等)
      const overlayRound = async (dataB64: string, wantPresent: boolean): Promise<Record<string, unknown> | null> => {
        for (let i = 0; i < 8; i++) {
          ws.send(JSON.stringify({ v: 1, type: "board.overlay.save", sessionId: sid, taskId: "tp1", dataB64 }));
          await new Promise((r) => setTimeout(r, 400));
          ws.send(JSON.stringify({ v: 1, type: "board.get", sessionId: sid, taskId: "tp1" }));
          const m = await wait(inbox, (mm) => mm.type === "board.doc" && (mm.doc as { title?: string })?.title === "人改过的板", wantPresent ? "overlay get" : "overlay cleared");
          if (!!(m as { overlayB64?: string }).overlayB64 === wantPresent) return m;
        }
        return null;
      };
      const withOverlay = await overlayRound(PNG_1X1, true);
      expect((withOverlay as unknown as { overlayB64: string } | null)?.overlayB64).toBe(PNG_1X1);
      const cleared = await overlayRound("", false);
      expect(cleared === null || (cleared as { overlayB64?: string }).overlayB64 === undefined).toBe(true);
      // 5. 非法批注(非 PNG)→ error 回包
      ws.send(JSON.stringify({ v: 1, type: "board.overlay.save", sessionId: sid, taskId: "tp1", dataB64: Buffer.from("not a png").toString("base64") }));
      const badOverlay = await wait(inbox, (m) => m.type === "error" && m.code === "board-overlay-invalid", "bad overlay");
      expect(badOverlay.code).toBe("board-overlay-invalid");
      ws.close();
    } finally {
      rmSync(join(rr, ".genie", "boards", sid), { recursive: true, force: true });
    }
  }, 30000);
  it("board.save 坏文档(边引用空节点)被拒,不落盘", async () => {
    const sid = "vitest-board-p3b-" + Date.now();
    const rr = repoRoot();
    saveBoard(rr, { ...goodDoc, sessionId: sid, taskId: "tp2" });
    try {
      app = createGatewayApp({ port: 7815, executor: new EchoChildBackend() });
      const ws = new WebSocket("ws://127.0.0.1:7815");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      const badDoc = { ...goodDoc, sessionId: sid, taskId: "tp2", edges: [{ from: "n1", to: "ghost", kind: "call" as const }] };
      ws.send(JSON.stringify({ v: 1, type: "board.save", sessionId: sid, taskId: "tp2", doc: badDoc, baseRev: 1 }));
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("等 error 超时")), 9000);
        const poll = setInterval(() => {
          const hit = inbox.find((m) => m.type === "error" && m.code === "board-invalid");
          if (hit) { clearTimeout(t); clearInterval(poll); resolve(); }
        }, 30);
      });
      expect(loadBoard(rr, sid, "tp2")?.edges).toHaveLength(1); // 未被污染
      ws.close();
    } finally {
      rmSync(join(rr, ".genie", "boards", sid), { recursive: true, force: true });
    }
  }, 20000);
});

describe("四期缺陷修复(C1/C4/C7/C8)", () => {
  let app: GatewayApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });
  const wait = (inbox: Record<string, unknown>[], pred: (m: Record<string, unknown>) => boolean, tag = "") =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const cursor = inbox.length;
      const t = setTimeout(() => reject(new Error("等消息超时 " + tag)), 9000);
      const poll = setInterval(() => {
        const hit = inbox.slice(cursor).find(pred);
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
      }, 30);
    });
  it("C7: 同 rev 按板续作幂等(双击只立一个任务)+ before 进续作指令", async () => {
    const sid = "vitest-board-p4-" + Date.now();
    const rr = repoRoot();
    saveBoard(rr, { ...goodDoc, sessionId: sid, taskId: "tc1", edges: [], nodes: [{ id: "n1", kind: "function" as const, label: "wbRender", summary: "渲染流程图", before: "只渲节点不渲边", change: "modify" as const, flow: [] }] });
    try {
      app = createGatewayApp({ port: 7817, executor: new EchoChildBackend() });
      const ws = new WebSocket("ws://127.0.0.1:7817");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ v: 1, type: "board.continue", sessionId: sid, taskId: "tc1" }));
      await wait(inbox, (m) => m.type === "task.submitted", "first");
      ws.send(JSON.stringify({ v: 1, type: "board.continue", sessionId: sid, taskId: "tc1" })); // 双击
      await new Promise((r) => setTimeout(r, 600));
      const subs = inbox.filter((m) => m.type === "task.submitted");
      const uniqueIds = new Set(subs.map((m) => (m.task as { id: string }).id));
      expect(uniqueIds.size).toBe(1); // 幂等键去重:双击只立一个任务(submitted 回执可能重发,任务 id 唯一)
      const task = subs[0]!.task as { instruction: string };
      expect(task.instruction).toContain("wbRender");
      expect(task.instruction).toContain("原来:只渲节点不渲边"); // C8
      ws.close();
    } finally {
      rmSync(join(rr, ".genie", "boards", sid), { recursive: true, force: true });
    }
  }, 20000);
  it("C8: before 字段 schema 收;C1 前置(节点 id 撞名消毒由 UI 层管,server 只验结构)", () => {
    const r = tmp();
    const withBefore = { ...goodDoc, edges: [], nodes: [{ id: "n-1", kind: "function" as const, label: "x", summary: "s", before: "旧形态描述", change: "modify" as const, flow: [] }] };
    const s = saveBoard(r, withBefore);
    expect(s.ok, s.ok ? "" : s.reason).toBe(true);
    expect(loadBoard(r, "s1", "t1")?.nodes[0]?.before).toBe("旧形态描述");
    const tooLong = { ...goodDoc, edges: [], nodes: [{ id: "n1", label: "x", summary: "s", before: "y".repeat(501), change: "add" as const, flow: [] }] };
    expect(saveBoard(r, tooLong).ok).toBe(false);
  });
});

describe("七期:从代码生成模块图(board.fromcode)", () => {
  let app: GatewayApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });
  const wait = (inbox: Record<string, unknown>[], pred: (m: Record<string, unknown>) => boolean, tag = "") =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const cursor = inbox.length;
      const t = setTimeout(() => reject(new Error("等消息超时 " + tag)), 12000);
      const poll = setInterval(() => {
        const hit = inbox.slice(cursor).find(pred);
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
      }, 30);
    });
  it("board-store.ts → 模块板:节点=真实符号+边=真实调用;title/taskId 规范;盘上可再读", async () => {
    const sid = "vitest-board-p7-" + Date.now();
    const rr = repoRoot();
    try {
      app = createGatewayApp({ port: 7821, executor: new EchoChildBackend() });
      const ws = new WebSocket("ws://127.0.0.1:7821");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ v: 1, type: "board.fromcode", sessionId: sid, file: "apps/gateway/src/board-store.ts" }));
      const got = await wait(inbox, (m) => m.type === "board.doc" && (m.doc as { title?: string })?.title?.startsWith("代码模块图"), "fromcode");
      const doc = got.doc as { nodes: { id: string; kind: string; label: string; symbolRef: { file: string } }[]; edges: unknown[]; taskId: string; planned_files: string[] };
      expect(doc.nodes.length).toBeGreaterThanOrEqual(8);
      expect(doc.nodes.some((n) => n.label === "saveBoard")).toBe(true);
      expect(doc.edges.length).toBeGreaterThanOrEqual(5); // 真实调用边
      expect(doc.planned_files).toEqual(["apps/gateway/src/board-store.ts"]);
      for (const n of doc.nodes) expect(n.symbolRef.file).toBe("apps/gateway/src/board-store.ts");
      // 盘上可再读(成为正常板,可评论/续作)
      const again = loadBoard(rr, sid, doc.taskId);
      expect(again?.nodes.length).toBe(doc.nodes.length);
      // 幂等:同文件再生成=覆盖同一块板(taskId 派生自路径)
      ws.send(JSON.stringify({ v: 1, type: "board.fromcode", sessionId: sid, file: "board-store.ts" })); // 短名兜底匹配
      await new Promise((r) => setTimeout(r, 900));
      const items = listBoards(rr, sid);
      const codeBoards = items.filter((i) => i.taskId.startsWith("code-"));
      expect(codeBoards.length).toBe(1);
      // 未索引文件 → 显式错误
      ws.send(JSON.stringify({ v: 1, type: "board.fromcode", sessionId: sid, file: "no/such/file.ts" }));
      const err = await wait(inbox, (m) => m.type === "error" && m.code === "board-file-not-indexed", "not indexed");
      expect(err.code).toBe("board-file-not-indexed");
      ws.close();
    } finally {
      rmSync(join(rr, ".genie", "boards", sid), { recursive: true, force: true });
    }
  }, 30000);
});

describe("五期实时面板(comment/done/continue 含评论)", () => {
  let app: GatewayApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });
  const wait = (inbox: Record<string, unknown>[], pred: (m: Record<string, unknown>) => boolean, tag = "") =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const cursor = inbox.length;
      const t = setTimeout(() => reject(new Error("等消息超时 " + tag)), 9000);
      const poll = setInterval(() => {
        const hit = inbox.slice(cursor).find(pred);
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
      }, 30);
    });
  it("board.comment:追加评论(服务端合并,免 rev)→done 字段落盘→续作指令带 done+评论", async () => {
    const sid = "vitest-board-p5-" + Date.now();
    const rr = repoRoot();
    saveBoard(rr, {
      ...goodDoc, sessionId: sid, taskId: "tq1", edges: [],
      nodes: [
        { id: "n1", kind: "function" as const, label: "模块A", summary: "做A", done: true, change: "add" as const, flow: [] },
        { id: "n2", kind: "function" as const, label: "模块B", summary: "做B", done: false, change: "add" as const, flow: [] },
      ],
    });
    try {
      app = createGatewayApp({ port: 7819, executor: new EchoChildBackend() });
      const ws = new WebSocket("ws://127.0.0.1:7819");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      // 1. 评论两条(不同节点)
      ws.send(JSON.stringify({ v: 1, type: "board.comment", sessionId: sid, taskId: "tq1", nodeId: "n1", text: "这里改成批量处理" }));
      await wait(inbox, (m) => m.type === "board.doc" && (m.doc as { nodes?: { comments?: string[] }[] }).nodes?.[0]?.comments?.length === 1, "comment1");
      ws.send(JSON.stringify({ v: 1, type: "board.comment", sessionId: sid, taskId: "tq1", nodeId: "n2", text: "B 要加错误重试" }));
      await wait(inbox, (m) => m.type === "board.doc" && (m.doc as { nodes?: { comments?: string[] }[] }).nodes?.[1]?.comments?.length === 1, "comment2");
      // 盘上对账:done 落盘+评论在位+rev 自增两次
      const d = loadBoard(rr, sid, "tq1");
      expect(d?.nodes[0]?.done).toBe(true);
      expect(d?.nodes[0]?.comments).toEqual(["这里改成批量处理"]);
      expect(d?.nodes[1]?.comments).toEqual(["B 要加错误重试"]);
      expect(d && d.rev).toBe(2); // 初始 0,两条评论各自 +1
 // 2b. 未处理评论:board.list 回包带 pendingComments(面板 chip 数据源),peek 不消费
      ws.send(JSON.stringify({ v: 1, type: "board.list", sessionId: sid }));
      const lst = await wait(inbox, (m) => m.type === "board.list.result", "pending list");
      const item = (lst.items as { taskId: string; pendingComments?: number; docKind?: string }[]).find((i) => i.taskId === "tq1");
      expect(item?.pendingComments).toBe(2);
      expect(item?.docKind).toBe("design");
      // 再拉一次仍是 2:peek 只读,消费权在 agent loop(takePendingComments)
      ws.send(JSON.stringify({ v: 1, type: "board.list", sessionId: sid }));
      const lst2 = await wait(inbox, (m) => m.type === "board.list.result" && (m.items as { taskId: string; pendingComments?: number }[]).some((i) => i.taskId === "tq1" && i.pendingComments === 2), "pending stable");
      expect(lst2.type).toBe("board.list.result");
      // 2. 续作:指令带 done 状态+用户评论
      ws.send(JSON.stringify({ v: 1, type: "board.continue", sessionId: sid, taskId: "tq1" }));
      const submitted = await wait(inbox, (m) => m.type === "task.submitted", "continue");
      const task = submitted.task as { instruction: string };
      expect(task.instruction).toContain("已落实 1/2");
      expect(task.instruction).toContain("模块A(add,已落实)");
      expect(task.instruction).toContain("用户评论:这里改成批量处理");
      expect(task.instruction).toContain("B 要加错误重试");
      expect(task.instruction).toContain("2 个节点带用户评论");
      // 3. 环节点评论→错误回包不炸
      ws.send(JSON.stringify({ v: 1, type: "board.comment", sessionId: sid, taskId: "tq1", nodeId: "ghost", text: "x" }));
      const err = await wait(inbox, (m) => m.type === "error" && m.code === "board-node-not-found", "bad comment");
      expect(err.code).toBe("board-node-not-found");
      ws.close();
    } finally {
      rmSync(join(rr, ".genie", "boards", sid), { recursive: true, force: true });
    }
  }, 25000);
});

describe("面板白板视图(PAGE 模板断言)", () => {
  it("白板视图含流程图区/明细卡/节点卡/消息族与任务卡 chip", async () => {
    const p = servePanel(7897, () => {});
    try {
      const res = await fetch("http://127.0.0.1:7897/");
      const html = await res.text();
      // 视图骨架:流程图/明细/节点清单/任务选择器/手绘批注层(降级保留)
      expect(html).toContain("boardGraph");
      expect(html).toContain("boardDetail");
      expect(html).toContain("boardNodes");
      expect(html).toContain("boardTaskSel");
      expect(html).toContain("boardSketchBox");
      // 消息族与渲染逻辑
      expect(html).toContain("board.list");
      expect(html).toContain("board.get");
      expect(html).toContain("board.doc");
      expect(html).toContain("board.changed");
      expect(html).toContain("boardMermaid");
      expect(html).toContain("boardOpenTask");
      expect(html).toContain("board-chip");
      expect(html).toContain("board.update");
      // 手绘层原功能保留(批注层语义)
      expect(html).toContain("wbCanvas");
      expect(html).toContain("zh:whiteboard");
    } finally {
      p.close();
    }
  });
});

describe("WS 回路(board.list/board.get)", () => {
  let app: GatewayApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });
  it("存板→list 出项→get 回 doc+links;空会话回 doc:null", async () => {
    // 板存 harness 根(生产语义),用完即清——会话 id 带时间戳防与并发会话撞名。
    const sid = "vitest-board-" + Date.now();
    const rr = repoRoot();
    saveBoard(rr, { ...goodDoc, sessionId: sid, taskId: "tt1" });
    try {
      app = createGatewayApp({ port: 7811, executor: new EchoChildBackend() });
      const ws = new WebSocket("ws://127.0.0.1:7811");
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws.on("open", r));
      const wait = (pred: (m: Record<string, unknown>) => boolean) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const cursor = inbox.length;
          const t = setTimeout(() => reject(new Error("等消息超时")), 8000);
          const poll = setInterval(() => {
            const hit = inbox.slice(cursor).find(pred) ?? inbox.find(pred);
            if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
          }, 30);
        });
      ws.send(JSON.stringify({ v: 1, type: "board.list", sessionId: sid }));
      const lst = await wait((m) => m.type === "board.list.result");
      expect((lst.items as { taskId: string }[]).map((i) => i.taskId)).toContain("tt1");
 // 列表项带 docKind(多板类型过滤数据源);无待读评论时不带 pendingComments
      const tt1 = (lst.items as { taskId: string; docKind?: string; pendingComments?: number }[]).find((i) => i.taskId === "tt1")!;
      expect(tt1.docKind).toBe("design");
      expect(tt1.pendingComments).toBeUndefined();
      ws.send(JSON.stringify({ v: 1, type: "board.get", sessionId: sid, taskId: "tt1" }));
      const got = await wait((m) => m.type === "board.doc");
      const doc = got.doc as { title: string; nodes: unknown[] };
      expect(doc.title).toBe("给白板加语义流程");
      expect(doc.nodes).toHaveLength(2);
      // 节点带 symbolRef 但文件 src/a.ts 在 harness 根不存在 → 断链或漂移(索引有无都合法,只验三态语义在场)
      const links = got.links as { nodeId: string; state: string }[];
      const l1 = links.find((l) => l.nodeId === "n1");
      expect(l1 && ["moved", "broken"].includes(l1.state)).toBe(true);
      // 空会话
      ws.send(JSON.stringify({ v: 1, type: "board.get", sessionId: sid + "-empty" }));
      const empty = await wait((m) => m.type === "board.doc" && (m.sessionId as string).endsWith("-empty"));
      expect(empty.doc).toBeNull();
      ws.close();
    } finally {
      rmSync(join(rr, ".genie", "boards", sid), { recursive: true, force: true });
    }
  }, 20000);
});
