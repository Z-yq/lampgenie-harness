/**
 * 项目级权限规则存取(F2 always-allow,ZCode addRules→项目 scope 移植):
 * .genie/permissions.json(fromConfig 形态),写入即合并;ask 咨询走 mtime 缓存热加载。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { permissionRulesFromConfig, type PermissionRule } from "@lampgenie/core";

export type PermissionsConfig = Record<string, string | Record<string, "allow" | "deny" | "ask">>;

export function permissionsFile(root: string): string {
  return join(root, ".genie", "permissions.json");
}

export function loadPermissionsConfig(root: string): PermissionsConfig {
  const file = permissionsFile(root);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as PermissionsConfig;
  } catch {
    return {}; // 坏文件容忍:规则面降级为空(不阻塞主流程);loadPermissionRules 的显式抛错语义在 env 路径保留
  }
}

/** 追加 always-allow 规则(合并同 permission 的 pattern 表;幂等)。
 * pattern 归一(C9, 四期):面板传的 pattern=ask 摘要首词(如 "safe-cmd"),而 agent loop
 * 工具闸门按 evaluatePermission(call.name, "*") 评估——非通配 pattern 永不命中,用户点「总是允许」
 * 反而把该工具其余调用全锁进 ask 兜底(fail-closed 拒绝)。规则文件的 pattern 域统一存 "*"=工具级放行;
 * 摘要前缀的精细语义由 broker ask 摘要匹配链(matchPermissionRule)承担。 */
export function addAlwaysAllowRule(root: string, permission: string, pattern: string): { ok: true; config: PermissionsConfig } | { ok: false; reason: string } {
  if (!permission.trim()) return { ok: false, reason: "permission 为空" };
  const storePattern = pattern.includes("*") ? pattern : "*";
  const config = loadPermissionsConfig(root);
  const entry = config[permission];
  const patterns: Record<string, "allow" | "deny" | "ask"> = typeof entry === "string" ? { "*": entry as "allow" | "deny" | "ask" } : { ...(entry ?? {}) };
  if (patterns[storePattern] === "deny" || patterns[storePattern] === "ask") {
    return { ok: false, reason: `规则冲突:${permission}[${storePattern}] 已是 ${patterns[storePattern]}` };
  }
  patterns[storePattern] = "allow";
  config[permission] = Object.keys(patterns).length === 1 && patterns["*"] ? patterns["*"]! : patterns;
  const file = permissionsFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return { ok: true, config };
}

/** ask 咨询面:mtime 缓存热加载(规则文件变更后下一次 ask 即生效)。 */
let cached: { file: string; mtime: number; rules: PermissionRule[] } | null = null;
export function loadRulesHot(root: string): PermissionRule[] {
  // env 显式空集=测试隔离语义(GENIE_PERMISSION_RULES="[]" 覆盖文件;与 loadPermissionRules 的
  // env 优先级对齐,避免测试去搬生产规则文件——与并发会话互踩的教训)。
  if (process.env.GENIE_PERMISSION_RULES === "[]") return [];
  const file = permissionsFile(root);
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return [];
  }
  if (cached && cached.file === file && cached.mtime === mtime) return cached.rules;
  const rules = permissionRulesFromConfig(loadPermissionsConfig(root));
  cached = { file, mtime, rules };
  return rules;
}