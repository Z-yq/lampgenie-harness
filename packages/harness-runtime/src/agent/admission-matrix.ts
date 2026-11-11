/**
 * 准入矩阵(纯逻辑,零 IO / 零依赖 / 不 throw / 不可变 / 确定性)。
 * 为什么要把「能不能投递」收成一张矩阵:
 * 旧 gate 是一串 if 串联——每个条件自己决定放行,读者只能顺着执行顺序推断某个组合的结果,
 * 也无法回答「这条为什么被拒」。矩阵把判定面摊平为
 * listed/unlisted × addressed/unaddressed × mode(observe/auto/allow)
 * 每格显式给出 admit / strength / reason / ruleId,未知组合一律 fail-closed(not admit, reason=invalid)。
 * 为什么 unlisted 不能被「点名」绕过:
 * 白名单(listed)表达的是「这个人/这个来源是否有资格让 harness 干活」,点名(addressed)表达的只是
 * 「这条消息在找我」。若把 addressed 当成白名单的替代品,任何人只要在消息里 @ 到路由对象就获得了
 * 与白名单同等的投递资格——准入判定就退化成「谁喊得响谁进来」。所以 unlisted 分支下 addressed
 * 只影响 reason 的成因归属,admit 恒为 false;真正的旁路只有显式授权凭证(explicitGrant:
 * 面板提交 / 幂等键),它优先于 listed 判定,但仍不能豁免非法 mode(fail-closed 优先于一切授权)。
 * 为什么所有规则都要评估(不短路):
 * 命中即返只会留下「第一条命中的规则」,审计时看不出「本来还有哪些规则会命中」——
 * 比如 explicitGrant 与非法 mode 同时成立时,只返第一条就丢失了「模型非法」这个事实。
 * 因此本模块逐条评估全部规则,把 matched 与各规则自身的 decision 全量留在 traces 里,
 * 最终 decision 由一个显式聚合选出(fail-closed 校验 > 显式授权 > 网格顺序)。
 */

/** 接受模式:observe=只观察 / auto=推断放行 / allow=配置允许。 */
export const ADMISSION_MODES = ["observe", "auto", "allow"] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

/** 判定强度:explicit=显式授权/inferred=推断放行/none=不派发。 */
export const ADMISSION_STRENGTHS = ["explicit", "inferred", "none"] as const;
export type AdmissionStrength = (typeof ADMISSION_STRENGTHS)[number];

/** 矩阵版本:字段语义或格位结论变化时递增(落审计后可用于回溯判定口径)。 */
export const ADMISSION_MATRIX_VERSION = "m187/v1" as const;

/** 判定输入。source 只作审计溯源,不参与格位选择(格位只由 listed/addressed/mode 决定)。 */
export interface AdmissionInput {
 /** 是否命中白名单(allowlist / 已授权来源身份)。 */
  listed: boolean;
 /** 是否被显式点名(dm/mention 命中 task 路由)。 */
  addressed: boolean;
  mode: AdmissionMode;
 /** 显式授权凭证:面板提交 / 幂等键。优先于 listed 判定。 */
  explicitGrant: boolean;
 /** 触发来源(panel/im/其它自定义来源名)。 */
  source: string;
}

/** 单条规则的判定结论。 */
export interface AdmissionDecision {
  admit: boolean;
  strength: AdmissionStrength;
  reason: string;
  ruleId: string;
 /** 仅观察模式格位会有:不派发但「本可接受」的审计标记。 */
  wouldAccept?: boolean;
}

/** 逐规则评估痕迹:matched=false 的规则也要留痕(审计「为什么没走到这一格」)。 */
export interface AdmissionTrace {
  ruleId: string;
  matched: boolean;
  decision?: AdmissionDecision;
}

/** 一次评估的完整结果:最终决定 + 全量痕迹 + 口径版本。 */
export interface AdmissionEvaluation {
  decision: AdmissionDecision;
  traces: readonly AdmissionTrace[];
  matrixVersion: string;
}

/** 规则顺序(fail-closed 校验最前,显式授权次之,网格规则按 listed→unlisted 排列)。 */
export const ADMISSION_RULE_IDS = [
  "invalid-input",
  "explicit-grant",
  "listed-addressed",
  "listed-unaddressed-allow",
  "listed-unaddressed-auto",
  "listed-unaddressed-observe",
  "unlisted-addressed",
  "unlisted-unaddressed",
] as const;
export type AdmissionRuleId = (typeof ADMISSION_RULE_IDS)[number];

/** 矩阵格位("*"=该维度不参与本格判定)。 */
export interface AdmissionMatrixCell {
  ruleId: AdmissionRuleId;
  listed: boolean | "*";
  addressed: boolean | "*";
  mode: AdmissionMode | "*";
  admit: boolean;
  strength: AdmissionStrength;
  reason: string;
  wouldAccept?: boolean;
  note: string;
}

/**
 * 集中矩阵常量(7 格 = 网格 6 格 + 显式授权 1 格),note 即口径说明。
 * 修改任何一格都必须同步 ADMISSION_MATRIX_VERSION 与文件顶部说明。
 */
export const ADMISSION_MATRIX: readonly AdmissionMatrixCell[] = Object.freeze(
  (
    [
      {
        ruleId: "explicit-grant",
        listed: "*",
        addressed: "*",
        mode: "*",
        admit: true,
        strength: "explicit",
        reason: "explicit_grant",
        note: "面板提交/幂等键=用户主动授权:优先于 listed 判定,但不豁免非法 mode。",
      },
      {
        ruleId: "listed-addressed",
        listed: true,
        addressed: true,
        mode: "*",
        admit: true,
        strength: "explicit",
        reason: "addressed",
        note: "白名单内 + 被点名:人显式指名,强度 explicit;mode 不参与判定。",
      },
      {
        ruleId: "listed-unaddressed-allow",
        listed: true,
        addressed: false,
        mode: "allow",
        admit: true,
        strength: "explicit",
        reason: "mode_allow",
        note: "配置允许(allow):白名单内未点名也放行,强度按配置授权记 explicit。",
      },
      {
        ruleId: "listed-unaddressed-auto",
        listed: true,
        addressed: false,
        mode: "auto",
        admit: true,
        strength: "inferred",
        reason: "mode_auto",
        note: "自动模式(auto):推断强度放行,审计可据此与显式授权区分。",
      },
      {
        ruleId: "listed-unaddressed-observe",
        listed: true,
        addressed: false,
        mode: "observe",
        admit: false,
        strength: "none",
        reason: "observed",
        wouldAccept: true,
        note: "观察模式(observe):只记 would_accept 供审计,不派发。",
      },
      {
        ruleId: "unlisted-addressed",
        listed: false,
        addressed: true,
        mode: "*",
        admit: false,
        strength: "none",
        reason: "unlisted",
        note: "点名不能绕过白名单:准入资格只由白名单/显式授权给,不由「喊我」给。",
      },
      {
        ruleId: "unlisted-unaddressed",
        listed: false,
        addressed: false,
        mode: "*",
        admit: false,
        strength: "none",
        reason: "unlisted",
        note: "未进白名单且未点名:恒不派发(同 unlisted-addressed,成因不同结论相同)。",
      },
    ] as AdmissionMatrixCell[]
  ).map((cell) => Object.freeze(cell)),
);

/** mode 运行时校验:不在枚举内(含缺字段 / 非字符串)=> false。 */
export function isAdmissionMode(value: unknown): value is AdmissionMode {
  return typeof value === "string" && (ADMISSION_MODES as readonly string[]).includes(value);
}

interface RuleSpec {
  ruleId: AdmissionRuleId;
  match: (input: AdmissionInput) => boolean;
  decide: () => AdmissionDecision;
}

function makeDecision(
  admit: boolean,
  strength: AdmissionStrength,
  reason: string,
  ruleId: string,
  wouldAccept?: boolean): AdmissionDecision {
  const decision: AdmissionDecision = { admit, strength, reason, ruleId };
  if (wouldAccept !== undefined) decision.wouldAccept = wouldAccept;
  return Object.freeze(decision);
}

/**
 * 非法输入定位:返回首个不合法字段名(invalid-input 规则据此命中),合法返回 undefined。
 * 入参按 unknown 宽化——调用方可能来自 JSON/配置,不能假设类型已校验。
 */
function invalidFieldOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return "input";
  const raw = input as Record<string, unknown>;
  if (!isAdmissionMode(raw["mode"])) return "mode";
  if (typeof raw["listed"] !== "boolean") return "listed";
  if (typeof raw["addressed"] !== "boolean") return "addressed";
  if (typeof raw["explicitGrant"] !== "boolean") return "explicitGrant";
  if (typeof raw["source"] !== "string" || raw["source"].length === 0) return "source";
  return undefined;
}

/** 规则表(顺序即 trace 顺序;每条规则只回答「我这一格命中吗」,聚合由 pickDecision 负责)。 */
const RULES: readonly RuleSpec[] = Object.freeze([
  {
    ruleId: "invalid-input",
    match: (input) => invalidFieldOf(input) !== undefined,
    decide: () => makeDecision(false, "none", "invalid", "invalid-input"),
  },
  {
    ruleId: "explicit-grant",
    match: (input) => input.explicitGrant === true,
    decide: () => makeDecision(true, "explicit", "explicit_grant", "explicit-grant"),
  },
  {
    ruleId: "listed-addressed",
    match: (input) => input.listed === true && input.addressed === true,
    decide: () => makeDecision(true, "explicit", "addressed", "listed-addressed"),
  },
  {
    ruleId: "listed-unaddressed-allow",
    match: (input) => input.listed === true && input.addressed === false && input.mode === "allow",
    decide: () => makeDecision(true, "explicit", "mode_allow", "listed-unaddressed-allow"),
  },
  {
    ruleId: "listed-unaddressed-auto",
    match: (input) => input.listed === true && input.addressed === false && input.mode === "auto",
    decide: () => makeDecision(true, "inferred", "mode_auto", "listed-unaddressed-auto"),
  },
  {
    ruleId: "listed-unaddressed-observe",
    match: (input) => input.listed === true && input.addressed === false && input.mode === "observe",
    decide: () => makeDecision(false, "none", "observed", "listed-unaddressed-observe", true),
  },
  {
    ruleId: "unlisted-addressed",
    match: (input) => input.listed === false && input.addressed === true,
    decide: () => makeDecision(false, "none", "unlisted", "unlisted-addressed"),
  },
  {
    ruleId: "unlisted-unaddressed",
    match: (input) => input.listed === false && input.addressed === false,
    decide: () => makeDecision(false, "none", "unlisted", "unlisted-unaddressed"),
  },
] as RuleSpec[]);

/**
 * 聚合:fail-closed 校验 > 显式授权 > 网格顺序。
 * 规则表按此优先级排列,故「首个命中的规则」即最终结论;网格规则彼此互斥(同一输入最多命中一格),
 * 唯一可能同时命中的组合是 invalid-input + explicit-grant,此时 invalid 排在前面赢得判定。
 */
function pickDecision(traces: readonly AdmissionTrace[]): AdmissionDecision {
  for (const trace of traces) {
    if (trace.matched && trace.decision) return trace.decision;
  }
 // 理论上不可达(合法输入必落一格):仍按 fail-closed 返回,绝不默认放行。
  return makeDecision(false, "none", "invalid", "invalid-input");
}

/**
 * 逐条评估全部规则(不短路),返回最终决定 + 全量 traces + 口径版本。
 * 纯函数:不读系统时间/环境/文件,不写 input;返回值(含嵌套对象与数组)全部冻结。
 */
export function evaluateAdmission(input: AdmissionInput): AdmissionEvaluation {
  const safe: AdmissionInput = (typeof input === "object" && input !== null ? input : {}) as AdmissionInput;
  const traces: AdmissionTrace[] = [];
  for (const rule of RULES) {
    let matched = false;
    try {
      matched = rule.match(safe) === true;
    } catch {
 // 规则读字段时不 throw 是约定;为满足「本模块不 throw」,异常一律折叠为未命中。
      matched = false;
    }
    traces.push(
      Object.freeze(
        matched
          ? { ruleId: rule.ruleId, matched: true, decision: rule.decide() }
          : { ruleId: rule.ruleId, matched: false },
      ),
    );
  }
  return Object.freeze({
    decision: pickDecision(traces),
    traces: Object.freeze(traces),
    matrixVersion: ADMISSION_MATRIX_VERSION,
  });
}

/** 人读摘要:每条规则的命中/结论一行串,便于落审计与肉眼排障(确定性,不含时间戳)。 */
export function summarizeAdmission(traces: readonly AdmissionTrace[]): string {
  const list = Array.isArray(traces) ? traces : [];
  const matchedCount = list.filter((t) => t.matched).length;
  const body = list
    .map((t) => {
      if (!t.matched) return `${t.ruleId}:-`;
      if (!t.decision) return `${t.ruleId}:matched`;
      return `${t.ruleId}:${t.decision.admit ? "admit" : "deny"}/${t.decision.reason}`;
    })
    .join(" ");
  return `matrix v=${ADMISSION_MATRIX_VERSION} rules=${list.length} matched=${matchedCount} | ${body}`;
}
