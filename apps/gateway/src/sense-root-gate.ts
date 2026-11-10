/**
 * 扫描根预算闸 + 多仓工作区感知(2026-10-21 立闸,2026-10-30 自 sense-root-gate 独立成模块并接全
 * 自动路径)。守护面:code_sense 工具(结构+语义)/warmIndex/**ensureIndex 自动构建**。
 *
 * 实锤史:画布 session 把工作区根 /mnt/e/workship/genie(巨型非 git 目录,9p 挂载,≥7000 文件
 * /4GB+)当 taskRoot——①主进程全量扫描 D 态饱和 libuv 线程池拖死网关(2026-10-21,立闸);
 * ②结构面 action=impact 绕过闸直通 ensureIndex → risk 档采样重建(5160 文件)压垮 9p,收割两个
 * worker + 网关 session.status 3-9s(2026-10-30,闸接全自动路径)。
 *
 * 闸语义:超预算根**自动路径一律不扫不建**(人类显式 CLI `codesense index --force` 仍可);工作区
 * 根(多个子仓的直接父目录)给「子仓收窄」出路——显式 root 参数 / target 路径前缀自动收窄 /
 * symbol·impact 在已建索引的子仓内扇出。原则:**拒绝必须带路,死路即缺陷**。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { readIndexMeta } from "@lampgenie/code-sense/callgraph/index-meta";

export interface RootScanVerdict {
  ok: boolean;
  /** 有界 walk 实计源码文件数(只计 SOURCE_EXT;达上限时=上限值,真实数 ≥ 该值)。 */
  files: number;
  /** 实计源码体积(MB,四舍五入;index-meta 短路时为 0=未测)。 */
  bytesMb: number;
  /** ok=false 时的原因(日志/journal 观测面)。 */
  reason?: string;
  /** 判定来源(2026-11-08):walk=有界遍历;index-meta=读构建产物身份短路(免 9p 全仓 walk)。 */
  source?: "walk" | "index-meta";
}

const SCAN_GATE_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", "ref", "coverage", ".zcode", "docs",
  "venv", "__pycache__", "site-packages", ".genie", ".agents", ".next", "out", "target", "bin", "obj",
  // 2026-11-02:本仓实测大目录(资产/日志/评测草稿),跳过省 walk;计费本就只算源码,这里是省时
  "assets", "devlog", "eval-scratch", ".pytest_cache", ".r4", "zz-wslcheck-dir"]);

/**
 * 源码扩展名(2026-11-02 计费口径修复):与 packages/code-sense GRAPH_SOURCE_EXT 同源
 * (callgraph/engine.ts:156;增语言时两处同步)。实锤:此前计所有非点文件字节,assets 二进制、
 * md 文档、pnpm-lock 把 lampgenie-harness 记成「2484 文件/880MB」假巨仓 → code_sense 全线拒答。
 */
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".java", ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".rs", ".cs", ".rb", ".php"]);

function isSourceFile(name: string): boolean {
  const i = name.lastIndexOf(".");
  return i > 0 && SOURCE_EXT.has(name.slice(i));
}

function scanGateMaxFiles(): number {
  const n = Number(process.env.GENIE_SENSE_ORIENT_MAX_FILES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5000;
}
function scanGateMaxMb(): number {
  const n = Number(process.env.GENIE_SENSE_ORIENT_MAX_MB);
  return Number.isFinite(n) && n > 0 ? n : 800;
}
function scanGateTtlMs(): number {
  const n = Number(process.env.GENIE_SENSE_GATE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 300_000; // 测试可置 0 强制每次重算
}
/** 有界 walk 的软 deadline(2026-11-08:15s → 30s)。9p 慢盘上 lampgenie-harness 实测 10.0s(空载),
 *  负载下会越过 15s → 正常 monorepo 被误判「巨根」降级成工作区扇出(7700 启动日志实锤)。
 *  真正的巨根仍由 maxFiles/maxMb/条目上限拦;这里只是给慢盘留余量。 */
function scanGateDeadlineMs(): number {
  const n = Number(process.env.GENIE_SENSE_GATE_DEADLINE_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 30_000;
}
/** index-meta 短路的可信期(2026-11-08):构建产物身份(srcCount)在期内可直接判「已知小仓」,
 *  免全仓 walk。默认 24h;过期后走一次真实 walk 复核(不会永久信任旧 meta)。 */
function metaTrustMs(): number {
  const n = Number(process.env.GENIE_SENSE_GATE_META_TRUST_MS);
  return Number.isFinite(n) && n >= 0 ? n : 86_400_000;
}

const scanVerdictMemo = new Map<string, { at: number; v: RootScanVerdict }>();

/** 扫描根预算闸(orientWithSense / code_sense 工具 / warmIndex / ensureIndex 共用;按根 memo TTL 内复用)。 */
export async function rootScanVerdict(root: string): Promise<RootScanVerdict> {
  const memo = scanVerdictMemo.get(root);
  const ttl = scanGateTtlMs();
  if (memo && Date.now() - memo.at < ttl) return memo.v;
  const maxFiles = scanGateMaxFiles();
  const maxMb = scanGateMaxMb();
  // 2026-11-08 快路:已有构建产物的 meta(srcCount)=「这个根曾经完整扫过且不大」的确定性证据,
  // 免掉 9p 上每次冷启动 10-20s 的全仓 walk(7700 启动日志:walk 15s 超时→正常仓被当巨根)。
  // 只在 meta 可信期内生效;过期仍走真实 walk 复核,不永久信任旧 meta。
  const meta = readIndexMeta(root);
  if (meta && typeof meta.srcCount === "number" && meta.srcCount >= 0
    && meta.srcCount <= maxFiles && Date.now() - meta.builtAt <= metaTrustMs()) {
    const v: RootScanVerdict = { ok: true, files: meta.srcCount, bytesMb: 0, source: "index-meta" };
    scanVerdictMemo.set(root, { at: Date.now(), v });
    return v;
  }
  const deadlineMs = scanGateDeadlineMs();
  const deadline = Date.now() + deadlineMs;
  let files = 0, bytes = 0, entries = 0;
  let stop: string | null = null;
  const fsp = await import("node:fs/promises");
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (stop) return;
    if (files >= maxFiles) { stop = `文件数达上限 ${maxFiles}`; return; }
    if (entries >= 40_000) { stop = "目录条目达上限 40000"; return; }
    // 2026-11-02:源码文件硬帽(目录自指/真实巨仓兜底)——skip 名单外的目录最多贡献 2 万个源文件
    if (files >= 20_000) { stop = "源码文件数达硬上限 20000(真实巨仓/目录自指兜底)"; return; }
    if (depth > 16) return;
    if (Date.now() > deadline) { stop = `有界 walk 超时(${Math.round(deadlineMs / 1000)}s)`; return; }
    let names: import("node:fs").Dirent[];
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      if (stop) return;
      entries++;
      if (n.name.startsWith(".") || SCAN_GATE_SKIP_DIRS.has(n.name)) continue;
      const full = dir + "/" + n.name;
      if (n.isDirectory()) await walk(full, depth + 1);
      else if (n.isFile() && isSourceFile(n.name)) {
        files++;
        try { bytes += (await fsp.stat(full)).size; } catch { /* 单文件 stat 失败容忍 */ }
        if (bytes > maxMb * 1024 * 1024) { stop = `源码体积超 ${maxMb}MB`; return; }
        if (files >= maxFiles) { stop = `文件数达上限 ${maxFiles}`; return; }
      }
      if (Date.now() > deadline) { stop = `有界 walk 超时(${Math.round(deadlineMs / 1000)}s)`; return; }
    }
  };
  try {
    // 外层 race 兜底(2026-10-21):9p 单个 readdir 若真 D 态挂住,walk 内部的逐目录 deadline
    // 检查到不了——整体 deadline+5s 未决=按超预算拒绝(fail-safe),悬挂的残余 walk 有界。
    const hardMs = deadlineMs + 5_000;
    await Promise.race([
      walk(root, 0),
      new Promise<void>((res) => {
        const t = setTimeout(() => { stop = stop ?? `闸判定整体超时(${Math.round(hardMs / 1000)}s)`; res(); }, hardMs);
        t.unref?.();
      }),
    ]);
  } catch { stop = stop ?? "有界 walk 异常"; }
  const bytesMb = Math.round(bytes / 1048576);
  const v: RootScanVerdict = stop
    ? { ok: false, files, bytesMb, reason: stop + `(实计 ${files} 文件/${bytesMb}MB)`, source: "walk" }
    : { ok: true, files, bytesMb, source: "walk" };
  if (!v.ok) {
    console.warn(`[sense] 扫描根超预算闸: root=${root} ${v.reason}——拒绝主进程扫描(GENIE_SENSE_ORIENT_MAX_FILES/MB 可调)`);
  }
  scanVerdictMemo.set(root, { at: Date.now(), v });
  return v;
}

// ---- 多仓工作区感知(2026-10-30:拒绝必须带路)----

/** 子仓标记文件:任一在场即认作仓(.git 目录优先,但非 git 的包根也算——工作区里常见混布)。 */
const REPO_MARKERS = [".git", "package.json", "pyproject.toml", "setup.py", "go.mod", "Cargo.toml"] as const;

export interface WorkspaceRepo {
  name: string;
  path: string;
  /** 一句话用途(package.json description / pyproject [project] description;缺席="")。 */
  description: string;
  /** .genie/sense-index 是否已有产物(扇出与提示都用;不触发构建)。 */
  indexed: boolean;
}

/** 探测子仓:直接子目录带仓标记即收;无标记的目录**下探一层**再收(2026-11-02:pnpm monorepo
 * 的 apps/ 与 packages/ 下两层深子仓,一层探测返回空清单 → 拒绝文案成死路)。已确认是仓的目录
 * 不再下探;重目录(node_modules/vendor 等)不下探。 */
/** 探测子仓:直接子目录带仓标记即收;无标记的目录**下探一层**再收(2026-11-02:pnpm monorepo
 * 的 apps/ 与 packages/ 下两层深子仓,一层探测返回空清单 → 拒绝文案成死路)。已确认是仓的目录
 * 不再下探;重目录(node_modules/vendor 等)不下探。
 * 2026-11-04:async IO(readdir/stat/readFile 全 fs/promises,9p 病态不再阻塞事件循环)+
 * per-root TTL 缓存(缺省 60s,GENIE_SENSE_REPOS_TTL_MS 可调;拒绝路径每次 code_sense 高频复用)。 */
async function detectWorkspaceReposFresh(root: string): Promise<WorkspaceRepo[]> {
  // 2026-11-08:根自身是 git 仓 = 单一扫描单元。此前按 package.json 把 lampgenie-harness 的
  // apps/* + packages/* 全认成「子仓」(17 个),各自建索引(28MB)、跨包 impact 被切断、
  // warm 汇总报「17 已新鲜」;而工作区(非 git 根,如 /mnt/e/workship/genie)仍按下探逻辑工作。
  if (await isGitRepoRoot(root)) return [];
  let names: Dirent[];
  try { names = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const top = names.filter((n) => n.isDirectory() && !n.name.startsWith(".") && !SCAN_GATE_SKIP_DIRS.has(n.name));
  // 顶层并行、单目录内顺序:并发 stat 不至于放大 9p 压力,又免串行全量慢盘长尾
  const perDir = await Promise.all(top.map(async (n): Promise<WorkspaceRepo[]> => {
    const p = join(root, n.name);
    if (await isRepoDir(p)) return [await repoAt(n.name, p)];
    let sub: Dirent[];
    try { sub = await readdir(p, { withFileTypes: true }); } catch { return []; }
    const out: WorkspaceRepo[] = [];
    for (const s of sub) {
      if (!s.isDirectory() || s.name.startsWith(".") || SCAN_GATE_SKIP_DIRS.has(s.name)) continue;
      const sp = join(p, s.name);
      if (await isRepoDir(sp)) out.push(await repoAt(n.name + "/" + s.name, sp));
    }
    return out;
  }));
  return perDir.flat(); // 按 readdir 顺序拼接,与旧同步版清单次序一致
}

function reposTtlMs(): number {
  const n = Number(process.env.GENIE_SENSE_REPOS_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60_000; // 测试可置 0 强制每次重算
}

export const reposMemo = new Map<string, { at: number; repos: WorkspaceRepo[] }>();

export async function detectWorkspaceRepos(root: string): Promise<WorkspaceRepo[]> {
  const memo = reposMemo.get(root);
  const ttl = reposTtlMs();
  if (memo && Date.now() - memo.at < ttl) return memo.repos;
  const repos = await detectWorkspaceReposFresh(root);
  reposMemo.set(root, { at: Date.now(), repos });
  return repos;
}

/** 仓根探测:.git 目录(普通仓)或 .git 文件(worktree/submodule)在场即真仓根。 */
async function isGitRepoRoot(root: string): Promise<boolean> {
  try {
    await stat(join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** 仓标记探测:6 个标记并行 stat(任一在场即仓;缺席=ENOENT catch,替代 existsSync×N)。
 *  仅用于「非 git 工作区根」下的子仓发现;git 仓根已在 detectWorkspaceReposFresh 提前返回 []。 */
async function isRepoDir(p: string): Promise<boolean> {
  const hits = await Promise.all(REPO_MARKERS.map(async (m) => {
    try { await stat(join(p, m)); return true; } catch { return false; }
  }));
  return hits.some(Boolean);
}

async function repoAt(name: string, p: string): Promise<WorkspaceRepo> {
  let indexed = false;
  try { await stat(join(p, ".genie", "sense-index")); indexed = true; } catch { /* 未建索引 */ }
  return { name, path: p, description: await repoDescription(p), indexed };
}

/** 仓一句话用途(小文件读取,失容忍;pyproject 取 [project] description,package 取 description)。 */
async function repoDescription(repoPath: string): Promise<string> {
  try {
    const d = (JSON.parse(await readFile(join(repoPath, "package.json"), "utf-8")) as { description?: unknown }).description;
    if (typeof d === "string" && d.trim()) return d.trim().slice(0, 80);
  } catch { /* 无 package.json/解析失败 → 试 pyproject */ }
  try {
    const m = /description\s*=\s*"([^"]{1,120})"/.exec((await readFile(join(repoPath, "pyproject.toml"), "utf-8")).slice(0, 8_000));
    if (m) return m[1]!;
  } catch { /* 描述是增强件 */ }
  return "";
}

/**
 * target(文件路径/scope 前缀)是否落在某个子仓内 → 收窄到该子仓根。
 * 接受:相对路径以子仓名开头(`genie-voice/genie/x.py` 或恰为子仓名)或绝对路径在子仓下;
 * 越界(../)不收。不校验文件存在——查询面自己有「缺文件」提示,这里只做根归属判定。
 */
export function refineRootForTarget(root: string, repos: WorkspaceRepo[], target: string): string | null {
  const t = target.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!t || t === ".." || t.startsWith("../")) return null;
  const abs = isAbsolute(t) ? normalize(t) : null;
  for (const r of repos) {
    const rp = normalize(r.path);
    if (abs) {
      if (abs === rp || abs.startsWith(rp + sep) || abs.startsWith(rp + "/")) return r.path;
    } else if (t === r.name || t.startsWith(r.name + "/")) {
      return r.path;
    }
  }
  return null;
}

/** 子仓清单文本(拒绝/总览共用;indexed 标注让模型知道扇出覆盖面)。 */
export function renderWorkspaceRepos(repos: WorkspaceRepo[]): string {
  if (!repos.length) return "(未探测到子仓)";
  return repos.map((r) => `- ${r.name}${r.description ? ` — ${r.description}` : ""}${r.indexed ? " [已建索引]" : " [未建索引]"}`).join("\n");
}

/** 工作区拒绝文本:拒绝 + 子仓清单 + 三条出路(显式 root / 路径前缀自动收窄 / 扇出说明)。 */
export function workspaceRefusalText(root: string, verdict: RootScanVerdict, repos: WorkspaceRepo[], what: string): string {
  const lines = [
    `code_sense 已拒绝对该根自动${what}:${root}(${verdict.reason})。`,
  ];
  if (repos.length) {
    lines.push(
      "这是多仓工作区根——整根索引会压垮慢盘(实锤:采样重建 5160 文件把 9p 拖到全系统停顿)。子仓都是小根,可安全查询/建索引:",
      renderWorkspaceRepos(repos),
      "出路(任选):",
      `① 显式收窄:本调用加 root="<子仓名>"(如 root="${repos[0]!.name}")后重查;`,
      "② file/vars/branches/flow 的 target 带子仓路径前缀时自动收窄(如 target=\"<子仓名>/src/x.py\"),无需 root;",
      "③ symbol/impact 不带 root 时会在「已建索引」的子仓内自动扇出;要搜未建索引的子仓,按①显式指定(首次会自动建,小根秒~分钟级)。",
    );
  } else {
    lines.push(
      "该根两层内未探测到带仓标记的子仓(单一超大码仓):自动路径不建索引。出路:",
      "① grep/refs 字面检索,branches/flow 带 path 子目录;",
      '② 确知子仓位置时显式 root="<工作区相对路径>"(如 root="apps/gateway")——不依赖探测清单;',
      "③ 整仓索引由人在 CLI 显式构建:codesense index <root> --force(按堆预算采样并如实登记);",
      "④ 阈值可调:GENIE_SENSE_ORIENT_MAX_FILES / GENIE_SENSE_ORIENT_MAX_MB(闸只计源码:ts/js/py/go/java/c/cpp/rs/cs/rb/php;二进制/文档/锁文件不计)。",
    );
  }
  return lines.join("\n");
}
