/**
 * 轨迹病理件持久层(生产侧,病理形态路由 2026-11):把 trajectory-pathology 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:detect / register 都是判断历史——「这一刻六原语命中什么、命中了哪些形态、给了哪些候选」
 * 与「某个新组合是哪一刻被登记进目录的」都值得回看,不能被后来的写入覆盖。单行追加 + 坏行只计数不 throw,
 * 让「一行坏不整文件失效」成为可复核行为而不是期望。
 * 数据面:`<root>/.genie/rsi/pathology.jsonl`,每行 `{v:1,type,at,primitives?,matches?,candidates?,catalogDelta?}`
 * - detect   {primitives,matches,candidates}  一次检测的快照(evidence 不落盘,只留 hit/count)
 * - register {catalogDelta}                   一次新形态登记(全量形态,listForms 据此投影目录)
 * 投影语义:listForms = DEFAULT_CATALOG + 已注册形态(按落盘顺序,同 id 去重取首个);
 * 坏行(JSON 坏 / v 不是 1 / type 未知 / 形状非法)只计入 badLines 并跳过,绝不 throw。
 * 依赖纪律(照抄 gap-taxonomy-store):只用 node:fs / node:path + runtime 纯逻辑模块;
 * 不引 agent loop、不静态 import runtime(dist 可能不存在),runtime 模块两跳惰性解析:
 * ① `--conditions=development` 的运行时(vitest / 带条件的 node)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误外不 throw:IO/投影失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  DetectOptions,
  PathologyFamily,
  PathologyForm,
  PathologyIntervention,
  PathologyPrimitive,
  PathologyTrace,
} from "@lampgenie/runtime/agent/trajectory-pathology";

/** store 稳定码:store 层自产的失败/提示码(检测/登记码沿用 runtime 的 PATHOLOGY_CODES)。 */
export const PATHOLOGY_STORE_CODES = [
  "PATHOLOGY_STORE_INVALID_INPUT",
  "PATHOLOGY_FORM_NOT_FOUND",
  "PATHOLOGY_LEDGER_WRITE_FAILED",
  "PATHOLOGY_STORE_ERROR",
] as const;

export type PathologyStoreCode = (typeof PATHOLOGY_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const PATHOLOGY_LINE_TYPES = ["detect", "register"] as const;

export type PathologyLineType = (typeof PATHOLOGY_LINE_TYPES)[number];

type UnknownRecord = Record<string, unknown>;

/** 一条落盘行。 */
export interface PathologyLine {
  v: 1;
  type: PathologyLineType;
  at: number;
  /** detect 行:六原语命中快照(只存 hit/count,evidence 不落盘)。 */
  primitives?: Record<string, { hit: boolean; count: number }>;
  /** detect 行:命中的形态与载体快照。 */
  matches?: {
    formId: string;
    family: string;
    carriers: string[];
    tipAllowed: boolean;
  }[];
  /** detect 行:候选形态建议(不自动入目录)。 */
  candidates?: { signature: string[]; familySuggestion: string }[];
  /** register 行:新登记形态全量。 */
  catalogDelta?: PathologyForm;
}

/** runtime 侧检测结果里的单原语命中。 */
interface RuntimePrimitiveHit {
  hit: boolean;
  evidence: string[];
  count: number;
}

/** runtime 面(只声明本层用到的导出,避免静态 import)。 */
interface PathologyRuntime {
  PATHOLOGY_PRIMITIVES: readonly PathologyPrimitive[];
  DEFAULT_CATALOG: PathologyForm[];
  PATHOLOGY_CODES: {
    FORM_DUPLICATE: string;
    INVALID: string;
    TIP_FORBIDDEN: string;
  };
  detectPrimitives(
    trace: PathologyTrace | undefined | null,
    opts?: DetectOptions): Record<PathologyPrimitive, RuntimePrimitiveHit>;
  matchForms(
    primitives: Record<PathologyPrimitive, RuntimePrimitiveHit>,
    catalog?: PathologyForm[],
  ): {
    matched: {
      form: PathologyForm;
      matchedSignature: PathologyPrimitive[];
      extraPrimitives: PathologyPrimitive[];
    }[];
    candidates: {
      signature: PathologyPrimitive[];
      familySuggestion: PathologyFamily;
      reason: string;
    }[];
    codes: string[];
  };
  registerForm(
    catalog: PathologyForm[],
    input: {
      family: PathologyFamily;
      signature: PathologyPrimitive[];
      interventions?: PathologyIntervention[];
      description?: string;
    },
  ): { catalog: PathologyForm[]; form: PathologyForm; codes: string[] };
  routeInterventions(
    form: PathologyForm,
    opts?: { requestTip?: boolean },
  ): {
    carriers: PathologyIntervention[];
    tipAllowed: boolean;
    codes: string[];
  };
}

let pathologyRuntime: PathologyRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadPathologyRuntime(): Promise<PathologyRuntime> {
  if (pathologyRuntime) return pathologyRuntime;
  const spec = "@lampgenie/runtime/agent/trajectory-pathology";
  try {
    pathologyRuntime = (await import(spec)) as PathologyRuntime;
  } catch {
    const srcUrl = new URL(
      "../../../packages/harness-runtime/src/agent/trajectory-pathology.ts",
      import.meta.url).href;
    pathologyRuntime = (await import(srcUrl)) as PathologyRuntime;
  }
  return pathologyRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadPathologyRuntime();

const LINE_TYPES: ReadonlySet<string> = new Set<string>(PATHOLOGY_LINE_TYPES);
const INVALID_INPUT = "PATHOLOGY_STORE_INVALID_INPUT" as const;
const STORE_ERROR = "PATHOLOGY_STORE_ERROR" as const;
const WRITE_FAILED = "PATHOLOGY_LEDGER_WRITE_FAILED" as const;

// ------------------------------------------------------------------ 基础工具

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPrimitiveName(value: unknown): value is PathologyPrimitive {
  return (
    typeof value === "string" &&
    (rt.PATHOLOGY_PRIMITIVES as readonly string[]).includes(value)
  );
}

/** 键字典序输出(所有报表口径统一,避免 Map 插入顺序泄漏到 API 表面)。 */
function sortedRecord(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) {
    out[key] = counts.get(key) ?? 0;
  }
  return out;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** 空六原语表:参数错误时也要给出完整形状,调用方不必判空。 */
function emptyPrimitives(): Record<
  PathologyPrimitive,
  { hit: boolean; count: number; evidence: string[] }
> {
  const out = {} as Record<
    PathologyPrimitive,
    { hit: boolean; count: number; evidence: string[] }
  >;
  for (const primitive of rt.PATHOLOGY_PRIMITIVES) {
    out[primitive] = { hit: false, count: 0, evidence: [] };
  }
  return out;
}

// ------------------------------------------------------------------ 落盘/读取

/** 台账路径:`<root>/.genie/rsi/pathology.jsonl`。 */
export function pathologyLedgerPath(root: string): string {
  return join(root, ".genie", "rsi", "pathology.jsonl");
}

/** 形态形状校验:非法形态(缺 id / 族 / 签名原语非法)整行算坏行。 */
function asForm(value: unknown): PathologyForm | undefined {
  if (!isRecord(value)) return undefined;
  if (!isFilled(value.id)) return undefined;
  if (!isFilled(value.family)) return undefined;
  const signature = asArray(value.signature);
  if (signature.length === 0 || !signature.every(isPrimitiveName)) return undefined;
  const interventions: PathologyIntervention[] = [];
  for (const item of asArray(value.interventions)) {
    if (!isRecord(item) || !isFilled(item.carrier)) return undefined;
    interventions.push({
      carrier: item.carrier as PathologyIntervention["carrier"],
      detail: isFilled(item.detail) ? item.detail : "",
    });
  }
  return {
    id: value.id,
    family: value.family as PathologyFamily,
    signature: signature as PathologyPrimitive[],
    description: isFilled(value.description) ? value.description : "",
    interventions,
    tipAllowed: value.tipAllowed === true,
    builtin: value.builtin === true,
  };
}

function asStringArray(value: unknown): string[] | undefined {
  const items = asArray(value);
  if (!items.every((item) => typeof item === "string")) return undefined;
  return items as string[];
}

/** 行形状校验:坏行(未知 type / v 不是 1 / 字段非法)只计数,不 throw。 */
function asLine(value: unknown): PathologyLine | undefined {
  if (!isRecord(value)) return undefined;
  if (value.v !== 1) return undefined;
  if (typeof value.type !== "string" || !LINE_TYPES.has(value.type)) {
    return undefined;
  }
  if (!isFiniteNumber(value.at)) return undefined;
  if (value.type === "register") {
    const form = asForm(value.catalogDelta);
    if (!form) return undefined;
    return { v: 1, type: "register", at: value.at, catalogDelta: form };
  }
  const primitives: Record<string, { hit: boolean; count: number }> = {};
  for (const primitive of rt.PATHOLOGY_PRIMITIVES) {
    const hit = isRecord(value.primitives) ? value.primitives[primitive] : undefined;
    if (hit === undefined) continue;
    if (!isRecord(hit) || typeof hit.hit !== "boolean" || !isFiniteNumber(hit.count)) {
      return undefined;
    }
    primitives[primitive] = { hit: hit.hit, count: hit.count };
  }
  const matches: { formId: string; family: string; carriers: string[]; tipAllowed: boolean }[] = [];
  for (const item of asArray(value.matches)) {
    if (!isRecord(item) || !isFilled(item.formId) || !isFilled(item.family)) {
      return undefined;
    }
    const carriers = asStringArray(item.carriers);
    if (!carriers) return undefined;
    matches.push({
      formId: item.formId,
      family: item.family,
      carriers,
      tipAllowed: item.tipAllowed === true,
    });
  }
  const candidates: { signature: string[]; familySuggestion: string }[] = [];
  for (const item of asArray(value.candidates)) {
    if (!isRecord(item) || !isFilled(item.familySuggestion)) return undefined;
    const signature = asStringArray(item.signature);
    if (!signature) return undefined;
    candidates.push({ signature, familySuggestion: item.familySuggestion });
  }
  const line: PathologyLine = { v: 1, type: "detect", at: value.at };
  if (isRecord(value.primitives)) line.primitives = primitives;
  if (Array.isArray(value.matches)) line.matches = matches;
  if (Array.isArray(value.candidates)) line.candidates = candidates;
  return line;
}

/** 全量扫描:返回合法行 + 行数口径。文件不存在视为空台账。 */
function readLedger(root: string): {
  lines: PathologyLine[];
  totalLines: number;
  badLines: number;
} {
  let text = "";
  try {
    text = readFileSync(pathologyLedgerPath(root), "utf8");
  } catch {
    return { lines: [], totalLines: 0, badLines: 0 };
  }
  const lines: PathologyLine[] = [];
  let totalLines = 0;
  let badLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      badLines += 1;
      continue;
    }
    const line = asLine(parsed);
    if (!line) {
      badLines += 1;
      continue;
    }
    lines.push(line);
  }
  return { lines, totalLines, badLines };
}

/** 已注册形态(按落盘顺序;同 id 去重取首个)。 */
function registeredForms(lines: PathologyLine[]): PathologyForm[] {
  const seen = new Set<string>();
  const out: PathologyForm[] = [];
  for (const line of lines) {
    if (line.type !== "register" || !line.catalogDelta) continue;
    if (seen.has(line.catalogDelta.id)) continue;
    seen.add(line.catalogDelta.id);
    out.push(line.catalogDelta);
  }
  return out;
}

/** 生效目录:内置 8 形态在前,已注册形态按落盘顺序追加(同 id 取首个)。 */
function effectiveCatalog(root: string): {
  forms: PathologyForm[];
  registered: number;
  badLines: number;
  totalLines: number;
} {
  const { lines, badLines, totalLines } = readLedger(root);
  const seen = new Set<string>();
  const forms: PathologyForm[] = [];
  for (const form of asArray(rt.DEFAULT_CATALOG) as PathologyForm[]) {
    if (seen.has(form.id)) continue;
    seen.add(form.id);
    forms.push(form);
  }
  const registered = registeredForms(lines);
  for (const form of registered) {
    if (seen.has(form.id)) continue;
    seen.add(form.id);
    forms.push(form);
  }
  return { forms, registered: registered.length, badLines, totalLines };
}

/** 追加一行:失败只置写失败码,不 throw。 */
function appendLine(root: string, line: PathologyLine): boolean {
  try {
    const path = pathologyLedgerPath(root);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ detect

export interface DetectStoreResult {
  ok: boolean;
  code?: string;
  /** runtime 侧稳定码(MATCHED / NEW_CANDIDATE / NO_MATCH ...)。 */
  codes: string[];
  primitives: Record<
    PathologyPrimitive,
    { hit: boolean; count: number; evidence: string[] }
  >;
  matched: {
    formId: string;
    family: string;
    matchedSignature: string[];
    extraPrimitives: string[];
  }[];
  candidates: {
    signature: string[];
    familySuggestion: string;
    reason: string;
  }[];
  /** matched 每条按 routeInterventions 展开(已过 tip 门)。 */
  interventions?: { formId: string; carriers: string[]; tipAllowed: boolean }[];
 /** 同签名 24h 去重命中:未落行( pathology 机制注意「同一快照重复落三行」)。 */
  deduped?: boolean;
}

/**
 * 一次检测:六原语 → 形态匹配 → 干预路由 → 落一行 detect。
 * 候选形态只落盘不入目录(入目录必须走 registerForm)。
 */
export function detect(
  root: string,
  trace: PathologyTrace,
  opts?: { windowMs?: number; minRepeats?: number; requestTip?: boolean; at?: number },
): DetectStoreResult {
  if (!isFilled(root)) {
    return {
      ok: false,
      code: INVALID_INPUT,
      codes: [INVALID_INPUT],
      primitives: emptyPrimitives(),
      matched: [],
      candidates: [],
      interventions: [],
    };
  }
  try {
    const { forms } = effectiveCatalog(root);
    const hits = rt.detectPrimitives(trace, {
      windowMs: opts?.windowMs,
      minRepeats: opts?.minRepeats,
    });
    const matchedResult = rt.matchForms(hits, forms);
    const primitives = emptyPrimitives();
    for (const primitive of rt.PATHOLOGY_PRIMITIVES) {
      const hit = hits[primitive];
      primitives[primitive] = {
        hit: hit?.hit === true,
        count: isFiniteNumber(hit?.count) ? hit.count : 0,
        evidence: Array.isArray(hit?.evidence) ? [...hit.evidence] : [],
      };
    }
    const matched = matchedResult.matched.map((item) => ({
      formId: item.form.id,
      family: item.form.family,
      matchedSignature: [...item.matchedSignature],
      extraPrimitives: [...item.extraPrimitives],
    }));
    const codes: string[] = [...matchedResult.codes];
    const interventions = matchedResult.matched.map((item) => {
      const routed = rt.routeInterventions(item.form, {
        requestTip: opts?.requestTip,
      });
      for (const code of routed.codes) {
        if (!codes.includes(code)) codes.push(code);
      }
      return {
        formId: item.form.id,
        carriers: routed.carriers.map((carrier) => carrier.carrier),
        tipAllowed: routed.tipAllowed,
      };
    });
    const candidates = matchedResult.candidates.map((item) => ({
      signature: [...item.signature],
      familySuggestion: item.familySuggestion,
      reason: item.reason,
    }));

 // pathology 机制注意「同一快照重复落三行,追加台账无去重」:与最近一条 detect
 // 的原语命中向量+计数完全一致且在 24h 内 → 不再落行(观测没变化=没有新信息)。
    const at = isFiniteNumber(opts?.at) ? (opts?.at as number) : Date.now();
    const lastDetect = [...readLedger(root).lines].reverse().find((l) => l.type === "detect");
    if (lastDetect && lastDetect.type === "detect" && at - lastDetect.at < 24 * 3600_000) {
      const sigOf = (prim: Record<string, unknown> | undefined) =>
        Object.keys(prim ?? {}).sort().map((k) => `${k}:${(prim as Record<string, { hit?: unknown; count?: unknown }>)[k]?.hit === true ? 1 : 0}:${(prim as Record<string, { count?: unknown }>)[k]?.count ?? 0}`).join("|");
      if (sigOf(lastDetect.primitives as Record<string, unknown>) === sigOf(primitives as unknown as Record<string, unknown>)) {
        return {
          ok: true,
          code: "PATHOLOGY_DETECT_UNCHANGED",
          codes: ["PATHOLOGY_DETECT_UNCHANGED"],
          primitives,
          matched,
          candidates: matchedResult.candidates.map((item) => ({ signature: [...item.signature], familySuggestion: item.familySuggestion, reason: item.reason })),
          interventions,
          deduped: true,
        };
      }
    }
    const writeOk = appendLine(root, {
      v: 1,
      type: "detect",
      at,
      primitives: Object.fromEntries(
        Object.entries(primitives).map(([key, value]) => [
          key,
          { hit: value.hit, count: value.count },
        ]),
      ),
      matches: interventions.map((item) => ({
        formId: item.formId,
        family:
          matched.find((entry) => entry.formId === item.formId)?.family ?? "",
        carriers: [...item.carriers],
        tipAllowed: item.tipAllowed,
      })),
      candidates: candidates.map((item) => ({
        signature: [...item.signature],
        familySuggestion: item.familySuggestion,
      })),
    });

    return {
      ok: writeOk,
      ...(writeOk ? {} : { code: WRITE_FAILED }),
      codes: [...codes],
      primitives,
      matched,
      candidates,
      interventions,
    };
  } catch {
    return {
      ok: false,
      code: STORE_ERROR,
      codes: [STORE_ERROR],
      primitives: emptyPrimitives(),
      matched: [],
      candidates: [],
      interventions: [],
    };
  }
}

// ------------------------------------------------------------------ registerForm

/** 登记输入:既接受极简组合也接受完整形态,统一取四字段交给 runtime 校验。 */
function registerInput(
  form:
    | {
        family: string;
        signature: string[];
        interventions?: { carrier: string; detail: string }[];
        description?: string;
      }
    | PathologyForm): {
  family: PathologyFamily;
  signature: PathologyPrimitive[];
  interventions?: PathologyIntervention[];
  description?: string;
} {
  const raw: UnknownRecord = isRecord(form) ? (form as UnknownRecord) : {};
  const interventions = asArray(raw.interventions)
    .filter((item): item is UnknownRecord => isRecord(item))
    .map((item) => ({
      carrier: item.carrier as PathologyIntervention["carrier"],
      detail: isFilled(item.detail) ? item.detail : "",
    }));
  const input: {
    family: PathologyFamily;
    signature: PathologyPrimitive[];
    interventions?: PathologyIntervention[];
    description?: string;
  } = {
    family: raw.family as PathologyFamily,
    signature: asArray(raw.signature) as PathologyPrimitive[],
  };
  if (interventions.length > 0) input.interventions = interventions;
  if (isFilled(raw.description)) input.description = raw.description;
  return input;
}

/** 登记形态:签名集合相等即重复(不写盘);非法输入给 INVALID_INPUT;成功落一行 register。 */
export function registerForm(
  root: string,
  form:
    | {
        family: string;
        signature: string[];
        interventions?: { carrier: string; detail: string }[];
        description?: string;
      }
    | PathologyForm): {
  ok: boolean;
  code?: string;
  codes: string[];
  formId?: string;
  duplicate?: boolean;
} {
  if (!isFilled(root)) {
    return { ok: false, code: INVALID_INPUT, codes: [INVALID_INPUT] };
  }
  try {
    const { forms } = effectiveCatalog(root);
    const registered = rt.registerForm(forms, registerInput(form));
    if (registered.codes.includes(rt.PATHOLOGY_CODES.FORM_DUPLICATE)) {
      return {
        ok: true,
        duplicate: true,
        formId: registered.form.id,
        codes: [...registered.codes],
      };
    }
    if (registered.codes.includes(rt.PATHOLOGY_CODES.INVALID)) {
      return {
        ok: false,
        code: INVALID_INPUT,
        codes: [...registered.codes],
      };
    }
    const writeOk = appendLine(root, {
      v: 1,
      type: "register",
      at: Date.now(),
      catalogDelta: registered.form,
    });
    return {
      ok: writeOk,
      ...(writeOk ? {} : { code: WRITE_FAILED }),
      codes: [...registered.codes],
      formId: registered.form.id,
      duplicate: false,
    };
  } catch {
    return { ok: false, code: STORE_ERROR, codes: [STORE_ERROR] };
  }
}

// ------------------------------------------------------------------ listForms

/** 目录投影:内置 8 形态在前 + 已注册形态按落盘顺序(同 id 取首个)。 */
export function listForms(root: string): {
  ok: boolean;
  forms: PathologyForm[];
  total: number;
  registered: number;
  badLines: number;
} {
  if (!isFilled(root)) {
    return { ok: false, forms: [], total: 0, registered: 0, badLines: 0 };
  }
  try {
    const { forms, registered, badLines } = effectiveCatalog(root);
    return { ok: true, forms, total: forms.length, registered, badLines };
  } catch {
    return { ok: false, forms: [], total: 0, registered: 0, badLines: 0 };
  }
}

// ------------------------------------------------------------------ route

/** 按 formId 路由干预:tip 门沿用 runtime,TIP_FORBIDDEN 用 runtime 稳定码回传(便于 CLI 判 exit 2)。 */
export function route(
  root: string,
  formId: string,
  opts?: { requestTip?: boolean },
): {
  ok: boolean;
  code?: string;
  codes: string[];
  formId?: string;
  carriers: { carrier: string; detail: string }[];
  tipAllowed?: boolean;
} {
  if (!isFilled(root) || !isFilled(formId)) {
    return {
      ok: false,
      code: INVALID_INPUT,
      codes: [INVALID_INPUT],
      carriers: [],
    };
  }
  try {
    const { forms } = effectiveCatalog(root);
    const form = forms.find((item) => item.id === formId);
    if (!form) {
      return {
        ok: false,
        code: "PATHOLOGY_FORM_NOT_FOUND",
        codes: ["PATHOLOGY_FORM_NOT_FOUND"],
        formId,
        carriers: [],
      };
    }
    const routed = rt.routeInterventions(form, opts);
    const tipForbidden = routed.codes.includes(
      rt.PATHOLOGY_CODES.TIP_FORBIDDEN);
    return {
      ok: !tipForbidden,
      ...(tipForbidden ? { code: rt.PATHOLOGY_CODES.TIP_FORBIDDEN } : {}),
      codes: [...routed.codes],
      formId: form.id,
      carriers: routed.carriers.map((item) => ({
        carrier: item.carrier,
        detail: item.detail,
      })),
      tipAllowed: routed.tipAllowed,
    };
  } catch {
    return { ok: false, code: STORE_ERROR, codes: [STORE_ERROR], carriers: [] };
  }
}

// ------------------------------------------------------------------ report

/** 台账报表:全部计数按首次出现累加,输出按键字典序;空目录给全 0/空对象。 */
export function reportPathology(root: string): {
  ok: boolean;
  totalLines: number;
  badLines: number;
  byFamily: Record<string, number>;
  byCarrier: Record<string, number>;
  matches: Record<string, number>;
  candidates: { signature: string[]; familySuggestion: string; seen: number }[];
} {
  const empty = {
    ok: false,
    totalLines: 0,
    badLines: 0,
    byFamily: {},
    byCarrier: {},
    matches: {},
    candidates: [],
  };
  if (!isFilled(root)) return empty;
  try {
    const { lines, totalLines, badLines } = readLedger(root);
    const byFamily = new Map<string, number>();
    const byCarrier = new Map<string, number>();
    const matches = new Map<string, number>();
    const candidates = new Map<
      string,
      { signature: string[]; familySuggestion: string; seen: number }
    >();
    for (const line of lines) {
      if (line.type === "register") {
        for (const intervention of line.catalogDelta?.interventions ?? []) {
          bump(byCarrier, intervention.carrier);
        }
        continue;
      }
      for (const item of line.matches ?? []) {
        bump(byFamily, item.family);
        bump(matches, item.formId);
        for (const carrier of item.carriers) bump(byCarrier, carrier);
      }
      for (const item of line.candidates ?? []) {
        const key = item.signature.join("+");
        const existing = candidates.get(key);
        if (existing) {
          existing.seen += 1;
          continue;
        }
        candidates.set(key, {
          signature: [...item.signature],
          familySuggestion: item.familySuggestion,
          seen: 1,
        });
      }
    }
    const candidateList = [...candidates.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value);
    return {
      ok: true,
      totalLines,
      badLines,
      byFamily: sortedRecord(byFamily),
      byCarrier: sortedRecord(byCarrier),
      matches: sortedRecord(matches),
      candidates: candidateList,
    };
  } catch {
    return empty;
  }
}
