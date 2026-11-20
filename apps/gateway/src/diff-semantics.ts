/**
 * diff 语义缺陷定位(设计稿)。
 * 真源:journal 里写工具的逐字参数(edit_file old/new、write_file 全文、apply_patch 分段)
 * ——语义在采集环节曾被丢弃(collectToolTouched 只取 path),本模块把它重放成 hunk 并分类。
 * 分类优先级(首个命中即定类,设计稿 §2.2):
 * 1 missing-test(旧判据,调用方传入 fixAddedTest)
 * 2 contract:del/add 行对上函数/类型声明行且参数 token 集不同
 * 3 boundary:add 行(非搬运)命中空值/边界词法
 * 4 concurrency:新增 await/锁原语(del 无同构行)
 * 5 uncategorized:无命中;降级闸(hunks>20 或各类命中≤1 行)保持 uncategorized(诚实)
 * 依赖纪律:零 IO、零 LLM、不 throw、不 import atlas-harvest(rework-chain→diff-semantics 纯叶子,
 * 保持 rework-chain→atlas-harvest 单向)。凡不能确定性判的一律退 uncategorized。
 */

/** 一次写调用的原始文本对(edit_file:old/new;write_file:old="" 全新增)。 */
export interface WriteHunk {
  tool: "edit_file" | "write_file" | "apply_patch";
  path: string;
  oldText: string;
  newText: string;
  seq?: number;
}

/** 归一化后的行级 hunk(公共前后缀已剥)。 */
export interface NormalizedHunk {
  tool: WriteHunk["tool"];
  path: string;
  del: string[];
  add: string[];
  seq?: number;
}

export interface DiffStats {
  hunks: number;
  addedLines: number;
  deletedLines: number;
  paths: string[];
}

export type DiffDefectClass = "boundary" | "contract" | "concurrency" | "missing-test" | "uncategorized";

/** 命中证据(每个新分类必须带,否则不落类——设计稿 §2.3)。 */
export interface DefectEvidence {
  cls: DiffDefectClass;
  path: string;
  hunkIndex: number;
  addLine?: number;
  sig: string;
}

/**
 * 剥掉逐字对的最长公共前后缀,**再对齐到整行边界**,按行拆 del/add。
 * 行对齐的理由(单测注意):字符级剥完会产生残行(`export function submit(task:` 被截成
 * `, opts?: SubmitOpts`),签名/守卫的正则分类器需要完整行;扩张只吞公共前缀/后缀里的字符,
 * 不改变「哪部分变了」的语义。
 */
function normalizeHunk(hunk: WriteHunk, index: number): NormalizedHunk {
  const oldText = String(hunk.oldText ?? "");
  const newText = String(hunk.newText ?? "");
 // 公共前缀(字符级)
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
 // 公共后缀(不与前缀重叠)
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }
 // 行边界对齐:start 回退到上一个换行(吞的是公共前缀);end 推进到下一个换行(吞的是公共后缀)
  while (start > 0 && oldText[start - 1] !== "\n") start--;
  while (endOld < oldText.length && oldText[endOld] !== "\n") endOld++;
  while (endNew < newText.length && newText[endNew] !== "\n") endNew++;
  const del = oldText.slice(start, endOld).split("\n").filter((l) => l.trim() !== "");
  const add = newText.slice(start, endNew).split("\n").filter((l) => l.trim() !== "");
  return { tool: hunk.tool, path: hunk.path, del, add, seq: hunk.seq ?? index };
}

export function buildDiffSet(hunks: readonly WriteHunk[]): { hunks: NormalizedHunk[]; stats: DiffStats } {
  const normalized = hunks.map(normalizeHunk);
  const paths = [...new Set(normalized.map((h) => h.path))];
  const stats: DiffStats = {
    hunks: normalized.length,
    addedLines: normalized.reduce((sum, h) => sum + h.add.length, 0),
    deletedLines: normalized.reduce((sum, h) => sum + h.del.length, 0),
    paths,
  };
  return { hunks: normalized, stats };
}

/* ── 2 contract:声明行配对且参数 token 集不同 ── */
const DECL_RES: readonly RegExp[] = [
  /(export\s+)?(async\s+)?function\s+\w+\s*\(/,
  /^\s*(export\s+)?(const|let)\s+\w+\s*=\s*(async\s*)?\(/,
  /interface\s+\w+\s*(\{|\n)/,
  /type\s+\w+\s*(=|<)/,
  /^\s*(export\s+)?(abstract\s+)?(public|private|protected|static|readonly|async|\s)*\w+\s*\([^()]*\)\s*:\s*[\w<>\[\]|]+/,
  /^\s*export\s+\{/, // re-export/barrel 契约变化
];

/**
 * contract 升级(精确率 50% 瓶颈:跨行签名/泛型):
 * ①**签名跨行拼接**——把 del/add 各自的行按括号配平拼成完整签名块再取参;
 * ②**泛型参数**——`<...>` 也进 token 集(设计稿 34 遗留:泛型变化=契约变化);
 * ③**类方法签名**——public/private/protected 修饰的方法声明行。
 */
function joinSignatureBlock(lines: readonly string[]): string {
 // 从声明行起按括号配平拼接(最多吞 6 行,防大类整块)
  const out: string[] = [];
  let depth = 0;
  let started = false;
  for (const line of lines) {
    if (!started && !DECL_RES.some((re) => re.test(line))) continue;
    started = true;
    out.push(line);
    depth += (line.match(/[(<]/g) ?? []).length - (line.match(/[)>]/g) ?? []).length;
    if (depth <= 0 && out.length > 0) break;
    if (out.length >= 6) break;
  }
  return out.join(" ");
}

function paramTokens(text: string): string[] {
 // 拼接后的签名块:取第一个平衡的 (...) 参数列表 + 泛型 <...> 也作 token 源
  const tokens: string[] = [];
  const paren = balancedExtract(text, "(", ")");
  if (paren !== undefined) {
    for (const t of paren.split(",")) {
      const norm = t.trim().replace(/\?$/, "").replace(/\s+/g, " ");
      if (norm !== "") tokens.push(norm);
    }
  }
  const generic = balancedExtract(text, "<", ">");
  if (generic !== undefined) {
    for (const t of generic.split(/[,\s]+/)) {
      if (t.trim() !== "") tokens.push(`<${t.trim()}>`);
    }
  }
  if (tokens.length === 0) {
 // type/interface:比较赋值/大括号前的主体
    const body = text.replace(/^\s*(export\s+)?(type|interface)\s+\w+/, "").replace(/=.*$/, "").replace(/\{.*$/, "");
    for (const t of body.split(/[\s<>,|]+/)) if (t !== "") tokens.push(t);
  }
  return tokens;
}

/** 取第一个配平的括号内内容(text 含多个时取最先出现的声明处)。 */
function balancedExtract(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return undefined; // 未配平(截断)——诚实返回 undefined
}

/** 参数续行(声明头在公共前缀里被剥掉,hunk 只剩 ` name: Type` 行)——契约变化的跨行残影。 */
const PARAM_LINE_RE = /^\s*\w+\s*\??\s*:\s*[\w<>\[\].|"']+\s*,?\s*$/;
const RETURN_LINE_RE = /^\s*\)\s*:\s*[\w<>\[\]|]+/;

function contractHit(hunk: NormalizedHunk): { sig: string; addLine: number } | undefined {
 // ①参数续行模式:del/add 全是参数行或收尾行,且 add 侧有 del 没有的新参数 → 契约变化
  const allParamLike = [...hunk.del, ...hunk.add].every((l) => PARAM_LINE_RE.test(l) || RETURN_LINE_RE.test(l));
  if (allParamLike && hunk.del.length > 0 && hunk.add.length > 0) {
    const delNames = new Set(hunk.del.map((l) => l.trim().split(":")[0]!.trim()));
    const newParam = hunk.add.findIndex((l) => !delNames.has(l.trim().split(":")[0]!.trim()));
    if (newParam >= 0) return { sig: "contract:param-continuation", addLine: newParam + 1 };
  }
  for (const re of DECL_RES) {
    const delDecl = hunk.del.find((l) => re.test(l));
    const addDeclIdx = hunk.add.findIndex((l) => re.test(l));
    if (delDecl === undefined || addDeclIdx < 0) continue;
 // 跨行拼接:del/add 各自从声明行起拼完整签名块
    const delBlock = joinSignatureBlock(hunk.del.slice(hunk.del.indexOf(delDecl)));
    const addBlock = joinSignatureBlock(hunk.add.slice(addDeclIdx));
    const before = paramTokens(delBlock).sort().join("\u0000");
    const after = paramTokens(addBlock).sort().join("\u0000");
    if (before !== after) {
      return { sig: `contract:${re.source.slice(0, 24)}`, addLine: addDeclIdx + 1 };
    }
  }
  return undefined;
}

/* ── 3 boundary:add 行(非搬运)命中空值/边界词法 ── */
const BOUNDARY_RES: readonly { re: RegExp; sig: string }[] = [
  { re: /\?\?=/, sig: "boundary:nullish-assign" },
  { re: /\?\?/, sig: "boundary:nullish" },
  { re: /\?\./, sig: "boundary:optional-chain" },
  { re: /[=!]==?\s*(null|undefined)/, sig: "boundary:null-check" },
  { re: /Number\.(isNaN|isFinite)/, sig: "boundary:number-guard" },
  { re: /\.length\s*[<>=!]=?/, sig: "boundary:length-guard" },
  { re: /Array\.isArray|Object\.keys\(/, sig: "boundary:shape-guard" },
];

function boundaryHit(hunk: NormalizedHunk): { sig: string; addLine: number } | undefined {
  for (let i = 0; i < hunk.add.length; i++) {
    const line = hunk.add[i]!;
 // 「补检查」要求:同 hunk 有对应 del(证明不是搬运/纯新增功能)
    const isGuard = /^\s*(if|else if|\}\s*while)\s*\(/.test(line) || BOUNDARY_RES.some((b) => b.re.test(line));
    if (!isGuard) continue;
    const moved = hunk.del.some((d) => d.trim() === line.trim());
    if (moved) continue;
    const hit = BOUNDARY_RES.find((b) => b.re.test(line));
    return { sig: hit?.sig ?? "boundary:guard-branch", addLine: i + 1 };
  }
  return undefined;
}

/* ── 4 concurrency:新增 await/锁原语 ── */
const LOCK_RE = /\b(lock|mutex|mutexRef|semaphore|withLock|acquire\s*\(|release\s*\()/i;

function concurrencyHit(hunk: NormalizedHunk): { sig: string; addLine: number } | undefined {
  for (let i = 0; i < hunk.add.length; i++) {
    const line = hunk.add[i]!;
    const isNewAwait = /\bawait\b/.test(line) && !hunk.del.some((d) => d.includes("await") && d.trim() === line.trim());
    const isLock = LOCK_RE.test(line) && !hunk.del.some((d) => LOCK_RE.test(d));
    if (isNewAwait || isLock) {
      return { sig: isLock ? "concurrency:lock" : "concurrency:new-await", addLine: i + 1 };
    }
  }
  return undefined;
}

export interface ClassifyInput {
  hunks: readonly WriteHunk[];
  editedPaths: readonly string[];
  fixAddedTest: boolean;
}

export interface ClassifyResult {
  cls: DiffDefectClass;
  evidence: DefectEvidence[];
  stats: DiffStats;
}

/**
 * 分类主体:按优先级扫 hunk;降级闸——hunks>20(大重构)或「每类命中 ≤1 行」的词法弱信号
 * 保持 uncategorized(设计稿 §2.2 第 5 档)。
 */
export function classifyDiffSemantics(input: ClassifyInput): ClassifyResult {
  const { hunks: normalized, stats } = buildDiffSet(input.hunks);
  const evidence: DefectEvidence[] = [];
  const classHits: Partial<Record<Exclude<DiffDefectClass, "uncategorized" | "missing-test">, number>> = {
    contract: 0,
    boundary: 0,
    concurrency: 0,
  };
  const record = (cls: keyof typeof classHits, hit: { sig: string; addLine: number }, hunk: NormalizedHunk, index: number) => {
    classHits[cls] = (classHits[cls] ?? 0) + hunk.add.length;
    evidence.push({ cls, path: hunk.path, hunkIndex: index, addLine: hit.addLine, sig: hit.sig });
  };
  normalized.forEach((hunk, index) => {
    const c = contractHit(hunk);
    if (c !== undefined) return record("contract", c, hunk, index);
    const b = boundaryHit(hunk);
    if (b !== undefined) return record("boundary", b, hunk, index);
    const k = concurrencyHit(hunk);
    if (k !== undefined) return record("concurrency", k, hunk, index);
  });
 // 优先级:contract > boundary > concurrency(取证据行数最多且优先级靠前的类)
  const order: Array<keyof typeof classHits> = ["contract", "boundary", "concurrency"];
  let cls: DiffDefectClass = "uncategorized";
  if (stats.hunks > 0 && stats.hunks <= 20) {
    for (const candidate of order) {
      const hitLines = classHits[candidate] ?? 0;
      if (hitLines >= 1 && !(hitLines <= 1 && (classHits.contract ?? 0) + (classHits.boundary ?? 0) + (classHits.concurrency ?? 0) > 1)) {
        cls = candidate;
        break;
      }
 // 弱信号(总命中只有 1 行)也允许——但若多类各 1 行,保持 uncategorized(降级闸)
      if (hitLines >= 1) {
        const total = (classHits.contract ?? 0) + (classHits.boundary ?? 0) + (classHits.concurrency ?? 0);
        if (total === hitLines) {
          cls = candidate;
          break;
        }
      }
    }
  }
 // 1 missing-test 最高优先(旧判据不动)
  if (input.fixAddedTest) cls = "missing-test";
  if (cls === "uncategorized") evidence.length = 0;
  else evidence.length = Math.min(evidence.length, 6);
  void input.editedPaths;
  return { cls, evidence: cls === "uncategorized" ? [] : evidence.filter((e) => e.cls === cls), stats };
}
