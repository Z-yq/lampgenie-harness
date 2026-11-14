/**
 * 返工因果链 v1(用户设想「RSI 的灵魂」)。
 * 设想的四环节,本轮按**确定性可判**的口径落地:
 * ① 链识别(三路投票):B 是否在修 A 的活——
 * 强证据 = 同逻辑单元(atlas-harvest logicalPathKey 归并)编辑 + B 标题命中修复词
 * + A 是该单元近期首个非修复编辑者;
 * 中证据 = 同模块(路径目录前缀) + A/B 标题词交集 ≥2 + 时间邻接(≤7 天);
 * 弱证据 = 仅路径重叠——**不进台账**(设想:切不干净,产物不可信)。
 * ② 分类标签(不是检测):rework(B 标题命中修复/fix/回归/崩溃)/ refactor(重构/优化/清理)
 * / drift(需求/新增/改为——演进不算缺陷)/ unrelated(其余,不进链)。
 * ③ 缺陷定位(v1 语义代理):B 是否补测试(write/edit 到 test 路径 → missing-test)+
 * 标题词表 → boundary(空值/边界/越界/校验)/ contract(签名/参数/接口/协议/契约)
 * / concurrency(并发/时序/竞态)/ uncategorized(诚实)。
 * ④ 根因归因(灵魂):只看 **A 决策那一刻,正确答案是否可得**——确定性代理 = A 会话的
 * readPaths(A 读过什么)。B 修的文件 A 没读过且不在 A 的编辑面 → 信息可得而未取
 * (影响面未查)→ preventable;B 的分类是 drift → drift(不可预防,进需求漂移);
 * 其余 → unknown(诚实,不冒充)。
 * 扇出簇聚合:同一 buildSession 挂 ≥2 个修复会话、涉及 ≥2 个不同逻辑单元
 * → 「影响面未闭合」候选(设想的扇出型返工链签名)。
 * 台账:`<root>/.genie/rsi/rework-chains.jsonl` append-only,按
 * (buildSession ∥ fixSession ∥ logicalKey) 幂等去重,重复检测不重复落行。
 * 三个护栏照设想内置:单例不成规(同根因 ≥2 次才带 preventionHint)/ 无责归因
 * (产物只写「该节点缺哪道检查」,不写「谁错」)/ 防事后偏见(只用 A 当时的 readPaths,
 * 不用 B 事后知道的东西)。
 * 依赖纪律:node:fs/node:path + atlas-harvest(会话视图);纯确定性,零 LLM;不 throw。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectWorkSessions, logicalPathKey, type HarvestWorkSession, type HarvestOptions } from "./atlas-harvest.js";

/** 证据级别:weak 不进台账(设想:归属切不干净,后面一切产物都不可信)。 */
export type ChainEvidenceLevel = "strong" | "medium";

/** 链分类:rework=返工(A 的缺陷)/refactor=质量升级/drift=需求演进(不算缺陷)。 */
export type ChainClassification = "rework" | "refactor" | "drift";

/** 缺陷类(v1 标题词表代理;uncategorized=诚实不猜)。 */
export type DefectClass = "boundary" | "contract" | "concurrency" | "missing-test" | "uncategorized";

/** 根因裁决:preventable=A 决策时信息可得而未取 / drift=当时不可得 / unknown=证据不足。 */
export type AttributionVerdict = "preventable" | "drift" | "unknown";

/** 预防件形态(设想:从轻到重 上下文补全→决策门→测试→工具)。 */
export type PreventionKind = "context" | "gate" | "test" | "tool";

export interface ReworkChainLine {
  v: 1;
  at: number;
  projectId: string;
 /** 建设会话(A)。 */
  buildSession: string;
  buildTitle: string;
 /** 修复会话(B)。 */
  fixSession: string;
  fixTitle: string;
 /** 本链的逻辑单元键(脚本+同名测试=1)。 */
  logicalKey: string;
 /** 代表路径(展示用)。 */
  path: string;
  evidenceLevel: ChainEvidenceLevel;
  classification: ChainClassification;
  defectClass: DefectClass;
  attribution: {
    verdict: AttributionVerdict;
 /** B 修复面里 A 读过的文件数 / 总数(信息可得性判据的原始信号)。 */
    readByA: number;
    fixFaceTotal: number;
 /** B 是否补了测试(missing-test 信号)。 */
    fixAddedTest: boolean;
  };
 /** 同根因重复 ≥2 次才带预防件(单例不成规)。 */
  prevention?: { kind: PreventionKind; note: string };
}

export interface FanoutClusterLine {
  v: 1;
  at: number;
  projectId: string;
  buildSession: string;
  buildTitle: string;
  fixSessions: string[];
 /** 修复涉及的逻辑单元键(≥2 个不同依赖边=「影响面未闭合」签名)。 */
  logicalKeys: string[];
  verdict: "impact-not-closed";
}

export type ReworkLedgerLine = ReworkChainLine | FanoutClusterLine;

export interface DetectReworkResult {
  ok: boolean;
  chains: number;
  fanoutClusters: number;
  appended: number;
 /** 参与检测的会话数(过滤噪声/跨项目后)。 */
  sessions: number;
 /** 本次**新落盘**的链(defectGenes 生产者只投新链,天然幂等)。 */
  freshChains: ReworkChainLine[];
}

const DAY_MS = 86_400_000;
const CHAIN_WINDOW_MS = 7 * DAY_MS;
/** 单例不成规:同一 (logicalKey 根因类) 出现 ≥2 次才附 prevention。 */
const PREVENTION_MIN_REPEATS = 2;

// 自评二轮:【修 】【补 #191】这类「修/补+空格+编号」逃过词表,把修复会话
// 误当建设者(生产剩余 preventable 4/4 全中)——修/补 后跟空格/编号/#/【 也算修复类。
const FIX_TITLE_RE = /修复|修正|修一下|改错|回归|补丁|排查|崩溃|报错|异常|fix|bug|regress|[修补][\s#\d【]/i;
const REFACTOR_TITLE_RE = /重构|优化|清理|精简|抽取|拆分|refactor|cleanup/i;
const DRIFT_TITLE_RE = /需求|新增|改为|调整|扩展|支持|变更|新要求/i;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/i;

/**
 * 问答类标题判据(自评三轮:用户问答会话被配成 builder——「把之前的产物结果
 * 罗列一下给我」这类不是建设工作)。保守:带问号或以问答动词开头才算。
 */
const QA_TITLE_RE = /[?？]|^(看看|罗列|列一下|帮我看|请评估|评估一下)/;

/** 建设者资格:标题非问答(harvest 对全文打的 isQuestion 优先——标题截断会把问号切掉,
 * v2 生产注意「罗列一下…质量如何?」的 ? 正好在 160 字之后)、编辑面里有非测试源文件。 */
function eligibleBuilder(session: HarvestWorkSession): boolean {
  if (session.isQuestion === true) return false;
  if (QA_TITLE_RE.test(session.title.trim())) return false;
  return session.editedPaths.some((p) => !TEST_PATH_RE.test(p));
}

const DEFECT_CLASS_RULES: ReadonlyArray<{ re: RegExp; cls: DefectClass }> = [
  { re: /空值|null|边界|越界|校验|判空|可选|optional/i, cls: "boundary" },
  { re: /签名|参数|接口|协议|契约|类型|schema|字段/i, cls: "contract" },
  { re: /并发|时序|竞态|锁|异步|顺序|race/i, cls: "concurrency" },
];

const PREVENTION_BY_CLASS: Readonly<Record<DefectClass, { kind: PreventionKind; note: string }>> = {
  boundary: { kind: "gate", note: "实现前先枚举被操作实体的取值全集(空值/边界),逐分支核对" },
  contract: { kind: "context", note: "改契约前先列出全部调用方/消费方并核对签名与语义" },
  concurrency: { kind: "gate", note: "涉及共享状态/异步顺序时,先写明时序假设与失效条件" },
  "missing-test": { kind: "test", note: "先写边界测试再实现(B 后来补的测试本可先写)" },
  uncategorized: { kind: "gate", note: "该类决策点补一道显式检查(证据不足以细分,先挂通用门)" },
};

/** 台账路径。 */
export function reworkChainsPath(root: string): string {
  return join(root, ".genie", "rsi", "rework-chains.jsonl");
}

function classify(title: string): ChainClassification | "unrelated" {
  if (FIX_TITLE_RE.test(title)) return "rework";
  if (REFACTOR_TITLE_RE.test(title)) return "refactor";
  if (DRIFT_TITLE_RE.test(title)) return "drift";
  return "unrelated";
}

function defectClassOf(fixTitle: string, fixAddedTest: boolean): DefectClass {
  if (fixAddedTest) return "missing-test";
  for (const rule of DEFECT_CLASS_RULES) if (rule.re.test(fixTitle)) return rule.cls;
  return "uncategorized";
}

function titleWordOverlap(a: string, b: string): number {
 // 滑动二元组(CJK 连续串内每个相邻对)+ 拉丁词;非重叠切法会把「模块一/一的问题」的边界吃掉。
  const words = (t: string) => {
    const out = new Set<string>();
    const text = t.toLowerCase();
    for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
      for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    }
    for (const w of text.match(/[a-z][a-z0-9_.-]{2,}/g) ?? []) out.add(w);
    return out;
  };
  const wa = words(a);
  let hit = 0;
  for (const w of words(b)) if (wa.has(w)) hit++;
  return hit;
}

/**
 * 路径的标识符候选(A/D 共用的小工具):文件名 / 去扩展名 stem(≥3 字)/
 * 末两段路径。与 atlas-harvest 的 taskTouchesModule 同思路,但**本文件自实现**——不让
 * atlas-harvest 反向依赖本模块(依赖单向:rework-chain → atlas-harvest)。
 */
function pathSegmentTokens(path: string): string[] {
  const segments = String(path ?? "").split("\\").join("/").split("/").filter((s) => s !== "");
  if (segments.length === 0) return [];
  const base = segments[segments.length - 1]!;
  const stem = base.replace(/\.[^./]+$/, "");
  const tokens = new Set<string>([base]);
  if (stem !== base && stem.length >= 3) tokens.add(stem);
  if (segments.length >= 2) tokens.add(`${segments[segments.length - 2]}/${base}`);
  return [...tokens];
}

/** token 是否以「非标识符边界」出现在文本里(避免 panel.ts 命中 panel.tsx)。 */
function containsBoundedToken(text: string, token: string): boolean {
  if (token === "" || text === "") return false;
  const isBoundaryChar = (ch: string): boolean => /[A-Za-z0-9_.-]/.test(ch);
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1]!;
    const afterAt = at + token.length;
    const after = afterAt >= text.length ? "" : text[afterAt]!;
    if (!isBoundaryChar(before) && !isBoundaryChar(after)) return true;
    from = at + 1;
  }
}

/**
 * fixer 的「引用文本」( medium 显式引用门):标题(≤160 字,harvest 视图字段)
 * + **首条用户消息的用户原文段**。harvest 的 HarvestWorkSession 只留 title(截断到 160 字),
 * 所以这里按会话文件补读一次首条 message.user(与 atlas-harvest 同口径:只取首个 "\n## "
 * 纪律卡段之前的用户原文,避免模板词误命中);读不到就退回标题。按会话缓存,每会话至多读一次。
 */
function fixerTextOf(journalDir: string, session: HarvestWorkSession, memo: Map<string, string>): string {
  const cached = memo.get(session.sessionId);
  if (cached !== undefined) return cached;
  let firstUser = session.title;
  try {
    const file = join(journalDir, "sessions", `${session.sessionId}.jsonl`);
    if (existsSync(file)) {
      for (const raw of readFileSync(file, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        let event: { kind?: unknown; payload?: { text?: unknown } };
        try {
          event = JSON.parse(raw) as { kind?: unknown; payload?: { text?: unknown } };
        } catch {
          continue; // 坏行跳过(与 harvest 一致)
        }
        if (event.kind !== "message.user") continue;
        const full = typeof event.payload?.text === "string" ? event.payload.text.trim() : "";
        if (full === "") continue;
        const cut = full.indexOf("\n## ");
        firstUser = cut > 0 ? full.slice(0, cut) : full;
        break;
      }
    }
  } catch {
 // 读失败退回标题(不 throw:确定性检测不许因 IO 失败中断)
  }
  const text = `${session.title}\n${firstUser}`.slice(0, 4000);
  memo.set(session.sessionId, text);
  return text;
}

/** builder 的哪个逻辑单元被 fixer 文本显式引用(命中返回该 key,否则 undefined)。 */
function citedBuilderKey(builder: HarvestWorkSession, fixerText: string): string | undefined {
  const seen = new Set<string>();
  for (const path of builder.editedPaths) {
    const key = logicalPathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const token of pathSegmentTokens(path)) {
      if (containsBoundedToken(fixerText, token)) return key;
    }
  }
  return undefined;
}

interface WorkingChain {
  build: HarvestWorkSession;
  fix: HarvestWorkSession;
  logicalKey: string;
  path: string;
  evidenceLevel: ChainEvidenceLevel;
  classification: ChainClassification;
}

/**
 * 检测一轮返工链并**幂等追加**到台账。纯确定性:两遍(候选链 → 归因+落行)。
 * journalDir 不存在/无会话 → ok:true 零追加(不 throw)。
 */
export function detectReworkChains(root: string, projectId: string, opts: HarvestOptions & { journalDir: string; now?: number }): DetectReworkResult {
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const collected = collectWorkSessions(opts.journalDir, { ...opts, now });
  const sessions = collected.sessions;
  const result: DetectReworkResult = { ok: true, chains: 0, fanoutClusters: 0, appended: 0, sessions: sessions.length, freshChains: [] };

 // ── ①链识别 + ②分类:每个逻辑单元的编辑时间线 → 建设会话与后续修复会话配对 ──
  const unitMap = new Map<string, { display: string; sessions: HarvestWorkSession[] }>();
  for (const session of sessions) {
    for (const path of session.editedPaths) {
      const key = logicalPathKey(path);
      const entry = unitMap.get(key) ?? { display: path, sessions: [] };
      entry.sessions.push(session);
      unitMap.set(key, entry);
    }
  }
  const chains: WorkingChain[] = [];
  const paired = new Set<string>(); // build∥fix 已配对(两遍之间去重)

 // ── 第一遍:同逻辑单元内配对(强证据:同单元编辑 + 修复类标题)──
 // 自评三轮「磁铁文件」:人人都改的共享测试文件(journal-maint.test.ts)上,
 // 共址≠因果——测试路径不作配对单元(仍可作修复面参与 missing-test 判定);桶文件 index.ts
 // 不降权(经 index.ts 导出缺失恰是真实契约链)。
  for (const [key, entry] of unitMap) {
    if (TEST_PATH_RE.test(entry.display)) continue;
    const list = [...entry.sessions].sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (let i = 0; i < list.length; i++) {
      const builder = list[i]!;
 // 建设者 = 开发/需求类标题(drift 的「新增/改为」也是建设);修复类与重构类不做建设者;
 // 问答类(带问号/问答动词)与纯测试会话也不做建设者。
      const builderClass = classify(builder.title);
      if (builderClass === "rework" || builderClass === "refactor") continue;
      if (!eligibleBuilder(builder)) continue;
      for (let j = i + 1; j < list.length; j++) {
        const fixer = list[j]!;
        if (fixer.mtimeMs - builder.mtimeMs > CHAIN_WINDOW_MS) break;
        const fixClass = classify(fixer.title);
        if (fixClass === "unrelated") continue;
        const semanticOverlap = titleWordOverlap(builder.title, fixer.title);
        let evidenceLevel: ChainEvidenceLevel | undefined;
        if (fixClass === "rework") evidenceLevel = "strong";
        else if (fixClass === "drift" && semanticOverlap >= 1) evidenceLevel = "medium";
        if (evidenceLevel === undefined) continue; // 弱证据不进台账
        chains.push({ build: builder, fix: fixer, logicalKey: key, path: entry.display, evidenceLevel, classification: fixClass });
        paired.add(`${builder.sessionId}\u0000${fixer.sessionId}`);
        break; // 每个建设会话只配最近一个后续(不追多代,v1)
      }
    }
  }

 // ── 第二遍:跨单元配对(设想的扇出场景:B 修的是 A 没碰过的上游/下游文件)──
 // 中证据两条,任一成立:
 // ① B 修复前**读过 A 的产出**(B.readPaths ∩ A.editedPaths,逻辑键)——「B 的会话里出现
 // A 产出的标识符」的文件级升级,修上游必读新模块,这是最强的跨单元信号;
 // ② A/B 标题语义重叠 ≥2(任务语义匹配)**且** B 的用户文本显式引用 A 的产出标识符
 // (显式引用门:纯语义重叠在标题词汇重叠的仓里产出共址伪链)。
  const citationMemo = new Map<string, string>(); // fixer 引用文本按会话缓存(每会话至多读一次 journal)
  for (const fixer of sessions) {
    const fixClass = classify(fixer.title);
    if (fixClass === "unrelated" || fixClass === "refactor") continue;
    let best: { builder: HarvestWorkSession; logicalKey: string; path: string; level: ChainEvidenceLevel } | undefined;
    for (const builder of sessions) {
      if (builder.mtimeMs >= fixer.mtimeMs || fixer.mtimeMs - builder.mtimeMs > CHAIN_WINDOW_MS) continue;
      const builderClass = classify(builder.title);
      if (builderClass === "rework" || builderClass === "refactor") continue;
      if (!eligibleBuilder(builder)) continue;
      if (paired.has(`${builder.sessionId}\u0000${fixer.sessionId}`)) continue;
      const builderKeys = [...new Set(builder.editedPaths.map((p) => logicalPathKey(p)))];
      const fixerReadKeys = new Set((fixer.readPaths ?? []).map((p) => logicalPathKey(p)));
      const readLink = builderKeys.find((k) => fixerReadKeys.has(k));
      const semantic = titleWordOverlap(builder.title, fixer.title);
      let level: ChainEvidenceLevel | undefined;
      let unitKey: string | undefined;
      if (readLink !== undefined) { level = "strong"; unitKey = readLink; }
      else if (semantic >= 2) {
 // medium 显式引用门(残留①:6 条 preventable 里 4 条是 medium 语义
 // 配对的混合体)。标题词汇高度重叠的仓里「语义重叠 ≥2」只是共址噪声:medium 必须额外
 // 满足「fixer 文本**显式出现** builder 的产出标识符」(产出路径的文件名/去扩展名 stem/
 // 末两段路径,边界匹配——panel.ts 不许命中 panel.tsx)。不满足 → 跳过该配对(不进台账);
 // readLink 的 strong 路径与 strong 永不受此门影响。
        const cited = citedBuilderKey(builder, fixerTextOf(opts.journalDir, fixer, citationMemo));
        if (cited !== undefined) { level = "medium"; unitKey = cited; } // 取命中的那个 key(不是 builderKeys[0])
      }
      if (level === undefined || unitKey === undefined) continue;
 // 取最近的合格建设者(时间最近 = 因果最可能)
      if (best === undefined || builder.mtimeMs > best.builder.mtimeMs) {
        const display = builder.editedPaths.find((p) => logicalPathKey(p) === unitKey) ?? unitKey;
        best = { builder, logicalKey: unitKey, path: display, level };
      }
    }
    if (best !== undefined) {
      chains.push({ build: best.builder, fix: fixer, logicalKey: best.logicalKey, path: best.path, evidenceLevel: best.level, classification: fixClass });
      paired.add(`${best.builder.sessionId}\u0000${fixer.sessionId}`);
    }
  }
 // ── 去伪:一个 fix 会话只保留一条链(自评三轮:磁铁单元上同一 fixer 与
 // 多个 builder 各配一条,journal-maint 案例一个 fix 会话挂 5 条链)——strong 优先,
 // 同级取最近的 builder(因果最可能)。真实扇出本来就是**多个不同 fix 会话**挂在同一 build 上,
 // 本约束不伤扇出签名。──
  const bestByFixer = new Map<string, WorkingChain>();
  for (const chain of chains) {
    const prev = bestByFixer.get(chain.fix.sessionId);
    const better =
      prev === undefined ||
      (prev.evidenceLevel === "medium" && chain.evidenceLevel === "strong") ||
      (prev.evidenceLevel === chain.evidenceLevel && chain.build.mtimeMs > prev.build.mtimeMs);
    if (better) bestByFixer.set(chain.fix.sessionId, chain);
  }
  const deduped = [...bestByFixer.values()].sort((a, b) => a.fix.mtimeMs - b.fix.mtimeMs);
  chains.length = 0;
  chains.push(...deduped);
  result.chains = chains.length;

 // ── ④根因归因:只用 A 当时的 readPaths(防事后偏见)──
 // 单例不成规的「同根因」= **L1 缺陷类跨实体重现**(设想:同一类缺陷在不同模块出现 ≥N 次,
 // 才允许上升到任务原型/预防件;按逻辑单元计数会把跨实体重现拆成N个单例)。
  const repeats = new Map<string, number>();
  for (const chain of chains) {
    const defectKey = defectClassOf(chain.fix.title, addedTest(chain.fix));
    repeats.set(defectKey, (repeats.get(defectKey) ?? 0) + 1);
  }
  const existingKeys = readExistingKeys(reworkChainsPath(root));
  const lines: ReworkLedgerLine[] = [];
  for (const chain of chains) {
    const fixAddedTest = addedTest(chain.fix);
    const defectClass = defectClassOf(chain.fix.title, fixAddedTest);
 // B 的修复面(逻辑键)里 A 读过几个(信息可得性)
    const fixFaceKeys = [...new Set(chain.fix.editedPaths.map((p) => logicalPathKey(p)))];
    const aReads = new Set((chain.build.readPaths ?? []).map((p) => logicalPathKey(p)));
    const readByA = fixFaceKeys.filter((k) => aReads.has(k)).length;
 // 自评证伪修复:「信息可得而未取」必须三渠道都查过才算——A 用 grep/terminal/
 // code_sense 勘察时参数里**提及过修复面的路径段**就不许判 preventable(生产抽查 3/3 的
 // preventable 会话其实都大量勘察过,首版判据把它们全冤枉了)。
    const probeCorpus = (chain.build.probeTexts ?? []).join(" ");
    const faceProbed = chain.fix.editedPaths.some((p) => {
      const seg = p.split("/").slice(-2).join("/");
      const base = p.split("/").pop() ?? p;
      return (seg.length > 3 && probeCorpus.includes(seg)) || (base.length > 4 && probeCorpus.includes(base));
    });
    let verdict: AttributionVerdict;
    if (chain.classification === "drift") verdict = "drift";
    else if (readByA < fixFaceKeys.length && !faceProbed) verdict = "preventable"; // 修复面 A 既没读也没勘察过
    else verdict = "unknown"; // 读过或勘察过但没防住 → 证据不足以定「未取」,诚实 unknown
    const line: ReworkChainLine = {
      v: 1,
      at: now,
      projectId,
      buildSession: chain.build.sessionId,
      buildTitle: clip(chain.build.title, 80),
      fixSession: chain.fix.sessionId,
      fixTitle: clip(chain.fix.title, 80),
      logicalKey: chain.logicalKey,
      path: chain.path,
      evidenceLevel: chain.evidenceLevel,
      classification: chain.classification,
      defectClass,
      attribution: { verdict, readByA, fixFaceTotal: fixFaceKeys.length, fixAddedTest },
    };
 // 单例不成规:同缺陷类跨实体 ≥2 次才附预防件
    if ((repeats.get(defectClass) ?? 0) >= PREVENTION_MIN_REPEATS && verdict === "preventable") {
      const p = PREVENTION_BY_CLASS[defectClass];
      line.prevention = { kind: p.kind, note: p.note };
    }
    lines.push(line);
  }

 // ── 扇出簇:同一 buildSession 挂 ≥2 修复、≥2 不同逻辑单元 ──
  const byBuild = new Map<string, { build: HarvestWorkSession; fixes: WorkingChain[] }>();
  for (const chain of chains) {
    const entry = byBuild.get(chain.build.sessionId) ?? { build: chain.build, fixes: [] };
    entry.fixes.push(chain);
    byBuild.set(chain.build.sessionId, entry);
  }
  for (const [, entry] of byBuild) {
 // 扇出签名 = 修复落在 ≥2 个**不同依赖边**(修复面自己的逻辑单元),不是建设的单元——
 // B 修上游、C 修下游都是因为 A 的新模块,但边不同。
    const fixKeys = new Set<string>();
    for (const chain of entry.fixes) {
      for (const p of chain.fix.editedPaths) fixKeys.add(logicalPathKey(p));
    }
    if (entry.fixes.length >= 2 && fixKeys.size >= 2) {
      result.fanoutClusters++;
      lines.push({
        v: 1,
        at: now,
        projectId,
        buildSession: entry.build.sessionId,
        buildTitle: clip(entry.build.title, 80),
        fixSessions: [...new Set(entry.fixes.map((c) => c.fix.sessionId))],
        logicalKeys: [...fixKeys],
        verdict: "impact-not-closed",
      });
    }
  }

 // ── 幂等追加:按行身份键去重(链:build∥fix∥logicalKey;簇:build∥fixes 排序) ──
  const fresh = lines.filter((line) => {
    const key = lineKey(line);
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });
  if (fresh.length > 0) {
    try {
      mkdirSync(dirname(reworkChainsPath(root)), { recursive: true });
      appendFileSync(reworkChainsPath(root), fresh.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
      result.appended = fresh.length;
      result.freshChains = fresh.filter((line): line is ReworkChainLine => "fixSession" in line);
    } catch {
      result.ok = false; // 写失败:不 throw,调用方按 ok:false 折叠
    }
  }
  return result;
}

/**
 * 「B 补了测试」判据(修):必须同时编辑源单元 X 与其测试(X 的逻辑键 ∈ 测试路径
 * 归并后的键)才算「为 X 补测试」。首轮生产经验证:只看「碰过任何 test 路径」会把机制任务
 * 全标成 missing-test——任务书本就要求写测试,那是 TDD 不是验证缺口。
 */
function addedTest(session: HarvestWorkSession): boolean {
  const testKeys = new Set(session.editedPaths.filter((p) => TEST_PATH_RE.test(p)).map((p) => logicalPathKey(p)));
  if (testKeys.size === 0) return false;
  return session.editedPaths.some((p) => !TEST_PATH_RE.test(p) && testKeys.has(logicalPathKey(p)));
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function lineKey(line: ReworkLedgerLine): string {
  if ("fixSession" in line) return `chain\u0000${line.buildSession}\u0000${line.fixSession}\u0000${line.logicalKey}`;
  return `fanout\u0000${line.buildSession}\u0000${[...line.fixSessions].sort().join(",")}`;
}

/** 读台账已有行身份键(坏行跳过)。 */
function readExistingKeys(file: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(file)) return keys;
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      try {
        const parsed = JSON.parse(raw) as ReworkLedgerLine;
        if (parsed && parsed.v === 1) keys.add(lineKey(parsed));
      } catch {
 // 坏行跳过
      }
    }
  } catch {
 // 读失败按空台账(首写会整体重建)
  }
  return keys;
}

/**
 * 台账 → 开工简报「预防检查单」行(残留②:预防件只有台账与简报两个
 * 消费面,D 是给网关 brief 的**可复用渲染器**,本次只实现函数+单测)。
 * 口径:取带 prevention 的链(单例不成规已在落账时保证 ≥2 次)→ 按 note 去重并累计次数
 * → 只留「该链的 logicalKey/path 路径段在 taskText 中出现」(边界匹配,复用 A 的小工具:
 * 本任务不碰 rework-chain.ts 就不把它的历史预防件塞进简报)→ 次数降序取前 3 行。
 * 行文案固定 `- 预防检查单(历史返工≥2):<note>`(无责归因:只说缺哪道检查)。taskText 为空
 * 或无命中 → []。纯函数,不读盘、不 throw。
 */
export function renderPreventionLines(chains: ReworkLedgerLine[], taskText: string): string[] {
  const text = typeof taskText === "string" ? taskText : "";
  if (text.trim() === "") return [];
  const counted = new Map<string, number>();
  for (const line of chains) {
    if (!("fixSession" in line)) continue; // 扇出簇无 prevention
    const prevention = line.prevention;
    if (!prevention || typeof prevention.note !== "string" || prevention.note === "") continue;
    const tokens = [...pathSegmentTokens(line.path ?? ""), ...pathSegmentTokens(line.logicalKey ?? "")];
    if (!tokens.some((token) => containsBoundedToken(text, token))) continue;
    counted.set(prevention.note, (counted.get(prevention.note) ?? 0) + 1);
  }
  return [...counted.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([note]) => `- 预防检查单(历史返工≥2):${note}`);
}

/** 台账读视图:链与簇分开返回(面板/机制 brief 消费)。 */
export function readReworkChains(root: string): { chains: ReworkChainLine[]; fanoutClusters: FanoutClusterLine[]; badLines: number } {
  const out = { chains: [] as ReworkChainLine[], fanoutClusters: [] as FanoutClusterLine[], badLines: 0 };
  const file = reworkChainsPath(root);
  if (!existsSync(file)) return out;
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      try {
        const parsed = JSON.parse(raw) as ReworkLedgerLine;
        if (!parsed || parsed.v !== 1) { out.badLines++; continue; }
        if ("fixSession" in parsed) out.chains.push(parsed);
        else out.fanoutClusters.push(parsed);
      } catch {
        out.badLines++;
      }
    }
  } catch {
 // 读失败按空
  }
  return out;
}
