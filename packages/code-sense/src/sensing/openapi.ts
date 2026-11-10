/**
 * sensing/openapi(step-077 / designs/24 §2.1):OpenAPI/swagger 规范消费与对账。
 *
 * 规范文件存在时=权威源,与代码提取结果对账:
 *   both(一致)/ spec-only(规范有代码没提取到=候选遗漏)/ code-only(代码有规范没有=规范过期候选)。
 *   差异如实列出,不做自动裁决。
 *
 * JSON 全量解析;YAML=受控子集解析器(零依赖,只识别 paths→method→summary/description/operationId
 * 域;锚点/多行块/流式集合等越界形态显式 partial 降级+失败行号,不硬解不猜)。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath, type ApiEndpoint } from "./http-api";

export interface SpecOperation {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
}

export interface SpecParseResult {
  file: string;
  parse: "full" | "partial";
  operations: SpecOperation[];
  /** partial 时的原因行号清单(诚实降级)。 */
  notes: string[];
}

export interface SpecReconcile {
  spec: SpecParseResult;
  both: { method: string; path: string; summary?: string; endpoint?: ApiEndpoint }[];
  specOnly: SpecOperation[];
  codeOnly: ApiEndpoint[];
}

const SPEC_FILE_RE = /^(openapi|swagger)\.(json|ya?ml)$/i;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".venv", "__pycache__", "vendor", "ref"]);

/** 规范文件发现(根下深度 ≤3;文件名形态 openapi.* / swagger.*)。 */
export async function findSpecFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try { entries = await readdir(join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(rel, depth + 1);
      } else if (SPEC_FILE_RE.test(e.name)) {
        out.push(rel);
      }
    }
  }
  await walk("", 0);
  return out.sort();
}

const HTTP_KEYS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "trace"]);

/** JSON 规范解析(全量)。 */
export function parseSpecJson(file: string, text: string): SpecParseResult {
  const operations: SpecOperation[] = [];
  const notes: string[] = [];
  try {
    const doc = JSON.parse(text) as { paths?: Record<string, Record<string, unknown>> };
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      if (!item || typeof item !== "object") continue;
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_KEYS.has(method.toLowerCase())) continue;
        const o = (op ?? {}) as { summary?: unknown; description?: unknown; operationId?: unknown };
        operations.push({
          method: method.toUpperCase(), path,
          ...(typeof o.summary === "string" ? { summary: o.summary } : {}),
          ...(typeof o.description === "string" ? { description: o.description } : {}),
          ...(typeof o.operationId === "string" ? { operationId: o.operationId } : {}),
        });
      }
    }
    return { file, parse: "full", operations, notes };
  } catch (e) {
    return { file, parse: "partial", operations, notes: [`JSON 解析失败: ${String(e).slice(0, 80)}`] };
  }
}

/** YAML 受控子集解析:只认 `paths:` 下的 path(2 空格级)→ method(4 级)→ summary/description/operationId(6 级)。
 * 越界形态(锚点 & / 别名 * / 多行块 | > / 流式集合 [ {)=partial 降级,其余内容继续解析。 */
export function parseSpecYamlSubset(file: string, text: string): SpecParseResult {
  const operations: SpecOperation[] = [];
  const notes: string[] = [];
  const lines = text.split("\n");
  let inPaths = false;
  let curPath = "";
  let curMethod = "";
  let partial = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const content = raw.trim();
    // 越界形态检测(在 paths 域内才有意义)
    if (inPaths && /[&*]|[[\]{}]|\s[|>]\s*$/.test(content) && !/^["'].*["']:?$/.test(content)) {
      partial = true;
      notes.push(`L${i + 1}: 越界 YAML 形态(锚点/多行块/流式集合),该节点跳过: ${content.slice(0, 60)}`);
      continue;
    }
    if (indent === 0) {
      if (/^paths\s*:/.test(content)) { inPaths = true; continue; }
      if (inPaths) { inPaths = false; } // 新的顶级键=paths 域结束
      continue;
    }
    if (!inPaths) continue;
    const kv = /^["']?([^"':]+?)["']?\s*:\s*(.*)$/.exec(content);
    if (!kv) continue;
    const [, key, valRaw] = kv as unknown as [string, string, string];
    const val = valRaw.replace(/^["']|["']$/g, "").trim();
    if (indent === 2 && key.startsWith("/")) {
      curPath = key; curMethod = "";
      continue;
    }
    if (indent === 4 && HTTP_KEYS.has(key.toLowerCase())) {
      curMethod = key.toUpperCase();
      operations.push({ method: curMethod, path: curPath });
      continue;
    }
    if (indent === 4 && !HTTP_KEYS.has(key.toLowerCase())) { curMethod = ""; continue; }
    if (indent === 6 && curMethod && ["summary", "description", "operationId"].includes(key)) {
      const op = operations[operations.length - 1]!;
      (op as unknown as Record<string, string>)[key] = val;
    }
  }
  return { file, parse: partial ? "partial" : "full", operations, notes };
}

/** 规范文件解析入口(按扩展名分派)。 */
export async function parseSpecFile(root: string, rel: string): Promise<SpecParseResult> {
  let text = "";
  try { text = await readFile(join(root, rel), "utf-8"); } catch (e) {
    return { file: rel, parse: "partial", operations: [], notes: [`读取失败: ${String(e).slice(0, 60)}`] };
  }
  return /\.json$/i.test(rel) ? parseSpecJson(rel, text) : parseSpecYamlSubset(rel, text);
}

/** 对账:spec(权威)× code 提取。匹配键=normalizePath+method。 */
export function reconcileSpec(spec: SpecParseResult, endpoints: ApiEndpoint[]): SpecReconcile {
  const codeByKey = new Map<string, ApiEndpoint>();
  for (const e of endpoints) {
    if (e.kind !== "http") continue;
    codeByKey.set(`${e.method} ${normalizePath(e.path)}`, e);
    // ANY 注册的端点与具体 method 的 spec 条目也算对上
    if (e.method === "ANY") {
      for (const m of HTTP_KEYS) codeByKey.set(`${m.toUpperCase()} ${normalizePath(e.path)}`, e);
    }
  }
  const specKeys = new Set<string>();
  const both: SpecReconcile["both"] = [];
  const specOnly: SpecOperation[] = [];
  for (const op of spec.operations) {
    const key = `${op.method} ${normalizePath(op.path)}`;
    specKeys.add(key);
    const ep = codeByKey.get(key);
    if (ep) both.push({ method: op.method, path: op.path, ...(op.summary ? { summary: op.summary } : {}), endpoint: ep });
    else specOnly.push(op);
  }
  const codeOnly = endpoints.filter((e) => {
    if (e.kind !== "http") return true; // ws 端点不参与 HTTP 规范对账,也不报 code-only
    if (e.method === "ANY") {
      return !spec.operations.some((op) => normalizePath(op.path) === normalizePath(e.path));
    }
    return !specKeys.has(`${e.method} ${normalizePath(e.path)}`);
  });
  return { spec, both, specOnly, codeOnly };
}

// ==================== OpenAPI 对账的单一真相源(api 面与 bridge 面共用) ====================

export interface SpecReconcileAtRoot {
  /** 命中的规范文件清单(findSpecFiles 已排序,首个即权威 spec)。 */
  specFiles: string[];
  /** 排序首个的解析结果;无 spec 时缺席(不造空壳)。 */
  spec?: SpecParseResult;
  /** 对账三态;无 spec 时缺席。 */
  reconcile?: SpecReconcile;
}

/**
 * **OpenAPI 对账的单一真相源**:findSpecFiles → parseSpecFile(排序首个) → reconcileSpec。
 *
 * api 输出(sensing/index.ts 的 ApiSurfaceResult.reconcile)与 bridge 的 spec 形态
 * (crosslang-bridge.ts 的 querySpecBridgeEdges)都必须经此函数取对账结果,**禁止另起一套
 * 发现/解析/对账**(历史上两侧各串一遍同样三步,spec 口径一改就双实现漂移:
 * 例如一侧改了排序/解析降级/键归一化,另一侧不会跟着变)。
 *
 * 授权口径亦唯一定义在此:spec 文件名形态 openapi.<ext> 或 swagger.<ext>、根下深度 ≤3;spec 在两个面
 * 都是同一份(「排序首个」= 多 spec 仓的确定性裁决),不做面与面之间的差异过滤。
 */
export async function reconcileForRoot(
  root: string,
  endpoints: ApiEndpoint[],
  /** 可选复用:只能传 specFingerprint() 返回的 specFiles(同一发现口径的结果传递,
   * 不是第二条发现路径)。用途=缓存键算完指纹后直接对账,省掉同一轮第二次全仓遍历
   * (本仓实测一次 findSpecFiles ≈ 0.8s)。传入即视为已发现,不再遍历。 */
  known?: { specFiles: string[] },
): Promise<SpecReconcileAtRoot> {
  const specFiles = known?.specFiles ?? await findSpecFiles(root);
  if (specFiles.length === 0) return { specFiles };
  const spec = await parseSpecFile(root, specFiles[0]!);
  return { specFiles, spec, reconcile: reconcileSpec(spec, endpoints) };
}

/** spec 指纹档位:深档(全仓遍历发现**新增** spec 文件)的最短间隔。
 *
 * 取舍(实测,2026-10,本机 9p 慢盘 E 盘 WSL;poly-owncast 不在本机,无法按 271 端点实测,
 * 故在目录数同量级的本仓测量:272 目录 / 2629 文件):
 *   · 深档 findSpecFiles(串行 readdir)= 760~845ms(四次连续稳定)→ 每轮查询都做会把
 *     api/长驻进程查询拖到秒级,与 c2f.ts「查询路径不做同步全仓遍历」的既有纪律冲突;
 *   · 只 stat 已知 spec 文件 = 亚毫秒级;
 *   · 并行 stat 272 个目录取 mtime = 115~162ms(可作新增文件检测,但仍比廉价档高 2 个量级)。
 * 因此分两档:**每次**走廉价档(已存在的 spec 被改/删 → 当次立即失效,零窗口);深档最多
 * 1s 一次(新增 spec 文件 → 最迟 1s 内被发现)。1s ≪ api 面的 60s TTL ⇒ 60s 缓存窗口内
 * 「spec 修改」零延迟生效、「spec 新增」上限 1s,都不会被旧对账掩盖。
 * 选 1s 而非 0:把 150ms 级目录 stat 摊到 1s 一次,保证 60s TTL 的缓存命中路径仍是毫秒级。 */
const SPEC_DISCOVERY_TTL_MS = 1_000;

interface SpecFpState { at: number; files: string[]; mtimes: Map<string, number>; }
const specFpCache = new Map<string, SpecFpState>();

async function statMtime(abs: string): Promise<number | undefined> {
  try { return (await stat(abs)).mtimeMs; } catch { return undefined; }
}

function fmtSpecKey(files: string[], mtimes: Map<string, number>): string {
  return files.length === 0 ? "none" : files.map((f) => `${f}@${mtimes.get(f) ?? -1}`).join("|");
}

/**
 * spec 指纹(缓存键成分):**spec 文件清单 + 各文件 mtime**。
 * api 面的 60s TTL 缓存键必须含它——源码扩展名指纹(GRAPH_SOURCE_EXT)不含
 * openapi.yaml/json,长驻进程(MCP serve)里改了 spec,旧代码会继续返回 60s 前的对账。
 * 返回 key 供缓存键使用,specFiles 供调用方判断有无 spec。
 */
export async function specFingerprint(root: string, force = false): Promise<{ key: string; specFiles: string[] }> {
  const hit = specFpCache.get(root);
  if (!force && hit && Date.now() - hit.at < SPEC_DISCOVERY_TTL_MS) {
    // 廉价档:只 stat 已知 spec 文件——「已存在的 spec 被改/被删」当次即失效
    const mtimes = new Map<string, number>();
    let changed = false;
    for (const f of hit.files) {
      const m = await statMtime(join(root, f));
      if (m === undefined || hit.mtimes.get(f) !== m) { changed = true; break; }
      mtimes.set(f, m);
    }
    if (!changed) return { key: fmtSpecKey(hit.files, mtimes), specFiles: hit.files };
  }
  // 深档:readdir 发现(新增 spec 文件只能靠它看见),并把 mtime 一并取回入档
  const files = await findSpecFiles(root);
  const mtimes = new Map<string, number>();
  for (const f of files) {
    const m = await statMtime(join(root, f));
    if (m !== undefined) mtimes.set(f, m);
  }
  specFpCache.set(root, { at: Date.now(), files, mtimes });
  return { key: fmtSpecKey(files, mtimes), specFiles: files };
}
