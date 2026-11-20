/**
 * SOP 行式卡注册表(tips 机制 SOP 化升级,2026-11)。
 * 定位:把常驻纪律压成「恰时行式卡」——五硬阶段首见那一刻注入对应阶段卡,一次为限
 * (compact 后允许重注入一次,与 dispatch 同语义,由 buildLoopTips 的 fired 集合承担,不另造机制)。
 * 卡面=行式短句:一行一个动作、动词开头,每卡 ≤SOP_TIP_MAX_LINES 行(含标题行)。
 * 硬红线(勿破,均有验证出处):
 * - 不回到「每条消息匹配式 tips」做法(已删):SOP 卡只按 phase 首见与
 *   上一步工具带错兜底触发,不按消息内容匹配;
 * - 不做 verify 卡:验收四步已由 task_phase(phase="verify") 回执送达(agent-wiring.ts
 *   task_phase 回执 phaseGuide),再注一张=重复信息,违 N3 教训;
 * - 恰时:动作前一刻触达(phase 首见即注入),不提前塞满开工上下文。
 * 文案出处:全部为本仓已验证教训(见各卡注释),不新造纪律。
 */

/** 每卡行数上限(含标题行);apps/gateway/test/sop-tips.test.ts 逐卡断言。 */
export const SOP_TIP_MAX_LINES = 6;

/** 五硬阶段 SOP 卡(键=阶段 key;无 verify——见文件头红线)。 */
export const SOP_TIPS: Readonly<Record<string, readonly string[]>> = {  /** 出处:task_phase 理解自查已有雏形(agent-wiring.ts task_phase 回执的阶段引导),本卡是恰时强化。 */
  understand: [
    "SOP·理解(进入任务的第一件事)",
    "需求反述一句话再动手(防越做越偏)",
    "三问过一遍:同类扩展?上下游牵动?异常与规模上限?",
    "实为问答/办公类 → task_phase(taskClass=...) 更正,免仪式",
    "单文件小改 → task_phase(phase=\"implement\", route=\"direct\") 直达",
  ],
  /** 出处:AGENTS.md 常驻纪律 impact 前置(改前先查影响面)。 */
  plan: [
    "SOP·规划(动刀之前)",
    "code_sense impact 查影响面(caller/callee)再选改法",
    "候选方案 ≥2(各带代价)再定",
    "多文件/多模块 → 落板,验收 accept 带可执行命令",
    "规划稿落 step.md",
  ],
  /** 出处:收尾纪律「每改必验」+变更集纪律(变更集外既有失败登记不修)。 */
  implement: [
    "SOP·实施(每改一笔)",
    "小步改,每改必验:测试/命令当场跑",
    "无依赖动作放同一条消息一起发",
    "变更集外的既有失败:登记不修(带证据)",
    "不碰其它任务的在途改动",
  ],
  /** 出处:builtin/systematic-debugging + Google SRE 排障口径 + 收尾纪律「同一逻辑最多 2 轮」。 */
  debug: [
    "SOP·排障(出错时)",
    "先说假设再动手(最近变更优先)",
    "设计最小验证,按结果排除/收敛,二分定位",
    "同一逻辑最多改 2 轮;第 3 轮带最小复现停手",
    "修完写一行根因结论",
  ],
  /** 出处:收尾纪律三段汇报。 */
  close: [
    "SOP·收尾(汇报之前)",
    "三段汇报:改了什么/验证了什么(条件+通过标准+实际结果)/还剩什么",
    "事故类任务补一句无责复盘",
    "P0 证据全绿才宣称完成",
  ],
};

/**
 * 全链路变更类任务的阶段卡覆盖。
 * 「用户只描述意图,harness 自动找出该意图涉及的所有链路节点,一次性全部改到一致,
 * 并证明没有残留、没有孤儿、没有只改一半。」
 * 只覆盖 plan / close 两阶段(其余阶段与全链路无关,不新增卡);仍是「按 phase 首见注入」的
 * 同一条机制,不引入消息匹配式 tips。每卡 ≤SOP_TIP_MAX_LINES。
 */
export const SOP_SURFACE_TIPS: Readonly<Record<string, readonly string[]>> = {
  /** 盘点 → 每条去向 → 一次改完 → 残留审计(四步 SOP,出处:全链路闭环变更机制)。 */
  plan: [
    "SOP·全链路(动刀之前)",
    "先盘点:change_surface action=scan 概念词 → 11 类表面清单 + 链路图",
    "每条给去向:改/删/保留旧(keep-legacy 必须写理由)",
    "按清单一次改完,不要只改一类就收",
    "汇报前 action=audit,0 未处理才算完成",
  ],
  /** 收尾:残留审计(与 close 常规卡互补,不重复三段汇报)。 */
  close: [
    "SOP·全链路收尾",
    "change_surface action=audit 重扫:0 unexplained 才宣称完成",
    "keep-legacy 每条都有理由(无理由=未处理)",
    "未通过就如实写「未通过全链路审计」并列剩余项",
  ],
};

/** 卡文本(行 join("\n"));未知 phase 返回空串(调用方按空=不注入处理)。
 *  surface=true 且该阶段有全链路覆盖卡时优先用覆盖卡(plan/close 两阶段)。 */
export function sopTipText(phase: string, surface = false): string {
  const lines = (surface ? SOP_SURFACE_TIPS[phase] : undefined) ?? SOP_TIPS[phase] ?? [];
  return lines.join("\n");
}

/**
 * 开工 brief 的三条停止规则(固定中文行,渲染侧永不裁剪)。
 * 出处:本仓已验证的三类高耗循环——
 * ①同一文件连改 3 次仍失败 = 假设错了(收尾纪律「同一逻辑最多 2 轮」的硬止损);
 * ②patch 失败凭记忆重试 → 必然再失败(apply_patch 的上下文已漂移,必须重读);
 * ③一步一个独立查询 → 每往返重发整段上下文(并行工具纪律)。
 * 只放这三条:停止规则是刹车,不是清单;再多会被模型当背景噪声跳过。
 */
export const START_BRIEF_STOP_RULES: readonly string[] = [
  "同一文件连续改 3 次仍失败:停手先问用户,别再换写法硬撞",
  "patch/apply_patch 失败:先重读文件再改,不凭记忆重试",
  "互不依赖的查询合批一次发,别一步一个往返",
];

/**
 * 把 renderWorkStartBrief 的正文包成可直插稳定前缀(system / kickoff 块)的段落。
 * 空正文=空串(调用方按空=不注入);正文本身已确定性,包装不再引入时间戳/随机数。
 */
export function renderStartProfileTip(brief: string): string {
  const body = String(brief ?? "").trim();
  if (!body) return "";
  return "\n\n## 开工画像(稳定前缀:同输入同文本,勿重复探测)\n" + body;
}
