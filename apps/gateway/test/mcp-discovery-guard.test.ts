/**
 * MCP 工具发现护栏(假 stdio 行协议 server,不依赖任何真实 MCP 服务端)。
 * 覆盖:分页合并 / 页数上限 / 条数上限 / 重复 cursor(不死循环) / 空与非法 nextCursor /
 * 跨页去重 / descriptor 未知键丢弃 / onClose 幂等(exit·error·close)/ Manager 撤销工具缓存与能力位。
 */
import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpClient,
  McpManager,
  McpServerStore,
  MCP_TOOL_CONTRACT_VERSION,
  MCP_TOOL_LIST_MAX_PAGES,
  MCP_TOOL_LIST_MAX_TOOLS,
  type McpServer,
} from "../src/mcp.js";

const DIR = mkdtempSync(join(tmpdir(), "m137-mcp-"));
const FIXTURE = join(DIR, "fake-mcp.mjs");
writeFileSync(FIXTURE, fixtureSource(), "utf8");

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** 假 MCP server:换行分隔 JSON-RPC;mode 决定 tools/list 行为,log 记录 spawn/list 次数。 */
function fixtureSource(): string {
  return [
    "import { createInterface } from 'node:readline';",
    "import { appendFileSync } from 'node:fs';",
    "const mode = process.argv[2] || 'paged';",
    "const log = process.argv[3] || '';",
    "const logln = (s) => { if (log) appendFileSync(log, s + '\\n'); };",
    "logln('spawn');",
    "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
    "function toolsFor(cursor) {",
    "  switch (mode) {",
    "    case 'paged':",
    "      if (!cursor) return { tools: [ { name: 'echo', description: '回显', inputSchema: { type: 'object' }, extra: 'drop-me' }, { name: 'sum' } ], nextCursor: 'p2' };",
    "      if (cursor === 'p2') return { tools: [ { name: 'add', description: '加法', annotations: {}, unknown: 1 } ] };",
    "      return { tools: [] };",
    "    case 'dup':",
    "      return { tools: [ { name: 't1', description: '同页' } ], nextCursor: 'dup' };",
    "    case 'endless': {",
    "      const n = cursor ? Number(String(cursor).slice(1)) : 0;",
    "      return { tools: [ { name: 'c' + n } ], nextCursor: 'c' + (n + 1) };",
    "    }",
    "    case 'bulk': {",
    "      const page = cursor ? Number(cursor) : 0;",
    "      const tools = [];",
    "      for (let i = 0; i < 200; i++) tools.push({ name: 'p' + page + '-t' + i, description: 'x' });",
    "      return { tools, nextCursor: String(page + 1) };",
    "    }",
    "    case 'empty':",
    "      return { tools: [ { name: 'solo' } ], nextCursor: '' };",
    "    case 'nonstring':",
    "      return { tools: [ { name: 'solo' } ], nextCursor: 42 };",
    "    case 'dedupe':",
    "      if (!cursor) return { tools: [ { name: 't1' }, { name: 't1' }, null, 42, { description: '无名' }, { name: '' }, 'str' ], nextCursor: 'n2' };",
    "      return { tools: [ { name: 't1' }, { name: 't2', description: '二' } ] };",
    "    case 'exit':",
    "      return { tools: [ { name: 'echo' }, { name: 'sum' } ] };",
    "    case 'exitAfterInit':",
    "      return { tools: [] };",
    "    default:",
    "      return { tools: [] };",
    "  }",
    "}",
    "const rl = createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.method === 'initialize') {",
    "    reply(m.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture-' + mode, version: '0' } });",
    "    if (mode === 'exitAfterInit') setTimeout(() => process.exit(0), 20);",
    "  } else if (m.method === 'tools/list') {",
    "    logln('list');",
    "    reply(m.id, toolsFor(m.params && m.params.cursor));",
    "    if (mode === 'exit') setTimeout(() => process.exit(0), 30);",
    "  } else if (m.method === 'tools/call') {",
    "    reply(m.id, { content: [ { type: 'text', text: 'ok:' + m.params.name } ] });",
    "  } else if (m.id !== undefined) {",
    "    reply(m.id, null);",
    "  }",
    "});",
  ].join("\n");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function serverOf(mode: string, log = ""): McpServer {
  return {
    id: `srv-${mode}-${Math.random().toString(36).slice(2, 8)}`,
    name: `fixture-${mode}`,
    command: process.execPath,
    args: [FIXTURE, mode, log],
    enabled: true,
    createdAt: Date.now(),
  };
}

function logLines(file: string, kind: string): number {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l === kind).length;
  } catch {
    return 0;
  }
}

describe("McpClient.listTools 分页护栏", () => {
  it("两页 cursor → 合并 3 工具,contractVersion=1(探针 A)", async () => {
    const log = join(DIR, "paged.log");
    const c = new McpClient(serverOf("paged", log));
    await c.start();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "sum", "add"]);
    expect(tools.every((t) => t.contractVersion === MCP_TOOL_CONTRACT_VERSION)).toBe(true);
    expect(logLines(log, "list")).toBe(2);
    c.close();
  }, 15_000);

  it("descriptor 只保留 name/description/contractVersion(未知键丢弃)", async () => {
    const c = new McpClient(serverOf("paged"));
    await c.start();
    const tools = await c.listTools();
    for (const t of tools) expect(Object.keys(t).sort()).toEqual(["contractVersion", "description", "name"]);
    expect(tools[0]!.description).toBe("回显");
    expect(tools[1]!.description).toBe(""); // 缺 description 归一为空串
    c.close();
  }, 15_000);

  it("重复 cursor → 停止且不 throw(探针 B)", async () => {
    const log = join(DIR, "dup.log");
    const c = new McpClient(serverOf("dup", log));
    await c.start();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["t1"]);
    expect(logLines(log, "list")).toBe(2); // 第二页发现 cursor 重复即停
    expect(c.listWarnings).toHaveLength(1);
    expect(c.listWarnings[0]).toContain("cursor 重复");
    c.close();
  }, 15_000);

  it("nextCursor 为空串 → 单页停止、无告警", async () => {
    const log = join(DIR, "empty.log");
    const c = new McpClient(serverOf("empty", log));
    await c.start();
    expect((await c.listTools()).map((t) => t.name)).toEqual(["solo"]);
    expect(logLines(log, "list")).toBe(1);
    expect(c.listWarnings).toEqual([]);
    c.close();
  }, 15_000);

  it("nextCursor 非字符串 → 当作缺失停止", async () => {
    const log = join(DIR, "nonstring.log");
    const c = new McpClient(serverOf("nonstring", log));
    await c.start();
    expect((await c.listTools()).map((t) => t.name)).toEqual(["solo"]);
    expect(logLines(log, "list")).toBe(1);
    c.close();
  }, 15_000);

  it(`页数上限 ${MCP_TOOL_LIST_MAX_PAGES} → 无限 cursor 也只请求 10 页(探针 C)`, async () => {
    const log = join(DIR, "endless.log");
    const c = new McpClient(serverOf("endless", log));
    await c.start();
    const tools = await c.listTools();
    expect(tools).toHaveLength(MCP_TOOL_LIST_MAX_PAGES);
    expect(logLines(log, "list")).toBe(MCP_TOOL_LIST_MAX_PAGES);
    expect(c.listWarnings.some((w) => w.includes("页数达到上限"))).toBe(true);
    c.close();
  }, 20_000);

  it(`条数上限 ${MCP_TOOL_LIST_MAX_TOOLS} → 200/页 × 3 页截断到 500`, async () => {
    const log = join(DIR, "bulk.log");
    const c = new McpClient(serverOf("bulk", log));
    await c.start();
    const tools = await c.listTools();
    expect(tools).toHaveLength(MCP_TOOL_LIST_MAX_TOOLS);
    expect(logLines(log, "list")).toBe(3);
    expect(c.listWarnings.some((w) => w.includes(`上限 ${MCP_TOOL_LIST_MAX_TOOLS}`))).toBe(true);
    c.close();
  }, 20_000);

  it("跨页同名去重 + 非法 tools 项丢弃", async () => {
    const c = new McpClient(serverOf("dedupe"));
    await c.start();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["t1", "t2"]);
    c.close();
  }, 15_000);
});

describe("McpClient onClose 幂等", () => {
  it("close() → 恰一次 reason=closed(重复 close 不再触发)", async () => {
    const reasons: string[] = [];
    const c = new McpClient(serverOf("paged"), (r) => reasons.push(r));
    await c.start();
    c.close();
    c.close();
    expect(reasons).toEqual(["closed"]);
  }, 15_000);

  it("server 自行 exit → 恰一次(exit/close 事件不重复回调)", async () => {
    const reasons: string[] = [];
    const c = new McpClient(serverOf("exitAfterInit"), (r) => reasons.push(r));
    await c.start();
    await sleep(300);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBe("exit");
  }, 15_000);

  it("spawn 失败(error 事件)→ 恰一次且 reason=error", async () => {
    const reasons: string[] = [];
    const srv: McpServer = {
      id: "srv-missing",
      name: "missing",
      command: "/nonexistent/mcp-server-m137",
      args: [],
      enabled: true,
      createdAt: Date.now(),
    };
    const c = new McpClient(srv, (r) => reasons.push(r));
    await c.start(500).catch(() => undefined);
    await sleep(300);
    expect(reasons).toEqual(["error"]);
  }, 15_000);
});

describe("McpManager:退出后撤销工具缓存与能力位", () => {
  it("exit → status 失败、缓存撤销,再次 tools() 重新 spawn(探针 D)", async () => {
    const log = join(DIR, "mgrexit.log");
    const st = new McpServerStore(join(DIR, "mcp-mgrexit.json"));
    const sv = st.add({ name: "exit-fixture", command: process.execPath, args: [FIXTURE, "exit", log] }) as McpServer;
    const mgr = new McpManager(st);

 // 初始:未探测 = ok:null
    expect(mgr.statusOf()[sv.id]!.ok).toBeNull();

    const first = await mgr.tools(sv.id);
    expect(first.map((t) => t.name)).toEqual(["echo", "sum"]);
    expect(mgr.statusOf()[sv.id]!.ok).toBe(true);
    expect(logLines(log, "spawn")).toBe(1);

    await sleep(400); // 等 server 退出与 onClose 生效
    const afterExit = mgr.statusOf()[sv.id]!;
    expect(afterExit.ok).toBe(false);
    expect(afterExit.tools).toBe(0);
    expect(afterExit.error).toBe("服务器已退出");

 // 缓存已撤销 → 重新 spawn(否则会直接命中缓存不再 spawn)
    const second = await mgr.tools(sv.id);
    expect(second.map((t) => t.name)).toEqual(["echo", "sum"]);
    expect(logLines(log, "spawn")).toBe(2);
    mgr.closeAll();
  }, 25_000);

  it("callTool 语义不变(tools/call 往返)", async () => {
    const st = new McpServerStore(join(DIR, "mcp-call.json"));
    const sv = st.add({ name: "paged", command: process.execPath, args: [FIXTURE, "paged", ""] }) as McpServer;
    const mgr = new McpManager(st);
    expect(await mgr.callTool(sv.id, "echo", { a: 1 })).toContain("ok:echo");
    mgr.closeAll();
  }, 15_000);

  it("面板 test():连接 + 工具清单仍可用(3 工具)", async () => {
    const st = new McpServerStore(join(DIR, "mcp-test.json"));
    const sv = st.add({ name: "paged", command: process.execPath, args: [FIXTURE, "paged", ""] }) as McpServer;
    const mgr = new McpManager(st);
    const s = await mgr.test(sv.id);
    expect(s.ok).toBe(true);
    expect(s.tools).toBe(3);
    mgr.closeAll();
  }, 20_000);
});
