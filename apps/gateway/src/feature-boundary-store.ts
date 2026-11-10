/**
 * 语义功能影响边界 store(IO 层):把「语义功能 / UI 表面 / 代码引用 / 语义采纳」四份输入采出来,
 * 交给 runtime 纯逻辑 `buildImpactBrief` 组装成影响边界简报(BoundaryItem 五级 / drift / 未决 owner / depth3)。
 * 语义判定全在 packages/harness-runtime/src/agent/feature-boundary.ts,本文件只做 IO、形状容错与落盘。
 *
 * 设计口径:
 * - 输入容错:三个输入文件都接受「裸数组」或「包裹对象」形状(feature / surfaces / codeRefs),
 *   形状不合法不抛异常,统一 `{ ok:false, codes:[FB_INVALID, FB_STORE_*] }`。
 * - 码:语义码一律取自 runtime `FB_CODES`(store 不重复造码);store 只追加自定义 FB_STORE_* 码:
 *   FB_STORE_MISSING_INPUT(文件不存在)/ FB_STORE_BAD_JSON(JSON 解析失败)/ FB_STORE_BAD_SHAPE(形状不合法)
 *   / FB_STORE_RUNTIME_MISSING(runtime 两跳解析都失败)/ FB_ACCEPTED(acceptSemantics 落盘成功)。
 * - accepted 来源优先级:① opts.acceptedFile(容忍 {by,at} / {accepted:{by,at}} / {semanticsAccepted:{by,at}})
 *   ② <root>/.genie/rsi/boundaries/<featureId>.json 里的 accepted:{by,at}。都没有则不传 acceptedSemantics。
 * - featureId 落盘前清洗(禁止 `/`、`\`、`..` 与空白):穿越直接拒绝,不写盘、不回退到别的目录。
 * - 不 throw 到调用方;不 import agent loop;不写仓库 .genie(写盘只发生在调用方给的 root 之下)。
 *
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑模块;runtime 按 store 既有两跳惰性解析:
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * collectBrief 契约要求同步签名,故 runtime 用顶层 await 预加载(runtime 缺失时降级为 rt=undefined,不炸整个模块)。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";

type FeatureBoundaryRuntime = typeof import("@lampgenie/runtime/agent/feature-boundary");

/** 复用 runtime 的类型(仅类型面,不引入运行期依赖)。 */
export type ImpactLevel = import("@lampgenie/runtime/agent/feature-boundary").ImpactLevel;
export type SemanticFeature = import("@lampgenie/runtime/agent/feature-boundary").SemanticFeature;
export type UISurface = import("@lampgenie/runtime/agent/feature-boundary").UISurface;
export type CodeRef = import("@lampgenie/runtime/agent/feature-boundary").CodeRef;
export type BoundaryItem = import("@lampgenie/runtime/agent/feature-boundary").BoundaryItem;
export type ImpactBrief = import("@lampgenie/runtime/agent/feature-boundary").ImpactBrief;

/** runtime 两跳解析(见文件头依赖纪律);两跳都失败返回 undefined,由调用方降级。 */
async function loadFeatureBoundaryRuntime(): Promise<FeatureBoundaryRuntime | undefined> {
  const spec = "@lampgenie/runtime/agent/feature-boundary";
  try {
    return (await import(spec)) as FeatureBoundaryRuntime;
  } catch {
    try {
      const srcUrl = new URL("../../../packages/harness-runtime/src/agent/feature-boundary.ts", import.meta.url).href;
      return (await import(srcUrl)) as FeatureBoundaryRuntime;
    } catch {
      return undefined;
    }
  }
}

const rt = await loadFeatureBoundaryRuntime();

/** runtime 缺席时的码表兜底(值即字面量,与 runtime FB_CODES 一致)。 */
const FB_CODES_FALLBACK: Readonly<Record<string, string>> = {
  INVALID: "FB_INVALID",
  BUILT: "FB_BUILT",
  MISSING_SEMANTIC: "FB_MISSING_SEMANTIC",
  MISSING_SURFACE: "FB_MISSING_SURFACE",
  MISSING_CODE: "FB_MISSING_CODE",
  DRIFT: "FB_DRIFT",
  UNRESOLVED_OWNER: "FB_UNRESOLVED_OWNER",
  DEPTH3_REQUIRED: "FB_DEPTH3_REQUIRED",
  E2E_BLOCKED: "FB_E2E_BLOCKED",
  E2E_ALLOWED: "FB_E2E_ALLOWED",
};

/** store 自定义码(前缀 FB_STORE_ / accept 专用),与 runtime 码不重名。 */
export const FB_STORE_CODES = {
  MISSING_INPUT: "FB_STORE_MISSING_INPUT",
  BAD_JSON: "FB_STORE_BAD_JSON",
  BAD_SHAPE: "FB_STORE_BAD_SHAPE",
  RUNTIME_MISSING: "FB_STORE_RUNTIME_MISSING",
  ACCEPTED: "FB_ACCEPTED",
} as const;

/** 五级顺序(报告分组固定按此序,空组也打印,便于下游稳定解析)。 */
export const LEVEL_ORDER: readonly ImpactLevel[] = ["must", "should", "conditional", "invariant", "evidence"];

const BOUNDARY_DIR = [".genie", "rsi", "boundaries"];
const INPUT_CODES = { INVALID: "FB_INVALID" };

function codesOf(): Readonly<Record<string, string>> {
  const table = (rt as { FB_CODES?: Readonly<Record<string, string>> } | undefined)?.FB_CODES;
  return table ?? FB_CODES_FALLBACK;
}

function code(name: string): string {
  return codesOf()[name] ?? FB_CODES_FALLBACK[name] ?? name;
}

// ---------------------------------------------------------------- 参数与结果类型

export interface CollectBriefOpts {
  /** 语义功能 JSON(绝对路径或相对 root)。 */
  featureFile: string;
  /** UI 表面 JSON。 */
  surfacesFile: string;
  /** 代码引用 JSON。 */
  codeFile: string;
  /** 可选:显式语义采纳凭据 JSON(优先级高于 state 文件)。 */
  acceptedFile?: string;
}

export interface CollectBriefResult {
  ok: boolean;
  brief?: ImpactBrief;
  codes: string[];
}

export interface AcceptOpts {
  by: string;
  brief?: ImpactBrief;
}

export interface AcceptResult {
  ok: boolean;
  path: string;
  codes: string[];
}

export interface DriftEntry {
  featureId: string;
  target: string;
  reason: string;
}

export interface ReportResult {
  ok: boolean;
  text: string;
  codes: string[];
}

// ---------------------------------------------------------------- 基础工具(容错)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** featureId 清洗:空 / 含 `/` `\` `..` / 含空白 → undefined(拒绝落盘)。 */
function cleanFeatureId(value: unknown): string | undefined {
  const id = nonEmptyString(value);
  if (!id) return undefined;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return undefined;
  if (/\s/.test(id)) return undefined;
  return id;
}

function absolutePath(root: string, file: string): string {
  return isAbsolute(file) ? file : resolvePath(root, file);
}

type ReadResult = { ok: true; value: unknown } | { ok: false; code: string };

function readJsonFile(path: string): ReadResult {
  if (!existsSync(path)) return { ok: false, code: FB_STORE_CODES.MISSING_INPUT };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { ok: false, code: FB_STORE_CODES.MISSING_INPUT };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, code: FB_STORE_CODES.BAD_JSON };
  }
}

// ---------------------------------------------------------------- 输入形状归一化

/** SemanticFeature:裸对象 / {feature} / {features:[...]}(有 id/featureId 选择器则按 id 取,否则取第一个)。 */
function normalizeFeature(value: unknown): SemanticFeature | undefined {
  let candidate: unknown = value;
  if (Array.isArray(value)) {
    candidate = value[0];
  } else if (isRecord(value)) {
    if (isRecord(value.feature)) {
      candidate = value.feature;
    } else if (Array.isArray(value.features)) {
      const list = value.features;
      const wantId = nonEmptyString(value.id) ?? nonEmptyString(value.featureId);
      const hit = wantId
        ? list.find((entry) => isRecord(entry) && nonEmptyString(entry.id) === wantId)
        : undefined;
      candidate = hit ?? list[0];
    }
  }
  if (!isRecord(candidate)) return undefined;
  const id = nonEmptyString(candidate.id);
  const name = nonEmptyString(candidate.name);
  if (!id || !name) return undefined;
  const entries = Array.isArray(candidate.entries)
    ? candidate.entries.filter((entry): entry is string => typeof entry === "string")
    : [];
  const dataFlows = Array.isArray(candidate.dataFlows)
    ? candidate.dataFlows.filter(
        (flow): flow is { from: string; to: string; kind: "read" | "write" } =>
          isRecord(flow) &&
          nonEmptyString(flow.from) !== undefined &&
          nonEmptyString(flow.to) !== undefined &&
          (flow.kind === "read" || flow.kind === "write"),
      )
    : [];
  const dependsOn = Array.isArray(candidate.dependsOn)
    ? candidate.dependsOn.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const feature: SemanticFeature = { id, name, entries, dataFlows };
  if (dependsOn && dependsOn.length > 0) feature.dependsOn = dependsOn;
  return feature;
}

/** UISurface[]:裸数组 / {surfaces:[...]};逐项校验 id/featureId,坏项丢弃。 */
function normalizeSurfaces(value: unknown): UISurface[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.surfaces)
      ? value.surfaces
      : undefined;
  if (!raw) return undefined;
  const out: UISurface[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = nonEmptyString(entry.id);
    const name = nonEmptyString(entry.name);
    const featureId = nonEmptyString(entry.featureId);
    if (!id || !name || !featureId) continue;
    const steps: UISurface["steps"] = {};
    if (isRecord(entry.steps)) {
      for (const key of ["draft", "validate", "submit"] as const) {
        const step = nonEmptyString(entry.steps[key]);
        if (step) steps[key] = step;
      }
    }
    const surface: UISurface = { id, name, featureId, steps };
    const owner = nonEmptyString(entry.authoritativeOwner);
    if (owner) surface.authoritativeOwner = owner;
    out.push(surface);
  }
  return out;
}

/** CodeRef[]:裸数组 / {codeRefs:[...]} / {code:[...]};逐项校验,坏项丢弃。 */
function normalizeCodeRefs(value: unknown): CodeRef[] | undefined {
  let raw: unknown[] | undefined;
  if (Array.isArray(value)) {
    raw = value;
  } else if (isRecord(value)) {
    if (Array.isArray(value.codeRefs)) raw = value.codeRefs;
    else if (Array.isArray(value.code)) raw = value.code;
  }
  if (!raw) return undefined;
  const out: CodeRef[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = nonEmptyString(entry.id);
    const module = nonEmptyString(entry.module);
    const file = nonEmptyString(entry.file);
    const symbol = nonEmptyString(entry.symbol);
    if (!id || !module || !file || !symbol) continue;
    const depth: 1 | 2 = entry.depth === 2 ? 2 : 1;
    out.push({ id, module, file, symbol, depth });
  }
  return out;
}

/** 语义采纳凭据:{by,at} / {accepted:{by,at}} / {semanticsAccepted:{by,at}}。 */
function normalizeAccepted(value: unknown): { by: string; at: string } | undefined {
  const pair = (node: unknown): { by: string; at: string } | undefined => {
    if (!isRecord(node)) return undefined;
    const by = nonEmptyString(node.by);
    const at = nonEmptyString(node.at);
    return by && at ? { by, at } : undefined;
  };
  const direct = pair(value);
  if (direct) return direct;
  if (!isRecord(value)) return undefined;
  for (const key of ["accepted", "semanticsAccepted"]) {
    const hit = pair(value[key]);
    if (hit) return hit;
  }
  return undefined;
}

// ---------------------------------------------------------------- 路径

/** <root>/.genie/rsi/boundaries/<featureId>.json(未清洗的 featureId 原样拼,调用方需先清洗)。 */
export function boundaryStatePath(root: string, featureId: string): string {
  return join(resolvePath(root), ...BOUNDARY_DIR, `${featureId}.json`);
}

function boundariesDir(root: string): string {
  return join(resolvePath(root), ...BOUNDARY_DIR);
}

// ---------------------------------------------------------------- 采集

/** 读 accepted 快照:opts.acceptedFile 优先,其次 state 文件;都没有返回 undefined。 */
function resolveAccepted(root: string, featureId: string, acceptedFile?: string): { by: string; at: string } | undefined {
  if (acceptedFile) {
    const read = readJsonFile(absolutePath(root, acceptedFile));
    if (read.ok) {
      const hit = normalizeAccepted(read.value);
      if (hit) return hit;
    }
  }
  const id = cleanFeatureId(featureId);
  if (!id) return undefined;
  const read = readJsonFile(boundaryStatePath(root, id));
  if (!read.ok || !isRecord(read.value)) return undefined;
  return normalizeAccepted(read.value.accepted);
}

/**
 * 采集一份影响边界简报。同步、不抛异常;任一步失败返回 `{ ok:false, codes:[FB_INVALID, FB_STORE_*] }`,
 * 此时 brief 字段省略。成功时 codes 即 brief.codes(FB_BUILT 开头,FB_E2E_ALLOWED / FB_E2E_BLOCKED 结尾)。
 */
export function collectBrief(root: string, opts: CollectBriefOpts): CollectBriefResult {
  const invalid = [code("INVALID")];
  if (!rt) return { ok: false, codes: [...invalid, FB_STORE_CODES.RUNTIME_MISSING] };
  const base = resolvePath(root);

  const featureRead = readJsonFile(absolutePath(base, opts.featureFile));
  if (!featureRead.ok) return { ok: false, codes: [...invalid, featureRead.code] };
  const feature = normalizeFeature(featureRead.value);
  if (!feature) return { ok: false, codes: [...invalid, FB_STORE_CODES.BAD_SHAPE] };

  const surfacesRead = readJsonFile(absolutePath(base, opts.surfacesFile));
  if (!surfacesRead.ok) return { ok: false, codes: [...invalid, surfacesRead.code] };
  const surfaces = normalizeSurfaces(surfacesRead.value);
  if (!surfaces) return { ok: false, codes: [...invalid, FB_STORE_CODES.BAD_SHAPE] };

  const codeRead = readJsonFile(absolutePath(base, opts.codeFile));
  if (!codeRead.ok) return { ok: false, codes: [...invalid, codeRead.code] };
  const codeRefs = normalizeCodeRefs(codeRead.value);
  if (!codeRefs) return { ok: false, codes: [...invalid, FB_STORE_CODES.BAD_SHAPE] };

  const accepted = resolveAccepted(base, feature.id, opts.acceptedFile);
  const brief = rt.buildImpactBrief({
    feature,
    surfaces,
    codeRefs,
    ...(accepted ? { acceptedSemantics: accepted } : {}),
  });
  return { ok: true, brief, codes: [...brief.codes] };
}

// ---------------------------------------------------------------- 语义采纳落盘

/**
 * 落盘语义采纳:写 `<root>/.genie/rsi/boundaries/<featureId>.json` = { featureId, accepted:{by,at}, brief?, updatedAt }。
 * featureId 不可清洗 → `{ ok:false, path:"", codes:[FB_INVALID] }`,不写盘、不抛异常。
 */
export function acceptSemantics(root: string, featureId: string, opts: AcceptOpts): AcceptResult {
  const invalid = [code("INVALID")];
  const id = cleanFeatureId(featureId);
  const by = nonEmptyString(opts.by);
  if (!id || !by) return { ok: false, path: "", codes: invalid };
  const at = new Date().toISOString();
  const path = boundaryStatePath(root, id);
  const snapshot: Record<string, unknown> = { featureId: id, accepted: { by, at } };
  if (opts.brief) snapshot.brief = opts.brief;
  snapshot.updatedAt = at;
  try {
    mkdirSync(boundariesDir(root), { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  } catch {
    return { ok: false, path, codes: [...invalid, FB_STORE_CODES.MISSING_INPUT] };
  }
  return { ok: true, path, codes: [FB_STORE_CODES.ACCEPTED] };
}

// ---------------------------------------------------------------- drift 聚合

/**
 * 扫 `<root>/.genie/rsi/boundaries/*.json`,聚合每份快照的 `brief.driftCandidates` → { featureId, target, reason }。
 * 坏文件(解析失败 / 非对象 / 无 driftCandidates)静默跳过;目录不存在返回空数组。
 */
export function listDrift(root: string): DriftEntry[] {
  const dir = boundariesDir(root);
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DriftEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const read = readJsonFile(join(dir, entry.name));
    if (!read.ok || !isRecord(read.value)) continue;
    const snapshot = read.value;
    const featureId = nonEmptyString(snapshot.featureId) ?? basename(entry.name, ".json");
    if (!isRecord(snapshot.brief)) continue;
    const drifts = snapshot.brief.driftCandidates;
    if (!Array.isArray(drifts)) continue;
    for (const item of drifts) {
      if (!isRecord(item)) continue;
      const target = nonEmptyString(item.target);
      if (!target) continue;
      out.push({ featureId, target, reason: nonEmptyString(item.reason) ?? "" });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 报告

/**
 * 生成多行文本报告:标题 / featureId / 五级分组(must..evidence,空组也列)/ drift / unresolvedOwners /
 * depth3Required / E2E 状态 / codes 行。采集失败时返回带 FB_STORE_* 码的失败文本。
 */
export function report(root: string, opts: CollectBriefOpts): ReportResult {
  const collected = collectBrief(root, opts);
  if (!collected.ok || !collected.brief) {
    const codes = collected.codes;
    return {
      ok: false,
      text: ["# Feature Boundary Impact Brief", "status: INVALID_INPUT", `codes: ${codes.join(", ")}`].join("\n"),
      codes,
    };
  }
  const brief = collected.brief;
  const lines: string[] = [];
  lines.push("# Feature Boundary Impact Brief");
  lines.push(`featureId: ${brief.featureId}`);
  lines.push(`items: ${brief.items.length}`);
  for (const level of LEVEL_ORDER) {
    const items = brief.items.filter((item) => item.level === level);
    lines.push(`[${level}] (${items.length})`);
    for (const item of items) {
      lines.push(`  - ${item.target} — ${item.rationale}`);
    }
  }
  lines.push(`drift (${brief.driftCandidates.length}):`);
  for (const drift of brief.driftCandidates) {
    lines.push(`  - ${drift.target} — ${drift.reason}`);
  }
  lines.push(`unresolvedOwners (${brief.unresolvedOwners.length}): ${brief.unresolvedOwners.join(", ") || "-"}`);
  lines.push(`depth3Required: ${brief.depth3Required}`);
  lines.push(`semanticsAccepted: ${brief.semanticsAccepted ? `${brief.semanticsAccepted.by}@${brief.semanticsAccepted.at}` : "none"}`);
  const e2eAllowed = codesOf().E2E_ALLOWED ?? "FB_E2E_ALLOWED";
  lines.push(`e2e: ${brief.codes.includes(e2eAllowed) ? "ALLOWED" : "BLOCKED"}`);
  lines.push(`codes: ${brief.codes.join(", ")}`);
  return { ok: true, text: `${lines.join("\n")}\n`, codes: [...brief.codes] };
}
