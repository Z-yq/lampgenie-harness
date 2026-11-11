/**
 * 任务种类(kind)封闭枚举与逐类能力表。
 * 设计口径:
 * - **纯逻辑、零 IO**:不读环境、不碰文件/journal/时间;同输入同输出(确定性)。
 * - **不 throw**:任何脏输入(undefined/null/非字符串/未知词)都由调用方拿到
 * `{kind, normalized:false, original}` 的显式回落结果,而不是异常或静默换值。
 * - **不可变**:枚举与能力表在模块加载时冻结;能力位只能整体替换,不能就地改写。
 * - **为什么 reminder 不能写文件**:提醒类任务由定时器在用户不在场时触发,没有当场审批
 * 与对象化交付物;一旦允许写文件/起终端,一次误触发的提醒就能改工作区、起长驻进程,
 * 用户无从当场拦截。故 reminder/scheduled_task 固定 canWriteFiles=false、canUseTerminal=false、
 * canSpawnSubagent=false,只保留只读工具 + 最小生命周期三件(todo_write/task_phase/ask_user)。
 */

/** 任务种类封闭枚举(新增成员必须同时补能力表,类型层强制)。 */
export const TASK_KINDS = Object.freeze([
	"user",
	"system",
	"reminder",
	"scheduled_task",
	"subagent",
	"workflow",
	"meeting",
	"automation",
] as const);

export type TaskKind = (typeof TASK_KINDS)[number];

/** 记忆注入域:project=项目长期记忆;session=仅会话域;none=不注入。 */
export type TaskMemoryScope = "project" | "session" | "none";

/** kindGuard 的动作面(与工具类别一一对应,便于审计口径统一)。 */
export type TaskKindGuardAction = "spawn_subagent" | "terminal" | "write_file" | "memory_project";

export interface TaskKindCapabilities {
	readonly canSpawnSubagent: boolean;
	readonly canUseTerminal: boolean;
	readonly canWriteFiles: boolean;
	readonly memoryScope: TaskMemoryScope;
	/** 最小生命周期工具:非空=工具面收敛为「这些 + 只读工具」;空=不收敛。 */
	readonly minimalLifecycleTools: string[];
	/** 终态是否对用户公告(subagent/workflow 的完成由父任务消费,不重复打扰)。 */
	readonly canAnnounce: boolean;
}

function freezeTools(list: string[]): string[] {
	// 运行时冻结(类型仍是 string[],保持外部消费签名简单)。
	return Object.freeze(list) as unknown as string[];
}

function fullCapabilities(memoryScope: TaskMemoryScope): TaskKindCapabilities {
	return Object.freeze({
		canSpawnSubagent: true,
		canUseTerminal: true,
		canWriteFiles: true,
		memoryScope,
		minimalLifecycleTools: freezeTools([]),
		canAnnounce: true,
	});
}

function readOnlyCapabilities(memoryScope: TaskMemoryScope): TaskKindCapabilities {
	return Object.freeze({
		canSpawnSubagent: false,
		canUseTerminal: false,
		canWriteFiles: false,
		memoryScope,
		minimalLifecycleTools: freezeTools([]),
		canAnnounce: true,
	});
}

function reminderCapabilities(): TaskKindCapabilities {
	return Object.freeze({
		canSpawnSubagent: false,
		canUseTerminal: false,
		canWriteFiles: false,
		memoryScope: "session" as const,
		minimalLifecycleTools: freezeTools(["todo_write", "task_phase", "ask_user"]),
		canAnnounce: true,
	});
}

/** 逐类能力表:键集必须与 TASK_KINDS 完全一致(Record<TaskKind,...> 类型层强制)。 */
export const TASK_KIND_CAPABILITIES: Readonly<Record<TaskKind, TaskKindCapabilities>> = Object.freeze({
	user: fullCapabilities("project"),
	system: fullCapabilities("project"),
	reminder: reminderCapabilities(),
	scheduled_task: reminderCapabilities(),
	subagent: Object.freeze({ ...fullCapabilities("session"), canAnnounce: false }),
	workflow: Object.freeze({ ...fullCapabilities("session"), canAnnounce: false }),
	meeting: readOnlyCapabilities("project"),
	automation: fullCapabilities("project"),
});

export type TaskKindCapabilityCode = "OK" | "UNKNOWN_KIND";

export interface NormalizedTaskKind {
	readonly kind: TaskKind;
	/** true=原样命中枚举;false=发生了回落(fallback),调用方应留痕而不是当成功。 */
	readonly normalized: boolean;
	/** 原始输入(非字符串按 String 归一;null/undefined 进空串),供审计对账。 */
	readonly original: string;
}

function isTaskKind(value: unknown): value is TaskKind {
	return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

/**
 * 归一任务种类:已知词原样返回;未知/空 → fallback(缺省 user)且 normalized=false。
 * 不 throw、不改写 fallback(非法 fallback 再回落 user)。
 */
export function normalizeTaskKind(raw: unknown, options: { fallback?: unknown } = {}): NormalizedTaskKind {
	const original = typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : String(raw);
	const trimmed = original.trim();
	if (isTaskKind(trimmed)) return { kind: trimmed, normalized: true, original };
	const fallback: TaskKind = isTaskKind(options.fallback) ? options.fallback : "user";
	return { kind: fallback, normalized: false, original };
}

export interface TaskKindCapabilityLookup {
	/** 实际生效的 kind(未知时=回落后的 kind)。 */
	readonly kind: TaskKind;
	readonly capabilities: TaskKindCapabilities;
	readonly code: TaskKindCapabilityCode;
}

/** 取能力表:未知 kind fail-safe 到 user 能力,并以 UNKNOWN_KIND 显式暴露(不静默)。 */
export function taskKindCapabilities(raw: unknown): TaskKindCapabilityLookup {
	const normalized = normalizeTaskKind(raw);
	const kind = normalized.kind;
	return {
		kind,
		capabilities: TASK_KIND_CAPABILITIES[kind],
		code: normalized.normalized ? "OK" : "UNKNOWN_KIND",
	};
}

export interface TaskKindGuardVerdict {
	readonly allow: boolean;
	readonly code: "OK" | "KIND_DENY";
}

/** 逐动作能力判定(不 throw;未知动作 fail-closed)。 */
export function kindGuard(raw: unknown, action: TaskKindGuardAction): TaskKindGuardVerdict {
	const capabilities = taskKindCapabilities(raw).capabilities;
	let allow = false;
	switch (action) {
		case "spawn_subagent":
			allow = capabilities.canSpawnSubagent;
			break;
		case "terminal":
			allow = capabilities.canUseTerminal;
			break;
		case "write_file":
			allow = capabilities.canWriteFiles;
			break;
		case "memory_project":
			allow = capabilities.memoryScope === "project";
			break;
		default:
			allow = false;
			break;
	}
	return { allow, code: allow ? "OK" : "KIND_DENY" };
}

/** 子代理族工具(委派与子代理运维)。 */
export const KIND_SPAWN_TOOLS: readonly string[] = Object.freeze([
	"spawn_subagent",
	"steer_agent",
	"resume_agent",
	"stop_agent",
	"list_agents",
]);

/** 终端/命令族工具(run_cmd 即 exec 类别名)。 */
export const KIND_TERMINAL_TOOLS: readonly string[] = Object.freeze(["terminal", "run_cmd"]);

/** 写类工具(board_upsert 落板同样是写盘)。 */
export const KIND_WRITE_TOOLS: readonly string[] = Object.freeze([
	"write_file",
	"edit_file",
	"apply_patch",
	"board_upsert",
]);

/** 最小生命周期收敛时仍保留的只读工具(read_file/glob/grep/code_sense/tool_view 等)。 */
export const KIND_READONLY_TOOLS: readonly string[] = Object.freeze([
	"read_file",
	"glob",
	"grep",
	"code_sense",
	"tool_view",
	"todo_write",
	"task_phase",
	"ask_user",
]);

export interface TaskKindToolFilterResult {
	readonly kept: string[];
	readonly removed: string[];
}

/**
 * 按能力位过滤工具名(纯函数):先按 spawn/terminal/write 三类 deny 剔除;
 * minimalLifecycleTools 非空时再收敛为「minimal + 只读工具」。
 * 返回 kept/removed 保持输入顺序,确定性。
 */
export function filterToolNamesByKindCapabilities(
	names: readonly string[],
	capabilities: TaskKindCapabilities): TaskKindToolFilterResult {
	const denied = new Set<string>();
	if (!capabilities.canSpawnSubagent) for (const name of KIND_SPAWN_TOOLS) denied.add(name);
	if (!capabilities.canUseTerminal) for (const name of KIND_TERMINAL_TOOLS) denied.add(name);
	if (!capabilities.canWriteFiles) for (const name of KIND_WRITE_TOOLS) denied.add(name);
	const minimal = capabilities.minimalLifecycleTools;
	const allowed = minimal.length > 0 ? new Set<string>([...minimal, ...KIND_READONLY_TOOLS]) : null;
	const kept: string[] = [];
	const removed: string[] = [];
	for (const name of names) {
		const drop = denied.has(name) || (allowed !== null && !allowed.has(name));
		if (drop) removed.push(name);
		else kept.push(name);
	}
	return { kept, removed };
}
