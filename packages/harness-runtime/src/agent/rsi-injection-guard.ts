/**
 * #198 RSI 产出注入安全边界(纯逻辑面)。
 *
 * 问题:RSI 产物(tips / 工具描述 / 文档摘录 / prompt 片段)是「机器自己写的文本」,
 * 一旦回流进下一轮上下文,就等于让模型给自己的指令集加料——越权、注入、伪造权威身份
 * 都是同一个缺口。本模块只做一件事:给任何「注入到上下文的一段文本」定死可复核的准入
 * 判定,输出 12 个稳定码 + 一份**已经过转义/模板渲染**的待审阅文本。
 *
 * 四条硬边界:
 *   ① 来源必须标身份:RSI 产物必须显式 `authoritative:false`,否则视为冒充系统权威。
 *     固定前缀 `[RSI 生成·非系统权威]` 只由本模块加;入参自带即越权(自证权威)。
 *   ② 模板白名单:prompt / tip 通道必须带白名单内的 templateId——自由文本不能直接进
 *      这些高信任通道,只有「已知壳 + 受控槽位」可以。
 *   ③ 转义:控制标签(system/instructions/assistant/user…)、`<|…|>`、未配对的三反引号
 *      围栏一律转义后再输出;嵌套闭合全部转义(否则只转开标签等于没转)。
 *   ④ 高风险需人类批准:命令 / 绝对路径 / URL / 密钥形态一旦命中,没有 human approver
 *      就不放行(agent 自批准不算,缺席更不算)。
 *
 * 纪律:零 IO、零依赖、绝不 throw(非法输入折叠成码);多条件命中**全部收集不短路**,
 * 因为审阅者需要一次看到所有问题,而不是修一个跑一遍。ok=false 时仍尽量给出
 * sanitizedText / wrapped,便于人工复核时看到「它到底想注入什么」。
 */

/** 判定面版本(台账里与 store 的 v 对齐)。 */
export const RSI_INJECTION_VERSION = 1;

/** RSI 来源的固定身份前缀;入参自带视为越权(见文件头 ①)。 */
export const RSI_INJECTION_LABEL = "[RSI 生成·非系统权威]";

/** 12 个稳定码(声明顺序即审阅者阅读顺序;运行期产出顺序见规则 1-7)。 */
export const INJ_CODES = [
  "INJ_SOURCE_MISSING",
  "INJ_SOURCE_KIND_INVALID",
  "INJ_NOT_LABELED",
  "INJ_TEMPLATE_REQUIRED",
  "INJ_TEMPLATE_UNKNOWN",
  "INJ_TRACE_ORIGIN_FORBIDDEN",
  "INJ_TAG_UNESCAPED",
  "INJ_HIGH_RISK_NEEDS_APPROVAL",
  "INJ_APPROVAL_MISSING",
  "INJ_TOO_LONG",
  "INJ_BLACKLISTED",
  "INJ_TEXT_EMPTY",
] as const;

export type InjectionCode = (typeof INJ_CODES)[number];

/** 注入来源身份。`authoritative` 是「这段文本是否代表系统权威」的显式声明。 */
export type InjectionSourceKind = "rsi" | "human" | "system";

export interface InjectionSource {
  kind: InjectionSourceKind;
  id: string;
  authoritative: boolean;
}

/** 四个入站通道:tip 提示 / tool-description 工具描述 / doc 文档摘录 / prompt 提示词。 */
export type InjectionChannel = "tip" | "tool-description" | "doc" | "prompt";

/** 产物来源形态:template=套模板生成,trace=从执行轨迹里摘的原始片段。 */
export type InjectionOrigin = "template" | "trace";

/** 高风险面四类。 */
export type InjectionRiskKind = "command" | "path" | "url" | "secret";

export interface InjectionRiskFlag {
  kind: InjectionRiskKind;
  /** 命中的字面片段(已去重,原样返回,便于审阅定位)。 */
  match: string;
}

export interface InjectionPayload {
  source: InjectionSource;
  channel: InjectionChannel;
  origin: InjectionOrigin;
  text: string;
  templateId?: string;
  /** 证据引用(trace 产物应给出);缺失不拒,但输出里明示「(无证据引用)」。 */
  evidenceRefs?: string[];
  /** 调用方自述的风险标记:仅记述,不参与判定,也不回显到 riskFlags。 */
  riskFlags?: InjectionRiskKind[];
}

export interface InjectionPolicy {
  /** 允许的模板 id;不在表内的 templateId 一律 INJ_TEMPLATE_UNKNOWN。 */
  templateWhitelist: string[];
  /** 注入文本(转义后)的字符上限。 */
  maxChars: number;
  /** 高风险是否必须人类批准。 */
  requireHumanForHighRisk: boolean;
  /** 允许 trace 来源的通道;空数组=任何 trace 都不许注入。 */
  allowTraceOriginChannels: InjectionChannel[];
}

/** 缺省策略:白名单只放四个已知壳,trace 一律禁入。 */
export const DEFAULT_INJECTION_POLICY: InjectionPolicy = {
  templateWhitelist: ["tip.dispatch", "tip.readlist", "tool.describe", "doc.evidence-quote"],
  maxChars: 4000,
  requireHumanForHighRisk: true,
  allowTraceOriginChannels: [],
};

export interface InjectionApprover {
  kind: "human" | "agent";
  id: string;
}

export interface InjectionEvalOptions {
  approver?: InjectionApprover;
  /** 黑名单命中(由 store 侧查询后传入;纯逻辑面不查库)。 */
  blacklisted?: boolean;
}

export interface InjectionEvaluation {
  ok: boolean;
  codes: InjectionCode[];
  /** 已渲染/转义/加身份前缀的待审阅文本;超长时为 `slice(0,maxChars) + "…"` 预览。 */
  sanitizedText?: string;
  /** 证据块包装(供审阅/审计;doc 通道同一形态)。 */
  wrapped?: string;
  riskFlags: InjectionRiskFlag[];
  templateId?: string;
}

/** 内置模板壳:已知模板的渲染前缀。renderTemplate 之外一律不改写文本。 */
export const TEMPLATE_LABELS: Readonly<Record<string, string>> = {
  "tip.dispatch": "提示:",
  "tip.readlist": "待读清单:",
  "tool.describe": "工具说明:",
  "doc.evidence-quote": "证据引述:",
};

/** 控制标签名族(system/instructions/assistant/user… 及其闭合形态)。 */
const CONTROL_TAG_NAMES =
  "system|sys|instructions?|assistant|user|human|developer|tools?|functions?|prompts?|context|memory|im_start|im_end";

const CONTROL_TAG_RULE = new RegExp(`</?(?:${CONTROL_TAG_NAMES})(?:\\s[^<>]*)?/?>`, "gi");
/** `<|im_start|>` 这类「管道围起来的伪特殊 token」。 */
const PIPE_TAG_RULE = /<\|[^<>\n]*\|>/g;
/** 三反引号围栏。 */
const FENCE_RULE = /```/g;

/**
 * 高风险形态表。顺序只影响 riskFlags 的排列,不影响判定(命中即收集)。
 * 与 security/redact.ts 的密钥形态表「同源不同责」:那边负责出站擦除(*脱敏*),
 * 这边负责入站拦截(*拒收/要批准*),因此不复用其规则对象,只借前缀形态。
 */
const HIGH_RISK_RULES: ReadonlyArray<{ kind: InjectionRiskKind; pattern: RegExp }> = [
  // command:子 shell / 串接 / 分号后接可执行词 / 管道进 shell
  { kind: "command", pattern: /\$\(/g },
  { kind: "command", pattern: /&&/g },
  {
    kind: "command",
    pattern: /;\s*(?:sh|bash|zsh|dash|node|python3?|perl|ruby|exec|eval|source|curl|wget|rm|sudo|nc|powershell)\b/gi,
  },
  { kind: "command", pattern: /\|\s*(?:sh|bash|zsh|dash|python3?|perl|ruby|powershell)\b/gi },
  // path:/etc、/usr、/var… 绝对系统路径,以及 C:\ 盘符路径
  {
    kind: "path",
    pattern:
      /(?:^|[\s"'`(=[])\/(?:etc|usr|var|root|bin|sbin|lib|lib64|home|opt|proc|sys|dev|boot|tmp|private|System|Users)\b[^\s"'`)\]]*/g,
  },
  { kind: "path", pattern: /[A-Za-z]:\\[^\s"'`)\]]*/g },
  // url:http(s) 外联
  { kind: "url", pattern: /\bhttps?:\/\/[^\s"'`<>)\]]+/gi },
  // secret:sk- 前缀 / Bearer 头 / ≥32 位字母数字高熵串(须同时含字母与数字)
  { kind: "secret", pattern: /\bsk-[A-Za-z0-9_-]{8,}/g },
  { kind: "secret", pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/g },
  { kind: "secret", pattern: /(?=[A-Za-z0-9]{32,})(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{32,}/g },
];

/** riskFlags 上限:一条注入文本灌满几百个命中对审阅没有增量信息。 */
const RISK_FLAG_LIMIT = 32;

const KINDS: ReadonlySet<string> = new Set<InjectionSourceKind>(["rsi", "human", "system"]);
/** 必须带白名单模板的通道。 */
const TEMPLATE_REQUIRED_CHANNELS: ReadonlySet<string> = new Set<InjectionChannel>(["prompt", "tip"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 纯函数模板渲染:已知模板 id 加固定前缀,未知/缺省原样返回(不改写文本内容)。
 */
export function renderTemplate(templateId: string | undefined, text: string): string {
  const body = String(text ?? "");
  if (!templateId) return body;
  const label = TEMPLATE_LABELS[templateId];
  return label ? label + body : body;
}

export interface EscapedControlTags {
  /** 转义后的文本(`<system>` → `&lt;system&gt;`)。 */
  text: string;
  /** 命中的原始片段(去重,保留首次出现顺序)。 */
  hits: string[];
  /** 三反引号围栏计数为奇数(开闭不配对)。 */
  fenceUnpaired: boolean;
}

/**
 * 控制标签 / `<|…|>` / 未配对围栏的转义。全部命中点都转义(嵌套闭合同样转义),
 * 而不是只转第一个开标签——半转义等于没转。
 */
export function escapeControlTags(text: string): EscapedControlTags {
  const src = String(text ?? "");
  const hits: string[] = [];
  const push = (raw: string): void => {
    if (!hits.includes(raw)) hits.push(raw);
  };
  const wrap = (raw: string): string => raw.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  let out = src.replace(PIPE_TAG_RULE, (m) => {
    push(m);
    return wrap(m);
  });
  out = out.replace(CONTROL_TAG_RULE, (m) => {
    push(m);
    return wrap(m);
  });

  const fences = src.match(FENCE_RULE)?.length ?? 0;
  const fenceUnpaired = fences % 2 === 1;
  if (fenceUnpaired) {
    out = out.replace(FENCE_RULE, "&#96;&#96;&#96;");
  }

  return { text: out, hits, fenceUnpaired };
}

/**
 * 四类高风险探测:命中即收集(去重 + 上限),不做判定。
 * 检测跑在**原始文本**上(转义只改尖括号,不影响这些形态,但先在原文上跑更直白)。
 */
export function detectHighRisk(text: string): InjectionRiskFlag[] {
  const src = String(text ?? "");
  const flags: InjectionRiskFlag[] = [];
  const seen = new Set<string>();
  for (const rule of HIGH_RISK_RULES) {
    for (const m of src.matchAll(rule.pattern)) {
      const raw = String(m[0] ?? "").trim();
      if (!raw) continue;
      // 带前导边界的规则(绝对路径)把边界字符切掉再报。
      const literal = rule.kind === "path" ? raw.replace(/^[\s"'`(=[]/, "") : raw;
      if (!literal) continue;
      const key = `${rule.kind}:${literal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push({ kind: rule.kind, match: literal });
      if (flags.length >= RISK_FLAG_LIMIT) return flags;
    }
  }
  return flags;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface WrappedInput {
  kind: string;
  id: string;
  channel: string;
  text: string;
  evidenceRefs: string[];
}

/** 证据块包装:RSI 产物一律装进 `<rsi-evidence untrusted="true">`(doc 通道同一形态)。 */
export function wrapEvidenceBlock(input: WrappedInput): string {
  const kind = escapeAttr(input.kind || "unknown");
  const id = escapeAttr(input.id || "unknown");
  const channel = escapeAttr(input.channel || "unknown");
  const evidence = input.evidenceRefs.length
    ? `\n证据引用:${input.evidenceRefs.map((r) => escapeAttr(r)).join(",")}`
    : "\n(无证据引用)";
  return `<rsi-evidence untrusted="true" source="${kind}:${id}" channel="${channel}">${input.text}${evidence}</rsi-evidence>`;
}

function sliceChars(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.slice(0, limit).join("");
}

/**
 * 注入准入判定(纯函数,不抛)。
 *
 * 规则顺序(source → trace → 模板 → 转义 → 高风险 → 黑名单 → 长度/空),
 * 每个规则命中都 push 码并继续往下走;ok 只在零码时为 true。
 */
export function evaluateInjection(
  payload: InjectionPayload,
  policy: InjectionPolicy = DEFAULT_INJECTION_POLICY,
  opts: InjectionEvalOptions = {},
): InjectionEvaluation {
  try {
    return evaluateInner(payload, policy, opts);
  } catch {
    // 兜底:纯逻辑面不抛。走到这里说明入参形态超出所有防御性解析(理论上不可达)。
    return { ok: false, codes: ["INJ_SOURCE_MISSING"], riskFlags: [] };
  }
}

function evaluateInner(
  payload: InjectionPayload,
  policy: InjectionPolicy = DEFAULT_INJECTION_POLICY,
  opts: InjectionEvalOptions = {},
): InjectionEvaluation {
  const pol: InjectionPolicy = { ...DEFAULT_INJECTION_POLICY, ...(isRecord(policy) ? policy : {}) };
  const whitelist = Array.isArray(pol.templateWhitelist) ? pol.templateWhitelist : [];
  const maxChars = Number.isFinite(pol.maxChars) ? pol.maxChars : DEFAULT_INJECTION_POLICY.maxChars;
  const allowTrace = Array.isArray(pol.allowTraceOriginChannels) ? pol.allowTraceOriginChannels : [];

  const rec = isRecord(payload) ? payload : undefined;
  const src = rec && isRecord(rec.source) ? rec.source : undefined;
  const kind = src && typeof src.kind === "string" ? src.kind : "";
  const sourceId = src && typeof src.id === "string" ? src.id.trim() : "";
  const channel = rec && typeof rec.channel === "string" ? rec.channel : "";
  const origin = rec && typeof rec.origin === "string" ? rec.origin : "";
  const templateId =
    rec && typeof rec.templateId === "string" && rec.templateId.trim() ? rec.templateId.trim() : undefined;
  const evidenceRefs =
    rec && Array.isArray(rec.evidenceRefs) ? rec.evidenceRefs.filter((r): r is string => typeof r === "string") : [];
  const rawText = rec && typeof rec.text === "string" ? rec.text : "";

  const codes: InjectionCode[] = [];
  const add = (code: InjectionCode): void => {
    if (!codes.includes(code)) codes.push(code);
  };

  // ① 来源身份
  if (!src) add("INJ_SOURCE_MISSING");
  else if (!KINDS.has(kind)) add("INJ_SOURCE_KIND_INVALID");
  if (kind === "rsi" && src?.authoritative !== false) add("INJ_NOT_LABELED");

  // 自带固定前缀 = 自证权威,一律拒并剥掉(前缀只能由本模块加)。
  let body = rawText;
  if (body.startsWith(RSI_INJECTION_LABEL)) {
    add("INJ_NOT_LABELED");
    body = body.slice(RSI_INJECTION_LABEL.length).replace(/^\s+/, "");
  }

  // ② trace 来源的通道准入
  if (origin === "trace" && !allowTrace.includes(channel as InjectionChannel)) {
    add("INJ_TRACE_ORIGIN_FORBIDDEN");
  }

  // ③ 模板白名单
  if (TEMPLATE_REQUIRED_CHANNELS.has(channel)) {
    if (!templateId) add("INJ_TEMPLATE_REQUIRED");
    else if (!whitelist.includes(templateId)) add("INJ_TEMPLATE_UNKNOWN");
  } else if (templateId && !whitelist.includes(templateId)) {
    add("INJ_TEMPLATE_UNKNOWN");
  }

  // ④ 控制标签转义
  const escaped = escapeControlTags(body);
  if (escaped.hits.length > 0 || escaped.fenceUnpaired) add("INJ_TAG_UNESCAPED");

  // ⑤ 高风险
  const riskFlags = detectHighRisk(body);
  if (riskFlags.length > 0 && pol.requireHumanForHighRisk) {
    const approver = isRecord(opts.approver) ? opts.approver : undefined;
    const humanApproved = approver?.kind === "human";
    if (!humanApproved) {
      add("INJ_HIGH_RISK_NEEDS_APPROVAL");
      if (!approver) add("INJ_APPROVAL_MISSING");
    }
  }

  // ⑥ 黑名单
  if (opts.blacklisted === true) add("INJ_BLACKLISTED");

  // ⑦ 空 / 超长
  const escapedBody = escaped.text;
  if (!escapedBody.trim()) add("INJ_TEXT_EMPTY");
  const tooLong = Array.from(escapedBody).length > maxChars;
  if (tooLong) add("INJ_TOO_LONG");

  const bodyForOutput = tooLong ? `${sliceChars(escapedBody, maxChars)}…` : escapedBody;
  const rendered = renderTemplate(templateId, bodyForOutput);
  const sanitizedText = kind === "rsi" ? `${RSI_INJECTION_LABEL}${rendered}` : rendered;

  return {
    ok: codes.length === 0,
    codes,
    sanitizedText,
    wrapped: wrapEvidenceBlock({
      kind,
      id: sourceId,
      channel,
      text: bodyForOutput,
      evidenceRefs,
    }),
    riskFlags,
    templateId,
  };
}
