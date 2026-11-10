/**
 * roster yaml schema(形状参照 teamai-cli src/types.ts MemberConfigSchema 等,MIT;
 * 字段按 designs/05 身份模型扩展:fingerprint/keys)。
 */
import { z } from "zod";

export const MemberSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().default(""),
  /** 身份指纹(designs/05:设备 ed25519 公钥指纹)。 */
  fingerprint: z.string().min(1),
  /** 同成员多设备的全部指纹。 */
  keys: z.array(z.string()).default([]),
  role: z.enum(["owner", "reviewer", "member"]).default("member"),
  /** 团队角色 id(designs/30 §2.1:roster/roles.yaml 的 id;空串=无角色)。与上面的权限位 role 同名不同义,禁止合并。 */
  roleId: z.string().default(""),
  projects: z.array(z.string()).default([]),
  invitedBy: z.string().optional(),
  registeredAt: z.string(),
  /** 吊销标记:被吊销的指纹拒绝一切连接。 */
  revoked: z.boolean().default(false),
});
/**
 * 成员类型:roleId 在类型面放宽为可选——W1 的 roster 读入字面量(team-relay.ts)尚未带该字段,
 * schema 已保证解析时默认 ""(契约 §2.6 运行时语义不变);该放宽待 W1 侧字面量补齐后可收回。
 */
export type Member = Omit<z.infer<typeof MemberSchema>, "roleId"> & { roleId?: string };

export const RolesSchema = z.object({
  roles: z.record(z.string(), z.object({
    canApproveMR: z.boolean().default(false),
    canInvite: z.boolean().default(false),
    canRevoke: z.boolean().default(false),
  })),
});
export type Roles = z.infer<typeof RolesSchema>;

export const ProjectsSchema = z.object({
  projects: z.record(z.string(), z.object({
    type: z.enum(["personal", "team"]),
    repo: z.string().optional(),
    provider: z.string().optional(),
    sharedNodes: z.array(z.string()).default([]),
  })),
});
export type Projects = z.infer<typeof ProjectsSchema>;
