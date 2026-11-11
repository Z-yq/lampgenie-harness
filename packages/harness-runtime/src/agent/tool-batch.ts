/**
 * 工具批次并发调度(纯逻辑,零 IO,不 throw,确定性)。
 * 背景:旧实现只按 `Tool.isConcurrencySafe` 做二分——安全的一起跑,不安全的独占串行。
 * 但「并发安全」通常只声明「自身不依赖共享可变状态」,并不保证两个安全调用**不碰同一路径**:
 * 两个 edit_file 写同一文件、read 与 write 交错,并行会读到中间态或互相覆盖写结果。
 * 因此这里在安全批内部再做**路径重叠检测**:有交集的调用拆成串行段(独占屏障),
 * 分段顺序严格保持调用提交顺序。
 * 为什么不猜路径:路径只从 canonical args 的固定键读取(path/file_path/target_path/
 * old_path/new_path),其它字段一律不当路径(如 `command` 里藏着的路径不解析)。
 * 若调用方声明「这个工具会碰路径」(hasPathInfo=true)但参数里抽不到路径,
 * **不能把「抽不到」当成「没有冲突」**——未知路径可能撞任何已并行的调用,只能按独占处理。
 */

/** 执行调度只需要的最小调用视图(与 loop 的 ToolCall 结构一致)。 */
export interface ToolCallLike {
  id: string;
  name: string;
  arguments: string;
}

/** 一个批次段:parallel=true 内部可 Promise.all;parallel=false 逐调用串行(屏障)。 */
export interface BatchSegment {
  parallel: boolean;
  calls: ToolCallLike[];
}

export interface BatchPlan {
  segments: BatchSegment[];
}

export interface BatchPlanOptions {
 /** 工具自身声明的并发安全性(等价旧 `Tool.isConcurrencySafe(args)`)。 */
  isSafe: (call: ToolCallLike) => boolean;
 /** 调用方声明「该调用属于会碰路径的工具但路径不可知」。缺省 false=不做未知路径判定。
 * 语义:返回 true 表示「我知道它会碰路径」;此时若 pathsOfToolCall 抽不到路径,按独占处理。
 * 参数里实际抽出路径的调用无需它——路径本身就是已知信息。 */
  hasPathInfo?: (call: ToolCallLike) => boolean;
}

/** 被判定为路径参数的固定键(只认 canonical args 顶层字段,不做嵌套猜测)。 */
export const PATH_ARG_KEYS = ["path", "file_path", "target_path", "old_path", "new_path"] as const;

/** 取消前未派发调用的合成结果文案(与 loop 既有串行屏障语义同源)。 */
export const ABORTED_BEFORE_DISPATCH_TEXT = "[ABORTED_BEFORE_DISPATCH]";

/** mergeBatchResults 在缺结果时合成的取消结果。 */
export interface SyntheticAbortedOutcome {
  call: ToolCallLike;
  content: string;
  durationMs: number;
  error: { origin: "aborted"; message: string; name: string };
}

/**
 * 从 canonical args 提取路径集:只读固定路径键,忽略空串,去重后排序。
 * 非法 JSON / 非对象(数组、null、标量)一律返回空数组——宁可不判定,也不误判。
 */
export function pathsOfToolCall(call: ToolCallLike): string[] {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return [];
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const out = new Set<string>();
  for (const key of PATH_ARG_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) out.add(value);
  }
  return [...out].sort();
}

/** 调用判定函数一律吞错:判定失败按「不安全/无路径声明」处理,绝不打断批次规划。 */
function safeCheck(fn: (call: ToolCallLike) => boolean, call: ToolCallLike): boolean {
  try {
    return fn(call) === true;
  } catch {
    return false;
  }
}

/**
 * 按提交顺序把调用切成「并行段 / 串行屏障段」。
 * 规则:
 * - safe 且与**当前并行段**已收集路径集无交集 → 并入当前并行段;
 * - 路径有交集 / safe=false → 结束当前并行段,该调用单独成 parallel=false 段(屏障);
 * - safe 但 hasPathInfo 声明会碰路径、参数里却抽不到路径 → 视为独占(保守,不猜无冲突);
 * - 空 calls → segments=[]。
 * 注意「只与当前并行段比对」:串行段是屏障,它之前的调用都已结束,不需要跨段判冲突。
 * 也不修改入参:返回的段与 calls 数组都是新建结构。
 */
export function planToolBatch(
  calls: readonly ToolCallLike[],
  opts: BatchPlanOptions): BatchPlan {
  const segments: BatchSegment[] = [];
  let parallelCalls: ToolCallLike[] | null = null;
  let parallelPaths = new Set<string>();

  const closeParallel = () => {
    if (parallelCalls && parallelCalls.length > 0) segments.push({ parallel: true, calls: parallelCalls });
    parallelCalls = null;
    parallelPaths = new Set();
  };

  for (const call of calls) {
    const isSafe = safeCheck(opts.isSafe, call);
    const paths = pathsOfToolCall(call);
    const unknownPaths = paths.length === 0 && (opts.hasPathInfo ? safeCheck(opts.hasPathInfo, call) : false);
    const overlaps = paths.some((p) => parallelPaths.has(p));
    if (!isSafe || unknownPaths || overlaps) {
      closeParallel();
      segments.push({ parallel: false, calls: [call] });
      continue;
    }
    if (!parallelCalls) parallelCalls = [];
    parallelCalls.push(call);
    for (const p of paths) parallelPaths.add(p);
  }
  closeParallel();
  return { segments };
}

export interface BatchStats {
  segments: number;
  parallelSegments: number;
  sequentialCalls: number;
  maxParallel: number;
}

/** 批次统计(确定性):段数 / 并行段数 / 串行调用数 / 单段最大并行度。 */
export function batchStats(plan: BatchPlan): BatchStats {
  let parallelSegments = 0;
  let sequentialCalls = 0;
  let maxParallel = 0;
  for (const segment of plan.segments) {
    if (segment.parallel) {
      parallelSegments += 1;
      if (segment.calls.length > maxParallel) maxParallel = segment.calls.length;
    } else {
      sequentialCalls += segment.calls.length;
    }
  }
  return { segments: plan.segments.length, parallelSegments, sequentialCalls, maxParallel };
}

/**
 * 按 calls 提交序归并执行结果(缺结果补 ABORTED_BEFORE_DISPATCH 合成结果)。
 * `outcomesById` 可以是 Map 或普通对象;不读取也不修改其内部条目,返回值是新建数组。
 * 合成结果带 `call`,调用方可直接当 ToolExecOutcome 使用(call/durationMs/error 同型)。
 * 调用方应把「已执行结果 + 护栏拦截结果」都放进同一 Map——命中即原样返回,
 * 只有真正没有结果的调用(取消未派发)才会被补成 aborted,不会把 guard 误报成取消。
 */
export function mergeBatchResults<T extends { content: string }>(
  calls: readonly ToolCallLike[],
  outcomesById: ReadonlyMap<string, T> | Readonly<Record<string, T>>,
): Array<T | SyntheticAbortedOutcome> {
  const asMap = outcomesById as ReadonlyMap<string, T>;
  const get = (id: string): T | undefined => {
    if (typeof asMap.get === "function") return asMap.get(id);
    const record = outcomesById as Readonly<Record<string, T>>;
    return Object.prototype.hasOwnProperty.call(record, id) ? record[id] : undefined;
  };
  return calls.map((call) => {
    const hit = get(call.id);
    if (hit !== undefined) return hit;
    return {
      call,
      content: ABORTED_BEFORE_DISPATCH_TEXT,
      durationMs: 0,
      error: { origin: "aborted" as const, message: ABORTED_BEFORE_DISPATCH_TEXT, name: call.name },
    };
  });
}
