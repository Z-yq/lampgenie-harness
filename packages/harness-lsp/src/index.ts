/**
 * @lampgenie/lsp — 编辑后 LSP 诊断 + 保存即格式化(step-114 / M108)。
 *
 * 用法(工具编排层):
 *   // 落盘前:采集基线
 *   const baseline = await collectBaselineDiagnostics({ root, absPath, text: oldText, settings });
 *   // 落盘后:只报新增 ERROR
 *   const suffix = await editCheckSuffix({ root, absPath, settings, baseline, baselineText: oldText });
 *
 * 语义:
 * - settings 缺省=关闭(低层);生产配置 coding.lsp 显式传入(缺省 on,见 ConfigSchema)。
 * - server 缺失/崩溃/超时=静默跳过(fail-soft),不阻塞写入。
 * - baseline 未传=写后全量报告(旧行为);baseline=null=采集失败(块带 note);数组=只报新增。
 * - 无诊断=不追加文本;有诊断=追加 `<diagnostics file=…>` 块。
 */
export { checkEditedFile, editCheckSuffix, renderDiagnostics, collectBaselineDiagnostics, subtractBaseline, makeLineMapper } from "./diagnose.js";
export { resolveLspSettings, LSP_DEFAULTS } from "./types.js";
export type {
  BaselineCheckInput,
  DiagnosticItem,
  EditCheckInput,
  EditCheckResult,
  LspSettings,
  NormalizedLspSettings,
  RenderDiagnosticsOptions,
} from "./types.js";
export { disposeAllLspClients, resetLspManagerState } from "./manager.js";
export {
  discoverServer,
  findExecutable,
  languageRouteOf,
  resetServerDiscoveryCache,
  type LanguageFamily,
  type LanguageRoute,
  type ServerSpec,
} from "./servers.js";
export { applyTextEdits, externalFormat, type LspTextEdit } from "./format.js";
export { typescriptDiagnostics, isTypeScriptFile, resetTypescriptModuleCache, warmTypeScriptChecker } from "./typescript.js";
export { MessageDecoder, encodeMessage } from "./framing.js";
export { LspClient } from "./client.js";
