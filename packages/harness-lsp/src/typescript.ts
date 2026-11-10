/**
 * TypeScript 诊断兜底(step-114):本机没有 typescript-language-server 时,用仓内 `typescript`
 * 编译器 API 做**单文件快速检查**(类型错/语法错)。
 *
 * 为什么不是 tsserver / ts.createProgram(全解析):
 * - ts.createProgram 解析完整项目:仓内 500 行文件实测 7.7s;
 * - tsserver 在 /mnt/e(WSL 9p 盘)打开仓内文件实测 **>15s**(项目/import 解析),直接超预算;
 * - 本实现 `noResolve` + 显式 lib + 全局 shim:实测 1.0-1.5s(冷/热同量级),在 2s 预算内。
 *
 * 诚实边界(不假装等价 LSP):
 * - 不解析 import(模块按 any 处理)→ **跨文件类型错误不会在此兜底中暴露**;
 * - 本地类型错(如 `const n: number = "x"`)与未定义名、语法错照常检出;
 * - 安装了 typescript-language-server 时优先走 LSP,该兜底不启用。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DiagnosticItem } from "./types.js";

type TsModule = typeof import("typescript");

/**
 * 运行时 require(不走静态 import):gateway 用 esbuild 打包,静态 import("typescript") 会把
 * 9MB 编译器打进 gateway bundle;经 createRequire 的变量调用 esbuild 无法静态解析,保持外部依赖。
 */
const requireFromHere = createRequire(import.meta.url);

const SHIM_PATH = "/__genie_lsp_shim__.d.ts";
const SHIM_TEXT = `
declare const console: any;
declare const process: any;
declare const Buffer: any;
declare type Buffer = any;
declare const require: any;
declare const module: any;
declare const exports: any;
declare const global: any;
declare const __dirname: string;
declare const __filename: string;
declare function setTimeout(...args: any[]): any;
declare function clearTimeout(...args: any[]): any;
declare function setInterval(...args: any[]): any;
declare function clearInterval(...args: any[]): any;
declare function fetch(...args: any[]): Promise<any>;
declare const AbortSignal: any;
declare type AbortSignal = any;
declare const AbortController: any;
declare type AbortController = any;
declare namespace NodeJS {
  type Timeout = any;
  type Timer = any;
  type ProcessEnv = Record<string, string | undefined>;
}
`;

/** 无解析模式下的「模块找不到」类噪声(跨文件类型本就按 any,不重复报)。 */
const IGNORED_CODES = new Set([2307, 2792, 7016, 2688, 6053]);

let tsModule: Promise<TsModule | null> | undefined;
let cachedShim: import("typescript").SourceFile | undefined;
let cachedLibPath: string | undefined;
let cachedLib: import("typescript").SourceFile | undefined;
let cachedHost: import("typescript").CompilerHost | undefined;
let cachedHostKey = "";

function loadTs(): Promise<TsModule | null> {
  tsModule ??= Promise.resolve().then(() => {
    try { return requireFromHere("typescript") as TsModule; } catch { return null; }
  });
  return tsModule;
}

function nearestTsConfig(fromFile: string): string | null {
  let dir = dirname(fromFile);
  for (;;) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 返回本文件的 TS 诊断;null=检查器不可用(typescript 包缺失/解析异常)。
 * 空数组=检查成功且无错——调用方据此区分「没检查」和「检查通过」。
 */
export async function typescriptDiagnostics(absPath: string, _root: string, _timeoutMs: number): Promise<DiagnosticItem[] | null> {
  const ts = await loadTs();
  if (!ts) return null;
  try {
    const file = resolve(absPath);
    const options = buildOptions(ts, file);
    const host = hostFor(ts, options);
    const libPath = ts.getDefaultLibFilePath(options);
    const program = ts.createProgram({ rootNames: [file, SHIM_PATH, libPath], options, host });
    const target = normalize(file);
    const out: DiagnosticItem[] = [];
    for (const d of ts.getPreEmitDiagnostics(program)) {
      if (!d.file || normalize(resolve(d.file.fileName)) !== target) continue;
      if (IGNORED_CODES.has(d.code)) continue;
      if (d.category !== ts.DiagnosticCategory.Error && d.category !== ts.DiagnosticCategory.Warning) continue;
      const pos = typeof d.start === "number" ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
      out.push({
        line: pos.line + 1,
        column: pos.character + 1,
        severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
        code: `TS${d.code}`,
        message: ts.flattenDiagnosticMessageText(d.messageText, " ").replace(/\s+/g, " ").trim(),
        source: "typescript",
      });
      if (out.length >= 200) break;
    }
    return dedupe(out);
  } catch {
    return null;
  }
}

function buildOptions(ts: TsModule, file: string): import("typescript").CompilerOptions {
  const options: import("typescript").CompilerOptions = {
    noResolve: true,
    types: [],
    lib: ["ES2022"],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    // noResolve 下 import 一律 any:strict 的 implicit-any 会把「本可推断」的参数全变假错。
    noImplicitAny: false,
    skipLibCheck: true,
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
  };
  // 项目 tsconfig 只取「语法相关」开关(jsx/decorators/class fields);模块解析不参与(noResolve)。
  const configPath = nearestTsConfig(file);
  if (configPath) {
    try {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(configPath));
      const o = parsed.options;
      if (o.jsx !== undefined) options.jsx = o.jsx;
      if (o.experimentalDecorators !== undefined) options.experimentalDecorators = o.experimentalDecorators;
      if (o.emitDecoratorMetadata !== undefined) options.emitDecoratorMetadata = o.emitDecoratorMetadata;
      if (o.useDefineForClassFields !== undefined) options.useDefineForClassFields = o.useDefineForClassFields;
      if (o.target !== undefined) options.target = o.target;
    } catch { /* 坏 tsconfig=保持缺省 */ }
  }
  return options;
}

/** 缓存 lib/shim SourceFile(逐次 createProgram 不再重复读 ~1MB lib)。 */
function hostFor(ts: TsModule, options: import("typescript").CompilerOptions): import("typescript").CompilerHost {
  const libPath = ts.getDefaultLibFilePath(options);
  const key = `${libPath}|${options.target}|${options.jsx}|${options.experimentalDecorators ?? false}`;
  if (cachedHost && cachedHostKey === key) return cachedHost;
  cachedHostKey = key;
  cachedLibPath = libPath;
  cachedLib = undefined;
  const host = ts.createCompilerHost(options);
  const origGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, onError, shouldCreate) => {
    if (name === SHIM_PATH) return (cachedShim ??= ts.createSourceFile(name, SHIM_TEXT, lang, true));
    if (name === cachedLibPath) return (cachedLib ??= origGet(name, lang, onError, shouldCreate));
    return origGet(name, lang, onError, shouldCreate);
  };
  const origExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === SHIM_PATH || origExists(name);
  const origRead = host.readFile.bind(host);
  host.readFile = (name) => (name === SHIM_PATH ? SHIM_TEXT : origRead(name));
  cachedHost = host;
  return host;
}

function normalize(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function dedupe(items: DiagnosticItem[]): DiagnosticItem[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .filter((d) => {
      const key = `${d.line}:${d.column}:${d.code ?? ""}:${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** 供调用方:路径是否属于 TS 可检查面(JS 不跑兜底)。 */
export function isTypeScriptFile(absPath: string): boolean {
  return /\.(ts|tsx|mts|cts)$/i.test(absPath);
}

/** 预热:提前加载 typescript 模块(0.5-0.7s),把首条编辑的冷启动移出工具等待。 */
export function warmTypeScriptChecker(): void {
  void loadTs();
}

/** 测试用:清模块/宿主缓存。 */
export function resetTypescriptModuleCache(): void {
  tsModule = undefined;
  cachedShim = undefined;
  cachedLib = undefined;
  cachedLibPath = undefined;
  cachedHost = undefined;
  cachedHostKey = "";
}
