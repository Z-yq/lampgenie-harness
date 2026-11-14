/**
 * 唯一 token 估算 + 标定模块(自有实现,无第三方分词器)。
 * 组成:
 *  1) 自有启发式计数:CJK 感知双系数(汉字类 1.95/字、其它 0.25/字,ceil)——
 *     压缩门/微压缩/大结果门等消费方全部是带余量的近似门控,该口径与标定层配合足够;
 *     纯函数、零依赖、零资产,任何环境可用。
 *  2) 标定层:用 provider 上报 usage 学习「自有估算 → 真实 token」的比例 ratio
 *     (输入 / 输出各一条,EWMA,落盘 .genie/token-calibration.json)。
 * 约定:所有导出函数永不抛。计费口径不受本模块影响(始终用 provider 上报 usage)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** rawTokens 结果缓存上限,超出清掉一半(LRU-lite)。 */
const RAW_CACHE_LIMIT = 4000;
/** 进缓存的文本长度上限,避免长文档 e4 级内存。 */
const RAW_CACHE_MAX_TEXT = 8192;
/** 系数:汉字类(含假名/谚文/全角)每字。 */
const CJK_TOKENS_PER_CHAR = 1.95;
/** 系数:其它字符每字。 */
const OTHER_TOKENS_PER_CHAR = 0.25;
/** 粗算(无原文)时用:混合语料的经验 tokens/字符。 */
const APPROX_TOKENS_PER_CHAR = 0.35;

/** 标定启用门槛:样本数 ≥ 此值才用 ratio,否则恒 1。 */
const MIN_SAMPLES = 3;
/** EWMA 系数。 */
const EWMA_ALPHA = 0.2;
/** 可信区间与夹取区间。 */
const RATIO_MIN = 0.5;
const RATIO_MAX = 3.0;
/** 每键保留的近期样本数。 */
const RATIO_HISTORY = 32;
/** 落盘节流窗口。 */
const WRITE_THROTTLE_MS = 60_000;
/** 默认标定文件名。 */
const DEFAULT_CALIBRATION_FILE = join(".genie", "token-calibration.json");

// ---------------------------------------------------------------------------
// 自有估算器
// ---------------------------------------------------------------------------

const rawCache = new Map<string, number>();

/** 码点是否属于汉字类(含假名 / 谚文 / 全角标点)。 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名 / 片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII / 标点
    (cp >= 0x20000 && cp <= 0x2fa1f) // 扩展 B+
  );
}

/** 自有启发式计数:按码点分类累计后取整(ceil)。 */
function ownCount(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_CHAR);
}

function cachePut(text: string, tokens: number): void {
  if (text.length > RAW_CACHE_MAX_TEXT) return;
  if (rawCache.size >= RAW_CACHE_LIMIT) {
    let drop = Math.ceil(RAW_CACHE_LIMIT / 2);
    for (const key of rawCache.keys()) {
      rawCache.delete(key);
      if (--drop <= 0) break;
    }
  }
  rawCache.set(text, tokens);
}

/** 自有原始计数(不乘标定系数)。异常 / 空输入 → 0,永不抛。 */
export function rawTokens(text: string): number {
  try {
    if (typeof text !== "string" || text.length === 0) return 0;
    const cached = rawCache.get(text);
    if (cached !== undefined) return cached;
    const tokens = ownCount(text);
    cachePut(text, tokens);
    return tokens;
  } catch {
    return 0;
  }
}

/** 估算器状态:恒为自有启发式(保留导出供观测面/测试用)。 */
export function estimatorKind(): "own-heuristic" {
  return "own-heuristic";
}

// ---------------------------------------------------------------------------
// 标定状态
// ---------------------------------------------------------------------------

interface KeyState {
  ratios: number[];
  samples: number;
  ratio: number;
  outputRatios: number[];
  outputSamples: number;
  outputRatio: number;
}

interface PersistKey {
  ratio: number;
  outputRatio: number;
  samples: number;
  outputSamples: number;
  ratios: number[];
  outputRatios: number[];
}

interface PersistShape {
  version: number;
  providers: Record<string, PersistKey>;
}

const states = new Map<string, KeyState>();
let calibLoaded = false;
let calibDirty = false;
let lastWriteAt = 0;
let calibFileOverride: string | null = null;
let calibWarned = false;

function keyOf(providerKey?: string, model?: string): string {
  return `${providerKey ?? ""}|${model ?? ""}`;
}

function emptyState(): KeyState {
  return { ratios: [], samples: 0, ratio: 1, outputRatios: [], outputSamples: 0, outputRatio: 1 };
}

function stateOf(key: string): KeyState {
  let s = states.get(key);
  if (!s) {
    s = emptyState();
    states.set(key, s);
  }
  return s;
}

function clampRatio(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, v));
}

function resolveCalibrationFile(): string {
  if (calibFileOverride) return calibFileOverride;
  const fromEnv = process.env["GENIE_CALIBRATION_FILE"];
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  const cwd = process.cwd();
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".genie"))) return join(dir, DEFAULT_CALIBRATION_FILE);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(cwd, DEFAULT_CALIBRATION_FILE);
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

function loadPersisted(raw: unknown): Map<string, KeyState> {
  const out = new Map<string, KeyState>();
  if (!raw || typeof raw !== "object") return out;
  const providers = (raw as PersistShape).providers;
  if (!providers || typeof providers !== "object") return out;
  for (const [key, value] of Object.entries(providers)) {
    if (!value || typeof value !== "object") continue;
    const v = value as PersistKey;
    const s = emptyState();
    s.ratio = typeof v.ratio === "number" && Number.isFinite(v.ratio) ? clampRatio(v.ratio) : 1;
    s.outputRatio = typeof v.outputRatio === "number" && Number.isFinite(v.outputRatio) ? clampRatio(v.outputRatio) : 1;
    s.samples = typeof v.samples === "number" && v.samples >= 0 ? Math.floor(v.samples) : 0;
    s.outputSamples = typeof v.outputSamples === "number" && v.outputSamples >= 0 ? Math.floor(v.outputSamples) : 0;
    s.ratios = isNumberArray(v.ratios) ? v.ratios.slice(-RATIO_HISTORY) : [];
    s.outputRatios = isNumberArray(v.outputRatios) ? v.outputRatios.slice(-RATIO_HISTORY) : [];
    out.set(key, s);
  }
  return out;
}

/** 首次用到标定时同步 lazy load 一次;损坏则回空态并 warn 一次。 */
function ensureCalibrationLoaded(): void {
  if (calibLoaded) return;
  calibLoaded = true;
  try {
    const file = resolveCalibrationFile();
    if (!existsSync(file)) return;
    const text = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    for (const [key, state] of loadPersisted(parsed)) states.set(key, state);
  } catch (err) {
    states.clear();
    if (!calibWarned) {
      calibWarned = true;
      try {
        console.warn(`[token-estimate] calibration file unusable, reset to empty: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        /* ignore */
      }
    }
  }
}

function persist(force: boolean): void {
  try {
    if (!calibDirty && !force) return;
    const now = Date.now();
    if (!force && now - lastWriteAt < WRITE_THROTTLE_MS) {
      calibDirty = true;
      return;
    }
    const providers: Record<string, PersistKey> = {};
    for (const [key, s] of states) {
      providers[key] = {
        ratio: s.ratio,
        outputRatio: s.outputRatio,
        samples: s.samples,
        outputSamples: s.outputSamples,
        ratios: s.ratios.slice(-RATIO_HISTORY),
        outputRatios: s.outputRatios.slice(-RATIO_HISTORY),
      };
    }
    const payload: PersistShape = { version: 1, providers };
    const file = resolveCalibrationFile();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(payload), "utf8");
    renameSync(tmp, file);
    calibDirty = false;
    lastWriteAt = now;
  } catch {
    calibDirty = true;
  }
}

function feedSample(ratios: number[], samples: number, ratio: number, r: number): { ratios: number[]; samples: number; ratio: number } {
  const next = ratios.concat(r);
  while (next.length > RATIO_HISTORY) next.shift();
  const nextSamples = samples + 1;
  let nextRatio = ratio;
  if (nextSamples === MIN_SAMPLES) {
    // 首批样本均值做初值,避免从 1 缓慢漂移
    nextRatio = next.reduce((a, b) => a + b, 0) / next.length;
  } else if (nextSamples > MIN_SAMPLES) {
    nextRatio = (1 - EWMA_ALPHA) * ratio + EWMA_ALPHA * r;
  }
  return { ratios: next, samples: nextSamples, ratio: clampRatio(nextRatio) };
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/** 标定后估算 = ceil(rawTokens(text) * ratio)。ratio 缺省 / 无样本 = 1。 */
export function estimateTokens(text: string, opts?: { providerKey?: string; model?: string }): number {
  try {
    const raw = rawTokens(text);
    if (raw <= 0) return 0;
    const ratio = calibrationOf(opts?.providerKey, opts?.model).ratio;
    return Math.ceil(raw * ratio);
  } catch {
    return 0;
  }
}

function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const out = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
      }
      return v;
    });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

function messageParts(m: unknown): string[] {
  const parts: string[] = [];
  if (m === null || m === undefined) return parts;
  if (typeof m === "string") return [m];
  if (typeof m !== "object") return [String(m)];
  const rec = m as Record<string, unknown>;
  if (typeof rec["role"] === "string") parts.push(rec["role"]);
  const content = rec["content"];
  if (typeof content === "string") parts.push(content);
  else if (content !== null && content !== undefined) parts.push(safeJson(content));
  if (typeof rec["toolCallId"] === "string") parts.push(rec["toolCallId"]);
  const toolCalls = rec["toolCalls"];
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as Record<string, unknown>;
      if (typeof t["name"] === "string") parts.push(t["name"]);
      const args = t["arguments"];
      if (typeof args === "string") parts.push(args);
      else if (args !== null && args !== undefined) parts.push(safeJson(args));
    }
  }
  return parts;
}

function rawOfMessage(m: unknown): number {
  let total = 0;
  for (const part of messageParts(m)) {
    if (part.length === 0) continue;
    total += rawTokens(part);
  }
  return total;
}

/** 单条消息的估算(role + content + toolCalls[].arguments),同样乘 ratio。 */
export function estimateMessageTokens(m: unknown, opts?: { providerKey?: string; model?: string }): number {
  try {
    const raw = rawOfMessage(m);
    if (raw <= 0) return 0;
    const ratio = calibrationOf(opts?.providerKey, opts?.model).ratio;
    return Math.ceil(raw * ratio);
  } catch {
    return 0;
  }
}

/** 消息数组的估算(原汇总后乘一次 ratio)。 */
export function estimateMessagesTokens(messages: readonly unknown[], opts?: { providerKey?: string; model?: string }): number {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let raw = 0;
    for (const m of messages) raw += rawOfMessage(m);
    if (raw <= 0) return 0;
    const ratio = calibrationOf(opts?.providerKey, opts?.model).ratio;
    return Math.ceil(raw * ratio);
  } catch {
    return 0;
  }
}

/** 字符量 → token 的粗算(无原文场合),CJK 感知,不乘 ratio。 */
export function approxTokensOfChars(chars: number): number {
  try {
    if (!Number.isFinite(chars) || chars <= 0) return 0;
    return Math.ceil(chars * APPROX_TOKENS_PER_CHAR);
  } catch {
    return 0;
  }
}

/** 标定采样:用 provider 上报 usage 更新 ratio。返回本次是否计入样本。 */
export function calibrate(input: {
  providerKey: string;
  model: string;
  estInputRaw?: number;
  reportedInput?: number;
  estOutputRaw?: number;
  reportedOutput?: number;
  suspect?: boolean;
}): { inputSampled: boolean; outputSampled: boolean; ratio: number; outputRatio: number; samples: number } {
  try {
    ensureCalibrationLoaded();
    const key = keyOf(input.providerKey, input.model);
    const state = stateOf(key);
    let inputSampled = false;
    let outputSampled = false;
    if (input.suspect !== true) {
      const r = ratioOfSample(input.estInputRaw, input.reportedInput);
      if (r !== null) {
        const next = feedSample(state.ratios, state.samples, state.ratio, r);
        state.ratios = next.ratios;
        state.samples = next.samples;
        state.ratio = next.ratio;
        inputSampled = true;
      }
      const or = ratioOfSample(input.estOutputRaw, input.reportedOutput);
      if (or !== null) {
        const nextOut = feedSample(state.outputRatios, state.outputSamples, state.outputRatio, or);
        state.outputRatios = nextOut.ratios;
        state.outputSamples = nextOut.samples;
        state.outputRatio = nextOut.ratio;
        outputSampled = true;
      }
    }
    if (inputSampled || outputSampled) {
      calibDirty = true;
      persist(false);
    }
    return {
      inputSampled,
      outputSampled,
      ratio: state.ratio,
      outputRatio: state.outputRatio,
      samples: state.samples,
    };
  } catch {
    return { inputSampled: false, outputSampled: false, ratio: 1, outputRatio: 1, samples: 0 };
  }
}

/** 单条样本的 r;不可用时 null。 */
function ratioOfSample(rawEst?: number, reported?: number): number | null {
  if (typeof rawEst !== "number" || typeof reported !== "number") return null;
  if (!Number.isFinite(rawEst) || !Number.isFinite(reported)) return null;
  if (rawEst <= 0 || reported <= 0) return null;
  const r = reported / rawEst;
  if (!Number.isFinite(r) || r < RATIO_MIN || r > RATIO_MAX) return null;
  return r;
}

/** 读当前标定状态。 */
export function calibrationOf(providerKey?: string, model?: string): { ratio: number; outputRatio: number; samples: number; outputSamples: number } {
  try {
    ensureCalibrationLoaded();
    const s = states.get(keyOf(providerKey, model));
    if (!s) return { ratio: 1, outputRatio: 1, samples: 0, outputSamples: 0 };
    return {
      ratio: s.samples >= MIN_SAMPLES ? clampRatio(s.ratio) : 1,
      outputRatio: s.outputSamples >= MIN_SAMPLES ? clampRatio(s.outputRatio) : 1,
      samples: s.samples,
      outputSamples: s.outputSamples,
    };
  } catch {
    return { ratio: 1, outputRatio: 1, samples: 0, outputSamples: 0 };
  }
}

/** 测试注入:设置标定文件路径。 */
export function setCalibrationFile(path: string): void {
  try {
    calibFileOverride = path;
    calibLoaded = false;
  } catch {
    /* ignore */
  }
}

/** 立即落盘(忽略节流)。 */
export function flushCalibration(): void {
  try {
    persist(true);
  } catch {
    /* ignore */
  }
}

/** 测试/重启用:清空内存态(保留 setCalibrationFile 注入的路径)。 */
export function resetForTest(): void {
  try {
    states.clear();
    calibLoaded = false;
    calibDirty = false;
    lastWriteAt = 0;
    calibWarned = false;
    rawCache.clear();
  } catch {
    /* ignore */
  }
}
