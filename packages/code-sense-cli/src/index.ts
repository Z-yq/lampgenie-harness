/**
 * code-sense-cli 公共 API(程序化消费面)。
 * CLI 体验走 bin(codesense);被其它工具集成时从这里导入。
 */
export { runCli, defaultIo, HELP, VERSION, type CliIo } from "./cli.js";
export {
  createCodeIndexMcp, discoverRoots, CODE_INDEX_TOOLS,
  formatSymbolHit, formatFileNodes, formatEntrypointsBlock,
  type CodeIndexMcp, type RepoState, type McpToolResult,
} from "./mcp-core.js";
export { buildIndexWithReuse, fileChangedSince, type BuildOutcome } from "./incremental.js";
export {
  loadRegistry, saveRegistry, upsertRoot, removeRoot, resolveProjectRoot, overlappingRoots,
  registryPath, registryDir, normalizeRoot, loadSidecar, saveSidecar, sidecarPath,
  type Registry, type RegistryEntry, type FingerprintSidecar,
} from "./registry.js";
export { runDoctor, type DoctorCheck } from "./doctor.js";
export { serveMain, isMainEntry, type ServeOptions } from "./serve.js";
export { reviewCommand, renderMarkdown, renderJson, resolveReviewRoot, ReviewUsageError, type ReviewCmdResult, type ReviewCmdOpts } from "./review.js";
export { reviewLlmFromEnv, makeReviewLlm, type ReviewLlmEnv } from "./review-llm.js";
