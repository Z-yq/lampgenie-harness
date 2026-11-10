/**
 * RSI #209 提示词版本与覆盖治理的持久层(IO)。
 * 数据面:
 * - `<root>/.genie/rsi/prompts/book.json`  完整 book(不可变版本序列 + builtin + status),原子写
 * - `<root>/.genie/rsi/prompts/pins.json`  会话钉扎 `{schema, sessions: {sessionId: SessionPromptPins}}`
 * 为什么不 append-only:book 的真相是「当前版本序列 + 谁覆盖了谁」,每次保存都要整体一致
 * (predecessor 链、current 指针、status 三者同源);原子写 + 写后重读比追加行更不容易半态。
 * 语义全部在 packages/harness-runtime/src/agent/prompt-version.ts(纯逻辑零 IO),本层只做:
 * 读盘 → 调纯函数 → 写盘。root 参数非法才 throw,IO/坏文件一律折叠成稳定码。
 * #196 集成:origin=rsi 的保存先构造 surface="prompt" 的 ModificationRequest 过
 * evaluateSelfModification;decision !== allow → 拒写,原样透传 MOD_* 码。
 * 依赖纪律:node:fs/node:path + runtime 两个纯逻辑模块;不引 agent loop、不引 gateway 其余业务模块。
 * runtime 模块按 cohort-metrics-store 的既有套路惰性双跳解析(vitest 走包导出 src;
 * 裸 node/tsx 缺文件时回退仓内源文件 URL)。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type {
  PromptBook,
  PromptRevision,
  SaveRevisionInput,
  SessionPromptPins,
} from "@lampgenie/runtime/agent/prompt-version";
import type { ModificationRequest } from "@lampgenie/runtime/agent/self-modification";

export const PROMPT_STORE_SCHEMA = 1;

/** 纯逻辑 saveRevision 的失败码集合:命中任一即不落盘;其余(SAVED/NOOP+PRUNED)都是成功态。 */
const SAVE_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  "PROMPT_INVALID",
  "PROMPT_UNKNOWN_KEY",
  "PROMPT_RESERVED_NAME",
  "PROMPT_PLACEHOLDER_MISSING",
  "PROMPT_PLACEHOLDER_UNKNOWN",
  "PROMPT_CONFLICT",
  "PROMPT_NEEDS_APPROVAL",
  "PROMPT_REVISION_NOT_FOUND",
]);

export interface PromptDiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

interface PromptRuntime {
  PROMPT_VERSION_SCHEMA: number;
  createBook(input: unknown, opts?: { at?: number }): { book: PromptBook; codes: string[] };
  normalizePromptBook(input: unknown): PromptBook;
  saveRevision(
    book: unknown,
    input: unknown,
    opts?: { at?: number },
  ): { book: PromptBook; revision?: PromptRevision; codes: string[]; draft?: string };
  resolve(book: unknown, key: unknown, opts?: { revision?: number }): { text?: string; revision?: number; codes: string[] };
  pinSession(book: unknown, input: unknown): { pins: SessionPromptPins; codes: string[] };
  resolveForSession(book: unknown, pins: unknown, key: unknown): { text?: string; revision?: number; codes: string[] };
  updateBuiltin(book: unknown, input: unknown): { book: PromptBook; codes: string[]; affected: string[] };
  diffWithDefault(book: unknown, key: unknown): { same: boolean; lines: PromptDiffLine[]; codes: string[] };
  acceptDefault(book: unknown, key: unknown): { book: PromptBook; codes: string[] };
  keepOverride(book: unknown, key: unknown): { book: PromptBook; codes: string[] };
  pruneRedundant(book: unknown): { book: PromptBook; pruned: string[] };
  promptKeys(book: unknown): string[];
}

interface SelfModRuntime {
  evaluateSelfModification(req: ModificationRequest, policy?: unknown): { decision: string; codes: string[]; details: string[] };
}

let promptRuntime: PromptRuntime | undefined;
let selfModRuntime: SelfModRuntime | undefined;

async function loadRuntime<T>(specifier: string, fallbackPath: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch {
    const url = new URL(fallbackPath, import.meta.url).href;
    return (await import(url)) as T;
  }
}

async function runtime(): Promise<PromptRuntime> {
  if (promptRuntime !== undefined) return promptRuntime;
  promptRuntime = await loadRuntime<PromptRuntime>(
    "@lampgenie/runtime/agent/prompt-version",
    "../../../packages/harness-runtime/src/agent/prompt-version.ts",
  );
  return promptRuntime;
}

async function selfMod(): Promise<SelfModRuntime> {
  if (selfModRuntime !== undefined) return selfModRuntime;
  selfModRuntime = await loadRuntime<SelfModRuntime>(
    "@lampgenie/runtime/agent/self-modification",
    "../../../packages/harness-runtime/src/agent/self-modification.ts",
  );
  return selfModRuntime;
}

/* ------------------------------------------------------------------ *
 * 路径与落盘
 * ------------------------------------------------------------------ */

function ensureRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new Error("prompt-version-store: root 必须是非空字符串");
  return resolvePath(root.trim());
}

/** 提示词书文件路径。 */
export function promptBookPath(root: string): string {
  return join(ensureRoot(root), ".genie", "rsi", "prompts", "book.json");
}

/** 会话钉扎文件路径。 */
export function promptPinsPath(root: string): string {
  return join(ensureRoot(root), ".genie", "rsi", "prompts", "pins.json");
}

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function dedupe(codes: readonly string[]): string[] {
  const out: string[] = [];
  for (const code of codes) if (!out.includes(code)) out.push(code);
  return out;
}

interface LoadedBook {
  book: PromptBook;
  codes: string[];
  exists: boolean;
}

async function readBook(root: string): Promise<LoadedBook> {
  const rt = await runtime();
  const file = promptBookPath(root);
  if (!existsSync(file)) return { book: { keys: {} }, codes: [], exists: false };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const container = (raw ?? {}) as { keys?: unknown; book?: unknown };
    const book = rt.normalizePromptBook(container.keys !== undefined ? container : container.book);
    return { book, codes: [], exists: true };
  } catch {
    return { book: { keys: {} }, codes: ["PROMPT_INVALID"], exists: true };
  }
}

function writeBook(rt: PromptRuntime, root: string, book: PromptBook): void {
  atomicWriteJson(promptBookPath(root), { schema: rt.PROMPT_VERSION_SCHEMA, keys: book.keys });
}

interface PinsFile {
  sessions: Record<string, SessionPromptPins>;
}

function readPins(root: string): { pins: PinsFile; codes: string[] } {
  const file = promptPinsPath(root);
  if (!existsSync(file)) return { pins: { sessions: {} }, codes: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const sessions = (raw as { sessions?: unknown } | null)?.sessions;
    const out: Record<string, SessionPromptPins> = {};
    if (sessions && typeof sessions === "object") {
      for (const [sessionId, value] of Object.entries(sessions as Record<string, unknown>)) {
        const item = (value ?? {}) as Partial<SessionPromptPins>;
        if (!item.revisions || typeof item.revisions !== "object") continue;
        const revisions: Record<string, number> = {};
        for (const [key, revision] of Object.entries(item.revisions)) {
          if (typeof revision === "number" && Number.isFinite(revision)) revisions[key] = revision;
        }
        out[sessionId] = {
          sessionId,
          createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : 0,
          revisions,
        };
      }
    }
    return { pins: { sessions: out }, codes: [] };
  } catch {
    return { pins: { sessions: {} }, codes: ["PROMPT_INVALID"] };
  }
}

function writePins(root: string, pins: PinsFile): void {
  atomicWriteJson(promptPinsPath(root), { schema: PROMPT_STORE_SCHEMA, sessions: pins.sessions });
}

/* ------------------------------------------------------------------ *
 * #196 自我修改门
 * ------------------------------------------------------------------ */

interface GateInput {
  key: string;
  text: string;
  baseRevision: number;
  at: number;
  approval?: { ok: boolean; by?: string };
}

async function evaluatePromptGate(input: GateInput): Promise<{ decision: string; codes: string[]; details: string[] }> {
  const mod = await selfMod();
  const by = typeof input.approval?.by === "string" ? input.approval.by.trim() : "";
  const request: ModificationRequest = {
    id: `prompt-${input.key}-rev${input.baseRevision + 1}`,
    schemaVersion: 1,
    surface: "prompt",
    targetRef: input.key,
    variant: `rev-${input.baseRevision + 1}`,
    summary: `prompt override ${input.key} rev ${input.baseRevision + 1}`,
    author: { kind: "rsi", id: "rsi" },
    ...(by !== "" ? { approver: { kind: "human" as const, id: by, at: input.at } } : {}),
    evidence: { hypothesisId: `prompt-version:${input.key}`, diffSummary: `${input.text.length} chars rev ${input.baseRevision + 1}` },
    impact: {},
    dryRun: { command: "prompt-version validate", ok: true, at: input.at },
    canary: { scope: "session", size: 1, plannedAt: input.at },
    rollback: { kind: "snapshot", ref: `prompt:${input.key}@${input.baseRevision}` },
    ownerName: "owner",
    irreversible: false,
    riskFlags: [],
    createdAt: input.at,
    updatedAt: input.at,
    decision: { kind: "pending" },
  };
  const evaluated = mod.evaluateSelfModification(request);
  return { decision: evaluated.decision, codes: evaluated.codes, details: evaluated.details };
}

/* ------------------------------------------------------------------ *
 * 公开 API
 * ------------------------------------------------------------------ */

export interface InitBookResult {
  ok: boolean;
  book: PromptBook;
  codes: string[];
}

/** 建立(或覆盖)整本书:每个 builtin key 生成 revision 1。 */
export async function initBook(root: string, input: { builtins: Record<string, string>; at?: number }): Promise<InitBookResult> {
  const rt = await runtime();
  const at = typeof input.at === "number" ? input.at : Date.now();
  const created = rt.createBook({ builtins: input.builtins }, { at });
  if (created.codes.length === 0) writeBook(rt, root, created.book);
  return { ok: created.codes.length === 0, book: created.book, codes: created.codes };
}

/** 读 book(缺文件=空书;坏文件=空书 + PROMPT_INVALID,不 throw)。 */
export async function loadBook(root: string): Promise<LoadedBook> {
  return readBook(root);
}

export interface SaveResult {
  ok: boolean;
  book: PromptBook;
  revision?: PromptRevision;
  codes: string[];
  draft?: string;
  decision?: string;
  gateDetails?: string[];
}

/**
 * 保存新版本:声明 base revision;冲突/校验失败不写盘并回 draft。
 * origin=rsi 先过 #196 门(假审批不落盘)。
 */
export async function saveRevision(
  root: string,
  input: SaveRevisionInput & { at?: number },
): Promise<SaveResult> {
  const rt = await runtime();
  const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : Date.now();
  const loaded = await readBook(root);
  let gate: { decision: string; codes: string[]; details: string[] } | undefined;

  if (input.origin === "rsi") {
    gate = await evaluatePromptGate({ key: input.key, text: input.text, baseRevision: input.baseRevision, at, approval: input.approval });
    if (gate.decision !== "allow") {
      const codes = dedupe([...(input.approval?.ok === true ? [] : ["PROMPT_NEEDS_APPROVAL"]), ...gate.codes]);
      return { ok: false, book: loaded.book, codes, draft: input.text, decision: gate.decision, gateDetails: gate.details };
    }
    // 门放行 ≠ 审批已成立:approval.ok 仍须为 true,由纯逻辑侧兜底报 NEEDS_APPROVAL。
  }

  const saved = rt.saveRevision(loaded.book, input, { at });
  // 幂等成功也算成功:NOOP(不再有覆盖)必须落盘,否则「自动删覆盖」只停在内存。
  const failed = saved.codes.some((code) => SAVE_FAILURE_CODES.has(code));
  const ok = !failed;
  if (ok) writeBook(rt, root, saved.book);
  return {
    ok,
    book: saved.book,
    revision: saved.revision,
    codes: saved.codes,
    draft: saved.draft,
    ...(gate !== undefined ? { decision: gate.decision, gateDetails: gate.details } : {}),
  };
}

/** 按版本解析(缺省 current);可回读任意历史版本。 */
export async function resolve(
  root: string,
  key: string,
  opts: { revision?: number } = {},
): Promise<{ ok: boolean; text?: string; revision?: number; codes: string[] }> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const res = rt.resolve(loaded.book, key, opts);
  return { ok: res.text !== undefined, ...res };
}

/** 开启/刷新会话钉扎(快照每 key current)。 */
export async function pinSession(
  root: string,
  sessionId: string,
  opts: { at?: number } = {},
): Promise<{ ok: boolean; pins?: SessionPromptPins; codes: string[] }> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const at = typeof opts.at === "number" && Number.isFinite(opts.at) ? opts.at : Date.now();
  const pinned = rt.pinSession(loaded.book, { sessionId, at });
  if (pinned.codes.includes("PROMPT_PINNED")) {
    const file = readPins(root);
    file.pins.sessions[pinned.pins.sessionId] = pinned.pins;
    writePins(root, file.pins);
    return { ok: true, pins: pinned.pins, codes: pinned.codes };
  }
  return { ok: false, codes: pinned.codes };
}

/** 会话内解析:按钉扎 revision(之后保存的新版本不影响该会话)。 */
export async function resolveForSession(
  root: string,
  sessionId: string,
  key: string): Promise<{ ok: boolean; text?: string; revision?: number; codes: string[] }> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const pins = readPins(root).pins.sessions[sessionId.trim()];
  if (pins === undefined) return { ok: false, codes: ["PROMPT_REVISION_NOT_FOUND"] };
  const res = rt.resolveForSession(loaded.book, pins, key);
  return { ok: res.text !== undefined, ...res };
}

/** 内置默认升级:不混入序列,status 切 default-updated 并给受影响覆盖。 */
export async function updateBuiltin(
  root: string,
  input: { key: string; text: string; at?: number },
): Promise<{ ok: boolean; book: PromptBook; codes: string[]; affected: string[] }> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const res = rt.updateBuiltin(loaded.book, { ...input, at: input.at ?? Date.now() });
  const ok = res.codes.includes("PROMPT_DEFAULT_UPDATED");
  if (ok) writeBook(rt, root, res.book);
  return { ok, book: res.book, codes: res.codes, affected: res.affected };
}

/** 当前覆盖 vs 新默认的行 diff。 */
export async function diffWithDefault(
  root: string,
  key: string): Promise<{ ok: boolean; same: boolean; lines: PromptDiffLine[]; codes: string[] }> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const res = rt.diffWithDefault(loaded.book, key);
  return { ok: res.codes.length === 0, ...res };
}

/** 用新默认:忽略覆盖(current 回 1)。 */
export async function acceptDefault(root: string, key: string): Promise<{ ok: boolean; book: PromptBook; codes: string[] }> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const res = rt.acceptDefault(loaded.book, key);
  const ok = !res.codes.includes("PROMPT_UNKNOWN_KEY") && !res.codes.includes("PROMPT_INVALID");
  if (ok) writeBook(rt, root, res.book);
  return { ok, book: res.book, codes: res.codes };
}

/** 保留我的:覆盖文本与版本号都不动,只把 status 打回 active。 */
export async function keepOverride(root: string, key: string): Promise<{ ok: boolean; book: PromptBook; codes: string[] }> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const res = rt.keepOverride(loaded.book, key);
  const ok = !res.codes.includes("PROMPT_UNKNOWN_KEY") && !res.codes.includes("PROMPT_INVALID");
  if (ok) writeBook(rt, root, res.book);
  return { ok, book: res.book, codes: res.codes };
}

/** 治理残留:删掉与默认逐字相同的覆盖。 */
export async function pruneRedundant(root: string): Promise<{ ok: boolean; book: PromptBook; pruned: string[]; codes: string[] }> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const res = rt.pruneRedundant(loaded.book);
  if (res.pruned.length > 0) writeBook(rt, root, res.book);
  return { ok: true, book: res.book, pruned: res.pruned, codes: res.pruned.length > 0 ? ["PROMPT_PRUNED"] : [] };
}

export interface HistoryResult {
  ok: boolean;
  key: string;
  builtin?: string;
  current?: number;
  status?: string;
  revisions?: PromptRevision[];
  codes: string[];
}

/** 历史回读:某 key 的完整版本序列。 */
export async function history(root: string, key: string): Promise<HistoryResult> {
  const loaded = await readBook(root);
  const record = loaded.book.keys[key.trim()];
  if (record === undefined) {
    return { ok: false, key, codes: ["PROMPT_UNKNOWN_KEY"] };
  }
  return {
    ok: true,
    key: record.key,
    builtin: record.builtin,
    current: record.current,
    status: record.status,
    revisions: record.revisions,
    codes: [],
  };
}

export interface PromptReport {
  ok: boolean;
  keys: number;
  revisions: number;
  pins: number;
  status: Record<string, number>;
  entries: Array<{ key: string; current: number; status: string; revisions: number }>;
  pinnedSessions: Array<{ sessionId: string; createdAt: number; pinned: number }>;
  codes: string[];
}

/** 汇总报告:key 数/版本数/钉扎会话数/status 分布。 */
export async function reportPrompts(root: string): Promise<PromptReport> {
  const rt = await runtime();
  const loaded = await readBook(root);
  const pins = readPins(root);
  const status: Record<string, number> = {};
  const entries: PromptReport["entries"] = [];
  let revisions = 0;
  for (const key of rt.promptKeys(loaded.book)) {
    const record = loaded.book.keys[key];
    if (record === undefined) continue;
    revisions += record.revisions.length;
    status[record.status] = (status[record.status] ?? 0) + 1;
    entries.push({ key, current: record.current, status: record.status, revisions: record.revisions.length });
  }
  const pinnedSessions = Object.values(pins.pins.sessions)
    .map((item) => ({ sessionId: item.sessionId, createdAt: item.createdAt, pinned: Object.keys(item.revisions).length }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return {
    ok: loaded.codes.length === 0 && pins.codes.length === 0,
    keys: entries.length,
    revisions,
    pins: pinnedSessions.length,
    status,
    entries,
    pinnedSessions,
    codes: dedupe([...loaded.codes, ...pins.codes]),
  };
}
