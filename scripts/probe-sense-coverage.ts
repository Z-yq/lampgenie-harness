/**
 * code_sense 全覆盖探针(2026-11-08):回答「扫描面里每个源文件都有去向吗」。
 *
 * 口径:
 *  - 扫描面 = engine.listSourceFilesDetailed(root)(与索引构建同一扩展名/跳过目录/上限口径);
 *  - 去向 = index.fileStatus(新索引):indexed / symbol-less / skipped / error;
 *  - 缺口 = 磁盘在扫描面、但 fileStatus 里没有的文件(通常=索引构建后新增/改动,索引滞后);
 *  - 过期 = fileStatus 里有、磁盘已不存在的文件(删除未重建)。
 *
 * 退出码:0=全覆盖(每个扫描文件都有去向);2=有缺口/过期(需 codesense index --force 重建);
 *         1=索引缺失/旧格式(无 fileStatus,无法判定)。
 * 跑法:npx tsx scripts/probe-sense-coverage.ts [root] [--json]
 */
import { listSourceFilesDetailed } from "../packages/code-sense/src/callgraph/engine.ts";
import { loadIndex } from "../packages/code-sense/src/callgraph/c2f.ts";
import { readIndexMeta as readMeta } from "../packages/code-sense/src/callgraph/index-meta.ts";

(async () => {
  const root = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : new URL("..", import.meta.url).pathname)
    .replace(/\/+$/, "");
  const json = process.argv.includes("--json");
  const scan = await listSourceFilesDetailed(root);
  const idx = loadIndex(root);
  if (!idx) {
    console.error("索引不存在:", root, "——先 codesense index");
    process.exit(1);
  }
  if (!idx.fileStatus) {
    console.error("索引为旧格式(无 fileStatus)——先 codesense index --force 重建");
    process.exit(1);
  }
  const disk = new Set(scan.files.map((f) => f.replace(root + "/", "").replace(/\\/g, "/")));
  const table = idx.fileStatus;
  const statusKeys = new Set(Object.keys(table));
  const missing = [...disk].filter((f) => !statusKeys.has(f));
  const stale = [...statusKeys].filter((f) => !disk.has(f));
  const counts = { indexed: 0, "symbol-less": 0, skipped: 0, error: 0 };
  for (const s of Object.values(table)) counts[s.status]++;
  const meta = readMeta(root);
  const report = {
    root,
    builtAt: new Date(idx.builtAt).toISOString(),
    nodes: idx.nodes.length,
    edges: idx.edges.length,
    diskFiles: disk.size,
    status: { scanned: statusKeys.size, ...counts },
    metaFileStatus: meta?.fileStatus,
    missingCount: missing.length,
    staleCount: stale.length,
    missing: missing.slice(0, 20),
    stale: stale.slice(0, 20),
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const pct = ((counts.indexed / Math.max(1, statusKeys.size)) * 100).toFixed(1);
    console.log(`root: ${root}`);
    console.log(`索引: ${report.builtAt} · ${report.nodes} 节点 / ${report.edges} 边`);
    console.log(`扫描面(磁盘): ${disk.size} 个源文件`);
    console.log(`去向: ${statusKeys.size} = 有符号 ${counts.indexed}(${pct}%) + 无顶层声明 ${counts["symbol-less"]} + 跳过 ${counts.skipped} + 失败 ${counts.error}`);
    if (missing.length) console.log(`索引滞后: ${missing.length} 个新文件尚未进索引(非覆盖缺口)—— ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
    if (stale.length) console.log(`过期(已删除未重建): ${stale.length} 个 —— ${stale.slice(0, 8).join(", ")}${stale.length > 8 ? " …" : ""}`);
    console.log(missing.length === 0 && stale.length === 0
      ? "PASS: 扫描面每个文件都有去向(全覆盖)"
      : `FAIL: 索引滞后 ${missing.length} / 过期 ${stale.length}——运行 codesense index(增量)或 --force(全量)后复测`);
  }
  process.exit(missing.length === 0 && stale.length === 0 ? 0 : 2);
})().catch((e) => {
  console.error("probe-sense-coverage 失败:", e);
  process.exit(1);
});