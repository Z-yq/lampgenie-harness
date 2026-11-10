/**
 * 任务模型与状态机。契约对齐 deepseek-harness 的 task manager,
 * 简化为自研可维护的最小完备集。
 */

export type TaskState =
  | "queued"       // 已入队,等待调度
  | "running"      // 正在执行
  | "blocked"      // 被资源锁/权限等阻塞
  | "interrupted"  // 被外因打断(网关重启/OOM),非人为取消;可续跑(三次 OOM 实测确认痛点)
  | "done"         // 成功完成
  | "failed"       // 失败终态
  | "cancelled";   // 被取消终态

/** 终态集合:一旦进入不再变迁。interrupted 非终态(可恢复)。 */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["done", "failed", "cancelled"]);

/** 合法的状态迁移表。from -> 允许的 to 集合。 */
const TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  // queued 可直接到终态(取消一个尚未开始的任务/启动即失败)。
  // queued 不入 interrupted:未开始执行的任务重启后原样重排队,无需"恢复"。
  queued:      new Set(["running", "done", "failed", "cancelled"]),
  running:     new Set(["blocked", "interrupted", "done", "failed", "cancelled"]),
  blocked:     new Set(["running", "interrupted", "cancelled"]),
  // interrupted 由网关重启清算产生;恢复=重新 running(或经续跑重提后旧任务转 cancelled/failed)。
  interrupted: new Set(["running", "cancelled", "failed"]),
  done:        new Set(),
  failed:      new Set(),
  cancelled:   new Set(),
};

export interface Task {
  id: string;
  /** 创建者的 session。 */
  sessionId: string;
  /** 任务描述(给 agent / 用户看)。 */
  instruction: string;
  state: TaskState;
  /** 期望在哪个节点执行;缺省 = 本地。 */
  targetNode?: string;
  /** 资源标签,用于 BuildLock 等互斥判断。 */
  resourceTags?: string[];
  /** 创建时间。 */
  createdAt: number;
  /** 最近一次状态变迁时间。 */
  updatedAt: number;
  /** 结果摘要(done/failed 时填)。 */
  result?: string;
  /** 幂等键:同一 key 不重复建任务。 */
  idempotencyKey?: string;
 /** 凭证引用名( tunnel 委派):只传名字,值由目标节点本地解析(红线:值不过网关)。 */
  credentialRef?: string;
 /** 项目 id:workdir 按项目解析;缺省=激活项目/回退 harness 根。 */
  projectId?: string;
 /** F3 自定义分组:用户桶,正交元数据不改状态机;缺省无。 */
  group?: string;
  /** 显示标题(F3):缺省显示 instruction 截断;重命名即改此字段。 */
  title?: string;
 /** (ref session-mgmt.ts:132-136 custom 粘性):用户改过名=true;此后该会话行
   *  标题不再被新任务的 instruction 派生标题顶掉;清空重命名=抹掉标记回默认派生。 */
  titleCustom?: boolean;
  /** 置顶(F3):侧栏置顶区,正交于状态的元数据。 */
  pinned?: boolean;
  /** 归档(F3):从默认列表隐藏;正交元数据,不改变终态。 */
  archived?: boolean;
 /** 本次运行起点(「已工作 X 分 X 秒」):进入 running 时刷新;面板用 now-startedAt 实时计时。 */
  startedAt?: number;
 /** 附件:已上传文件;agent 侧注入任务书 + vision 通道(image/*)。 */
  attachments?: { name: string; path: string; mime?: string; size?: number }[];
  /** 任务进展(TaskSupervisor.touch 写入):面板防御式读取,全部字段可选;正交元数据,不改状态机。 */
  progress?: { phase?: string; step?: number; note?: string; at?: number };
}

/** 校验一次状态迁移是否合法。 */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].has(to);
}

/** 迁移;非法则抛错。返回新对象(不可变)。 */
export function transition(task: Task, to: TaskState, result?: string): Task {
  if (!canTransition(task.state, to)) {
    throw new Error(`非法任务状态迁移: ${task.state} -> ${to} (task ${task.id})`);
  }
  return {
    ...task, state: to, updatedAt: Date.now(),
    ...(to === "running" ? { startedAt: Date.now() } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}
