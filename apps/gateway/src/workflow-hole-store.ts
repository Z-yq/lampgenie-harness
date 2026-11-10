/**
 * 工作流留白的持久层(gateway 侧):把 workflow-hole 的纯逻辑落到 `<root>/.genie/rsi/holes.json`,
 * 并把「当前脚本源」同步成可执行的草稿 `<root>/drafts/<id>.mjs`。
 *
 * 为什么落在状态文件 + 草稿两份:
 * - holes.json 记的是判断历史(哪些留白、哪些已填、函数体记忆),丢了就得重新问模型;
 * - drafts/<id>.mjs 记的是「此刻脚本长什么样」——停驻时人和调试器直接看这份文件,不必反解 json。
 * 两份都由同一个 HoleState 派生,写入顺序固定(先 states 后 draft),失败折叠成稳定码而不是半真半假。
 *
 * 为什么写入必须原子(写 tmp 再 rename):停驻中的脚本是唯一可恢复副本,写到一半被 kill 会得到
 * 一个既不是旧状态也不是新状态的 json(下次 load 直接 parse 失败,等于丢整份历史)。
 * rename 在同一文件系统上是原子的,写后重读比对让「写成功了吗」成为可复核断言。
 *
 * 依赖纪律:node:fs / node:path;runtime 纯逻辑模块按 defect-lineage-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 不静态 import runtime 的 workflow-hole:gateway 的 tsc 走 runtime dist,新文件未 build 会 TS2307;
 * 类型侧允许(types 条件指向 src),值侧一律走上面的惰性解析。
 * 除参数错误外不 throw:坏 JSON 当成空 states 并计入 parseErrors,IO/校验失败折叠成稳定码。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { HoleReachedEvent, HoleSite, HoleState } from "@lampgenie/runtime/agent/workflow-hole";

/** store 稳定码:store 层自产的失败码(hole 结局码沿用 runtime 的 HOLE_CODES)。 */
export const WORKFLOW_HOLE_STORE_CODES = [
  "WORKFLOW_HOLE_NOT_FOUND",
  "WORKFLOW_HOLE_INVALID_INPUT",
  "WORKFLOW_HOLE_STORE_ERROR",
  "WORKFLOW_HOLE_WRITE_VERIFY_FAILED",
] as const;

export type WorkflowHoleStoreCode = (typeof WORKFLOW_HOLE_STORE_CODES)[number];

/** 状态文件 schema 版本:字段语义变化时递增。 */
export const HOLES_STORE_VERSION = 1;

/** 落盘结构:一个 root 下所有留白工作流的 states 表。 */
interface HolesFile {
  v: number;
  states: Record<string, HoleState>;
}

/** runtime 面(惰性解析,见文件头依赖纪律)。 */
interface HoleRuntime {
  scanHoles(source: string, opts?: { id?: string }): {
    ok: boolean;
    codes: string[];
    state: HoleState;
    count?: number;
  };
  reachHole(state: HoleState, siteId: string, opts?: { root?: string }): {
    ok: boolean;
    codes: string[];
    state: HoleState;
    event?: HoleReachedEvent;
  };
  fillHole(
    state: HoleState,
    input: { siteId: string; body: string; at?: number; root?: string },
  ): { ok: boolean; codes: string[]; state: HoleState; reason?: string; resumed?: boolean; site?: HoleSite };
  chainTail(state: HoleState, input: { name: string; prompt: string; at?: number }): {
    ok: boolean;
    codes: string[];
    state: HoleState;
    site?: HoleSite;
  };
  draftPath(state: HoleState, root?: string): string;
  roughCompileCheck(source: string): { ok: boolean; reason?: string };
}

let holeRuntime: HoleRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadHoleRuntime(): Promise<HoleRuntime> {
  if (holeRuntime) return holeRuntime;
  const spec = "@lampgenie/runtime/agent/workflow-hole";
  try {
    holeRuntime = (await import(spec)) as HoleRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/workflow-hole.ts", import.meta.url).href;
    holeRuntime = (await import(srcUrl)) as HoleRuntime;
  }
  return holeRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadHoleRuntime();

/** 状态文件路径:`<root>/.genie/rsi/holes.json`。 */
export function holesPath(root: string): string {
  return join(root, ".genie", "rsi", "holes.json");
}

/** 草稿目录:`<root>/drafts`(与 runtime 的 draftPath 同构)。 */
export function draftsDir(root: string): string {
  return join(root, "drafts");
}

/** 单个工作流的草稿路径(交给 runtime 保持唯一口径)。 */
function draftFile(root: string, state: HoleState): string {
  return join(root, "drafts", `${state.script.id}.mjs`);
}

/** 一次 load 的结果:states + 坏条目计数(坏一条不整文件失效)。 */
interface LoadResult {
  states: Record<string, HoleState>;
  parseErrors: number;
  error?: string;
}

/** 合法 state 的最小形状校验(字段级,不用 zod:这里只要「能安全参与后续运算」)。 */
function isHoleState(value: unknown): value is HoleState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<HoleState>;
  const script = candidate.script as { id?: unknown; source?: unknown; hash?: unknown } | undefined;
  if (script === undefined || script === null) return false;
  if (typeof script.id !== "string" || typeof script.source !== "string" || typeof script.hash !== "string") return false;
  if (candidate.sites === null || typeof candidate.sites !== "object") return false;
  if (candidate.memory === null || typeof candidate.memory !== "object") return false;
  return true;
}

/** 载入 states 文件:不存在 → 空;坏 JSON → 空 + parseErrors(不 throw)。 */
function loadStates(root: string): LoadResult {
  const file = holesPath(root);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { states: {}, parseErrors: 0 };
    return { states: {}, parseErrors: 0, error: `读状态文件失败:${String(code ?? error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { states: {}, parseErrors: 1 };
  }
  if (parsed === null || typeof parsed !== "object") return { states: {}, parseErrors: 1 };
  const file1 = parsed as Partial<HolesFile>;
  const rawStates = file1.states;
  if (rawStates === null || typeof rawStates !== "object") return { states: {}, parseErrors: 1 };
  const states: Record<string, HoleState> = {};
  let parseErrors = 0;
  if (file1.v !== HOLES_STORE_VERSION) parseErrors += 1;
  for (const [id, value] of Object.entries(rawStates as Record<string, unknown>)) {
    if (isHoleState(value)) states[id] = value;
    else parseErrors += 1;
  }
  return { states, parseErrors };
}

/** 原子写:先写 `<file>.tmp-<pid>-<rand>` 再 rename;写后重读比对。 */
function writeAtomic(file: string, content: string): { ok: boolean; reason?: string } {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    return { ok: false, reason: `写 ${file} 失败:${String((error as { code?: string }).code ?? error)}` };
  }
  try {
    if (readFileSync(file, "utf8") !== content) return { ok: false, reason: `写后重读不一致:${file}` };
  } catch (error) {
    return { ok: false, reason: `写后重读失败:${String((error as { code?: string }).code ?? error)}` };
  }
  return { ok: true };
}

/** 落盘 states(原子),失败返回稳定码。 */
function saveStates(root: string, states: Record<string, HoleState>): { ok: boolean; code?: string; reason?: string } {
  const payload: HolesFile = { v: HOLES_STORE_VERSION, states };
  const written = writeAtomic(holesPath(root), `${JSON.stringify(payload, null, 2)}\n`);
  if (!written.ok) return { ok: false, code: "WORKFLOW_HOLE_WRITE_VERIFY_FAILED", reason: written.reason };
  return { ok: true };
}

/** 落盘草稿(内容是当前 script.source),失败返回稳定码。 */
function saveDraft(root: string, state: HoleState): { ok: boolean; code?: string; reason?: string } {
  const written = writeAtomic(draftFile(root, state), state.script.source);
  if (!written.ok) return { ok: false, code: "WORKFLOW_HOLE_WRITE_VERIFY_FAILED", reason: written.reason };
  return { ok: true };
}

/** 稳定地解出 root 下的 file 参数(相对路径按 root 解析)。 */
function resolveInputFile(root: string, file: string): string {
  return isAbsolute(file) ? file : join(root, file);
}

/** scan 结果。 */
export interface ScanScriptResult {
  ok: boolean;
  codes: string[];
  state?: HoleState;
  count?: number;
  draftPath?: string;
  parseErrors?: number;
  reason?: string;
}

/**
 * 扫描一段脚本(或一个脚本文件),落盘 states[id] 与草稿,返回 state。
 * 同一 id 再扫一次 = 用新源覆盖该 id(幂等:同源重复扫得到同一份 states 内容)。
 */
export function scanScript(
  root: string,
  input: { id?: string; source?: string; file?: string },
  opts?: { at?: number },
): ScanScriptResult {
  void opts;
  let source = typeof input?.source === "string" ? input.source : undefined;
  if (source === undefined) {
    const file = typeof input?.file === "string" ? input.file.trim() : "";
    if (file === "") return { ok: false, codes: ["WORKFLOW_HOLE_INVALID_INPUT"], reason: "需要 source 或 file" };
    try {
      source = readFileSync(resolveInputFile(root, file), "utf8");
    } catch (error) {
      return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: `读 ${file} 失败:${String(error)}` };
    }
  }
  const scanned = rt.scanHoles(source, input?.id !== undefined ? { id: input.id } : undefined);
  const state = scanned.state;
  try {
    const loaded = loadStates(root);
    if (loaded.error !== undefined) return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: loaded.error };
    const states = { ...loaded.states, [state.script.id]: state };
    const saved = saveStates(root, states);
    if (!saved.ok) return { ok: false, codes: [saved.code ?? "WORKFLOW_HOLE_STORE_ERROR"], reason: saved.reason };
    const drafted = saveDraft(root, state);
    if (!drafted.ok) return { ok: false, codes: [drafted.code ?? "WORKFLOW_HOLE_STORE_ERROR"], reason: drafted.reason };
    return {
      ok: true,
      codes: scanned.codes,
      state,
      count: scanned.count ?? Object.keys(state.sites).length,
      draftPath: draftFile(root, state),
      parseErrors: loaded.parseErrors,
    };
  } catch (error) {
    return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: String(error) };
  }
}

/** reach 结果。 */
export interface ReachHoleAtResult {
  ok: boolean;
  codes: string[];
  state?: HoleState;
  event?: HoleReachedEvent;
  reason?: string;
}

/**
 * 到达留白点:成功则把 stoppedAt 落盘(停驻状态是跨进程事实,进程退出后仍要能看见停在哪)。
 * site 不存在 / 已 filled 时不落盘,原 state 保持。
 */
export function reachHoleAt(root: string, id: string, siteId: string): ReachHoleAtResult {
  if (typeof id !== "string" || id === "" || typeof siteId !== "string" || siteId === "") {
    return { ok: false, codes: ["WORKFLOW_HOLE_INVALID_INPUT"], reason: "id 与 siteId 必填" };
  }
  try {
    const loaded = loadStates(root);
    if (loaded.error !== undefined) return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: loaded.error };
    const state = loaded.states[id];
    if (state === undefined) return { ok: false, codes: ["WORKFLOW_HOLE_NOT_FOUND"], reason: id };
    const reached = rt.reachHole(state, siteId, { root });
    if (!reached.ok) return { ok: false, codes: reached.codes, state: reached.state };
    const saved = saveStates(root, { ...loaded.states, [id]: reached.state });
    if (!saved.ok) return { ok: false, codes: [saved.code ?? "WORKFLOW_HOLE_STORE_ERROR"], reason: saved.reason };
    return { ok: true, codes: reached.codes, state: reached.state, event: reached.event };
  } catch (error) {
    return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: String(error) };
  }
}

/** fill 结果。 */
export interface FillHoleAtResult {
  ok: boolean;
  codes: string[];
  state?: HoleState;
  resumed?: boolean;
  site?: HoleSite;
  reason?: string;
}

/**
 * 填充留白点:只提交函数体语句,runtime 负责拼接/重编译/漂移校验。
 * 校验失败(漂移 / 坏体 / 编译失败)不落盘 —— 半成品 splice 比不补更贵,site 保持 waiting。
 */
export function fillHoleAt(root: string, id: string, input: { siteId: string; body: string; at?: number }): FillHoleAtResult {
  if (typeof id !== "string" || id === "" || typeof input?.siteId !== "string" || input.siteId === "") {
    return { ok: false, codes: ["WORKFLOW_HOLE_INVALID_INPUT"], reason: "id 与 siteId 必填" };
  }
  if (typeof input.body !== "string") {
    return { ok: false, codes: ["WORKFLOW_HOLE_INVALID_INPUT"], reason: "body 必填" };
  }
  try {
    const loaded = loadStates(root);
    if (loaded.error !== undefined) return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: loaded.error };
    const state = loaded.states[id];
    if (state === undefined) return { ok: false, codes: ["WORKFLOW_HOLE_NOT_FOUND"], reason: id };
    const filled = rt.fillHole(state, { ...input, root });
    if (!filled.ok) {
      return { ok: false, codes: filled.codes, state: filled.state, reason: filled.reason };
    }
    const saved = saveStates(root, { ...loaded.states, [id]: filled.state });
    if (!saved.ok) return { ok: false, codes: [saved.code ?? "WORKFLOW_HOLE_STORE_ERROR"], reason: saved.reason };
    const drafted = saveDraft(root, filled.state);
    if (!drafted.ok) return { ok: false, codes: [drafted.code ?? "WORKFLOW_HOLE_STORE_ERROR"], reason: drafted.reason };
    return { ok: true, codes: filled.codes, state: filled.state, resumed: filled.resumed, site: filled.site };
  } catch (error) {
    return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: String(error) };
  }
}

/** chain 结果。 */
export interface ChainHoleAtResult {
  ok: boolean;
  codes: string[];
  state?: HoleState;
  site?: HoleSite;
  reason?: string;
}

/** 在脚本尾部链式长出一个新的留白点,成功则落盘 states 与草稿。 */
export function chainHoleAt(
  root: string,
  id: string,
  input: { name: string; prompt: string; at?: number },
): ChainHoleAtResult {
  if (typeof id !== "string" || id === "" || typeof input?.name !== "string") {
    return { ok: false, codes: ["WORKFLOW_HOLE_INVALID_INPUT"], reason: "id 与 name 必填" };
  }
  try {
    const loaded = loadStates(root);
    if (loaded.error !== undefined) return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: loaded.error };
    const state = loaded.states[id];
    if (state === undefined) return { ok: false, codes: ["WORKFLOW_HOLE_NOT_FOUND"], reason: id };
    const chained = rt.chainTail(state, { name: input.name, prompt: input.prompt ?? "", at: input.at });
    if (!chained.ok) return { ok: false, codes: chained.codes, state: chained.state };
    const saved = saveStates(root, { ...loaded.states, [id]: chained.state });
    if (!saved.ok) return { ok: false, codes: [saved.code ?? "WORKFLOW_HOLE_STORE_ERROR"], reason: saved.reason };
    const drafted = saveDraft(root, chained.state);
    if (!drafted.ok) return { ok: false, codes: [drafted.code ?? "WORKFLOW_HOLE_STORE_ERROR"], reason: drafted.reason };
    return { ok: true, codes: chained.codes, state: chained.state, site: chained.site };
  } catch (error) {
    return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: String(error) };
  }
}

/** 单个工作流的读取结果。 */
export interface GetStateResult {
  ok: boolean;
  codes: string[];
  state?: HoleState;
  draftPath?: string;
  reason?: string;
}

/** 读一个工作流的状态(含草稿路径;草稿本身由 scan/fill/chain 写入)。 */
export function getState(root: string, id: string): GetStateResult {
  try {
    const loaded = loadStates(root);
    if (loaded.error !== undefined) return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: loaded.error };
    const state = loaded.states[id];
    if (state === undefined) return { ok: false, codes: ["WORKFLOW_HOLE_NOT_FOUND"], reason: id };
    return { ok: true, codes: [], state, draftPath: draftFile(root, state) };
  } catch (error) {
    return { ok: false, codes: ["WORKFLOW_HOLE_STORE_ERROR"], reason: String(error) };
  }
}

/** 列表项摘要(不吐整份 source,列表场景只要计数)。 */
export interface HoleStateSummary {
  id: string;
  hash: string;
  lines: number;
  sites: number;
  waiting: number;
  filled: number;
  stoppedAt?: string;
  draftPath: string;
}

/** 列出所有工作流摘要。 */
export function listStates(root: string): { ok: boolean; codes: string[]; states: HoleStateSummary[]; parseErrors: number } {
  const loaded = loadStates(root);
  const summaries: HoleStateSummary[] = [];
  for (const [id, state] of Object.entries(loaded.states)) {
    const sites = Object.values(state.sites);
    summaries.push({
      id,
      hash: state.script.hash,
      lines: state.script.source.split("\n").length,
      sites: sites.length,
      waiting: sites.filter((s) => s.status === "waiting").length,
      filled: sites.filter((s) => s.status === "filled").length,
      stoppedAt: state.stoppedAt,
      draftPath: draftFile(root, state),
    });
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, codes: [], states: summaries, parseErrors: loaded.parseErrors };
}

/** 报表(rsi 汇总用):站点计数 + 记忆命中 + 草稿数量 + 坏条目。 */
export interface HolesReport {
  ok: boolean;
  total: number;
  byStatus: { waiting: number; filled: number };
  waitingSites: number;
  memoryHits: number;
  drafts: number;
  parseErrors: number;
}

/** 汇总报表:坏 JSON 也返回 ok:true(带 parseErrors),报表本身不该因为历史坏了而不可读。 */
export function reportHoles(root: string): HolesReport {
  const loaded = loadStates(root);
  let waiting = 0;
  let filled = 0;
  let memoryHits = 0;
  const states = Object.values(loaded.states);
  for (const state of states) {
    for (const site of Object.values(state.sites)) {
      if (site.status === "filled") filled += 1;
      else waiting += 1;
    }
    memoryHits += Object.keys(state.memory).length;
  }
  let drafts = 0;
  try {
    drafts = readdirSync(draftsDir(root)).filter((name) => name.endsWith(".mjs")).length;
  } catch {
    drafts = 0;
  }
  const report: HolesReport = {
    ok: true,
    total: states.length,
    byStatus: { waiting, filled },
    waitingSites: waiting,
    memoryHits,
    drafts,
    parseErrors: loaded.parseErrors,
  };
  return report;
}
