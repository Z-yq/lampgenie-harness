/**
 * change-scope:「这次请求是不是一次全面替换/迁移」的确定性判定(不调 LLM)。
 * 用途:gateway/CLI 在开工前判 scope——surface 级动作(替换/迁移/重命名/下线)
 * 必须先看概念足迹面全清单,普通小改(新建按钮、小修文案)不必。
 * 词表固定,空串/问候语/无动词请求一律 normal(保守:不把日常小改升级成全面替换)。
 */

export type ChangeScope = "surface" | "normal";

export interface ChangeScopeVerdict {
  scope: ChangeScope;
  /** 命中的动词原文(按词表顺序去重;便于回报「为什么判成 surface」)。 */
  matched: string[];
}

/** 中文动词表(任务口径 11 个 + 第二批 17 个;「废弃」第一批已有,不重复)。
 * 只收「换代/换实现/换位置」的动词;单字与泛动词(调整/改/优化/更新)不进表——
 * 它们在各处小改里都会出现,入表就把正常小改升级成全链路扫描(代价不对称)。 */
const SURFACE_VERBS_ZH = [
  // 第一批(11)
  "替换", "迁移", "重命名", "改名", "下线", "统一", "换掉", "改成", "废弃", "删除旧", "全面改",
  // 第二批(17):换实现/换名/删除/取代/搬迁/升级/收敛
  "换成", "换为", "换用", "切换为", "统一到", "统一成", "改名为", "重命名为",
  "移除", "删掉", "取代", "替代", "搬迁", "迁移到", "升级到", "整合到", "收敛到",
] as const;

/** 英文动词表(按词边界匹配,避免 removeAll 之外误伤)。 */
const SURFACE_VERBS_EN = [
  "replace", "migrate", "rename", "deprecate", "remove all",
  // 第二批(9):同义动词与短语
  "swap", "switch to", "convert to", "consolidate", "unify", "sunset", "drop", "move to", "replace with",
] as const;

/**
 * 显式「这就是个小改」标记(经验证回归修正)。
 * 注意:指令「把 config.ts 里的超时改成 30 秒,明确小改」命中「改成」→ 被判 surface →
 * 直达实施路由被全链路门拦掉(task-class.test.ts 的 direct 用例红)。「改成」既可以是全链路
 * 换代也可以是单点改值,纯词表必然误判。代价不对称:误判 surface 会**拦住**正常小改,
 * 而漏判 surface 只是少一次扫描(收尾审计仍会提示)。故只在用户/agent **显式**声明小改时抑制。
 */
const EXPLICIT_SMALL_MARKERS = ["明确小改", "明确是小改", "小改动", "小修", "只改一处", "只改这一处", "单点修改", "仅改一处"] as const;

export function classifyChangeScope(text: string): ChangeScopeVerdict {
  const src = (text ?? "").trim();
  if (!src) return { scope: "normal", matched: [] };
  const matched: string[] = [];
  for (const v of SURFACE_VERBS_ZH) {
    if (src.includes(v)) matched.push(v);
  }
  const lower = src.toLowerCase();
  for (const v of SURFACE_VERBS_EN) {
    const re = new RegExp(`(^|[^a-z0-9])${v.replace(/ /g, "\\s+")}($|[^a-z0-9])`, "i");
    if (re.test(lower)) matched.push(v);
  }
  if (matched.length > 0 && EXPLICIT_SMALL_MARKERS.some((m) => src.includes(m))) {
    // 显式小改标记优先:matched 照实回报(便于审计「为什么没升级成全链路」),判 normal。
    return { scope: "normal", matched };
  }
  return { scope: matched.length > 0 ? "surface" : "normal", matched };
}
