/**
 * code-sense 在 ref/ 各项目上的质量验证探针(第三轮验收,2026-10-14)。
 * 用法: NODE_OPTIONS=--conditions=development npx tsx scripts/validate-codesense-ref.ts <cmd> ...
 *   build <repo>            建索引(耗时/节点/边/截断)并落 /tmp/gh-ref-idx/<repo>.json
 *   stats <repo>            载入索引统计(含截断检测)
 *   top <repo> [n]          被调最多的符号(对拍候选)
 *   eps <repo> [limit]      入口清单(生产/测试分列)
 *   sym <repo> <name>       querySymbol 明细(callers/callees 全列)
 *   pair <repo> <name>...   callers 对拍 grep 真值:召回率/虚报(逐符号)
 *   file <repo> <path>      queryFile + renderFile
 *   graph <repo> <name>     renderNeighborhood(mermaid 落 /tmp/gh-ref-shots/)
 * 索引产物只写 /tmp,不写 ref/(只读纪律)。
 */
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildC2fIndex, loadIndex as _unusedLoad, querySymbol, queryFile, queryEntryPoints,
  renderNeighborhood, renderFile, srcFingerprint,
  type C2fIndex,
} from "../packages/code-sense/src/callgraph/c2f";
import { listSourceFiles, GRAPH_SKIP_DIRS, GRAPH_SOURCE_EXT } from "../packages/code-sense/src/callgraph/engine";

void _unusedLoad;
const REFS = join(new URL("..", import.meta.url).pathname, "ref");
const OUT = "/tmp/gh-ref-idx";
const SHOTS = "/tmp/gh-ref-shots";

function repoPath(repo: string): string {
  const p = join(REFS, repo);
  if (!existsSync(p)) throw new Error(`ref/${repo} 不存在`);
  return p;
}

/** 独立全量枚举(无 4000 上限,同 skip 口径)——测截断。 */
function fullWalk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") || GRAPH_SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (out.length < 40000) stack.push(full);
      } else if (GRAPH_SOURCE_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) out.push(full);
    }
  }
  return out;
}

async function cmdBuild(repo: string): Promise<void> {
  const root = repoPath(repo);
  const t0 = Date.now();
  const idx = await buildC2fIndex(root);
  const wallMs = Date.now() - t0;
  mkdirSync(OUT, { recursive: true });
  const json = JSON.stringify(idx);
  writeFileSync(join(OUT, `${repo}.json`), json);
  const listed = await listSourceFiles(root, 100000);
  const all = fullWalk(root);
  const listedSet = new Set(listed);
  const truncated = all.filter((f) => !listedSet.has(f));
  console.log(JSON.stringify({
    repo, buildMsGraph: idx.buildMs, wallMs,
    nodes: idx.nodes.length, edges: idx.edges.length,
    trunk: idx.nodes.filter((n) => n.kind === "trunk").length,
    jsonMB: (json.length / 1048576).toFixed(1),
    filesEnumerated: listed.length, filesOnDisk: all.length,
    truncatedAway: truncated.length,
    truncatedSample: truncated.slice(0, 5).map((f) => f.replace(root + "/", "")),
  }, null, 1));
}

function loadIdx(repo: string): C2fIndex {
  const p = join(OUT, `${repo}.json`);
  if (!existsSync(p)) throw new Error(`索引不存在: ${p}(先 build)`);
  return JSON.parse(readFileSync(p, "utf-8")) as C2fIndex;
}

function cmdStats(repo: string): void {
  const idx = loadIdx(repo);
  const byKind = { trunk: 0, leaf: 0, regular: 0 };
  for (const n of idx.nodes) byKind[n.kind]++;
  const extCount = new Map<string, number>();
  for (const n of idx.nodes) {
    const ext = n.file.slice(n.file.lastIndexOf("."));
    extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }
  const zeroEdgeNodes = idx.nodes.filter((n) => n.outCount === 0 && n.inCount === 0).length;
  console.log(JSON.stringify({
    repo, nodes: idx.nodes.length, edges: idx.edges.length, byKind, byExt: Object.fromEntries(extCount),
    isolatedNodes: zeroEdgeNodes, buildMs: idx.buildMs,
    jsonMB: (statSync(join(OUT, `${repo}.json`)).size / 1048576).toFixed(1),
  }, null, 1));
}

function cmdTop(repo: string, n = 20): void {
  const idx = loadIdx(repo);
  const top = [...idx.nodes].sort((a, b) => b.inCount - a.inCount).slice(0, n);
  for (const t of top) console.log(`${t.name}  in=${t.inCount} out=${t.outCount}  ${t.file}:${t.line} [${t.kind}]`);
}

function cmdEps(repo: string, limit = 30): void {
  const idx = loadIdx(repo);
  const eps = queryEntryPoints(idx, limit * 3);
  const isTest = (f: string): boolean => {
    const segs = f.split("/");
    if (segs.some((s) => /^tests?$/i.test(s) || s === "__tests__")) return true;
    const base = segs[segs.length - 1] ?? "";
    return /^test_/.test(base) || /\.test\./.test(base) || /_test\.py$/.test(base);
  };
  const prod = eps.filter((n) => !isTest(n.file));
  const test = eps.filter((n) => isTest(n.file));
  const allTrunk = idx.nodes.filter((n) => n.kind === "trunk");
  const allTest = allTrunk.filter((n) => isTest(n.file));
  console.log(`trunk 总数=${allTrunk.length}(其中测试路径=${allTest.length})`);
  console.log("--- 生产入口 top ---");
  for (const e of prod.slice(0, limit)) console.log(`  ${e.name} — ${e.file}:${e.line} (下游 ${e.outCount})`);
  console.log(`--- 测试入口(前 5,共 ${test.length})---`);
  for (const e of test.slice(0, 5)) console.log(`  ${e.name} — ${e.file}:${e.line} (下游 ${e.outCount})`);
}

function cmdSym(repo: string, name: string): void {
  const idx = loadIdx(repo);
  const hits = querySymbol(idx, name);
  if (hits.length === 0) { console.log(`未找到符号: ${name}`); return; }
  for (const h of hits) {
    console.log(`== ${h.symbol.name} [${h.symbol.kind}] ${h.symbol.file}:${h.symbol.line} (${h.symbol.kind === "trunk" ? "入口" : h.symbol.kind === "leaf" ? "叶子" : "常规"})`);
    console.log(`  被调用 ${h.callers.length}:`);
    for (const c of h.callers) console.log(`    ${c.name}@${c.file}:${c.line}`);
    console.log(`  调用 ${h.callees.length}:`);
    for (const c of h.callees) console.log(`    ${c.name}@${c.file}:${c.line}`);
  }
}

// ---- 对拍:grep 真值 vs 索引 callers ----

const DEF_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*(?:async\s+)?def\s+NAME\s*\(/, "py"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*NAME\s*\(/, "ts"],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+NAME\b/, "ts"],
  [/^\s*func\s+(?:\([^)]*\)\s*)?NAME\s*\(/, "go"],
  [/^\s*(?:public|private|protected).*\bNAME\s*\(/, "java"],
  [/^\s*(?:const|let|var)\s+NAME\s*=/, "ts"],
  [/^\s*NAME\s*(?::\s*[A-Za-z_<>\[\]|,\s]+)?\s*=\s*(?:async\s*)?\(/, "ts-arrow"],
];

function isDefinitionLine(line: string, name: string): boolean {
  for (const [re] of DEF_PATTERNS) {
    const r = new RegExp(re.source.replace("NAME", name.replace(/\$/g, "\\$")));
    if (r.test(line)) return true;
  }
  return false;
}

/** grep 真值:全仓扫描 name 的「调用形态」行(排除定义行),返回文件→行号列表。 */
function truthCalls(root: string, name: string): Map<string, number[]> {
  const truth = new Map<string, number[]>();
  const callRe = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") || GRAPH_SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!GRAPH_SOURCE_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) continue;
      let text: string;
      try { text = readFileSync(full, "utf-8"); } catch { continue; }
      const lines = text.split("\n");
      const defFile = lines.some((l) => isDefinitionLine(l, name));
      const hits: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!callRe.test(lines[i]!)) continue;
        if (defFile && isDefinitionLine(lines[i]!, name)) continue;
        hits.push(i + 1);
      }
      if (hits.length) truth.set(full.replace(root + "/", ""), hits);
    }
  }
  return truth;
}

function cmdPair(repo: string, names: string[]): void {
  const root = repoPath(repo);
  const idx = loadIdx(repo);
  const callRe = (name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`);
  const summary: unknown[] = [];
  for (const name of names) {
    const hits = querySymbol(idx, name);
    const truth = truthCalls(root, name);
    if (hits.length === 0) {
      console.log(`\n### ${name}: 索引未找到(grep 真值文件数=${truth.size})`);
      summary.push({ name, indexed: false, truthFiles: truth.size });
      continue;
    }
    // 取「真值覆盖最大」的命中(重名时按调用者最多者评)
    const h = [...hits].sort((a, b) => b.callers.length - a.callers.length)[0]!;
    // 行级核验用边上的调用点行(而非调用方定义行):索引声称该行发生了对该符号的调用
    const callSites = idx.edges.filter((e) => e.to === h.symbol.id);
    const idxFiles = new Set(callSites.map((e) => e.from.split("#")[0]!.replace(/^\/tmp\/mcp-root\//, "")));
    const truthFiles = new Set(truth.keys());
    const truthOnly = [...truthFiles].filter((f) => !idxFiles.has(f));
    const idxOnly = [...idxFiles].filter((f) => !truthFiles.has(f));
    // 调用点行核验:边上 file:line 是否真含该符号的调用形态
    const unverified: string[] = [];
    for (const e of callSites) {
      if (e.line === 0 || !e.file) continue;
      let ok = false;
      try {
        const line = readFileSync(join(root, e.file), "utf-8").split("\n")[e.line - 1] ?? "";
        ok = callRe(name).test(line) || new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(line);
      } catch { /* 文件消失 */ }
      if (!ok) unverified.push(`${e.from.split("#")[1]}@${e.file}:${e.line}`);
    }
    const recall = truthFiles.size === 0 ? 1 : (idxFiles.size > 0 ? (truthFiles.size - truthOnly.length) / truthFiles.size : 0);
    console.log(`\n### ${name}  定义=${h.symbol.file}:${h.symbol.line} [${h.symbol.kind}]`);
    console.log(`  索引 callers=${h.callers.length}(调用点 ${callSites.length},文件 ${idxFiles.size}) | grep 真值文件=${truthFiles.size} | 召回=${(recall * 100).toFixed(0)}% | 真值外文件=${idxOnly.length} | 调用点行未核验=${unverified.length}/${callSites.filter((e) => e.line > 0).length}`);
    if (truthOnly.length) console.log(`  真值有而索引无(文件): ${truthOnly.slice(0, 8).join(", ")}${truthOnly.length > 8 ? ` …共${truthOnly.length}` : ""}`);
    if (idxOnly.length) console.log(`  索引有而真值无(文件,多为属性调用形式 obj.name() 或注释提及): ${idxOnly.slice(0, 6).join(", ")}${idxOnly.length > 6 ? ` …共${idxOnly.length}` : ""}`);
    if (unverified.length) console.log(`  调用点行未核验: ${unverified.slice(0, 6).join(", ")}${unverified.length > 6 ? ` …共${unverified.length}` : ""}`);
    summary.push({ name, indexed: true, kind: h.symbol.kind, idxCallers: h.callers.length, truthFiles: truthFiles.size, recall: +(recall * 100).toFixed(0), extraFiles: idxOnly.length, unverifiedCallSites: unverified.length });
  }
  console.log("\n---- 对拍汇总 ----");
  console.log(JSON.stringify(summary, null, 1));
}

function cmdFile(repo: string, path: string): void {
  const idx = loadIdx(repo);
  const nodes = queryFile(idx, path);
  console.log(`符号数=${nodes.length}`);
  for (const n of nodes) console.log(`  [${n.kind}] ${n.name} :${n.line} (out ${n.outCount}/in ${n.inCount})`);
  const m = renderFile(idx, path);
  mkdirSync(SHOTS, { recursive: true });
  const p = join(SHOTS, `${repo}-file-${path.split("/").pop()}.mmd`);
  writeFileSync(p, m);
  console.log(`mermaid → ${p} (${m.split("\n").length} 行)`);
}

function cmdGraph(repo: string, name: string): void {
  const idx = loadIdx(repo);
  const m = renderNeighborhood(idx, name);
  mkdirSync(SHOTS, { recursive: true });
  const p = join(SHOTS, `${repo}-graph-${name.replace(/[^\w-]/g, "_")}.mmd`);
  writeFileSync(p, m);
  console.log(m.split("\n").length + " 行 → " + p);
  console.log(m);
}

function cmdFp(repo: string): void {
  const idx = srcFingerprint(repoPath(repo), true);
  console.log(JSON.stringify(idx));
}

const [cmd, ...rest] = process.argv.slice(2);
const run: Record<string, () => void | Promise<void>> = {
  build: () => cmdBuild(rest[0]!),
  stats: () => cmdStats(rest[0]!),
  top: () => cmdTop(rest[0]!, rest[1] ? parseInt(rest[1]) : 20),
  eps: () => cmdEps(rest[0]!, rest[1] ? parseInt(rest[1]) : 30),
  sym: () => cmdSym(rest[0]!, rest[1]!),
  pair: () => cmdPair(rest[0]!, rest.slice(1)),
  file: () => cmdFile(rest[0]!, rest[1]!),
  graph: () => cmdGraph(rest[0]!, rest[1]!),
  fp: () => cmdFp(rest[0]!),
};
if (!cmd || !run[cmd]) {
  console.error("用法: tsx scripts/validate-codesense-ref.ts <build|stats|top|eps|sym|pair|file|graph|fp> ...");
  process.exit(1);
}
await run[cmd]!();
