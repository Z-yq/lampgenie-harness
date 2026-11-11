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
import type { Journal, EventKind } from "@lampgenie/core";
import type { SubagentBackend } from "@lampgenie/executors";
import {
  clampRunConcurrency,
  deriveWorkflowConcurrencyCeiling,
} from "@lampgenie/runtime/concurrency/ceiling";
import { RunGuard, WorkflowRunError, isFatalWorkflowError, settleOrder } from "./run-guard";

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

/** fatal 错误码提取:非 WorkflowRunError 但有 code 的错误也按其 code 归类,无 code 归 FATAL。 */
function guardErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : "FATAL";
}

/** 护栏等待在飞派发落定的时间盒:超时只统计 pending,绝不让 run 卡死。 */
const GUARD_SETTLE_TIMEOUT_MS = 5_000;

/** run() 的 catch 用此前缀分类(单独导出=可断言映射本身,不只断言正则)。 */
export function runErrorPrefix(err: unknown): string {
  return isLoaderError(err) ? "esbuild 加载失败" : "语法错误";
}

export interface WorkflowReportItem {
  actor?: string;
  [k: string]: unknown;
}

/** 运行期 caps:一次 workflow 运行的可调参数面。
 * 为什么只有 maxConcurrency / subagentModel 能热调整:这两个只影响「之后新开的派发」,
 * 改它们不会让已派发的子 agent 半途换语义;脚本本体/沙箱策略一旦运行就不可热改,
 * 否则 replay 会产出与首次不同的结果,把 journal-first 的确定性打穿。 */
export interface WorkflowCaps {
 /** 并发上限(1..32);派发方按它节流。 */
  maxConcurrency?: number;
 /** 子代理模型名(非空 ≤128);派发方按它选模型。 */
  subagentModel?: string;
 /** 引擎维护:最近一次 amend 的时间(工具可观测,不接受外部 amend)。 */
  amendedAt?: number;
 /** 引擎维护:累计 amend 次数(同上)。 */
  amendCount?: number;
}
/** amend 只接受白名单字段,落地的 patch 就是这两个字段的子集。 */
export type CapsPatch = Pick<WorkflowCaps, "maxConcurrency" | "subagentModel">;
export interface CapsAmendResult {
  ok: boolean;
  code: "APPLIED" | "INVALID_FIELD" | "INVALID_VALUE";
 /** 真正被合并进 caps 的字段(INVALID_* 时为空对象:整体失败不半应用)。 */
  applied: CapsPatch;
 /** 不在白名单里的字段名(INVALID_FIELD 时非空)。 */
  rejectedKeys: string[];
 /** 结果发生后的 caps 快照(便于调用方一次拿全,不必再调 currentCaps)。 */
  caps: WorkflowCaps;
}

/** 可 amend 字段白名单:见 WorkflowCaps 注释(新增字段必须同时评估 replay 确定性)。 */
const CAPS_AMENDABLE: readonly string[] = ["maxConcurrency", "subagentModel"];
/** 事件名尚未登记进 core 的 EventKind 联合(本任务不改 core);journal 落盘不做 kind 白名单校验,
 * 仅类型层面窄化——读回时按字符串相等判断。 */
const CAPS_KIND = "workflow.caps";
type JournalKind = EventKind;

/** 只保留已知字段并丢弃非法值:读 journal/opts 的防御面——坏字段不该让引擎起不来。 */
function sanitizeCaps(raw: unknown): WorkflowCaps | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: WorkflowCaps = {};
  if (typeof src.maxConcurrency === "number" && Number.isInteger(src.maxConcurrency) && src.maxConcurrency >= 1 && src.maxConcurrency <= 32) {
    out.maxConcurrency = src.maxConcurrency;
  }
  if (typeof src.subagentModel === "string" && src.subagentModel.trim().length > 0 && src.subagentModel.length <= 128) {
    out.subagentModel = src.subagentModel;
  }
  if (typeof src.amendedAt === "number" && Number.isFinite(src.amendedAt)) out.amendedAt = src.amendedAt;
  if (typeof src.amendCount === "number" && Number.isInteger(src.amendCount) && src.amendCount >= 0) out.amendCount = src.amendCount;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface WorkflowResult {
  ok: boolean;
  items: WorkflowReportItem[];
  logs: string[];
  partial: boolean;
  error?: string;
  durationMs: number;
 /** 生效 caps;仅在有配置时出现(零 caps 时结果对象与旧版逐字一致,不新增字段)。 */
  caps?: WorkflowCaps;
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
 /**  护栏:单 run 总派发上限(缺省 200)。超限后 ask 抛 fatal 错误,整条 run 收敛为 GUARD:TOTAL_EXCEEDED。 */
  maxTotal?: number;
 /** 初始 caps(可选)。优先级低于 journal 里最后一条 workflow.caps(resume 必须继承热调整后的值)。 */
  caps?: WorkflowCaps;
}

export class WorkflowEngine {
  private opts: WorkflowEngineOptions;
  private items: WorkflowReportItem[] = [];
  private logs: string[] = [];
  /** 超时/失败时通知 dispatch 链停止(L-092)。 */
  private abort?: AbortController;
  private worldBridge = createWorld("."); // run 时按 root 重建
 /** 缓存身份:(actor, seq, inputHash) → result(ZCode 命名复用的基础)。 */
  private cache = new Map<string, unknown>();
  private seqByActor = new Map<string, number>();
 /** 运行期 caps:可被 amend 热调整,随 journal 的 workflow.caps 事件持久化/继承。 */
  private caps: WorkflowCaps = {};
 /** 运行护栏:每 run 的并发闸 + 总派发预算 + fatal 收敛。 */
  private guard: RunGuard;
 /** 在飞派发镜像(settleOrder 用):镜像吞掉结果/错误,避免未被 await 的镜像产生 unhandled rejection。 */
  private inflight = new Set<Promise<void>>();
 /** 单 run 总派发上限(缺省 200):防止脚本在循环里无限 ask 把子代理池打爆。 */
  private readonly maxTotal: number;

  constructor(opts: WorkflowEngineOptions) {
    this.opts = opts;
 // resume 两条重放:ask 结果(缓存)+ 最后一条 caps(热调整后的运行配置)。
 // caps 必须以 journal 为准:只放内存的话,新引擎实例会退回默认值,同一 workflowId 的
 // 续跑行为和首次不一致(journal-first 的确定性就断了)。
    let journalCaps: WorkflowCaps | undefined;
    for (const e of opts.journal.readAll()) {
      if (e.sessionId !== opts.workflowId) continue;
      if (e.kind === "workflow.ask") {
        const p = e.payload as { cacheKey?: string; result?: unknown };
        if (p.cacheKey && p.result !== undefined) this.cache.set(p.cacheKey, p.result);
      } else if (String(e.kind) === CAPS_KIND) {
        const restored = sanitizeCaps((e.payload as { caps?: unknown } | undefined)?.caps);
        if (restored) journalCaps = restored; // 后写覆盖前写:最后一条是权威值
      }
    }
    this.caps = journalCaps ?? sanitizeCaps(opts.caps) ?? {};
 // :并发上限来自生效 caps(与既有缺省 8 一致);非法 maxTotal 回落到缺省而不是抛错——
 // 护栏是防御面,配置写坏不该让引擎起不来(同 sanitizeCaps 的纪律)。
    this.maxTotal = typeof opts.maxTotal === "number" && Number.isInteger(opts.maxTotal) && opts.maxTotal >= 0
      ? opts.maxTotal
      : 200;
    this.guard = this.makeGuard();
  }

 /** 按当前生效 caps 构造护栏(双界):run 界 = min(请求值, CPU 天花板)。
 * 请求值缺省仍是既有的 8(不是天花板):缺省语义是「按引擎既有并发跑」,
 * 而 CPU 天花板是硬上界——caps=32 在 14 核机上实际取 14;provider 界由 governor 管,
 * 两界取 min 的唯一口径见 ceiling.ts 的 doubleBoundConcurrency。 */
  private makeGuard(): RunGuard {
    const ceiling = deriveWorkflowConcurrencyCeiling();
    return new RunGuard({
      maxConcurrent: clampRunConcurrency(this.caps.maxConcurrency ?? 8, ceiling),
      maxTotal: this.maxTotal,
    });
  }

 /** 跟踪在飞派发:给调用方的仍是原 promise(错误语义不变),内部只留一个吞错镜像供 settleOrder 等待。 */
  private trackDispatch<T>(promise: Promise<T>): Promise<T> {
    const mirror = promise.then(() => undefined, () => undefined);
    this.inflight.add(mirror);
    void mirror.then(() => { this.inflight.delete(mirror); });
    return promise;
  }

 /** 护栏事件落 journal(观测面):core 的 EventKind 未登记 workflow.guard,用既有 "custom"
 * + payload.type 区分;构造函数只认 workflow.ask / workflow.caps,不会误入 replay。
 * 观测面故障不打断脚本(与 log 的 onLog 同一纪律)。 */
  private guardNotice(code: string): void {
    const s = this.guard.stats();
    try {
      this.opts.journal.append({
        kind: "custom" as JournalKind,
        sessionId: this.opts.workflowId,
        payload: { type: "workflow.guard", code, inFlight: s.inFlight, total: s.total },
      });
    } catch { /* 忽略 */ }
  }

 /** 当前生效 caps 的只读快照(派发/面板在 amend 之后读它拿新值;从未配置时为 {})。 */
  currentCaps(): WorkflowCaps {
    return { ...this.caps };
  }

 /** run 结果里的 caps 只在真有配置时出现:零 caps 时结果对象与旧版逐字一致,不新增字段。 */
  private capsField(): { caps?: WorkflowCaps } {
    return Object.keys(this.caps).length > 0 ? { caps: { ...this.caps } } : {};
  }

 /** 热调整 caps:只接受白名单字段,全部校验通过才落地(失败不半应用)。
 * 为什么不静默丢弃未知字段:调用方把 maxConcurrency 写成 maxParallel 之类的字段名时,
 * 静默丢弃会让 amend 回执「看起来成功」但配置完全没生效——热调整场景下这种假成功比报错危险。
 * 为什么不重启当前 run:脚本已经在 vm 里跑到一半,重启等于丢弃在飞 ask 与已 report 成果;
 * caps 只影响之后的派发,所以只更新内存值 + 追加 journal,当前 run 继续走到结束。
 * 为什么写回 journal:caps 是运行语义的一部分,resume(replay)必须能重建最后一版配置;
 * 见构造函数里从最后一条 workflow.caps 恢复的注释。 */
  amend(patch: Partial<WorkflowCaps>): CapsAmendResult {
    const input = (patch ?? {}) as Record<string, unknown>;
    const keys = Object.keys(input);
    const rejectedKeys = keys.filter((k) => !CAPS_AMENDABLE.includes(k));
 // 未知字段优先判定:键名都不对时,值合不合法没有讨论价值
    if (rejectedKeys.length > 0) {
      return { ok: false, code: "INVALID_FIELD", applied: {}, rejectedKeys, caps: this.currentCaps() };
    }
    if (keys.length === 0) {
 // 空 patch 没有可调整的字段;不能当 APPLIED(否则 amendCount/amendedAt 被无意义推进)
      return { ok: false, code: "INVALID_VALUE", applied: {}, rejectedKeys: [], caps: this.currentCaps() };
    }
    const applied: CapsPatch = {};
    for (const k of keys) {
      const v = input[k];
      if (k === "maxConcurrency") {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 32) {
          return { ok: false, code: "INVALID_VALUE", applied: {}, rejectedKeys: [], caps: this.currentCaps() };
        }
        applied.maxConcurrency = v;
      } else {
        if (typeof v !== "string" || v.trim().length === 0 || v.length > 128) {
          return { ok: false, code: "INVALID_VALUE", applied: {}, rejectedKeys: [], caps: this.currentCaps() };
        }
        applied.subagentModel = v.trim();
      }
    }
    const now = Date.now();
    this.caps = { ...this.caps, ...applied, amendedAt: now, amendCount: (this.caps.amendCount ?? 0) + 1 };
    this.opts.journal.append({
      kind: CAPS_KIND as JournalKind,
      sessionId: this.opts.workflowId,
      payload: { caps: { ...this.caps }, patch: applied, at: now },
    });
    return { ok: true, code: "APPLIED", applied, rejectedKeys: [], caps: this.currentCaps() };
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
 //  护栏顺序固定:先占「总派发预算」,再排队等「并发槽」,最后才落 journal + 派发。
 // 预算前置的理由:排队本身就是等待,若排到时才发现预算耗尽,这段等待完全白费,
 // 还会和 fatal 收敛抢时序(见 run catch 的注释)。
          const budget = this.guard.recordDispatch();
          if (!budget.ok) {
            this.guardNotice(budget.code);
            throw new WorkflowRunError(budget.code, `工作流派发总数超过上限 ${this.maxTotal}`, { fatal: true });
          }
          const release = await this.guard.acquire({ signal: this.abort?.signal });
          try {
            this.opts.journal.append({
              kind: "workflow.ask", sessionId: this.opts.workflowId,
              payload: { actor: name, seq, inputHash, cacheKey, instructions: instructions.slice(0, 2000) },
            });
            const raw = await this.trackDispatch(this.dispatch(instructions));
            let result: unknown = raw;
            if (opts?.schema) {
              let parsed: unknown | undefined;
              let lastErr = "";
              for (let attempt = 0; attempt < 2 && parsed === undefined; attempt++) {
                const attemptRaw = attempt === 0
                  ? raw
                  : await this.trackDispatch(this.dispatch(instructions + "\n\n(上一版输出无法通过 schema 校验,严格只输出合法 JSON)"));
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
          } finally {
 // release 幂等:异常路径(fatal/abort)与正常路径只会真正让位一次
            release();
          }
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
 // 上一 run 的 finally 会 abortAll;同一引擎实例再次 run 必须拿到一块干净的护栏
 // (否则 acquire 一律 ABORTED),同时让 amend 后的 maxConcurrency 对新 run 生效。
    if (this.guard.stats().aborted) this.guard = this.makeGuard();
    // 静态禁令(二次兜底:vm 本身拿不到 require/process)
    if (/\brequire\s*\(|\bprocess\.|\bimport\s*\(/.test(source)) {
      return { ...this.capsField(), ok: false, items: this.items, logs: this.logs, partial: true, error: "静态禁令:脚本不得使用 require/process/import(只可用注入的 facade)", durationMs: Date.now() - t0 };
    }
    let code: string;
    try {
      const transformed = await loadTransform()(source, { loader: "ts", format: "esm", target: "es2022" });
      code = transformed.code;
    } catch (err) {
      // 加载器/部署问题(esbuild 解析不到、bundle 内联)不与用户脚本语法错误混报
      return { ...this.capsField(), ok: false, items: this.items, logs: this.logs, partial: true, error: `${runErrorPrefix(err)}: ${String(err).slice(0, 300)}`, durationMs: Date.now() - t0 };
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
      return { ...this.capsField(), ok: true, items: this.items, logs: this.logs, partial: false, durationMs: Date.now() - t0 };
    } catch (err) {
      // 失败保留已 report 成果(ZCode 纪律);abort 通知 dispatch 链停止(L-092)
      this.abort.abort();
      if (isFatalWorkflowError(err)) {
 // 为什么 fatal 必须先中止排队、再等结算、最后才返回/重抛(GUARD:code):
 // ①排队者若继续等槽,会在 run 已注定失败之后才真正派发子代理——白烧预算;
 // ②在飞 Promise 若晚于 run 返回才写 journal,resume/replay 会读到「run 之后」的事件,
 // journal-first 的「事件顺序=执行顺序」前提被打穿;
 // ③所以顺序是 abortAll(拒绝全部排队者)→ settleOrder(等已在飞的收敛,带时间盒)→ 返回 partial。
        const code = guardErrorCode(err);
        this.guard.abortAll("fatal");
        this.guardNotice(code);
        await settleOrder([...this.inflight], { timeoutMs: GUARD_SETTLE_TIMEOUT_MS });
        return { ...this.capsField(), ok: false, items: this.items, logs: this.logs, partial: true, error: `GUARD:${code}: ${String(err).slice(0, 300)}`, durationMs: Date.now() - t0 };
      }
      return { ...this.capsField(), ok: false, items: this.items, logs: this.logs, partial: this.items.length > 0, error: String(err).slice(0, 400), durationMs: Date.now() - t0 };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
 // run 收尾护栏:不管成功/失败,先拒掉残留排队者,再等已在飞的派发落定后才交出结果——
 // 否则 run 返回后仍有 Promise 往 journal 写 workflow.ask(观测面错位)。时间盒保证不卡死。
      this.guard.abortAll("run-ended");
      await settleOrder([...this.inflight], { timeoutMs: GUARD_SETTLE_TIMEOUT_MS });
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
