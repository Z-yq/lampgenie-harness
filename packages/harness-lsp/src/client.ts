/**
 * 单语言服务器实例的 stdio JSON-RPC 客户端。
 * 参照:
 * - deepseek-harness/packages/lsp/lsp-stdio/src/connection.ts(id 关联/进程关闭即拒绝)
 * - opencode/packages/opencode/src/lsp/client.ts(诊断新鲜度/版本/去抖)
 * 红线:任何异常只影响本客户端(fail-soft),不允许向工具调用抛错。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { MessageDecoder, encodeMessage } from "./framing.js";
import type { ServerSpec } from "./servers.js";
import type { DiagnosticItem } from "./types.js";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_TAIL = 4096;
/** 诊断发布后的静默窗(lsp 可能连续推空/填充两帧)。 */
const DIAGNOSTICS_QUIET_MS = 120;

interface RawDiagnostic {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  code?: unknown;
  source?: string;
  message?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface DocState {
  version: number;
  text: string;
}

interface DiagEntry {
  items: RawDiagnostic[];
  at: number;
  version?: number;
}

export interface TextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LspClient {
  private readonly decoder = new MessageDecoder(MAX_MESSAGE_BYTES);
  private readonly pending = new Map<number, Pending>();
  private readonly docs = new Map<string, DocState>();
  private readonly diagByUri = new Map<string, DiagEntry>();
  private nextId = 1;
  private closed: Error | null = null;
  private exited = false;
  private stderrTail = "";
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    readonly serverId: string,
    readonly root: string,
    readonly defaultTimeoutMs: number) {
    proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_TAIL);
    });
    proc.on("error", (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    proc.on("exit", () => {
      this.exited = true;
      this.fail(new Error(`LSP server exited (${this.serverId})`));
    });
    // 子进程 stdin 关闭(server 自杀)也必须立即释放等待方。
    proc.stdin.on("error", (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
  }

  /** spawn 并完成 initialize/initialized;失败抛错(由 manager 转 fail-soft)。 */
  static async start(server: ServerSpec, root: string, timeoutMs: number): Promise<LspClient> {
    const proc = spawn(server.command, server.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const client = new LspClient(proc, server.id, root, timeoutMs);
    const rootUri = pathToFileURL(root).href;
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            formatting: { dynamicRegistration: false },
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
      }, timeoutMs);
      await client.notify("initialized", {});
      return client;
    } catch (err) {
      client.fail(err instanceof Error ? err : new Error(String(err)));
      client.kill();
      throw err;
    }
  }

  /** 同实例串行执行(防 didChange 与诊断等待交错)。 */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** didOpen(首次)/didChange(全量);同文本不重复通知。 */
  async syncDocument(absPath: string, languageId: string, text: string): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    const prev = this.docs.get(uri);
    if (!prev) {
      // 新鲜度锚点:通知前清掉旧诊断——此后到达的 publish 一定属于本次同步(避免「发布早于
 // collect 起始时刻」被误判为陈旧,经验证 fake/pylsp 都可能先推后返)。
      this.diagByUri.delete(uri);
      await this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      this.docs.set(uri, { version: 1, text });
      return;
    }
    if (prev.text === text) return; // 内容未变:保留旧诊断(collect 直接复用)
    this.diagByUri.delete(uri);
    const version = prev.version + 1;
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    this.docs.set(uri, { version, text });
  }

  /** textDocument/formatting;不支持/失败/超时=null(调用方走外部 formatter 兜底)。 */
  async formatDocument(absPath: string, options: { tabSize: number; insertSpaces: boolean }): Promise<TextEdit[] | null> {
    try {
      const res = await this.request("textDocument/formatting", {
        textDocument: { uri: pathToFileURL(absPath).href },
        options,
      }, this.defaultTimeoutMs);
      return Array.isArray(res) ? (res as TextEdit[]) : null;
    } catch {
      return null;
    }
  }

  /**
   * 等待本次同步之后发布的诊断(quiet 窗收敛;超时返回已到达的最新一帧,无则空)。
   * 新鲜度由 syncDocument 清旧诊断保证;server 带 version 时再校验 version 匹配。
   */
  async collectDiagnostics(absPath: string, timeoutMs: number): Promise<DiagnosticItem[]> {
    const uri = pathToFileURL(absPath).href;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const expectedVersion = this.docs.get(uri)?.version;
    let lastAt = 0;
    while (Date.now() < deadline) {
      const entry = this.diagByUri.get(uri);
      if (entry && this.isFresh(entry, expectedVersion)) {
        if (entry.at !== lastAt) lastAt = entry.at;
        if (Date.now() - entry.at >= DIAGNOSTICS_QUIET_MS) return normalize(entry.items);
      }
      if (this.closed) break;
      await sleep(20);
    }
    const entry = this.diagByUri.get(uri);
    return entry && this.isFresh(entry, expectedVersion) ? normalize(entry.items) : [];
  }

  private isFresh(entry: DiagEntry, expectedVersion?: number): boolean {
    if (typeof entry.version === "number" && typeof expectedVersion === "number") return entry.version >= expectedVersion;
    return true;
  }

  /** 发送请求并等响应;超时/关闭/错误响应均 reject(调用方 catch)。 */
  request(method: string, params: unknown, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (this.closed) {
        reject(this.closed);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise<void>((resolve, reject) => {
      try {
        this.proc.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }), (err) => {
          if (err) reject(err);
          else resolve();
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 优雅关闭;幂等。 */
  async shutdown(): Promise<void> {
    if (this.closed) {
      this.kill();
      return;
    }
    try { await this.request("shutdown", null, 500); } catch { /* 已死/超时都继续收尾 */ }
    try { await this.notify("exit", null); } catch { /* ignore */ }
    await sleep(150);
    this.fail(new Error("LSP client shutdown"));
    this.kill();
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  private kill(): void {
    if (this.exited) return;
    try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
  }

  private fail(reason: Error): void {
    if (this.closed) return;
    this.closed = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(reason);
    }
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      this.kill();
      return;
    }
    for (const m of messages) this.dispatch(m);
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const frame = message as Record<string, unknown>;
    const method = typeof frame.method === "string" ? frame.method : undefined;
    const id = frame.id;
    // server→client 请求(有 id + method):必须应答,否则 server 端 await 挂死。
    if (method && (typeof id === "number" || typeof id === "string")) {
      void this.answerServerRequest(id, method, frame.params);
      return;
    }
    if (method) {
      if (method === "textDocument/publishDiagnostics") this.onPublishDiagnostics(frame.params);
      return; // 其它通知(日志/进度)忽略
    }
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(`LSP error: ${JSON.stringify(frame.error).slice(0, 300)}`));
      else pending.resolve(frame.result);
    }
  }

  private onPublishDiagnostics(params: unknown): void {
    const p = params as { uri?: unknown; version?: unknown; diagnostics?: unknown };
    if (typeof p?.uri !== "string") return;
    this.diagByUri.set(p.uri, {
      items: Array.isArray(p.diagnostics) ? (p.diagnostics as RawDiagnostic[]) : [],
      at: Date.now(),
      ...(typeof p.version === "number" ? { version: p.version } : {}),
    });
  }

  private async answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const respond = (result: unknown, error?: { code: number; message: string }) => {
      try {
        this.proc.stdin.write(encodeMessage(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }));
      } catch { /* server 已死 */ }
    };
    switch (method) {
      case "workspace/configuration": {
        const items = (params as { items?: unknown[] } | undefined)?.items;
        respond(Array.isArray(items) ? items.map(() => null) : []);
        return;
      }
      case "workspace/workspaceFolders": {
        const rootUri = pathToFileURL(this.root).href;
        respond([{ uri: rootUri, name: "workspace" }]);
        return;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create": {
        respond(null);
        return;
      }
      case "workspace/applyEdit": {
        respond({ applied: false, failureReason: "applyEdit not supported by harness" });
        return;
      }
      default:
        respond(null, { code: -32601, message: `Method not supported: ${method}` });
    }
  }
}

/** 原始诊断 → 归一 DiagnosticItem(1-based;severity 缺省按 spec 视为 error=1)。 */
function normalize(items: RawDiagnostic[]): DiagnosticItem[] {
  const out: DiagnosticItem[] = [];
  for (const d of items) {
    const line = Number(d.range?.start?.line);
    const character = Number(d.range?.start?.character);
    out.push({
      line: Number.isFinite(line) ? line + 1 : 1,
      column: Number.isFinite(character) ? character + 1 : 1,
      severity: severityOf(d.severity),
      ...(d.code !== undefined && d.code !== null ? { code: codeOf(d.code) } : {}),
      message: String(d.message ?? "").replace(/\s+/g, " ").trim() || "(no message)",
      ...(d.source ? { source: String(d.source) } : {}),
    });
  }
  return out;
}

function severityOf(sev: unknown): DiagnosticItem["severity"] {
  switch (Number(sev)) {
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "error";
  }
}

function codeOf(code: unknown): string | number {
  if (typeof code === "string" || typeof code === "number") return code;
  if (code && typeof code === "object" && "value" in code) {
    const v = (code as { value?: unknown }).value;
    if (typeof v === "string" || typeof v === "number") return v;
  }
  return String(code);
}
