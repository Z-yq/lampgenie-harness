/**
 * Team Relay 协议( §8:Gateway Client Protocol 的子集)。
 * relay 是每个 org 一个的轻中继:presence 交换/活动流路由/邀请码兑换;
 * 权威数据全部在 Git 仓,relay 是可重建缓存。
 * 连接鉴权:连接即收 challenge(nonce)→ 客户端私钥签名 → relay 对照 roster.keys 校验;
 * 未认证连接只放行 relay.invite.redeem 与 ping(邀请兑换的前提就是还不是成员)。
 */
import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";

const Envelope = z.object({ v: z.literal(PROTOCOL_VERSION) });

// ---- presence 状态( §2 六态;判定规则确定性,不靠模型) ----
export const PresenceStateName = z.enum([
  "online", "coding", "reviewing", "away", "dnd", "offline",
]);
export type PresenceStateName = z.infer<typeof PresenceStateName>;

/** 客户端上行的事实(不是状态本身——状态由 relay 状态机从事实推导)。 */
export const PresenceFacts = z.object({
  lastInputAt: z.number(),
  runningSessions: z.number().int().nonnegative(),
  pendingAsks: z.number().int().nonnegative(),
  dnd: z.boolean(),
});
export type PresenceFacts = z.infer<typeof PresenceFacts>;

// ---- 活动流( §4:最小事件集;payload 只放摘要+指针,不放正文) ----
export const ActivityEvent = z.object({
  ts: z.number(),
  userId: z.string(),
  projectId: z.string(),
 // "teamai" = 团队仓资源动作(push/remove/contribute; §2.5)。
  category: z.enum(["task", "approval", "doc", "node", "build", "member", "eval", "teamai"]),
  type: z.string(),
  summary: z.string(),
  link: z.string().optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

// ---- 客户端 → relay ----
export const RelayClientMessage = z.discriminatedUnion("type", [
  /** 挑战应答:公钥+nonce 签名(私钥在客户端;relay 以指纹为信任锚校验公钥再验签)。 */
  Envelope.extend({
    type: z.literal("relay.auth"),
    fingerprint: z.string().min(1),
    publicKeyPem: z.string().min(1),
    nonce: z.string().min(1),
    sig: z.string().min(1),
  }),
  /** presence 事实上行(25s 心跳节律)。 */
  Envelope.extend({ type: z.literal("relay.presence"), facts: PresenceFacts }),
  /** 推自己的活动事件(personal/team 由 projects.yaml 定可见性)。 */
  Envelope.extend({ type: z.literal("relay.activity.push"), event: ActivityEvent }),
  /** 拉活动流(since=ts,隐私过滤按请求者)。 */
  Envelope.extend({ type: z.literal("relay.activity.list"), since: z.number().optional() }),
 /** owner 生成一次性邀请码(角色校验在 relay:canInvite);projects=邀请入册时绑定的项目。 */
  Envelope.extend({
    type: z.literal("relay.invite.create"),
    displayName: z.string().optional(),
    projects: z.array(z.string()).optional(),
  }),
  /** 兑换邀请码(允许未认证连接——兑换的前提就是尚未入册)。 */
  Envelope.extend({
    type: z.literal("relay.invite.redeem"),
    code: z.string().min(1),
    username: z.string().min(1),
    displayName: z.string().default(""),
    fingerprint: z.string().min(1),
  }),
  /** 通知 relay 拉取团队仓(reviewer 合并 MR 后主动通知,轮询兜底)。 */
  Envelope.extend({ type: z.literal("relay.roster.changed") }),
  /** teamai push:把一份资源以团队仓形态写分支+MR(teamai/push/<user>/<ts> 约定;需认证)。
 * kind 缺省 "skill"(向后兼容旧客户端; §2.2)。
   * body 不在此处 min(1):空 body 由 relay 回 `push.result{code:"invalid"}`(可诊断的拒绝)。 */
  Envelope.extend({
    type: z.literal("relay.teamai.push"),
    ns: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(""),
    body: z.string().default(""),
    contributors: z.array(z.string()).optional(),
    kind: z.enum(["skill", "rule", "doc"]).optional(),
  }),
 /** teamai remove:删团队仓 main 上的一个资源并推送( §2.3)。
   * ns/name 不在此处 min(1):空 name 由 relay 回 `remove.result{code:"invalid"}`(契约要求)。 */
  Envelope.extend({
    type: z.literal("relay.teamai.remove"),
    kind: z.enum(["skill", "rule", "doc"]),
    ns: z.string().default(""),
    name: z.string().default(""),
  }),
 /** teamai contribute:会话经验写 learnings 分支( §2.4);
   * title/body 空由 relay 回 `contribute.result{code:"invalid"}`。 */
  Envelope.extend({
    type: z.literal("relay.teamai.contribute"),
    title: z.string().default(""),
    body: z.string().default(""),
    tags: z.array(z.string()).optional(),
    project: z.string().optional(),
  }),
  /** 成员卡查询(隐私红线:personal 项目对他人=notFound)。 */
  Envelope.extend({
    type: z.literal("relay.query.member"),
    target: z.string().min(1),
  }),
  Envelope.extend({ type: z.literal("ping") }),
]);
export type RelayClientMessage = z.infer<typeof RelayClientMessage>;

// ---- relay → 客户端 ----
export const RelayServerMessage = z.discriminatedUnion("type", [
  /** 连接即发:鉴权挑战。 */
  Envelope.extend({ type: z.literal("relay.challenge"), nonce: z.string() }),
  Envelope.extend({
    type: z.literal("relay.auth.ok"),
    member: z.object({ username: z.string(), role: z.string() }),
  }),
  Envelope.extend({
    type: z.literal("relay.auth.reject"),
    reason: z.string(),
    /** 机器可读拒绝类:client 据此区分「等 MR 合并的重试(not-on-roster)」与「永久拒绝」。 */
    code: z.enum(["not-on-roster", "revoked", "key-mismatch", "bad-sig"]).optional(),
  }),
 /** presence diff(只发变化项);projects=成员项目归属(项目绑定团队,relay 从 roster 附带)。 */
  Envelope.extend({
    type: z.literal("relay.presence.diff"),
    states: z.array(z.object({
      fingerprint: z.string(),
      username: z.string(),
      state: PresenceStateName,
      lastActiveAt: z.number(),
      projects: z.array(z.string()).optional(),
    })),
  }),
  /** 项目注册表(roster projects.yaml 镜像;gateway 据此做「激活项目 git remote ↔ 团队项目」绑定)。 */
  Envelope.extend({
    type: z.literal("relay.projects"),
    projects: z.record(z.string(), z.object({
      type: z.string().optional(),
      repo: z.string().optional(),
    })),
  }),
 /** teamai 团队仓资产投影(skills/rules/docs/env/hooks/... 的 digest;secrets 只出 key)。 */
  Envelope.extend({
    type: z.literal("relay.teamai.digest"),
    digest: z.record(z.unknown()),
  }),
  Envelope.extend({
    type: z.literal("relay.teamai.push.result"),
    ok: z.boolean(),
    branch: z.string().optional(),
    reason: z.string().optional(),
    code: z.string().optional(),
  }),
 /** 删除结果( §2.3):code=invalid|not-found|unauthorized。 */
  Envelope.extend({
    type: z.literal("relay.teamai.remove.result"),
    ok: z.boolean(),
    path: z.string().optional(),
    reason: z.string().optional(),
    code: z.string().optional(),
  }),
 /** 经验贡献结果( §2.4):成功带 branch+path。 */
  Envelope.extend({
    type: z.literal("relay.teamai.contribute.result"),
    ok: z.boolean(),
    branch: z.string().optional(),
    path: z.string().optional(),
    reason: z.string().optional(),
    code: z.string().optional(),
  }),
  Envelope.extend({ type: z.literal("relay.activity"), events: z.array(ActivityEvent) }),
  Envelope.extend({
    type: z.literal("relay.invite.issued"),
    code: z.string(), expiresAt: z.number(),
    projects: z.array(z.string()).optional(),
  }),
  Envelope.extend({
    type: z.literal("relay.invite.result"),
    ok: z.boolean(),
    mr: z.object({ branch: z.string(), title: z.string() }).optional(),
    reason: z.string().optional(),
  }),
  Envelope.extend({ type: z.literal("relay.member.joined"), username: z.string() }),
  Envelope.extend({
    type: z.literal("relay.query.result"),
    notFound: z.boolean().default(false),
    card: z.object({
      username: z.string(),
      state: PresenceStateName,
      currentTask: z.string().nullable(),
    }).nullable(),
  }),
  Envelope.extend({ type: z.literal("error"), code: z.string(), message: z.string() }),
  Envelope.extend({ type: z.literal("pong"), time: z.number() }),
]);
export type RelayServerMessage = z.infer<typeof RelayServerMessage>;

/** 解析 relay 客户端消息;非法返回 null。 */
export function parseRelayClientMessage(raw: string): RelayClientMessage | null {
  try {
    const r = RelayClientMessage.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
