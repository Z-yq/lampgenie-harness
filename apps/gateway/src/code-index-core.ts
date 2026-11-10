/**
 * code-index MCP 核心(薄壳, 起单一真相迁移至 @lampgenie/code-sense-cli/mcp-core)。
 * 原实现(工具面定义/多仓路由/查询分派/文本格式化)整体迁入 code-sense-cli 包,与独立 CLI、
 * `codesense serve` MCP 模式共用同一份;gateway 只保留再导出。
 * 行为等价由两处测试锚定:code-sense-cli 的 mcp-core 套件 + 本仓 apps/gateway/test/code-index-mcp.test.ts
 * (不经修改原样运行——它 import 的就是本薄壳)。
 */
export {
  discoverRoots, CODE_INDEX_TOOLS, createCodeIndexMcp,
  type RepoState, type McpToolResult, type CodeIndexMcp,
} from "@lampgenie/code-sense-cli/mcp-core";
