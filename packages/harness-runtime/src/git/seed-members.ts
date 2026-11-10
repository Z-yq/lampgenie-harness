/**
 * 成员种子导入(designs/06 R7-2 二期):从平台(group/project members)拉成员清单,
 * 生成 roster 种子条目;指纹仍走邀请流逐人登记——**安全边界不破**。
 *
 * roster 形态(与 team/team-relay 同一产消约定):roster 根目录下 members/<username>.yaml,
 * 每人一文件,yaml-lite 受控子集(扁平 key:value + 块式列表,见 team/yaml-lite)。
 *
 * 幂等语义:username 对应的成员文件**已存在即跳过**(roster 权威在 Git——手工/邀请流建立的
 * 完整条目与历史种子一律不 clobber);重复运行第二次起零写入。
 *
 * 种子条目形态:fingerprint=占位符("pending")、keys=[]、pendingInvite=true——
 * team-relay 的 roster 解析按白名单取字段,未知键(pendingInvite)被安全忽略;
 * 待该成员走完邀请流,正式条目(真实指纹)由 doCreateRosterBranch 以 MR 形态覆盖写入。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringifyYamlLite } from "../team/yaml-lite.js";
import type { PlatformMemberInfo } from "./gitlab.js";

/** 能出成员清单的 provider(GitLab/Codeup 均满足;结构化最小面,便于测试替身)。 */
export interface MemberListingProvider {
  listMembers(): Promise<PlatformMemberInfo[]>;
}

export interface SeedImportOptions {
  /** 平台成员→harness 角色映射;缺省=按 accessLevel(R7-2 对应表:Owner→owner、Maintainer→reviewer、其余→member)。 */
  roleMap?: (m: PlatformMemberInfo) => "owner" | "reviewer" | "member";
  /** 指纹占位串(默认 "pending")。 */
  fingerprintPlaceholder?: string;
}

export interface SeedImportResult {
  /** 新写入的种子用户名。 */
  added: string[];
  /** 跳过的用户名(已有条目/非法用户名——不 clobber 原则)。 */
  skipped: string[];
  /** 平台返回的成员总数。 */
  total: number;
}

/** 默认角色映射(designs/06 R7-2:「提示对齐用,不强制」的代码化)。 */
export function defaultRoleMap(m: PlatformMemberInfo): "owner" | "reviewer" | "member" {
  if (m.accessLevel === undefined) return "member";
  if (m.accessLevel >= 50) return "owner";
  if (m.accessLevel >= 40) return "reviewer";
  return "member";
}

/**
 * 导入平台成员为 roster 种子。
 * @param rosterPath roster 根目录(其下 members/ 为成员文件目录;不存在则创建)。
 */
export async function importMembersFromProvider(
  provider: MemberListingProvider,
  rosterPath: string,
  opts?: SeedImportOptions,
): Promise<SeedImportResult> {
  const members = await provider.listMembers();
  const placeholder = opts?.fingerprintPlaceholder ?? "pending";
  const roleOf = opts?.roleMap ?? defaultRoleMap;
  const membersDir = join(rosterPath, "members");
  mkdirSync(membersDir, { recursive: true });

  const added: string[] = [];
  const skipped: string[] = [];
  for (const m of members) {
    const username = (m.username ?? "").trim();
    // 文件名安全:拒绝路径穿越与非法形态(用户名只作文件名,绝不拼进 shell/git 命令)。
    if (!username || username === "." || username === ".." || /[/\\\0]/.test(username)) {
      skipped.push(username || "(空用户名)");
      continue;
    }
    const file = join(membersDir, `${username}.yaml`);
    if (existsSync(file)) {
      skipped.push(username); // 不 clobber:已有条目(正式成员或历史种子)一律保留
      continue;
    }
    const entry = {
      username,
      displayName: (m.name ?? "").trim() || username,
      fingerprint: placeholder,
      keys: [] as string[],
      role: roleOf(m),
      projects: [] as string[],
      registeredAt: new Date().toISOString(),
      revoked: false, // 显式默认态:吊销 MR 的 diff 可读(改 true),不靠字段缺省(与 relay 同约定)
      pendingInvite: true, // 种子=待邀请:指纹经邀请流登记后才算正式成员(R7 安全边界)
    };
    writeFileSync(file, stringifyYamlLite(entry));
    added.push(username);
  }
  return { added, skipped, total: members.length };
}
