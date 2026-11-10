/**
 * 会话投影归约器( F1,ZCode v4 投影精髓 × qwen journal 事件源):
 * 单一纯函数把 journal 事件流归约为面板消费的会话投影——todo/subagent/workflow/
 * 压缩标记/消息行——单时钟纪律(不读时钟不触 IO),UI 不再各自扫事件流。
 */
export interface SessionEventLike {
  kind: string;
  payload?: unknown;
  time?: number;
}

export interface ProjectedTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ProjectedRow {
  kind: "user" | "agent";
  text: string;
}

export interface SessionProjection {
  /** todo:最后一次 todo.updated 的清单(ZCode 最后写赢语义)。 */
  todo: { items: ProjectedTodoItem[]; completed: number; total: number } | null;
  /** 子代理:spawn/result 计数(running=spawn-result,不减去 cancel 侧——诚实子集)。 */
  subagents: { spawnCount: number; resultCount: number; running: number };
  /** workflow:每个 run 的待答 ask 数与终态。 */
  workflows: { wfId: string; asks: number; done: boolean }[];
  /** 压缩边界标记(auto-compact 落盘的 start/done 对)。 */
  compactions: {
    at: number;
    tokens?: number;
    summaryChars?: number;
    /** 边界元数据(2026-11):透传 compact.done 的 tokensBefore/tokensAfter/trigger/summaryMessageIds。 */
    tokensBefore?: number;
    tokensAfter?: number;
    trigger?: "manual" | "auto";
    summaryMessageIds?: number[];
  }[];
  /** 消息行(可见投影:user/agent 文本,工具事件不入行——工具卡另有渲染通道)。
 * 有界化(网关 OOM 根因):旧实现把每条消息全文塞进 rows——巨型会话(36K 事件/
   *  数千条消息,单条可含 500KB 级内容)的投影达数 MB,session.status 每 3s 轮询全量序列化,
 * 4GB 堆也被打穿(崩溃栈=JsonStringify)。经验证消费面:面板状态条只用 todo/subagents/
   *  workflows/compactions,rows 全量是死重。现封顶:尾部 ROWS_MAX 条 + 单条文本 ROW_TEXT_MAX
   * 字符 + rowCount 总数(消费方要全量该走 session.history,不该走状态投影)。 */
  rows: ProjectedRow[];
  /** 消息行总数(封顶前的真实数;rows 只是尾部窗口)。 */
  rowCount: number;
}

/** rows 尾部窗口上限(状态投影只服务「当前进度感」,不是消息通道)。 */
export const PROJECTION_ROWS_MAX = 50;
/** 单行文本截断(行只是预览;全文在 session.history)。 */
export const PROJECTION_ROW_TEXT_MAX = 200;

/** 增量投影的跨批携带态( session.status 增量化;治网关 OOM:面板不再每次全量回拉)。
 *  只装「projectSession 的单批返回值里装不下」的两类事实:
 *  ① todoCleared/compactionStarted 这类**批内出现与否**的标志(todo 初值 null 无法区分「本批无
 *     todo.updated」与「todo 被清空」;compact.start/compact.done 分落两批时 at/tokens 会丢);
 *  ② workflows 已见 wfId 集(否则增量后 workflows 回 []——workflow.run.start 只在历史里)。
 *  由 mergeProjection 输入输出,服务端 memo 每会话存一份(见 server.ts sessionStatusMemo)。 */
export interface ProjectionCarry {
  /** 本批出现过 todo.updated(哪怕 items 被清空)。false=保留上一批 todo 原样。 */
  todoSeen: boolean;
  /** 跨批 compact.start(没等到 compact.done 的半对)。 */
  compactStart: { at: number; tokens?: number } | null;
  /** 已见 workflow wfId(按首次出现顺序;合并靠它保住 prev 的 workflows 不被增量清空)。 */
  wfSeen: Set<string>;
}

/** 单批投影的增量事实(in-out 事实袋:compactStart 带入跨批态、写出本批残留;
 *  mergeProjection 用它判定「本批写了什么」)。 */
export interface ProjectionDeltaFacts {
  todoSeen: boolean;
  compactStart: { at: number; tokens?: number } | null;
}

/** 初始携带态(服务端首次全量投影时用)。 */
export function emptyProjectionCarry(): ProjectionCarry {
  return { todoSeen: false, compactStart: null, wfSeen: new Set<string>() };
}

/**
 * 增量合并:把一批新事件的投影 delta 合并进累积投影 prev。
 * **全量等价性契约**(测试锁):设 factsIn 从 carry 带入(见 projectSession 第三参是 in-out 事实袋)、
 * outCarry 承接跨批态,则对任意事件流分批 A1..An,
 *   merge(merge(projectSession(A1)…), projectSession(Ak))
 * 逐字段 deepEqual 对 A1.concat(..Ak) 的一次全量 projectSession
 * (todo/subagents/workflows/compactions/rows/rowCount)。
 * 逐字段口径(对 projectSession 归约语义的推导):
 * - todo:本批见过 todo.updated 才覆盖(facts.todoSeen),否则保留 prev.todo——
 *   projectSession 的 todo 初值 null 无法区分「本批无 todo.updated」与「todo 被清空」。
 * - subagents:spawn/result 计数相加;running 合并后重算 max(0, spawn-result)(不能相加)。
 * - workflows:按 wfId 合并(prev 序在前),done 取 OR;**asks 不由 delta 推导**——全量口径是
 *   在 wf 会话流里 filter 出的跨会话量,增量批看不到,由调用方按 wf 会话水位累加后回填。
 *   outCarry.wfSeen 保住「只在历史里出现过 run.start」的 wf(否则增量后 workflows 回 [])。
 * - compactions:追加(compact.start/compact.done 分落两批时,由 facts.compactStart 在
 *   projectSession 里带入,delta 的 at/tokens 因此与全量逐字一致)。
 * - rows:prev.rows.concat(delta.rows) 取尾部 PROJECTION_ROWS_MAX;rowCount 相加
 *   (尾部窗口对「后缀拼接」封闭:两条流各取后缀拼接再取后缀 = 全量后缀)。
 */
export function mergeProjection(
  prev: SessionProjection,
  delta: SessionProjection,
  carry: { facts?: ProjectionDeltaFacts; outCarry?: ProjectionCarry } = {},
): SessionProjection {
  const todoSeen = carry.facts?.todoSeen ?? true;
  const todo = todoSeen ? delta.todo : prev.todo;
  const spawnCount = prev.subagents.spawnCount + delta.subagents.spawnCount;
  const resultCount = prev.subagents.resultCount + delta.subagents.resultCount;

  // workflows:prev 顺序在前(首次出现序),delta 新 wf 追加;asks 保留 prev 值(跨会话,调用方维护)。
  const wf = new Map<string, { wfId: string; asks: number; done: boolean }>();
  for (const w of prev.workflows) wf.set(w.wfId, { wfId: w.wfId, asks: w.asks, done: w.done });
  for (const w of delta.workflows) {
    const cur = wf.get(w.wfId);
    if (cur) cur.done = cur.done || w.done;
    else wf.set(w.wfId, { wfId: w.wfId, asks: w.asks, done: w.done });
  }
  if (carry.outCarry) {
    for (const id of carry.outCarry.wfSeen) if (!wf.has(id)) wf.set(id, { wfId: id, asks: 0, done: false });
    carry.outCarry.wfSeen = new Set(wf.keys());
  }

  const merged: SessionProjection = {
    todo,
    subagents: { spawnCount, resultCount, running: Math.max(0, spawnCount - resultCount) },
    workflows: [...wf.values()],
    compactions: prev.compactions.concat(delta.compactions),
    rows: prev.rows.concat(delta.rows).slice(-PROJECTION_ROWS_MAX),
    rowCount: prev.rowCount + delta.rowCount,
  };
  if (carry.outCarry) {
    // facts.compactStart 是 in-out:projectSession 已把「未成对的 compact.start」留在里面(成对即清)。
    carry.outCarry.compactStart = carry.facts?.compactStart ?? null;
    carry.outCarry.todoSeen = todoSeen;
  }
  return merged;
}

/**
 * 归约会话事件流。新增第三参 factsOut(可选,纯输出)——把「批内出现过什么」记进去
 * (todoSeen / 未成对的 compactStart),供 mergeProjection 判增量。不带第三参=调用方零改动。
 */
export function projectSession(
  events: SessionEventLike[],
  allEvents: (SessionEventLike & { sessionId?: string })[] = [],
  factsOut?: ProjectionDeltaFacts): SessionProjection {
  const proj: SessionProjection = {
    todo: null,
    subagents: { spawnCount: 0, resultCount: 0, running: 0 },
    workflows: [],
    compactions: [],
    rows: [],
    rowCount: 0,
  };
  const wf = new Map<string, { wfId: string; asks: number; done: boolean }>();
  // factsOut.compactStart 是 in-out:带入上一批未成对的 compact.start(跨批 at/tokens 不丢),
  // 循环结束把本批残留写回(成对已被 compact.done 清空)。
  let compactStart: { at: number; tokens?: number } | null = factsOut?.compactStart ?? null;

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.kind) {
      case "todo.updated": {
        const raw = (p.items as { content?: string; status?: string }[] | undefined) ?? [];
        const items: ProjectedTodoItem[] = raw.map((i) => ({
          content: String(i.content ?? ""),
          status: i.status === "completed" || i.status === "in_progress" ? i.status : "pending",
        }));
        proj.todo = { items, completed: items.filter((i) => i.status === "completed").length, total: items.length };
        if (factsOut) factsOut.todoSeen = true;
        break;
      }
      case "subagent.spawn":
        proj.subagents.spawnCount++;
        break;
      case "subagent.result": {
        proj.subagents.resultCount++;
        break;
      }
      case "workflow.run.start": {
        const id = String(p.wfId ?? "");
        if (id) wf.set(id, { wfId: id, asks: 0, done: false });
        break;
      }
      case "workflow.ask": {
        // ask 事件在 run 自己的会话流(journal sessionId=wfId),主会话投影不重复计;
        // 计数在收尾处按全量事件关联(见下)。
        break;
      }
      case "workflow.run.done": {
        const id = String(p.wfId ?? "");
        const cur = wf.get(id) ?? { wfId: id, asks: 0, done: false };
        cur.done = true;
        wf.set(id, cur);
        break;
      }
      case "compact.start":
        compactStart = { at: ev.time ?? 0, tokens: typeof p.tokens === "number" ? p.tokens : undefined };
        break;
      case "compact.done":
        proj.compactions.push({
          at: compactStart?.at ?? ev.time ?? 0,
          tokens: compactStart?.tokens,
          summaryChars: typeof p.summaryChars === "number" ? p.summaryChars : undefined,
          // 边界元数据透传(2026-11):缺省省略,保证旧 journal(无这些字段)投影逐字不变。
          ...(typeof p.tokensBefore === "number" ? { tokensBefore: p.tokensBefore } : {}),
          ...(typeof p.tokensAfter === "number" ? { tokensAfter: p.tokensAfter }
            : typeof p.tokensAfterMicrocompact === "number" ? { tokensAfter: p.tokensAfterMicrocompact } : {}),
          ...(p.trigger === "manual" || p.trigger === "auto" ? { trigger: p.trigger } : {}),
          ...(Array.isArray(p.summaryMessageIds)
            ? { summaryMessageIds: (p.summaryMessageIds as unknown[]).filter((n): n is number => typeof n === "number") }
            : {}),
        });
        compactStart = null;
        break;
      case "message.user":
      case "message.agent": {
 // 有界化:尾部窗口+文本截断(见 SessionProjection.rows 注释)。
        proj.rowCount += 1;
        const text = String(p.text ?? "");
        proj.rows.push({ kind: ev.kind === "message.user" ? "user" : "agent", text: text.length > PROJECTION_ROW_TEXT_MAX ? text.slice(0, PROJECTION_ROW_TEXT_MAX) + "…(行截断)" : text });
        if (proj.rows.length > PROJECTION_ROWS_MAX) proj.rows.shift();
        break;
      }
      default:
        break;
    }
  }
  proj.subagents.running = Math.max(0, proj.subagents.spawnCount - proj.subagents.resultCount);
  // workflow asks 关联:ask 落在 run 会话流(sessionId=wfId)——按全量事件补计(旧行为同口径)。
  for (const [id, cur] of wf) {
    cur.asks = allEvents.filter((e) => e.sessionId === id && e.kind === "workflow.ask").length;
  }
  proj.workflows = [...wf.values()];
 // 增量事实输出(可选):批内见过 todo.updated / 有未成对的 compact.start。
  if (factsOut) factsOut.compactStart = compactStart;
  return proj;
}
