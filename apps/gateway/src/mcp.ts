/**
 * MCP 客户端(ZCode MCP 服务器管理裁剪):stdio JSON-RPC 2.0。
 * 生命周期:按需连接(连接后常驻,闲时由 closeAll 收);工具以 mcp__<server>__<tool> 并入主 agent。
 * 纪律:fail-soft(服务器不可达=工具调用返回错误文本,不挂任务);stderr 丢弃防污染 RPC 流。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  createdAt: number;
}

export class McpServerStore {
  private items = new Map<string, McpServer>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const arr = JSON.parse(readFileSync(file, "utf-8")) as McpServer[];
        for (const s of arr) if (s && s.id && s.command) this.items.set(s.id, s);
      } catch {
        // 坏文件容忍
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.items.values()], null, 2) + "\n");
  }

  list(): McpServer[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): McpServer | undefined {
    return this.items.get(id);
  }

  add(input: { name: string; command: string; args?: string[] }): McpServer | { error: string } {
    const name = String(input.name || "").trim();
    const command = String(input.command || "").trim();
    if (!name) return { error: "名称为空" };
    if (!command) return { error: "命令为空" };
    const s: McpServer = {
      id: randomUUID(), name, command,
      args: Array.isArray(input.args) ? input.args.map(String).filter(Boolean) : [],
      enabled: true, createdAt: Date.now(),
    };
    this.items.set(s.id, s);
    this.persist();
    return s;
  }

  update(id: string, patch: { enabled?: boolean }): McpServer | undefined {
    const s = this.items.get(id);
    if (!s) return undefined;
    if (patch.enabled !== undefined) s.enabled = patch.enabled;
    this.persist();
    return s;
  }

  remove(id: string): boolean {
    const ok = this.items.delete(id);
    if (ok) this.persist();
    return ok;
  }
}

/**
 * 工具发现护栏:
 * - 页数/条数上限防服务器死循环或爆量(MCP 允许 nextCursor 无限链)。
 * - descriptor 带 contractVersion,未知键丢弃(只保留 name/description/contractVersion)。
 */
export const MCP_TOOL_LIST_MAX_PAGES = 10;
export const MCP_TOOL_LIST_MAX_TOOLS = 500;
export const MCP_TOOL_CONTRACT_VERSION = 1;

export interface McpToolInfo {
  name: string;
  description: string;
  contractVersion: number;
}

/** 单服务器 stdio 客户端:initialize → tools/list → tools/call。 */
export class McpClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private stderrBuf = "";
 /** onClose 只回调一次(exit/error/close 会重复触发)。 */
  private closeNotified = false;
 /** 最近一次 listTools 的护栏告警(重复 cursor / 达到上限);空=无异常。 */
  listWarnings: string[] = [];

  constructor(private readonly server: McpServer, private readonly onClose?: (reason: string) => void) {}

  get alive(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  async start(timeoutMs = 10_000): Promise<void> {
    if (this.alive) return;
    const child = spawn(this.server.command, this.server.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    this.child = child;
    this.closeNotified = false; // 新一代子进程可再次回调
    child.stderr?.on("data", (d: Buffer) => { this.stderrBuf = (this.stderrBuf + d.toString()).slice(-2000); });
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // 非 JSON 行忽略
      }
      const id = typeof msg.id === "number" ? msg.id : undefined;
      if (id !== undefined && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error).slice(0, 200)));
        else p.resolve(msg.result);
      }
    });
    child.on("error", () => this.notifyClose("error"));
    child.on("exit", () => {
      for (const [, p] of this.pending) p.reject(new Error("MCP 服务器退出"));
      this.pending.clear();
      this.notifyClose("exit");
    });
    child.on("close", () => this.notifyClose("close"));
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lampgenie-harness", version: "1.0" },
    }, timeoutMs);
    this.notify("notifications/initialized", {});
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin) return Promise.reject(new Error("MCP 未连接"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("MCP 请求超时:" + method));
        }
      }, timeoutMs).unref?.();
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      // 连接已断忽略
    }
  }

 /**
 * 工具发现:MCP 允许 nextCursor 无限链,这里按页数/条数双上限收敛。
 * 停止条件:nextCursor 缺失/空、cursor 重复(记 warning,不 throw)、触顶。
 * descriptor 只保留 name/description/contractVersion(未知键丢弃)。
 */
  async listTools(): Promise<McpToolInfo[]> {
    this.listWarnings = [];
    const out: McpToolInfo[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MCP_TOOL_LIST_MAX_PAGES; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: unknown[];
        nextCursor?: unknown;
      };
      for (const raw of Array.isArray(r.tools) ? r.tools : []) {
        if (!raw || typeof raw !== "object") continue;
        const t = raw as Record<string, unknown>;
        if (typeof t.name !== "string" || !t.name) continue;
        if (seenNames.has(t.name)) continue; // 跨页去重
        seenNames.add(t.name);
        out.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          contractVersion: MCP_TOOL_CONTRACT_VERSION,
        });
        if (out.length >= MCP_TOOL_LIST_MAX_TOOLS) {
          this.listWarnings.push(`tools 数量达到上限 ${MCP_TOOL_LIST_MAX_TOOLS},停止分页`);
          return out;
        }
      }
      const next = typeof r.nextCursor === "string" ? r.nextCursor : "";
      if (!next) break;
      if (seenCursors.has(next)) {
        this.listWarnings.push(`tools/list cursor 重复(${next.slice(0, 64)}),停止分页`);
        return out;
      }
      seenCursors.add(next);
      cursor = next;
    }
    if (cursor) this.listWarnings.push(`tools/list 页数达到上限 ${MCP_TOOL_LIST_MAX_PAGES},停止分页`);
    return out;
  }

  async callTool(name: string, args: unknown, timeoutMs = 60_000): Promise<string> {
    const r = (await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = (r.content ?? []).map((c) => (c.type === "text" ? String(c.text ?? "") : "[" + String(c.type ?? "?") + "]")).join("\n");
    return (r.isError ? "[工具错误] " : "") + (text || "(空返回)");
  }

  get stderrTail(): string {
    return this.stderrBuf;
  }

 /** 服务器断开/主动关闭:恰好回调一次(幂等),异常不外泄。 */
  private notifyClose(reason: string): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    try {
      this.onClose?.(reason);
    } catch {
 // 回调异常不影响收尾
    }
  }

  close(): void {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      // 忽略
    }
    this.child = null;
    this.notifyClose("closed");
  }
}

export interface McpStatus {
  ok: boolean | null;
  tools: number;
  error?: string;
}

/** 管理器:每 server 惰性连接 + 工具缓存 + 状态上报(面板/MCP 桥共用)。 */
export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolCache = new Map<string, McpToolInfo[]>();
  private status = new Map<string, McpStatus>();

  constructor(readonly store: McpServerStore) {}

  private clientFor(s: McpServer): McpClient {
    let c = this.clients.get(s.id);
    if (!c) {
      c = new McpClient(s, (reason) => this.onServerClosed(s.id, reason));
      this.clients.set(s.id, c);
    }
    return c;
  }

 /** 服务器退出/关闭:撤销工具缓存与能力位,不留幽灵工具(下次 tools 会重新 start)。 */
  private onServerClosed(serverId: string, reason: string): void {
    this.toolCache.delete(serverId);
    this.status.set(serverId, {
      ok: false,
      tools: 0,
      error: reason === "closed" ? "服务器已关闭" : "服务器已退出",
    });
  }

  async tools(serverId: string): Promise<McpToolInfo[]> {
    const s = this.store.get(serverId);
    if (!s || !s.enabled) return [];
    const hit = this.toolCache.get(serverId);
    if (hit) return hit;
    const c = this.clientFor(s);
    try {
      await c.start();
      const tools = await c.listTools();
      this.toolCache.set(serverId, tools);
      this.status.set(serverId, { ok: true, tools: tools.length });
      return tools;
    } catch (err) {
      this.status.set(serverId, { ok: false, tools: 0, error: String(err).slice(0, 200) });
      return [];
    }
  }

  async callTool(serverId: string, tool: string, args: unknown): Promise<string> {
    const s = this.store.get(serverId);
    if (!s) return "[MCP] 服务器不存在";
    const c = this.clientFor(s);
    try {
      await c.start();
      return await c.callTool(tool, args);
    } catch (err) {
      return "[MCP 调用失败] " + String(err).slice(0, 300);
    }
  }

  /** 面板「测试」:连接 + 工具清单(结果入缓存)。 */
  async test(id: string): Promise<McpStatus> {
    const s = this.store.get(id);
    if (!s) return { ok: false, tools: 0, error: "服务器不存在" };
    this.toolCache.delete(id);
    const old = this.clients.get(id);
    if (old) { old.close(); this.clients.delete(id); }
    const tools = await this.tools(id);
    const st = this.status.get(id) ?? { ok: false, tools: 0, error: "未知" };
    if (st.ok === false) {
      const c = this.clients.get(id);
      if (c && c.stderrTail) st.error = (st.error ?? "") + " | stderr: " + c.stderrTail.slice(-120);
    }
    return st;
  }

  statusOf(): Record<string, McpStatus> {
    const out: Record<string, McpStatus> = {};
    for (const s of this.store.list()) out[s.id] = this.status.get(s.id) ?? { ok: null, tools: this.toolCache.get(s.id)?.length ?? 0 };
    return out;
  }

  /** 主 agent 工具桥:全部启用服务器的工具(名形如 mcp__<server>__<tool>;≤40 防爆)。 */
  async allToolsForAgent(): Promise<{ serverId: string; serverName: string; name: string; description: string }[]> {
    const out: { serverId: string; serverName: string; name: string; description: string }[] = [];
    for (const s of this.store.list()) {
      if (!s.enabled) continue;
      const tools = await this.tools(s.id);
      for (const t of tools) {
        out.push({ serverId: s.id, serverName: s.name, name: t.name, description: t.description });
        if (out.length >= 40) return out;
      }
    }
    return out;
  }

  closeAll(): void {
    for (const [, c] of this.clients) c.close();
    this.clients.clear();
  }
}
