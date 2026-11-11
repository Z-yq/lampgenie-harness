/**
 * 输入准入与归属:durable inbox(纯逻辑,零 IO)。
 * 为什么需要它:用户输入 / steer / 重试此前直接进内存队列,重复提交会重复执行、
 * 客户端重试时无法判定「同一个请求」,重启时排队项只能靠快照猜状态。本模块把
 * 「准入(admit)」与「放行(promote)」拆成两条独立水位:
 * - admittedSeq:受理水位。每条被受理的输入只在**第一次**受理时分配一次,跨会话全局单调。
 * DUPLICATE 复用已有项、不新分配 seq(客户端重试不会产生第二条消息)。
 * - promotedSeq:放行水位。只有会话空闲(=无在跑任务)且处在**完整 tool batch 边界**时才推进。
 * 为什么 promote 只能在完整 tool batch 之后:agent loop 里 tool.call 落账后必须等到配对的
 * tool.result 才闭合一次模型往返;此时插入新的用户消息会把 tool_call 与 tool_result 之间
 * 塞进一条 user 消息,模型看到的调用链被截断/错配(协议破窗),同一 turn 的上下文也会被
 * 两段输入交错。所以 promote 的触发点是任务终态事件这类天然边界,并用 assertQueueBoundary
 * 再挡一层 tool.call / tool.result / step.start 这类批内事件。
 * 为什么同一个 idempotencyKey 但载荷不同必须 CONFLICT:静默当作重复会丢掉用户真正想发的
 * 新消息(消息丢失,客户端却以为成功);静默当作新消息又会破坏调用方对幂等的假设(同一次
 * 重试变成两次执行)。两者都不可接受,因此升级为显式冲突,交给调用方换 key 或人工核对。
 * 约束:零 IO(时间戳由调用方传入或仅作元数据)、不 throw、返回不可变(freeze)、
 * 同输入同输出(顺序与 id 均由 seq 派生,不用随机)。
 */
import { createHash } from "node:crypto";

/** 附件描述(与 protocol.QueueItem.attachments 同形,避免跨包依赖)。 */
export interface InboxAttachment {
  name: string;
  path: string;
  mime?: string;
  size?: number;
}

/** 投递状态:pending=已受理未放行;delivered=已放行(可提交)。 */
export type InboxDelivery = "pending" | "delivered";

/** inbox 项(不可变)。 */
export interface InboxItem {
  id: string;
  sessionId: string;
  instruction: string;
  ownerId: string;
  idempotencyKey?: string;
 /** sha256(instruction + 规范化附件) 前 16 hex。 */
  fingerprint: string;
  admittedSeq: number;
  promotedSeq?: number;
  delivery: InboxDelivery;
  admittedAt: number;
  promotedAt?: number;
}

export type AdmitCode = "ADMITTED" | "DUPLICATE" | "CONFLICT" | "INVALID";

export interface AdmitResult {
  ok: boolean;
  code: AdmitCode;
 /** DUPLICATE=已有项(副本);ADMITTED=新项;CONFLICT/INVALID=null。 */
  item: InboxItem | null;
 /** 本次受理分配的 seq;未分配(=CONFLICT/INVALID)为 0。 */
  admittedSeq: number;
}

export interface AdmitOptions {
  idempotencyKey?: string;
  ownerId?: string;
  attachments?: readonly InboxAttachment[];
 /** 受理时间(缺省=Date.now;测试传入以获得确定性)。 */
  at?: number;
}

export interface PromoteOptions {
 /** 只推进 admittedSeq <= cutoff 的项(缺省=全部 pending):并发 admit 的新项留给下一轮。 */
  cutoff?: number;
  at?: number;
}

export interface InboxStats {
  sessions: number;
  total: number;
  pending: number;
  delivered: number;
  lastAdmittedSeq: number;
  lastPromotedSeq: number;
}

export interface OwnerCandidate {
  sessionId: string;
  ownerId?: string | null;
}

export interface ResumePlan {
 /** 可注入上下文的项(已 delivered 或已 promoted)。 */
  restored: InboxItem[];
 /** 未 drain 的项:只留在队列,不注入上下文。 */
  heldBack: InboxItem[];
}

/** 未归属 owner 的稳定字面量。 */
export const UNOWNED = "unowned";

/** 冻结(项是扁平对象,只差数组容器)。 */
function frozen<T>(value: T): T {
  if (Array.isArray(value)) Object.freeze(value);
  else if (value && typeof value === "object") Object.freeze(value);
  return value;
}

/**
 * 载荷指纹:sha256(instruction + 规范化附件) 前 16 hex。
 * 规范化 = 只取 (name, path, mime ?? "", size ?? 0) 且保持给定顺序——同载荷必同指纹,
 * 载荷任何一处变化必换指纹(CONFLICT 判定依赖这一点)。
 */
export function fingerprintOf(instruction: string, attachments?: readonly InboxAttachment[]): string {
  const text = typeof instruction === "string" ? instruction : "";
  const list = Array.isArray(attachments) ? attachments : [];
  const normalized = list.map((a) => [
    typeof a?.name === "string" ? a.name : "",
    typeof a?.path === "string" ? a.path : "",
    typeof a?.mime === "string" ? a.mime : "",
    typeof a?.size === "number" && Number.isFinite(a.size) ? a.size : 0,
  ]);
  const canonical = JSON.stringify([text, normalized]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/**
 * 队列边界断言:只有「完整 tool batch 之后」才允许 promote。
 * 批内事件(tool.call / tool.result / step.start)= 一次模型往返还没闭合,promote 会把
 * 新用户消息插进 tool_call 与 tool_result 之间 → 拒绝。无末事件(=会话空闲)= 放行。
 */
const MID_BATCH_KINDS: ReadonlySet<string> = new Set(["tool.call", "tool.result", "step.start"]);

export function assertQueueBoundary(lastEventKind?: string | null): boolean {
  if (typeof lastEventKind !== "string") return true;
  const kind = lastEventKind.trim();
  if (!kind) return true;
  return !MID_BATCH_KINDS.has(kind);
}

/** 单会话 inbox(进程内)。 */
export class DurableInbox {
  private readonly bySession = new Map<string, InboxItem[]>();
  private admittedSeq = 0;
  private promotedSeq = 0;

 /**
 * 受理一条输入。不 throw:
 * - INVALID:sessionId/instruction 为空(不写入);
 * - DUPLICATE:同 session 内同 idempotencyKey 且同指纹(返回已有项,不新分配 seq);
 * - CONFLICT:同 idempotencyKey 但指纹不同(不写入,显式冲突);
 * - ADMITTED:新分配 admittedSeq(跨会话全局单调)。
 */
  admit(sessionId: string, instruction: string, options: AdmitOptions = {}): AdmitResult {
    const sid = typeof sessionId === "string" ? sessionId : "";
    const text = typeof instruction === "string" ? instruction : "";
    if (!sid.trim() || !text.trim()) {
      return frozen({ ok: false, code: "INVALID" as const, item: null, admittedSeq: 0 });
    }
    const key =
      typeof options.idempotencyKey === "string" && options.idempotencyKey.trim()
        ? options.idempotencyKey
        : undefined;
    const fingerprint = fingerprintOf(text, options.attachments);

    if (key) {
 // 幂等键按会话命名空间查重:同一客户端 key 在不同会话是不同消息。
      const existing = (this.bySession.get(sid) ?? []).find((i) => i.idempotencyKey === key);
      if (existing) {
        if (existing.fingerprint === fingerprint) {
          return frozen({
            ok: true,
            code: "DUPLICATE" as const,
            item: frozen({ ...existing }),
            admittedSeq: existing.admittedSeq,
          });
        }
        return frozen({ ok: false, code: "CONFLICT" as const, item: null, admittedSeq: 0 });
      }
    }

    const seq = ++this.admittedSeq;
    const ownerId = typeof options.ownerId === "string" && options.ownerId.trim() ? options.ownerId : UNOWNED;
    const item: InboxItem = frozen({
 // id 由 seq 派生:同输入同输出,不依赖随机/时钟。
      id: `ib-${seq}`,
      sessionId: sid,
      instruction: text,
      ownerId,
      ...(key ? { idempotencyKey: key } : {}),
      fingerprint,
      admittedSeq: seq,
      delivery: "pending" as const,
      admittedAt: typeof options.at === "number" && Number.isFinite(options.at) ? options.at : Date.now(),
    });
    const list = this.bySession.get(sid) ?? [];
    this.bySession.set(sid, [...list, item]);
    return frozen({ ok: true, code: "ADMITTED" as const, item: frozen({ ...item }), admittedSeq: seq });
  }

 /**
 * 放行:把该会话 pending 且 admittedSeq <= cutoff 的项转 delivered 并记 promotedSeq。
 * 不传 cutoff = 全部 pending。返回被放行的项(按 admittedSeq 升序)。
 */
  promote(sessionId: string, options: PromoteOptions = {}): InboxItem[] {
    const list = this.bySession.get(sessionId);
    if (!list || list.length === 0) return frozen([] as InboxItem[]);
    const cutoff =
      typeof options.cutoff === "number" && Number.isFinite(options.cutoff) ? options.cutoff : Number.POSITIVE_INFINITY;
    const at = typeof options.at === "number" && Number.isFinite(options.at) ? options.at : Date.now();
    const promoted: InboxItem[] = [];
    const next = list.map((it) => {
      if (it.delivery !== "pending" || it.admittedSeq > cutoff) return it;
      const seq = ++this.promotedSeq;
      const moved: InboxItem = frozen({ ...it, delivery: "delivered" as const, promotedSeq: seq, promotedAt: at });
      promoted.push(frozen({ ...moved }));
      return moved;
    });
    this.bySession.set(sessionId, next);
    promoted.sort((a, b) => a.admittedSeq - b.admittedSeq);
    return frozen(promoted);
  }

 /** 纯查询:该会话当前可放行的项(不推进水位)。 */
  promotable(sessionId: string, cutoff?: number): InboxItem[] {
    const list = this.bySession.get(sessionId) ?? [];
    const limit =
      typeof cutoff === "number" && Number.isFinite(cutoff) ? cutoff : Number.POSITIVE_INFINITY;
    const out = list
      .filter((it) => it.delivery === "pending" && it.admittedSeq <= limit)
      .map((it) => frozen({ ...it }));
    out.sort((a, b) => a.admittedSeq - b.admittedSeq);
    return frozen(out);
  }

 /** 该会话全部项(副本,按 admittedSeq 升序)。 */
  items(sessionId: string): InboxItem[] {
    const list = this.bySession.get(sessionId) ?? [];
    return frozen([...list].sort((a, b) => a.admittedSeq - b.admittedSeq).map((it) => frozen({ ...it })));
  }

  stats(): InboxStats {
    let total = 0;
    let pending = 0;
    let delivered = 0;
    for (const list of this.bySession.values()) {
      total += list.length;
      for (const it of list) {
        if (it.delivery === "pending") pending++;
        else delivered++;
      }
    }
    return frozen({
      sessions: this.bySession.size,
      total,
      pending,
      delivered,
      lastAdmittedSeq: this.admittedSeq,
      lastPromotedSeq: this.promotedSeq,
    });
  }

 /**
 * 从持久化快照恢复:只收 delivery !== "delivered" 的项(已放行=已提交或已交给执行器,
 * 重启不该再排);缺失/非法的 admittedSeq 按本次恢复顺序补号,并把水位推到已见最大值,
 * 保证后续 admit 不会复用序号。同 id 去重(恢复幂等)。
 */
  restore(sessionId: string, items: readonly InboxItem[]): InboxItem[] {
    const sid = typeof sessionId === "string" ? sessionId : "";
    if (!sid.trim()) return frozen([] as InboxItem[]);
    if (!Array.isArray(items) || items.length === 0) {
      this.bySession.set(sid, []);
      return frozen([] as InboxItem[]);
    }
    const kept: InboxItem[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const instruction = typeof raw.instruction === "string" ? raw.instruction : "";
      if (!instruction.trim()) continue;
      if (raw.delivery === "delivered") continue; // 已放行项不恢复
      const seq =
        typeof raw.admittedSeq === "number" && Number.isFinite(raw.admittedSeq) && raw.admittedSeq > 0
          ? raw.admittedSeq
          : ++this.admittedSeq;
      if (seq > this.admittedSeq) this.admittedSeq = seq;
      if (typeof raw.promotedSeq === "number" && Number.isFinite(raw.promotedSeq) && raw.promotedSeq > this.promotedSeq) {
        this.promotedSeq = raw.promotedSeq;
      }
      const rawAttachments = (raw as { attachments?: InboxAttachment[] }).attachments;
      kept.push(
        frozen({
          id: typeof raw.id === "string" && raw.id ? raw.id : `ib-${seq}`,
          sessionId: sid,
          instruction,
          ownerId: typeof raw.ownerId === "string" && raw.ownerId ? raw.ownerId : UNOWNED,
          ...(typeof raw.idempotencyKey === "string" && raw.idempotencyKey
            ? { idempotencyKey: raw.idempotencyKey }
            : {}),
          fingerprint:
            typeof raw.fingerprint === "string" && raw.fingerprint
              ? raw.fingerprint
              : fingerprintOf(instruction, Array.isArray(rawAttachments) ? rawAttachments : undefined),
          admittedSeq: seq,
          ...(typeof raw.promotedSeq === "number" && Number.isFinite(raw.promotedSeq)
            ? { promotedSeq: raw.promotedSeq }
            : {}),
          delivery: "pending" as const,
          admittedAt:
            typeof raw.admittedAt === "number" && Number.isFinite(raw.admittedAt) ? raw.admittedAt : Date.now(),
        }),
      );
    }
    kept.sort((a, b) => a.admittedSeq - b.admittedSeq);
    const deduped: InboxItem[] = [];
    const seen = new Set<string>();
    for (const it of kept) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      deduped.push(it);
    }
    this.bySession.set(sid, deduped);
    return frozen(deduped.map((it) => frozen({ ...it })));
  }
}

/**
 * 归属决议:只认 candidates 里 **同 sessionId** 的条目,绝不跨会话猜 owner;
 * 找不到(=异常回退)时写 fallbackOwner(缺省 "unowned")。确定性:取第一个有效候选。
 */
export function resolveOwner(input: {
  sessionId: string;
  candidates?: readonly OwnerCandidate[];
  fallbackOwner?: string;
}): string {
  const sid = typeof input?.sessionId === "string" ? input.sessionId : "";
  const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    if (c.sessionId !== sid) continue; // 不猜其它会话的 owner
    if (typeof c.ownerId === "string" && c.ownerId.trim() && c.ownerId !== UNOWNED) return c.ownerId;
  }
  const fallback =
    typeof input?.fallbackOwner === "string" && input.fallbackOwner.trim() ? input.fallbackOwner : UNOWNED;
  return fallback;
}

/**
 * resume 策略:未 drain(pending 且无 promotedSeq)的项**不**注入上下文,只留在队列;
 * 已 delivered / 已 promoted 的项是既有上下文的一部分,放回 restored。
 */
export function applyResumePolicy(items: readonly InboxItem[]): ResumePlan {
  const restored: InboxItem[] = [];
  const heldBack: InboxItem[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== "object") continue;
    if (it.delivery === "pending" && it.promotedSeq === undefined) heldBack.push(frozen({ ...it }));
    else restored.push(frozen({ ...it }));
  }
  return frozen({ restored: frozen(restored), heldBack: frozen(heldBack) });
}
