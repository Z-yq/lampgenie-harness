/**
 * Office 导出契约的共享纯逻辑层(-A,零 IO)。
 * 为什么需要它:同一份文档常要被导成多种目标格式(PPT→PDF 预览、DOCX→PNG 缩略、
 * MD→PPTX 汇报稿…),而每条链路都牵涉三个各自会出错的环节:
 * 1. 路由——哪种输入能到哪种目标、要经过哪几个引擎(soffice/gs/pptxgenjs/原生渲染器);
 * 2. 依赖——引擎装没装、第三方件(vendor)清单对不对得上、离线时还满不满足约束;
 * 3. 产物——页数/字节/sha256 是否可信,内容里有没有漏填的占位符和必须联网的外链。
 * 这三件事如果散落在 gateway/CLI/UI 各自实现,就会出现「面板说能导、命令行说不能导」
 * 这类漂移。于是把判定收敛成一张固定路由表 + 三组纯校验函数:本模块只回答结论,
 * 真正调用 LibreOffice/Ghostscript、落盘与上传都在上层。
 * 四个概念:
 * - route:输入×目标 → 固定引擎链(不降级;比如 md→pdf 没有路由,不会偷偷走 md→html→pdf)。
 * - manifest:vendor 目录的内容清单(name/version/entries),用于确认本机依赖件与出厂一致。
 * - preflight:导出前的全量体检(占位符/外链/空页/字体/清单),一次收全部 failures 而不是首错即停。
 * - artifact:导出后对产物做最小可信校验(非空、页数对得上、两个 sha256 格式合法)。
 * 关键不变量:
 * 1. 所有导出函数都不修改入参(`pages`/`entries`/`actual` 一律只读遍历),返回新对象。
 * 2. 零 IO、不 throw:本模块唯一 import 是 node:crypto(供 sha256Hex 使用),
 * 不读文件/环境/网络/时钟,同一入参两次调用必定深相等。
 * 3. 码表顺序固定(便于自动化按码断言与落盘),`EXPORT_CODES` 即全部稳定码。
 * 4. 路由不降级:没有路由就是 EXPORT_UNSUPPORTED,绝不拼一条临时链路。
 * 5. ok 只在「路由支持且零 failures」时为 true;warnings 永远不影响 ok。
 */
import { createHash } from "node:crypto";

/** 导出契约 schema 版本:字段语义变化时递增。 */
export const EXPORT_CONTRACT_VERSION = 1;

/** 稳定码:导出路由/依赖/产物的全部判断结论(字符串常量,便于落盘与断言)。 */
export const EXPORT_OK = "EXPORT_OK" as const;
export const EXPORT_INVALID = "EXPORT_INVALID" as const;
export const EXPORT_UNSUPPORTED = "EXPORT_UNSUPPORTED" as const;
export const EXPORT_ENGINE_MISSING = "EXPORT_ENGINE_MISSING" as const;
export const EXPORT_ENGINE_UNAVAILABLE = "EXPORT_ENGINE_UNAVAILABLE" as const;
export const EXPORT_MANIFEST_MISSING = "EXPORT_MANIFEST_MISSING" as const;
export const EXPORT_MANIFEST_MISMATCH = "EXPORT_MANIFEST_MISMATCH" as const;
export const EXPORT_EXTERNAL_REF = "EXPORT_EXTERNAL_REF" as const;
export const EXPORT_PLACEHOLDER = "EXPORT_PLACEHOLDER" as const;
export const EXPORT_EMPTY_PAGE = "EXPORT_EMPTY_PAGE" as const;
export const EXPORT_EMPTY_DECK = "EXPORT_EMPTY_DECK" as const;
export const EXPORT_OFFLINE_VIOLATION = "EXPORT_OFFLINE_VIOLATION" as const;
export const EXPORT_ARTIFACT_INVALID = "EXPORT_ARTIFACT_INVALID" as const;
export const EXPORT_FONT_MISSING = "EXPORT_FONT_MISSING" as const;

/** 全部稳定码(固定顺序)。 */
export const EXPORT_CODES = [
  EXPORT_OK,
  EXPORT_INVALID,
  EXPORT_UNSUPPORTED,
  EXPORT_ENGINE_MISSING,
  EXPORT_ENGINE_UNAVAILABLE,
  EXPORT_MANIFEST_MISSING,
  EXPORT_MANIFEST_MISMATCH,
  EXPORT_EXTERNAL_REF,
  EXPORT_PLACEHOLDER,
  EXPORT_EMPTY_PAGE,
  EXPORT_EMPTY_DECK,
  EXPORT_OFFLINE_VIOLATION,
  EXPORT_ARTIFACT_INVALID,
  EXPORT_FONT_MISSING,
] as const;

export type ExportCode = (typeof EXPORT_CODES)[number];

/** 支持的输入格式。 */
export const INPUT_KINDS = ["pptx", "docx", "xlsx", "md", "html", "pdf"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

/** 支持的导出目标格式。 */
export const TARGETS = ["pptx", "pdf", "png", "md", "html"] as const;
export type Target = (typeof TARGETS)[number];

/** 参与导出的引擎代号。 */
export const ENGINES = ["soffice", "gs", "pptxgenjs", "native-md", "native-html"] as const;
export type Engine = (typeof ENGINES)[number];

/** 引擎特性:是否必须联网才能工作(可用 engineSpecs 覆盖,便于测试/特殊部署)。 */
export interface EngineSpec {
  engine: Engine;
  requiresNetwork: boolean;
}

/** 五个引擎的出厂默认特性:全部可离线(都是本地进程/本地库)。 */
export const ENGINE_SPECS: Record<Engine, EngineSpec> = Object.freeze({
  soffice: Object.freeze({ engine: "soffice", requiresNetwork: false }),
  gs: Object.freeze({ engine: "gs", requiresNetwork: false }),
  pptxgenjs: Object.freeze({ engine: "pptxgenjs", requiresNetwork: false }),
  "native-md": Object.freeze({ engine: "native-md", requiresNetwork: false }),
  "native-html": Object.freeze({ engine: "native-html", requiresNetwork: false }),
});

/** 路由请求:一次导出要问「这条链路能不能走、走哪个引擎」。 */
export interface RouteRequest {
  input: InputKind;
  target: Target;
 /** 离线约束:任一必需引擎需要网络即拒绝(EXPORT_ENGINE_UNAVAILABLE)。 */
  offline?: boolean;
 /** 本机实际可用的引擎;缺省视为全可用。 */
  availableEngines?: readonly Engine[];
 /** 引擎特性覆盖(缺省用 ENGINE_SPECS)。 */
  engineSpecs?: Readonly<Record<string, EngineSpec>>;
}

/** 路由裁决:engine 为第一段引擎;两段式链路的第二段写在 reason 里。 */
export interface RouteResult {
  supported: boolean;
  engine?: Engine;
  code: ExportCode;
  reason?: string;
}

/** 内部路由规则:引擎链至少一段,顺序即执行顺序。 */
interface RouteRule {
  readonly input: InputKind;
  readonly target: Target;
  readonly stages: readonly [Engine, ...Engine[]];
}

/**
 * 固定路由表(不可降级)。两段式(px→png)一律 soffice 出中间件、gs 光栅化:
 * 单靠 soffice 直接吐 PNG 会丢多页,单靠 gs 又不认 OOXML,所以必须两段。
 */
const ROUTE_TABLE: readonly RouteRule[] = [
  { input: "pptx", target: "pdf", stages: ["soffice"] },
  { input: "pptx", target: "png", stages: ["soffice", "gs"] },
  { input: "pptx", target: "pptx", stages: ["pptxgenjs"] },
  { input: "docx", target: "pdf", stages: ["soffice"] },
  { input: "docx", target: "png", stages: ["soffice", "gs"] },
  { input: "xlsx", target: "pdf", stages: ["soffice"] },
  { input: "xlsx", target: "png", stages: ["soffice", "gs"] },
  { input: "md", target: "html", stages: ["native-md"] },
  { input: "md", target: "md", stages: ["native-md"] },
  { input: "md", target: "pptx", stages: ["pptxgenjs"] },
  { input: "html", target: "html", stages: ["native-html"] },
  { input: "html", target: "pdf", stages: ["soffice"] },
  { input: "pdf", target: "png", stages: ["gs"] },
];

/** 64 位小写/大写 hex(sha256 字面校验,不比较内容)。 */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** 判定值是否落在已知枚举里(用于把脏入参折叠成 EXPORT_INVALID)。 */
function isInputKind(value: unknown): value is InputKind {
  return typeof value === "string" && (INPUT_KINDS as readonly string[]).includes(value);
}

function isTarget(value: unknown): value is Target {
  return typeof value === "string" && (TARGETS as readonly string[]).includes(value);
}

/**
 * 取某个引擎的特性:入参覆盖优先,其次出厂默认;未知引擎视为「需要网络」
 * (无法证明它能离线,就按不安全处理)。
 */
function specOf(engine: string, specs?: Readonly<Record<string, EngineSpec>>): EngineSpec {
  const custom = specs?.[engine];
  if (custom !== undefined && typeof custom.requiresNetwork === "boolean") return custom;
  const builtin = (ENGINE_SPECS as Record<string, EngineSpec>)[engine];
  if (builtin !== undefined) return builtin;
  return { engine: engine as Engine, requiresNetwork: true };
}

/**
 * 路由裁决:先查固定表,再查引擎可用性,最后查离线约束。
 * 顺序即优先级:没路由 → UNSUPPORTED;路由有但引擎没装 → ENGINE_MISSING;
 * 引擎装了但离线不可用 → ENGINE_UNAVAILABLE。永不降级到别的引擎。
 */
export function routeExport(req: RouteRequest): RouteResult {
  const input: unknown = req?.input;
  const target: unknown = req?.target;
  if (!isInputKind(input) || !isTarget(target)) {
    return {
      supported: false,
      code: EXPORT_INVALID,
      reason: `未知的输入或目标格式: ${String(input)}→${String(target)}`,
    };
  }
  const rule = ROUTE_TABLE.find((r) => r.input === input && r.target === target);
  if (rule === undefined) {
    return {
      supported: false,
      code: EXPORT_UNSUPPORTED,
      reason: `${input}→${target} 没有固定路由(不降级拼接)`,
    };
  }
  const engine = rule.stages[0];
  const available = req.availableEngines ?? ENGINES;
  const missing = rule.stages.filter((e) => !available.includes(e));
  if (missing.length > 0) {
    return {
      supported: false,
      engine,
      code: EXPORT_ENGINE_MISSING,
      reason: `缺少必需引擎: ${missing.join(", ")}`,
    };
  }
  if (req.offline === true) {
    const specs = req.engineSpecs;
    const networked = rule.stages.filter((e) => specOf(e, specs).requiresNetwork);
    if (networked.length > 0) {
      return {
        supported: false,
        engine,
        code: EXPORT_ENGINE_UNAVAILABLE,
        reason: `离线模式不可用(引擎需要网络): ${networked.join(", ")}`,
      };
    }
  }
  const result: RouteResult = { supported: true, engine, code: EXPORT_OK };
  if (rule.stages.length > 1) {
    result.reason = `两段式: 第一段 ${engine},第二段 ${rule.stages[1]} 光栅化`;
  }
  return result;
}

/** vendor 清单里的一个条目:文件名 + 内容 sha256 + 字节数(+ 本地相对路径)。 */
export interface VendorEntry {
  name: string;
  sha256: string;
  bytes: number;
  path?: string;
}

/** vendor 清单:名称/版本 + 全部条目。 */
export interface VendorManifest {
  name: string;
  version: string;
  entries: VendorEntry[];
}

/** 实际观测到的条目(扫描本机 vendor 目录得到的 name/sha256/bytes)。 */
export interface ManifestActual {
  name: string;
  sha256: string;
  bytes: number;
}

/** 清单校验选项:offline 要求每条都带本地 path;actual 给了就逐条比对。 */
export interface VerifyManifestOptions {
  offline?: boolean;
  actual?: readonly ManifestActual[];
}

/** 清单裁决:mismatches 逐条 "name: 原因",warnings 留给非致命提示。 */
export interface ManifestVerdict {
  ok: boolean;
  code: ExportCode;
  mismatches: string[];
  warnings: string[];
}

/** 清单形状校验:缺失或结构坏折叠成 MANIFEST_MISSING,不再往下比。 */
function isManifestShape(value: unknown): value is VendorManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["name"] !== "string") return false;
  if (typeof record["version"] !== "string") return false;
  return Array.isArray(record["entries"]);
}

/**
 * 校验 vendor 清单。
 * 判定集中在此,是为了让「装错版本/漏复制文件/被篡改」在导出前就暴露:
 * - 清单缺失或形状坏 → MANIFEST_MISSING(根本没法校验);
 * - 条目为空/name 重复/sha256 非 64 hex/bytes 非正 → MANIFEST_MISMATCH(清单自身不自洽);
 * - 给了 actual:清单缺条目 → MANIFEST_MISSING;sha/bytes 不符 → MANIFEST_MISMATCH;
 * - offline:任一条目没有本地 path → OFFLINE_VIOLATION(离线时不允许回源下载)。
 * 多个问题同时存在时按 缺失 > 不符 > 离线 的优先级给单一 code,mismatches 仍全量保留。
 */
export function verifyVendorManifest(
  manifest: VendorManifest | null | undefined,
  opts: VerifyManifestOptions = {},
): ManifestVerdict {
  const warnings: string[] = [];
  if (!isManifestShape(manifest)) {
    return {
      ok: false,
      code: EXPORT_MANIFEST_MISSING,
      mismatches: ["manifest: 缺失或形状非法(需要 name/version/entries)"],
      warnings,
    };
  }
  const mismatches: string[] = [];
 /** 清单自报的名字;条目与清单级问题都用它做前缀,便于多份清单混跑时定位。 */
  const label = manifest.name !== "" ? manifest.name : "manifest";
  let missing = false;
  let mismatch = false;
  let offlineViolation = false;

  if (manifest.entries.length === 0) {
    mismatch = true;
    mismatches.push(`${label}: entries 为空`);
  }

  const seen = new Set<string>();
  manifest.entries.forEach((raw, position) => {
    const entry = raw as Partial<VendorEntry> | null | undefined;
    const name = entry?.name;
    if (typeof name !== "string" || name === "") {
      mismatch = true;
      mismatches.push(`entries[${position}]: name 缺失或非法`);
      return;
    }
    if (seen.has(name)) {
      mismatch = true;
      mismatches.push(`${name}: 条目重复`);
    }
    seen.add(name);
    if (typeof entry?.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
      mismatch = true;
      mismatches.push(`${name}: sha256 不是 64 位 hex`);
    }
    if (typeof entry?.bytes !== "number" || !Number.isFinite(entry.bytes) || entry.bytes <= 0) {
      mismatch = true;
      mismatches.push(`${name}: bytes 必须为正数`);
    }
    if (opts.offline === true && (typeof entry?.path !== "string" || entry.path === "")) {
      offlineViolation = true;
      mismatches.push(`${name}: 离线模式要求本地 path`);
    }
  });

  const actual = opts.actual;
  if (actual !== undefined) {
 // 反方向:清单要求、而实际目录里找不到 = 缺件(离线场景最常见的故障)。
    const observed = new Set<string>();
    for (const item of actual) {
      if (typeof item?.name === "string" && item.name !== "") observed.add(item.name);
    }
    for (const entry of manifest.entries) {
      if (typeof entry?.name === "string" && entry.name !== "" && !observed.has(entry.name)) {
        missing = true;
        mismatches.push(`${entry.name}: 实际产物缺失`);
      }
    }
    for (const item of actual) {
      const itemName = typeof item?.name === "string" && item.name !== "" ? item.name : "actual";
      const entry = manifest.entries.find((candidate) => candidate?.name === item?.name);
      if (entry === undefined) {
        missing = true;
        mismatches.push(`${itemName}: 清单中缺少该条目`);
        continue;
      }
      const expectedSha = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : "";
      const actualSha = typeof item?.sha256 === "string" ? item.sha256.toLowerCase() : "";
      if (expectedSha === "" || actualSha !== expectedSha) {
        mismatch = true;
        mismatches.push(`${itemName}: sha256 不符`);
      }
      if (typeof item?.bytes !== "number" || item.bytes !== entry.bytes) {
        mismatch = true;
        mismatches.push(
          `${itemName}: bytes 不符(清单 ${String(entry.bytes)},实际 ${String(item?.bytes)})`,
        );
      }
    }
  }

  let code: ExportCode = EXPORT_OK;
  if (missing) code = EXPORT_MANIFEST_MISSING;
  else if (mismatch) code = EXPORT_MANIFEST_MISMATCH;
  else if (offlineViolation) code = EXPORT_OFFLINE_VIOLATION;

  return { ok: mismatches.length === 0, code, mismatches, warnings };
}

/** 导出结果的一页(上游渲染产物的事实摘录)。 */
export interface ExportPage {
  index?: number;
  text?: string;
  texts?: string[];
  shapes?: number;
  images?: number;
}

/** 单页体检结论:nonEmpty = 有字或有图形或有图片。 */
export interface PageReport {
  index: number;
  nonEmpty: boolean;
  chars: number;
  shapes: number;
  images: number;
}

/** 只留字符串项:上游可能给出脏数组,这里一次性过滤成 string[]。 */
function textListOf(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/** 把非法计数(负数/NaN/缺省)折叠成 0,保证报告字段恒为非负整数。 */
function countOf(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

/**
 * 逐页体检:index 缺省按位置 1-based 补,显式 index 优先(上游可能已按 0 或原页号编号)。
 * chars 同时统计 text 与 texts,用于识别「有页面元素但一个字都没写」的空页。
 */
export function perPageReport(pages: readonly ExportPage[]): PageReport[] {
  if (!Array.isArray(pages)) return [];
  return pages.map((page, position) => {
    const text = typeof page?.text === "string" ? page.text : "";
    const texts = textListOf(page?.texts);
    const chars = text.length + texts.reduce((total, item) => total + item.length, 0);
    const shapes = countOf(page?.shapes);
    const images = countOf(page?.images);
    const explicit = page?.index;
    const index =
      typeof explicit === "number" && Number.isFinite(explicit) ? explicit : position + 1;
    return {
      index,
      nonEmpty: chars > 0 || shapes > 0 || images > 0,
      chars,
      shapes,
      images,
    };
  });
}

/** 预检请求:一次体检所需的全部事实(全部只读)。 */
export interface PreflightRequest {
  inputKind: InputKind;
  target: Target;
  pages: readonly ExportPage[];
  fonts?: readonly string[];
  externalRefs?: readonly string[];
  placeholders?: readonly string[];
  manifest?: VendorManifest | null;
  offline?: boolean;
  availableEngines?: readonly Engine[];
  engineSpecs?: Readonly<Record<string, EngineSpec>>;
 /** 离线时是否要求清单声明字体(缺省 true)。 */
  requireFontManifest?: boolean;
}

/** 一条预检问题:稳定码 + 给人看的细节(细节里点名哪一页/哪个引擎/哪个条目)。 */
export interface PreflightIssue {
  code: ExportCode;
  detail: string;
}

/** 预检结论:route 保留路由裁决,便于上层解释「为什么根本没法导」。 */
export interface PreflightResult {
  ok: boolean;
  code: ExportCode;
  route: RouteResult;
  failures: PreflightIssue[];
  warnings: PreflightIssue[];
  perPage: PageReport[];
}

/** 清单里是否声明了字体条目(name 含 font 或字体扩展名)。 */
const FONT_HINT = /font|\.(?:ttf|otf|ttc|woff2?)$/i;

function manifestDeclaresFonts(manifest: VendorManifest | null | undefined): boolean {
  if (!isManifestShape(manifest)) return false;
  return manifest.entries.some(
    (entry) => typeof entry?.name === "string" && FONT_HINT.test(entry.name),
  );
}

/** 取一页的全部可见文本(多段 texts 用换行拼接,避免跨段误拼出关键词)。 */
function pageText(page: ExportPage | null | undefined): string {
  const single = typeof page?.text === "string" ? page.text : "";
  return [single, ...textListOf(page?.texts)].join("\n");
}

/**
 * 导出前体检:先路由,路由通过后再**全收** failures(不首错即停,一次把问题讲全)。
 * 检查顺序即 failures 的排列顺序:
 * 占位符 → 外链(离线拒/在线 warn) → 空 deck → 空页 → 字体 warn → manifest 并入。
 * ok = 路由支持 && failures 为空;code = ok ? EXPORT_OK : 第一处失败码
 * (路由失败时直接沿用路由码,不再跑后续检查)。
 */
export function preflightExport(req: PreflightRequest): PreflightResult {
  const offline = req?.offline === true;
  const pages: readonly ExportPage[] = Array.isArray(req?.pages) ? req.pages : [];
  const route = routeExport({
    input: req?.inputKind,
    target: req?.target,
    offline,
    availableEngines: req?.availableEngines,
    engineSpecs: req?.engineSpecs,
  });
  const perPage = perPageReport(pages);
  const failures: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];

  if (!route.supported) {
    return { ok: false, code: route.code, route, failures, warnings, perPage };
  }

  const declared = req?.placeholders ?? [];
  for (const placeholder of declared) {
    if (typeof placeholder === "string" && placeholder.trim() !== "") {
      failures.push({ code: EXPORT_PLACEHOLDER, detail: `占位符未替换: ${placeholder}` });
    }
  }
  pages.forEach((page, position) => {
    const index = perPage[position]?.index ?? position + 1;
    for (const hit of findPlaceholders(pageText(page))) {
      failures.push({ code: EXPORT_PLACEHOLDER, detail: `第 ${index} 页含占位符: ${hit}` });
    }
  });

  const refs: string[] = [];
  for (const ref of req?.externalRefs ?? []) {
    if (typeof ref === "string" && ref.trim() !== "") pushUnique(refs, ref);
  }
 // 正文里写字面链接同样会断网失效,所以页面文本也扫一遍(与显式 externalRefs 合并去重)。
  for (const page of pages) {
    for (const ref of findExternalRefs(pageText(page))) pushUnique(refs, ref);
  }
  for (const ref of refs) {
    if (offline) {
      failures.push({ code: EXPORT_OFFLINE_VIOLATION, detail: `离线模式不允许外链: ${ref}` });
    } else {
      warnings.push({ code: EXPORT_EXTERNAL_REF, detail: `外链需联网,导出后不可离线复现: ${ref}` });
    }
  }

  if (pages.length === 0) {
    failures.push({ code: EXPORT_EMPTY_DECK, detail: "deck 没有任何页面" });
  }
  for (const report of perPage) {
    if (!report.nonEmpty) {
      failures.push({ code: EXPORT_EMPTY_PAGE, detail: `第 ${report.index} 页为空` });
    }
  }

  if ((req?.fonts?.length ?? 0) === 0) {
    warnings.push({ code: EXPORT_FONT_MISSING, detail: "未声明字体清单,渲染字形可能与预期不同" });
  }
  if (offline && req?.requireFontManifest !== false && !manifestDeclaresFonts(req?.manifest)) {
    warnings.push({
      code: EXPORT_FONT_MISSING,
      detail: "离线导出要求清单声明字体,但清单未声明任何字体",
    });
  }

  const manifest = req?.manifest;
  if (manifest !== null && manifest !== undefined) {
    const verdict = verifyVendorManifest(manifest, { offline });
    if (!verdict.ok) {
      failures.push({
        code: verdict.code,
        detail: verdict.mismatches.join("; ") || `依赖清单校验失败: ${verdict.code}`,
      });
    }
  }

  const ok = failures.length === 0;
  const code: ExportCode = ok ? EXPORT_OK : (failures[0]?.code ?? route.code);
  return { ok, code, route, failures, warnings, perPage };
}

/** 占位词表(固定顺序;匹配不区分大小写,返回的仍是这里的原文)。 */
export const PLACEHOLDER_PATTERNS = ["TODO", "待填", "TBD", "XXX", "lorem ipsum"] as const;

/** 剔除 ``` 围栏代码块与 `行内代码`,避免把示例代码里的 TODO 当成漏填。 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * 找占位词:不区分大小写、去重、按 PLACEHOLDER_PATTERNS 顺序返回 pattern 原文。
 * ignoreCodeBlocks 时先剔除代码块/行内代码——文档里常故意保留代码示例,那里出现
 * TODO/XXX 是正常的。
 */
export function findPlaceholders(text: string, opts: { ignoreCodeBlocks?: boolean } = {}): string[] {
  if (typeof text !== "string" || text === "") return [];
  const haystack = (opts.ignoreCodeBlocks === true ? stripCodeBlocks(text) : text).toLowerCase();
  const hits: string[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const needle = pattern.toLowerCase();
    if (!hits.includes(pattern) && haystack.includes(needle)) hits.push(pattern);
  }
  return hits;
}

/** 外链字面:http(s):// 与 file://,遇到空白/引号/括号即止。 */
const EXTERNAL_REF = /\b(?:https?|file):\/\/[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]+/gi;

/** 去重入栈(保持首次出现顺序)。 */
function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/** 去掉句末标点(中文句号、英文逗点等往往紧贴 URL)。 */
function trimRefTail(ref: string): string {
  return ref.replace(/[.,;:!?。，、；：！？]+$/g, "");
}

/** 找外链:去重、保留首次出现顺序;只做字面识别,不解析/不联网。 */
export function findExternalRefs(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const found: string[] = [];
  for (const match of text.matchAll(EXTERNAL_REF)) {
    const ref = trimRefTail(match[0]);
    if (ref !== "" && !found.includes(ref)) found.push(ref);
  }
  return found;
}

/** 单个引用是否外链(http/https/file 全限定 URL)。 */
export function isExternalRef(ref: string): boolean {
  if (typeof ref !== "string") return false;
  return /^\s*(?:https?|file):\/\/\S+\s*$/i.test(ref);
}

/** 产物事实:字节数/页数 + 输入与产物的 sha256(只校验格式,不要求两者相等)。 */
export interface ArtifactCheck {
  inputSha256?: string;
  artifactSha256?: string;
  bytes: number;
  pages: number;
  expectedPages?: number;
}

/** 产物裁决:ok 表示产物可交付;detail 写清是哪一项不过。 */
export interface ArtifactVerdict {
  ok: boolean;
  code: ExportCode;
  detail: string;
}

/**
 * 校验导出产物是否可信:
 * 空产物(bytes<=0)与零页直接拒;两个 sha256 必须都是 64 位 hex(缺省/空也算非法);
 * 给了 expectedPages 就要求页数一致(页数不符通常是转换中途失败却仍写了文件)。
 * 注意:不要求 inputSha256 === artifactSha256(格式变化后内容必然不同,那是正常的)。
 */
export function verifyArtifact(check: ArtifactCheck): ArtifactVerdict {
  const bytes = typeof check?.bytes === "number" ? check.bytes : Number.NaN;
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return {
      ok: false,
      code: EXPORT_ARTIFACT_INVALID,
      detail: "空产物:字节数必须为正",
    };
  }
  const pages = typeof check?.pages === "number" ? check.pages : Number.NaN;
  if (!Number.isFinite(pages) || pages <= 0) {
    return {
      ok: false,
      code: EXPORT_ARTIFACT_INVALID,
      detail: `产物没有页面: pages=${String(check?.pages)}`,
    };
  }
  const digests: readonly (readonly [string, string | undefined])[] = [
    ["inputSha256", check?.inputSha256],
    ["artifactSha256", check?.artifactSha256],
  ];
  for (const [label, value] of digests) {
    if (typeof value !== "string" || !SHA256_HEX.test(value)) {
      return {
        ok: false,
        code: EXPORT_ARTIFACT_INVALID,
        detail: `${label} 缺失或不是 64 位 hex`,
      };
    }
  }
  if (typeof check?.expectedPages === "number" && check.expectedPages !== pages) {
    return {
      ok: false,
      code: EXPORT_ARTIFACT_INVALID,
      detail: `期望 ${check.expectedPages} 页,实际 ${pages} 页`,
    };
  }
  return { ok: true, code: EXPORT_OK, detail: "产物校验通过" };
}

/** 离线保证请求:引擎特性 + 外链 + 清单已验 + 媒体已内嵌。 */
export interface OfflineGuaranteeRequest {
  engine: Engine;
  externalRefs?: readonly string[];
  manifestVerified: boolean;
  mediaEmbedded: boolean;
  engineSpecs?: Readonly<Record<string, EngineSpec>>;
}

/** 离线保证结论:reasons 逐条列出不满足项(空则 ok)。 */
export interface OfflineGuarantee {
  ok: boolean;
  code: ExportCode;
  reasons: string[];
}

/**
 * 判定一次导出是否真的能离线成立:引擎不需要网络、没有外链、清单已校验、媒体已内嵌。
 * 四者缺一不可——只有「产物看起来对」不算离线保证,断网后能否复现才是标准。
 */
export function offlineGuarantee(req: OfflineGuaranteeRequest): OfflineGuarantee {
  const reasons: string[] = [];
  const engine = req?.engine;
  const spec = specOf(String(engine), req?.engineSpecs);
  if (spec.requiresNetwork) reasons.push(`引擎 ${String(engine)} 需要网络`);
  const refs = (req?.externalRefs ?? []).filter(
    (ref): ref is string => typeof ref === "string" && ref.trim() !== "",
  );
  for (const ref of refs) reasons.push(`存在外链: ${ref}`);
  if (req?.manifestVerified !== true) reasons.push("vendor 清单未通过校验");
  if (req?.mediaEmbedded !== true) reasons.push("媒体未内嵌");
  const ok = reasons.length === 0;
  return { ok, code: ok ? EXPORT_OK : EXPORT_OFFLINE_VIOLATION, reasons };
}

/**
 * 附加辅助:算内容的 sha256 hex(供上层填 vendor 清单与 ArtifactCheck)。
 * 仅此一处用到 node:crypto,不做任何 IO。
 */
export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  return typeof data === "string" ? hash.update(data, "utf8").digest("hex") : hash.update(data).digest("hex");
}
