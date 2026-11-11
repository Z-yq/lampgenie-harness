/**
 * 工具结果双投影:模型投影(content/modelContent/images)与展示投影(display)物理隔离。
 * 为什么展示投影**不能**进模型:
 * - display 的 title/meta 是给人看的排版数据。进上下文既白烧 token,又会改变模型对结果的解释
 * (同一份工具输出换一个 title,模型行为就可能变),结果就不可复现了;
 * - 展示侧允许**迟到更新**(generation 单调),它来自面板/回放/后置加工。若 display 与模型内容
 * 同源,一次迟到更新就会改写历史请求 → 提示前缀缓存整段失效,而且「今天的模型看到昨天的结果」
 * 这种事故无从取证;
 * - 所以两边只能靠**事件流分支**隔离:deriveMessages 只读 content/modelContent/images 三个字段,
 * 展示侧由 projectToolDisplays 独立投影(按 toolCallId + generation 单调)。本模块就是展示侧的
 * 全部纯逻辑,零 IO、不 import 任何运行时模块,便于单测与回放复算。
 * 纪律:所有函数不可变(不改入参、不回引用);同输入同输出(确定性);非法输入不抛,丢弃并给 reason。
 */

/** 展示投影类型(text=纯文本,card=卡片,table=表格,diff=差异,json=结构化)。 */
export const TOOL_DISPLAY_KINDS = ["text", "card", "table", "diff", "json"] as const;
export type ToolDisplayKind = (typeof TOOL_DISPLAY_KINDS)[number];

/** 展示投影载荷:只给面板/回放,绝不进模型上下文。 */
export interface ToolDisplayPayload {
  kind: ToolDisplayKind;
 /** 卡片标题(≤200 字符,超长截断)。 */
  title?: string;
 /** 正文(≤8000 字符,超长截断并带标记)。 */
  body?: string;
 /** 结构化旁注(浅拷贝 + JSON 往返快照,不可序列化/过大则丢弃)。 */
  meta?: Record<string, unknown>;
 /** 载荷自身版本号(展示侧演化用;非负整数)。 */
  version?: number;
}

/** 展示侧迟到更新事件(custom{what:"toolDisplay.update"} 的 payload)。 */
export interface ToolDisplayUpdate {
  what: "toolDisplay.update";
  toolCallId: string;
  display: ToolDisplayPayload;
 /** 单调代次:只有严格更大才接受。 */
  generation: number;
 /** 事件时间(ms);同代次时用更晚的 at 决胜(仅投影扫描,单条 apply 不接受同代)。 */
  at: number;
}

/** 某 toolCallId 的展示投影结果。 */
export interface ToolDisplayProjection {
  display: ToolDisplayPayload;
  generation: number;
  updatedAt: number;
}

/** 模型投影:只含这三个字段,永不含 display/displayText。 */
export interface ModelVisibleToolResult {
  content: string;
  modelContent?: string;
  images?: string[];
}

/** 截断上限(展示侧;模型内容不受影响)。 */
export const MAX_DISPLAY_TITLE_CHARS = 200;
export const MAX_DISPLAY_BODY_CHARS = 8000;
export const MAX_DISPLAY_META_CHARS = 4000;
/** body 被截断时追加的标记(逐字固定,便于断言)。 */
export const DISPLAY_TRUNCATED_MARK = "…[截断]";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function truncateBody(text: string): string {
 // 先截再拼标记:保证输出长度上限是常量,不随输入规模浮动(确定性 + 可断言)。
  return text.length > MAX_DISPLAY_BODY_CHARS ? text.slice(0, MAX_DISPLAY_BODY_CHARS) + DISPLAY_TRUNCATED_MARK : text;
}

/**
 * 归一化展示载荷:合法对象或 undefined。
 * `reasons` 只用于取证(非法原因逐条 push);返回值仍是「合法对象/undefined」二态,调用方不必解包。
 */
export function normalizeToolDisplay(raw: unknown, reasons?: string[]): ToolDisplayPayload | undefined {
  const fail = (reason: string): undefined => {
    reasons?.push(reason);
    return undefined;
  };
  if (!isPlainObject(raw)) return fail("display-not-object");
  const kind = raw.kind;
  if (typeof kind !== "string" || !(TOOL_DISPLAY_KINDS as readonly string[]).includes(kind)) {
    return fail("display-kind-invalid");
  }
  const out: ToolDisplayPayload = { kind: kind as ToolDisplayKind };

  if (raw.title !== undefined) {
    if (typeof raw.title === "string") {
      const title = raw.title.trim().slice(0, MAX_DISPLAY_TITLE_CHARS);
      if (title) out.title = title;
      else reasons?.push("display-title-empty");
    } else reasons?.push("display-title-invalid");
  }

  if (raw.body !== undefined) {
    if (typeof raw.body === "string") {
      if (raw.body.length > 0) out.body = truncateBody(raw.body);
      else reasons?.push("display-body-empty");
    } else reasons?.push("display-body-invalid");
  }

  if (raw.meta !== undefined) {
    if (!isPlainObject(raw.meta)) reasons?.push("display-meta-invalid");
    else {
 // JSON 往返=深拷贝快照(展示侧拿到后改原对象不会污染已投影结果),顺带挡循环引用。
      try {
        const json = JSON.stringify(raw.meta);
        if (json.length > MAX_DISPLAY_META_CHARS) reasons?.push("display-meta-too-large");
        else out.meta = JSON.parse(json) as Record<string, unknown>;
      } catch {
        reasons?.push("display-meta-unserializable");
      }
    }
  }

  if (raw.version !== undefined) {
    if (isNonNegativeInt(raw.version)) out.version = raw.version;
    else reasons?.push("display-version-invalid");
  }
 // 未知字段一律不拷贝:展示 schema 必须收敛,否则面板/回放各读各的字段会再次分叉。
  return out;
}

/**
 * 从 tool.result payload 取展示投影:优先 payload.display,其次旧事件兼容的 displayText。
 * displayText 只作**展示回退来源**,永不进入模型投影(见 modelVisibleToolResult)。
 */
export function displayFromToolResult(payload: unknown, reasons?: string[]): ToolDisplayPayload | undefined {
  if (!isPlainObject(payload)) return undefined;
  const direct = normalizeToolDisplay(payload.display, reasons);
  if (direct) return direct;
  const text = payload.displayText;
  if (typeof text === "string" && text.trim().length > 0) {
    return { kind: "text", body: truncateBody(text) };
  }
  return undefined;
}

/** applyDisplayUpdate 的结果:接受则给投影,拒绝则给 reason(不抛)。 */
export interface ApplyDisplayUpdateResult {
  accepted: boolean;
  projection?: ToolDisplayProjection;
  reason?: string;
}

/**
 * 把一条更新应用到某 toolCallId 的当前投影。
 * 语义:generation 必须**严格大于**当前代次才接受——同代直接忽略,因此「只改 body 不改 generation」
 * 的补丁式更新天然被拒(否则一次重放即可悄悄改写历史展示)。
 */
export function applyDisplayUpdate(
  current: ToolDisplayProjection | undefined,
  update: ToolDisplayUpdate | unknown,
  reasons?: string[],
): ApplyDisplayUpdateResult {
  const reject = (reason: string): ApplyDisplayUpdateResult => {
    reasons?.push(reason);
    return { accepted: false, reason };
  };
  if (!isPlainObject(update)) return reject("update-not-object");
  if (update.what !== "toolDisplay.update") return reject("update-what-invalid");
  if (typeof update.toolCallId !== "string" || update.toolCallId.length === 0) return reject("update-tool-call-id-invalid");
  if (!isNonNegativeInt(update.generation)) return reject("update-generation-invalid");
  if (typeof update.at !== "number" || !Number.isFinite(update.at)) return reject("update-at-invalid");
  const display = normalizeToolDisplay(update.display, reasons);
  if (!display) return reject("update-display-invalid");
  if (current && update.generation <= current.generation) return reject("display-generation-not-newer");
  return {
    accepted: true,
    projection: { display, generation: update.generation, updatedAt: update.at },
  };
}

/** 事件时间兜底:journal 事件的真实字段是 `time`(ts/at 只在外部事件形状里出现)。 */
function eventAt(e: Record<string, unknown>): number {
  const ts = e.time ?? e.ts ?? e.at;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  const p = e.payload;
  if (isPlainObject(p)) {
    const pat = p.at;
    if (typeof pat === "number" && Number.isFinite(pat)) return pat;
  }
  return 0;
}

/** 投影合并顺序:代次大者胜;同代取更晚 at(事件流乱序时也收敛到同一结果)。 */
function isNewer(candidate: { generation: number; updatedAt: number }, current: ToolDisplayProjection | undefined): boolean {
  if (!current) return true;
  if (candidate.generation > current.generation) return true;
  return candidate.generation === current.generation && candidate.updatedAt > current.updatedAt;
}

/** projectToolDisplays 的结果:投影表 + 被判非法跳过的事件计数与原因。 */
export interface ToolDisplayProjectionScan {
  displays: Map<string, ToolDisplayProjection>;
  skipped: number;
  reasons: string[];
}

/**
 * 扫描事件流(tool.result + custom{toolDisplay.update}),按 toolCallId 产出投影。
 * - tool.result 提供基线(generation=0),display 缺失是常态,不计入 skipped;
 * - update 事件按 generation 单调、同代 at 更晚决胜(展示侧允许迟到收敛,与模型前缀稳定性无关);
 * - 非法/陈旧事件一律跳过并留 reason,不抛(回放遇到坏事件不能整段失败)。
 */
export function projectToolDisplays(events: readonly unknown[]): ToolDisplayProjectionScan {
  const displays = new Map<string, ToolDisplayProjection>();
  const reasons: string[] = [];
  let skipped = 0;
  const skip = (reason: string): void => {
    skipped += 1;
    reasons.push(reason);
  };

  for (const raw of events) {
    if (!isPlainObject(raw)) {
      skip("event-not-object");
      continue;
    }
    const payload = isPlainObject(raw.payload) ? raw.payload : undefined;
    if (!payload) {
      reasons.push("event-payload-missing");
      continue;
    }
    if (raw.kind === "tool.result") {
      const toolCallId = payload.toolCallId;
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        skip("result-tool-call-id-invalid");
        continue;
      }
      const hasDisplay = payload.display !== undefined;
      const localReasons: string[] = [];
      const display = displayFromToolResult(payload, localReasons);
      if (!display) {
 // display 完全缺失=普通工具结果(无展示投影),不计数;display 存在却非法=坏事件,计数。
        if (hasDisplay) {
          skipped += 1;
          reasons.push(...localReasons, "result-display-unusable");
        }
        continue;
      }
      reasons.push(...localReasons);
      const candidate: ToolDisplayProjection = { display, generation: 0, updatedAt: eventAt(raw) };
      const current = displays.get(toolCallId);
      if (isNewer(candidate, current)) displays.set(toolCallId, candidate);
      else reasons.push("result-out-of-order");
      continue;
    }
    if (raw.kind === "custom" && payload.what === "toolDisplay.update") {
      if (typeof payload.toolCallId !== "string" || payload.toolCallId.length === 0) {
        skip("update-tool-call-id-invalid");
        continue;
      }
      const localReasons: string[] = [];
      const display = normalizeToolDisplay(payload.display, localReasons);
      if (!display) {
        skipped += 1;
        reasons.push(...localReasons, "update-display-invalid");
        continue;
      }
      if (!isNonNegativeInt(payload.generation)) {
        skip("update-generation-invalid");
        continue;
      }
      if (typeof payload.at !== "number" || !Number.isFinite(payload.at)) {
        skip("update-at-invalid");
        continue;
      }
      reasons.push(...localReasons);
      const candidate: ToolDisplayProjection = { display, generation: payload.generation, updatedAt: payload.at };
      const current = displays.get(payload.toolCallId);
      if (isNewer(candidate, current)) displays.set(payload.toolCallId, candidate);
      else reasons.push("display-generation-not-newer");
      continue;
    }
 // 其它 kind 与其它 custom.what 不参与投影(不是展示事件,静默忽略)。
  }
  return { displays, skipped, reasons };
}

/**
 * 模型投影:只导出 content/modelContent/images。
 * 这是隔离的**唯一出口**——display/displayText 在这里被物理丢弃,调用方拿不到也就带不进上下文。
 */
export function modelVisibleToolResult(payload: unknown): ModelVisibleToolResult {
  if (!isPlainObject(payload)) return { content: "" };
  const content = typeof payload.content === "string" ? payload.content : payload.content === undefined || payload.content === null ? "" : String(payload.content);
  const out: ModelVisibleToolResult = { content };
  if (typeof payload.modelContent === "string") out.modelContent = payload.modelContent;
  if (Array.isArray(payload.images)) {
    const images = payload.images.filter((u): u is string => typeof u === "string" && u.length > 0);
    if (images.length > 0) out.images = images;
  }
  return out;
}
