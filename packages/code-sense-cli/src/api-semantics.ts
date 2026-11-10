/**
 * api-semantics(收尾批 I 项):api 命令的 LLM 语义描述层模块。
 *
 * 定位:api 命令已有确定性层(method/path/handler 行扫描,sensing/http-api)。本模块在其上
 * 加语义层——每端点一句业务/职责描述。只做「模块+单测+脚本实测」,不改 cli.ts 命令分发表
 * (CLI 接线由另一子代理负责)。
 *
 * 凭证:复用 llm-config.ts 的解析链(flag > GENIE_LLM_* env > ~/.codesense/config.json >
 * ask-file > null),不新造凭证链。无凭证=返回显式 off 状态+文案(仿 project 命令 llmState
 * 先例:确定性清单独立可用),不抛错、不静默降级冒充成功。
 *
 * 规模纪律:
 *  - 上限:单仓 >40 端点只取前 40 送 LLM,其余在输出里保留并标 truncatedOut(显式标注,
 *    不静默丢);
 *  - 分片:单次 LLM 请求 ≤12 端点,13+ 自动分片(13 端点→2 请求);
 *  - 缓存:<root>/.genie/sense-index/api-semantics.json,键=git sha+端点集指纹;命中=0 次
 *    LLM 调用。写入仅由参数 writeCache 显式开启(默认 false——本仓只读红线);读缓存只在
 *    文件已存在时进行。缓存内容不含任何凭证(maskKey 形态也不落盘,只记 model)。
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeAskFileLlm, makeSenseLlm, maskKey, resolveLlmConfig } from "./llm-config.js";
import type { SenseLlm } from "@lampgenie/code-sense/sensing/index";

/** 送 LLM 的端点上限(>40 截断,显式标注)。 */
export const SEMANTICS_MAX_ENDPOINTS = 40;
/** 单次 LLM 请求的端点数上限(13 端点→12+1 两片)。 */
export const SEMANTICS_BATCH_SIZE = 12;
/** 单端点代码窗摘要进 prompt 的字符上限。 */
const EXCERPT_CHAR_CAP = 600;
/** 单批次 prompt 总字符上限(12×600 代码窗+头部,留余量)。 */
const PROMPT_CHAR_CAP = 16_000;

// ---- 输入/输出契约 ----

/** 语义层输入端点(确定性层 ApiEndpoint 的子集 + 代码窗摘要;由调用方组装)。 */
export interface ApiEndpointForSemantics {
  method: string;
  path: string;
  handler?: string;
  file?: string;
  line?: number;
  /** 行扫描已有的注释提示(http-api docHint),有则一并给 LLM。 */
  docHint?: string;
  /** 代码窗摘要(handler 定位行附近若干行;缺席=仅凭 method/path/handler 描述)。 */
  codeExcerpt?: string;
}

export interface ApiSemanticsItem extends ApiEndpointForSemantics {
  /** 一句语义描述(LLM 产出;缺席=本次未产出)。 */
  semantic?: string;
  /** 超 40 上限未送 LLM(显式标注,不静默丢)。 */
  truncatedOut?: boolean;
}

export interface ApiSemanticsResult {
  /** ok=有语义产出;cached=缓存命中(本次 0 次 LLM 调用);off=无凭证(显式文案);failed=LLM 全失败。 */
  status: "ok" | "cached" | "off" | "failed";
  reason?: string;
  /** 本次运行实际发生的 LLM 请求数(缓存命中/off=0)。 */
  llmCalls: number;
  /** 分片数(每片 ≤SEMANTICS_BATCH_SIZE)。 */
  batches: number;
  /** >40 截断呈报:total=原始端点数,kept=送 LLM 的前 40。 */
  truncated?: { total: number; kept: number };
  /** LLM 应答缺失/不合格/批次失败被丢弃的端点数。 */
  dropped?: number;
  /** 全部端点(含截断标注者;确定性信息原样保留)。 */
  endpoints: ApiSemanticsItem[];
  cache?: { hit?: boolean; key?: string; path?: string; written?: boolean; generatedAt?: number };
  /** LLM 形态呈报(只含 model 与 maskKey 形态 apiKey,凭证红线)。 */
  llm?: { source: "flag" | "env" | "config" | "ask-file" | "injected"; model: string; apiKey: string };
}

export interface ApiSemanticsOpts {
  /** 项目根(缓存与 git sha 的锚点;缺省 process.cwd())。 */
  root?: string;
  /** 显式开启缓存写入(默认 false——本仓只读红线,不落盘)。 */
  writeCache?: boolean;
  /** 注入 LLM(测试用);缺省走 resolveLlmConfig 凭证链。 */
  llm?: SenseLlm;
  /** 凭证链透传(测试注入 env 三件套/configFile 用;缺省用 process.env/真实配置文件)。 */
  env?: NodeJS.ProcessEnv;
  flags?: { baseURL?: string; model?: string; apiKey?: string };
  configFile?: unknown;
}

// ---- 指纹与缓存 ----

/** 路径参数归一(:id / {id} → {},与 sensing/index normalizeKey 同规则)。 */
function normalizeEpPath(p: string): string {
  return p.replace(/:([\w]+)/g, "{}").replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "");
}

/** 端点集指纹:全集(含超 40 的部分)归一排序后 sha1 前 16 位——第 41 个端点变更也失效。 */
export function endpointFingerprint(endpoints: ApiEndpointForSemantics[]): string {
  const lines = endpoints
    .map((e) => `${e.method.toUpperCase()} ${normalizeEpPath(e.path)}${e.handler ? ` ${e.handler}` : ""}`)
    .sort()
    .join("\n");
  return createHash("sha1").update(lines).digest("hex").slice(0, 16);
}

/** git sha(非 git 仓/失败=字面量 "no-git",不抛错)。 */
export function gitHeadOf(root: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return "no-git";
  }
}

/** 缓存键 = git sha + 端点集指纹。 */
export function apiSemanticsCacheKey(root: string, endpoints: ApiEndpointForSemantics[]): string {
  return `${gitHeadOf(root)}:${endpointFingerprint(endpoints)}`;
}

export function apiSemanticsCachePath(root: string): string {
  return join(root, ".genie", "sense-index", "api-semantics.json");
}

interface ApiSemanticsCacheFile {
  version: 1;
  /** 多键共存(不同 git sha/端点集互不驱逐)。 */
  entries: Record<string, { generatedAt: number; model: string; result: Omit<ApiSemanticsResult, "cache" | "status" | "llmCalls"> }>;
}

/** 读缓存:文件不存在=null;坏 JSON=null(如实跳过,不抛——语义层是增强不是闸门)。 */
function readCacheFile(path: string): ApiSemanticsCacheFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ApiSemanticsCacheFile;
    return parsed && parsed.version === 1 && parsed.entries ? parsed : null;
  } catch {
    return null;
  }
}

/** 写缓存:读-改-写保留其它键;不含任何凭证(只记 model)。 */
function writeCacheFile(path: string, file: ApiSemanticsCacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}

// ---- LLM 交互 ----

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPrompt(batch: { item: ApiSemanticsItem; id: string }[]): string {
  const head =
    "你是后端接口分析师。为下列 HTTP 接口各写一句中文语义描述(≤60 字:这个接口做什么、输入/输出要点)。" +
    '只依据给出的代码事实,不推测业务背景。只输出 JSON(schema: {"E1":"一句描述","E2":"…"}),不要输出其它内容。\n\n';
  const body = batch
    .map(({ item, id }) => {
      const meta = `[${id}] ${item.method} ${item.path}` +
        (item.handler ? ` → handler ${item.handler}` : "") +
        (item.file ? ` @${item.file}${item.line ? `:${item.line}` : ""}` : "") +
        (item.docHint ? `(注释: ${item.docHint})` : "");
      const code = item.codeExcerpt?.trim() ? `\n${item.codeExcerpt.trim().slice(0, EXCERPT_CHAR_CAP)}` : "";
      return `${meta}${code}`;
    })
    .join("\n\n");
  return (head + body).slice(0, PROMPT_CHAR_CAP);
}

/** 从 LLM 文本里抠第一个平衡的 JSON 对象(容忍 ```json 围栏/前后缀闲话)。 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```(?:json)?/g, "");
  const start = stripped.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(stripped.slice(start, i + 1)) as Record<string, unknown>;
          return obj && typeof obj === "object" ? obj : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---- 主入口 ----

/**
 * 语义层主入口:端点列表(method/path/handler+代码窗摘要)→ 每端点一句语义描述。
 *
 * 流程:截断标注(>40)→ 缓存命中检查(文件已存在才读;命中=0 次 LLM 调用)→ 凭证解析
 * (复用 llm-config 链;无凭证=显式 off,不抛错)→ 分片批跑(≤12/请求)→ 结果回填。
 * writeCache=true 且 status=ok 时才写缓存文件;默认 false,零落盘。
 */
export async function annotateApiSemantics(
  endpoints: ApiEndpointForSemantics[],
  opts: ApiSemanticsOpts = {},
): Promise<ApiSemanticsResult> {
  const root = opts.root ?? process.cwd();
  const items: ApiSemanticsItem[] = endpoints.map((e) => ({ ...e }));
  const total = items.length;

  // ① 上限:>40 只取前 40 送 LLM,其余显式标注保留(不静默丢)
  const kept = items.slice(0, SEMANTICS_MAX_ENDPOINTS);
  if (total > SEMANTICS_MAX_ENDPOINTS) {
    for (let i = SEMANTICS_MAX_ENDPOINTS; i < total; i++) items[i]!.truncatedOut = true;
  }
  const truncated = total > SEMANTICS_MAX_ENDPOINTS ? { total, kept: kept.length } : undefined;
  const base = { endpoints: items, batches: 0, llmCalls: 0, ...(truncated ? { truncated } : {}) };

  if (total === 0) {
    return { ...base, status: "ok", reason: "无端点,跳过语义层" };
  }

  // ② 缓存:只在文件已存在时读;命中=0 次 LLM 调用(无需凭证)
  const cachePath = apiSemanticsCachePath(root);
  const key = apiSemanticsCacheKey(root, endpoints);
  const cached = readCacheFile(cachePath);
  const hit = cached?.entries[key];
  if (hit) {
    return {
      ...hit.result,
      status: "cached",
      llmCalls: 0,
      cache: { hit: true, key, path: cachePath, generatedAt: hit.generatedAt },
    };
  }

  // ③ 凭证:复用 llm-config 解析链(不新造);null=显式 off,不抛错
  let llm: SenseLlm | null = opts.llm ?? null;
  let llmInfo: ApiSemanticsResult["llm"] | undefined;
  let model = "(注入)";
  if (opts.llm) {
    llmInfo = { source: "injected", model, apiKey: maskKey(undefined) };
  } else {
    const resolved = resolveLlmConfig({ env: opts.env, flags: opts.flags, configFile: opts.configFile as never });
    if (!resolved) {
      return {
        ...base,
        status: "off",
        reason:
          "未配置 LLM 凭证(GENIE_LLM_* env / ~/.codesense/config.json / llm.askFile.dir 均不可用);" +
          "接口确定性清单(method/path/handler)独立可用——配置凭证后重跑即得语义描述",
      };
    }
    if (resolved.kind === "ask-file") {
      llm = makeAskFileLlm(resolved.dir);
      model = "ask-file";
      llmInfo = { source: "ask-file", model, apiKey: maskKey(undefined) };
    } else {
      llm = makeSenseLlm(resolved.cfg);
      model = resolved.cfg.model;
      llmInfo = { source: resolved.source, model, apiKey: maskKey(resolved.cfg.apiKey) };
    }
  }

  // ④ 分片批跑:单请求 ≤12 端点;llmCalls 计数(缓存命中证明用)
  const batches = chunk(kept, SEMANTICS_BATCH_SIZE);
  let llmCalls = 0;
  let semanticCount = 0;
  let dropped = 0;
  let lastErr = "";
  for (const batch of batches) {
    const batchStart = kept.indexOf(batch[0]!);
    const tagged = batch.map((item, i) => ({ item, id: `E${batchStart + i + 1}` }));
    llmCalls++;
    try {
      const raw = await llm!.generate(buildPrompt(tagged));
      const obj = parseJsonObject(raw);
      let any = false;
      for (const { item, id } of tagged) {
        const v = obj?.[id];
        if (typeof v === "string" && v.trim()) {
          item.semantic = v.trim();
          semanticCount++;
          any = true;
        } else {
          dropped++;
        }
      }
      if (!any) lastErr ||= "LLM 输出解析后无有效描述";
    } catch (err) {
      dropped += batch.length;
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }

  const status: ApiSemanticsResult["status"] = semanticCount > 0 ? "ok" : "failed";
  const result: ApiSemanticsResult = {
    ...base,
    status,
    llmCalls,
    batches: batches.length,
    llm: llmInfo,
    ...(dropped > 0 ? { dropped } : {}),
    ...(status === "failed" ? { reason: lastErr || "LLM 未产出任何有效描述" } : lastErr ? { reason: `部分批次失败: ${lastErr.slice(0, 160)}` } : {}),
  };

  // ⑤ 写缓存:仅 writeCache 显式开启且 ok(失败结果不缓存);内容无凭证
  if (opts.writeCache === true && status === "ok") {
    const file: ApiSemanticsCacheFile =
      readCacheFile(cachePath) ?? { version: 1, entries: {} };
    file.entries[key] = {
      generatedAt: Date.now(),
      model,
      // 落盘体不带本次运行计数/status(命中时另行呈报 0 调用),也不带 llm 凭证形态
      result: {
        endpoints: result.endpoints,
        batches: result.batches,
        ...(result.truncated ? { truncated: result.truncated } : {}),
        ...(result.dropped !== undefined ? { dropped: result.dropped } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      },
    };
    writeCacheFile(cachePath, file);
    result.cache = { hit: false, key, path: cachePath, written: true };
  }
  return result;
}

// ---- 文本渲染(CLI/脚本面同源;CLI 接线由后续批做,这里只供模块消费方) ----

export function renderApiSemantics(r: ApiSemanticsResult): string {
  const lines: string[] = [];
  if (r.status === "off") {
    lines.push(`接口语义层: off(0 次 LLM 调用)`);
    if (r.reason) lines.push(`  ${r.reason}`);
    return lines.join("\n");
  }
  if (r.status === "cached") {
    lines.push(`接口语义层: cached(命中缓存 ${r.cache?.key ?? "?"};本次 0 次 LLM 调用)`);
  } else {
    lines.push(`接口语义层: ${r.status} · LLM 调用 ${r.llmCalls} 次(分片 ${r.batches})${r.llm ? ` · ${r.llm.source}/${r.llm.model}` : ""}`);
  }
  if (r.truncated) {
    lines.push(`  [截断] 端点共 ${r.truncated.total} > ${SEMANTICS_MAX_ENDPOINTS},只取前 ${r.truncated.kept} 送 LLM;其余 ${r.truncated.total - r.truncated.kept} 个显式列出但无语义描述`);
  }
  if (r.dropped !== undefined && r.dropped > 0) lines.push(`  [丢弃] ${r.dropped} 个端点的 LLM 应答缺失/不合格`);
  if (r.reason) lines.push(`  ${r.reason}`);
  for (const e of r.endpoints) {
    const desc = e.truncatedOut ? "(超出 40 上限,未送 LLM——截断显式标注)" : (e.semantic ?? "(未产出)");
    lines.push(`  ${e.method} ${e.path}${e.handler ? ` → ${e.handler}` : ""} — ${desc}`);
  }
  return lines.join("\n");
}
