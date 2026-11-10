#!/usr/bin/env node
/**
 * genie code-index MCP server(stdio)——把 code-sense 静态调用索引作为工具暴露给任意 MCP 客户端
 * (首要客户端:ZCode)。协议=JSON-RPC 2.0 over stdio(MCP 2024-11-05 基线)。
 *
 * 工具面(六件读 .genie/sense-index 静态产物,毫秒级;索引缺失/过期自动后台重建;
 * step-080 起加 api/state/algo 三件=step-077 sensing 行扫描,不触发索引构建):
 *   code_index_symbol(name, repo?)      符号定义+调用者+被调者(跨仓合并)
 *   code_index_file(path, repo?)        文件符号表(含 code2flow 分类/出入度)
 *   code_index_entrypoints(repo?)       入口函数清单(trunk,缺省逐仓分组)
 *   code_index_graph(name, repo?)       符号邻域 code2flow mermaid 图
 *   code_index_filegraph(path, repo?)   文件级 code2flow 图
 *   code_index_impact(name, repo?)      改动影响面清单(step-066)
 *   code_index_api(repo?)               HTTP 接口表面+OpenAPI 对账(step-077/080)
 *   code_index_state(repo?)             状态机表面(step-077/080)
 *   code_index_algo(file?, repo?)       算法画像(step-077/080)
 *   code_index_wire(root?, repo?, changed?) WS 消息协议表面(协议声明↔handler↔面板发送/接收三处对账)
 *
 * 多仓路由:repo 参数/路径仓前缀/跨仓自动路由,见 code-index-core.ts。
 *
 * 用法: node code-index-mcp.mjs <项目根>(缺省=cwd)
 * 环境变量: GENIE_SENSE_INDEX_ROOT 可覆盖项目根。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCodeIndexMcp } from "./code-index-core";

const ROOT = resolve(process.env.GENIE_SENSE_INDEX_ROOT || process.argv[2] || process.cwd());

// 仅作为主入口运行时启动 stdio 循环;被测试/其它模块 import 时只暴露工厂。
const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = argv1 !== "" && import.meta.url === pathToFileURL(argv1).href;

if (isMain) {
  const mcp = createCodeIndexMcp(ROOT);

  let buf = "";
  // 在飞异步分派计数(step-080):api/state/algo 行扫描秒级,一次性管道场景 stdin 关闭
  // 早于响应写出——直接 exit(0) 会吃掉在飞响应,先等清零再退。
  let pendingCalls = 0;
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      handleLine(line);
    }
  });
  process.stdin.on("end", () => {
    const waitPending = () => {
      if (pendingCalls <= 0) { process.exit(0); return; }
      setTimeout(waitPending, 25);
    };
    waitPending();
  });

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  function handleLine(line) {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;
    const isNotify = id === undefined || id === null;
    try {
      if (method === "initialize") {
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "genie-code-index", version: "1.1.0" } } });
        return;
      }
      if (method === "notifications/initialized") return;
      if (method === "ping") { if (!isNotify) send({ jsonrpc: "2.0", id, result: {} }); return; }
      if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: mcp.tools } });
        return;
      }
      if (method === "tools/call") {
        // step-080:api/state/algo 走 async sensing 分派,统一 dispatchToolAsync(其余工具
        // 内部委托同步 dispatchTool 行为零变)。响应按 id 关联,异步到达不破坏 stdio 协议。
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
  process.stderr.write(`[genie-code-index] root=${ROOT} 多仓路由=v1.1\n`);
}
