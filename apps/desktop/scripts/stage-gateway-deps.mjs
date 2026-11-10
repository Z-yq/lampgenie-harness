/**
 * 打包前的 gateway 外部依赖 staging( K5)。
 * 背景:apps/gateway build 用 `--external:ts-morph --external:playwright-core`,运行时靠真实
 * node_modules 解析;code-sense 还额外 `require.resolve('tree-sitter-wasms/out/*.wasm')`。
 * 两个必须同时解决的坑:
 * ① 传递依赖漏带:ts-morph 依赖 @ts-morph/common → minimatch/path-browserify/tinyglobby →
 *    picomatch/fdir/brace-expansion/balanced-match。只拷根包时打包产物 `require('ts-morph')`
 *    直接 MODULE_NOT_FOUND(code_review 整块失效)。
 * ② 扁平化破坏多版本共存:若按「包名」去重全部摊到顶层,同名包的多主版本(minimatch@9 与
 *    minimatch@10 等)只剩一个,另一使用方 require 到错误主版本,运行时 API 不匹配。
 * 做法:按 Node 的**嵌套解析**语义构建 layout ——
 *   - 先 BFS 求出完整依赖图(name@version + 各自依赖的解析结果);
 *   - 每个包名选一个版本作为**顶层共享版**(root 优先,其次被引用次数多者);
 *   - 依赖版本与顶层一致的 → 靠顶层解析,不重复拷贝;
 *     不一致的 → 巢套在该包自己的 node_modules/<name> 下,并递归处理它的依赖。
 *   这样任何包的 require 都能按 Node 的向上查找规则拿到自己需要的版本。
 * pnpm 的软链/虚拟 store 在解析阶段用 realpath 消解为实体目录,产物是标准可移植 node_modules。
 * 纯 Node 内置实现;幂等(.stage 每次重建);闭包不完整则拒绝产出残包。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/desktop/scripts
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const gatewayDir = join(repoRoot, "apps", "gateway");
const codeSenseDir = join(repoRoot, "packages", "code-sense");
const stageDir = join(desktopDir, ".stage");
const stageModules = join(stageDir, "node_modules");

/** 根依赖:gateway bundle 的 esbuild external + require.resolve 运行期依赖。 */
const ROOTS = [
  { name: "ts-morph", from: gatewayDir },
  { name: "playwright-core", from: gatewayDir },
  { name: "tree-sitter-wasms", from: codeSenseDir },
  { name: "web-tree-sitter", from: codeSenseDir },
];

/** 可选依赖(platform 相关)解析失败不致命。 */
const OPTIONAL = new Set(["fsevents"]);

/** 拷贝时排除的无用大目录(不影响运行时解析)。 */
const SKIP_DIRS = new Set(["test", "tests", "__tests__", ".github", "docs", "example", "examples", ".git"]);

function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 在 fromDir 的解析上下文里定位包真实目录(pnpm 软链 → realpath)。 */
function resolvePkgDir(name, fromDir) {
  const req = createRequire(join(fromDir, "noop.js"));
  const candidates = [];
  try {
    candidates.push(req.resolve(`${name}/package.json`));
  } catch {
    /* 部分包 package.json 未导出,退主入口上溯 */
  }
  if (!candidates.length) {
    try {
      candidates.push(req.resolve(name));
    } catch {
      return null;
    }
  }
  for (const c of candidates) {
    let dir = dirname(c);
    for (let i = 0; i < 6; i++) {
      const pkg = readPkg(dir);
      if (pkg && pkg.name === name) {
        try {
          return realpathSync(dir);
        } catch {
          return dir;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * BFS 构建完整依赖图。
 * 返回:
 *   nodes: Map<`name@version`, {name, version, dir, deps: Array<{name, key}>, root:boolean}>
 *   topKeyOf: Map<name, `name@version`>  顶层共享版本
 *   missing: 未能解析的必需依赖
 */
function buildGraph(roots, { log }) {
  const nodes = new Map();
  const missing = [];
  const queue = [];
  const rootNames = new Set(roots.map((r) => r.name));

  const visit = (name, from, isRoot) => {
    const dir = resolvePkgDir(name, from);
    if (!dir) {
      if (OPTIONAL.has(name)) {
        log(`可选依赖缺位(跳过): ${name}`);
      } else if (!missing.includes(name)) {
        missing.push(name);
        log(`依赖无法解析: ${name}(解析起点 ${from})`);
      }
      return null;
    }
    const pkg = readPkg(dir) ?? {};
    const version = String(pkg.version ?? "0.0.0");
    const key = `${name}@${version}`;

    if (!nodes.has(key)) {
      const node = { name, version, dir, deps: [], root: false };
      nodes.set(key, node);
      queue.push(node);
    }
    const node = nodes.get(key);
    if (isRoot) node.root = true;
    return node;
  };

  for (const r of roots) visit(r.name, r.from, true);

  // 逐层解析每个包的依赖(依赖从包自身目录解析 = pnpm 嵌套语义)
  const resolvedEdges = new Map(); // key → [{name, key}]
  while (queue.length) {
    const node = queue.shift();
    const pkg = readPkg(node.dir) ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
    const edges = [];
    for (const depName of Object.keys(deps)) {
      const child = visit(depName, node.dir, false);
      if (child) edges.push({ name: depName, key: `${child.name}@${child.version}` });
    }
    resolvedEdges.set(`${node.name}@${node.version}`, edges);
    node.deps = edges;
  }

  // 顶层版本选择:root 优先,其次被依赖次数多者(平局保持先到)
  const versionsByName = new Map(); // name → Set<key>
  const refCount = new Map(); // key → 被引用次数
  for (const [key, node] of nodes) {
    if (!versionsByName.has(node.name)) versionsByName.set(node.name, new Set());
    versionsByName.get(node.name).add(key);
    for (const e of node.deps) refCount.set(e.key, (refCount.get(e.key) ?? 0) + 1);
  }
  const topKeyOf = new Map();
  for (const [name, keys] of versionsByName) {
    const list = [...keys];
    if (list.length === 1) {
      topKeyOf.set(name, list[0]);
      continue;
    }
    list.sort((a, b) => {
      const ra = nodes.get(a).root ? 1 : 0;
      const rb = nodes.get(b).root ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return (refCount.get(b) ?? 0) - (refCount.get(a) ?? 0);
    });
    topKeyOf.set(name, list[0]);
    log(`同名多版本: ${name} → 顶层 ${list[0]},嵌套 ${list.slice(1).join(", ")}`);
  }

  return { nodes, topKeyOf, missing };
}

function copyPkgDir(srcDir, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(srcDir, dest, {
    recursive: true,
    dereference: true,
    // package 自带的 node_modules(pnpm 软链)不拷:其内容由本脚本按依赖图重新布点,
    // 直接拷软链会带进 pnpm 的 .pnpm 布局且可能重复/悬空。
    filter: (src) => {
      const base = src.split(/[\\/]/).pop();
      if (!base) return true;
      if (src === srcDir) return true;
      if (SKIP_DIRS.has(base)) return false;
      return true;
    },
  });
}

/** 从某个包的 dest 目录开始,把「版本与顶层不一致」的依赖递归嵌套进去。 */
function layoutNested(nodeKey, nodeDest, graph, stack, log) {
  const node = graph.nodes.get(nodeKey);
  if (!node) return;
  for (const dep of node.deps) {
    if (graph.topKeyOf.get(dep.name) === dep.key) continue; // 顶层同版本,靠向上查找
    if (stack.includes(dep.key)) continue; // 循环依赖,交给外层已布点的实例
    const depNode = graph.nodes.get(dep.key);
    if (!depNode) continue;
    const dest = join(nodeDest, "node_modules", ...dep.name.split("/"));
    if (!existsSync(dest)) {
      copyPkgDir(depNode.dir, dest);
      log(`嵌套 ${dep.key} → ${dep.name}/node_modules(版本与顶层冲突)`);
    }
    layoutNested(dep.key, dest, graph, [...stack, nodeKey], log);
  }
}

function main() {
  const log = (m) => console.log(`[stage-gateway-deps] ${m}`);
  log(`gateway=${gatewayDir}`);
  log(`code-sense=${codeSenseDir}`);

  if (!existsSync(gatewayDir)) {
    console.error("[stage-gateway-deps] 找不到 apps/gateway —— 请在仓根执行");
    process.exit(1);
  }

  const graph = buildGraph(ROOTS, { log });
  if (graph.missing.length) {
    console.error(`[stage-gateway-deps] 必需依赖解析失败: ${graph.missing.join(", ")}`);
    process.exit(1);
  }

  // 只重建 node_modules:`.stage` 下还有全量运行时(runtime/browsers/git)与下载缓存,
// 整目录删除会让 dist:full 每次重装 Python/torch/Chromium(~25 分钟)。
  rmSync(stageModules, { recursive: true, force: true });
  rmSync(join(stageDir, "probe.js"), { force: true });
  mkdirSync(stageModules, { recursive: true });

  // 顶层:每个包名只放它的共享版本
  let topCount = 0;
  const topKeys = new Set(graph.topKeyOf.values());
  for (const key of [...topKeys].sort()) {
    const node = graph.nodes.get(key);
    copyPkgDir(node.dir, join(stageModules, ...node.name.split("/")));
    topCount += 1;
  }
  log(`顶层 ${topCount} 个包`);

  // 嵌套:版本冲突的依赖按 Node 解析规则落在引用方 node_modules 下
  for (const key of topKeys) {
    const node = graph.nodes.get(key);
    layoutNested(key, join(stageModules, ...node.name.split("/")), graph, [key], log);
  }

  // 自检:stage 出来的 node_modules 能被独立 require,且多版本各自解析到正确版本
  const req = createRequire(join(stageDir, "probe.js"));
  const probe = (name) => {
    try {
      req(name);
      return true;
    } catch (err) {
      log(`自检失败 ${name}: ${err && err.code ? err.code : err}`);
      return false;
    }
  };
  const okTsMorph = probe("ts-morph");
  const okPlaywright = probe("playwright-core");
  log(`自检 ts-morph=${okTsMorph} playwright-core=${okPlaywright} 包数=${graph.nodes.size}`);

  if (!okTsMorph) {
    console.error("[stage-gateway-deps] ts-morph 仍不可加载 —— 依赖闭包不完整,拒绝产出残包");
    process.exit(1);
  }

  const du = (dir) => {
    let bytes = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          try {
            bytes += readFileSync(p).length;
          } catch {
            /* 忽略 */
          }
        }
      }
    };
    try {
      walk(dir);
    } catch {
      /* 忽略 */
    }
    return (bytes / 1024 / 1024).toFixed(1);
  };
  log(`stage 体积约 ${du(stageModules)}MB → ${stageModules}`);
}

main();