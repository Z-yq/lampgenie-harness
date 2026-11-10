/**
 * 静态调用索引管理(三改):
 * ① 提前生成:服务启动/项目注册时后台构建全图索引落盘(.genie/sense-index/),不点哪个查哪个;
 * ② 按需查询:code_index 工具给 vibe coding agent 随时调用(symbol/file/entrypoints/graph),
 *    返回结构化信息,不塞 system prompt;
 * ③ code2flow 形态:trunk/leaf/regular 分类+File/Class 群组+边分色,面板图也走此形态。
 * 资源防御:同根单飞锁(跨进程文件锁,忙则等待复用/礼貌拒绝)+ worker 堆帽自适应
 * (按仓规模估内存→--max-old-space-size/GENIE_SENSE_MAX_FILES 降数)+ 启动孤儿清扫。
 */
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { repoRoot } from "./repo-root.js";

const childProcessReq = (globalThis as { require?: NodeRequire }).require ?? (await import("node:module")).createRequire(import.meta.url);
const { fork } = childProcessReq("node:child_process") as typeof import("node:child_process");
import {
  loadIndex, loadIndexAsync, indexStale,
  querySymbol, queryFile, queryEntryPoints, renderNeighborhood, renderFile,
  queryImpact, renderImpact,
  queryApiSurface, renderApiSurface,
  suggestSymbolNames,
  type C2fIndex, type SymbolQueryResult,
} from "@lampgenie/code-sense";
import { acquireBuildLock, releaseBuildLock, readLockState, readWorkerPid, workerPidPath, buildLockPath, pidMatches } from "@lampgenie/code-sense-cli/build-lock";
import { estimateIndexMemory, explicitHeapMb, budgetReduceEnv } from "@lampgenie/code-sense-cli/heap-budget";
import { rootScanVerdict, detectWorkspaceRepos, workspaceRefusalText } from "./sense-root-gate.js";

type RootKey = string;
const indexes = new Map<RootKey, C2fIndex>();
const building = new Map<RootKey, Promise<C2fIndex>>();
/** 已清扫过的根(每进程一次;warmIndex 可能反复触发)。 */
const sweptRoots = new Set<RootKey>();
/** 构建失败冷却:大工作区(如多仓巨根)冷构建经验证
 * 7 分钟后 SIGABRT 崩溃且无产物;此前每次查询/派遣都重新 fork 一遍,反复赔 CPU 与内存。
 * 失败后冷却窗口内直接拒绝重试,查询侧降级「尚未就绪」。成功即清。 */
const buildFailure = new Map<RootKey, { at: number; detail: string; cooldownMs?: number }>();

function failureCooldownMs(): number {
  const n = Number(process.env.GENIE_SENSE_INDEX_RETRY_COOLDOWN_MS ?? 300_000);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
}

/** 预算拒绝注册表(巨根治理):ensureIndex 对超预算根**拒绝构建**(自动路径一律不建,
 * 人类显式 CLI --force 仍可)。与失败冷却分开记:拒绝不是故障,是策略;查询面据此给出
 * 「工作区收窄」指引而非误导性的「后台构建中」。TTL 同闸 memo(300s),不另设清理。 */
const refusedRoots = new Map<RootKey, { at: number; reason: string }>();

/** 观测面(启动日志/诊断):当前处于失败冷却的根。 */
export function indexFailureCooldowns(): { root: string; at: number; detail: string; cooldownMs?: number }[] {
  return [...buildFailure.entries()].map(([root, v]) => ({ root, ...v }));
}

/** 索引构建:挪子进程(ts-morph 同步解析 101s 会阻塞主进程事件循环——R2 修复:
 * 此前主进程 warmIndex 导致 WS 握手 30s 无响应,3 个 e2e 超时)。
 * 子进程跑 buildC2fIndex+saveIndex,完成后主进程 loadIndex。
 * fork 前取同根单飞锁(跨进程防重复索引),锁内二次核对新鲜度(等到的在飞构建
 * 直接复用其产物);worker 带堆帽自适应(execArgv/--max-old-space-size,超预算传降数 env)。 */
export function ensureIndex(root: string): Promise<C2fIndex> {
  const key = root;
  const cached = indexes.get(key);
  if (cached && !indexStale(root, cached)) return Promise.resolve(cached);
  const inflight = building.get(key);
  if (inflight) return inflight;
  const failed = buildFailure.get(key);
  const cooldown = failed?.cooldownMs ?? failureCooldownMs();
  if (cooldown > 0 && failed && Date.now() - failed.at < cooldown) {
    const remain = Math.ceil((cooldown - (Date.now() - failed.at)) / 1000);
    return Promise.reject(new Error(`索引构建失败冷却中(剩 ${remain}s,${failed.detail})`));
  }
 // 预算闸(巨根治理,接全自动路径):超预算根不 fork——此前 risk 档仍采样降数构建
 // (5160 文件),慢盘上压垮全系统(收割 ×2 + 网关停顿注意)。闸在锁前:被拒根连锁都不该碰。
  // 注:闸首次判定是有界 walk(≤15s,memo 300s),ensureIndex 调用方全是 fire-and-forget,不阻塞请求。
  const gateP = rootScanVerdict(root).then((v) => {
    if (!v.ok) {
      refusedRoots.set(root, { at: Date.now(), reason: v.reason ?? "超预算" });
      throw new Error(`索引构建被预算闸拒绝: ${root}(${v.reason})——自动路径不建巨根索引,人类显式 CLI codesense index --force 才可`);
    }
    refusedRoots.delete(root);
    return true;
  });
  const p = (async (): Promise<C2fIndex> => {
    await gateP; // 预算闸先行:被拒根抛错(调用方 catch 容忍),不碰锁不 fork
    const lock = await acquireBuildLock(root, {
      // holder 如实标注(2026-10-29):本模块在 gateway 与 session-worker 两处实例化,此前硬编码
 // "gateway" 让等待方排障时找错进程(注意:「同根索引在飞(pid 639462,gateway)」实际是 worker)。
      holder: process.env.GENIE_SESSION_WORKER_CHILD === "1" ? "session-worker" : "gateway",
      onWait: (info) => console.warn(`[sense-index] 同根索引在飞(pid ${info.pid},${info.holder}),等待其完成…`),
    });
    if (!lock.ok) {
      const who = lock.info ? `pid ${lock.info.pid}(${lock.info.holder}${lock.info.startedAt ? `,${lock.info.startedAt} 起` : ""})` : "未知持有者";
      throw new Error(`同根索引已有在飞(${who}),礼貌拒绝未重复索引;等待 ${Math.round(lock.waited / 1000)}s 超时(GENIE_SENSE_INDEX_LOCK_WAIT_MS 可调)`);
    }
    try {
      // 拿到锁后二次核对:等待期间别的进程可能刚建成(等待-复用语义,零重复索引)
      const fresh = indexes.get(root) ?? await loadIndexAsync(root);
      if (fresh && !indexStale(root, fresh)) {
        indexes.set(root, fresh);
        buildFailure.delete(key);
        return fresh;
      }
      try {
        const built = await forkWorker(root);
        buildFailure.delete(key);
        return built;
      } catch (err) {
        // 只对「构建本身失败」(worker 崩溃/退出非 0)记冷却;SIGABRT(OOM 级)= 巨根反复
 // 全量扫描的系统压力源(注意:每次重试都几分钟内存churn 后崩),冷却 ×6。
        const msg = String((err as Error)?.message ?? err);
        if (/SIGABRT/.test(msg)) buildFailure.set(key, { at: Date.now(), detail: `${msg.slice(0, 180)}(OOM 级,冷却 ×6)` , cooldownMs: 6 * failureCooldownMs() });
        else buildFailure.set(key, { at: Date.now(), detail: msg.slice(0, 200) });
        throw err;
      }
    } finally {
      releaseBuildLock(root);
    }
  })().finally(() => { building.delete(key); }); // 忙拒/等锁路径失败也清在飞表,防后续请求永挂拒绝态
  building.set(key, p);
  return p;
}

/** fork 构建子进程(持锁状态下调用;堆帽自适应+降数 env 透传)。 */
async function forkWorker(root: string): Promise<C2fIndex> {
  // worker 路径双候选(echo-backend 同款):bundle=dist/sense-index-worker.mjs / dev=src/xxx.ts
  // fileURLToPath(不是 URL.pathname):Windows 下 pathname 是 /C:/...,直接 join 会变 C:\C:\...
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "sense-index-worker.mjs"), join(here, "sense-index-worker.ts")];
  const workerPath = candidates.find((c) => existsSync(c)) ?? candidates[0]!;
 // 堆帽自适应( RC-K2):显式 GENIE_SENSE_HEAP_MB > 按仓估算建议;
  // 估算失败=fail-open(不带堆帽 flag,与旧行为一致)。
  const extraExec: string[] = [];
  const extraEnv: Record<string, string> = {};
  try {
    const explicit = explicitHeapMb();
    const est = await estimateIndexMemory(root);
    const heapMb = explicit ?? est.recommendedHeapMb;
    extraExec.push(`--max-old-space-size=${heapMb}`);
    if (est.tier === "risk") {
      const env = budgetReduceEnv(est);
      if (env) Object.assign(extraEnv, env);
      console.warn(`[sense-index] 堆预算风险: 估算 ${est.estMb}MB > 预算 ${est.budgetMb}MB,堆帽 ${heapMb}MB${env ? `+采样降数 ${env.GENIE_SENSE_MAX_FILES} 文件` : ""}`);
    } else if (est.tier === "warn") {
      console.warn(`[sense-index] 堆预算贴线: 估算 ${est.estMb}MB / 预算 ${est.budgetMb}MB,堆帽 ${heapMb}MB`);
    }
  } catch {
    /* 估算失败 fail-open:不带堆帽 flag */
  }
  return new Promise<C2fIndex>((resolve, reject) => {
    const key = root;
 // detached(冻结治理):构建子进程脱离宿主进程组——宿主(gateway/session-worker)
    // 中途死亡时构建继续跑完并原子落盘,下个进程 loadIndex 直接收成品;旧形态子进程随宿主陪葬,
 // 巨根构建反复从头再来(注意:巨根构建若随宿主进程死亡,只留 worker.pid 墓碑)。
    // stderr 改 ignore:detached 后管道读端随宿主消亡,子进程写 stderr 会 EPIPE 崩溃(崩溃态由
    // buildFailure 冷却+失败重试兜底;worker.pid 登记让等待方按活 worker 语义礼让)。
    const worker = fork(workerPath, [root], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: Object.keys(extraEnv).length > 0 ? { ...process.env, ...extraEnv } : process.env,
      ...(workerPath.endsWith(".ts")
        ? { execArgv: [...extraExec, "--import", "tsx"] }
        : extraExec.length > 0 ? { execArgv: extraExec } : {}),
    });
    worker.unref();
    worker.on("exit", async (code, signal) => {
      building.delete(key);
      const idx = await loadIndexAsync(root);
      if (code === 0 && idx) { indexes.set(key, idx); resolve(idx); return; }
      const why = signal ? `signal ${signal}` : `code ${code}`;
      console.warn(`[sense-index] 索引子进程结束(${why}) root=${root}${code === 0 ? "(产物未及落盘)" : "(detached 形态;崩溃细节见系统日志/冷却重试)"}`);
      reject(new Error("索引子进程退出 " + why));
    });
    worker.on("error", (e) => { building.delete(key); reject(e); });
  });
}

/** 首查等待上限(首查体验①):GENIE_SENSE_INDEX_WAIT_MS,默认 30000;0=关闭等待(旧行为)。 */
function firstQueryWaitMs(): number {
  const n = Number(process.env.GENIE_SENSE_INDEX_WAIT_MS ?? 30_000);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

/** 等待上限读取口(sense-tool flow 面降级文案展示上限用;与 firstQueryWaitMs 同口径)。 */
export function firstQueryWaitMsForLog(): number {
  return firstQueryWaitMs();
}

/** 该根是否有可信的「构建在飞」信号:本进程 building 表,或跨进程活 worker 登记(detached 单飞形态)。 */
function buildInFlight(root: string): boolean {
  if (building.has(root)) return true;
  try {
    const w = readWorkerPid(root);
    return !!w && pidMatches(w.pid, w.startTime);
  } catch {
    return false;
  }
}

/** 轮询等待构建落地(非阻塞纪律:500ms 间隔查内存缓存/盘上产物,每次都 setTimeout 让出事件循环
 *  ——构建本体在 detached worker 进程,网关主循环零阻塞)。返回 null=到点未就绪,或已确定
 *  不会有构建产出(失败冷却中/无在飞信号——不空等,立刻交还降级文案)。 */
async function waitForFreshIndex(root: string, timeoutMs: number): Promise<C2fIndex | null> {
  const t0 = Date.now();
  for (;;) {
    const idx = indexes.get(root) ?? await loadIndexAsync(root).catch(() => null);
    if (idx && !indexStale(root, idx)) { indexes.set(root, idx); return idx; }
    const failed = buildFailure.get(root);
    const cooling = !!failed && Date.now() - failed.at < (failed.cooldownMs ?? failureCooldownMs());
    if (cooling || !buildInFlight(root)) return null;
    const left = timeoutMs - (Date.now() - t0);
    if (left <= 0) return null;
    await new Promise((r) => setTimeout(r, Math.min(500, left)));
  }
}

/** 首查等待入口(codeIndexQuery 与 sense-tool flow 共用):确保构建在飞(幂等,
 *  在飞复用),轮询等其落地。timeoutMs 缺省=GENIE_SENSE_INDEX_WAIT_MS(默认 30s)。 */
export async function waitForIndexReady(root: string, timeoutMs?: number): Promise<C2fIndex | null> {
  const wait = timeoutMs ?? firstQueryWaitMs();
  const cur = indexes.get(root) ?? await loadIndexAsync(root).catch(() => null);
  if (cur && !indexStale(root, cur)) { indexes.set(root, cur); return cur; }
  void ensureIndex(root).catch(() => {});
  return waitForFreshIndex(root, wait);
}

/** 快取:盘上有且不过期→直接用(毫秒);否则后台重建,先返回盘上旧版(如有)。
 * 冻结治理:盘加载改异步预热——同步 readFileSync(29-40MB)在 9p 停顿时把
 *  worker 事件循环冻 183s。冷进程首次调用可能返回 null(异步加载 1-2s 内入内存缓存,
 *  下次调用即得);需要立刻拿索引的路径用 loadIndexAsync。 */
export function getIndexBestEffort(root: string): { index: C2fIndex | null; rebuilding: boolean; refused?: string } {
  const cached = indexes.get(root);
  if (cached && !indexStale(root, cached)) return { index: cached, rebuilding: false };
  if (!cached) {
    // 冷进程:异步预热内存缓存(不阻塞;失败静默——ensureIndex 路径会再处理)
    void loadIndexAsync(root).then((idx) => { if (idx) indexes.set(root, idx); }).catch(() => {});
  }
  const refused = refusedRoots.get(root);
  if (refused && !cached) {
    // 已拒根且没有任何可用索引:不再每查一次就重跑一遍闸(拒绝是策略不是抖动);TTL 过期由下次复核。
    return { index: null, rebuilding: false, refused: refused.reason };
  }
  const needs = indexStale(root, cached ?? null) || !cached;
  if (needs && !refused) void ensureIndex(root).catch(() => {});
  // review 抓:盘上索引新鲜且无需重建时,过去硬编码 rebuilding:true(codeIndexQuery 会误挂「后台更新中」)
  return { index: cached ?? null, rebuilding: needs };
}

/** 逐个预热未索引/过期子仓(首查体验②):gateway 启动后后台按序(detectWorkspaceRepos
 *  清单顺序,**逐个不并发**——慢盘上并发 fork 会互相拖慢且放大内存),已有新鲜索引跳过,其余
 *  ensureIndex 串行兜底(单飞锁幂等,失败只记日志,不抛不中断后续子仓)。 */
export async function warmWorkspaceSubrepos(base?: string, delayMs?: number): Promise<void> {
  const baseRoot = base ?? repoRoot();
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const { detectWorkspaceRepos } = await import("./sense-root-gate.js");
  const repos = await detectWorkspaceRepos(baseRoot);
 // a3(命中率三修):循环外计数,循环后输出一行汇总(全跳过也输出)——可观测性。
  let skipped = 0;
  let triggered = 0;
  let failed = 0;
  for (const r of repos) {
    try {
      const cur = indexes.get(r.path) ?? await loadIndexAsync(r.path).catch(() => null);
      if (cur && !indexStale(r.path, cur)) { skipped++; continue; } // 已有且新鲜:跳过
      triggered++;
      console.warn(`[sense-index] 子仓预热: ${r.name}(${r.path})`);
      await ensureIndex(r.path).catch((e) => { failed++; console.warn(`[sense-index] 子仓预热失败: ${r.name} ${String((e as Error)?.message ?? e).slice(0, 160)}(下查仍会触发/首查等待兜底)`); });
    } catch (e) {
      failed++;
      console.warn(`[sense-index] 子仓预热异常: ${r.name} ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }
  console.warn(`[sense-index] 子仓预热汇总: 跳过 ${skipped}(已新鲜) / 触发 ${triggered} / 失败 ${failed}`);
}

/** 服务启动预热(harness 根;fire-and-forget)+ 首调孤儿清扫。 */
export function warmIndex(root?: string): void {
  const r = root ?? repoRoot();
  if (!sweptRoots.has(r)) {
    sweptRoots.add(r);
    try {
      const rep = sweepOrphanIndexWorkers(r);
      if (rep.removedLocks + rep.killedWorkers + rep.removedPidFiles > 0) {
        console.warn(`[sense-index] 孤儿清扫: ${JSON.stringify(rep)}`);
      }
    } catch {
      /* 清扫失败不拦预热 */
    }
  }
  void ensureIndex(r).catch(() => {});
}

export interface SweepReport {
  root: string;
  removedLocks: number;
  killedWorkers: number;
  removedPidFiles: number;
  skipped: string[];
}

/** 孤儿清扫(manager 启动/warmIndex 首调):收割无主 worker 与死锁文件。
 * 证据链(缺证据不动手,礼貌边界):
 *  - build.lock 持有者 pid 已死(pid+starttime 双校验)→ 删锁;
 *  - worker.pid 持者 pid 已死 → 删登记;
 *  - worker.pid 持者活 + /proc cmdline 含 sense-index-worker + 其父 ppid 已死(确证孤儿)→ SIGKILL + 删登记;
 *  - 无 /proc(cmdline/ppid 不可读)或证据不足 → 只登记 skipped 不动手。 */
export function sweepOrphanIndexWorkers(root: string): SweepReport {
  const rep: SweepReport = { root, removedLocks: 0, killedWorkers: 0, removedPidFiles: 0, skipped: [] };
  // ① 死锁文件
  const { state } = readLockState(root);
  if (state === "stale") {
    try {
      rmSync(buildLockPath(root), { force: true });
      rep.removedLocks++;
    } catch {
      /* 删不掉留给接管逻辑 */
    }
  }
  // ② worker 登记
  const w = readWorkerPid(root);
  if (!w) return rep;
  if (!pidMatches(w.pid, w.startTime)) {
    try {
      rmSync(workerPidPath(root), { force: true });
      rep.removedPidFiles++;
    } catch {
      /* best effort */
    }
    return rep;
  }
  // ③ 活 worker:确证「sense-index-worker + 父已死」才杀
  let cmdline = "";
  try {
    cmdline = readFileSync(`/proc/${w.pid}/cmdline`, "utf-8");
  } catch {
    rep.skipped.push(`pid ${w.pid} 非 Linux/不可读 cmdline,不动手`);
    return rep;
  }
  if (!cmdline.includes("sense-index-worker")) {
    rep.skipped.push(`pid ${w.pid} cmdline 非 sense-index-worker(pid 复用?),不动手`);
    return rep;
  }
  const ppid = procPpid(w.pid);
  if (ppid === null) {
    rep.skipped.push(`pid ${w.pid} ppid 不可读,不动手`);
    return rep;
  }
  const parentAlive = ppid > 1 && pidMatches(ppid, null);
  if (parentAlive) return rep; // 正常在飞(worker 有活父),不碰
  try {
    process.kill(w.pid, "SIGKILL");
    rep.killedWorkers++;
  } catch {
    /* 已死:按登记清理 */
  }
  try {
    rmSync(workerPidPath(root), { force: true });
    rep.removedPidFiles++;
  } catch {
    /* best effort */
  }
  return rep;
}

function procPpid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ");
    const ppid = Number.parseInt(afterComm[1] ?? "", 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** code_index 工具的查询面(action 分派;全部读静态索引,毫秒级;索引缺失时显式降级)。
 * action=symbol/file/entrypoints/graph/filegraph/impact(impact=改动影响面清单——
 * 改函数前先查它,签名+双向闭包+受影响文件+关联测试一次出)/api(HTTP 接口表面——
 * 确定性行扫描不依赖索引,索引在场时附带 handler 影响面摘要)。 */
export async function codeIndexQuery(root: string, action: string, target: string): Promise<string> {
  if (action === "api") {
    // api 走 sensing 行扫描(索引非前置;影响面增强在索引在场时自动挂载)
    const r = await queryApiSurface(root, { withImpact: true });
    return renderApiSurface(r);
  }
  if (action === "project") {
 // P3:项目底座认知(读 .genie/sense-index/profile.json manifest;缺席=显式提示
    // 不触发 LLM 不阻塞;stale=指纹不匹配如实标注)
    const { loadProjectProfile, renderProjectProfile } = await import("@lampgenie/code-sense/project-profile");
    const loaded = loadProjectProfile(root);
    if (!loaded) {
      return "项目画像未生成:在项目根运行 codesense project --write(生成 .genie/sense-index/profile.json;确定性骨架无 LLM 也可用)";
    }
    return renderProjectProfile(loaded.profile, { stale: loaded.stale });
  }
  const { index, rebuilding, refused } = getIndexBestEffort(root);
  if (refused && !index) {
 // 巨根拒绝:绝不能再说「后台构建中」——没有构建在跑,也不会有。给工作区收窄出路。
    return workspaceRefusalText(root, { ok: false, files: 0, bytesMb: 0, reason: refused }, await detectWorkspaceRepos(root), "建索引");
  }
  // 巨根已有(采样)索引但被闸拒绝自动重建:照常服务 + 如实标注过期与收窄出路——
  // 拒绝遮蔽可用数据比数据旧一点更糟(symbol 查询对索引新旧不敏感)。
  const giantStaleNote = refused && index
    ? "\n(注:工作区根超预算不自动重建,以上基于既有索引" + (rebuilding ? "" : ",可能滞后于最新代码") + ";要新结果用 root=\"<子仓名>\" 收窄。)"
    : "";
  if (!index) {
 // 首查体验①:未索引子仓的首查不再立刻回「稍后再试」死路——同步**轮询等待**
    // 构建落地(GENIE_SENSE_INDEX_WAIT_MS,默认 30s;500ms 间隔,构建在 detached worker,
    // 网关主循环不被卡)。成功=直接回真实结果;到点未完=诚实降级,带已等待时长与预计剩余。
 // 失败冷却/无在飞信号时不空等,立即降级。 的洪峰教训保留:10 路并发首查共用
    // 同一单飞构建(building 表去重+跨进程锁),只等一次,不会造成建连洪峰。
    const t0 = Date.now();
    const ready = await waitForIndexReady(root);
    if (ready) {
      const out = formatQuery(ready, action, target);
      return (rebuilding ? out + rebuildNote(ready) : out);
    }
    const waitedSec = Math.round((Date.now() - t0) / 1000);
    const waitCapSec = Math.round(firstQueryWaitMs() / 1000);
    const remainSec = Math.max(0, waitCapSec - waitedSec);
    return `调用索引尚未就绪(已等待 ${waitedSec}s,预计剩余约 ${remainSec}s,上限 ${waitCapSec}s 由 GENIE_SENSE_INDEX_WAIT_MS 控制;首次构建需 1-2 分钟,后台进行中,稍后再试)`;
  }
  const out = formatQuery(index, action, target);
  if (giantStaleNote) return out + giantStaleNote;
  return rebuilding ? out + rebuildNote(index) : out;
}

/** 无构建查询(工作区扇出用):盘上有索引才查(loadIndexAsync,绝不触发构建/闸)。
 *  返回 null=该根没有盘上索引(扇出方如实标注「未搜索」);有则与 codeIndexQuery 同渲染。 */
export async function codeIndexQueryNoBuild(root: string, action: string, target: string): Promise<string | null> {
  const cached = indexes.get(root) ?? await loadIndexAsync(root);
  if (!cached) return null;
  if (cached) indexes.set(root, cached); // 顺手入内存缓存(读侧无害)
  return formatQuery(cached, action, target);
}

/** 符号命中渲染(formatQuery 与 a2 建议器共用:requery 结果与正常路径同形)。 */
function renderSymbolHits(hits: SymbolQueryResult[]): string {
  return hits.map((h) => {
    const s = h.symbol;
    const kindLabel = s.kind === "trunk" ? "入口(trunk,无人调用)" : s.kind === "leaf" ? "叶子(leaf,不调用他人)" : "常规";
    return [
      `${s.name} [${kindLabel}] — ${s.file}:${s.line}`,
      h.callers.length ? "  被调用(" + h.callers.length + "): " + h.callers.slice(0, 12).map((c) => `${c.name}@${c.file}:${c.line}`).join(", ") : "  被调用: 无(入口函数)",
      h.callees.length ? "  调用(" + h.callees.length + "): " + h.callees.slice(0, 12).map((c) => `${c.name}@${c.file}:${c.line}`).join(", ") : "  调用: 无(叶子函数)",
    ].join("\n");
  }).join("\n---\n");
}

/** 重建期注记:带上「当前结果基于哪次构建」——只写「更新中」时,模型无法判断
 * 手里这份结果可能落后多少(7700 注意:索引 8 天未重建,仍然只给一句「后台更新中」)。 */
function rebuildNote(index: C2fIndex): string {
  const built = typeof index.builtAt === "number" ? new Date(index.builtAt).toISOString().slice(0, 16).replace("T", " ") : "未知";
  return `\n(索引正在后台更新至最新代码状态;当前结果基于 ${built} 构建)`;
}

/** :file miss 的可操作回执(替代裸「文件无索引符号」)。
 *  三分支:①构建期被解析守卫跳过(带原因);②文件存在但晚于索引构建(索引滞后);
 *  ③确实查无此文件(保持原文案)。
 * 注意:15/23 次 file miss 是「文件存在且很新,只是索引没收录」——模型拿到裸文案只能换关键词硬撞。 */
function fileMissText(index: C2fIndex, target: string): string {
  const rel = target.replace(/\\/g, "/").replace(/^\.\//, "");
  const statusKey = index.fileStatus
    ? (Object.hasOwn(index.fileStatus, rel) ? rel : Object.keys(index.fileStatus).find((k) => k.endsWith("/" + rel)))
    : undefined;
  const st = statusKey ? index.fileStatus![statusKey] : undefined;
  // 兼容旧索引(有 skippedFiles 无 fileStatus):同一份原因表,不让升级前产物退化成裸文案。
  const legacySkip = !st && index.skippedFiles
    ? index.skippedFiles.find((s) => s.rel === rel || s.rel.endsWith("/" + rel) || rel.endsWith("/" + s.rel))
    : undefined;
  if (st?.status === "skipped" || legacySkip) {
    const reason = st?.status === "skipped" ? st.reason : legacySkip!.reason;
    return `文件未进索引: ${rel}\n原因: ${reason}\n`
      + "该文件仍可读:action=refs / grep / read_file 不受索引影响;要进索引设 GENIE_SENSE_PARSE_GUARD=off 后 codesense index --force。";
  }
  if (st?.status === "error") {
    return `文件解析失败(已登记): ${rel}\n原因: ${st.reason}\n`
      + "索引未能装载该文件;请用 read_file 查看,或用 action=refs / grep 定位内容。";
  }
  if (st?.status === "symbol-less") {
    return `文件已索引但无函数/类声明: ${rel}\n`
      + "该文件在扫描面内(解析成功),内容为 barrel 导出/副作用脚本/测试用例等无可索引顶层声明;"
      + "查其内容用 read_file / action=refs,查 import 关系用 action=impact(文件级 importers 通道)。";
  }
  if (isAbsolute(index.root)) {
    try {
      const fsSt = statSync(join(index.root, rel));
      if (fsSt.isFile() && fsSt.mtimeMs > (index.builtAt ?? 0)) {
        const fmt = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");
        return `文件存在但未进索引: ${rel}(文件 ${fmt(fsSt.mtimeMs)},索引构建于 ${fmt(index.builtAt ?? 0)})\n`
          + "索引已滞后,后台重建中;可先用 action=refs / grep,或 codesense index 重建后再查。";
      }
    } catch {
      /* 不存在/不可读:走原文案 */
    }
  }
  return `文件无索引符号: ${target}`;
}

/** 跳过文件的存在性注记(symbol/impact miss 时一行,避免模型以为「不存在」)。 */
function skippedFilesNote(index: C2fIndex): string {
  const n = index.skippedFiles?.length ?? 0;
  if (n === 0) return "";
  const sample = index.skippedFiles!.slice(0, 3).map((s) => s.rel).join(", ");
  return `\n(注:${n} 个文件因解析守卫未进索引:${sample}${n > 3 ? " …" : ""};若目标在其中,改用 action=refs 或 grep)`;
}

/** 导出仅供测试。 */
export function formatQuery(index: C2fIndex, action: string, target: string): string {
  if (action === "symbol") {
    const hits = querySymbol(index, target);
    if (hits.length === 0) {
      // 索引为空分支逐字保持(a2 契约:先判空再进建议逻辑,建议器只对非空索引生效)。
      return index.nodes.length === 0
        ? `未找到符号: ${target}(索引为空——语言未被索引覆盖或索引残缺,已触发后台重建)`
        : buildSymbolMissText(index, target, "symbol") + skippedFilesNote(index);
    }
    return renderSymbolHits(hits);
  }
  if (action === "file") {
    const nodes = queryFile(index, target);
    if (nodes.length === 0) return fileMissText(index, target);
 // P1:符号行带声明类型(有则显;旧索引无 dataType 字段=不显,重建后生效)
    return nodes.map((n) => `  ${n.kind === "trunk" ? "[入口]" : n.kind === "leaf" ? "[叶子]" : "      "} ${n.name} @:${n.line}${n.dataType ? ` [${n.dataType}]` : ""} (调用 ${n.outCount} / 被调 ${n.inCount})`).join("\n");
  }
  if (action === "entrypoints") {
    const eps = queryEntryPoints(index, 15);
    if (eps.length === 0) {
      // 空索引 ≠ 闭环/库形态:如实区分(降级显式原则)
      return index.nodes.length === 0
        ? "索引为空(无源码文件被索引——语言覆盖缺口或索引残缺,已触发后台重建)"
        : "无入口函数(入度全>0,可能闭环/库形态)";
    }
    return "入口函数(trunk,从这些开始读): \n" + eps.map((n) => `  ${n.name} — ${n.file}:${n.line} (下游 ${n.outCount})`).join("\n");
  }
  if (action === "graph") {
    return renderNeighborhood(index, target);
  }
  if (action === "filegraph") {
    return renderFile(index, target);
  }
  if (action === "impact") {
 // 改动影响面——签名/双向调用闭包(逐跳 dN)/受影响文件/关联测试,一次查询全出。
    if (!target.trim()) return "impact 需要 target=符号名(如: evaluatePermission)";
    const r = queryImpact(index, target, { depth: 2 });
    if (r.definitions.length === 0) {
      // 索引为空分支逐字保持(a2 契约)。
      return index.nodes.length === 0
        ? `未找到符号: ${target}(索引为空——语言未被索引覆盖或索引残缺,已触发后台重建)`
        : buildSymbolMissText(index, target, "impact") + skippedFilesNote(index);
    }
    return renderImpact(r);
  }
  return "action 必须是 symbol/file/entrypoints/graph/filegraph/impact/api/project";
}

/** a2(命中率三修):symbol/impact 精确 miss 时给确定性建议——不让 agent 断链。
 *  两档:suggestSymbolNames(典范形/编辑距离,c2f 现成)+ camelTokenSuggest(查询词元 ⊆ 候选词元,
 * "runWorkflow"→"WorkflowEngine.run" 注意)。恰好 1 个候选=自动改查并带注记行;≥2 个=给候选清单
 *  (symbol/impact 按精确名重查)。**契约:miss 文本必须仍以「未找到符号」开头**——
 *  sense-tool.ts:277/284 扇出过滤、agent-wiring.ts:2416 都按 startsWith("未找到符号") 过滤,不可破坏。 */
function buildSymbolMissText(index: C2fIndex, target: string, action: "symbol" | "impact"): string {
  const names = [...new Set([
    ...suggestSymbolNames(index, target, 5),
    ...camelTokenSuggest(index, target, 3),
  ])];
  const first = names[0];
  if (names.length === 1 && first) {
    // 唯一近似命中:直接改查,结果前加注记行(结果与正常路径同形)。
    const reread = action === "symbol"
      ? renderSymbolHits(querySymbol(index, first))
      : renderImpact(queryImpact(index, first, { depth: 2 }));
    return `未找到符号: ${target},已按索引内唯一近似命中(自动改查 ${first}):\n${reread}`;
  }
  const pathNote = /[\\/]/.test(target) ? `\n(target 是路径形态:改用 action=file target="${target}" 查符号表)` : "";
  if (names.length >= 2) {
    return `未找到符号: ${target}\n(试试索引内近似符号: ${names.join(", ")}——symbol/impact 按精确名重查)${pathNote}`;
  }
  return `未找到符号: ${target}${pathNote}`;
}

/** camelTokenSuggest:名字按驼峰/下划线/点切小写词元("runWorkflow"→[run,workflow],
 *  "WorkflowEngine.run"→[workflow,engine,run]);候选=byName 键中查询词元 ⊆ 候选词元且候选≠查询名;
 *  按该名下节点最大 inCount 降序取 limit。 */
function camelTokenSuggest(index: C2fIndex, target: string, limit: number): string[] {
  const tokens = camelTokens(target);
  if (tokens.length === 0) return [];
  const cands: { name: string; inCount: number }[] = [];
  for (const cand of Object.keys(index.byName)) {
    if (!Object.hasOwn(index.byName, cand)) continue; // 原型键守卫(与 querySymbol 同口径)
    if (cand === target) continue;
    const candTokens = camelTokens(cand);
    if (candTokens.length === 0 || candTokens.length < tokens.length) continue;
    const set = new Set(candTokens);
    if (!tokens.every((tk) => set.has(tk))) continue;
    let max = 0;
    for (const id of index.byName[cand]!) {
      const n = index.nodes.find((x) => x.id === id);
      if (n && n.inCount > max) max = n.inCount;
    }
    cands.push({ name: cand, inCount: max });
  }
  return cands
    .sort((a, b) => b.inCount - a.inCount || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((c) => c.name);
}

/** 词元切分:驼峰边界 + 下划线/连字符/点/空白分隔,全小写;纯数字段保留。 */
function camelTokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-./\\]+/)
    .map((tk) => tk.trim().toLowerCase())
    .filter(Boolean);
}
