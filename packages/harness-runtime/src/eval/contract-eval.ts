/**
 * L1 契约 eval:用代码锁定 prompt 关键语句/工具清单,防漂移。
 * 模式参照 qwen-audio-agent 契约式 eval。
 */
import { readFileSync } from "node:fs";
import { glob } from "glob";

export interface ContractRule {
  /** 规则名。 */
  name: string;
  /** 目标文件 glob。 */
  target: string;
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
    const files = glob.sync(rule.target, { cwd, absolute: true });
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
