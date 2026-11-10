/**
 * 编辑后检查的公共类型(step-114 / M108)。
 * 语义:settings 缺省=低层关闭(单测/嵌入方不传=行为与旧版一致);
 * 生产配置 coding.lsp 经 zod 解析后显式传入({enabled:true,...}),即用户可见的「缺省 on」。
 */

/** 归一到一行的诊断(渲染层与工具结果解耦,便于单测)。 */
export interface DiagnosticItem {
  /** 1-based 行号。 */
  line: number;
  /** 1-based 列号。 */
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  /** TS2322 / pylsp code;可能缺席。 */
  code?: string | number;
  message: string;
  /** 诊断来源(typescript/pyright/pylsp/...;观测用)。 */
  source?: string;
}

/** 配置面(coding.lsp 的运行时形态)。 */
export interface LspSettings {
  enabled?: boolean;
  /** 单次诊断/格式化各自的预算(ms)。 */
  timeoutMs?: number;
  /** 单文件最多回灌条数。 */
  maxDiagnostics?: number;
  /** 保存即格式化开关。 */
  format?: boolean;
  /**
   * 写前 baseline + 写后 delta(M108):只报「写前不存在的新增」诊断。
   * 缺省 true;显式 false=旧行为(全量报告写后诊断)。
   */
  baseline?: boolean;
  /** 是否把 warning 一并回灌(缺省 false:只报 ERROR)。 */
  includeWarnings?: boolean;
}

export interface NormalizedLspSettings {
  enabled: boolean;
  timeoutMs: number;
  maxDiagnostics: number;
  format: boolean;
  baseline: boolean;
  includeWarnings: boolean;
}

export const LSP_DEFAULTS = {
  timeoutMs: 2000,
  maxDiagnostics: 20,
  format: true,
  /** 诊断块渲染总字符预算(M108):超出截断并注明。 */
  maxRenderChars: 4096,
  /** 超过该大小的文件跳过格式化+诊断(预算保护)。 */
  maxFileBytes: 512 * 1024,
} as const;

/**
 * 低层缺省:未提供 settings = 关闭。
 * 提供的对象按字段补缺省(enabled 仅在显式 false 时关闭)。
 */
export function resolveLspSettings(input?: LspSettings): NormalizedLspSettings {
  if (!input) {
    return {
      enabled: false,
      timeoutMs: LSP_DEFAULTS.timeoutMs,
      maxDiagnostics: LSP_DEFAULTS.maxDiagnostics,
      format: LSP_DEFAULTS.format,
      baseline: true,
      includeWarnings: false,
    };
  }
  return {
    enabled: input.enabled !== false,
    timeoutMs: clampInt(input.timeoutMs, 100, 30_000, LSP_DEFAULTS.timeoutMs),
    maxDiagnostics: clampInt(input.maxDiagnostics, 1, 200, LSP_DEFAULTS.maxDiagnostics),
    format: input.format !== false,
    baseline: input.baseline !== false,
    includeWarnings: input.includeWarnings === true,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 一次编辑后检查的结果。 */
export interface EditCheckResult {
  /** 是否应用了格式化并写回磁盘。 */
  formatted: boolean;
  /** 写后真实诊断(未经 baseline 对消/渲染过滤)。 */
  diagnostics: DiagnosticItem[];
  /** delta 结果:去掉写前 baseline 命中的部分(=只报新增;baseline 未启用=同 diagnostics)。 */
  newDiagnostics: DiagnosticItem[];
  /** 渲染后的 <diagnostics> 块;无错误时为 null。 */
  rendered: string | null;
  /** baseline 状态:ok=已对消 / unavailable=采集失败(渲染块带 note)/ off=未启用 delta。 */
  baseline: "ok" | "unavailable" | "off";
  /** 实际产出诊断的检查器;none=未运行/不可用。 */
  checker: "lsp" | "tsc" | "none";
  /** 本次检查耗时(含格式化+诊断)。 */
  elapsedMs: number;
}

/** 检查输入。 */
export interface EditCheckInput {
  /** 项目根(围栏根;用于 LSP rootUri / 最近 tsconfig 搜索边界)。 */
  root: string;
  /** 被编辑文件的绝对路径。 */
  absPath: string;
  /** 覆盖内容(缺省读磁盘;调用方刚写盘时读盘即最新)。 */
  content?: string;
  /** coding.lsp 配置;缺省=关闭(低层语义)。 */
  settings?: LspSettings;
  /**
   * 写前 baseline 诊断(M108):由 collectBaselineDiagnostics 在**落盘前**采集。
   * - undefined = 不做 delta(全量报告写后诊断,旧行为);
   * - null = 采集失败(渲染块带 note="baseline 不可用,仅报当前 ERROR",仍只报 ERROR);
   * - 数组 = 对消(空数组=新文件基线为空)。
   */
  baseline?: DiagnosticItem[] | null;
  /** 写前旧内容(行位移对消用;缺省=按行号原样比对)。 */
  baselineText?: string;
}

/** 写前 baseline 采集输入(M108)。 */
export interface BaselineCheckInput {
  root: string;
  absPath: string;
  /** 写前旧内容;"" = 新文件/空文件(基线为空,不探测);缺省=读磁盘。 */
  text?: string;
  settings?: LspSettings;
}

/** 渲染选项(M108)。 */
export interface RenderDiagnosticsOptions {
  /** 是否连 warning 一起回灌(缺省 false:只报 ERROR)。 */
  includeWarnings?: boolean;
  /** 附加在 <diagnostics> 上的提示(baseline 不可用等);属性值会被转义。 */
  note?: string;
}
