/**
 * 语义流程白板存储:
 * ① BoardDoc 落盘 .genie/boards/<sessionId>/<taskId>.json(沿用 plans/exports 的 per-session 落地惯例);
 * ② 写入经 BoardDocZ 校验 + 边引用完整性检查,原子写(tmp+rename);
 * ③ symbolRef 三态解析:linked/moved(anchor 文本锚重定位)/broken——
 *    符号真相以工作区文件文本为准(索引可能旧),callers/callees 富化走静态索引。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises"; // 异步变体专用(board-store-async):9p/drvfs 慢盘上同步 fs 阻塞事件循环
import { createHash } from "node:crypto";
import { extname, isAbsolute, join, resolve } from "node:path";
import { isPathInside } from "./path-safety.js"; // :内存索引按目录归属判(Windows 分隔符)
import { BoardDocZ, BoardNodeZ, type BoardDoc, type BoardEvidence, type BoardEvidenceFile, type BoardLinkState, type BoardSymbolRefZ } from "@lampgenie/protocol";
import type { z } from "zod";
import { computeP0Coverage, markDoneFromEvidence, validateP0Accepts } from "./board-accept.js";

type SymbolRef = z.infer<typeof BoardSymbolRefZ>;

/** q7 节点 label 限长(agent 写入面):label 是画布框内一行的文字,过长会把节点撑成大块、
 * 泳道全乱;实现细节/数据格式归 summary 与边 label。人手改板(board.save)不受此限。 */
export const LABEL_MAX_CHARS = 14;

/** 路径段消毒:sessionId/taskId 来自外部输入,剥路径分隔符防逃逸。 */
function seg(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_").slice(0, 120);
}

export function boardDir(root: string, sessionId: string): string {
  return join(root, ".genie", "boards", seg(sessionId));
}

export function boardPath(root: string, sessionId: string, taskId: string): string {
  return join(boardDir(root, sessionId), seg(taskId) + ".json");
}

// ---- 证据文件指纹----
/** 内容比对上限:超过就不算 sha256(只靠 mtimeMs+size),避免每次写板都读巨型文件。 */
const FINGERPRINT_MAX_BYTES = 512 * 1024;
/** 代码/文本扩展名白名单(sha256 只对这些做);其它(图片/二进制)只记 mtime+size。 */
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt",
  ".py", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php",
  ".sh", ".bash", ".zsh", ".css", ".scss", ".html", ".vue", ".svelte", ".yml", ".yaml", ".toml", ".sql",
]);

/** targets 里混着 "file#symbol"、目录、glob——这些不是可 stat 的单文件,直接跳过(不编造指纹)。 */
function statableTarget(p: string): string {
  const clean = String(p ?? "").split("#")[0]!.trim();
  if (!clean) return "";
  if (/[*?{[\]]/.test(clean)) return "";
  if (clean.endsWith("/") || clean.endsWith("\\")) return "";
  return clean;
}

/** 单文件指纹:不存在/目录/符号链接 → null(不记);文本且 ≤512KB 才带 sha256。 */
function fingerprintFile(root: string, target: string): BoardEvidenceFile | null {
  const clean = statableTarget(target);
  if (!clean) return null;
  const abs = isAbsolute(clean) ? clean : resolve(root, clean);
  if (!isPathInside(root, abs)) return null; // 只认仓内文件,不把外部路径写进板
  let st;
  try {
    st = lstatSync(abs); // lstat:符号链接 isFile=false → 不记
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const out: BoardEvidenceFile = { path: abs, mtimeMs: st.mtimeMs, size: st.size };
  if (st.size <= FINGERPRINT_MAX_BYTES && TEXT_EXTS.has(extname(abs).toLowerCase())) {
    try {
      out.sha256 = createHash("sha256").update(readFileSync(abs)).digest("hex");
    } catch { /* 读失败只留 mtime+size */ }
  }
  return out;
}

/** 捕获一组路径的指纹(≤12;去重;跳过不存在/目录/符号链接/越界路径)。 */
export function captureEvidenceFiles(root: string, targets: string[]): BoardEvidenceFile[] {
  const out: BoardEvidenceFile[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(targets) ? targets : []) {
    const fp = fingerprintFile(root, t);
    if (!fp || seen.has(fp.path)) continue;
    seen.add(fp.path);
    out.push(fp);
    if (out.length >= 12) break;
  }
  return out;
}

/** 落账时给 evidence 绑文件指纹:
 * - 盘上同 cmd 且 ok/at/output/note **逐字相同** = 不是本次新提交(整板重存/别的字段改动)→ 保留原指纹,
 *   否则每次保存都会刷新指纹,证据永远不会过期;
 * - 其余(新 cmd / 重跑后重新提交)= 按节点 targets + symbolRef.file 现采;客户端传的 files 一律不采信;
 * - 采集不到任何文件时不写 files(旧行为逐字不变)。
 * 原地改 doc.nodes[].evidence,返回 doc。 */
export function stampEvidenceFingerprints(root: string, doc: BoardDoc, prev: BoardDoc | null): BoardDoc {
  const prevEvByNode = new Map<string, BoardEvidence[]>();
  for (const n of prev?.nodes ?? []) prevEvByNode.set(n.id, ((n.evidence ?? []) as BoardEvidence[]));
  for (const n of doc.nodes) {
    const evs = (n.evidence ?? []) as BoardEvidence[];
    if (!evs.length) continue;
    const prevEvs = prevEvByNode.get(n.id) ?? [];
    const targets = [...strArr(n.targets), ...(n.symbolRef?.file ? [n.symbolRef.file] : [])];
    let touched = false;
    const nextEvs: BoardEvidence[] = evs.map((e) => {
      const base: BoardEvidence = { cmd: e.cmd, ok: e.ok, at: e.at, ...(e.note ? { note: e.note } : {}), ...(e.output ? { output: e.output } : {}) };
      const old = prevEvs.find((p) => p.cmd === e.cmd);
      const same = !!old && old.ok === e.ok && old.at === e.at
        && (old.output ?? "") === (e.output ?? "") && (old.note ?? "") === (e.note ?? "");
      if (same) {
        // 非本次新提交:原指纹原样保留(旧 evidence 无 files 就继续没有 = 逐字兼容);
        // 客户端传的 files/capturedAt 一律丢弃(指纹只能由本路径捕获)。
        const keepFiles = Array.isArray(old!.files) && old!.files.length > 0;
        return keepFiles ? { ...base, files: old!.files, capturedAt: old!.capturedAt ?? 0 } : base;
      }
      touched = true;
      const files = captureEvidenceFiles(root, targets);
      return files.length ? { ...base, files, capturedAt: Date.now() } : base;
    });
    n.evidence = nextEvs;
    // 证据变了才重算「落实」:只升不降(人手工置的 done 不被证据合并反手抹掉)。
    if (touched && markDoneFromEvidence(n as never)) n.done = true;
  }
  return doc;
}

// ---- 板写入互斥(进程内)----
/**
 * 同一块板文件的 read-modify-write 互斥(f1。
 * 缺陷背景:并行派 3 个 planner 时三者都拿到同一 boardWrite.taskId，
 * `load → merge → save` 各自持旧盘内容写回，后写者按 id 整块替换先写者——先落的板静默消失。
 * 语义:按 boardPath 串成一条链,后来的排在前一个之后执行;
 * - 前一个失败**不阻塞**后一个(`.then(run, run)`:成功失败都继续往下跑);
 * - 队列尾部完成后清理 Map 条目(防长跑进程按会话累积泄漏);只有自己仍是队尾时才清,
 *   后面已排队时由新的队尾接手清理(不能把等待者从链上摘掉);
 * - 只管进程内(单 gateway 进程写同一 .genie/boards);跨进程并发仍靠调用方纪律。
 */
const boardWriteChains = new Map<string, Promise<unknown>>();

export async function withBoardLock<T>(
  root: string,
  sessionId: string,
  taskId: string,
  fn: () => Promise<T> | T): Promise<T> {
  const key = boardPath(root, sessionId, taskId);
  const run = (): Promise<T> => Promise.resolve().then(fn);
  const prev = boardWriteChains.get(key);
  const next: Promise<T> = prev ? prev.then(run, run) : run();
  boardWriteChains.set(key, next);
  try {
    return await next;
  } finally {
    if (boardWriteChains.get(key) === next) boardWriteChains.delete(key);
  }
}

// ---- 人改板保真合并(节点级)----
/** 节点的宽松形态:agent 入参未经 BoardDocZ 解析(可能是部分字段),prev 侧来自 loadBoard(已补默认值),
 * 两侧都不能硬塞成 BoardNode,合并后再交给 saveBoard 校验。 */
type LooseNode = Record<string, unknown> & { id: string };

function looseNodes(v: unknown): LooseNode[] {
  return (Array.isArray(v) ? v : []).filter(
    (n): n is LooseNode => !!n && typeof n === "object" && typeof (n as { id?: unknown }).id === "string" && (n as { id: string }).id !== "",
  );
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** evidence 合并:按 cmd 去重,next 条目优先(顺序在前),prev 中 next 没提交的 cmd 追加在后。
 * 上限 24(协议 BoardEvidenceZ 数组上限):超出留最新,避免合并把整板顶到 schema 拒收。 */
function mergeEvidence(prev: unknown, next: unknown): { entries: Record<string, unknown>[]; keptFromPrev: number } {
  const cmds = new Set<string>();
  const out: Record<string, unknown>[] = [];
  const take = (v: unknown, fromPrev: boolean): number => {
    let kept = 0;
    for (const e of Array.isArray(v) ? v : []) {
      if (!e || typeof e !== "object") continue;
      const cmd = (e as { cmd?: unknown }).cmd;
      if (typeof cmd !== "string" || cmd.trim() === "" || cmds.has(cmd)) continue;
      cmds.add(cmd);
      out.push({ ...(e as Record<string, unknown>) });
      if (fromPrev) kept++;
    }
    return kept;
  };
  take(next, false);
  const keptFromPrev = take(prev, true);
  return { entries: out.length > 24 ? out.slice(-24) : out, keptFromPrev };
}

export interface BoardMergeStats {
  /** 从 prev 保留的人工评论条数。 */
  comments: number;
  /** next 未显式表态、从 prev 保留的「已落实」节点数。 */
  done: number;
  /** next 未给 pos、从 prev 保留的拖拽位置节点数。 */
  pos: number;
  /** next 未提交过的 cmd、从 prev 保留的证据条数。 */
  evidence: number;
}

export interface BoardMergeResult {
  /** 合并后的节点数组:先按 next 顺序,再追加 prev-only 节点。 */
  nodes: LooseNode[];
  /** prev 有、next 没提交而被保留的节点 id(人工新增节点;回执文案用)。 */
  keptIds: string[];
  stats: BoardMergeStats;
}

/**
 * 节点级保真合并:agent 提交整板(next)时,把板上已有(prev)的**人的痕迹**合回来,
 * 避免「人改板被 agent 全量覆盖」(人的 comments/done/pos/人工新增节点一次落板全丢)。
 * 语义:
 * 1. 以 next 为主体与顺序;同 id 节点:
 *    - 保留人的痕迹:comments(next 未给/为空时用 prev)、done(next 未显式给布尔值时保留 prev 的 true;
 *      **next 显式 done:false 尊重 false**)、pos(next 为 undefined 时保留 prev)。
 *    - 以 next 为准(agent 的意图):label/summary/kind/group/before/change/phase/targets/accept/
 *      flow/symbolRef/wf/fileRef。
 *    - evidence:按 cmd 合并去重(next 优先,prev 中 next 未提交的 cmd 保留)。
 * 2. prev 有、next 没有的节点一律保留(通常带 virtual:true 或人工追加),追加到结果尾部并保持原相对顺序;
 *    这是本函数的已知限制:**没有删除语义**——agent 无法用 upsert 删掉板上的节点,
 *    删除只能由人经 board.save(带 skipGates 的人工改板口)做。刻意为之:少删一个节点只是多一块图,
 *    误删人的节点等于丢人的工作。
 * 3. 顺序:先 next 顺序,再 prev-only;节点总数上限 maxNodes(协议 BoardDocZ 60),超限时**只截 prev-only 尾部**
 *    (agent 提交的节点永远不丢)。
 */
export function mergeBoardNodes(
  prevNodes: unknown,
  nextNodes: unknown,
  opts: { keepPrevOnly?: boolean; maxNodes?: number } = {},
): BoardMergeResult {
  const prevList = looseNodes(prevNodes);
  const nextList = looseNodes(nextNodes);
  const prevById = new Map<string, LooseNode>();
  for (const n of prevList) if (!prevById.has(n.id)) prevById.set(n.id, n);
  const stats: BoardMergeStats = { comments: 0, done: 0, pos: 0, evidence: 0 };
  const out: LooseNode[] = [];
  const seen = new Set<string>();
  for (const n of nextList) {
    if (seen.has(n.id)) continue; // next 内撞 id:先到先得(saveBoard 另有「节点 id 重复」拒收)
    seen.add(n.id);
    const merged: LooseNode = { ...n };
    const p = prevById.get(n.id);
    if (!p) { out.push(merged); continue; }
    // —— 人的痕迹:评论(next 未给/为空 → 用 prev)——
    const nextComments = strArr(n.comments);
    const prevComments = strArr(p.comments);
    if (nextComments.length > 0) merged.comments = nextComments;
    else if (prevComments.length > 0) {
      merged.comments = prevComments;
      stats.comments += prevComments.length;
    }
    // —— 人的痕迹:已落实(next 显式布尔值即尊重,含显式 false;未给 → 保留 prev 的 true)——
    if (typeof n.done === "boolean") merged.done = n.done;
    else if (p.done === true) {
      merged.done = true;
      stats.done += 1;
    }
    // —— 人的痕迹:拖拽位置(next 未给 → 保留 prev)——
    if (n.pos === undefined && p.pos !== undefined) {
      merged.pos = p.pos;
      stats.pos += 1;
    }
    // —— evidence:按 cmd 合并去重 ——
    const ev = mergeEvidence(p.evidence, n.evidence);
    if (ev.entries.length > 0) merged.evidence = ev.entries;
    else delete merged.evidence;
    stats.evidence += ev.keptFromPrev;
    out.push(merged);
  }
  const keptIds: string[] = [];
  const maxNodes = typeof opts.maxNodes === "number" && opts.maxNodes > 0 ? opts.maxNodes : 60;
  if (opts.keepPrevOnly !== false) {
    for (const p of prevList) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (out.length >= maxNodes) break; // 只在尾部截断人工新增节点,不丢 agent 提交的
      keptIds.push(p.id);
      out.push({ ...p });
    }
  }
  return { nodes: out, keptIds, stats };
}

// ---- 人改板变更集(humanEdits,2026-10):「人改板 → 按板续作」只派变更集 ----
/** 变更集比较里**不算改动**的字段:done=agent/人推进度、pos=画布拖拽位置(面板频繁回写,
 * 拖一下不等于改了设计)。comments 不入此集——评论文本变化也算人工改动,单独比(见 diffNodeFields)。 */
const HUMAN_EDIT_IGNORED = new Set(["id", "done", "pos", "comments"]);

/** 稳定序列化(对象键排序、丢 undefined):语义字段等值比较用;数组保持顺序(flow 顺序有意义)。 */
function stableVal(v: unknown): string {
  if (v === null || typeof v !== "object") return String(JSON.stringify(v));
  if (Array.isArray(v)) return "[" + v.map(stableVal).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableVal(o[k])).join(",") + "}";
}

/** 单节点相比原板的字段级改动清单(字段原名,给「按板续作」拼「改动:」行);
 * 空数组=没改。原板没有该 id=人工新增节点。删除的节点不在此列(没 id 可派发)。 */
export function diffNodeFields(prev: LooseNode | undefined, next: LooseNode): string[] {
  if (!prev) return ["新增节点"];
  const fields: string[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (HUMAN_EDIT_IGNORED.has(k)) continue;
    if (stableVal(prev[k]) !== stableVal(next[k])) fields.push(k);
  }
  // 评论文本变化也算人工改动(board.comment 走另一条链,这里只管人整板保存时带进来的评论)
  if (stableVal(strArr(prev.comments)) !== stableVal(strArr(next.comments))) fields.push("comments");
  return fields;
}

export interface BoardHumanEdits {
  /** 人工动过的节点 id(入参顺序、去重;上限 60=协议节点上限)。 */
  ids: string[];
  /** 记录这份变更集时的板 rev(派发后清空为 {ids:[], rev}）。 */
  rev: number;
  /** 每个变更节点的字段级改动(给「改动:」行;缺失/空=只报「人工改动」)。 */
  changes: Record<string, string[]>;
}

/** 计算人工改动集:入参 nodes(人保存的整板)与 existing nodes 按 id 比;
 * **新增 id** 与**语义字段/评论有变化的 id** 都算(顺序=入参顺序,去重)。
 * 上限 60(超出只留前 60,变更集本身远小于此;整板容量本身就是 60)。 */
export function computeHumanEdits(prevNodes: unknown, nextNodes: unknown, rev: number): BoardHumanEdits {
  const prevById = new Map<string, LooseNode>();
  for (const n of looseNodes(prevNodes)) if (!prevById.has(n.id)) prevById.set(n.id, n);
  const ids: string[] = [];
  const changes: Record<string, string[]> = {};
  for (const n of looseNodes(nextNodes)) {
    if (ids.includes(n.id)) continue;
    const fields = diffNodeFields(prevById.get(n.id), n);
    if (fields.length === 0) continue;
    ids.push(n.id);
    changes[n.id] = fields.slice(0, 12);
  }
  return { ids: ids.slice(0, 60), rev, changes };
}

/** 校验 + 落盘(原子)。返回 {ok, path} 或 {ok:false, reason}——调用方决定 fail-soft 话术。
 * 代码级落目标两道门(只对 agent 写入面生效):
 * - **落板门**:phase=P0 节点必须带非空 accept,缺则拒收并点名(板上写着 DoD 却没人核对=本次事故根因);
 * - **门**:status=done 时 P0 节点必须全部有 ok=true 证据,否则拒收并列出未覆盖节点(禁止无证据宣称完成)。
 * opts.skipGates=true 用于系统侧回填(backfillActualFiles 的 diffstat 对账)与人工改板(board.save):
 * 那不是「agent 宣称完成」,不该被验收门卡住(人工改板也不该因缺 accept 而丢拖动结果)。
 * opts.gateExemptNodeIds=本次**不是 agent 提交**的节点(人改板保真合并保留下来的人工节点):
 * 两道门只管 agent 自己写下的话,否则人工新增的 P0 节点(人经 board.save 写,按位移口径不必带 accept)
 * 会把整块板永久卡在门外——agent 一落板就拒收,比原先的覆盖 bug 更糟。
 * opts.agentWrite=本次写入来自 **agent 工具面**(board_upsert 传 true):额外启用 label 限长门
 * (q7,见 assertAgentLabels)。人经 board.save 改板不传=不限长——人写长 label 是他的自由,
 * 且盘上存量超长 label 的节点只要不被本次提交触及(exempt/未提交)就不会导致拒收。 */
/** agent 写入面的常见 kind 笔误 → 最近义合法值(拒收自愈)。
 * 经验证两轮真跑(15 步/14 步)均踩同一个坑:kind 写枚举外值 → **整板拒收**,
 *  白付一步 + 一条 400 字符错误回执永驻历史(board_upsert 在 NEVER_COMPACT_TOOLS 里)。
 *  schema 描述里早已写明「只能取本枚举值之一」,模型照踩——文案路线到顶,故改为机制兜底。 */
const NODE_KIND_ALIASES: Readonly<Record<string, string>> = {
  util: "module", utils: "module", helper: "module", helpers: "module", class: "module",
  service: "module", services: "module", store: "module", cache: "module", lib: "module",
  api: "http", endpoint: "http", request: "http",
  route: "nav", router: "nav", menu: "nav", view: "page", screen: "page", ui: "page",
  if: "decision", branch: "decision", condition: "decision", switch: "decision",
  step: "function", task: "function", action: "function", handler: "function", method: "function",
  io: "io", file: "io", fs: "io", db: "io", disk: "io", network: "io",
  start: "start", input: "start", entry: "start", begin: "start", enter: "start",
  end: "end", output: "end", exit: "end", finish: "end", done: "end",
  note: "note", config: "note", comment: "note", doc: "note", text: "note",
};

/** 合法 kind 集合:从 BoardNodeZ 内省(唯一真源),失败时回落硬编码。
 *  测试 `board-node-kinds.test.ts` 锁住「内省可用且与枚举一致」——协议加新 kind 而这里没跟上是可测的。 */
function allowedNodeKinds(): readonly string[] {
  const kindSchema = (BoardNodeZ.shape as unknown as Record<string, unknown>).kind as
    | { _def?: { innerType?: { options?: readonly string[] }; options?: readonly string[] } }
    | undefined;
  const opts = kindSchema?._def?.innerType?.options ?? kindSchema?._def?.options;
  if (Array.isArray(opts) && opts.length > 0) return opts;
  return FALLBACK_NODE_KINDS;
}

/** 内省失败时的兜底清单(与 packages/protocol BoardNodeZ.kind 枚举同源;测试锁一致性)。 */
export const FALLBACK_NODE_KINDS: readonly string[] = [
  "module", "function", "decision", "note", "llm", "tool", "io",
  "start", "end", "http", "template", "aggregate", "loop", "retrieval", "classifier", "agent",
  "page", "section", "component", "nav",
  "wf-script", "wf-test", "wf-agent", "wf-condition", "wf-parallel", "wf-notify",
];

/** 导出供测试断言(内省是否走通)。 */
export { allowedNodeKinds };

/** agent 写入面的可自愈规范化:kind 校正 + label 截断。
 *  **只改确定可纠正的两类**,其它照旧严格拒收(边悬空/id 重复/P0 缺 accept/证据不足)。
 *  返回 corrections 供回执点名——静默改用户的板比拒收更糟,必须让模型和人都看见改了什么。 */
function normalizeAgentNodes(
  input: unknown,
  exemptLabelIds: ReadonlySet<string>,
): { value: unknown; corrections: string[] } {
  if (!input || typeof input !== "object") return { value: input, corrections: [] };
  const doc = input as Record<string, unknown>;
  if (!Array.isArray(doc.nodes)) return { value: input, corrections: [] };
  const kinds = new Set(allowedNodeKinds());
  const corrections: string[] = [];
  const nodes = doc.nodes.map((raw, index) => {
    if (!raw || typeof raw !== "object") return raw;
    const node = { ...(raw as Record<string, unknown>) };
    const id = String(node.id ?? `#${index}`);
    const kindRaw = typeof node.kind === "string" ? node.kind.trim() : "";
    if (kindRaw && !kinds.has(kindRaw)) {
      const mapped = NODE_KIND_ALIASES[kindRaw.toLowerCase()] ?? "module";
      node.kind = mapped;
      corrections.push(`节点 ${id} 的 kind「${kindRaw}」不在合法枚举内 → 按最近义改为「${mapped}」`);
    }
    if (!exemptLabelIds.has(id)) {
      const label = typeof node.label === "string" ? node.label : "";
      const chars = [...label];
      if (chars.length > LABEL_MAX_CHARS) {
        const cut = chars.slice(0, LABEL_MAX_CHARS).join("");
        node.label = cut;
        corrections.push(`节点 ${id} 的 label 超 ${LABEL_MAX_CHARS} 字 → 截断为「${cut}」(细节应写 summary)`);
      }
    }
    return node;
  });
  return { value: { ...doc, nodes }, corrections };
}

/** saveBoard/saveBoardAsync 共用写入参数(原 saveBoard 的内联参数原样抽出,签名兼容)。 */
export interface SaveBoardOpts {
  skipGates?: boolean;
  gateExemptNodeIds?: string[];
  agentWrite?: boolean;
  /** q7 配套:这些 id 的 label 与盘上已有版本逐字相同(=本次提交没改它),
   *  限长门跳过——存量超长 label 不该让 agent 的每次整板提交都被拒。 */
  labelExemptNodeIds?: string[];
 /** 内部参数(saveBoard/saveBoardAsync 自己填,调用方不用传):
   *  落盘前给新提交的 evidence 捕获目标文件指纹;prev 用于识别「不是本次新提交的证据」并保留原指纹。 */
  fingerprintRoot?: string;
  prevDoc?: BoardDoc | null;
}

/** 校验门(纯函数,零 fs 操作):saveBoard 与 saveBoardAsync 共用,防两份校验逻辑漂移。
 *  覆盖:agentWrite 自愈(kind 校正/label 截断)→ BoardDocZ.safeParse → 边引用完整性 → id 去重 →
 * P0 落板门(composition 免)→ done 门(P0 覆盖率)→ label 限长门;通过即赋 doc.updatedAt(落盘前)。 */
function validateBoardInput(
  input: unknown,
  opts: SaveBoardOpts): { ok: true; doc: BoardDoc; corrections: string[] } | { ok: false; reason: string } {
  // 自愈(只对 agent 写入面):kind 校正 + label 截断,替代「整板拒收」。
  // 人经 board.save 改板不传 agentWrite=保持严格校验(UI 只会发合法枚举,收紧才能暴露真 bug)。
  const normalized = opts.agentWrite
    ? normalizeAgentNodes(input, new Set(Array.isArray(opts.labelExemptNodeIds) ? opts.labelExemptNodeIds : []))
    : { value: input, corrections: [] as string[] };
  const corrections = normalized.corrections;
  const parsed = BoardDocZ.safeParse(normalized.value);
  if (!parsed.success) return { ok: false, reason: "白板结构不合法: " + parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") + " " + i.message).join("; ") };
  const doc = parsed.data;
 // evidence 指纹必须在**门之前**捕获——done 门要按过期后的真实状态判(过期=不算通过)。
  // 采集不到文件时证据不带 files,与旧行为逐字相同。
  if (opts.fingerprintRoot) stampEvidenceFingerprints(opts.fingerprintRoot, doc, opts.prevDoc ?? null);
  // 边引用完整性:挂在不存在的节点上的边是脏数据,拒收(防 mermaid 渲染炸)。
  const ids = new Set(doc.nodes.map((n) => n.id));
  const badEdge = doc.edges.find((e) => !ids.has(e.from) || !ids.has(e.to));
  if (badEdge) return { ok: false, reason: `边引用了不存在的节点: ${badEdge.from} -> ${badEdge.to}` };
  const dupId = doc.nodes.some((n, i) => doc.nodes.findIndex((x) => x.id === n.id) !== i);
  if (dupId) return { ok: false, reason: "节点 id 重复" };
  if (!opts.skipGates) {
    // 两道门只管 agent 本次提交的节点:人工保留节点(gateExemptNodeIds)由人负责,
    // 否则人工 P0 节点(人写板不必带 accept)会让 agent 的每次落板都被拒。
    const exempt = new Set(Array.isArray(opts.gateExemptNodeIds) ? opts.gateExemptNodeIds : []);
    const gated = exempt.size > 0 ? doc.nodes.filter((n) => !exempt.has(n.id)) : doc.nodes;
 // composition(作业思路板跳过 P0 accept 门:composition 是表达结构不是代码契约,
    // 不出命令级验收(主题/受众/章节/章间关系),结构完整性由类型门(board-contract)管。
 // 覆盖率门/门不动——status=done 仍要求 P0 证据全绿(思路板本身不该有 P0 节点)。
    if (doc.boardType !== "composition") {
      const v = validateP0Accepts(gated);
      if (!v.ok) return { ok: false, reason: "P0 落目标缺可执行验收: " + v.problems.join("; ") };
    }
    if (doc.status === "done") {
      const cov = computeP0Coverage({ nodes: gated });
      if (cov.passed < cov.total) {
        const staleIds = new Set(cov.stale.map((s) => s.nodeId));
        const open = cov.nodes.filter((s) => !s.passed).map((s) => {
          const stale = staleIds.has(s.id)
            ? `,证据过期 ${s.stale.length} 条(${s.stale.slice(0, 2).map((x) => `${x.cmd} ← ${x.file}`).join("、")})`
            : "";
          return `${s.id}「${s.label}」缺 ${s.missing.length} 条证据${stale}`;
        }).join("; ");
        return { ok: false, reason: `P0 落目标证据未覆盖(${cov.passed}/${cov.total}):` + open + "——先补跑验收并用 board_upsert action=evidence 回填,再置 done" };
      }
    }
    // q7 label 限长门(只对 agent 写入面:opts.agentWrite=true):label 是画布上的框内文字,
    // 一行装不下就把节点撑成大字块、泳道全乱;细节本该写进 summary(框内副标题)。
    // 口径:只校验**本次提交里改了 label 的节点**——存量超长 label(人留的/旧板)只要没被这次提交
    // 触及(exempt/逐字未变)就不拒收,否则整板提交会被历史数据永久卡死。
    if (opts.agentWrite) {
      const labelExempt = new Set(Array.isArray(opts.labelExemptNodeIds) ? opts.labelExemptNodeIds : []);
      const tooLong = gated.filter((n) => !labelExempt.has(n.id) && [...String(n.label ?? "")].length > LABEL_MAX_CHARS);
      if (tooLong.length > 0) {
        const detail = tooLong.slice(0, 3).map((n) => `${n.id}「${n.label}」${[...String(n.label)].length} 字`).join("; ");
        return { ok: false, reason: `节点 label 过长(${tooLong.length} 个,限 ${LABEL_MAX_CHARS} 字):${detail}——label 用名词短语 ≤${LABEL_MAX_CHARS} 字,细节写进 summary` };
      }
    }
  }
  doc.updatedAt = Date.now();
  return { ok: true, doc, corrections };
}

/** 内部:直读盘上旧板(不做存在性等待,读不到=null)。写路径用它拿 prev 指纹,**不要**用 loadBoard/loadBoardAsync
 *  (那两者在文件不存在时有最长 200ms 的等待,会把等待成本加到每次首次落板)。 */
function readPrevBoardSync(root: string, sessionId: string, taskId: string): BoardDoc | null {
  try {
    const parsed = BoardDocZ.safeParse(JSON.parse(readFileSync(boardPath(root, sessionId, taskId), "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
async function readPrevBoardAsync(root: string, sessionId: string, taskId: string): Promise<BoardDoc | null> {
  try {
    const parsed = BoardDocZ.safeParse(JSON.parse(await fsp.readFile(boardPath(root, sessionId, taskId), "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// sync-legacy:异步变体 saveBoardAsync 已就绪;本同步版供既有测试/tasks 脚本/冷路径使用,勿在新代码调用。
export function saveBoard(root: string, input: unknown, opts: SaveBoardOpts = {}): { ok: true; path: string; doc: BoardDoc; corrections?: string[] } | { ok: false; reason: string } {
 // 先读盘上旧板(用于识别「非本次新提交的证据」并保留原指纹),再走校验门。
  const loose = input as { sessionId?: unknown; taskId?: unknown } | null;
  const prevDoc = typeof loose?.sessionId === "string" && typeof loose?.taskId === "string"
    ? readPrevBoardSync(root, loose.sessionId, loose.taskId) : null;
  const v = validateBoardInput(input, { ...opts, fingerprintRoot: root, prevDoc });
  if (!v.ok) return v;
  const { doc, corrections } = v;
  const p = boardPath(root, doc.sessionId, doc.taskId);
  try {
    mkdirSync(boardDir(root, doc.sessionId), { recursive: true });
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(doc, null, 1));
    renameSync(tmp, p);
  } catch (err) {
    return { ok: false, reason: "白板落盘失败: " + String(err).slice(0, 120) };
  }
  // 九期补(drvfs 写后立读不可见窗):写盘成功即记忆路径——list/load 在目录枚举假阴性时按内存索引兜底
  boardMemIndex.set(p, Date.now());
  return { ok: true, path: p, doc, ...(corrections.length > 0 ? { corrections } : {}) };
}

/** 已写板的内存路径索引(本进程写过的都可信;drvfs readdir 间歇漏新条目时兜底;>10min 陈旧条目顺带清)。 */
const boardMemIndex = new Map<string, number>();
function memRescue(root: string, sessionId: string): string[] {
  const dir = boardDir(root, sessionId);
  const out: string[] = [];
  for (const [p, at] of boardMemIndex) {
    if (isPathInside(dir, p) && p.endsWith(".json")) {
      if (Date.now() - at > 600_000) boardMemIndex.delete(p);
      else out.push(p);
    }
  }
  return out;
}

// sync-legacy:异步变体 loadBoardAsync 已就绪;本同步版供既有测试/tasks 脚本/冷路径使用,勿在新代码调用(drvfs 忙等会停摆事件循环)。
export function loadBoard(root: string, sessionId: string, taskId: string): BoardDoc | null {
  const p = boardPath(root, sessionId, taskId);
  // drvfs 写后立读窗(existsSync 假阴性):无内存索引时退避重试一次存在性
  if (!existsSync(p) && !boardMemIndex.has(p)) {
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) { if (existsSync(p)) break; }
    if (!existsSync(p)) return null;
  }
  try {
    const parsed = BoardDocZ.safeParse(JSON.parse(readFileSync(p, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch (err) {
 // 六期注意:drvfs 高载下 readFileSync 间歇 EIO/ETIMEDOUT,fail-soft 吞掉=面板「凭空无板」;
    // 非 ENOENT 的读错误必须留痕(boot log 可见),与「文件不存在」区分。
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[board-store] 读板失败(非缺文件):", p, String(err).slice(0, 120));
    return null;
  }
}

/** 会话内全部板(按更新时间倒序);坏文件跳过不炸。 */
// sync-legacy:异步变体 listBoardsAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function listBoards(root: string, sessionId: string): { taskId: string; title: string; status: string; updatedAt: number; nodeCount: number }[] {
  return listBoardsEx(root, sessionId).items;
}

/** 带 skipped 计数(损坏/不可读文件数)的列板——面板据此区分「真无板」与「板文件损坏」,
 * 不再把损坏静默成「该会话还没有设计白板」。
 * 补 docKind(多板按类型过滤需要);pendingComments 由 server 侧按 board-comments 内存队列合并。 */
// sync-legacy:异步变体 listBoardsExAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用(drvfs 忙等会停摆事件循环)。
export function listBoardsEx(root: string, sessionId: string): { items: { taskId: string; title: string; status: string; updatedAt: number; nodeCount: number; docKind?: string }[]; skipped: number } {
  const dir = boardDir(root, sessionId);
  if (!existsSync(dir)) {
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) { if (existsSync(dir)) break; }
    if (!existsSync(dir)) return { items: [], skipped: 0 };
  }
  const out: { taskId: string; title: string; status: string; updatedAt: number; nodeCount: number; docKind?: string }[] = [];
  let skipped = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // drvfs/9p 高载间歇 EIO(review 抓):目录读失败 fail-soft 返回已收集项,不让 board.list 整体炸
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[board-store] 列板目录读失败:", dir, String(err).slice(0, 100));
    return { items: out, skipped };
  }
  const seen = new Set<string>();
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = BoardDocZ.safeParse(JSON.parse(readFileSync(join(dir, f), "utf-8")));
      if (!parsed.success) { skipped++; continue; }
      const d = parsed.data;
      seen.add(f);
      out.push({ taskId: d.taskId, title: d.title, status: d.status, updatedAt: d.updatedAt, nodeCount: d.nodes.length, docKind: d.docKind ?? "design" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") { console.error("[board-store] 列板读失败(非缺文件):", join(dir, f), String(err).slice(0, 120)); skipped++; }
      continue;
    }
  }
 // 内存索引对账(九期注意:readdir 漏新写文件=「刚生成的板凭空消失」)——漏的补读
  for (const p of memRescue(root, sessionId)) {
    const f = p.split("/").pop()!;
    if (seen.has(f)) continue;
    try {
      const parsed = BoardDocZ.safeParse(JSON.parse(readFileSync(p, "utf-8")));
      if (!parsed.success) continue; // 内存兜底里损坏不重复计 skipped(目录枚举已计)
      const d = parsed.data;
      out.push({ taskId: d.taskId, title: d.title, status: d.status, updatedAt: d.updatedAt, nodeCount: d.nodes.length });
    } catch {
      continue;
    }
  }
  return { items: out.sort((a, b) => b.updatedAt - a.updatedAt), skipped };
}

/** 任务完成回填实际触碰文件(计划 vs 实际对账, P4 的数据口)。 */
// sync-legacy:异步变体 backfillActualFilesAsync 已就绪;本同步版供既有测试/finalize 冷路径使用,勿在新代码调用。
export function backfillActualFiles(root: string, sessionId: string, taskId: string, files: string[]): boolean {
  const doc = loadBoard(root, sessionId, taskId);
  if (!doc) return false;
  doc.actual_files = files.slice(0, 60);
  if (doc.status !== "done") doc.status = "done";
  return saveBoard(root, doc).ok;
}

// ---- 设计沉淀索引:done 板的项目级「设计记忆」----
// 定位:白板=一次代码改动的临时任务草图;任务收官时最终板承载的设计决策沉淀为项目级知识,
// 在代码档案里可查可看。索引只存指针与反查键(files),板全文仍以 board 文件为单一真相——
// 点击条目走既有 board.get 通道拿 doc+links,索引损坏/缺失只影响列表不影响数据。

/** 沉淀索引条目;files=节点 symbolRef.file 去重(档案反查「哪些设计板碰过它」的匹配键)。 */
export interface BoardArchiveEntry {
  sessionId: string;
  taskId: string;
  projectId: string;
  title: string;
  status: string;
  updatedAt: number;
  nodeCount: number;
  files: string[];
  archivedAt: number;
}

export function boardArchivePath(root: string): string {
  return join(root, ".genie", "board-archive.json");
}

/** 读沉淀索引(容忍损坏/缺文件:返回已解析条目,不炸——列表面 fail-soft)。 */
// sync-legacy:异步变体 loadBoardArchiveAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function loadBoardArchive(root: string): BoardArchiveEntry[] {
  try {
    const p = boardArchivePath(root);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as { items?: BoardArchiveEntry[] };
    return Array.isArray(parsed.items) ? parsed.items.filter((it) => it && typeof it.sessionId === "string" && typeof it.taskId === "string") : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[board-store] 沉淀索引读失败(非缺文件):", String(err).slice(0, 120));
    return [];
  }
}

/** 按项目过滤(条目顺序保持 updatedAt 倒序由调用方排)。 */
// sync-legacy:异步变体 boardArchiveForAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function boardArchiveFor(root: string, projectId: string): BoardArchiveEntry[] {
  return loadBoardArchive(root).filter((it) => it.projectId === projectId);
}

/** 登记一块 done 板进沉淀索引(upsert by sessionId/taskId:重复收官覆盖同键=幂等;原子写)。
 * 只收 status=done 的板(draft/implementing 是活草图,不沉淀);索引体积有界(≤500 条,超出淘汰最旧)。 */
// sync-legacy:异步变体 archiveBoardAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function archiveBoard(root: string, doc: BoardDoc, projectId: string): boolean {
  if (doc.status !== "done") return false;
  const files = [...new Set(doc.nodes.map((n) => n.symbolRef?.file).filter((f): f is string => !!f))].slice(0, 60);
  const entry: BoardArchiveEntry = {
    sessionId: doc.sessionId, taskId: doc.taskId, projectId,
    title: doc.title, status: doc.status, updatedAt: doc.updatedAt,
    nodeCount: doc.nodes.length, files, archivedAt: Date.now(),
  };
  const items = loadBoardArchive(root).filter((it) => !(it.sessionId === entry.sessionId && it.taskId === entry.taskId));
  items.push(entry);
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  const bounded = items.length > 500 ? items.slice(0, 500) : items;
  try {
    mkdirSync(join(root, ".genie"), { recursive: true });
    const p = boardArchivePath(root);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, items: bounded }, null, 1));
    renameSync(tmp, p);
    return true;
  } catch (err) {
    console.error("[board-store] 沉淀索引写失败:", String(err).slice(0, 120));
    return false;
  }
}

/** 收官沉淀判定用轻量读:不做 drvfs 写后 200ms 忙等重试。
 * 每个无板任务的 done 都要过这里(app.ts 收官钩子),忙等×N 是纯事件循环浪费;
 * 正确性:本进程写过的板必在 boardMemIndex(10min 窗),backfill 刚落盘的板走内存索引零间隙。 */
// sync-legacy:异步变体 loadBoardFastAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
function loadBoardFast(root: string, sessionId: string, taskId: string): BoardDoc | null {
  const p = boardPath(root, sessionId, taskId);
  if (!existsSync(p) && !boardMemIndex.has(p)) return null;
  try {
    const parsed = BoardDocZ.safeParse(JSON.parse(readFileSync(p, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[board-store] 沉淀判定读板失败(非缺文件):", p, String(err).slice(0, 120));
    return null;
  }
}

/** 收官登记口(app.ts 任务 done 钩子用):板存在且 status=done 才沉淀;其余形态静默跳过。
 * 幂等性:upsert 同键覆盖,钩子重复触发(重启重放)不产生重复条目。 */
// sync-legacy:异步变体 archiveDoneBoardAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function archiveDoneBoard(root: string, sessionId: string, taskId: string, projectId: string): boolean {
  const doc = loadBoardFast(root, sessionId, taskId);
  if (!doc || doc.status !== "done") return false;
  return archiveBoard(root, doc, projectId);
}

// ---- 手绘批注层(P3 迁服务端:每任务一张 overlay.png,换浏览器/换机不丢) ----

export function overlayPath(root: string, sessionId: string, taskId: string): string {
  return join(boardDir(root, sessionId), seg(taskId) + ".overlay.png");
}

/** 存批注 PNG(dataURL 的 base64 体,不带 "data:image/png;base64," 前缀)。 */
// overlay 写后立读内存索引(drvfs 写后立读不可见窗:listBoards 同族坑,save 后秒级 load 会 null)
const overlayMemIndex = new Map<string, { b64: string; at: number }>();

// sync-legacy:异步变体 saveOverlayAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function saveOverlay(root: string, sessionId: string, taskId: string, dataB64: string): boolean {
  try {
    const buf = Buffer.from(dataB64, "base64");
    if (buf.length < 8 || buf.length > 4_200_000) return false;
    // PNG 完整 8 字节签名校验(review 抓:首两字节可被非 PNG 前缀绕过)
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (PNG_SIG.some((b, i) => buf[i] !== b)) return false;
    mkdirSync(boardDir(root, sessionId), { recursive: true });
    writeFileSync(overlayPath(root, sessionId, taskId), buf);
    overlayMemIndex.set(overlayPath(root, sessionId, taskId), { b64: dataB64, at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

// sync-legacy:异步变体 loadOverlayAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function loadOverlay(root: string, sessionId: string, taskId: string): string | null {
  const p = overlayPath(root, sessionId, taskId);
  try {
    if (existsSync(p)) return readFileSync(p).toString("base64");
  } catch { /* drvfs 读异常走内存兜底 */ }
  // drvfs 窗兜底:本进程刚写过的直接回内存副本(>10min 陈旧条目顺带清,同 listBoards memRescue 纪律)
  const mem = overlayMemIndex.get(p);
  if (mem) {
    if (Date.now() - mem.at > 10 * 60_000) { overlayMemIndex.delete(p); return null; }
    return mem.b64;
  }
  return null;
}

// sync-legacy:异步变体 deleteOverlayAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function deleteOverlay(root: string, sessionId: string, taskId: string): void {
  try {
    const p = overlayPath(root, sessionId, taskId);
    if (existsSync(p)) rmSync(p);
  } catch {
    // 删除失败容忍(批注不致命)
  }
}

/** 任务 done 收官( §4:
 * ① 有 checkpoint sha(开工树脏,快照钉住了任务前基线)→ diffstat 回填 actual_files(计划 vs 实际对账);
 * ② 涉事仓索引后台重建(改完码 code-index 跟着改)。
 * F 修复(撤销三期 B1 的「基线落 HEAD」):sha=null=开工时树干净(git stash
 * create 无变更)——没有钉住的任务前基线,diff HEAD 会把仓里他人/其他任务的在途未提交改动算成本任务
 * 「计划外」(共享仓经验证纯规划板被污染 50 文件)。诚实语义:无可信基线=不对账——不回填 actual_files、
 * 不翻 status=done;索引重建照走(指纹档判过期不依赖 git)。判据=sha 有无,不看板 kind。
 * diffstat/重建失败均 fail-soft。 */
export async function finalizeBoardOnTaskDone(opts: {
  storeRoot: string;
  sessionId: string;
  taskId: string;
  workdir: string;
  /** checkpoint.create 的 sha;null=开工时树干净(无可信基线,跳过对账只重建)。 */
  sha: string | null;
  diffstatFn?: (cwd: string, sha: string) => Promise<{ files: { path: string }[]; total: { files: number } }>;
  reindexFn?: (root: string) => void;
}): Promise<{ backfilled: boolean; reindexKicked: boolean }> {
  const diffstatFn = opts.diffstatFn ?? (await import("./git-service.js")).diffstat;
  let backfilled = false;
  if (opts.sha) {
    try {
      const st = await diffstatFn(opts.workdir, opts.sha);
      if (st && st.total.files > 0) {
        backfilled = backfillActualFiles(opts.storeRoot, opts.sessionId, opts.taskId, st.files.map((f) => f.path));
      }
    } catch {
      // diffstat 失败:回填跳过,重建照走(指纹档判过期不依赖 git)
    }
  }
  const reindex = opts.reindexFn ?? ((root: string) => {
    void import("./sense-index-manager.js").then((sm) => sm.ensureIndex(root)).catch(() => { /* 后台重建失败容忍,查询面 best-effort 自愈 */ });
  });
  reindex(opts.workdir);
  return { backfilled, reindexKicked: true };
}

// ---- symbolRef 三态解析 ----

/** 内部纯函数:把源码文本里的「非代码」内容抹成空格,换行符原样保留(行号可对齐)。
 * 状态处理:行注释(双斜杠到行尾)、块注释(斜杠星号…星号斜杠,允许跨行)、单引号串、双引号串、
 * 模板串(反引号,允许跨行),以及 Python 式三引号串(单/双三引号,允许跨行——文档字符串里点名
 * 符号最常见,不覆盖就会把后续代码整段吞成字符串,反而漏掉真命中);
 * 转义 `\"`、`\'`、`\\` 按「界定符+后一字一起抹」处理,故串内转义引号不会提前收尾。
 * 界定符本身也抹成空格(避免残留 `//`、引号干扰后续 includes/正则匹配)。
 * 正则字面量不做特殊解析(可能把除号当正则界,只影响极少见场景,不影响行号对齐)。
 * 字符长度与换行位置严格不变(逐字符原位替换),故行号/列位置对齐。
 * 单/双引号串未闭合时在行尾收尾(防御坏文本,C 系单行串本就换行即止);
 * 三引号串与模板串按跨行处理,未闭合则吞到文件尾。
 * 动机:旧版在整行原文本上匹配,注释/文档字符串里提到同名符号就命中 →
 * 板 symbolRef 的「漂移」全是假阳性。 */
export function maskNonCode(text: string): string {
  const out = text.split("");
  const n = text.length;
  const blank = (k: number) => {
    if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      // 无闭合 `*/` 时不当作块注释(防其它语言的 `/*` 字样,如 Python 注释里的 glob `sessions/*.jsonl`
      // 把余下全文吞成注释);正常 TS 代码里块注释总是闭合的。
      const close = text.indexOf("*/", i + 2);
      if (close < 0) {
        i += 2;
        continue;
      }
      blank(i++);
      blank(i++);
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if ((c === '"' && text[i + 1] === '"' && text[i + 2] === '"') || (c === "'" && text[i + 1] === "'" && text[i + 2] === "'")) {
      const triple = c.repeat(3);
      blank(i++);
      blank(i++);
      blank(i++);
      while (i < n) {
        if (text.startsWith(triple, i)) {
          blank(i++);
          blank(i++);
          blank(i++);
          break;
        }
        if (text[i] === "\\") {
          blank(i++);
          if (i < n) blank(i++);
          continue;
        }
        blank(i++);
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      blank(i++);
      while (i < n) {
        const d = text[i];
        if (d === "\\") {
          blank(i++);
          if (i < n) blank(i++);
          continue;
        }
        if (d === q) {
          blank(i++);
          break;
        }
        if (q !== "`" && d === "\n") break; // 未闭合串:行尾收尾
        blank(i++);
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 纯函数核心(可测):在工作区文件文本里按 anchor/名字定位符号行号。
 * anchor=签名行文本(首选);退化=符号名出现行(词边界防子串误配;
 * 「ClassName.method」形态在源码里不带类前缀——全名不中再试最后一段)。返回 1-based 行号,未命中 null。
 * 假阳性修复:先在 maskNonCode 抹掉注释/字符串后的文本上定位,
 * 注释里或字符串字面量里提到同名串不再算命中(否则板 symbolRef 的「漂移」全是假阳性)。 */
export function locateSymbolInText(fileText: string, ref: SymbolRef): number | null {
  const lines = maskNonCode(fileText).split("\n");
  if (ref.anchor) {
    const needle = maskNonCode(ref.anchor.trim());
    if (needle.trim()) {
      const at = lines.findIndex((l) => l.includes(needle));
      if (at >= 0) return at + 1;
    }
  }
  const candidates = [ref.name];
  const lastSeg = ref.name.includes(".") ? ref.name.split(".").pop()! : null;
  if (lastSeg && lastSeg !== ref.name) candidates.push(lastSeg);
  for (const cand of candidates) {
    const nameRe = new RegExp("(^|[^A-Za-z0-9_$])" + cand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^A-Za-z0-9_$]|$)");
    const at = lines.findIndex((l) => nameRe.test(l));
    if (at >= 0) return at + 1;
  }
  return null;
}

/** 单节点连接态判定(纯函数):
 * - 文件文本命中且行号与记录一致 → linked;行号不同 → moved(返回新行号);
 * - 文件读不到/文本不命中 → 看索引是否还有此名(有=moved 等重建刷新,无=broken)。 */
export function resolveLinkState(fileText: string | null, ref: SymbolRef, indexHasSymbol: boolean | null): { state: "broken" | "moved" | "linked"; line?: number } {
  if (fileText !== null) {
    const line = locateSymbolInText(fileText, ref);
    if (line !== null) return ref.line !== undefined && line === ref.line ? { state: "linked", line } : { state: "moved", line };
  }
  // 文件层面定位失败:索引里还有这个名字(可能文件刚改索引未刷)→ moved 待重建;否则断链。
  if (indexHasSymbol) return { state: "moved" };
  return { state: "broken" };
}

/** 整板解析:读文件文本 + 索引存在性,逐节点出三态。索引面由调用方注入(防存储层依赖索引管理器)。 */
// sync-legacy:异步变体 resolveBoardLinksAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function resolveBoardLinks(
  root: string,
  doc: BoardDoc,
  indexHas: (name: string) => boolean | null): BoardLinkState[] {
  const links: BoardLinkState[] = [];
  const fileCache = new Map<string, string | null>();
  for (const n of doc.nodes) {
    const ref = n.symbolRef;
    if (!ref) continue;
    const resolveRoot = doc.root ?? root;
    let text: string | null = null;
    if (ref.file) {
      if (!fileCache.has(ref.file)) {
        let t: string | null = null;
        try {
          // 路径围栏(review 抓):ref.file 来自板文档,拒绝绝对路径与 .. 逃逸,只读项目根内文件
          if (!ref.file.startsWith("/") && !ref.file.split("/").includes("..")) {
            const p = join(resolveRoot, ref.file);
            if (existsSync(p) && statSync(p).size < 4_000_000) t = readFileSync(p, "utf-8");
          }
        } catch {
          t = null;
        }
        fileCache.set(ref.file, t);
      }
      text = fileCache.get(ref.file) ?? null;
    }
    const r = resolveLinkState(text, ref, indexHas(ref.name));
    links.push({
      nodeId: n.id,
      state: r.state,
      ...(ref.file ? { file: ref.file } : {}),
      ...(r.line !== undefined ? { line: r.line } : {}),
      ...(r.state === "broken" ? { note: "符号在当前代码中未找到(已删除/改名?)" } : r.state === "moved" && r.line !== undefined ? { note: `行漂移:${ref.line ?? "?"} → ${r.line}` } : {}),
    });
  }
  return links;
}

/** targets 真实性核对:板上 targets 是「本次变更指向的实际文件路径」,
 * 常因写错/文件不存在/写成绝对路径而变成幻影——这里只报不判(audit 的 ok 计算不含本项)。
 * 口径与 resolveBoardLinks 的围栏一致:拒绝以 `/` 开头与含 `..` 段;`#` 之后是行锚/符号锚,
 * 不参与路径核对。目录不算命中(targets 应指向文件)。全程 try/catch,读盘异常归 missing。
 * `BoardLinkStateZ` 三值枚举零改动:本函数返回独立数组,state 只有 missing|outside。 */
// sync-legacy:异步变体 resolveTargetPathsAsync 已就绪;本同步版供既有测试/冷路径使用,勿在新代码调用。
export function resolveTargetPaths(
  root: string,
  doc: BoardDoc): Array<{ nodeId: string; target: string; state: "missing" | "outside" }> {
  const out: Array<{ nodeId: string; target: string; state: "missing" | "outside" }> = [];
  const resolveRoot = doc.root ?? root;
  for (const n of doc.nodes) {
    const targets = (n as { targets?: unknown }).targets;
    if (!Array.isArray(targets) || targets.length === 0) continue;
    for (const raw of targets) {
      const full = String(raw ?? "").trim();
      if (!full) continue;
      // `#` 之后是行号/符号锚(a.ts:12#foo),不进路径
      const p = full.split("#")[0]!.trim();
      if (!p) continue;
      let state: "missing" | "outside" | null = null;
      try {
        if (p.startsWith("/") || p.split("/").includes("..")) state = "outside";
        else {
          const abs = join(resolveRoot, p);
          if (!existsSync(abs) || !statSync(abs).isFile()) state = "missing";
        }
      } catch {
        state = "missing"; // 读盘异常(权限/符号链断裂)算 missing,不抛
      }
      if (state) out.push({ nodeId: n.id, target: p, state });
    }
  }
  return out;
}

// ---- 异步变体(board-store-async):9p/drvfs 慢盘上同步 fs 阻塞事件循环,网关请求路径改走本族。
// 同构纪律:与同步版逐字对齐的校验/留痕/内存索引语义;仅 fs 调用换 node:fs/promises(fsp),
// 存在性退避改 waitForPath(Promise sleep 轮询,绝不禁自旋忙等)。同步版原样保留(见 sync-legacy 注释)。 ----

/** Promise 版 sleep(替代 while(Date.now()<deadline) 自旋:轮询间隙让出事件循环)。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** drvfs 写后立读窗的异步退避:每 10ms fsp.stat 检查一次存在性,预算内出现即 true(≤20 轮)。
 *  与同步版 200ms 忙等同预算,但等待期间事件循环保持可调度(心跳/WS 不停摆)。 */
export async function waitForPath(p: string, budgetMs = 200): Promise<boolean> {
  const rounds = Math.max(1, Math.floor(budgetMs / 10));
  for (let i = 0; i < rounds; i++) {
    try {
      await fsp.stat(p);
      return true;
    } catch {
      await sleep(10);
    }
  }
  return false;
}

/** loadBoard 的异步同构:存在性等待用 waitForPath(仅当无内存索引),读走 fsp;非 ENOENT 错误留痕同款。 */
export async function loadBoardAsync(root: string, sessionId: string, taskId: string): Promise<BoardDoc | null> {
  const p = boardPath(root, sessionId, taskId);
  if (!boardMemIndex.has(p)) {
    // 与同步版逐字同构:内存索引有=直接读(本进程刚写,drvfs 假阴性窗内也可信)
    let present = false;
    try {
      await fsp.stat(p);
      present = true;
    } catch {
      present = false;
    }
    if (!present && !(await waitForPath(p))) return null;
  }
  try {
    const parsed = BoardDocZ.safeParse(JSON.parse(await fsp.readFile(p, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch (err) {
 // 六期注意同款:非 ENOENT 的读错误必须留痕(boot log 可见),与「文件不存在」区分。
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[board-store] 读板失败(非缺文件):", p, String(err).slice(0, 120));
    return null;
  }
}

/** listBoardsEx 的异步同构:目录等待 waitForPath;坏目录 fail-soft 留痕;坏文件 skipped++ 语义不变;
 *  memRescue 对账原样(同步内存索引读取,无 fs);返回类型与同步版逐字段相同。 */
export async function listBoardsExAsync(root: string, sessionId: string): Promise<{ items: { taskId: string; title: string; status: string; updatedAt: number; nodeCount: number; docKind?: string }[]; skipped: number }> {
  const dir = boardDir(root, sessionId);
  {
    let present = false;
    try {
      await fsp.stat(dir);
      present = true;
    } catch {
      present = false;
    }
    if (!present && !(await waitForPath(dir))) return { items: [], skipped: 0 };
  }
  const out: { taskId: string; title: string; status: string; updatedAt: number; nodeCount: number; docKind?: string }[] = [];
  let skipped = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[board-store] 列板目录读失败:", dir, String(err).slice(0, 100));
    return { items: out, skipped };
  }
  const seen = new Set<string>();
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = BoardDocZ.safeParse(JSON.parse(await fsp.readFile(join(dir, f), "utf-8")));
      if (!parsed.success) { skipped++; continue; }
      const d = parsed.data;
      seen.add(f);
      out.push({ taskId: d.taskId, title: d.title, status: d.status, updatedAt: d.updatedAt, nodeCount: d.nodes.length, docKind: d.docKind ?? "design" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") { console.error("[board-store] 列板读失败(非缺文件):", join(dir, f), String(err).slice(0, 120)); skipped++; }
      continue;
    }
  }
 // 内存索引对账(九期注意同款:readdir 漏新写文件=「刚生成的板凭空消失」)——漏的补读
  for (const p of memRescue(root, sessionId)) {
    const f = p.split("/").pop()!;
    if (seen.has(f)) continue;
    try {
      const parsed = BoardDocZ.safeParse(JSON.parse(await fsp.readFile(p, "utf-8")));
      if (!parsed.success) continue; // 内存兜底里损坏不重复计 skipped(目录枚举已计)
      const d = parsed.data;
      out.push({ taskId: d.taskId, title: d.title, status: d.status, updatedAt: d.updatedAt, nodeCount: d.nodes.length });
    } catch {
      continue;
    }
  }
  return { items: out.sort((a, b) => b.updatedAt - a.updatedAt), skipped };
}

/** listBoards 的异步同构(listBoardsExAsync 的 items 投影)。 */
export async function listBoardsAsync(root: string, sessionId: string): Promise<{ taskId: string; title: string; status: string; updatedAt: number; nodeCount: number }[]> {
  return (await listBoardsExAsync(root, sessionId)).items;
}

/** saveBoard 的异步同构:校验门走共用 validateBoardInput(单一出处,防两份逻辑漂移);
 *  仅落盘段改 fsp.mkdir+writeFile(tmp)+rename(原子写),成功后 boardMemIndex.set 同款。 */
export async function saveBoardAsync(root: string, input: unknown, opts: SaveBoardOpts = {}): Promise<{ ok: true; path: string; doc: BoardDoc; corrections?: string[] } | { ok: false; reason: string }> {
 // 落盘前先读盘上旧板,用于保留「非本次新提交证据」的原指纹(直读文件,不走 loadBoardAsync
  // 的存在性等待——首次落板不该在写路径上多等 200ms)。
  const loose = input as { sessionId?: unknown; taskId?: unknown } | null;
  const prevDoc = typeof loose?.sessionId === "string" && typeof loose?.taskId === "string"
    ? await readPrevBoardAsync(root, loose.sessionId, loose.taskId) : null;
  const v = validateBoardInput(input, { ...opts, fingerprintRoot: root, prevDoc });
  if (!v.ok) return v;
  const { doc, corrections } = v;
  const p = boardPath(root, doc.sessionId, doc.taskId);
  try {
    await fsp.mkdir(boardDir(root, doc.sessionId), { recursive: true });
    const tmp = p + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 1));
    await fsp.rename(tmp, p);
  } catch (err) {
    return { ok: false, reason: "白板落盘失败: " + String(err).slice(0, 120) };
  }
  boardMemIndex.set(p, Date.now());
  return { ok: true, path: p, doc, ...(corrections.length > 0 ? { corrections } : {}) };
}

/** backfillActualFiles 的异步同构:loadBoardAsync + saveBoardAsync(不带 opts,同现状)。 */
export async function backfillActualFilesAsync(root: string, sessionId: string, taskId: string, files: string[]): Promise<boolean> {
  const doc = await loadBoardAsync(root, sessionId, taskId);
  if (!doc) return false;
  doc.actual_files = files.slice(0, 60);
  if (doc.status !== "done") doc.status = "done";
  return (await saveBoardAsync(root, doc)).ok;
}

/** loadBoardArchive 的异步同构(容忍损坏/缺文件 fail-soft,留痕同款)。 */
export async function loadBoardArchiveAsync(root: string): Promise<BoardArchiveEntry[]> {
  try {
    const p = boardArchivePath(root);
    try {
      await fsp.stat(p);
    } catch {
      return [];
    }
    const parsed = JSON.parse(await fsp.readFile(p, "utf-8")) as { items?: BoardArchiveEntry[] };
    return Array.isArray(parsed.items) ? parsed.items.filter((it) => it && typeof it.sessionId === "string" && typeof it.taskId === "string") : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[board-store] 沉淀索引读失败(非缺文件):", String(err).slice(0, 120));
    return [];
  }
}

/** boardArchiveFor 的异步同构(按项目过滤)。 */
export async function boardArchiveForAsync(root: string, projectId: string): Promise<BoardArchiveEntry[]> {
  return (await loadBoardArchiveAsync(root)).filter((it) => it.projectId === projectId);
}

/** archiveBoard 的异步同构:upsert 同键幂等 + ≤500 条淘汰 + fsp 原子写,错误留痕同款。 */
export async function archiveBoardAsync(root: string, doc: BoardDoc, projectId: string): Promise<boolean> {
  if (doc.status !== "done") return false;
  const files = [...new Set(doc.nodes.map((n) => n.symbolRef?.file).filter((f): f is string => !!f))].slice(0, 60);
  const entry: BoardArchiveEntry = {
    sessionId: doc.sessionId, taskId: doc.taskId, projectId,
    title: doc.title, status: doc.status, updatedAt: doc.updatedAt,
    nodeCount: doc.nodes.length, files, archivedAt: Date.now(),
  };
  const items = (await loadBoardArchiveAsync(root)).filter((it) => !(it.sessionId === entry.sessionId && it.taskId === entry.taskId));
  items.push(entry);
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  const bounded = items.length > 500 ? items.slice(0, 500) : items;
  try {
    await fsp.mkdir(join(root, ".genie"), { recursive: true });
    const p = boardArchivePath(root);
    const tmp = p + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, items: bounded }, null, 1));
    await fsp.rename(tmp, p);
    return true;
  } catch (err) {
    console.error("[board-store] 沉淀索引写失败:", String(err).slice(0, 120));
    return false;
  }
}

/** loadBoardFast 的异步同构:不做 drvfs 忙等、靠 boardMemIndex(同步版同款轻量语义),
 *  仅把 readFileSync 换 await fsp.readFile。 */
async function loadBoardFastAsync(root: string, sessionId: string, taskId: string): Promise<BoardDoc | null> {
  const p = boardPath(root, sessionId, taskId);
  if (!boardMemIndex.has(p)) {
    try {
      await fsp.stat(p);
    } catch {
      return null;
    }
  }
  try {
    const parsed = BoardDocZ.safeParse(JSON.parse(await fsp.readFile(p, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("[board-store] 沉淀判定读板失败(非缺文件):", p, String(err).slice(0, 120));
    return null;
  }
}

/** archiveDoneBoard 的异步同构(板存在且 status=done 才沉淀;幂等 upsert)。 */
export async function archiveDoneBoardAsync(root: string, sessionId: string, taskId: string, projectId: string): Promise<boolean> {
  const doc = await loadBoardFastAsync(root, sessionId, taskId);
  if (!doc || doc.status !== "done") return false;
  return archiveBoardAsync(root, doc, projectId);
}

/** saveOverlay 的异步同构:PNG 8 字节签名校验 + 4_200_000 上限 + overlayMemIndex 全部保留。 */
export async function saveOverlayAsync(root: string, sessionId: string, taskId: string, dataB64: string): Promise<boolean> {
  try {
    const buf = Buffer.from(dataB64, "base64");
    if (buf.length < 8 || buf.length > 4_200_000) return false;
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (PNG_SIG.some((b, i) => buf[i] !== b)) return false;
    await fsp.mkdir(boardDir(root, sessionId), { recursive: true });
    await fsp.writeFile(overlayPath(root, sessionId, taskId), buf);
    overlayMemIndex.set(overlayPath(root, sessionId, taskId), { b64: dataB64, at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

/** loadOverlay 的异步同构:盘读优先,drvfs 窗内存兜底(>10min 过期清理逻辑原样)。 */
export async function loadOverlayAsync(root: string, sessionId: string, taskId: string): Promise<string | null> {
  const p = overlayPath(root, sessionId, taskId);
  try {
    const buf = await fsp.readFile(p);
    return buf.toString("base64");
  } catch { /* 缺文件/读异常走内存兜底 */ }
  const mem = overlayMemIndex.get(p);
  if (mem) {
    if (Date.now() - mem.at > 10 * 60_000) { overlayMemIndex.delete(p); return null; }
    return mem.b64;
  }
  return null;
}

/** deleteOverlay 的异步同构(fsp.rm {force:true} 等价 rmSync 条件删除;失败容忍)。
 *  与同步版的一处刻意差异:同步版 deleteOverlay 不清 overlayMemIndex,删除后 10min 内 load 仍回
 *  内存副本(盘上已无文件的「影子读」);异步版删除即清索引,load 才会如语义返回 null。 */
export async function deleteOverlayAsync(root: string, sessionId: string, taskId: string): Promise<void> {
  const p = overlayPath(root, sessionId, taskId);
  try {
    await fsp.rm(p, { force: true });
  } catch {
    // 删除失败容忍(批注不致命)
  }
  overlayMemIndex.delete(p);
}

/** resolveBoardLinks 的异步同构:路径围栏/4MB 上限/缓存语义不变,fs 调用换 fsp。 */
export async function resolveBoardLinksAsync(
  root: string,
  doc: BoardDoc,
  indexHas: (name: string) => boolean | null): Promise<BoardLinkState[]> {
  const links: BoardLinkState[] = [];
  const fileCache = new Map<string, string | null>();
  for (const n of doc.nodes) {
    const ref = n.symbolRef;
    if (!ref) continue;
    const resolveRoot = doc.root ?? root;
    let text: string | null = null;
    if (ref.file) {
      if (!fileCache.has(ref.file)) {
        let t: string | null = null;
        try {
          // 路径围栏(同同步版):拒绝绝对路径与 .. 逃逸,只读项目根内文件
          if (!ref.file.startsWith("/") && !ref.file.split("/").includes("..")) {
            const p = join(resolveRoot, ref.file);
            const st = await fsp.stat(p);
            if (st.isFile() && st.size < 4_000_000) t = await fsp.readFile(p, "utf-8");
          }
        } catch {
          t = null;
        }
        fileCache.set(ref.file, t);
      }
      text = fileCache.get(ref.file) ?? null;
    }
    const r = resolveLinkState(text, ref, indexHas(ref.name));
    links.push({
      nodeId: n.id,
      state: r.state,
      ...(ref.file ? { file: ref.file } : {}),
      ...(r.line !== undefined ? { line: r.line } : {}),
      ...(r.state === "broken" ? { note: "符号在当前代码中未找到(已删除/改名?)" } : r.state === "moved" && r.line !== undefined ? { note: `行漂移:${ref.line ?? "?"} → ${r.line}` } : {}),
    });
  }
  return links;
}

/** resolveTargetPaths 的异步同构:outside/missing 判定与 `#` 锚口径不变,fs 换 fsp。 */
export async function resolveTargetPathsAsync(
  root: string,
  doc: BoardDoc): Promise<Array<{ nodeId: string; target: string; state: "missing" | "outside" }>> {
  const out: Array<{ nodeId: string; target: string; state: "missing" | "outside" }> = [];
  const resolveRoot = doc.root ?? root;
  for (const n of doc.nodes) {
    const targets = (n as { targets?: unknown }).targets;
    if (!Array.isArray(targets) || targets.length === 0) continue;
    for (const raw of targets) {
      const full = String(raw ?? "").trim();
      if (!full) continue;
      const p = full.split("#")[0]!.trim();
      if (!p) continue;
      let state: "missing" | "outside" | null = null;
      try {
        if (p.startsWith("/") || p.split("/").includes("..")) state = "outside";
        else {
          const abs = join(resolveRoot, p);
          const st = await fsp.stat(abs).catch(() => null);
          if (!st || !st.isFile()) state = "missing";
        }
      } catch {
        state = "missing"; // 读盘异常(权限/符号链断裂)算 missing,不抛
      }
      if (state) out.push({ nodeId: n.id, target: p, state });
    }
  }
  return out;
}
