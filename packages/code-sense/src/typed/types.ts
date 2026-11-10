/**
 * typed/types(step-089 P1 / designs/26 §2.1):变量类型识别的数据契约。
 * 单一 kind 词表(对齐 LSP SemanticTokenTypes 的诚实子集)+ 声明时类型文本(dataType)。
 * tier×evidence 双诚实轴沿用 designs/16:structural/ast=语法级确证,lexical/grep=词法级。
 */

export type TypedLang = "c" | "cpp" | "python" | "typescript" | "go" | "java";

/** token/符号 kind(semantic-token 与 vars 共用一张词表)。 */
export type TypedKind =
  | "function"
  | "method"
  | "class"
  | "struct"
  | "enum"
  | "interface"
  | "variable"
  | "property"
  | "enumMember"
  | "type"
  // F/G 批(2026-10-22):函数内 kind——默认 vars 面不入(VAR_KINDS 不含),--locals 扩入。
  | "param" // Python def 形参(带注解)
  | "parameter" // TS/JS 形参(带类型注解)
  | "local"; // 函数体内注解局部变量(Python/TS 同名)

/** 变量类 kind(带 dataType 的集合——vars 命令的口径)。 */
export const VAR_KINDS: ReadonlySet<TypedKind> = new Set<TypedKind>(["variable", "property", "enumMember", "type"]);

/** 函数内 kind(--locals 面专用):形参(param=Python/parameter=TS)+注解局部(local)。
 * 刻意不入 VAR_KINDS——默认 vars 清单只模块/类级(行为不变),varsOf(symbols,{locals:true})
 * 才扩入;且局部只收 structural(推断型局部不入,lexical 如实挡在门外)。 */
export const LOCAL_KINDS: ReadonlySet<TypedKind> = new Set<TypedKind>(["param", "local", "parameter"]);

export interface TypedSymbol {
  name: string;
  kind: TypedKind;
  /** 声明时类型文本(归一化空白,截 120)。variable/property/enumMember/type 专用。 */
  dataType?: string;
  file: string;
  line: number;
  /** 名字标识符 span(character=0-based 列;行号用外层 line,1-based)。 */
  span?: { character: number; length: number };
  container?: string;
  tier: "structural" | "lexical";
}

export interface TypedFileResult {
  file: string;
  language: TypedLang | undefined;
  symbols: TypedSymbol[];
  /** 支持语言之外的扩展名/解析不可用=显式降级,不静默。 */
  degraded?: { reason: string };
}

/** 读取失败降级理由(step-101):fs 错误的完整路径不截断——旧 `slice(0,80)` 把 ENOENT 完整路径
 * 拦腰斩断(实测呈现「open '/home/…/bench)」半截路径,读起来像「参数被截断」误诊,step-092 踩坑③)。
 * ≤300 字符全量保留;超长中段截断但保尾部(fs 错误消息的路径恒在尾:`…, open '<path>'`)。 */
export function readFailReason(err: unknown): string {
  const full = String(err);
  if (full.length <= 300) return full;
  return full.slice(0, 160) + " … " + full.slice(-130);
}

/** semantic-token 流导出格式(designs/26 §2.1 定稿;消费者=未来 UI 语义着色/外部编辑器集成)。 */
export interface SemanticTokenFile {
  version: 1;
  file: string;
  language: TypedLang;
  generatedAt: number;
  tokens: {
    line: number;
    character: number;
    length: number;
    kind: TypedKind;
    name: string;
    dataType?: string;
    tier?: "structural" | "lexical";
  }[];
}

export function extToLang(name: string): TypedLang | undefined {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (ext === ".c") return "c";
  if (ext === ".cc" || ext === ".cpp" || ext === ".cxx" || ext === ".hh" || ext === ".hpp" || ext === ".hxx") return "cpp";
  if (ext === ".h") return "c"; // .h 双语法兜底在 cpp 深提取器内处理
  if (ext === ".py") return "python";
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "typescript";
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  return undefined;
}
