/**
 * @lampgenie/terminal — 持久终端会话。
 * 用法(agent 编排层):
 *   const service = new TerminalSessionService({ audit: (e) => journal.append({ kind: "custom", ... }) });
 *   const tool = createTerminalTool({ service, owner: task.sessionId, root: taskRoot });
 * 分工:run_cmd=一次性命令;terminal=保活/交互式/cwd 状态的连续操作。
 * 零原生依赖:Linux 用系统 `script` 伪 TTY,其它平台回退 stdio 管道。
 */
export { TerminalSessionService } from "./service.js";
export { JobRegistry, JobError } from "./jobs.js";
export { createJobTool, createTerminalTool, type CreateJobToolOptions, type CreateTerminalToolOptions, type TerminalToolLike } from "./tool.js";
export { TerminalError, type TerminalAuditEvent, type TerminalAuditSink } from "./types.js";
export type {
  JobErrorCode,
  JobInfo,
  JobKillInput,
  JobReadInput,
  JobReadResult,
  JobRegistryOptions,
  JobSettledEvent,
  JobStartInput,
  JobStatus,
  JobWaitInput,
} from "./jobs.js";
export type {
  TerminalCloseResult,
  TerminalErrorCode,
  TerminalOpenInput,
  TerminalReadInput,
  TerminalReadResult,
  TerminalSendInput,
  TerminalSendResult,
  TerminalServiceOptions,
  TerminalSessionInfo,
  TerminalSessionStatus,
  TerminalShellKind,
  TerminalWaitReason,
} from "./types.js";
