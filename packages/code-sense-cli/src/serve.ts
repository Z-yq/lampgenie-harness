/**
 * `codesense serve`——MCP stdio 模式:把 code-sense 静态索引作为 MCP 工具暴露给任意客户端
 * (codex / trae / dsh / zcode / claude 系等,协议=JSON-RPC 2.0 over stdio,MCP 基线)。
 * 工具面与 gateway 的 code-index-mcp 完全同源(同一 mcp-core),serverInfo 名不同而已。
 * stdout 是协议通道:一切日志走 stderr。
 */
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createCodeIndexMcp } from "./mcp-core.js";

export interface ServeOptions {
  root?: string;
  /** stdio 注入(测试用);缺省=process.stdin/stdout。 */
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): unknown };
  log?: (msg: string) => void;
  /** 进程退出钩子(测试注入防 process.exit 杀掉测试进程;缺省=真退出)。 */
  exit?: (code: number) => void;
}

export function serveMain(argv: string[], opts: ServeOptions = {}): void | Promise<void> {
  const root = resolve(opts.root ?? process.env.GENIE_SENSE_INDEX_ROOT ?? argv[0] ?? process.cwd());
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const log = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));
  const finish0 = opts.exit ?? ((code: number) => process.exit(code));
  const mcp = createCodeIndexMcp(root);

  let buf = "";
 /** 在飞异步分派计数:api/state/algo 行扫描秒级,一次性管道场景 stdin 关闭
 * 早于响应写出——旧逻辑 10ms/2s 兜底退出会吃掉在飞响应(stdio 三连经验证 1/4 行注意)。 */
  let pendingCalls = 0;
  input.setEncoding("utf-8");
  input.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleLine(line);
    }
  });
  input.on("end", () => {
    // stdin 关闭后先等在飞异步分派清零,再等 stdout 排水后退出(一次性管道脚本场景:
    // JSON-RPC 响应可能还在管道缓冲;常驻 MCP 客户端不关 stdin,不受影响)。
    const out = (opts.output ?? process.stdout) as typeof process.stdout;
    const finish = () => finish0(0);
    const drainWait = () => {
      if (typeof out.writableLength === "number" && out.writableLength > 0) {
        out.once("drain", () => setTimeout(finish, 10));
        setTimeout(finish, 2000); // 排水兜底(对端不读也不悬挂)
      } else {
        setTimeout(finish, 10);
      }
    };
    const waitPending = () => {
      if (pendingCalls <= 0) {
        drainWait();
        return;
      }
      setTimeout(waitPending, 25);
    };
    waitPending();
  });

  function send(msg: unknown): void {
    output.write(JSON.stringify(msg) + "\n");
  }

  function handleLine(line: string): void {
    let req: { id?: unknown; method?: string; params?: { name?: unknown; arguments?: Record<string, unknown> } };
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = req;
    const isNotify = id === undefined || id === null;
    try {
      if (method === "initialize") {
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "code-sense-cli", version: "0.1.0" } } });
        return;
      }
      if (method === "notifications/initialized") return;
      if (method === "ping") {
        if (!isNotify) send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: mcp.tools } });
        return;
      }
      if (method === "tools/call") {
 // api/state/algo 是 async sensing 分派,统一走 dispatchToolAsync
        //(其余工具在其内部委托同步 dispatchTool,行为零变)。响应按 id 关联,异步到达不破坏协议。
        pendingCalls++;
        Promise.resolve(mcp.dispatchToolAsync(String(params?.name ?? ""), params?.arguments ?? {}))
          .then((r) => send({ jsonrpc: "2.0", id, result: r }))
          .catch((err) => {
            if (!isNotify) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err).slice(0, 200) } });
          })
          .finally(() => {
            pendingCalls--;
          });
        return;
      }
      if (!isNotify) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
    } catch (err) {
      if (!isNotify) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err).slice(0, 200) } });
    }
  }

  // 启动日志走 stderr(stdio 协议占用 stdout)
  log(`[code-sense-cli] root=${root} 多仓路由=v1.1(工具面与 lampgenie-harness gateway 同源)`);
}

/** 独立进程入口判定(cli.ts 复用同一守卫逻辑)。 */
export function isMainEntry(metaUrl: string): boolean {
  const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
  if (argv1 === "") return false;
  if (metaUrl === pathToFileURL(argv1).href) return true;
 // npm/pnpm 安装态 bin 是符号链接(.bin/codesense → 包内 dist/cli.js),
  // Node 对主入口默认 realpath 化 import.meta.url,而 argv[1] 保留链接路径——
 // 不补 realpath 比对时主守卫静默不触发(进程零输出 exit 0,tarball 安装经验证注意)。
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
