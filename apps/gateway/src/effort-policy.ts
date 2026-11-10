/**
 * 思考力度分档( O2):主实施轨与评审/子代理轨的 effort 各自解析。
 * 背景(轨迹经验证):LLM 36.7 分钟/106 次调用,5 次 >60s,全程 reasoningEffort=xhigh——
 * 纯实施(改文件/跑命令)吃 xhigh 是纯成本;真正要多想的是规划与评审。
 * 故:主实施轨缺省 high(可经 coding.llm.implementationEffort 覆盖),
 *     评审/子代理轨缺省 xhigh(可经 coding.models.<role>.reasoningEffort 覆盖)。
 * 显式性口径:这两个字段在 schema 里都**没有 default**(与旧 coding.llm.reasoningEffort 的
 * default "high" 不同)——所以「字段在场 = 用户显式选择」,不需要 sources 层标记;
 * ""=显式关(请求不带 reasoning_effort)。
 * 用户拍板:主实施轨以 implementationEffort 为唯一权威(旧 reasoningEffort 对主轨不再生效)。
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh";

/** 合法档位取值域(会话级 effort 覆盖的校验白名单;顺序=由弱到强,供面板下拉与文案复用)。 */
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"] as const;

/** 主实施轨缺省档(实施=改文件/跑命令,不需要 xhigh 的思考预算)。 */
export const IMPLEMENTATION_DEFAULT_EFFORT: EffortLevel = "high";
/** 规划/评审/子代理轨缺省档(要多想)。 */
export const REASONING_DEFAULT_EFFORT: EffortLevel = "xhigh";

/** 空串=显式关 → undefined(请求不带该参数);其余原样。 */
function normalize(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return v === "" ? undefined : v;
}

/** 主实施轨 effort:显式 implementationEffort 优先,未配置=缺省 high;""=关。 */
export function resolveImplementationEffort(value: string | undefined): string | undefined {
  if (value === undefined) return IMPLEMENTATION_DEFAULT_EFFORT;
  return normalize(value);
}

/** 角色轨 effort:显式 coding.models.<role>.reasoningEffort 优先,未配置=缺省 xhigh;""=关。 */
export function resolveRoleEffort(roleValue: string | undefined): string | undefined {
  if (roleValue === undefined) return REASONING_DEFAULT_EFFORT;
  return normalize(roleValue);
}