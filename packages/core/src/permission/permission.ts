/**
 * 权限求值:规则 = (permission, pattern, action)。匹配用通配符。
 * 规则模型与「最后一条命中优先」语义参考 opencode 开源项目的 permission 设计(致谢),
 * 本文件为独立实现:无 Effect 依赖,纯函数 + 简单服务。
 */

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  /** 权限名,如 "fs.write" / 工具名 "spawn_subagent"。 */
  permission: string;
  /** 目标模式,如 "/etc/*" 或 "*"。 */
  pattern: string;
  action: PermissionAction;
}

/** 通配符匹配(* → 任意段,? → 单字符;大小写敏感)。 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.split("?").map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*") + "$",
  );
  return re.test(input);
}

/** 展开 ~ 与 $HOME 前缀。 */
export function expandHome(pattern: string, home = process.env.HOME ?? "~"): string {
  if (pattern === "~") return home;
  if (pattern.startsWith("$HOME/") || pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

/** 从多个 ruleset(数组的数组)里找最后一条命中的规则;都没有则默认 ask(fail-safe)。 */
export function evaluatePermission(
  permission: string,
  pattern: string,
  rulesets: PermissionRule[][],
  wildcardMatchFn: (input: string, pattern: string) => boolean = wildcardMatch): PermissionRule {
  for (const ruleset of [...rulesets].reverse()) {
    for (const rule of [...ruleset].reverse()) {
      if (wildcardMatchFn(permission, rule.permission) && wildcardMatchFn(pattern, rule.pattern)) {
        return rule;
      }
    }
  }
  return { action: "ask", permission, pattern: "*" };
}

/**
 * 配置形态({perm: action} 或 {perm: {pattern: action}})→ 平铺 ruleset。
 * 配置形态平铺;.genie/permissions.json 与 env JSON 共用此入口。
 */
export function permissionRulesFromConfig(
  config: Record<string, string | Record<string, PermissionAction>>,
): PermissionRule[] {
  const out: PermissionRule[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      if (value !== "allow" && value !== "deny" && value !== "ask") {
        throw new Error(`权限配置非法: ${key} = ${value}(只允许 allow|deny|ask)`);
      }
      out.push({ permission: key, action: value, pattern: "*" });
      continue;
    }
    for (const [pattern, action] of Object.entries(value)) {
      out.push({ permission: key, action, pattern: expandHome(pattern) });
    }
  }
  return out;
}

/**
 * 子代理规则派生:只收不放——
 * 父的 deny 全部下传;allow/ask 不下传(不放大、不转嫁无人应答的 ask)。
 */
export function deriveChildRules(parent: PermissionRule[]): PermissionRule[] {
  return parent.filter((r) => r.action === "deny").map((r) => ({ ...r }));
}

/**
 * 规则匹配(F2 always-allow):ask 到达时先查规则——确定性配置优先于交互。
 * 匹配语义:permission 相等或 "*";pattern "*" 全匹配,否则 summary 前缀命中。
 */
export function matchPermissionRule(
  rules: PermissionRule[],
  permission: string,
  summary: string): PermissionRule | undefined {
  for (const r of rules) {
    if (r.permission !== permission && r.permission !== "*") continue;
    const pattern = r.pattern ?? "*";
    // 前缀 glob 语义(ZCode Bash 前缀 scope 同形):首个 * 吸收后文;"rm *"→前缀"rm "。
    const literal = pattern.includes("*") ? pattern.slice(0, pattern.indexOf("*")) : pattern;
    if (literal === "" || summary.startsWith(literal)) return r;
  }
  return undefined;
}
