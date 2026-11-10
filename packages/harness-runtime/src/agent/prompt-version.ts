/**
 * RSI #209 提示词版本与覆盖治理(纯逻辑零 IO)。
 *
 * 要解决的问题:提示词改了没法回滚、答不出「这个会话读的是哪版」、团队与 RSI 互相覆盖、
 * 内置默认升级后自定义覆盖静默失效、同一 turn 内不同 step 读到不同版本。
 *
 * 口径:
 * - 提示词配置是**不可变版本序列**:每个 key 一条 PromptHistory,revisions 单调追加,
 *   每条带 revision/predecessor/timestamp/origin;current 指向「此刻生效的版本」。
 * - 保存必须**声明 base revision**:base !== current 即冲突,book 原样返回 + draft 文本(草稿不丢)。
 * - 与会话钉扎分离:pinSession 快照 current;之后保存新版本不改变已钉扎会话解析结果。
 * - 内置升级**不混入序列**:只改 builtin 字段(与 revision 1 的内置快照),
 *   status 切 default-updated,并给出 diff 与「保留我的 / 用新默认」两态。
 * - 与默认完全相同的覆盖没有意义:保存时自动写回 current=1 并标 PRUNED;
 *   pruneRedundant 用于治理历史残留。
 * - 参数非法/键不存在一律折叠成稳定码返回,不 throw;返回的 book 一律是新对象(入参不被修改)。
 *
 * 保留名口径:`admin.*` 与 `__` 前缀在内置声明处即拒绝;`system.*` 是内置命名空间
 * (createBook 的输入就是系统默认文本),允许声明;任何试图往 book 里**新增**保留名 key 的
 * 保存路径一律 RESERVED_NAME。这样内置提示 `system.coding` 可正常建版与覆盖。
 *
 * 依赖纪律:零 import、零 IO、不引 agent loop / gateway。
 */

export const PROMPT_VERSION_SCHEMA = 1;

/** 稳定码(顺序即输出顺序;只增不改)。 */
export const PROMPT_INVALID = "PROMPT_INVALID";
export const PROMPT_UNKNOWN_KEY = "PROMPT_UNKNOWN_KEY";
export const PROMPT_RESERVED_NAME = "PROMPT_RESERVED_NAME";
export const PROMPT_PLACEHOLDER_MISSING = "PROMPT_PLACEHOLDER_MISSING";
export const PROMPT_PLACEHOLDER_UNKNOWN = "PROMPT_PLACEHOLDER_UNKNOWN";
export const PROMPT_CONFLICT = "PROMPT_CONFLICT";
export const PROMPT_NEEDS_APPROVAL = "PROMPT_NEEDS_APPROVAL";
export const PROMPT_SAVED = "PROMPT_SAVED";
export const PROMPT_NOOP_SAME_AS_DEFAULT = "PROMPT_NOOP_SAME_AS_DEFAULT";
export const PROMPT_DEFAULT_UPDATED = "PROMPT_DEFAULT_UPDATED";
export const PROMPT_PINNED = "PROMPT_PINNED";
export const PROMPT_RESOLVED = "PROMPT_RESOLVED";
export const PROMPT_REVISION_NOT_FOUND = "PROMPT_REVISION_NOT_FOUND";
export const PROMPT_PRUNED = "PROMPT_PRUNED";

export const PROMPT_CODES = [
  PROMPT_INVALID,
  PROMPT_UNKNOWN_KEY,
  PROMPT_RESERVED_NAME,
  PROMPT_PLACEHOLDER_MISSING,
  PROMPT_PLACEHOLDER_UNKNOWN,
  PROMPT_CONFLICT,
  PROMPT_NEEDS_APPROVAL,
  PROMPT_SAVED,
  PROMPT_NOOP_SAME_AS_DEFAULT,
  PROMPT_DEFAULT_UPDATED,
  PROMPT_PINNED,
  PROMPT_RESOLVED,
  PROMPT_REVISION_NOT_FOUND,
  PROMPT_PRUNED,
] as const;

export type PromptCode = (typeof PROMPT_CODES)[number];

/** 版本来源:内置默认 / 用户 / 项目 / env / RSI(自我改进循环,#196 门后落序列)。 */
export const PROMPT_ORIGINS = ["builtin", "user", "project", "env", "rsi"] as const;
export type PromptOrigin = (typeof PROMPT_ORIGINS)[number];

export interface PromptRevision {
  revision: number;
  text: string;
  predecessor: number | null;
  timestamp: number;
  origin: PromptOrigin;
  /** 保存时声明的 base revision(此版本基于哪一版改写)。 */
  baseRevision?: number;
  author?: string;
  note?: string;
}

export interface PromptHistory {
  key: string;
  /** 当前内置默认文本(revision 1 的内置快照与本字段同源)。 */
  builtin: string;
  revisions: PromptRevision[];
  /** 生效版本号。 */
  current: number;
  status: "active" | "default-updated";
}

export interface PromptBook {
  keys: Record<string, PromptHistory>;
}

/** 会话钉扎:某会话对每个 key 所用的 revision 快照(会话内不随保存变化)。 */
export interface SessionPromptPins {
  sessionId: string;
  createdAt: number;
  revisions: Record<string, number>;
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

function orderCodes(codes: readonly string[]): string[] {
  const seen: string[] = [];
  for (const code of codes) if (!seen.includes(code)) seen.push(code);
  const known = (PROMPT_CODES as readonly string[]).filter((code) => seen.includes(code));
  const extra = seen.filter((code) => !(PROMPT_CODES as readonly string[]).includes(code));
  return [...known, ...extra];
}

const RESERVED_PREFIX_RE = /^(system|admin)\./i;

/** 保留名:`system.*` / `admin.*` 命名空间与 `__` 前缀。 */
export function isReservedKey(key: unknown): boolean {
  const name = typeof key === "string" ? key.trim() : "";
  if (name === "") return false;
  return RESERVED_PREFIX_RE.test(name) || name.startsWith("__");
}

/** createBook 处拒绝的保留前缀:内置命名空间 system.* 允许声明,admin.* 与 __ 不允许。 */
function reservedAtDeclaration(key: string): boolean {
  return /^admin\./i.test(key) || key.startsWith("__");
}

function toFinite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cloneRevision(raw: unknown): PromptRevision | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Partial<PromptRevision>;
  if (typeof source.revision !== "number" || !Number.isFinite(source.revision)) return undefined;
  if (typeof source.text !== "string") return undefined;
  const origin = (PROMPT_ORIGINS as readonly string[]).includes(String(source.origin))
    ? (source.origin as PromptOrigin)
    : "builtin";
  const revision: PromptRevision = {
    revision: source.revision,
    text: source.text,
    predecessor: source.predecessor === null || typeof source.predecessor === "number" ? (source.predecessor as number | null) : null,
    timestamp: toFinite(source.timestamp, 0),
    origin,
  };
  if (typeof source.baseRevision === "number" && Number.isFinite(source.baseRevision)) revision.baseRevision = source.baseRevision;
  if (typeof source.author === "string" && source.author !== "") revision.author = source.author;
  if (typeof source.note === "string" && source.note !== "") revision.note = source.note;
  return revision;
}

function cloneHistory(raw: unknown, fallbackKey: string): PromptHistory | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Partial<PromptHistory>;
  const revisions: PromptRevision[] = [];
  if (Array.isArray(source.revisions)) {
    for (const item of source.revisions) {
      const rev = cloneRevision(item);
      if (rev !== undefined) revisions.push(rev);
    }
  }
  if (revisions.length === 0) return undefined;
  revisions.sort((a, b) => a.revision - b.revision);
  const builtin = typeof source.builtin === "string" ? source.builtin : (revisions[0]?.text ?? "");
  const current =
    typeof source.current === "number" && revisions.some((rev) => rev.revision === source.current)
      ? source.current
      : (revisions[revisions.length - 1]?.revision ?? 1);
  return {
    key: typeof source.key === "string" && source.key !== "" ? source.key : fallbackKey,
    builtin,
    revisions,
    current,
    status: source.status === "default-updated" ? "default-updated" : "active",
  };
}

/**
 * 把任意输入收敛成合法 book(畸形 key 跳过,不 throw)。入参不被修改。
 * store 读磁盘坏文件也走它。
 */
export function normalizePromptBook(input: unknown): PromptBook {
  const keys: Record<string, PromptHistory> = {};
  if (!input || typeof input !== "object") return { keys };
  const source = (input as Partial<PromptBook>).keys;
  if (!source || typeof source !== "object") return { keys };
  for (const [key, value] of Object.entries(source)) {
    const name = key.trim();
    if (name === "") continue;
    const history = cloneHistory(value, name);
    if (history !== undefined) keys[name] = history;
  }
  return { keys };
}

function emptyBook(): PromptBook {
  return { keys: {} };
}

function findHistory(book: PromptBook, key: unknown): { key: string; history?: PromptHistory; code?: string } {
  const name = typeof key === "string" ? key.trim() : "";
  if (name === "") return { key: name, code: PROMPT_INVALID };
  const history = book.keys[name];
  if (history === undefined) return { key: name, code: isReservedKey(name) ? PROMPT_RESERVED_NAME : PROMPT_UNKNOWN_KEY };
  return { key: name, history };
}

function textOfRevision(history: PromptHistory, revision: number): string | undefined {
  return history.revisions.find((rev) => rev.revision === revision)?.text;
}

function currentText(history: PromptHistory): string {
  return textOfRevision(history, history.current) ?? history.builtin;
}

/* ------------------------------------------------------------------ *
 * createBook / placeholder
 * ------------------------------------------------------------------ */

export interface CreateBookInput {
  builtins: Record<string, string>;
}

export interface CreateBookResult {
  book: PromptBook;
  codes: string[];
}

/**
 * 从内置默认文本建书:每个 key 生成 revision 1(origin=builtin,predecessor=null)。
 * 保留名(admin.* / __ 前缀)与空文本被拒并报码;system.* 允许(内置命名空间)。
 */
export function createBook(input: unknown, opts: { at?: number } = {}): CreateBookResult {
  const at = toFinite(opts.at, 0);
  const source = (input ?? {}) as { builtins?: unknown };
  const builtins = source.builtins;
  if (!builtins || typeof builtins !== "object") return { book: emptyBook(), codes: [PROMPT_INVALID] };
  const codes: string[] = [];
  const book = emptyBook();
  for (const [rawKey, rawText] of Object.entries(builtins as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (key === "") {
      codes.push(PROMPT_INVALID);
      continue;
    }
    if (reservedAtDeclaration(key)) {
      codes.push(PROMPT_RESERVED_NAME);
      continue;
    }
    if (typeof rawText !== "string" || rawText.trim() === "") {
      codes.push(PROMPT_INVALID);
      continue;
    }
    book.keys[key] = {
      key,
      builtin: rawText,
      revisions: [{ revision: 1, text: rawText, predecessor: null, timestamp: at, origin: "builtin" }],
      current: 1,
      status: "active",
    };
  }
  return { book, codes: orderCodes(codes) };
}

const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_.-]+)\}\}/g;

/** 按 `{{name}}` 提取占位符集合(去重,保持出现顺序)。 */
export function extractPlaceholders(text: unknown): string[] {
  if (typeof text !== "string" || text === "") return [];
  const out: string[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, "g");
  let matched: RegExpExecArray | null = re.exec(text);
  while (matched !== null) {
    const name = matched[1] ?? "";
    if (name !== "" && !out.includes(name)) out.push(name);
    matched = re.exec(text);
  }
  return out;
}

export interface ValidateRevisionResult {
  codes: string[];
}

/**
 * 校验一次候选文本:内置里有的占位符不许丢(MISSING),文本里多出的占位符不许有(UNKNOWN)。
 * 这是「升级默认后被覆盖版静默失效」的反向护栏——占位符契约以内置为基准。
 */
export function validateRevision(book: unknown, input: unknown): ValidateRevisionResult {
  const source = normalizePromptBook(book);
  const req = (input ?? {}) as { key?: unknown; text?: unknown };
  if (typeof req.text !== "string") return { codes: [PROMPT_INVALID] };
  const found = findHistory(source, req.key);
  if (found.history === undefined) return { codes: [found.code ?? PROMPT_INVALID] };
  const builtinPlaceholders = extractPlaceholders(found.history.builtin);
  const textPlaceholders = extractPlaceholders(req.text);
  const codes: string[] = [];
  if (builtinPlaceholders.some((name) => !textPlaceholders.includes(name))) codes.push(PROMPT_PLACEHOLDER_MISSING);
  if (textPlaceholders.some((name) => !builtinPlaceholders.includes(name))) codes.push(PROMPT_PLACEHOLDER_UNKNOWN);
  return { codes: orderCodes(codes) };
}

/* ------------------------------------------------------------------ *
 * saveRevision
 * ------------------------------------------------------------------ */

export interface SaveRevisionInput {
  key: string;
  text: string;
  /** 必须声明:保存基于哪一版(与会话/团队并发写对齐)。 */
  baseRevision: number;
  origin: PromptOrigin;
  author?: string;
  note?: string;
  /** RSI 来源的审批(ok=true 才允许落序列;store 侧还要过 #196 门)。 */
  approval?: { ok: boolean; by?: string };
}

export interface SaveRevisionResult {
  book: PromptBook;
  revision?: PromptRevision;
  codes: string[];
  /** 冲突/校验失败时的草稿文本(不丢稿)。 */
  draft?: string;
}

/**
 * 保存一个新版本(不可变:返回新 book,入参不动)。
 *
 * 判定顺序:非法输入 → 未知/保留 key → placeholder 契约 → base 冲突(不写,回 draft)
 * → 与默认相同(NOOP;已有覆盖则自动删覆盖并标 PRUNED)→ RSI 审批 → 追加 revision。
 */
export function saveRevision(book: unknown, input: unknown, opts: { at?: number } = {}): SaveRevisionResult {
  const source = normalizePromptBook(book);
  const at = toFinite(opts.at, 0);
  const req = (input ?? {}) as Partial<SaveRevisionInput>;
  const draft = typeof req.text === "string" ? req.text : undefined;
  const fail = (codes: string[]): SaveRevisionResult => ({ book: source, codes: orderCodes(codes), draft });

  if (typeof req.text !== "string") return fail([PROMPT_INVALID]);
  const found = findHistory(source, req.key);
  if (found.history === undefined) return fail([found.code ?? PROMPT_INVALID]);
  const history = found.history;

  const validation = validateRevision(source, { key: found.key, text: req.text });
  if (validation.codes.length > 0) return fail(validation.codes);

  const base = req.baseRevision;
  if (typeof base !== "number" || !Number.isInteger(base)) return fail([PROMPT_INVALID]);
  if (base !== history.current) return fail([PROMPT_CONFLICT]);

  if (req.text === history.builtin) {
    if (history.current === 1) return fail([PROMPT_NOOP_SAME_AS_DEFAULT]);
    // 覆盖内容与默认一致:没有存在意义 → 自动删覆盖,current 回 1。
    const pruned = normalizePromptBook(source);
    const target = pruned.keys[found.key];
    if (target !== undefined) {
      target.current = 1;
      target.status = "active";
    }
    return { book: pruned, codes: orderCodes([PROMPT_NOOP_SAME_AS_DEFAULT, PROMPT_PRUNED]) };
  }

  const origin = req.origin;
  if (typeof origin !== "string" || !(PROMPT_ORIGINS as readonly string[]).includes(origin)) return fail([PROMPT_INVALID]);
  if (origin === "builtin") return fail([PROMPT_INVALID]);
  if (origin === "rsi" && req.approval?.ok !== true) return fail([PROMPT_NEEDS_APPROVAL]);

  const revision: PromptRevision = {
    revision: history.revisions.reduce((max, rev) => Math.max(max, rev.revision), 0) + 1,
    text: req.text,
    predecessor: history.current,
    timestamp: at,
    origin: origin as PromptOrigin,
    baseRevision: base,
  };
  if (typeof req.author === "string" && req.author.trim() !== "") revision.author = req.author.trim();
  if (typeof req.note === "string" && req.note.trim() !== "") revision.note = req.note.trim();

  const updated = normalizePromptBook(source);
  const target = updated.keys[found.key];
  if (target === undefined) return fail([PROMPT_UNKNOWN_KEY]);
  target.revisions.push(revision);
  target.current = revision.revision;
  target.status = "active";
  return { book: updated, revision, codes: [PROMPT_SAVED] };
}

/* ------------------------------------------------------------------ *
 * resolve / 会话钉扎
 * ------------------------------------------------------------------ */

export interface ResolveResult {
  text?: string;
  revision?: number;
  codes: string[];
}

/** 按版本解析文本(缺省 current);版本不存在 → REVISION_NOT_FOUND。 */
export function resolve(book: unknown, key: unknown, opts: { revision?: number } = {}): ResolveResult {
  const source = normalizePromptBook(book);
  const found = findHistory(source, key);
  if (found.history === undefined) return { codes: [found.code ?? PROMPT_INVALID] };
  const history = found.history;
  const target = opts.revision ?? history.current;
  if (typeof target !== "number" || !Number.isFinite(target)) return { codes: [PROMPT_INVALID] };
  const text = textOfRevision(history, target);
  if (text === undefined) return { codes: [PROMPT_REVISION_NOT_FOUND] };
  return { text, revision: target, codes: [PROMPT_RESOLVED] };
}

export interface PinSessionResult {
  pins: SessionPromptPins;
  codes: string[];
}

/** 开启/刷新会话钉扎:把每个 key 的 current 快照一份。 */
export function pinSession(book: unknown, input: unknown): PinSessionResult {
  const source = normalizePromptBook(book);
  const req = (input ?? {}) as { sessionId?: unknown; at?: unknown };
  const sessionId = typeof req.sessionId === "string" ? req.sessionId.trim() : "";
  const at = toFinite(req.at, 0);
  const empty: SessionPromptPins = { sessionId, createdAt: at, revisions: {} };
  if (sessionId === "") return { pins: empty, codes: [PROMPT_INVALID] };
  const revisions: Record<string, number> = {};
  for (const [key, history] of Object.entries(source.keys)) revisions[key] = history.current;
  return { pins: { sessionId, createdAt: at, revisions }, codes: [PROMPT_PINNED] };
}

/** 会话内解析:按钉扎 revision(之后保存的新版本不影响本会话)。 */
export function resolveForSession(book: unknown, pins: unknown, key: unknown): ResolveResult {
  const source = normalizePromptBook(book);
  if (!pins || typeof pins !== "object") return { codes: [PROMPT_INVALID] };
  const pinned = (pins as Partial<SessionPromptPins>).revisions;
  const found = findHistory(source, key);
  if (found.history === undefined) return { codes: [found.code ?? PROMPT_INVALID] };
  if (!pinned || typeof pinned !== "object") return { codes: [PROMPT_INVALID] };
  const revision = pinned[found.key];
  if (typeof revision !== "number" || !Number.isFinite(revision)) return { codes: [PROMPT_REVISION_NOT_FOUND] };
  return resolve(source, found.key, { revision });
}

/* ------------------------------------------------------------------ *
 * 内置升级 / diff / 两态收敛 / prune
 * ------------------------------------------------------------------ */

export interface UpdateBuiltinResult {
  book: PromptBook;
  codes: string[];
  /** 受影响覆盖的版本引用(`key@revision`)——它们是基于旧内置写下的。 */
  affected: string[];
}

/**
 * 内置默认升级:不新增 revision(序列只记覆盖),只改 builtin 字段与 revision 1 的内置快照。
 * 已有覆盖 → status=default-updated(等用户选「保留我的 / 用新默认」)。
 */
export function updateBuiltin(book: unknown, input: unknown): UpdateBuiltinResult {
  const current = normalizePromptBook(book);
  const req = (input ?? {}) as { key?: unknown; text?: unknown; at?: unknown };
  const found = findHistory(current, req.key);
  if (found.history === undefined) return { book: current, codes: [found.code ?? PROMPT_INVALID], affected: [] };
  if (typeof req.text !== "string" || req.text.trim() === "") return { book: current, codes: [PROMPT_INVALID], affected: [] };
  const at = toFinite(req.at, 0);
  const updated = normalizePromptBook(current);
  const target = updated.keys[found.key];
  if (target === undefined) return { book: current, codes: [PROMPT_UNKNOWN_KEY], affected: [] };
  const affected =
    target.current > 1 ? target.revisions.filter((rev) => rev.revision > 1).map((rev) => `${found.key}@${rev.revision}`) : [];
  target.builtin = req.text;
  const first = target.revisions[0];
  if (first !== undefined) {
    first.text = req.text;
    if (at > 0) first.timestamp = at;
  }
  target.status = target.current > 1 ? "default-updated" : "active";
  return { book: updated, codes: [PROMPT_DEFAULT_UPDATED], affected };
}

export interface PromptDiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

export interface PromptDiffResult {
  same: boolean;
  /** left=我的覆盖,right=新默认:del=只在我的版本里,add=只在默认里。 */
  lines: PromptDiffLine[];
  codes: string[];
}

function lineDiff(left: string[], right: string[]): PromptDiffLine[] {
  const n = left.length;
  const m = right.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      const nextRow = table[i + 1] as number[];
      row[j] = left[i] === right[j] ? ((nextRow[j + 1] as number) ?? 0) + 1 : Math.max((nextRow[j] as number) ?? 0, (row[j + 1] as number) ?? 0);
    }
  }
  const out: PromptDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const leftLine = left[i] as string;
    const rightLine = right[j] as string;
    if (leftLine === rightLine) {
      out.push({ kind: "same", text: leftLine });
      i += 1;
      j += 1;
      continue;
    }
    const down = (table[i + 1] as number[])[j] as number;
    const rightScore = (table[i] as number[])[j + 1] as number;
    if (down >= rightScore) {
      out.push({ kind: "del", text: leftLine });
      i += 1;
    } else {
      out.push({ kind: "add", text: rightLine });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: left[i] as string });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "add", text: right[j] as string });
    j += 1;
  }
  return out;
}

/** 当前覆盖 vs 新默认的行 diff(same=true 时全 same)。 */
export function diffWithDefault(book: unknown, key: unknown): PromptDiffResult {
  const source = normalizePromptBook(book);
  const found = findHistory(source, key);
  if (found.history === undefined) return { same: false, lines: [], codes: [found.code ?? PROMPT_INVALID] };
  const history = found.history;
  const mine = currentText(history);
  if (mine === history.builtin) {
    const lines = history.builtin === "" ? [] : history.builtin.split("\n").map((text) => ({ kind: "same" as const, text }));
    return { same: true, lines, codes: [] };
  }
  return { same: false, lines: lineDiff(mine.split("\n"), history.builtin.split("\n")), codes: [] };
}

export interface BookResult {
  book: PromptBook;
  codes: string[];
}

/** 用新默认:忽略覆盖(current 回 1,status 回 active)。 */
export function acceptDefault(book: unknown, key: unknown): BookResult {
  const current = normalizePromptBook(book);
  const found = findHistory(current, key);
  if (found.history === undefined) return { book: current, codes: [found.code ?? PROMPT_INVALID] };
  const updated = normalizePromptBook(current);
  const target = updated.keys[found.key];
  if (target === undefined) return { book: current, codes: [PROMPT_UNKNOWN_KEY] };
  const pruned = target.current > 1;
  if (pruned) target.current = 1;
  target.status = "active";
  return { book: updated, codes: pruned ? [PROMPT_PRUNED] : [] };
}

/**
 * 保留我的:覆盖文本不动(版本号不跳),只把 status 打回 active——
 * 「我的版本现在被认定为基于新默认」,后续解析仍读我的文本。
 */
export function keepOverride(book: unknown, key: unknown): BookResult {
  const current = normalizePromptBook(book);
  const found = findHistory(current, key);
  if (found.history === undefined) return { book: current, codes: [found.code ?? PROMPT_INVALID] };
  const updated = normalizePromptBook(current);
  const target = updated.keys[found.key];
  if (target === undefined) return { book: current, codes: [PROMPT_UNKNOWN_KEY] };
  target.status = "active";
  return { book: updated, codes: [] };
}

export interface PruneResult {
  book: PromptBook;
  pruned: string[];
}

/** 治理残留:删掉与内置默认逐字相同的覆盖(current 回 1)。 */
export function pruneRedundant(book: unknown): PruneResult {
  const updated = normalizePromptBook(book);
  const pruned: string[] = [];
  for (const [key, history] of Object.entries(updated.keys)) {
    if (history.current > 1 && currentText(history) === history.builtin) {
      history.current = 1;
      history.status = "active";
      pruned.push(key);
    }
  }
  return { book: updated, pruned };
}

/** 全部 key(排序后),供 store/CLI 报告用。 */
export function promptKeys(book: unknown): string[] {
  return Object.keys(normalizePromptBook(book).keys).sort((a, b) => a.localeCompare(b));
}
