/**
 * 内置技能禁用面(ZCode 技能开关对齐):
 * .genie/skills-disabled.json 存被停用的内置技能名;mergeSkillIndexWith 过滤后进系统提示。
 * 用户/项目技能走 ExperienceStore.status(disabled),两条通道互不干扰。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function skillsDisabledFile(root: string): string {
  return join(root, ".genie", "skills-disabled.json");
}

export function disabledBuiltins(root: string): string[] {
  const f = skillsDisabledFile(root);
  if (!existsSync(f)) return [];
  try {
    const arr = JSON.parse(readFileSync(f, "utf-8")) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setBuiltinDisabled(root: string, name: string, disabled: boolean): string[] {
  const cur = new Set(disabledBuiltins(root));
  if (disabled) cur.add(String(name));
  else cur.delete(String(name));
  const next = [...cur].sort();
  const f = skillsDisabledFile(root);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(next, null, 2) + "\n");
  return next;
}
