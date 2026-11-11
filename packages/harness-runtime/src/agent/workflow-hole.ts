/**
 * 工作流留白与填充(Workflow Hole/Fill):脚本写到一半才发现「下一步取决于前面的发现」时,
 * 允许把这一步留成 hole 停驻,等发现落地后再只补函数体、拼回原脚本继续跑。
 * 为什么需要一条独立机制:
 * - 提前猜下一步会把猜测写进脚本,猜错了整条脚本要重写;hole 让脚本在未知处「停驻」而不是「假装知道」。
 * - 停驻点不写 node row(不产生执行记录):没发生过的事不能出现在执行史里,否则回放会看见一个假的成功节点。
 *   HoleState 里刻意没有任何 node row / 执行记录字段,状态只有 script / sites / memory / stoppedAt。
 * - 补丁只提交函数体语句,不提交整脚本:调用方改一处不该有机会顺手改别处(splice 语义,而不是 replace source)。
 * - siteId 只由稳定身份 (name, line) 派生、不掺整份源码:链式生长或填掉别的留白都会改写 source,
 *   掺进去会让旧 site id 全部漂移(旧留白再也填不上、记忆键也永远不命中)。
 * - 拼接后必须重编译、并按存储 site 的 (name, line) 在源里复核:找不到才是真漂移(脚本被别的写入改过),
 *   此时静默拼接会把补丁塞进错误位置,所以宁可拒绝 splice、让该 site 保持 waiting。
 * - 同一 site 记忆命中可直接复用上次的函数体(跳过模型调用):重复出现的同类留白不必再花钱问一次。
 * - 脚本尾部还能链式长出新的 hole:发现会把「下一步」推到更后面,脚本要能一直往后再留白。
 * 纯逻辑:零 IO,不读文件/网络/环境。只用 node:crypto 的 sha256(稳定 site id 与脚本 hash)。
 * 时间一律 epoch ms 数字;写时间的函数都可注入 at(缺省 Date.now())。
 * 所有函数不抛异常——非法输入返回稳定码,编译失败返回 reason,状态对象不被静默改写。
 */
import { createHash } from "node:crypto";

/** hole 机制稳定码:每个码对应一个可判定的结局(不加盖异常)。 */
export const HOLE_CODES = [
  "HOLE_INVALID",
  "HOLE_SCANNED",
  "HOLE_REACHED",
  "HOLE_FILLED",
  "HOLE_SITE_DRIFT",
  "HOLE_INVALID_BODY",
  "HOLE_COMPILE_FAILED",
  "HOLE_MEMORY_HIT",
  "HOLE_CHAINED",
] as const;

export type HoleCode = (typeof HOLE_CODES)[number];

/** 可留白的工作流脚本:source 是唯一事实,hash 是它的短指纹(12 位)。 */
export interface WorkflowScript {
  id: string;
  source: string;
  hash: string;
}

/** 一个留白点:siteId 只由稳定身份 (name, line) 派生(不含整份源码),status 只有 waiting/filled 两态。 */
export interface HoleSite {
  siteId: string;
  name: string;
  prompt: string;
  line: number;
  status: "waiting" | "filled";
  bodyHash?: string;
}

/** 留白工作流状态(刻意不含任何执行记录/node row 字段:停驻不等于执行过)。 */
export interface HoleState {
  script: WorkflowScript;
  sites: Record<string, HoleSite>;
  memory: Record<string, { body: string; at: number }>;
  stoppedAt?: string;
}

/** 扫描结果。 */
export interface ScanResult {
  ok: boolean;
  codes: string[];
  state: HoleState;
  count?: number;
}

/** reach 成功时随事件带出的停驻信息(交给上层发 hole-reached 事件)。 */
export interface HoleReachedEvent {
  type: "hole-reached";
  siteId: string;
  draftPath: string;
  line: number;
}

/** reach 结果。 */
export interface ReachResult {
  ok: boolean;
  codes: string[];
  state: HoleState;
  event?: HoleReachedEvent;
}

/** fill 结果(失败时 state 保持原样,site 仍 waiting;编译失败附 reason)。 */
export interface FillResult {
  ok: boolean;
  codes: string[];
  state: HoleState;
  reason?: string;
  resumed?: boolean;
  site?: HoleSite;
}

/** chain 结果。 */
export interface ChainResult {
  ok: boolean;
  codes: string[];
  state: HoleState;
  site?: HoleSite;
}

/** memoryHit 结果:命中即调用方可跳过模型调用。 */
export interface MemoryHitResult {
  ok: boolean;
  hit: boolean;
  codes: string[];
  body?: string;
  at?: number;
}

/** 粗检编译结论(括号/引号配对 + 非空)。 */
export interface RoughCompileResult {
  ok: boolean;
  reason?: string;
}

const SCRIPT_HASH_LEN = 12;
const SITE_HASH_LEN = 8;
const BODY_HASH_LEN = 8;

/** sha256 十六进制前 n 位(唯一哈希用法,不引别的依赖)。 */
function sha256Hex(text: string, len: number): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, len);
}

/** 脚本 hash 规则:sha256(source) 前 12 位。 */
function scriptHashOf(source: string): string {
  return sha256Hex(source, SCRIPT_HASH_LEN);
}

/**
 * site id 规则:只由稳定身份 (name, line) 派生 —— sha256(`${name}@${line}`) 前 8 位。
 * 刻意不掺整份 source:chain 追加一行 / 填掉别的留白都会改写 source,掺进去会让旧 site id 全部漂移。
 * 同一 (name, line) 出现多次时(同一行写两个同名 hole 的极端情形)追加 `#k`:k 按源码出现序从 0 起,
 * 同样的 source 必然得到同样的 id。
 */
function siteIdOf(name: string, line: number, occurrence?: number): string {
  const base = sha256Hex(`${name}@${line}`, SITE_HASH_LEN);
  return occurrence === undefined ? base : `${base}#${occurrence}`;
}

/** 稳定身份键:`${name}@${line}`(去重/计数用)。 */
function siteKeyOf(name: string, line: number): string {
  return `${name}@${line}`;
}

/** 从 siteId 里解出「同 (name, line) 第 k 次出现」的后缀;无后缀 = 该身份唯一出现。 */
function occurrenceOf(siteId: string): number | undefined {
  const m = /#(\d+)$/.exec(siteId);
  return m === null ? undefined : Number(m[1]);
}

/** 双引号/单引号混排的 hole 调用;任意空白都认。 */
const HOLE_CALL_RE = /hole\s*\(\s*(["'])([^"']*)\1\s*,\s*(["'])([^"']*)\3\s*\)/g;

/** 一次扫描命中的 hole 调用(src 原文 + 位置)。 */
interface RawHit {
  name: string;
  prompt: string;
  line: number;
  start: number;
  end: number;
  text: string;
}

/** 逐行找 hole 调用(行号 1-based;同一行多个 hole 各自成 site)。 */
function findHoleCalls(source: string): RawHit[] {
  const hits: RawHit[] = [];
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? "";
    HOLE_CALL_RE.lastIndex = 0;
    let m = HOLE_CALL_RE.exec(text);
    while (m !== null) {
      hits.push({
        name: m[2] ?? "",
        prompt: m[4] ?? "",
        line: i + 1,
        start: offset + m.index,
        end: offset + m.index + m[0].length,
        text: m[0],
      });
      m = HOLE_CALL_RE.exec(text);
    }
    offset += text.length + 1;
  }
  return hits;
}

/** 按源码出现序给每个 hit 分配稳定 siteId(同一 (name,line) 多次出现时追加 #k)。 */
function assignSiteIds(hits: RawHit[]): Map<RawHit, string> {
  const totals = new Map<string, number>();
  for (const hit of hits) {
    const key = siteKeyOf(hit.name, hit.line);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const ids = new Map<RawHit, string>();
  for (const hit of hits) {
    const key = siteKeyOf(hit.name, hit.line);
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    const total = totals.get(key) ?? 1;
    ids.set(hit, siteIdOf(hit.name, hit.line, total > 1 ? k : undefined));
  }
  return ids;
}

/**
 * 按存储 site 的稳定身份 (name, line) 在源码里定位它的 hole 调用。
 * 不再用「重算整份 source 哈希」判定:source 被 chain 或别的 fill 改写后,旧 site 依然能对上。
 * 同一身份有多个候选时用 siteId 的 `#k` 选第 k 个;无后缀却多候选 = 身份歧义,按漂移处理(fail-closed)。
 */
function locateHit(source: string, site: HoleSite, siteId: string): RawHit | undefined {
  const hits = findHoleCalls(source).filter((h) => h.name === site.name && h.line === site.line);
  if (hits.length === 0) return undefined;
  const k = occurrenceOf(siteId);
  if (k !== undefined) {
 // 同身份靠前的出现被填掉后,剩余 hit 的序号会前移:k 越界但只剩一个时它必然就是该 site。
    return k < hits.length ? hits[k] : hits.length === 1 ? hits[0] : undefined;
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** 源里这个稳定身份 (name,line) 是否仍有 hole 调用(拼接后「没被误删」的存在性复核)。 */
function hasHoleAt(source: string, name: string, line: number): boolean {
  return findHoleCalls(source).some((h) => h.name === name && h.line === line);
}

/** 把扫描结果整理成 sites 表(已 filled 的旧 site 由调用方另行保留)。 */
function sitesFromSource(source: string): Record<string, HoleSite> {
  const sites: Record<string, HoleSite> = {};
  const hits = findHoleCalls(source);
  const ids = assignSiteIds(hits);
  for (const hit of hits) {
    const siteId = ids.get(hit)!;
    sites[siteId] = { siteId, name: hit.name, prompt: hit.prompt, line: hit.line, status: "waiting" };
  }
  return sites;
}

/**
 * 扫描脚本里的 hole 调用:建立 state(含 sites/memory),不做任何 IO。
 * 不含 hole 也 ok,codes 带 HOLE_SCANNED 并给出 count=0(「扫过且没有」是可判定结论,不是失败)。
 */
export function scanHoles(source: string, opts?: { id?: string }): ScanResult {
  const text = typeof source === "string" ? source : "";
  const hash = scriptHashOf(text);
  const id = opts?.id !== undefined && opts.id !== "" ? opts.id : `wf-${hash.slice(0, 6)}`;
  const sites = sitesFromSource(text);
  const state: HoleState = { script: { id, source: text, hash }, sites, memory: {} };
  return { ok: true, codes: ["HOLE_SCANNED"], state, count: Object.keys(sites).length };
}

/**
 * 到达一个 hole 点:该分支停驻(stoppedAt=siteId),发 hole-reached 事件。
 * 不写 node row —— 停驻是「还没跑」,不能产生执行记录。
 * site 不存在 = site 漂移(脚本已被别的写入改过);已 filled 再来 reach 是非法流转。
 */
export function reachHole(state: HoleState, siteId: string, opts?: { root?: string }): ReachResult {
  const site = state.sites[siteId];
  if (site === undefined) return { ok: false, codes: ["HOLE_SITE_DRIFT"], state };
  if (site.status === "filled") return { ok: false, codes: ["HOLE_INVALID"], state };
  const next: HoleState = { ...state, stoppedAt: siteId };
  return {
    ok: true,
    codes: ["HOLE_REACHED"],
    state: next,
    event: { type: "hole-reached", siteId, draftPath: draftPath(next, opts?.root), line: site.line },
  };
}

/** 剥掉字符串字面量,只留结构字符(用于顶层 => 与括号配对判断)。 */
function stripStrings(source: string): { ok: boolean; text: string; reason?: string } {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        if (c === "\n" && quote !== "`") break;
        i += 1;
      }
      if (!closed) return { ok: false, text: out, reason: `未闭合的引号 ${quote}` };
      out += quote === "`" ? "``" : `${quote}${quote}`;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { ok: true, text: out };
}

/** 顶层是否出现箭头(函数值必须由脚本作者写进脚本,不能靠补丁偷渡)。 */
function hasTopLevelArrow(structure: string): boolean {
  let depth = 0;
  for (let i = 0; i < structure.length - 1; i += 1) {
    const ch = structure[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "=" && structure[i + 1] === "=") {
      i += 1;
    } else if (ch === "=" && structure[i + 1] === ">") {
      if (depth === 0) return true;
      i += 1;
    }
  }
  return false;
}

/** 粗检编译:非空 + 圆/方/花括号配对 + 引号（含反引号）闭合。不追求真编译,只拦明显坏体。 */
export function roughCompileCheck(source: string): RoughCompileResult {
  const text = typeof source === "string" ? source : "";
  if (text.trim() === "") return { ok: false, reason: "空源" };
  const stripped = stripStrings(text);
  if (!stripped.ok) return { ok: false, reason: stripped.reason };
  const structure = stripped.text;
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const ch of structure) {
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const open = stack.pop();
      if (open !== pairs[ch]) return { ok: false, reason: `括号不配对:${ch}` };
    }
  }
  if (stack.length > 0) return { ok: false, reason: `括号未闭合:${stack.join("")}` };
  return { ok: true };
}

/**
 * 决定 splice 的替换区间。
 * hole 作为独立语句(`hole("a","b");`)时整行替换,函数体成为该位置新的语句块;
 * hole 嵌在表达式里(`const x = hole(...)`)时只替换调用本身(调用方自己保留了左侧绑定)。
 */
function spliceRange(source: string, hit: RawHit): { start: number; end: number } {
  const lineStart = source.lastIndexOf("\n", hit.start - 1) + 1;
  const newlineAt = source.indexOf("\n", hit.end);
  const lineEnd = newlineAt === -1 ? source.length : newlineAt;
  // `await hole(...)` 的 await 属于 hole 语句本身而不是调用方的绑定:不一起吃掉就会拼出
  // `await const x = ...` 这种非法源码(粗检只验括号,拦不住),所以 splice 起点前移到 await。
  let start = hit.start;
  const rawPrefix = source.slice(lineStart, hit.start);
  const awaitMatch = /(?:^|[^\w$])await\s*$/.exec(rawPrefix);
  if (awaitMatch) start = lineStart + awaitMatch.index + (awaitMatch[0].startsWith("await") ? 0 : 1);
  const prefix = source.slice(lineStart, start);
  const suffix = source.slice(hit.end, lineEnd);
  if (prefix.trim() === "" && (suffix.trim() === "" || suffix.trim() === ";")) {
    return { start: lineStart, end: lineEnd };
  }
  return { start, end: hit.end };
}

/** 函数体校验(清洗后非空、不含 hole 调用、不含 function 与顶层 =>)。 */
function checkBody(body: string): { ok: boolean; body: string; reason?: string } {
  const text = typeof body === "string" ? body : "";
  const oneshot = text.trim();
  if (oneshot === "") return { ok: false, body: oneshot, reason: "空函数体" };
  if (/\bhole\s*\(/.test(oneshot)) return { ok: false, body: oneshot, reason: "函数体内不允许再出现 hole 调用" };
  if (/\bfunction\b/.test(oneshot)) return { ok: false, body: oneshot, reason: "函数体不允许声明 function" };
  const stripped = stripStrings(oneshot);
  if (stripped.ok && hasTopLevelArrow(stripped.text)) {
    return { ok: false, body: oneshot, reason: "函数体不允许顶层 =>(只提交语句)" };
  }
  return { ok: true, body: oneshot };
}

/**
 * 把一个 hole 调用的整段替换成函数体,然后重编译、复核其它留白仍在、更新 hash、从停点恢复。
 * 判定顺序刻意为「未知 site → 已 filled → 按 (name,line) 定位 → 函数体 → 编译」:
 * - siteId 不在 sites 表 → HOLE_SITE_DRIFT(codes 只含它),连坏体也不抢判;
 * - 已 filled 的 site 再来 fill → HOLE_INVALID(已填,不允许二次覆盖);
 * - 按存储 site 的 (name, line) 在源里找不到调用 → HOLE_SITE_DRIFT(脚本被别的写入改过),拒绝 splice;
 * - 函数体本身不合法 → HOLE_INVALID_BODY(与站点状态无关);
 * - 拼接后粗检编译失败 → HOLE_COMPILE_FAILED + reason,site 保持 waiting(不落任何半成品);
 * - 拼接后其它 waiting site 反而定位不到 = 本次 splice 误删了留白 → HOLE_SITE_DRIFT,整次拒绝。
 * 任一失败都不改 state(纯函数:失败返回原 state,调用方据此不落盘)。
 */
export function fillHole(
  state: HoleState,
  input: { siteId: string; body: string; at?: number; root?: string },
): FillResult {
  const siteId = typeof input?.siteId === "string" ? input.siteId : "";
  const known = state.sites[siteId];
  // ① 未知 site = 没有这个留白(与 body 好坏无关)。
  if (known === undefined) return { ok: false, codes: ["HOLE_SITE_DRIFT"], state };
  // ② 已填充,不允许二次覆盖。
  if (known.status === "filled") return { ok: false, codes: ["HOLE_INVALID"], state, reason: "site 已填充" };

  // ③ 按稳定身份 (name, line) 重定位,不重算 source 哈希:chain 追加或别的 fill 都不该让旧 id 失效。
  const source = state.script.source;
  const hit = locateHit(source, known, siteId);
  if (hit === undefined) return { ok: false, codes: ["HOLE_SITE_DRIFT"], state };

  // ④ 再校验函数体(清洗后非空、不含 hole 调用、不含 function 与顶层 =>)。
  const checked = checkBody(input?.body ?? "");
  if (!checked.ok) return { ok: false, codes: ["HOLE_INVALID_BODY"], state, reason: checked.reason };

  const range = spliceRange(source, hit);
  const spliced = `${source.slice(0, range.start)}${checked.body}${source.slice(range.end)}`;
  const compiled = roughCompileCheck(spliced);
  if (!compiled.ok) {
    return { ok: false, codes: ["HOLE_COMPILE_FAILED"], state, reason: compiled.reason || "粗检编译失败" };
  }

  // ⑤ 拼接后复核:其余 waiting site 仍能在新源里定位(这次 splice 没把它们连带删掉)。
  for (const other of Object.values(state.sites)) {
    if (other.siteId === siteId || other.status !== "waiting") continue;
    if (!hasHoleAt(spliced, other.name, other.line)) {
      return { ok: false, codes: ["HOLE_SITE_DRIFT"], state, reason: `拼接会删除其他留白 ${other.siteId}` };
    }
  }

  const at = typeof input?.at === "number" && Number.isFinite(input.at) ? input.at : Date.now();
  const site: HoleSite = {
    siteId,
    name: hit.name,
    prompt: hit.prompt,
    line: hit.line,
    status: "filled",
    bodyHash: sha256Hex(checked.body, BODY_HASH_LEN),
  };
  const memory = { ...state.memory, [siteId]: { body: checked.body, at } };
  const next: HoleState = {
    script: { ...state.script, source: spliced, hash: scriptHashOf(spliced) },
    sites: { ...state.sites, [siteId]: site },
    memory,
  };
  return { ok: true, codes: ["HOLE_FILLED"], state: next, resumed: true, site };
}

/**
 * 在脚本末尾追加一个新的 hole(链式留白):siteId 由新 hole 的稳定身份 (name, line) 派生。
 * 既有 site 一律原样保留(按 (name,line) 匹配复用旧 id 与旧状态),stoppedAt 也不因链式生长而改变:
 * 追加一行不改变已有留白的位置,旧 id 就不该漂移。
 * 同 name 的尾部 hole 未填时也允许新增(不做去重)——不同位置的留白是不同的事实。
 */
export function chainTail(state: HoleState, input: { name: string; prompt: string; at?: number }): ChainResult {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  if (name === "") return { ok: false, codes: ["HOLE_INVALID"], state };

  const base = state.script.source.replace(/\s*$/, "");
  const call = `hole("${name}","${prompt.replace(/"/g, '\\"')}")`;
  const spliced = `${base}\n${call}\n`;
  const hits = findHoleCalls(spliced);
  const ids = assignSiteIds(hits);
  const tail = hits.filter((h) => h.name === name).sort((a, b) => b.line - a.line)[0];
  if (tail === undefined) return { ok: false, codes: ["HOLE_INVALID"], state };
  let siteId = ids.get(tail)!;
  // 保留既有 siteId:同 (name,line) 的旧 site 优先复用它的 id(以及已有状态),新 hole 才分配新 id。
  const prior = Object.values(state.sites).find((s) => s.name === tail.name && s.line === tail.line);
  if (prior !== undefined) siteId = prior.siteId;
  const site: HoleSite = state.sites[siteId] ?? {
    siteId,
    name: tail.name,
    prompt: tail.prompt,
    line: tail.line,
    status: "waiting",
  };
  const next: HoleState = {
    ...state,
    script: { ...state.script, source: spliced, hash: scriptHashOf(spliced) },
    sites: { ...state.sites, [siteId]: site },
    memory: state.memory,
  };
  return { ok: true, codes: ["HOLE_CHAINED"], state: next, site };
}

/** 同一 site 的记忆命中:命中即复用上次函数体,调用方可跳过模型调用(省一次生成)。 */
export function memoryHit(
  state: HoleState,
  siteId: string,
  input?: { name?: string; prompt?: string },
): MemoryHitResult {
  void input;
  const remembered = state.memory[siteId];
  if (remembered === undefined) return { ok: true, hit: false, codes: [] };
  return { ok: true, hit: true, codes: ["HOLE_MEMORY_HIT"], body: remembered.body, at: remembered.at };
}

/** 草稿路径:`<root>/drafts/<scriptId>.mjs`(始终单个 "/",root 缺省 ".")。 */
export function draftPath(state: HoleState, root = "."): string {
  const raw = typeof root === "string" && root !== "" ? root : ".";
  const base = raw === "/" ? "" : raw.replace(/\/+$/, "");
  return `${base}/drafts/${state.script.id}.mjs`;
}
