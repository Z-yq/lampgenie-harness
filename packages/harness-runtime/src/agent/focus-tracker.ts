/**
 * 焦点信号数据源(缺口#29, 审计「独立杂项」件4)。
 * 背景:上下文裁剪只看 token 体积会优先丢「老但仍是当前焦点」的内容。这里提供
 * **纯逻辑、零 IO** 的焦点段派生:从 journal 事件序列推出「用户当前焦点落在哪一段
 * 事件区间」,供裁剪器(如按龄/microcompact)做「焦点内不裁」的加权输入。
 * 口径(与任务书一致):
 * - 段起点 = message.user 事件(用户每发一条新消息 = 焦点切换);
 * - 段内的 board_upsert 完成 / goal_progress / subagent spawn+终态**只记 origin 标记**,
 * 不拆段(焦点仍在同一用户轮次内);
 * - 段尾 = 下一 user 消息(最后一段 endSeq 留空 = 仍开放);
 * - 不读盘、不 throw、不改入参(脏事件跳过)。
 */

/** 子焦点来源:段内推进焦点的信号(只标记,不拆段)。 */
export type FocusOrigin = "user-message" | "board-advance" | "goal-advance" | "subagent-round";

/** 一段焦点区间:[startSeq, endSeq)(endSeq 缺省 = 开放段,直到事件流末尾)。 */
export interface FocusSegment {
  focusId: string;
  startSeq: number;
  endSeq?: number;
  origin: FocusOrigin;
}

/** 派生输入的最小事件形状(kind-based,journal 事件的子集即可)。 */
export interface FocusEvent {
  type: string;
  seq: number;
  payload?: unknown;
}

/**
 * 从事件序列派生焦点段(纯函数)。
 * 规则:user 消息(type=message.user 或 kind=message.user,两种键名都认)开新段;
 * 其间出现的 board_upsert 完成 / goal_progress / subagent spawn+终态记
 * origin 子焦点标记——即以该信号为 origin 开一段同 startSeq 的「标记段」,
 * 便于上层问「这个 seq 是否在某个 board-advance 焦点里」,但**不改 user 段边界**。
 * seq 缺省按出现顺序递增(0,1,2,...)兜底,保证无 seq 的脏事件也能产出确定性结果。
 */
export function deriveFocusSegments(events: readonly FocusEvent[]): FocusSegment[] {
  const list: readonly unknown[] = Array.isArray(events) ? events : [];
  const seqOf = (e: FocusEvent, fallback: number): number =>
    typeof e?.seq === "number" && Number.isFinite(e.seq) ? e.seq : fallback;

  const out: FocusSegment[] = [];
  let userIndex = 0;
  let current: FocusSegment | null = null;
  let lastSeq = -Infinity;

  const closeCurrent = (endSeq: number): void => {
    if (current && current.endSeq === undefined && endSeq > current.startSeq) {
      current.endSeq = endSeq;
    }
  };

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== "object") continue;
    const e = raw as FocusEvent;
    const type = typeof e.type === "string" ? e.type : "";
    if (!type) continue;
    const seq = seqOf(e, lastSeq === -Infinity ? 0 : lastSeq + 1);
    lastSeq = Math.max(lastSeq, seq);
    const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;

    if (type === "message.user") {
 // 新焦点段:上一段在此闭合。
      closeCurrent(seq);
      current = { focusId: `focus-${userIndex}`, startSeq: seq, origin: "user-message" };
      out.push(current);
      userIndex += 1;
      continue;
    }

    if (current) {
 // 子焦点标记:不拆段,只追加 origin 标记段(startSeq 同 current,便于区间查询)。
      if (type === "board_upsert" && (p.status === undefined || p.status === "done" || p.done === true)) {
        out.push({ focusId: `focus-${userIndex - 1}#board`, startSeq: current.startSeq, origin: "board-advance" });
      } else if (type === "goal_progress") {
        out.push({ focusId: `focus-${userIndex - 1}#goal`, startSeq: current.startSeq, origin: "goal-advance" });
      } else if (type === "subagent.spawn") {
        out.push({ focusId: `focus-${userIndex - 1}#subagent`, startSeq: current.startSeq, origin: "subagent-round" });
      } else if (type === "subagent.event" && isSubagentTerminal(p)) {
        out.push({ focusId: `focus-${userIndex - 1}#subagent`, startSeq: current.startSeq, origin: "subagent-round" });
      }
    }
  }
 // 最后一段保持开放(endSeq 缺省)。
  return out;
}

/** subagent 终态判定:事件 payload 带 phase/status/kind 终态字样(宽容匹配,缺省非终态)。
 * session-worker 镜像的子事件把子事件 kind 放在 payload.kind(经验证 `turn.end` 最多),
 * 以及 `subagent.result` 的 ok/error;都算子代理动作完成。 */
export function isSubagentTerminal(p: Record<string, unknown>): boolean {
  const phase = typeof p.phase === "string" ? p.phase : "";
  const status = typeof p.status === "string" ? p.status : "";
  const kind = typeof p.kind === "string" ? p.kind : "";
  return ["done", "complete", "completed", "finished", "exit", "exited", "failed", "error", "turn.end", "result", "cancelled", "stopped"].some(
    (t) => phase === t || status === t || kind === t,
  );
}

/**
 * 焦点消耗判定(纯逻辑):某工具调用(target.tool + where 寻址)在**之后的**调用里
 * 是否被再次命中——后续调用的 argsText 包含 where 子串(大小写不敏感)即视为
 * 「同一焦点仍在被使用」,裁剪器应保护该 where 寻址的内容。
 * laterCalls 为空 / where 为空 / 参数非字符串 → false(没有证据就不算消耗)。
 */
export function isConsumed(
  target: { tool: string; where?: string },
  laterCalls: readonly { tool: string; argsText?: unknown }[],
): boolean {
  const where = typeof target?.where === "string" ? target.where.trim() : "";
  if (!where) return false;
  const needle = where.toLowerCase();
  const calls = Array.isArray(laterCalls) ? laterCalls : [];
  for (const c of calls) {
    if (!c || typeof c !== "object") continue;
    const args = typeof c.argsText === "string" ? c.argsText : "";
    if (!args) continue;
    if (args.toLowerCase().includes(needle)) return true;
  }
  return false;
}
