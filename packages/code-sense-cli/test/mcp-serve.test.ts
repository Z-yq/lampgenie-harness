/**
 * MCP serve 模式测试:
 * ①进程内 serveMain(注入 stdio 三件套)——握手/tools list/tools call 全链;
 * ②sensing 三工具(step-080:code_index_api/state/algo)——stdio 全链+错误路径+CLI↔MCP 同源对照;
 * ③真子进程冒烟(dist bundle 存在时才跑;缺 dist=SKIP,不装假绿)。
 */
import { describe, it, expect, afterAll } from "vitest";
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { serveMain } from "../src/serve.js";
import { createCodeIndexMcp, type CodeIndexMcp } from "../src/mcp-core.js";
import { runCli, type CliIo } from "../src/cli.js";
import { buildC2fIndex, saveIndex } from "@lampgenie/code-sense";

let ws = "";
let mcp: CodeIndexMcp; // autoBuild:false 直调实例(sensing 错误路径与 CLI 同源对照用)

/** 夹具:六件套的索引靶(mod.ts)+ sensing 三工具的行扫描靶(server.ts/gate.ts/model.py,
 * 三者均为 code-sense sensing 既有测试的 proven 形态,step-077 实证可被确定性提取)。 */
async function makeFixture(): Promise<void> {
  if (ws) return; // 幂等:多 describe 共享同一夹具
  ws = mkdtempSync(join(tmpdir(), "csmb-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "mod.ts"), "export function hi(x: number): number { return x; }\nexport function trunk(): number { return hi(1); }\n");
  // api:express Router+use 前缀(sensing-api.test.ts EXPRESS_FILE 同款)
  writeFileSync(join(ws, "src", "server.ts"), [
    'import express from "express";',
    "const app = express();",
    "const router = express.Router();",
    'router.get("/users", listUsers);',
    'app.use("/api", router);',
    "function listUsers(req, res) {}",
    "",
  ].join("\n"));
  // state:switch+联合类型双条件收敛(sensing-state.test.ts F2 同款)
  writeFileSync(join(ws, "src", "gate.ts"), [
    'type GateState = "idle" | "loading" | "ready" | "failed";',
    "",
    "export class Gate {",
    '  private state: GateState = "idle";',
    "",
    "  dispatch(action: string): void {",
    "    switch (this.state) {",
    '      case "idle":',
    '        if (action === "load") this.state = "loading";',
    "        break;",
    '      case "loading":',
    '        if (action === "ok") this.state = "ready";',
    '        else this.state = "failed";',
    "        break;",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n"));
  // algo:torch 模型定义+训练循环(sensing-algo.test.ts TORCH_MODEL 同款)
  writeFileSync(join(ws, "src", "model.py"), [
    "import torch",
    "import torch.nn as nn",
    "from torch.utils.data import DataLoader, Dataset",
    "",
    "class SpeechEncoder(nn.Module):",
    "    def __init__(self):",
    "        super().__init__()",
    "        self.conv = nn.Conv1d(80, 128, 3)",
    "",
    "    def forward(self, x):",
    "        return self.conv(x)",
    "",
    "def train_loop(model, loader):",
    "    opt = torch.optim.Adam(model.parameters())",
    "    for x, y in loader:",
    "        loss = model(x)",
    "        loss.backward()",
    "        opt.step()",
    "",
    "def predict(model, x):",
    "    model.eval()",
    "    with torch.no_grad():",
    "        return model(x)",
    "",
  ].join("\n"));
  saveIndex(ws, await buildC2fIndex(ws));
  mcp = createCodeIndexMcp(ws, { autoBuild: false });
}

// 2026-10-21 E③:MCP 工具面——graph/filegraph 移出 agent 面(mermaid 图给人看,
// 走 CLI symbol --graph/file --graph;分派处理器保留,gateway 直调与 required 校验不受影响)。
// 2026-10-22 P1:+code_index_modules=十二件;2026-10-23:+code_index_branches=十三件;2026-10-26:+code_index_flow=十四件。
const MCP_TOOLS = [
  "code_index_symbol", "code_index_file", "code_index_entrypoints",
  // 2026-10-22:模块视图(清单+跨模块交互矩阵+枢纽/测试面)
  "code_index_modules",
  // 2026-10-26:整仓代码流(module/file/function 三层 + 入口/分层/主干)
  "code_index_flow",
  "code_index_impact",
  "code_index_api", "code_index_state", "code_index_algo",
  // step-089 P1/P3:文件变量类型清单 + 项目底座画像
  "code_index_vars", "code_index_project",
  // 2026-10-21:WS 消息协议表面(协议↔handler↔面板发送/接收)+ 字面量引用面
  "code_index_wire", "code_index_refs",
  // 2026-10-23:分支/循环骨架(条件关系:这个调用在什么条件下发生)
  "code_index_branches",
  // 2026-11-06:概念足迹面(八类表面:这个概念要动的地方齐了吗)
  "code_index_surface",
];

const RPC = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "code_index_symbol", arguments: { name: "trunk" } } }),
  "",
].join("\n");

interface Served {
  lines: string[];
  done: Promise<void>;
}

function driveServe(root: string, rpc: string = RPC): Promise<Served> {
  const chunks: string[] = [];
  const input = Readable.from([rpc]);
  let finishResolve: () => void;
  const done = new Promise<void>((res) => (finishResolve = res));
  serveMain([root], {
    input,
    output: { write: (s: string) => (chunks.push(s), true) },
    log: () => {},
    exit: () => finishResolve(),
  });
  return done.then(() => ({ lines: chunks.join("").trim().split("\n"), done }));
}

function capture(): { io: CliIo; out: () => string } {
  const o: string[] = [];
  return { io: { out: (s) => (o.push(s), undefined), err: () => undefined }, out: () => o.join("\n") };
}

describe("serve(进程内,注入 stdio)", () => {
  it("握手+tools/list 工具面(step-066:+impact;step-080:+api/state/algo;step-089:+vars/project)+tools/call 命中符号", async () => {
    await makeFixture();
    const served = await driveServe(ws);
    expect(served.lines.length).toBe(3);
    const init = JSON.parse(served.lines[0]!);
    expect(init.result.serverInfo.name).toBe("code-sense-cli");
    expect(init.result.protocolVersion).toBe("2024-11-05");
    const tools = JSON.parse(served.lines[1]!);
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toEqual(MCP_TOOLS);
    const call = JSON.parse(served.lines[2]!);
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0].text).toContain("trunk");
  }, 300_000);

  it("未知方法=-32601;坏 JSON 行被吞不炸", async () => {
    const chunks: string[] = [];
    let finishResolve: () => void;
    const done = new Promise<void>((res) => (finishResolve = res));
    const input = Readable.from(["this is not json\n", JSON.stringify({ jsonrpc: "2.0", id: 9, method: "bogus/method" }) + "\n", ""]);
    serveMain([ws], {
      input,
      output: { write: (s: string) => (chunks.push(s), true) },
      log: () => {},
      exit: () => finishResolve(),
    });
    await done;
    const resp = JSON.parse(chunks.join("").trim());
    expect(resp.error.code).toBe(-32601);
  }, 60_000);
});

describe("sensing 三工具(step-080):stdio 全链", () => {
  it("stdio:code_index_api/state/algo 三连 call——异步分派经 serveMain 出真结果(非 Promise 序列化垃圾)", async () => {
    await makeFixture();
    const rpc = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "code_index_api", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "code_index_state", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "code_index_algo", arguments: {} } }),
      "",
    ].join("\n");
    const served = await driveServe(ws, rpc);
    expect(served.lines.length).toBe(4);
    // 响应按 id 关联;三个异步分派并发完成,到达序不保证(JSON-RPC 语义)——按 id 取
    const byId = new Map(served.lines.map((l) => [JSON.parse(l).id as number, JSON.parse(l)]));
    const api = byId.get(2)!;
    expect(api.result.isError).toBe(false);
    expect(api.result.content[0].text).toContain("接口表面:");
    expect(api.result.content[0].text).toContain("GET /api/users");
    expect(api.result.content[0].text).toContain("listUsers");
    const state = byId.get(3)!;
    expect(state.result.isError).toBe(false);
    expect(state.result.content[0].text).toContain("状态机表面: 1 个");
    expect(state.result.content[0].text).toContain("idle, loading, ready, failed");
    expect(state.result.content[0].text).toContain("→ loading");
    const algo = byId.get(4)!;
    expect(algo.result.isError).toBe(false);
    expect(algo.result.content[0].text).toContain("算法画像:");
    expect(algo.result.content[0].text).toContain("model.py");
  }, 120_000);
});

describe("sensing 三工具(step-080):直调错误路径+CLI↔MCP 同源对照", () => {
  it("错误路径:未知仓同 pickForced 文案;未知工具委托 dispatchTool=isError;algo file 参数按文件过滤(2026-10-22)", async () => {
    await makeFixture();
    const ghost = await mcp.dispatchToolAsync("code_index_api", { repo: "ghost" });
    expect(ghost.isError).toBe(false);
    expect(ghost.content[0]!.text).toContain("未知仓: ghost");
    const unknown = await mcp.dispatchToolAsync("code_index_bogus", {});
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("未知工具");
    const noFilter = await mcp.dispatchToolAsync("code_index_algo", {});
    expect(noFilter.content[0]!.text).toContain("model.py");
    // 2026-10-22 P0:file 参数现在真正限定画像文件(旧行为只影响 LLM 导读粒度、确定性面仍全仓)。
    const withFile = await mcp.dispatchToolAsync("code_index_algo", { file: "src/model.py" });
    expect(withFile.isError).toBe(false);
    expect(withFile.content[0]!.text).toContain("src/model.py");
    const ghostFile = await mcp.dispatchToolAsync("code_index_algo", { file: "src/nope.py" });
    expect(ghostFile.isError).toBe(false);
    expect(ghostFile.content[0]!.text).toContain("0 个文件");
  }, 60_000);

  it("CLI↔MCP 同源对照:codesense api/state/algo 输出与 dispatchToolAsync 逐字节相等(同一渲染函数,零漂移)", async () => {
    await makeFixture();
    const cases: [string[], string, Record<string, unknown>][] = [
      [["api"], "code_index_api", {}],
      [["state"], "code_index_state", {}],
      [["algo"], "code_index_algo", {}],
      [["algo", "src/model.py"], "code_index_algo", { file: "src/model.py" }],
    ];
    for (const [argv, tool, args] of cases) {
      const cap = capture();
      const code = await runCli([...argv, "--root", ws, "--no-color", "--quiet"], cap.io);
      const mcpRes = await mcp.dispatchToolAsync(tool, args);
      expect(code).toBe(0);
      expect(cap.out().trim()).toBe(mcpRes.content[0]!.text.trim());
    }
  }, 120_000);
});

describe("工具入参 required 校验(B:缺参/空串/错参数名三态)", () => {
  it("错参数名 → isError:true 且指路 schema 参数名;不进入查询(不再出现「未找到符号: (空)」)", async () => {
    await makeFixture();
    // 缺陷现场复现:code_index_symbol 的 schema 要求 name,调用方传了 symbol
    const wrong = await mcp.dispatchToolAsync("code_index_symbol", { symbol: "hi" });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]!.text).toContain("缺少必填参数 name");
    expect(wrong.content[0]!.text).toContain("期望参数名:name");
    expect(wrong.content[0]!.text).toContain("symbol"); // 指出收到的错误键
    // 关键负面断言:不得再出现「拿空名去查」的误导性输出
    expect(wrong.content[0]!.text).not.toContain("未找到符号");
  }, 60_000);

  it("缺参与空串 → 均 isError:true;正确参数正常命中", async () => {
    await makeFixture();
    const absent = await mcp.dispatchToolAsync("code_index_symbol", {});
    expect(absent.isError).toBe(true);
    expect(absent.content[0]!.text).toContain("缺少必填参数 name");
    const blank = await mcp.dispatchToolAsync("code_index_symbol", { name: "   " });
    expect(blank.isError).toBe(true);
    expect(blank.content[0]!.text).toContain("缺少必填参数 name");
    const nonString = await mcp.dispatchToolAsync("code_index_symbol", { name: 42 });
    expect(nonString.isError).toBe(true);
    // 正确参数:正常命中,不受校验影响
    const ok = await mcp.dispatchToolAsync("code_index_symbol", { name: "hi" });
    expect(ok.isError).toBe(false);
    expect(ok.content[0]!.text).toContain("hi");
  }, 60_000);

  it("13 个工具的 required 全部生效(不是只修 symbol)", async () => {
    await makeFixture();
    const cases: [string, Record<string, unknown>, string][] = [
      ["code_index_symbol", {}, "name"],
      ["code_index_file", {}, "path"],
      ["code_index_graph", {}, "name"],
      ["code_index_filegraph", {}, "path"],
      ["code_index_impact", {}, "name"],
      ["code_index_vars", {}, "file"],
      ["code_index_refs", {}, "literal"],
      ["code_index_surface", {}, "concept"],
    ];
    for (const [tool, args, key] of cases) {
      const r = await mcp.dispatchToolAsync(tool, args);
      expect(r.isError, `${tool} 缺 ${key} 应 isError`).toBe(true);
      expect(r.content[0]!.text).toContain(`缺少必填参数 ${key}`);
    }
    // 无 required 的工具(entrypoints/api/state/algo/project)不受影响,空参照常出结果
    const noReq = ["code_index_entrypoints", "code_index_api", "code_index_state", "code_index_algo", "code_index_project", "code_index_wire"];
    for (const tool of noReq) {
      const r = await mcp.dispatchToolAsync(tool, {});
      expect(r.content[0]!.text, `${tool} 不应报缺参`).not.toContain("缺少必填参数");
    }
  }, 120_000);

  it("CLI 同步入口(dispatchTool)同一校验:querySymbolCmd 不再拿空名查询", async () => {
    await makeFixture();
    const direct = mcp.dispatchTool("code_index_symbol", { symbol: "hi" });
    expect(direct.isError).toBe(true);
    expect(direct.content[0]!.text).toContain("缺少必填参数 name");
  }, 60_000);
});

describe("serve(真子进程 dist bundle 冒烟)", () => {
  it("node dist/cli.js serve 全链(无 dist=SKIP)", async () => {
    const distCli = join(import.meta.dirname ?? ".", "..", "dist", "cli.js");
    const target = existsSync(distCli) ? distCli : null;
    if (!target) {
      console.warn("SKIP:dist/cli.js 未构建(先 pnpm build)——真子进程冒烟不装假绿");
      return;
    }
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [target, "serve", ws], { timeout: 60_000 }, (err, stdout) => {
        // stdin 关闭后 serve 主动退出:err 可能为 null;stdout 是协议流
        if (err && !stdout) reject(err);
        else resolve(stdout as string);
      });
      child.stdin!.end(RPC);
    });
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!).result.serverInfo.name).toBe("code-sense-cli");
    expect(JSON.parse(lines[2]!).result.content[0].text).toContain("trunk");
  }, 120_000);
});

afterAll(() => {
  if (ws) rmSync(ws, { recursive: true, force: true });
}, 60_000);
