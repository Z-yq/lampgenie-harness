/**
 * 数据工具→agent 工具面桥接(提案「数据工具无执行通道,注册后 agent 不可达」)。
 * data-tool-store 注册的工具(nightly_status 等)此前只有 CLI/面板能看,agent 无法调用。
 * 本桥创建 data_tool 工具:list 列出可用;execute 按名字执行(handler.kind=command 走终端)。
 */
import { resolveDataTool, listToolStore } from "./data-tool-store.js";
import type { Tool } from "@lampgenie/runtime/agent/loop";

export function dataToolBridge(root: string): Tool {
  return {
    name: "data_tool",
    description:
      "查询 RSI 数据台账(夜间运行状态/实验进度/cohort 指标等)。action=list 列出可用工具;" +
      "action=execute name=<工具名> args=<JSON> 执行指定工具。这是读 .genie/rsi 台账的标准入口," +
      "不要用 read_file 裸扫 .jsonl。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "execute"], description: "list=列出可用数据工具;execute=执行指定工具" },
        name: { type: "string", description: "execute 时必填:数据工具名(如 nightly_status)" },
        args: { type: "object", description: "execute 时可选:工具参数(按 schema)" },
      },
      required: ["action"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { action?: string; name?: string; args?: Record<string, unknown> };
      if (a.action === "list") {
        const store = listToolStore(root);
        const tools = (store?.data ? Object.values(store.data) : []) as Array<{ name?: string; description?: string; handler?: { kind?: string } }>;
        if (tools.length === 0) return "(无已注册数据工具;用 scripts/data-tool.mts --register 注册)";
        return tools.map((t) => `- ${t.name}: ${t.description ?? "(无描述)"} [handler: ${t.handler?.kind ?? "?"}]`).join("\n");
      }
      if (a.action === "execute") {
        const name = String(a.name ?? "");
        if (name === "") return "错误:execute 需要 name";
        const resolved = resolveDataTool(root, name);
        if (!resolved.spec) return `未找到数据工具 "${name}"(用 action=list 查看)`;
 // v1:handler.kind=command → 直接返回 spec(告诉 agent 用 terminal 执行引用命令)
        const handler = (resolved.spec as { handler?: { kind?: string; ref?: string } }).handler;
        if (handler?.kind === "command" && typeof handler.ref === "string") {
          return `数据工具 "${name}" 是命令型,请用 terminal 执行:\n${handler.ref}`;
        }
 // 其他 handler 类型(skill/mcp)或无 handler → 返回 spec 供参考
        return JSON.stringify(resolved.spec, null, 2).slice(0, 4000);
      }
      return `未知 action "${a.action}";可选 list/execute`;
    },
  };
}
