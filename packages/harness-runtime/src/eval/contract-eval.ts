/**
 * L1 契约 eval:用代码锁定 prompt 关键语句/工具清单,防漂移。
 * 模式参照 qwen-audio-agent 契约式 eval。
 */
import { readFileSync } from "node:fs";
import { glob } from "glob";

export interface ContractRule {
  /** 规则名。 */
  name: string;
  /** 目标文件 glob(每份匹配文件都必须满足全部短语;短语分散多文件时用 targetAny)。 */
  target?: string;
  /** 多目标 glob:mustContain 短语命中**任一**匹配文件即满足;mustNot 任一文件出现即红。 */
  targetAny?: string[];
  /** 必须出现的关键语句(任一缺失即红)。 */
  mustContain?: string[];
  /** 不得出现的内容(任一出现即红)。 */
  mustNotContain?: string[];
}

export interface ContractViolation {
  rule: string;
  file: string;
  missing?: string;
  forbidden?: string;
}

export function runContractEval(rules: ContractRule[], cwd: string): ContractViolation[] {
  const violations: ContractViolation[] = [];
  for (const rule of rules) {
    if (rule.targetAny && rule.targetAny.length > 0) {
 // 联合语义:每条 mustContain 命中任一目标文件即满足;mustNot 任一文件出现即红。
      const blobs = rule.targetAny.map((g) => ({ g, files: glob.sync(g, { cwd, absolute: true }) }));
      for (const needle of rule.mustContain ?? []) {
        const hit = blobs.some(({ files }) => files.some((f) => readFileSync(f, "utf-8").includes(needle)));
        if (!hit) violations.push({ rule: rule.name, file: rule.targetAny.join(" | "), missing: needle });
      }
      for (const bad of rule.mustNotContain ?? []) {
        const hit = blobs.some(({ files }) => files.some((f) => readFileSync(f, "utf-8").includes(bad)));
        if (hit) violations.push({ rule: rule.name, file: rule.targetAny.join(" | "), forbidden: bad });
      }
      continue;
    }
    const files = glob.sync(rule.target ?? "", { cwd, absolute: true });
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      for (const needle of rule.mustContain ?? []) {
        if (!content.includes(needle)) {
          violations.push({ rule: rule.name, file, missing: needle });
        }
      }
      for (const bad of rule.mustNotContain ?? []) {
        if (content.includes(bad)) {
          violations.push({ rule: rule.name, file, forbidden: bad });
        }
      }
    }
  }
  return violations;
}
