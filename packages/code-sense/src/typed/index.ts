/**
 * typed/index( P1 / §2):变量类型识别编排面。
 * - extractTypedSymbols(root, file):按扩展名分派到语言深提取器(逐文件,毫秒~亚秒级,
 *   不依赖/不触发索引构建——api/state/algo 先例);
 * - varsOf / groupByDataType:类型分组变量清单(`codesense vars` 数据源);
 * - toSemanticTokens:semantic-token JSON 流导出(未来 UI 语义着色/外部编辑器集成供数据;
 *   面板着色渲染不在本任务,panel.ts 并发作业禁碰——登记后续 UI 轮)。
 */
import { extToLang, LOCAL_KINDS, VAR_KINDS, type SemanticTokenFile, type TypedFileResult, type TypedKind, type TypedLang, type TypedSymbol } from "./types";

export * from "./types";

export async function extractTypedSymbols(root: string, relFile: string): Promise<TypedFileResult> {
  const lang = extToLang(relFile);
  if (!lang) {
    return { file: relFile, language: undefined, symbols: [], degraded: { reason: `不支持的扩展名(typed 档支持 c/cpp/python/typescript/go/java;${extOf(relFile) || "无扩展名"} 未收录,如实不猜)` } };
  }
  const mod = await import(
    lang === "c" || lang === "cpp" ? "./cpp"
      : lang === "python" ? "./python"
        : lang === "typescript" ? "./ts"
          : lang === "go" ? "./go"
            : "./java"
  );
  const fnName = lang === "c" || lang === "cpp" ? "extractCppTyped" : `extract${cap(lang)}Typed`;
  const fn = (mod as Record<string, unknown>)[fnName] as (root: string, f: string) => Promise<TypedFileResult>;
  return fn(root, relFile);
}

function cap(s: string): string {
  return s === "typescript" ? "Ts" : s.charAt(0).toUpperCase() + s.slice(1);
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i);
}

/** 变量子集(variable/property/enumMember/type——带 dataType 的 kind 集合)。
 * opts.locals=true 时扩入函数内注解面(param/parameter/local;F 批 --locals)——
 * 且 local/param 恒 structural(推断型局部不入:提取层就不产,tier 门槛双保险)。 */
export function varsOf(symbols: TypedSymbol[], opts?: { locals?: boolean }): TypedSymbol[] {
  const kinds: ReadonlySet<TypedKind> = opts?.locals ? LOCAL_KINDS : VAR_KINDS;
  return symbols.filter((s) => kinds.has(s.kind) && !!s.dataType && (!opts?.locals || s.tier === "structural"));
}

/** 按声明类型分组(vars 命令的「类型分组变量清单」口径;组序=数量降序,组内按行号)。 */
export function groupByDataType(symbols: TypedSymbol[], opts?: { locals?: boolean }): { dataType: string; vars: TypedSymbol[] }[] {
  const groups = new Map<string, TypedSymbol[]>();
  for (const v of varsOf(symbols, opts)) {
    const key = v.dataType!;
    const list = groups.get(key) ?? [];
    list.push(v);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([dataType, vars]) => ({ dataType, vars: vars.sort((a, b) => a.line - b.line) }))
    .sort((a, b) => b.vars.length - a.vars.length || a.dataType.localeCompare(b.dataType));
}

/** semantic-token 流导出(全部符号,不只变量——着色需要函数/类型一并供位)。 */
export function toSemanticTokens(r: TypedFileResult, now = Date.now()): SemanticTokenFile | undefined {
  if (!r.language) return undefined;
  return {
    version: 1,
    file: r.file,
    language: r.language,
    generatedAt: now,
    tokens: r.symbols
      .filter((s) => s.span)
      .map((s) => ({
        line: s.line,
        character: s.span!.character,
        length: s.span!.length,
        kind: s.kind,
        name: s.name,
        ...(s.dataType ? { dataType: s.dataType } : {}),
        ...(s.tier !== "structural" ? { tier: s.tier } : {}),
      })),
  };
}

/** vars 的人读渲染(类型分组;tier=lexical 的推断条目如实标注)。
 * opts.locals=true(--locals)时扩入函数内注解面(param/parameter/local),标题如实标注口径。 */
export function renderVars(r: TypedFileResult, opts?: { locals?: boolean }): string {
  if (r.degraded && r.symbols.length === 0) {
    return `${r.file}: 无 typed 符号(${r.degraded.reason})`;
  }
  const vars = varsOf(r.symbols, opts);
  const groups = groupByDataType(r.symbols, opts);
  const head = `${r.file}(${langLabel(r.language)};变量 ${vars.length} 个 / 类型 ${groups.length} 组${opts?.locals ? ";口径=模块/类级+函数内注解(param/local)" : ""}${r.degraded ? ";⚠️ " + r.degraded.reason : ""})`;
  const lines = groups.map((g) => {
    const items = g.vars
      .map((v) => `${v.container ? v.container + "." : ""}${v.name}@${v.line}${v.tier === "lexical" ? "(推断)" : ""}`)
      .join(", ");
    return `  ${g.dataType} (${g.vars.length}): ${items}`;
  });
  const localsShown = opts?.locals
    ? r.symbols.filter((s) => LOCAL_KINDS.has(s.kind)).length
    : 0;
  const others = r.symbols.filter((s) => !(opts?.locals ? LOCAL_KINDS : VAR_KINDS).has(s.kind));
  const tail = others.length > 0
    ? [`  (另有函数/方法/类型 ${others.length} 个——tokens 导出面含,vars 清单不含)`]
    : [];
  return [head, ...lines, ...tail, ...(opts?.locals ? [`  (--locals:${localsShown} 个函数内注解条目——param/local)`] : [])].join("\n");
}

function langLabel(l: TypedLang | undefined): string {
  return l === "c" ? "C/C++" : l === "python" ? "Python" : l === "typescript" ? "TS/JS" : l === "go" ? "Go" : l === "java" ? "Java" : "未知";
}

export type { SemanticTokenFile, TypedFileResult, TypedKind, TypedLang, TypedSymbol };
