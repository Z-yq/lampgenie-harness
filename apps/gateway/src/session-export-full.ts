/**
 * 会话完整导出(2026-10-19 用户口径:「日志下载就应该下载完全的内容」)。
 *
 * 此前「↓ 日志」只把 journal 事件(指针+摘要)拼成 jsonl——system 提示词、消息构型、
 * 工具 schema、原始响应全在 .genie/llm-trace 的文件里,下载拿不到。
 *
 * 本模块把三层打包成一个自包含 jsonl:
 *   ①`export.meta` 头行(会话/时间/说明);
 *   ②journal 逐事件(原样,seq 保序);
 *   ③每个 llm.trace 指针 → 紧随一行 `llm.trace.full`(轨迹文件全文内嵌);
 *   ④该会话派发的每个子代理(subagent.spawn.taskId)→ `subagent.trace.full` 逐调用
 *     (subagent-<taskId> 与 -retry 两目录都收;call-*.json 保序)。
 * 缺失文件不静默:`missing:true` + stats.missing 计数(journal 指针指向的文件被清掉时可见)。
 *
 * 读盘可注入(测试用内存桩);HTTP 面由 servePanel 的 sessionExport 钩子挂载。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redactEventPayload } from "@lampgenie/core";

export interface ExportEvent {
  seq?: number;
  time?: number;
  sessionId?: string;
  kind: string;
  payload?: unknown;
}

export interface BuildSessionExportInput {
  sessionId: string;
  events: ExportEvent[];
  /** 轨迹根目录(调用方给 <repo>/.genie/llm-trace)。 */
  traceRoot: string;
  readText?: (path: string) => string;
  listDir?: (path: string) => string[];
  exists?: (path: string) => boolean;
  now?: () => number;
}

export interface SessionExportResult {
  filename: string;
  body: string;
  stats: { events: number; llmTraces: number; subagentTraces: number; missing: number; bytes: number };
}

/** taskId → 子代理轨迹目录名(首跑/重派两条)。 */
export function subagentTraceDirs(taskId: string): string[] {
  return ["subagent-" + taskId, "subagent-" + taskId + "-retry"];
}

export function buildSessionExport(input: BuildSessionExportInput): SessionExportResult {
  const readText = input.readText ?? ((p: string) => readFileSync(p, "utf-8"));
  const listDir = input.listDir ?? ((p: string) => readdirSync(p));
  const exists = input.exists ?? ((p: string) => existsSync(p));
  const lines: string[] = [];
  let llmTraces = 0;
  let subagentTraces = 0;
  let missing = 0;

  const traceFilesIn = (dir: string): string[] => {
    const abs = join(input.traceRoot, dir);
    if (!exists(abs)) return [];
    try {
      return listDir(abs).filter((f) => /^call-.*\.json$/.test(f)).sort().map((f) => join(abs, f));
    } catch {
      return [];
    }
  };

  // 先从 journal 收集:llm.trace 指针 + 子代理 taskId(去重保序)。
  const tracePointers: { seq?: number; file: string }[] = [];
  const taskIds: string[] = [];
  for (const e of input.events) {
    const p = (e.payload ?? {}) as { file?: unknown; taskId?: unknown };
    if (e.kind === "llm.trace" && typeof p.file === "string" && p.file) {
      tracePointers.push({ seq: e.seq, file: p.file });
    } else if (e.kind === "subagent.spawn" && typeof p.taskId === "string" && p.taskId && !taskIds.includes(p.taskId)) {
      taskIds.push(p.taskId);
    }
  }

  // ① 头行
  lines.push(JSON.stringify({
    kind: "export.meta",
    sessionId: input.sessionId,
    exportedAt: (input.now ?? Date.now)(),
    note: "完整会话导出:journal 事件 + 每次 LLM 调用全量轨迹(system/消息构型/工具 schema/provider 参数/响应)+ 子代理轨迹",
  }));

  // ② journal 逐事件(导出侧脱敏,轨迹追踪 P1-B)
  // journal 落盘时已过 redactEventPayload(journal.ts append),这里再跑一次是**幂等兜底**:
  // 占位符 `<redacted:kind>` 不命中任何规则,故不会二次打标/层层替换;真正兜的是
  // 「脱敏开关曾经关着」或「调用方直接喂了内存事件(测试/回放)」这两种明文漏网。
  // `GENIE_JOURNAL_REDACT=0` 时 redactEventPayload 原样返回(全关)。
  for (const e of input.events) {
    const r = redactEventPayload(e.payload);
    lines.push(JSON.stringify({ seq: e.seq, time: e.time, sessionId: e.sessionId, kind: e.kind, payload: r.payload }));
  }

  // ③ LLM 轨迹全文
  for (const tp of tracePointers) {
    let trace: unknown;
    let ok = false;
    try {
      trace = JSON.parse(readText(tp.file));
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) llmTraces++;
    else missing++;
    lines.push(JSON.stringify(ok
      ? { kind: "llm.trace.full", seq: tp.seq, file: tp.file, trace }
      : { kind: "llm.trace.full", seq: tp.seq, file: tp.file, missing: true }));
  }

  // ④ 子代理轨迹(按 spawn 顺序,目录内 call 文件保序)。
  // 目录发现用前缀匹配:2026-10-19 起子代理 taskId 每次派发唯一,loop sessionId 为
  // `subagent-<subTaskId>-sub| -bg`;旧会话是 `subagent-<parentTaskId>-sub`。两者都按
  // `subagent-<taskId>` 或 `subagent-<taskId>-*` 命中(不再依赖固定两条目录名)。
  const allDirs = exists(input.traceRoot) ? (() => { try { return listDir(input.traceRoot); } catch { return []; } })() : [];
  const dirsFor = (taskId: string): string[] => {
    const exact = subagentTraceDirs(taskId);
    const prefixed = allDirs.filter((d) => d === "subagent-" + taskId || d.startsWith("subagent-" + taskId + "-"));
    return [...new Set([...exact.filter((d) => allDirs.includes(d)), ...prefixed])];
  };
  for (const taskId of taskIds) {
    for (const dir of dirsFor(taskId)) {
      for (const file of traceFilesIn(dir)) {
        let trace: unknown;
        try {
          trace = JSON.parse(readText(file));
        } catch {
          missing++;
          lines.push(JSON.stringify({ kind: "subagent.trace.full", taskId, file, missing: true }));
          continue;
        }
        subagentTraces++;
        lines.push(JSON.stringify({ kind: "subagent.trace.full", taskId, file, trace }));
      }
    }
  }

  const body = lines.join("\n") + "\n";
  return {
    filename: `session-${input.sessionId}-${(input.now ?? Date.now)()}.jsonl`,
    body,
    stats: { events: input.events.length, llmTraces, subagentTraces, missing, bytes: Buffer.byteLength(body) },
  };
}
