/**
 * heavy-op 判定(父子 ask-answer 机制):命令级重操作识别。
 * 定位:纯函数判定表——子代理(run_cmd 等命令执行工具)发起 build/install/全量测试/
 * 递归批处理类大资源操作时,机制层强制走父 agent 审批(即使 allow 规则命中也拦,
 * unless 显式豁免)。判定只看命令字符串,不看调用方——「调用方是子代理」由闸门侧
 * (loop.ts permission.heavyOp.callerIsSubagent)判定,本模块保持单一职责。
 * 设计纪律:
 * - 可配置可扩展:DEFAULT 表打底 + env 追加(GENIE_HEAVY_OP_EXTRA_RULES / GENIE_HEAVY_OP_EXEMPT);
 *   坏 JSON 显式抛错(配置错误不得静默变全放行,与 loadPermissionRules 同纪律)。
 * - 豁免先判:显式豁免(如单文件 vitest --maxWorkers=1)命中即放行,不再进分类。
 * - 判定从窄:宁可漏判(走旧链路)不可滥判(把 grep/cat 都拦下问父)——误伤的代价是
 *   每条命令多一轮审批,漏判的代价由既有规则链兜底。
 */

/** 一条 heavy 分类规则:pattern 为正则 source(可 JSON 配置;非法正则按配置错误抛错)。 */
export interface HeavyOpRule {
  /** 分类名(如 "build" / "install" / "full-test" / "bulk")。 */
  category: string;
  /** 命中模式(正则 source;对整条命令字符串做 search,链式命令 cd x && pnpm build 天然覆盖)。 */
  patterns: string[];
  /** 一句话说明(进结构化问题,给父 agent 决策参考)。 */
  note?: string;
}

/** 判定结果:kind 恒为 "cmd.heavy"(权限域别名,审批卡/规则书写用)。 */
export interface HeavyOpMatch {
  kind: "cmd.heavy";
  category: string;
  /** 命中的模式原文(审计可解释:为什么判重)。 */
  pattern: string;
  note?: string;
}

/** 默认分类表(TS monorepo 优先 + 常见构建/安装/全量测试;判定从窄,可 env 扩展)。 */
export const DEFAULT_HEAVY_OP_RULES: HeavyOpRule[] = [
  {
    category: "build",
    note: "构建类:产物编译/打包,CPU 与内存大头",
    patterns: [
      "\\bpnpm\\s+(?:--filter\\s+\\S+\\s+)?(?:run\\s+)?build\\b",
      "\\bnpm\\s+run\\s+build\\b",
      "\\byarn\\s+build\\b",
      "\\btsc\\s+(?:-b\\b|--build\\b)",
      "\\bnext\\s+build\\b",
      "\\bvite\\s+build\\b",
      "\\bwebpack\\b",
      "\\brollup\\s+-c\\b",
      "\\bgo\\s+build\\b",
      "\\bcargo\\s+build\\b",
      "\\bpython3?\\s+-m\\s+build\\b",
      "\\bgradle\\w*\\s+(?:build|assemble)\\b",
      "\\bmvn\\s+\\S*(?:package|verify)\\b",
    ],
  },
  {
    category: "install",
    note: "安装类:依赖安装/下载,网络与磁盘大头",
    patterns: [
      "\\bpnpm\\s+(?:add|install|i)\\b",
      "\\bnpm\\s+(?:install|i)\\b",
      "\\byarn\\s+(?:add|install)\\b",
      "\\bpip3?\\s+install\\b",
      "\\bapt(?:-get)?\\s+install\\b",
      "\\bbrew\\s+install\\b",
    ],
  },
  {
    category: "full-test",
    note: "全量测试:整包/整仓测试套件",
    patterns: [
      "\\bpnpm\\s+(?:-r\\s+|--recursive\\s+)?(?:run\\s+)?test\\b",
      "\\bnpm\\s+(?:run\\s+)?test\\b",
      "\\byarn\\s+test\\b",
      "\\bvitest\\s+run\\b",
      "\\bjest\\b",
      "\\bpytest\\b",
      "\\bgo\\s+test\\s+\\.\\.\\.\\b",
      "\\bcargo\\s+test\\b",
    ],
  },
  {
    category: "bulk",
    note: "递归/批量:跨包扇出执行,资源放大",
    patterns: [
      "\\bpnpm\\s+(?:-r\\b|--recursive\\b)",
      "\\bturbo\\s+run\\b",
      "\\bnx\\s+run-many\\b",
      "\\blerna\\s+run\\b",
      "\\bnpm\\s+[^;&|]*--workspaces\\b",
    ],
  },
];

/** 默认豁免表(显式白名单:命中即不判重;判准=单文件、单 worker、单包 typecheck)。 */
export const DEFAULT_HEAVY_OP_EXEMPTS: string[] = [
  // 单文件 vitest 且 --maxWorkers=1(两种参数顺序;必须带 .test/.spec 文件路径=「一次一个文件」)
  "vitest\\s+run\\s+[^;&|]*\\.(?:test|spec)\\.[cm]?[jt]sx?\\b[^;&|]*--maxWorkers=1",
  "vitest\\s+run\\s+[^;&|]*--maxWorkers=1[^;&|]*\\.(?:test|spec)\\.[cm]?[jt]sx?\\b",
];

/** 判定:豁免命中=null(放行);分类表首个命中=HeavyOpMatch;都不中=null。命令空白=null。 */
export function classifyHeavyOp(
  command: string,
  rules: HeavyOpRule[] = DEFAULT_HEAVY_OP_RULES,
  exemptPatterns: string[] = DEFAULT_HEAVY_OP_EXEMPTS): HeavyOpMatch | null {
  const cmd = String(command ?? "").trim();
  if (!cmd) return null;
  for (const src of exemptPatterns) {
    if (new RegExp(src).test(cmd)) return null;
  }
  for (const rule of rules) {
    for (const src of rule.patterns) {
      if (new RegExp(src).test(cmd)) {
        return { kind: "cmd.heavy", category: rule.category, pattern: src, ...(rule.note ? { note: rule.note } : {}) };
      }
    }
  }
  return null;
}

/** 便捷布尔判定(闸门侧主入口)。 */
export function isHeavyCommand(
  command: string,
  rules?: HeavyOpRule[],
  exemptPatterns?: string[],
): boolean {
  return classifyHeavyOp(command, rules, exemptPatterns) !== null;
}

export interface HeavyOpEnvConfig {
  /** 合并后的判定表(默认表在前,env 追加在后——env 只增不删,防配置失误拆掉打底表)。 */
  rules: HeavyOpRule[];
  exempts: string[];
}

/**
 * env 合并配置:GENIE_HEAVY_OP_EXTRA_RULES(JSON HeavyOpRule[])+ GENIE_HEAVY_OP_EXEMPT(JSON string[])。
 * env 只增不删(追加到默认表之后);坏 JSON/形态错显式抛错(fail-visible,配置错误不静默)。
 * env 参数可注入(测试隔离);缺省读 process.env。
 */
export function loadHeavyOpConfig(env: Record<string, string | undefined> = process.env): HeavyOpEnvConfig {
  const rules = [...DEFAULT_HEAVY_OP_RULES];
  const exempts = [...DEFAULT_HEAVY_OP_EXEMPTS];
  const extraRaw = env.GENIE_HEAVY_OP_EXTRA_RULES;
  if (extraRaw !== undefined && extraRaw !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extraRaw);
    } catch (err) {
      throw new Error("GENIE_HEAVY_OP_EXTRA_RULES 不是合法 JSON:" + String(err).slice(0, 120));
    }
    if (!Array.isArray(parsed)) throw new Error("GENIE_HEAVY_OP_EXTRA_RULES 必须是 HeavyOpRule[] 数组");
    for (const r of parsed as HeavyOpRule[]) {
      if (!r || typeof r.category !== "string" || !Array.isArray(r.patterns) || r.patterns.some((p) => typeof p !== "string")) {
        throw new Error("GENIE_HEAVY_OP_EXTRA_RULES 条目形态错:{category:string, patterns:string[]}");
      }
      for (const p of r.patterns) new RegExp(p); // 非法正则在此抛错(fail-visible)
      rules.push(r);
    }
  }
  const exemptRaw = env.GENIE_HEAVY_OP_EXEMPT;
  if (exemptRaw !== undefined && exemptRaw !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(exemptRaw);
    } catch (err) {
      throw new Error("GENIE_HEAVY_OP_EXEMPT 不是合法 JSON:" + String(err).slice(0, 120));
    }
    if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
      throw new Error("GENIE_HEAVY_OP_EXEMPT 必须是 string[](正则 source)");
    }
    for (const p of parsed as string[]) {
      new RegExp(p); // 非法正则在此抛错(fail-visible)
      exempts.push(p);
    }
  }
  return { rules, exempts };
}
