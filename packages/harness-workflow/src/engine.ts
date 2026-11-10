/**
 * Workflow 引擎(ZCode dynamic-workflow 编排本体思想 TS 重写,Apache-2.0):
 * 模型写 TS 脚本编排子 agent;vm 沙箱+facade;journal-first(resume=replay);
 * 失败保留已 report 成果;world.run 确定性白名单。
 */
import vm from "node:vm";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve as pathResolve } from "node:path";
import { z } from "zod";
import type { Journal } from "@lampgenie/core";
import type { SubagentBackend } from "@lampgenie/executors";

const execFileP = promisify(execFile);

/** esbuild 必须外置(/L-124 同族):静态 import 会被 gateway 的 esbuild bundle 内联,
 * 内联后 esbuild 自身的 CJS __filename/__dirname 在 ESM bundle 中未定义,首次 transform() 即抛
 * 「The esbuild JavaScript API cannot be bundled」/「__filename is not defined」(验证:
 * 生产环境 dist/gateway.mjs 下 run_workflow 任何脚本必失败,含最小单行脚本)。
 * 修法同 harness-lsp/typescript.ts 的 loadTs():createRequire + 变量调用 → bundler 无法静态解析,
 * 保持外部依赖,运行时按 bundle 所在目录解析到 node_modules/esbuild。
 * ⚠ 两处是独立副本(跨包无共享 helper),改 esbuild 加载方式时须两处人工同步。 */
type TransformFn = typeof import("esbuild").transform;
let transformFn: TransformFn | undefined;
/** 惰性解析:createRequire 也在函数体内(模块加载期零新增失败面,解析失败只在首次 run 暴露);
 * 解析失败与「用户脚本语法错误」分开报错——见 run 的 catch(isLoaderError)。 */
function loadTransform(): TransformFn {
  if (!transformFn) {
    const requireFromHere = createRequire(import.meta.url);
    const mod = requireFromHere("esbuild") as { transform?: unknown };
    // 形状校验:模块形状不符(被桩化/互操作差异)也归「加载失败」,不落回「语法错误」误导排障
    if (typeof mod.transform !== "function") throw new Error("Cannot find module 'esbuild'(加载到的模块不含 transform)");
    transformFn = mod.transform as TransformFn;
  }
  return transformFn;
}

/** 依赖/部署问题(模块解析不到、bundle 内联、版本不匹配)与用户脚本语法错误分开报,避免误导排障。
 * 只取首行判定:esbuild 的**语法错误**信息会回显出错源码行,若用户脚本里恰好含
 * 「Cannot find module」等字样,全文匹配会误判;加载类错误均为单行首句。 */
export function isLoaderError(err: unknown): boolean {
  const head = String(err).split("\n", 1)[0] ?? "";
  return /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|The esbuild JavaScript API cannot be bundled|__filename is not defined|another platform|Cannot start service/.test(head);
}

/** run() 的 catch 用此前缀分类(单独导出=可断言映射本身,不只断言正则)。 */
export function runErrorPrefix(err: unknown): string {
  return isLoaderError(err) ? "esbuild 加载失败" : "语法错误";
}

export interface WorkflowReportItem {
  actor?: string;
  [k: string]: unknown;
}
export interface WorkflowResult {
  ok: boolean;
  items: WorkflowReportItem[];
  logs: string[];
  partial: boolean;
  error?: string;
  durationMs: number;
}

export interface WorkflowWorld {
  run(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  read(path: string): Promise<string>;
  glob(pattern: string): Promise<string[]>;
}

/** 白名单命令( §2.3:确定性世界读取)。
 * 分解校验:命令按 &&; | 拆段,每段独立过白名单——防「pnpm test && curl evil」类拼接注入。 */
const SEGMENT_ALLOW = /^(npx\s+(vitest|tsx|tsc|playwright)\b|pnpm\s+([\w@/.=-]+\s+)*(test|run|exec)\b|npm\s+([\w@/.=-]+\s+)*(test|run)\b|node\s|git\s+(status|log|diff|show)\b|tail\b|head\b|ls\b|cat\b|echo\b|true\b|rg\b|grep\b)/;

export function commandAllowed(cmd: string): boolean {
  const segments = cmd.split(/&&|;|\|\|?/).map((s) => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every((s) => SEGMENT_ALLOW.test(s));
}

export function createWorld(root: string): WorkflowWorld {
  return {
    async run(cmd, opts = {}) {
      if (!commandAllowed(cmd)) {
        throw new Error(`world.run 白名单拒绝: ${cmd.slice(0, 60)}(允许:测试运行器/node/git 只读/ls/cat/grep/tail)`);
      }
      const timeoutMs = opts.timeoutMs ?? 120_000;
      try {
        const { stdout, stderr } = await execFileP("sh", ["-c", cmd], {
          cwd: pathResolve(root, opts.cwd ?? "."),
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { code: 0, stdout: stdout.toString().slice(0, 200_000), stderr: stderr.toString().slice(0, 50_000) };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
        return {
          code: e.killed ? 124 : (e.code ?? 1),
          stdout: (e.stdout ?? "").toString().slice(0, 200_000),
          stderr: (e.stderr ?? "").toString().slice(0, 50_000) + (e.killed ? "\n[超时被杀]" : ""),
        };
      }
    },
    async read(path) {
      const abs = pathResolve(root, path);
      if (!abs.startsWith(pathResolve(root))) throw new Error(`world.read 越界: ${path}`);
      return readFile(abs, "utf-8").then((t) => t.slice(0, 500_000));
    },
    async glob(pattern) {
      // 轻量 glob:递归枚举+尾部模式匹配
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "ref") continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else out.push(full.slice(root.length + 1));
        }
      };
      await walk(root);
      const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, "⟦⟧").replace(/\*/g, "[^/]*").replace(/⟦⟧/g, ".*") + "$");
      return out.filter((f) => re.test(f));
    },
  };
}

export interface AgentHandle {
  ask<T = unknown>(instructions: string, opts?: { schema?: z.ZodType<T> }): Promise<T>;
}

export interface WorkflowEngineOptions {
  root: string;
  journal: Journal;
  workflowId: string;
  executor: SubagentBackend;
  /** 派发实现(缺省走 executor;测试可注入)。 */
  dispatch?: (instructions: string) => Promise<string>;
  /** 脚本可用的预注册 zod schema(vm 沙箱内无 import,schema 由外部注入)。 */
  schemas?: Record<string, z.ZodType>;
 /** 工作流板:log 流式回调(脚本内 log/console.log 每条实时上抛;缺省=只入 this.logs 终值)。
   * 加性可选——board-workflow runner 用它解析节点状态标记(WFN|id|state|detail),面板实时高亮。 */
  onLog?: (msg: string) => void;
}

export class WorkflowEngine {
  private opts: WorkflowEngineOptions;
  private items: WorkflowReportItem[] = [];
  private logs: string[] = [];
  /** 超时/失败时通知 dispatch 链停止(L-092)。 */
  private abort?: AbortController;
  private worldBridge = createWorld("."); // run 时按 root 重建
  /** ask 缓存身份:(actor, seq, inputHash) → result(ZCode 命名复用的基础)。 */
  private cache = new Map<string, unknown>();
  private seqByActor = new Map<string, number>();

  constructor(opts: WorkflowEngineOptions) {
    this.opts = opts;
    // resume:重放 journal 里已有 ask 结果
    for (const e of opts.journal.readAll()) {
      if (e.kind !== "workflow.ask" || e.sessionId !== opts.workflowId) continue;
      const p = e.payload as { cacheKey?: string; result?: unknown };
      if (p.cacheKey && p.result !== undefined) this.cache.set(p.cacheKey, p.result);
    }
  }

  private dispatch: (instructions: string) => Promise<string> = async (instructions) => {
    if (this.opts.dispatch) return this.opts.dispatch(instructions);
    // 真实 executor:spawn 等 result
    return new Promise((resolve, reject) => {
      void this.opts.executor
        .spawn({ taskId: `wf-${this.opts.workflowId}`, instructions, workdir: this.opts.root, permissions: "sandbox" }, (e) => {
          if (e.type === "result") {
            if (e.result.ok) resolve(e.result.finalText ?? "");
            else reject(new Error(e.result.error?.detail ?? e.result.error?.kind ?? "agent 失败"));
          }
        })
        .catch(reject);
    });
  };

  agent(name = "worker"): AgentHandle {
    return {
      ask: async <T>(instructions: string, opts?: { schema?: z.ZodType<T> }): Promise<T> => {
        const seq = (this.seqByActor.get(name) ?? 0) + 1;
        this.seqByActor.set(name, seq);
        const inputHash = createHash("sha256").update(instructions).digest("hex").slice(0, 12);
        const cacheKey = `${name}:${seq}:${inputHash}`;
        // journal-first:先落盘再派发
        if (!this.cache.has(cacheKey)) {
          this.opts.journal.append({
            kind: "workflow.ask", sessionId: this.opts.workflowId,
            payload: { actor: name, seq, inputHash, cacheKey, instructions: instructions.slice(0, 2000) },
          });
          const raw = await this.dispatch(instructions);
          let result: unknown = raw;
          if (opts?.schema) {
            let parsed: unknown | undefined;
            let lastErr = "";
            for (let attempt = 0; attempt < 2 && parsed === undefined; attempt++) {
              const attemptRaw = attempt === 0
                ? raw
                : await this.dispatch(instructions + "\n\n(上一版输出无法通过 schema 校验,严格只输出合法 JSON)");
              try { parsed = opts.schema.parse(JSON.parse(stripJson(attemptRaw))); }
              catch (err) { lastErr = String(err).slice(0, 120); }
            }
            if (parsed === undefined) {
              this.opts.journal.append({
                kind: "workflow.ask", sessionId: this.opts.workflowId,
                payload: { cacheKey, schemaError: lastErr },
              });
              throw new Error(`ask 输出 schema 校验失败: ${lastErr}`);
            }
            result = parsed;
          }
          this.cache.set(cacheKey, result);
          this.opts.journal.append({
            kind: "workflow.ask", sessionId: this.opts.workflowId,
            payload: { cacheKey, result: safeSerialize(result) },
          });
        } else {
          this.logs.push(`[resume] ${name}#${seq} 缓存命中`);
        }
        return this.cache.get(cacheKey) as T;
      },
    };
  }

  report(item: WorkflowReportItem): void {
    this.items.push(item);
  }

  log(msg: string): void {
    const s = String(msg).slice(0, 300);
    this.logs.push(s);
 // 流式回调(异常吞掉——观测面故障不能打断脚本执行)
    if (this.opts.onLog) { try { this.opts.onLog(s); } catch { /* 忽略 */ } }
  }

  /** 执行脚本(沙箱+禁令+esbuild 语法校验)。
   * 沙箱定位(R4 修正):「防误用」而非「防逃逸」——宿主函数在 vm 内包装,
   * constructor 链断在 vm Realm(L-091);AbortController 贯穿 dispatch(超时真终止,L-092)。 */
  async run(source: string, timeoutMs = 600_000): Promise<WorkflowResult> {
    const t0 = Date.now();
    this.abort = new AbortController();
    // 静态禁令(二次兜底:vm 本身拿不到 require/process)
    if (/\brequire\s*\(|\bprocess\.|\bimport\s*\(/.test(source)) {
      return { ok: false, items: this.items, logs: this.logs, partial: true, error: "静态禁令:脚本不得使用 require/process/import(只可用注入的 facade)", durationMs: Date.now() - t0 };
    }
    let code: string;
    try {
      const transformed = await loadTransform()(source, { loader: "ts", format: "esm", target: "es2022" });
      code = transformed.code;
    } catch (err) {
      // 加载器/部署问题(esbuild 解析不到、bundle 内联)不与用户脚本语法错误混报
      return { ok: false, items: this.items, logs: this.logs, partial: true, error: `${runErrorPrefix(err)}: ${String(err).slice(0, 300)}`, durationMs: Date.now() - t0 };
    }
    this.worldBridge = createWorld(this.opts.root);
    const ctx = vm.createContext({}); // 空 context:全部对象经 vm 内创建/包装
    // vm 内桥:宿主值经 wrapFn 包装——包装函数的 constructor 属 vm Realm,跨域逃逸链断
    const hostFns = {
      __agent: (name: string | undefined) => this.agent(name ?? "worker"),
      __worldRun: (cmd: string, opts: unknown) => this.worldBridge.run(cmd, opts as { cwd?: string; timeoutMs?: number } | undefined),
      __worldRead: (path: string) => this.worldBridge.read(path),
      __worldGlob: (pattern: string) => this.worldBridge.glob(pattern),
      __report: (i: WorkflowReportItem) => this.report(i),
      __log: (m: string) => this.log(m),
      __now: () => Date.now(),
      __signalAborted: () => this.abort?.signal.aborted ?? false,
    };
    const bootstrap = `
      const wrapFn = (hostFn) => (...args) => hostFn(...args);
      const wrapObj = (obj, methods) => {
        const out = {};
        for (const m of methods) out[m] = wrapFn(obj[m]);
        return out;
      };
      const __host = ${JSON.stringify(Object.keys(hostFns))} ;
      globalThis.schemas = undefined; // 占位,下方赋值
    `;
    vm.runInContext(bootstrap, ctx);
    // 注入宿主函数(经 vm 内 wrapFn 再包装)
    const inner = vm.runInContext("({ wrapFn, wrapObj })", ctx) as {
      wrapFn: <A extends unknown[]>(fn: (...args: A) => unknown) => (...args: A) => unknown;
      wrapObj: <T extends object>(o: T, m: (keyof T)[]) => T;
    };
    const worldApi = inner.wrapObj(
      { run: hostFns.__worldRun, read: hostFns.__worldRead, glob: hostFns.__worldGlob },
      ["run", "read", "glob"],
    );
    const sandboxApi = {
      schemas: this.opts.schemas ?? {},
      agent: (name?: string) => hostFns.__agent(name),
      world: worldApi,
      report: inner.wrapFn(hostFns.__report),
      log: inner.wrapFn(hostFns.__log),
      now: inner.wrapFn(hostFns.__now),
      aborted: inner.wrapFn(hostFns.__signalAborted),
      console: { log: inner.wrapFn(hostFns.__log) },
      Promise, Math: { ...Math, random: () => 0.5 }, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Error, Date,
    };
    vm.runInContext(`globalThis.agent = undefined`, ctx); // 清 bootstrap 残留
    for (const [k, v] of Object.entries(sandboxApi)) {
      (ctx as unknown as Record<string, unknown>)[k] = v;
    }
    // 超时定时器:clear+unref(L-092)
    let timeoutTimer: NodeJS.Timeout | undefined;
    try {
      const wrapped = `(async () => { ${code}\n})()`;
      await Promise.race([
        vm.runInContext(wrapped, ctx, { timeout: timeoutMs }),
        new Promise((_, rej) => {
          timeoutTimer = setTimeout(() => rej(new Error("workflow 超时")), timeoutMs);
          timeoutTimer.unref?.();
        }),
      ]);
      return { ok: true, items: this.items, logs: this.logs, partial: false, durationMs: Date.now() - t0 };
    } catch (err) {
      // 失败保留已 report 成果(ZCode 纪律);abort 通知 dispatch 链停止(L-092)
      this.abort.abort();
      return { ok: false, items: this.items, logs: this.logs, partial: this.items.length > 0, error: String(err).slice(0, 400), durationMs: Date.now() - t0 };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }
}

function stripJson(raw: string): string {
  const m = /```json\s*([\s\S]*?)\s*```/.exec(raw.trim());
  return (m?.[1] ?? raw).trim();
}
function safeSerialize(v: unknown): unknown {
  try { JSON.stringify(v); return v; } catch { return String(v); }
}
