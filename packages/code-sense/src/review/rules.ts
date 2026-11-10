/**
 * 规则引擎(ocr config/rules 思想 TS 重写):四层叠加(custom>项目>全局>内置),
 * 按文件路径 glob 匹配注入 checklist;内置 default 五维+常用语言子集。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ReviewRule {
  /** glob 模式(对文件路径)。 */
  pattern: string;
  /** checklist markdown(注入 prompt 的 {{system_rule}})。 */
  checklist: string;
}

/** 内置规则(default 五维=ocr rule_docs/default.md 精神;语言子集按扩展名)。 */
const BUILTIN_RULES: ReviewRule[] = [
  {
    pattern: "**/*.ts",
    checklist: `## TypeScript Checklist
- 正确性:类型窄化是否正确(any 滥用/断言掩盖)/空值与 undefined 边界/async 错误传播
- 安全:用户输入进 eval/动态 import/SQL 拼接/路径穿越
- 性能:热路径同步 IO/无界数组增长
- 可维护性:导出面是否最小/命名与仓内一致
- 测试:变更行为是否有对应测试覆盖`,
  },
  {
    pattern: "**/*.tsx",
    checklist: `## React Checklist
- 正确性:hooks 依赖数组/竞态(未取消的异步 setState)/key 稳定性
- 安全:dangerouslySetInnerHTML/用户输入直渲染(XSS)
- 性能:不必要的重渲染(缺 memo 的热组件)/列表无 key
- 行为变更:受控/非受控切换/事件时序变化`,
  },
  {
    pattern: "**/*.py",
    checklist: `## Python Checklist
- 正确性:可变默认参数/类型混淆/异常吞掉(bare except)/缩进块作用域
- 安全:eval/exec/pickle 反序列化/SQL 拼接/路径穿越
- 性能:循环内重复 IO/低效字符串拼接
- 并发:共享可变状态无锁`,
  },
  {
    pattern: "**/*.{go,java,rs}",
    checklist: `## 系统语言 Checklist
- 正确性:错误分支遗漏/nil-null 解引用/整数溢出/所有权/生命周期
- 并发:goroutine 泄漏/未加锁共享/map 并发写
- 资源:defer/close 缺失导致的泄漏`,
  },
  {
    pattern: "**/*",
    checklist: `## 通用 Checklist(五维)
- 正确性 Correctness:逻辑错误/边界条件/错误处理
- 安全 Security:注入/越权/数据暴露/凭证
- 性能 Performance:明显复杂度问题/热路径阻塞
- 可维护性 Maintainability:抽象一致性/过度嵌套/命名
- 测试覆盖 Test Coverage:变更是否有测试`,
  },
];

/** glob 匹配(轻量:** 前缀 + 尾缀;支持 *.{a,b} 与 *.spec.ts 多级后缀)。 */
function matchRule(pattern: string, path: string): boolean {
  const tail = pattern.replace(/^\*\*\//, "");
  if (tail === "*") return true;
  // **/*.{a,b} → 扩展名任一
  const extAlt = /\*\.\{([^}]+)\}$/.exec(tail)?.[1];
  if (extAlt) return extAlt.split(",").some((e) => path.endsWith(e.trim()));
  // **/*.spec.ts → 后缀 .spec.ts(多级)
  if (tail.startsWith("*")) return path.endsWith(tail.slice(1));
  return false;
}

export interface RuleLayer { name: string; rules: ReviewRule[] }

/** 四层叠加:custom(--rule)>项目(.opencodereview/rule.json 形态)>全局(~)>内置。 */
export function loadRules(
  root: string,
  custom?: { pattern: string; checklist: string }[],
): { layers: RuleLayer[]; rulesFor: (path: string) => string } {
  const layers: RuleLayer[] = [];
  if (custom?.length) layers.push({ name: "custom", rules: custom });
  const projectRule = join(root, "opencodereview", "rule.json");
  const readLayer = (p: string, name: string): void => {
    if (!existsSync(p)) return;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as ReviewRule[];
      if (Array.isArray(parsed) && parsed.length) layers.push({ name, rules: parsed });
    } catch { /* 坏配置忽略(降级到下一层) */ }
  };
  readLayer(projectRule, "project");
  readLayer(join(process.env.HOME ?? "", ".opencodereview", "rule.json"), "global");
  layers.push({ name: "builtin", rules: BUILTIN_RULES });

  return {
    layers,
    rulesFor(path: string): string {
      for (const layer of layers) {
        for (const r of layer.rules) {
          if (matchRule(r.pattern, path)) return r.checklist;
        }
      }
      return BUILTIN_RULES[BUILTIN_RULES.length - 1]!.checklist; // 通用兜底
    },
  };
}
