/**
 * 启动期看门狗阶段租约(纯逻辑,零 IO、无时钟依赖:时间/CPU 全注入)。
 * 【为什么阶段证据比总超时更可诊断】
 * 旧的 ready 等待只有一个总时长:超时之后只知道「worker 没起来」,不知道它卡在 loadConfig
 * 读文件、executor 装配、还是 providers/MCP 网络往返——四次冻结收割全部无证据定因的教训。
 * 阶段租约把启动切成 spawn → config → executor → providers → loop-ready 五段:
 * - 每段进入时刻与停留时长都有记录 → 超时判决读「最后推进到哪一段、该段停了多久」,
 * 证据落 journal,复盘直接看到卡点,不用猜;
 * - 阶段刚推进过(stageElapsed 小)= 还在干活,先重武装一次窗口(RETRY),不急着杀;
 * - 阶段长停且 CPU 空转 = 真卡住(NO_PROGRESS);
 * - 阶段长停但 CPU 持续高 = 同步计算/编译还在烧(CPU_BUSY),这时候杀是误伤,
 * 所以必须「连续 cpuFallbackLimit 次采样都高且无阶段推进」才判 CPU_BUSY 杀。
 * CPU 证据缺失(/proc 不可读、非 Linux、进程已退)时退回 NO_PROGRESS——不能因为读不到
 * CPU 就永不收割。所有方法不 throw:调用方在 ready 定时器异常路径上也不能被打断。
 */

/** 启动阶段(只允许按此顺序向前推进)。 */
export const STARTUP_STAGES = ["spawn", "config", "executor", "providers", "loop-ready"] as const;
export type StartupStage = (typeof STARTUP_STAGES)[number];

/** 判决码。KILL 预留给调用方统计用;具体杀因由 CPU_BUSY / NO_PROGRESS 表达。 */
export const STARTUP_CODES = ["OK", "WAITING", "NO_PROGRESS", "CPU_BUSY", "RETRY", "KILL"] as const;
export type StartupCode = (typeof STARTUP_CODES)[number];

/** begin 可能返回 INVALID(阶段回退/未知阶段),它不属于判决码集合,故单列。 */
export type StartupVerdictCode = StartupCode | "INVALID";

/** CPU 高判定线(百分比)。 */
const CPU_HIGH_PERCENT = 80;
/** 重武装次数上限:只重武装一次(第二次超时即杀,probe C 口径)。 */
const RETRY_LIMIT = 1;

export interface StartupLeaseOptions {
 /** 总启动窗口(ms;从 begin("spawn") 起算,retry 时整窗重武装)。 */
  timeoutMs: number;
 /** 当前阶段停留多久以内仍算「刚推进过」可取 RETRY;缺省 timeoutMs/2。 */
  stageTimeoutMs?: number;
 /** CPU 高连续采样多少次才判 CPU_BUSY(缺省 3)。 */
  cpuFallbackLimit?: number;
 /** 时钟注入(缺省 Date.now;测试注入固定时钟)。 */
  now?: () => number;
}

export interface StartupBeginResult {
  ok: boolean;
  code: StartupVerdictCode;
 /** 当前生效阶段(回退被拒时=原阶段)。 */
  stage: StartupStage;
 /** 前一阶段(首次 begin 为 null)。 */
  previous: StartupStage | null;
 /** 该阶段进入时刻。 */
  enteredAt: number;
 /** 自租约窗口起点到本次 begin 的毫秒数。 */
  elapsedMs: number;
}

export interface StartupSampleInput {
 /** CPU 百分比(0~100);undefined=无 CPU 证据。 */
  cpuPercent?: number;
 /** 采样时刻(缺省 now)。 */
  at?: number;
}

export interface StartupVerdict {
  action: "wait" | "retry" | "kill";
  code: StartupVerdictCode;
  stage: StartupStage;
 /** 自窗口起点(最近一次重武装)起算的毫秒数。 */
  elapsedMs: number;
 /** 当前阶段停留毫秒数。 */
  stageElapsedMs: number;
 /** 人类可读判据(直接进 journal/日志)。 */
  reason: string;
}

export interface StartupEvidence {
 /** 已进入阶段(按推进顺序;每项带进入时刻与相对停留时长)。 */
  stages: { stage: StartupStage; enteredAt: number; elapsedMs: number }[];
  lastStage: StartupStage;
 /** 已用重武装次数。 */
  retries: number;
 /** sample 调用总次数(含无 CPU 证据的采样)。 */
  cpuSamples: number;
 /** 最近一次判决码(未采样过=WAITING)。 */
  code: StartupVerdictCode;
}

/** 线程栈/进程法证建议(纯函数:只给可执行命令与路径,不执行任何 IO)。 */
export interface ThreadStackHint {
  pid: number | null;
  commands: string[];
  paths: { procTaskStack: string; procTaskStat: string; nodeReport: string };
  note: string;
}

/**
 * 给「立即杀之前的取证」一份可直接照抄的命令与路径建议。
 * /proc/<pid>/task/<tid>/stack 能看到内核栈(需 root/CAP_SYS_ADMIN);Node 侧用 SIGUSR2
 * 生成诊断报告(默认写 cwd,可用 NODE_OPTIONS=--report-directory 指定)。
 */
export function threadStackHint(pid: number | undefined): ThreadStackHint {
  const valid = typeof pid === "number" && Number.isFinite(pid) && pid > 0;
  const p = valid ? Math.floor(pid) : null;
  const base = p === null ? "/proc/<pid>" : `/proc/${p}`;
  return {
    pid: p,
    commands: [
      `cat ${base}/task/*/stack 2>/dev/null || true   # 内核栈,需 root/CAP_SYS_ADMIN;读不到=权限不足,不影响收割`,
      `for f in ${base}/task/*/stat; do awk '{print $1, $2, $3}' "$f"; done   # 线程态分布(D=不可中断 IO)`,
      `kill -USR2 ${p ?? "<pid>"}   # Node 诊断报告:生成 report.<pid>.*.json`,
    ],
    paths: {
      procTaskStack: `${base}/task/*/stack`,
      procTaskStat: `${base}/task/*/stat`,
      nodeReport: `report.${p ?? "<pid>"}.*.json(node --report 缺省写 cwd;或 NODE_OPTIONS=--report-directory=<dir>)`,
    },
    note: "取证只读;stack 通常需要特权,读不到时以线程 stat 与 node report 为准。",
  };
}

/**
 * 启动阶段租约状态机(不可变语义:所有返回值都是新快照,外部改动不影响内部状态)。
 * 时间/CPU 全注入 → 单测可完全确定。
 */
export class StartupLease {
  private readonly timeoutMs: number;
  private readonly stageTimeoutMs: number;
  private readonly cpuFallbackLimit: number;
  private readonly now: () => number;

  private readonly createdAt: number;
  private stageIndex = -1;
  private lastStage: StartupStage = STARTUP_STAGES[0];
  private stageEnteredAt: number;
  private readonly entered: { stage: StartupStage; enteredAt: number; count: number }[] = [];
  private retries = 0;
  private cpuSamples = 0;
  private cpuBusyStreak = 0;
 /** 上一拍采样时的阶段索引(用于判「两拍之间有无阶段推进」)。 */
  private lastSampleStageIndex = -1;
  private windowStartAt: number;
  private lastSampleAt: number | undefined;
  private code: StartupVerdictCode = "WAITING";

  constructor(opts: StartupLeaseOptions) {
    this.now = opts.now ?? Date.now;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000;
    const stageT = Number(opts.stageTimeoutMs);
    this.stageTimeoutMs = Number.isFinite(stageT) && stageT >= 0 ? stageT : Math.max(1, Math.floor(this.timeoutMs / 2));
    const cpuLimit = Math.floor(Number(opts.cpuFallbackLimit));
    this.cpuFallbackLimit = Number.isFinite(cpuLimit) && cpuLimit >= 1 ? cpuLimit : 3;
    this.createdAt = this.now();
    this.windowStartAt = this.createdAt;
    this.stageEnteredAt = this.createdAt;
  }

 /** 阶段推进。只允许向前(spawn→…→loop-ready);回退/未知阶段→{ok:false,code:"INVALID"}。 */
  begin(stage: StartupStage, at?: number): StartupBeginResult {
    const now = typeof at === "number" && Number.isFinite(at) ? at : this.now();
    const idx = (STARTUP_STAGES as readonly string[]).indexOf(stage);
    const previous = this.stageIndex >= 0 ? this.lastStage : null;
    const base = { stage: this.lastStage, previous, enteredAt: this.stageEnteredAt, elapsedMs: Math.max(0, now - this.windowStartAt) };
    if (idx < 0 || idx < this.stageIndex) {
 // 回退=调用方状态机 bug 或乱序上报;不修改任何状态,交调用方记录。
      return { ok: false, code: "INVALID", ...base };
    }
    if (idx === this.stageIndex) {
 // 幂等:同阶段重复上报(worker 的 loop-ready 先走 progress 再走 ready)不重复记账。
      return { ok: true, code: "OK", ...base };
    }
    this.stageIndex = idx;
    this.lastStage = stage;
    this.stageEnteredAt = now;
 // 首次进入(spawn)同时锚定总窗口起点:显式 at 比构造时刻早(host 用进程 startedAt)时
 // 以阶段进入时刻为准,避免「窗口起点在将来」导致永久 WAITING。
    if (idx === 0) this.windowStartAt = now;
    const seen = this.entered.find((e) => e.stage === stage);
    if (seen) seen.count++;
    else this.entered.push({ stage, enteredAt: now, count: 1 });
 // 阶段推进=在干活:CPU 忙碌「连续」计数断链。
    this.cpuBusyStreak = 0;
    this.lastSampleStageIndex = idx;
    return { ok: true, code: "OK", stage, previous, enteredAt: now, elapsedMs: Math.max(0, now - this.windowStartAt) };
  }

 /**
 * 采样判决:
 * - 已 loop-ready → wait/OK(调用方不应再判);
 * - 未超时 → wait/WAITING;
 * - 超时且当前阶段刚推进(阶段停留 < stageTimeoutMs)→ retry/RETRY(只重武装一次);
 * - 超时且 CPU 高但未达连续上限 → wait/WAITING(仍在计算,继续观察);
 * - 超时且 CPU 连续 ≥ cpuFallbackLimit 次高且无阶段推进 → kill/CPU_BUSY;
 * - 其余(CPU 不忙/无 CPU 证据)→ kill/NO_PROGRESS。
 */
  sample(input: StartupSampleInput = {}): StartupVerdict {
    const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : this.now();
    this.cpuSamples++;
    this.lastSampleAt = at;
    const stage = this.lastStage;
    const elapsedMs = Math.max(0, at - this.windowStartAt);
    const stageElapsedMs = Math.max(0, at - this.stageEnteredAt);
    if (stage === "loop-ready") {
      this.code = "OK";
      return { action: "wait", code: "OK", stage, elapsedMs, stageElapsedMs, reason: "loop-ready 已上报,启动完成" };
    }
    if (elapsedMs < this.timeoutMs) {
      this.code = "WAITING";
      return { action: "wait", code: "WAITING", stage, elapsedMs, stageElapsedMs, reason: `启动中(${stage}):已等待 ${elapsedMs}ms/${this.timeoutMs}ms` };
    }
 // 超时:先判「两拍之间有没有阶段推进」,维护 CPU 连续忙碌计数。
    const cpuHigh = typeof input.cpuPercent === "number" && Number.isFinite(input.cpuPercent) && input.cpuPercent >= CPU_HIGH_PERCENT;
    const advanced = this.lastSampleStageIndex >= 0 && this.lastSampleStageIndex !== this.stageIndex;
    this.cpuBusyStreak = cpuHigh ? (advanced ? 1 : this.cpuBusyStreak + 1) : 0;
    this.lastSampleStageIndex = this.stageIndex;

    if (stageElapsedMs < this.stageTimeoutMs && this.retries < RETRY_LIMIT) {
      this.retries++;
      this.windowStartAt = at; // 重武装整窗:再给一个完整窗口
      this.code = "RETRY";
      return { action: "retry", code: "RETRY", stage, elapsedMs, stageElapsedMs, reason: `超时但阶段 ${stage} 刚推进(${stageElapsedMs}ms < ${this.stageTimeoutMs}ms),重武装第 ${this.retries} 次` };
    }
    if (cpuHigh && this.cpuBusyStreak < this.cpuFallbackLimit) {
 // CPU 持续高=仍在同步计算/编译,未达连续上限前不杀(否则误伤)。
      this.code = "WAITING";
      return { action: "wait", code: "WAITING", stage, elapsedMs, stageElapsedMs, reason: `阶段 ${stage} 停留 ${stageElapsedMs}ms,CPU 连续 ${this.cpuBusyStreak}/${this.cpuFallbackLimit} 次繁忙,继续观察` };
    }
    if (cpuHigh) {
      this.code = "CPU_BUSY";
      return { action: "kill", code: "CPU_BUSY", stage, elapsedMs, stageElapsedMs, reason: `阶段 ${stage} 停留 ${stageElapsedMs}ms 无推进且 CPU 连续 ${this.cpuBusyStreak} 次 ≥${CPU_HIGH_PERCENT}%(仍在计算,超限收割)` };
    }
    this.code = "NO_PROGRESS";
    return { action: "kill", code: "NO_PROGRESS", stage, elapsedMs, stageElapsedMs, reason: `阶段 ${stage} 停留 ${stageElapsedMs}ms 无推进${typeof input.cpuPercent === "number" ? `(CPU ${Math.round(input.cpuPercent)}% 不忙)` : "(无 CPU 证据)"}` };
  }

 /** 证据快照:阶段轨迹 + 重试/采样计数 + 最近判决码。每次返回全新对象(外部改动不回灌)。 */
  evidence(): StartupEvidence {
    const at = this.lastSampleAt ?? this.now();
    const stages = this.entered.map((e) => ({ stage: e.stage, enteredAt: e.enteredAt, elapsedMs: Math.max(0, at - e.enteredAt) }));
    return { stages, lastStage: this.lastStage, retries: this.retries, cpuSamples: this.cpuSamples, code: this.code };
  }

 /** 只读观测(测试/日志用;不参与判决)。 */
  get currentStage(): StartupStage { return this.lastStage; }
  get createdTime(): number { return this.createdAt; }
}
