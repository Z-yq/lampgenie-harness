/**
 * 团队角色( §2.1/§2.7):roster/roles.yaml 的解析与读取。
 * 形状参照 teamai-cli/src/roles.ts,MIT,自有实现(零 yaml 依赖,逐行状态机解析,
 * 风格照抄 teamai-bridge.ts 的 parseHookList)。
 * 注意:此处的 role 是「资源命名空间集合」,与 member.role(owner/reviewer/member 权限位)同名不同义,
 * 成员侧引用走 roster/members/<username>.yaml 的 roleId 字段。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TeamaiRole {
  id: string;
  name: string;
  description: string;
  skills: string[];
  rules: string[];
}

/** 去掉包裹引号(与 teamai-bridge 的 unq 同义,保持 fail-soft)。 */
function unq(v: string): string {
  return /^".*"$/.test(v) || /^'.*'$/.test(v) ? v.slice(1, -1) : v;
}

/** 流式列表 `[a, b]` → ["a","b"];空/非流式形态 → []。 */
function flowList(val: string): string[] {
  const m = /^\[(.*)\]$/.exec(val.trim());
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((x) => unq(x.trim()))
    .filter(Boolean);
}

/**
 * roster/roles.yaml 解析:块式列表。
 * ```yaml
 * roles:
 *   - id: dev
 *     name: 开发
 *     description: 实现与自测
 *     skills: [demo-team-style]
 *     rules: [demo-typescript]
 * ```
 * skills/rules 同时支持块式(`- item` 缩进行)与流式(`[a, b]`)两种写法。
 * fail-soft:缺 id 的条目跳过,未知键忽略,坏行不抛错。
 */
export function parseRolesYaml(text: string): TeamaiRole[] {
  const roles: TeamaiRole[] = [];
  let cur: Partial<TeamaiRole> | null = null;
  let blockKey: "skills" | "rules" | null = null;

  const flush = () => {
    const id = (cur?.id ?? "").trim();
    if (id) {
      roles.push({
        id,
        name: (cur?.name ?? "").trim() || id,
        description: (cur?.description ?? "").trim(),
        skills: cur?.skills ?? [],
        rules: cur?.rules ?? [],
      });
    }
    cur = null;
    blockKey = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // 条目起点:`- id: dev`(也容忍 `- name: dev` 这类以其它键起头的形态)
    const item = /^\s*-\s+(\w+):\s*(.*)$/.exec(line);
    if (item) {
      flush();
      const key = item[1]!;
      const val = unq(item[2]!.trim());
      cur = key === "id" ? { id: val } : key === "name" ? { name: val } : {};
      continue;
    }

    // 块式列表续行(仅当上一行声明了 skills:/rules: 且无值)
    if (cur && blockKey) {
      const li = /^\s*-\s+(.+)$/.exec(line);
      if (li) {
        cur[blockKey] = [...(cur[blockKey] ?? []), unq(li[1]!.trim())];
        continue;
      }
    }

    const kv = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!kv || !cur) continue;
    const key = kv[1]!;
    const val = kv[2]!.trim();
    blockKey = null;
    if (key === "id") cur.id = unq(val);
    else if (key === "name") cur.name = unq(val);
    else if (key === "description") cur.description = unq(val);
    else if (key === "skills" || key === "rules") {
      const flow = flowList(val);
      cur[key] = flow;
      if (flow.length === 0 && val === "") blockKey = key;
    }
  }
  flush();
  return roles;
}

/** 读 `<cloneDir>/roster/roles.yaml`;不存在返回 [](团队仓可选带角色定义)。 */
export function readRoles(cloneDir: string): TeamaiRole[] {
  const p = join(cloneDir, "roster", "roles.yaml");
  if (!existsSync(p)) return [];
  try {
    return parseRolesYaml(readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}
