/**
 * super 审批分级:
 * 「每个 coding agent 有基本的工具/环境权限,不需要啥指令都问 super;只有危险指令、重资源操作
 * (build 等)、重启/发布/推远端等影响面非常宽的指令才问 super。其余按聊天窗权限设置走。」
 * 定位:PermissionBroker 在 submittedBy=super 分支上的**唯一分流判据**(纯函数、零 IO)。
 * - 命中 heavy(复用 core 的 classifyHeavyOp:build/install/全量测试/递归批处理)→ super;
 * - 命中 dangerous / restart / publish / wide-impact(本模块窄表)→ super;
 * - 其余(日常读写、ls/grep/单文件测试、普通命令)→ 返回 null,继续走 policy/面板权限路径。
 * 判定纪律(与 heavy-op 同源):从窄,宁可漏判走聊天窗权限,不可滥判把日常命令都抛给 super。
 * 判定只读 tool/summary/command;不执行、不落账。工具不是命令执行类时不做命令模式匹配,
 * 避免 write_file 内容里出现 `git push` 被误判。
 */
import { classifyHeavyOp, DEFAULT_HEAVY_OP_EXEMPTS, DEFAULT_HEAVY_OP_RULES, type HeavyOpRule } from "@lampgenie/core";

export type SuperApprovalCategory = "heavy" | "dangerous" | "restart" | "publish" | "wide-impact";

export interface SuperApprovalVerdict {
  category: SuperApprovalCategory;
 /** 一句话说明(进 super 请求摘要/审计,便于它快速裁决)。 */
  note: string;
 /** 命中的模式原文(可解释性;heavy 时为 core 规则 pattern)。 */
  pattern?: string;
}

/** 可执行命令类工具(命中才做命令模式匹配;subagent 内部工具从 summary 前缀识别)。 */
const COMMAND_TOOL_RE = /^(?:terminal|run_cmd|run_command|bash|shell|exec|execute|command|job|process)$/i;

/** 工具名是否命令执行类(调用方据此决定是否提取 command 字段,避免把 write_file 内容当命令)。 */
export function isCommandToolName(tool: string): boolean {
  return COMMAND_TOOL_RE.test(String(tool ?? "").trim().toLowerCase());
}
/** 子代理申请摘要形如 `[子代理 terminal] {...}`——里面的真实工具名决定是否按命令判。 */
const SUBAGENT_SUMMARY_RE = /^\[子代理\s+([^\]]+)\]/;
/** 影响面很宽、但不带命令文本的工具(直接送 super 自决)。 */
const WIDE_TOOLS: ReadonlySet<string> = new Set(["run_workflow"]);

interface RuleGroup {
  category: Exclude<SuperApprovalCategory, "heavy">;
  note: string;
  patterns: string[];
}

/**
 * 危险/重启/发布窄表(只匹配命令文本;均为「不可逆/越出工作区/影响全局进程或外部世界」类)。
 * 刻意不收:普通 rm(非根/非通配)、git commit/add/checkout 单文件、普通 npm test 单文件、
 * 普通 pnpm install 之外的日常命令——这些继续按聊天窗权限设置。
 */
const RULE_GROUPS: RuleGroup[] = [
  {
    category: "dangerous",
    note: "破坏性/不可逆命令",
    patterns: [
 // rm -rf 指向系统根/家目录/上级/盘符/根层通配(递归删 node_modules/dist//tmp 之类不在内)
      "\\brm\\s+-[a-zA-Z]*[rf][a-zA-Z]*\\s+(?:-\\S+\\s+)*(?:\\/(?:mnt|home|root|etc|usr|var|opt|srv|boot|dev|proc|sys)\\b|\\/\\s*$|\\/\\*|~|\\$HOME|\\.\\.(?:\\/|\\s|$)|[A-Za-z]:[\\\\/]|\\*)(?=\\s|$|/)",
      "\\bgit\\s+reset\\s+--hard\\b",
      "\\bgit\\s+clean\\s+-[a-zA-Z]*[fdx][a-zA-Z]*",
      "\\bgit\\s+checkout\\s+--\\s+\\.(?:\\s|$)",
      "\\bgit\\s+restore\\s+\\.(?:\\s|$)",
      "\\bgit\\s+branch\\s+-D\\b",
      "\\bdd\\b[^;&|]*\\bof=",
      "\\bmkfs(?:\\.\\w+)?\\b",
      "\\b(?:fdisk|parted)\\b",
      "\\bsudo\\b",
      "\\b(?:curl|wget)\\b[^;&|]*\\|\\s*(?:ba)?sh\\b",
      "\\bchmod\\s+-R\\b[^;&|]*\\s\\/(?:\\s|$)",
      "\\bchown\\s+-R\\b[^;&|]*\\s\\/(?:\\s|$)",
      "\\bdropdb\\b|\\bDROP\\s+DATABASE\\b|\\bTRUNCATE\\s+TABLE\\b",
      "\\bredis-cli\\b[^;&|]*\\bflushall\\b",
      "\\bcrontab\\s+-r\\b",
      "\\b(?:kill|killall|pkill)\\b",
    ],
  },
  {
    category: "restart",
    note: "重启/停服/影响全局进程",
    patterns: [
      "\\bsafe-restart-gateway\\b",
      "\\brestart-and-resume\\b",
      "\\b(?:shutdown|reboot|halt|poweroff)\\b",
      "\\bsystemctl\\s+(?:restart|stop|disable|mask|kill)\\b",
      "\\bservice\\s+\\S+\\s+(?:restart|stop)\\b",
      "\\bpm2\\s+(?:restart|stop|delete|kill)\\b",
      "\\bdocker\\s+(?:restart|stop|kill|rm|rmi|prune)\\b",
      "\\bkubectl\\s+(?:delete|apply|rollout|scale|drain|cordon)\\b",
      "\\bterraform\\s+(?:apply|destroy)\\b",
    ],
  },
  {
    category: "publish",
    note: "发布/推远端(对外可见,不可收回)",
    patterns: [
      "\\b(?:npm|pnpm|yarn)\\s+publish\\b",
      "\\bdocker\\s+push\\b",
      "\\bgit\\s+push\\b",
      "\\bgh\\s+release\\b",
    ],
  },
];

/** heavy-op 表的本仓补充(默认表之外的常见重资源;只增不删,判定仍从窄)。 */
const EXTRA_HEAVY_RULES: HeavyOpRule[] = [
  {
    category: "build",
    note: "容器/前台安装类构建",
    patterns: [
      "\\bdocker\\s+(?:compose\\s+)?build\\b",
      "\\bnpm\\s+ci\\b",
      "\\bpnpm\\s+ci\\b",
    ],
  },
];

/** 从 summary/arguments 里尽力提取完整命令文本(截断的 preview 之外,调用方可直接传 command)。 */
export function commandTextOf(candidate: { tool?: string; summary?: string; command?: string }): string {
  if (typeof candidate.command === "string" && candidate.command.trim() !== "") return candidate.command;
  const summary = String(candidate.summary ?? "");
 // 先尝试 JSON 片段(主链路 summary = "<tool> {json...}"):只收命令类键,不把 path/sessionId 当命令。
  const brace = summary.indexOf("{");
  const bracket = summary.indexOf("[");
  const start = brace >= 0 ? brace : bracket;
  if (start >= 0) {
    try {
      const parsed = JSON.parse(summary.slice(start)) as unknown;
      const parts: string[] = [];
      collectCommandFields(parsed, parts, 0);
      if (parts.length > 0) return parts.join("\n");
    } catch { /* 截断/非 JSON:继续用正则/原文 */ }
  }
 // 截断导致 JSON 不闭合时,至少把 command/cmd/script 字段的字面量抓出来。
  const re = /"(?:command|commands|cmd|script)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  const hits: string[] = [];
  for (let m = re.exec(summary); m !== null; m = re.exec(summary)) {
    try { hits.push(JSON.parse(`"${m[1]}"`) as string); } catch { hits.push(m[1]!); }
  }
  if (hits.length > 0) return hits.join("\n");
  return summary;
}

function collectCommandFields(v: unknown, out: string[], depth: number): void {
  if (depth > 4 || v === null || v === undefined) return;
  if (typeof v === "string") return;
  if (Array.isArray(v)) {
    for (const x of v) collectCommandFields(x, out, depth + 1);
    return;
  }
  if (typeof v !== "object") return;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (key === "command" || key === "cmd" || key === "script") {
      if (typeof val === "string" && val.trim() !== "") out.push(val);
      continue;
    }
    if (key === "commands" && Array.isArray(val)) {
      for (const x of val) if (typeof x === "string" && x.trim() !== "") out.push(x);
      continue;
    }
    collectCommandFields(val, out, depth + 1);
  }
}

/** 子代理摘要里的真实工具名(`[子代理 terminal] ...` → terminal);非子代理=原 tool。 */
export function effectiveToolOf(candidate: { tool?: string; summary?: string }): string {
  const tool = String(candidate.tool ?? "").trim();
  if (tool.toLowerCase() === "subagent") {
    const m = SUBAGENT_SUMMARY_RE.exec(String(candidate.summary ?? ""));
    if (m && m[1]) return m[1].trim().toLowerCase();
  }
  return tool.toLowerCase();
}

/**
 * 判定一次权限申请是否必须送 super 自决。
 * 返回 null = 走聊天窗权限设置(规则/会话代答/面板审批,原路径不变)。
 */
export function superApprovalVerdict(candidate: {
  tool?: string;
  summary?: string;
  risk?: string;
  command?: string;
}): SuperApprovalVerdict | null {
  const tool = effectiveToolOf(candidate);
  if (WIDE_TOOLS.has(tool)) {
    return { category: "wide-impact", note: "多代理/工作流编排,资源与影响面放大" };
  }
  const isCommandTool = COMMAND_TOOL_RE.test(tool) || (typeof candidate.command === "string" && candidate.command.trim() !== "");
  if (!isCommandTool) return null;
  const text = commandTextOf(candidate);
  if (text.trim() === "") return null;
 // ① 重资源(单一真源:core heavy-op 表,含 build/install/全量测试/递归批处理)
  const heavy = classifyHeavyOp(text, [...DEFAULT_HEAVY_OP_RULES, ...EXTRA_HEAVY_RULES], DEFAULT_HEAVY_OP_EXEMPTS);
  if (heavy) {
    return {
      category: "heavy",
      note: heavy.note ?? `重资源操作(${heavy.category})`,
      ...(heavy.pattern ? { pattern: heavy.pattern } : {}),
    };
  }
 // ② 危险/重启/发布窄表
  for (const g of RULE_GROUPS) {
    for (const src of g.patterns) {
      if (new RegExp(src).test(text)) {
        return { category: g.category, note: g.note, pattern: src };
      }
    }
  }
  return null;
}