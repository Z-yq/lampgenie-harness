/**
 * 剖面判定(定序,designs/16 §3)+ 五剖面编排。
 * 一期实装:debug(全量)/explore(grep 版);plan/ui 显式降级(二期 step-018/019)。
 */

export type Mode = "auto" | "debug" | "plan" | "explore" | "ui" | "api" | "state" | "algo";

const UI_WORDS = ["页面", "跳转", "路由", "按钮", "前端", "page", "route", "navigate"];
const PLAN_WORDS = ["规划", "设计", "怎么加", "影响", "新功能", "架构", "plan", "design"];
/** 业务感知强意图词(step-077,designs/24 §5.1):与 ui 词同级优先(规则 1.5)。
 * ASCII 词按词边界匹配(防 "api.ts" 这类路径被子串误吞);CJK 词按 includes。 */
const API_WORDS = ["接口清单", "有哪些接口", "接口列表", "http接口", "http 接口", "rest接口", "rest 接口", "路由表", "openapi", "swagger"];
const API_WORDS_ASCII = ["endpoint", "endpoints", "rest api"];
const STATE_WORDS = ["状态机", "状态流转", "状态转移", "生命周期"];
const STATE_WORDS_ASCII = ["state machine", "statemachine", "lifecycle", "xstate"];
const ALGO_WORDS = ["算法画像", "算法模块", "训练流程", "推理流程", "神经网络", "深度学习", "模型训练", "模型推理"];
const ALGO_WORDS_ASCII = ["neural", "nn.module", "dataloader"];

export type ProfilePicked = "debug" | "plan" | "explore" | "ui" | "api" | "state" | "algo";

export interface AutoDecision {
  picked: ProfilePicked;
  reason: string;
  /** 混合语句中提取出的符号 token(仅 debug):debug 剖面用它代替整句定位。 */
  symbol?: string;
}

/** 符号形态:驼峰/帕斯卡/下划线/文件路径/文件:行号。 */
function looksLikeSymbol(query: string): boolean {
  if (/^[\w./-]+\.\w+:\d+$/.test(query)) return true;             // file.ts:123
  if (/^[\w./-]+\.(ts|tsx|js|py|go)$/.test(query)) return true;   // file path
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(query) && !query.includes(" ");
}

/** 混合语句里的符号 token 提取:「tabStore 没初始化」→ tabStore(v8 §3 定序:符号>规划词,
 * 但整句不满足符号形态时此前直接掉 explore 且整句 grep 零命中)。
 * 判定标准(确定性,不猜):长度≥4 且含内部大写转换(camel/Pascal)或下划线——
 * 纯小写英文单词(the/user/没有)不算符号。 */
const STOP_TOKENS = new Set(["the", "this", "that", "with", "from", "into", "user", "page", "code", "test", "true", "false", "null", "undefined", "string", "number", "boolean"]);
export function extractSymbolToken(query: string): string | undefined {
  const tokens = query.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? [];
  const scored = tokens
    .filter((t) => t.length >= 4 && !STOP_TOKENS.has(t.toLowerCase()))
    .filter((t) => /[a-z][A-Z]/.test(t) || /_[a-zA-Z]/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t) || t.includes("."));
  return scored.sort((a, b) => b.length - a.length)[0];
}

/** ASCII 词边界匹配(防子串误吞路径/符号);CJK 词直接 includes。 */
function hasWord(q: string, cjk: string[], ascii: string[]): boolean {
  if (cjk.some((w) => q.includes(w))) return true;
  const lower = q.toLowerCase();
  return ascii.some((w) => new RegExp(`\\b${w.replace(/[.]/g, "\\.")}\\b`, "i").test(lower));
}

/** auto 判定:有序规则,首个命中即停(designs/16 §3 + designs/24 §5.1 业务感知词)。 */
export function decideMode(query: string, knownSymbols?: Set<string>): AutoDecision {
  const q = query.trim();
  // 2. ui 词优先(强意图:页面语境覆盖符号语境)
  if (UI_WORDS.some((w) => q.includes(w))) {
    return { picked: "ui", reason: `命中页面类词(规则2,优先于符号)` };
  }
  // 2.5 业务感知词(与 ui 同级强意图;顺序 api > state > algo)
  if (hasWord(q, API_WORDS, API_WORDS_ASCII)) {
    return { picked: "api", reason: `命中接口类词(规则2.5,优先于符号)` };
  }
  if (hasWord(q, STATE_WORDS, STATE_WORDS_ASCII)) {
    return { picked: "state", reason: `命中状态机类词(规则2.5,优先于符号)` };
  }
  if (hasWord(q, ALGO_WORDS, ALGO_WORDS_ASCII)) {
    return { picked: "algo", reason: `命中算法类词(规则2.5,优先于符号)` };
  }
  // 3. 已知符号/文件路径形态;混合语句中含明确符号 token 时提取该 token 走 debug
  const isKnown = knownSymbols?.has(q);
  if (isKnown || looksLikeSymbol(q)) {
    return { picked: "debug", reason: isKnown ? `命中已知符号(规则3)` : `符号/路径形态(规则3)` };
  }
  const sym = extractSymbolToken(q);
  if (sym) {
    return { picked: "debug", reason: `混合语句提取符号 token「${sym}」(规则3)`, symbol: sym };
  }
  // 4. 规划类词或长意图句
  if (PLAN_WORDS.some((w) => q.includes(w)) || (q.length > 12 && !q.includes(" "))) {
    return { picked: "plan", reason: `规划类词/意图句(规则4)` };
  }
  // 5. 其余
  return { picked: "explore", reason: `默认自由探索(规则5)` };
}
