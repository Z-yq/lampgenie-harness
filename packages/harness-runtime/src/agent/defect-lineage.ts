/**
 * 缺陷血缘(Defect Lineage):把「一次缺陷修复」回连到产生它的交付任务 / 模块 / 决策,
 * 并回答两个当前靠人肉追问的问题:
 * - 这条缺陷到底该不该算在那次交付头上(voteEvidence / resolveConfidence)?
 * - 交付时漏掉了哪一道防线(requirement / plan-coverage / verification-coverage / ...)?
 *
 * 为什么要单独一层,而不是直接写进证据图:
 * - 归属是「多源弱证据的合并判断」,单个信号(路径交集、时间邻近、文本提及)都太弱,
 *   必须先各自成票、再按门槛折算置信度,否则「碰巧同模块」就会被当成元凶。
 * - 不可归属的缺陷(unattributed)必须显式返回空链而不是硬凑一条血缘——错的溯源比没有更贵。
 * - 漏点(missedLink)决定了下游要补哪道防线,所以分类与漏点推断共用一份证据快照,避免两处口径漂移。
 *
 * 纯逻辑:零 IO(不读文件 / 网络 / 环境 / 真实时钟)。时间一律 epoch ms 数字,
 * 任何需要"现在"的地方都可注入 opts.now(缺省 Date.now())。
 * 所有导出函数不抛异常:非法输入返回安全空值并带稳定码(DEFECT_CODES),调用方据此降级。
 */

/** 血缘 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const DEFECT_LINEAGE_VERSION = 1;

/** 缺陷类别:rework=返工,drift=偏离,refactor=重构/迁移,unrelated=与交付无关,unknown=判不了。 */
export type DefectCategory = "rework" | "drift" | "refactor" | "unrelated" | "unknown";

/** 归属置信度:high=有强证据,medium=多条中证据,low=弱证据或无证据(下游不应据此追责)。 */
export type DefectConfidence = "high" | "medium" | "low";

/** 漏点:交付阶段漏掉的那道防线。none=证据不足,不指认漏点。 */
export type MissedLink =
  | "requirement"
  | "plan-coverage"
  | "verification-coverage"
  | "knowledge-gap"
  | "tool-gap"
  | "wrong-assumption"
  | "impact-analysis"
  | "none";

/** 一行 blame:哪个提交、哪个文件、第几行,以及可选的作者与时间。 */
export interface BlameLine {
  file: string;
  line: number;
  commit: string;
  author?: string;
  at?: number;
}

/** 一条缺陷记录(已修复的 bug),category/confidence/missedLink 由本模块补齐。 */
export interface DefectRecord {
  id: string;
  fixTaskId: string;
  description: string;
  module?: string;
  files: string[];
  fixedAt: number;
  blame?: BlameLine[];
  category: DefectCategory;
  confidence: DefectConfidence;
  missedLink?: MissedLink;
  evidenceRefs?: string[];
}

/** 候选元凶:某次交付任务留下的证据快照(代码变更 / 计划 / 验证 / 是否查过影响面)。 */
export interface SourceTaskEvidence {
  taskId: string;
  sessionId?: string;
  commit?: string;
  at?: number;
  text?: string;
  module?: string;
  filesChanged: string[];
  testsChanged?: string[];
  codeSenseUsed?: boolean;
  boardEvidenceRefs?: string[];
  plan?: { nodes: { id: string; label: string; targets?: string[] }[]; p0Accepts?: { id: string; expect?: string }[] };
  verification?: { commands?: string[]; evidenceRefs?: string[] };
}

/** 一票证据:strong=单票即可定归属,medium=需要两票,weak=只能说明"碰过同一文件"。 */
export interface EvidenceVote {
  kind: "strong" | "medium" | "weak";
  note: string;
}

/** 血缘链的一环:任务 → 模块 → 缺陷 → 决策 → 缺失防线。 */
export interface LineageChainEntry {
  type: "task" | "module" | "defect" | "decision" | "missing-safeguard";
  ref: string;
  label: string;
}

/** 稳定码:调用方按码分支,不解析文案。 */
export const DEFECT_CODES = {
  INVALID: "DEFECT_INVALID",
  LINK_STRONG: "DEFECT_LINK_STRONG",
  LINK_MEDIUM: "DEFECT_LINK_MEDIUM",
  LINK_WEAK: "DEFECT_LINK_WEAK",
  UNATTRIBUTED: "DEFECT_UNATTRIBUTED",
  CATEGORY_UNKNOWN: "DEFECT_CATEGORY_UNKNOWN",
  GRAPH_PROJECTED: "DEFECT_GRAPH_PROJECTED",
  GRAPH_FAILED: "DEFECT_GRAPH_FAILED",
} as const;

export type DefectCode = (typeof DEFECT_CODES)[keyof typeof DEFECT_CODES];

// ------------------------------------------------------------------ 内部工具

const DAY_MS = 86_400_000;
/** 时间邻接窗口:14 天内的交付才算"同一次上下文"。 */
const ADJACENT_WINDOW_MS = 14 * DAY_MS;
/** 重构/迁移语义线索:出现在交付描述里说明这次改动是搬运而不是新增能力。 */
const REFACTOR_RE = /重构|迁移|统一|rename/i;
/** 错误假设线索:交付描述里承认了未验证的前提。 */
const ASSUMPTION_RE = /不需要验证|假设|默认成立/;

/** 缺失防线文案:给下游看的是"要补哪一道",所以写成祈使句。 */
const SAFEGUARDS: Record<MissedLink, string> = {
  requirement: "需求理解:交付任务必须显式记录目标模块与文件",
  "plan-coverage": "计划覆盖:交付任务必须为目标模块落节点(targets 命中)",
  "verification-coverage": "验证覆盖:交付任务必须为改动文件落可执行验收",
  "knowledge-gap": "知识缺失:交付前检索历史同类缺陷并写入证据图谱",
  "tool-gap": "工具缺失:补足检测该缺陷所需的工具能力",
  "wrong-assumption": "假设错误:交付前复核边界假设并写入计划",
  "impact-analysis": "影响面分析:交付前必须用 code-sense 查影响面",
  none: "(无漏点证据)",
};

function safeguardOf(link: MissedLink): string {
  return SAFEGUARDS[link] ?? SAFEGUARDS.none;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 只留下非空字符串(去空白),其余丢弃——脏数据不该把整条判断带偏。 */
function stringsOf(value: unknown): string[] {
  return asArray(value)
    .filter(isFilled)
    .map((item) => (item as string).trim());
}

/** 路径归一:反斜杠 → 斜杠、去掉前导 `./`、压缩重复 `/`。 */
function pathKey(raw: string): string {
  let out = raw.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out.replace(/\/{2,}/g, "/");
}

function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** 同文件判定:归一后全等,或 basename 相等(`src/a.ts` ≡ `./a.ts` ≡ `src\\a.ts`)。 */
function samePath(a: unknown, b: unknown): boolean {
  if (!isFilled(a) || !isFilled(b)) return false;
  const left = pathKey(a);
  const right = pathKey(b);
  if (left === right) return true;
  const leftBase = baseName(left);
  const rightBase = baseName(right);
  return leftBase.length > 0 && leftBase === rightBase;
}

/** 两组路径是否有交集(任意一对同文件)。 */
function pathsIntersect(left: unknown, right: unknown): boolean {
  const a = stringsOf(left);
  const b = stringsOf(right);
  if (a.length === 0 || b.length === 0) return false;
  return a.some((x) => b.some((y) => samePath(x, y)));
}

/** 文本里是否出现某个词(大小写不敏感)。 */
function mentions(text: unknown, needle: unknown): boolean {
  if (!isFilled(text) || !isFilled(needle)) return false;
  return text.toLowerCase().includes(needle.trim().toLowerCase());
}

/** 模块相等(去空白 + 大小写不敏感)。 */
function sameModuleName(a: unknown, b: unknown): boolean {
  if (!isFilled(a) || !isFilled(b)) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function filesOfDefect(defect: Partial<DefectRecord>): string[] {
  return stringsOf(defect.files);
}

function moduleOfDefect(defect: Partial<DefectRecord>): string | undefined {
  return isFilled(defect.module) ? defect.module.trim() : undefined;
}

/** 同模块:声明模块相等,或改动文件与缺陷文件有交集。 */
function sameModuleOf(module: string | undefined, source: Partial<SourceTaskEvidence>, defectFiles: string[]): boolean {
  if (sameModuleName(module, source.module)) return true;
  return pathsIntersect(source.filesChanged, defectFiles);
}

/** 是否存在验证覆盖(命令 / 证据引用 / 看板证据 / P0 验收任一条非空)。 */
function hasVerificationCoverage(source: Partial<SourceTaskEvidence>): boolean {
  const verification = isObject(source.verification) ? source.verification : undefined;
  const plan = isObject(source.plan) ? source.plan : undefined;
  const p0Accepts = plan ? asArray(plan.p0Accepts).filter(isObject) : [];
  const commands = stringsOf(verification?.commands);
  const evidenceRefs = stringsOf(verification?.evidenceRefs);
  return commands.length > 0 || evidenceRefs.length > 0 || stringsOf(source.boardEvidenceRefs).length > 0 || p0Accepts.length > 0;
}

/** 计划是否为目标模块/文件落了节点(targets 命中)。 */
function planCoversTargets(source: Partial<SourceTaskEvidence>, module: string | undefined, defectFiles: string[]): boolean {
  const plan = isObject(source.plan) ? source.plan : undefined;
  if (!plan) return false;
  const nodes = asArray(plan.nodes).filter(isObject);
  if (nodes.length === 0) return false;
  return nodes.some((node) => {
    for (const target of stringsOf(node.targets)) {
      if (defectFiles.some((file) => samePath(file, target))) return true;
      if (module !== undefined && sameModuleName(module, target)) return true;
    }
    return false;
  });
}

/** 语义线索:模块名或某个缺陷文件的 basename 出现在交付描述里。 */
function semanticHit(module: string | undefined, defectFiles: string[], text: unknown): string | undefined {
  if (!isFilled(text)) return undefined;
  if (module !== undefined && mentions(text, module)) return module;
  for (const file of defectFiles) {
    const base = baseName(pathKey(file));
    if (mentions(text, base)) return base;
  }
  return undefined;
}

/** 时间邻接:两侧都有时间戳且相差不超过 14 天。 */
function isTimeAdjacent(fixedAt: unknown, at: unknown): boolean {
  if (typeof fixedAt !== "number" || typeof at !== "number") return false;
  if (!Number.isFinite(fixedAt) || !Number.isFinite(at)) return false;
  return Math.abs(fixedAt - at) <= ADJACENT_WINDOW_MS;
}

function isValidDefect(defect: unknown): defect is DefectRecord {
  if (!isObject(defect)) return false;
  return isFilled(defect.id) && isFilled(defect.fixTaskId) && Array.isArray(defect.files);
}

function isValidSource(source: unknown): source is SourceTaskEvidence {
  if (!isObject(source)) return false;
  return isFilled(source.taskId) && Array.isArray(source.filesChanged);
}

function dedupeCodes(codes: readonly (DefectCode | undefined)[]): DefectCode[] {
  const out: DefectCode[] = [];
  for (const code of codes) {
    if (isFilled(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

// ------------------------------------------------------------------ voteEvidence

/**
 * 给一条缺陷 × 一份交付证据投票。顺序 strong → medium → weak:
 * - strong 三条独立理由(blame 同提交同文件 / 测试改动命中 / 描述点名模块),满足任一即出一票,可多条;
 * - medium 需要「语义命中 + 同模块 + 时间邻接」三者同时成立,只出一票;
 * - weak 只在没有任何 strong/medium 时,用"碰过同一文件"兜底一票。
 */
export function voteEvidence(defect: DefectRecord, source: SourceTaskEvidence): EvidenceVote[] {
  const votes: EvidenceVote[] = [];
  if (!isObject(defect) || !isObject(source)) return votes;
  const d: Partial<DefectRecord> = defect;
  const s: Partial<SourceTaskEvidence> = source;
  const defectFiles = filesOfDefect(d);
  const changedFiles = stringsOf(s.filesChanged);
  const module = moduleOfDefect(d);

  // 强证据 ①:blame 里某条 commit 与交付提交相同,且该条 file 在该次交付的改动文件里。
  const blame = asArray(d.blame).filter(isObject) as Partial<BlameLine>[];
  const commitHit = blame.find(
    (entry) => isFilled(s.commit) && entry.commit === s.commit && changedFiles.some((file) => samePath(file, entry.file)),
  );
  if (commitHit) {
    votes.push({ kind: "strong", note: `blame 提交 ${s.commit} 命中改动文件 ${String(commitHit.file)}` });
  }

  // 强证据 ②:交付任务改过测试,且测试文件与缺陷文件有交集。
  const testsHit = stringsOf(s.testsChanged).find((test) => defectFiles.some((file) => samePath(file, test)));
  if (testsHit) {
    votes.push({ kind: "strong", note: `测试改动 ${testsHit} 命中缺陷文件` });
  }

  // 强证据 ③:交付描述里直接点了缺陷模块名。
  if (module !== undefined && mentions(s.text, module)) {
    votes.push({ kind: "strong", note: `交付描述包含模块 ${module}` });
  }

  // 中证据:语义命中 + 同模块 + 时间邻接,三者缺一不可;已有强证据时不再叠加。
  const semantic = semanticHit(module, defectFiles, s.text);
  const moduleSame = sameModuleOf(module, s, defectFiles);
  const adjacent = isTimeAdjacent(d.fixedAt, s.at);
  if (votes.length === 0 && semantic !== undefined && moduleSame && adjacent) {
    votes.push({ kind: "medium", note: `描述命中 ${semantic} + 同模块 + 时间邻接(≤14 天)` });
  }

  // 弱证据:仅路径交集,且当前没有更强的票。
  if (votes.length === 0 && pathsIntersect(changedFiles, defectFiles)) {
    const shared = changedFiles.find((file) => defectFiles.some((defectFile) => samePath(defectFile, file)));
    votes.push({ kind: "weak", note: `仅路径交集 ${String(shared)}(无强/中证据)` });
  }

  return votes;
}

// ------------------------------------------------------------------ resolveConfidence

/**
 * 把票折成置信度:≥1 张 strong → high;无 strong 但 medium ≥2 → medium;其余 → low。
 * 强/中门槛是故意设高的:只有一条 medium 时不允许对外声称"是我们交付造成的"。
 */
export function resolveConfidence(votes: EvidenceVote[]): { confidence: DefectConfidence; codes: DefectCode[] } {
  const list = asArray(votes).filter(isObject) as Partial<EvidenceVote>[];
  const strong = list.filter((vote) => vote.kind === "strong").length;
  const medium = list.filter((vote) => vote.kind === "medium").length;
  if (strong > 0) return { confidence: "high", codes: [DEFECT_CODES.LINK_STRONG] };
  if (medium >= 2) return { confidence: "medium", codes: [DEFECT_CODES.LINK_MEDIUM] };
  return { confidence: "low", codes: [DEFECT_CODES.LINK_WEAK] };
}

// ------------------------------------------------------------------ classifyLineage

/**
 * 判缺陷类别。优先级:重构语义 > 返工(有交集且有验证覆盖) > 无关(无交集) > 偏离(其余)。
 * 「无关」必须先于「偏离」:没有交集的交付不能因为"同模块闲着"就算偏离。
 */
export function classifyLineage(
  defect: DefectRecord,
  source: SourceTaskEvidence,
  opts: { now?: number } = {},
): { category: DefectCategory; codes: DefectCode[] } {
  void opts;
  if (!isValidDefect(defect) || !isValidSource(source)) {
    return { category: "unknown", codes: [DEFECT_CODES.CATEGORY_UNKNOWN] };
  }
  const d: Partial<DefectRecord> = defect;
  const s: Partial<SourceTaskEvidence> = source;
  const module = moduleOfDefect(d);
  const defectFiles = filesOfDefect(d);

  if (sameModuleOf(module, s, defectFiles) && REFACTOR_RE.test(isFilled(s.text) ? s.text : "")) {
    return { category: "refactor", codes: [DEFECT_CODES.CATEGORY_UNKNOWN] };
  }
  const overlap = pathsIntersect(s.filesChanged, defectFiles);
  if (overlap && hasVerificationCoverage(s)) return { category: "rework", codes: [] };
  if (!overlap) return { category: "unrelated", codes: [] };
  return { category: "drift", codes: [] };
}

// ------------------------------------------------------------------ inferMissedLink

/**
 * 推断交付时漏掉的那道防线。顺序即优先级(先补上游,再补下游):
 * 知识缺失 > 需求理解 > 计划覆盖 > 验证覆盖 > 影响面分析 > 工具缺失 > 假设错误 > 证据不足。
 * 只返回第一个命中的一类:漏点同时有多处时,先修最上游那道(它挡住了后面所有防线)。
 */
export function inferMissedLink(
  defect: DefectRecord,
  source: SourceTaskEvidence,
  opts: { priorDefects?: DefectRecord[]; now?: number } = {},
): { missedLink: MissedLink; rationale: string; codes: DefectCode[] } {
  if (!isValidDefect(defect) || !isValidSource(source)) {
    return { missedLink: "none", rationale: "输入非法(id/fixTaskId/files/taskId/filesChanged 缺失),无法推断漏点", codes: [DEFECT_CODES.INVALID] };
  }
  const d: Partial<DefectRecord> = defect;
  const s: Partial<SourceTaskEvidence> = source;
  const module = moduleOfDefect(d);
  const defectFiles = filesOfDefect(d);
  const changedFiles = stringsOf(s.filesChanged);
  const text = isFilled(s.text) ? s.text : "";

  // 1 知识缺失:历史上同类缺陷出现过却没被检索。
  const priors = asArray(opts.priorDefects).filter(isObject) as Partial<DefectRecord>[];
  const priorHit = priors.find((prior) => {
    if (!isFilled(prior.id) || prior.id === d.id) return false;
    const sameModulePrior = sameModuleName(module, prior.module);
    return sameModulePrior || pathsIntersect(prior.files, defectFiles);
  });
  if (priorHit && stringsOf(d.evidenceRefs).length > 0) {
    return {
      missedLink: "knowledge-gap",
      rationale: `opts.priorDefects 已有同类缺陷 ${String(priorHit.id)}(同 module 或 files 交集),而交付未检索写入证据图谱(evidenceRefs 存在)`,
      codes: [],
    };
  }

  // 2 需求理解:交付没写清目标模块(或描述空/没提模块)。
  if (text.length === 0) {
    return { missedLink: "requirement", rationale: "source.text 为空,交付任务没有记录需求上下文", codes: [] };
  }
  if (module !== undefined && !mentions(text, module)) {
    return { missedLink: "requirement", rationale: `source.text 未提及缺陷模块 ${module},需求理解缺少目标定位`, codes: [] };
  }

  // 3 计划覆盖:计划缺失或没有任何节点 targets 命中缺陷文件/模块。
  if (!planCoversTargets(s, module, defectFiles)) {
    const planExists = isObject(s.plan) && asArray((s.plan as Record<string, unknown>).nodes).length > 0;
    return {
      missedLink: "plan-coverage",
      rationale: planExists
        ? "plan.nodes[].targets 未命中缺陷 files/module,计划没有为改动落节点"
        : "plan 缺失,交付任务没有任何 plan.nodes 覆盖目标模块",
      codes: [],
    };
  }

  // 4 验证覆盖:验证信息全空(命令 / 证据 / 看板 / P0 验收)。
  if (!hasVerificationCoverage(s)) {
    return {
      missedLink: "verification-coverage",
      rationale: "verification.commands/evidenceRefs、boardEvidenceRefs、plan.p0Accepts 全为空,交付缺少可执行验收",
      codes: [],
    };
  }

  // 5 影响面分析:声明了模块却没用 code-sense 查影响面。
  if (s.codeSenseUsed === false && module !== undefined) {
    return {
      missedLink: "impact-analysis",
      rationale: `codeSenseUsed=false 且有明确 module ${module},未用 code-sense 查影响面`,
      codes: [],
    };
  }

  // 6 工具缺失:连模块都没定位(或压根没改文件),说明缺少检测该缺陷的工具能力。
  if ((s.codeSenseUsed === false && module === undefined) || changedFiles.length === 0) {
    return {
      missedLink: "tool-gap",
      rationale: changedFiles.length === 0
        ? "source.filesChanged 为空,交付没有可追溯的改动文件,现有工具无法定位"
        : "codeSenseUsed=false 且 module 为空,交付无法定位改动范围",
      codes: [],
    };
  }

  // 7 假设错误:描述里承认了未复核的前提。
  if (ASSUMPTION_RE.test(text)) {
    return {
      missedLink: "wrong-assumption",
      rationale: "source.text 含「不需要验证/假设/默认成立」,边界假设未复核",
      codes: [],
    };
  }

  // 8 证据不足:所有防线都在,不指认漏点。
  return { missedLink: "none", rationale: "证据不足,无法定位漏点", codes: [] };
}

// ------------------------------------------------------------------ buildLineage

/** buildLineage 结果:ok=false 只表示输入非法(不是"没归属")。 */
export interface BuildLineageResult {
  ok: boolean;
  defect?: DefectRecord;
  chain: LineageChainEntry[];
  unattributed: boolean;
  votes: EvidenceVote[];
  codes: DefectCode[];
}

/**
 * 组装完整血缘:投票 → 置信度 → 类别 → 漏点 → 链。
 * 置信度 low 或类别 unrelated 一律 unattributed(chain 为空):宁可承认"说不清",也不硬凑链。
 */
export function buildLineage(
  defect: DefectRecord,
  source: SourceTaskEvidence,
  opts: { now?: number; priorDefects?: DefectRecord[] } = {},
): BuildLineageResult {
  if (!isValidDefect(defect) || !isValidSource(source)) {
    return { ok: false, chain: [], unattributed: true, votes: [], codes: [DEFECT_CODES.INVALID] };
  }
  const votes = voteEvidence(defect, source);
  const resolved = resolveConfidence(votes);
  const classified = classifyLineage(defect, source, { now: opts.now });
  const missed = inferMissedLink(defect, source, { priorDefects: opts.priorDefects, now: opts.now });

  const enriched: DefectRecord = {
    ...defect,
    category: classified.category,
    confidence: resolved.confidence,
    missedLink: missed.missedLink,
  };
  const unattributed = resolved.confidence === "low" || classified.category === "unrelated";

  const chain: LineageChainEntry[] = [];
  if (!unattributed) {
    const module = moduleOfDefect(enriched);
    const files = filesOfDefect(enriched);
    const moduleRef = module ?? files[0];
    chain.push({ type: "task", ref: source.taskId, label: `交付任务 ${source.taskId}` });
    if (moduleRef !== undefined) chain.push({ type: "module", ref: moduleRef, label: `模块 ${moduleRef}` });
    chain.push({ type: "defect", ref: defect.id, label: `缺陷 ${defect.id}` });
    chain.push({
      type: "decision",
      ref: source.taskId,
      label: `${classified.category} / ${resolved.confidence} / ${missed.missedLink}`,
    });
    if (missed.missedLink !== "none") {
      chain.push({ type: "missing-safeguard", ref: missed.missedLink, label: safeguardOf(missed.missedLink) });
    }
  }

  const codes = dedupeCodes([
    ...resolved.codes,
    classified.category === "unknown" ? DEFECT_CODES.CATEGORY_UNKNOWN : undefined,
    unattributed ? DEFECT_CODES.UNATTRIBUTED : undefined,
  ]);

  return { ok: true, defect: enriched, chain, unattributed, votes, codes };
}

// ------------------------------------------------------------------ toEvidenceGraphInputs

/**
 * 把血缘投影成证据图输入(纯数据,不依赖 evidence-graph 的类型,避免反向耦合)。
 * 不可归属 / 非法 → ok=false + GRAPH_FAILED,不给图里塞没把握的节点。
 */
export function toEvidenceGraphInputs(lineage: ReturnType<typeof buildLineage>): {
  ok: boolean;
  codes: DefectCode[];
  nodes: {
    kind: "anti-pattern" | "direction";
    statement: string;
    associations: { type: "task" | "module" | "decision"; ref: string; label?: string }[];
    confidence: number;
    source: { note?: string };
  }[];
  edges: { from: string; to: string; kind: string }[];
} {
  const nodes: {
    kind: "anti-pattern" | "direction";
    statement: string;
    associations: { type: "task" | "module" | "decision"; ref: string; label?: string }[];
    confidence: number;
    source: { note?: string };
  }[] = [];
  const edges: { from: string; to: string; kind: string }[] = [];

  if (!isObject(lineage)) {
    return { ok: false, codes: [DEFECT_CODES.GRAPH_FAILED], nodes, edges };
  }
  const codes = dedupeCodes(asArray(lineage.codes).filter(isFilled).map((code) => code as DefectCode));
  if (lineage.ok !== true || lineage.unattributed !== false) {
    return { ok: false, codes: dedupeCodes([...codes, DEFECT_CODES.GRAPH_FAILED]), nodes, edges };
  }
  const defect = isObject(lineage.defect) ? (lineage.defect as Partial<DefectRecord>) : undefined;
  if (!defect || !isFilled(defect.id) || !isFilled(defect.fixTaskId)) {
    return { ok: false, codes: dedupeCodes([...codes, DEFECT_CODES.GRAPH_FAILED]), nodes, edges };
  }

  const chain = asArray(lineage.chain).filter(isObject) as Partial<LineageChainEntry>[];
  const taskEntry = chain.find((entry) => entry.type === "task");
  const moduleEntry = chain.find((entry) => entry.type === "module");
  const taskId = taskEntry !== undefined && isFilled(taskEntry.ref) ? taskEntry.ref : "";
  const moduleRef = moduleEntry !== undefined && isFilled(moduleEntry.ref) ? moduleEntry.ref : undefined;
  if (taskId.length === 0) {
    return { ok: false, codes: dedupeCodes([...codes, DEFECT_CODES.GRAPH_FAILED]), nodes, edges };
  }

  const missedLink: MissedLink = isFilled(defect.missedLink) ? (defect.missedLink as MissedLink) : "none";
  const confidenceScore = defect.confidence === "high" ? 0.85 : defect.confidence === "medium" ? 0.6 : 0.35;

  const antiPatternAssociations: { type: "task" | "module" | "decision"; ref: string; label?: string }[] = [
    { type: "task", ref: defect.fixTaskId },
  ];
  if (moduleRef !== undefined) antiPatternAssociations.push({ type: "module", ref: moduleRef });
  antiPatternAssociations.push({ type: "decision", ref: taskId, label: missedLink });

  nodes.push({
    kind: "anti-pattern",
    statement: `缺陷 ${defect.id} 回归:${isFilled(defect.description) ? defect.description : ""}`,
    associations: antiPatternAssociations,
    confidence: confidenceScore,
    source: { note: `defect-lineage v1 ${defect.fixTaskId}` },
  });

  if (missedLink !== "none") {
    const safeguardAssociations: { type: "task" | "module" | "decision"; ref: string; label?: string }[] = [];
    if (moduleRef !== undefined) safeguardAssociations.push({ type: "module", ref: moduleRef });
    safeguardAssociations.push({ type: "decision", ref: missedLink });
    nodes.push({
      kind: "direction",
      statement: safeguardOf(missedLink),
      associations: safeguardAssociations,
      confidence: 0.6,
      source: { note: "missing-safeguard" },
    });
  }

  if (nodes.length === 2) edges.push({ from: "node-0", to: "node-1", kind: "contains" });

  return { ok: true, codes: dedupeCodes([...codes, DEFECT_CODES.GRAPH_PROJECTED]), nodes, edges };
}
