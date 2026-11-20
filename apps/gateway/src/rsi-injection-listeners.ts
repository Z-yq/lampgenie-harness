/**
 * RSI 注入枢纽的生产注册点(事件面 v1 首批 listener)。
 * 之前每个 RSI 注入位都是一次 run-with-agent 核心修改;现在开工注入统一走
 * `rsiInjectionHub.collect({point:"kickoff",...})`,listener 在本文件注册:
 * - negkb-deadends:负面知识库死路警告( B2a 的 listener 化,行为不变);
 * - gap-prevention:缺失物预防件(#211 消费面首次接线)——gap-taxonomy 的内置分类账
 * 经 seedTaxonomy 落地后,按注入点(pre-requirement=开工)取 context 块注入。
 * 纪律:listener 只产文本零 IO 写入(gap 读取/seed 在调度器做);台账驻 gateway
 * repoRoot,远程项目不注入(由调用方门控);fail-soft 由 hub 兜底。
 */
import { createLoopInjectionHub, type LoopInjectionHub } from "@lampgenie/runtime/agent/loop-injection-hub";
import { inject as negKbInject } from "./negative-kb-store.js";
import { applyAt } from "./gap-taxonomy-store.js";
import { repoRoot } from "./repo-root.js";

export const RSI_INJECTION_POINT_KICKOFF = "kickoff";

/**
 * 五阶段 → 注入点(阶段恰时注入):task_phase 回执携带,映射到 gap-taxonomy 的
 * INJECTION_POINTS(understand→pre-requirement / plan→pre-plan / implement→pre-write /
 * verify→pre-verify / close→pre-close)。
 */
export const RSI_INJECTION_POINT_FOR_PHASE: Record<string, string> = {
  understand: "phase-understand",
  plan: "phase-plan",
  implement: "phase-implement",
  verify: "phase-verify",
  close: "phase-close",
};

export const rsiInjectionHub: LoopInjectionHub = createLoopInjectionHub({ totalMaxBytes: 4096 });

rsiInjectionHub.register({
  id: "negkb-deadends",
  maxBytes: 1200,
  collect: (input) => {
 // 死路警告只在开工位注入(规划前一次性;阶段位不重复)。
    if (input.point !== RSI_INJECTION_POINT_KICKOFF) return "";
    const negkb = negKbInject(repoRoot(), { planText: input.taskText, taskClass: input.taskClass ?? "coding" }, { maxChars: 1200 });
    if (negkb.blocks.length === 0) return "";
    return "## 已验证死路(负面知识库,别再走)\n以下做法在本仓已被实证失败,直接用「替代」方案:\n" + negkb.blocks.join("\n");
  },
});

/** hub 注入点 → gap-taxonomy 注入点(阶段恰时:该阶段「之前」生效)。 */
const GAP_POINT_FOR_HUB: Record<string, string> = {
  kickoff: "pre-requirement",
  "phase-understand": "pre-requirement",
  "phase-plan": "pre-plan",
  "phase-implement": "pre-write",
  "phase-verify": "pre-verify",
  "phase-close": "pre-close",
};

rsiInjectionHub.register({
  id: "gap-prevention",
  maxBytes: 1024,
  collect: (input) => {
    const gapPoint = GAP_POINT_FOR_HUB[input.point];
    if (gapPoint === undefined) return "";
    const applied = applyAt(repoRoot(), gapPoint, {
      taskClass: input.taskClass,
      ...(input.module !== undefined ? { module: input.module } : {}),
    });
    if (!applied.ok || applied.contextBlocks.length === 0) return "";
    return "## 历史缺失预防件(同根因 ≥N 次的检查提醒)\n" + applied.contextBlocks.join("\n");
  },
});
