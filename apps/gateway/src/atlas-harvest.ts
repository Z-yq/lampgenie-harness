/**
 * 项目世界模型确定性采集器。
 * 背景(mechanisms.md #217「项目方向总览与活代码档案」):atlas 的 store/机制/快照都在,
 * 但 11-11 首跑后再无生产者——快照停在首跑日,「世界模型」没有生成闭环。本模块从 journal
 * 会话**确定性**挖掘「derived 层」:主题簇(在做什么)/模块活动(哪里在被反复改)/
 * 返工信号(同一文件先建后修的跨会话链)/噪声账(内部会话过滤数),合入快照的 `derived` 字段。
 * 与 curated 层的分工:entries.jsonl(goal/change/conflict/decision/defects)仍是人工/机制
 * 断言的审计事实,append-only;derived 层是**可重算的观察**,每次 refresh 覆写,不冒充结论。
 * 消费面:会话开工「方向简报」(renderAtlasStartBrief)+ atlas 机制 brief(读快照目录)。
 * 归因口径(v1,登记):会话归属 = 事件里首个 `payload.projectId`;无归属会话计入目标项目
 * (网关自仓的多数工作会话不带 projectId);`__harness__` 视同网关自仓;跨项目 UUID 排除。
 * 噪声 = sessionId 含 probe/smoke/rsi/super/prompt-live(内部与测试面,不进方向判断)。
 * 依赖纪律:node:fs/node:path + direction-atlas-store(同仓 IO);不引 agent loop、不碰时钟
 * (now 可注入);坏行/坏文件 fail-soft 跳过并计数。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DirectionAtlas } from "@lampgenie/runtime/agent/direction-atlas";
import { atlasJsonPath, build, writeAtlasFile } from "./direction-atlas-store.js";

/** 单会话的采集视图。 */
export interface HarvestedSession {
  sessionId: string;
  title: string;
  editedPaths: string[];
  tokens: number;
 /** 最后一条 delivery.obligation 的 state(无投递义务=undefined,如问答会话)。 */
  terminal?: string;
  mtimeMs: number;
}

/** 归因后的工作会话(病理检测等下游也消费;projectId 保留供过滤方复核)。 */
export interface HarvestWorkSession extends HarvestedSession {
 /** 本会话 read_file 过的路径(返工归因:决策时信息可得性的确定性代理;cap 400)。 */
  readPaths?: string[];
 /** 勘察文本(grep/code_sense/terminal 的参数原文,截断; 自评注意:只看 readPaths
 * 会把「用 grep/terminal 查过影响面」的会话误判成「信息未取」——归因必须三渠道都认)。 */
  probeTexts?: string[];
 /** 首条用户消息是问答类(解析时对全文判,标题截断后问号会丢—— v2 去伪)。 */
  isQuestion?: boolean;
  projectId?: string;
}

/** 会话收集结果:harvest 与 pathology 接线共用的底层视图。 */
export interface CollectedSessions {
  sessions: HarvestWorkSession[];
  sessionsScanned: number;
  noiseSessions: number;
  unattributedIncluded: number;
}

/** 主题簇:v1 用标题关键词贪心聚类(≥2 会话才算主题,单会话是孤例不进方向)。 */
export interface AtlasTheme {
  id: string;
  keywords: string[];
  sessions: number;
  titles: string[];
  firstSeen: string;
  lastSeen: string;
}

/** 模块活动:同一路径被多少个不同会话编辑(重复探索/热点最直接的信号)。 */
export interface AtlasModuleActivity {
  path: string;
  editSessions: number;
  sampleSessions: string[];
  firstSeen: string;
  lastSeen: string;
 /** 结构上下文(code_sense 索引:改这个模块会波及什么。 */
  context?: {
    upstream: number;
    downstream: number;
    isEntrypoint: boolean;
    riskLevel: "high" | "medium" | "low";
  };
}

/** 返工信号:同一路径先被「建设类」会话编辑、窗口内又被「修复类」会话编辑(点对点链 v1 签名)。 */
export interface AtlasReworkSignal {
  path: string;
  buildSession: string;
  fixSessions: string[];
  gapMs: number;
}

/** 返工链台账摘要(进快照 derived;refresh 时从 rework-chains.jsonl 读入)。 */
export interface AtlasReworkSummary {
  chains: number;
  fanoutClusters: number;
 /** 「影响面未闭合」簇 top3(build 会话 + 修复数 + 涉及逻辑单元数)。 */
  impactNotClosed: Array<{ buildSession: string; fixes: number; units: number }>;
}

/** derived 层整体(覆盖式写入快照)。 */
export interface AtlasHarvest {
  reworkChains?: AtlasReworkSummary;
  harvestedAt: string;
  windowDays: number;
  projectKey: string;
  sessionsScanned: number;
  noiseSessions: number;
  unattributedIncluded: number;
  themes: AtlasTheme[];
  moduleActivity: AtlasModuleActivity[];
  reworkSignals: AtlasReworkSignal[];
 /** P1:近窗口被 ≥3 个不同会话 read_file 的路径 top10(重复探索浪费信号)。 */
  repeatExploration?: Array<{ path: string; sessions: number }>;
}

/** 修复类标题判据(中文动词优先;英文 fix/bug/regress 兜底)。 */
const FIX_TITLE_RE = /修复|修正|修一下|改错|回归|补丁|排查|fix|bug|regress/i;

/** 噪声会话 id 判据。 */
// 监督轮注意:未锚定的 `super` 子串把 supervise-* 会话误杀为噪声——super 只匹配
// 指挥台自身会话(super / super:日期 / super-*),不许吞同前缀词(supervise)。
const NOISE_SESSION_RE = /probe|smoke|^rsi$|^rsi-|^super$|^super[:.-]|prompt-live/i;

const DAY_MS = 86_400_000;
const TITLE_MAX_CHARS = 160;
const MAX_THEMES = 6;
const MAX_MODULES = 15;
const MAX_REWORK = 8;

function toIso(ms: number): string {
  return new Date(Number.isFinite(ms) ? Math.trunc(ms) : 0).toISOString();
}

/** 标题分词:CJK 二元组 + 拉丁词;去停用词与过短片段。 */
function titleKeywords(title: string): string[] {
  const out = new Set<string>();
  const text = String(title ?? "").toLowerCase();
  const latin = text.match(/[a-z][a-z0-9_.-]{2,}/g) ?? [];
  for (const word of latin) out.add(word);
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    if (run.length === 1) out.add(run);
  }
  return [...out].filter((k) => !STOPWORDS.has(k)).slice(0, 24);
}

/**
 * (S3 种子):标题/主题 token 是否**全部**被停用词吸收——主题晋升 goal 回收判据。
 * 空/无 token → false(不回收,宁漏勿误);tokenize 与 titleKeywords 同口径(过滤前全集)。
 */
export function isAllStopwords(title: string): boolean {
  const text = String(title ?? "").toLowerCase();
 // 拉丁按连字符/下划线/点断子词——slugOf 用 `-` 拼接关键词(187-195),判据须与其互逆,
 // 否则「missing-implemented」成整 token 而 STOPWORDS 只有分词形态,恒判不中。
  const tokens: string[] = text.match(/[a-z][a-z0-9]*/g) ?? [];
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    if (run.length === 1) tokens.push(run);
  }
  if (tokens.length === 0) return false;
  return tokens.every((t) => STOPWORDS.has(t));
}

const STOPWORDS: ReadonlySet<string> = new Set<string>([
  "the", "and", "for", "with", "this", "that", "from", "into", "用户", "要求", "继续", "一个", "一下",
  "进行", "使用", "需要", "可以", "没有", "已经", "目前", "所有", "这些", "下面", "以上",
 // atlas 机制注意「主题榜前三 51/171 是抽取噪声」:机制矩阵状态词与系统提示词
 // 霸榜(missing×36/工具×9/task-phase×6)——它们是任务标题里的流程词,不是开发方向。
  "missing", "implemented", "partial", "mechanism", "step", "task-phase", "phase", "tools", "tool",
  "agent", "panel", "session", "fix", "test", "tests", "tasks", "update", "add", "refactor",
  "工具", "任务", "文件", "步骤", "机制", "面板",
 // 优化(atlas 机制注意「主题簇关键词取自任务书样板」):任务书样板句的高频词
 // 不是开发方向——它们出现在每个任务的标题里(「背景」「用户是」「口径」「优化」)。
  "背景", "口径", "优化", "修复", "问题", "开发", "功能", "实现", "分析", "处理",
  "lampgenie-harness", "genie", // 仓名不是方向(每个任务标题都含)
]);

/**
 * 路径的逻辑单元归一( atlas 机制注意「safe-restart 返工被记两次,虚高一半」):
 * 脚本与其同名测试是同一个逻辑变更——去扩展名与测试后缀后 stem 相同的路径归并为一个键。
 * `x.test.ts` 与 `x.ts` → `x`;`scripts/x.cjs` 与 `scripts/x.test.ts` → 同 stem。
 */
export function logicalPathKey(path: string): string {
  const posix = String(path ?? "").split("\\").join("/");
  const withoutExt = posix.replace(/\.(m|c)?[jt]sx?$/i, "").replace(/\.(py|rb|go|rs|c|cpp|sh|cjs|mjs|mts|cts)$/i, "");
  return withoutExt.replace(/\/__tests__\//g, "/").replace(/[.-](test|spec|_test)$/i, "");
}

function slugOf(keywords: string[]): string {
  return (
    keywords
      .slice(0, 2)
      .map((k) => k.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-"))
      .filter((s) => s !== "")
      .join("-") || "theme"
  );
}


/** 单会话单遍解析:首条用户消息/编辑路径/projectId/token/终态;坏行计数返回。 */
function parseSessionFile(file: string, sessionId: string): { parsed?: HarvestWorkSession; badLines: number } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { badLines: 0 };
  }
  let title = "";
  let isQuestion = false;
  const edited = new Set<string>();
  const reads = new Set<string>();
  const probes: string[] = [];
  let tokens = 0;
  let projectId: string | undefined;
  let terminal: string | undefined;
  let badLines = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let event: { kind?: unknown; payload?: Record<string, unknown> };
    try {
      event = JSON.parse(raw) as { kind?: unknown; payload?: Record<string, unknown> };
    } catch {
      badLines++;
      continue;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.kind) {
      case "message.user": {
        if (title === "" && typeof payload.text === "string" && payload.text.trim() !== "") {
          const full = payload.text.trim();
 // atlas 机制注意「主题被系统纪律卡污染」:任务书=用户首句+## 核心纪律卡
 // 模板(task_phase 等模板词成为假主题×13 会话)。标题只取首个 ## 段之前的用户原文。
          const cut = full.indexOf("\n## ");
          title = (cut > 0 ? full.slice(0, cut) : full).slice(0, TITLE_MAX_CHARS);
 // 全文判问答(截断后问号会丢;v2.1 生产注意:问答会话可能整条无问号——
 // 「把之前的产物结果罗列一下给我,我看看质量如何」。改用系统已注入的任务类别卡
 // 「问答/调研类任务」+ 首段问号双判据,这是 classifyTaskClass 的确定性产物)。
          if (/[?？]/.test(full.slice(0, 800)) || full.slice(0, 800).includes("问答/调研类任务")) isQuestion = true;
        }
        break;
      }
      case "tool.call": {
        if (payload.name === "edit_file" || payload.name === "write_file" || payload.name === "multi_edit") {
          const path = pathOfArgs(payload.arguments);
          if (path !== "") edited.add(path);
        } else if (payload.name === "read_file") {
 // 返工归因需要:A 决策时读过什么(信息可得性判据的确定性代理)。
          const path = pathOfArgs(payload.arguments);
          if (path !== "" && reads.size < 400) reads.add(path);
        } else if (payload.name === "grep" || payload.name === "code_sense" || payload.name === "terminal") {
 // 自评证伪修复:勘察动作的参数原文也要进归因证据(readPaths 只覆盖 read_file,
 // 会把 grep/terminal 查过影响面的会话误判「信息未取」——生产 3/3 抽查全中)。
          if (probes.length < 300) probes.push(String(payload.arguments ?? "").slice(0, 300));
        }
        break;
      }
      case "llm.trace": {
        const usage = payload.usage as { totalTokens?: unknown } | undefined;
        const total = usage?.totalTokens;
        if (typeof total === "number" && Number.isFinite(total)) tokens += total;
        break;
      }
      case "delivery.obligation": {
        if (typeof payload.state === "string") terminal = payload.state;
        break;
      }
      default: {
        if (projectId === undefined && typeof payload.projectId === "string" && payload.projectId !== "") {
          projectId = payload.projectId;
        }
        break;
      }
    }
  }
  if (title === "" && edited.size === 0) return { badLines }; // 空会话/无工作痕迹:不进方向统计
  return {
    parsed: {
      sessionId,
      title,
      editedPaths: [...edited],
      readPaths: [...reads],
      probeTexts: probes,
      ...(isQuestion ? { isQuestion: true } : {}),
      tokens,
      ...(terminal !== undefined ? { terminal } : {}),
      mtimeMs: 0,
      ...(projectId !== undefined ? { projectId } : {}),
    },
    badLines,
  };
}

/** 工具参数取 path:arguments 可能是 JSON 字符串也可能是对象;multi_edit 取首个 path。 */
function pathOfArgs(args: unknown): string {
  let value = args;
  if (typeof value === "string" && value.trim() !== "") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return "";
    }
  }
  if (value === null || typeof value !== "object") return "";
  const rec = value as Record<string, unknown>;
  if (typeof rec.path === "string" && rec.path.trim() !== "") return rec.path.trim();
  const edits = rec.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit !== null && typeof edit === "object") {
        const p = (edit as Record<string, unknown>)["path"];
        if (typeof p === "string" && p.trim() !== "") return p.trim();
      }
    }
  }
  return "";
}

export interface HarvestOptions {
  windowDays?: number;
  now?: number;
 /** 额外计入的 projectId(缺省只收无归属 + __harness__)。 */
  includeProjectIds?: string[];
 /** 主题最少会话数(缺省 2:单会话孤例不进方向)。 */
  minThemeSessions?: number;
 /**
 * 项目注册表(projectId → 绝对根目录)的可注入视图。
 * 动机:会话 payload.projectId 绑到「非本快照项目」时旧口径一律丢弃——但夜间跑/切项目跑的
 * 会话编辑路径全落在本项目根下,属于本项目的工作却进了噪声账。这里留纯数据注入位,
 * 生产调用方传网关真源 ProjectStore(apps/gateway/src/projects.ts:resolveWorkdir)的
 * id→path 映射;不传 = 不做路径族兜底(行为与旧版逐字一致)。
 */
  projectRoots?: Record<string, string>;
}

/**
 * 从项目注册表落盘文件读出 projectId → 根目录(J 兜底的真源接线)。
 * 真源:`<journalDir>/projects.json`(网关 ProjectStore 的落盘位置,apps/gateway/src/app.ts:415
 * `join(opts.journalDir, "projects.json")`;结构见 apps/gateway/src/projects.ts:100-104
 * `{ projects: ProjectEntry[], activeProjectId }`,ProjectEntry 带 id/path)。
 * 只读、fail-soft:文件缺失/坏 JSON/条目缺 id 或 path → 跳过该条(不 throw);
 * `remote:` 远程 identity 不是本地路径,不进映射(避免拿远端串当后缀比较)。
 * 生产调用方一行即可接上:`collectWorkSessions(dir, { projectRoots: loadProjectRoots(dir) })`。
 */
export function loadProjectRoots(journalDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(join(journalDir, "projects.json"), "utf8");
  } catch {
    return out;
  }
  try {
    const parsed = JSON.parse(raw) as { projects?: Array<{ id?: unknown; path?: unknown }> };
    for (const entry of parsed.projects ?? []) {
      const id = typeof entry?.id === "string" ? entry.id : "";
      const path = typeof entry?.path === "string" ? entry.path : "";
      if (id === "" || path === "" || path.startsWith("remote:")) continue;
      out[id] = path;
    }
  } catch {
    return {};
  }
  return out;
}

/**
 * 路径是否落在某根目录下(项目归因兜底)。
 * 口径:绝对路径按「根 + 分隔符」前缀严格判定(不吃 `/a/bc` 被 `/a/b` 吞的假命中);
 * 相对路径视为以会话 workdir 为锚点 —— 会话已在册项目里,相对编辑路径天然在该根内。
 * 分隔符 Windows/Posix 统一成 `/`,根尾斜杠先剥掉。
 */
function pathUnderRoot(path: string, root: string): boolean {
  const p = path.trim().replace(/\\/g, "/");
  const r = root.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === "" || r === "") return false;
  const isAbsolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  if (!isAbsolute) return true; // 相对路径:锚在会话 workdir,无法更细分辨 → 认作根内
  return p === r || p.startsWith(`${r}/`);
}

/**
 * 按「编辑路径族」给跨项目会话兜底归因(J 兜底)。
 * 动机:payload.projectId 绑到别的项目(切项目跑/夜间跑/迁移后的旧会话)时,旧口径整会话丢弃;
 * 但它的编辑路径全落在本项目根下 → 它改的就是本项目代码。判据刻意保守:
 * **全部** editedPaths 都要在某一个 include 项目根内(混合路径 → 不认),空编辑路径 → 不认。
 * 多个候选根命中(嵌套项目)时取最长根(最具体);没注入 projectRoots → 恒 undefined(旧行为)。
 */
function attributeByEditedPaths(
  editedPaths: string[],
  include: Set<string>,
  projectRoots: Record<string, string> | undefined,
): string | undefined {
  if (projectRoots === undefined || editedPaths.length === 0) return undefined;
  let best: { id: string; depth: number } | undefined;
  for (const [id, root] of Object.entries(projectRoots)) {
    if (!include.has(id)) continue;
    if (typeof root !== "string" || root.trim() === "") continue;
    if (!editedPaths.every((path) => pathUnderRoot(path, root))) continue;
    const depth = root.replace(/\\/g, "/").replace(/\/+$/, "").length;
    if (best === undefined || depth > best.depth) best = { id, depth };
  }
  return best?.id;
}

/**
 * 会话收集(底层视图):窗口内 + 噪声过滤 + 项目归因;harvest 与 pathology 接线共用。
 * 纯读不写;journalDir 不存在 → 空结果(不 throw)。
 */
export function collectWorkSessions(journalDir: string, opts: HarvestOptions = {}): CollectedSessions {
  const windowDays = typeof opts.windowDays === "number" && opts.windowDays > 0 ? Math.floor(opts.windowDays) : 7;
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const include = new Set<string>(["__harness__", ...(opts.includeProjectIds ?? []).map((id) => String(id))]);
  const out: CollectedSessions = { sessions: [], sessionsScanned: 0, noiseSessions: 0, unattributedIncluded: 0 };

  let files: string[] = [];
  try {
    files = readdirSync(join(journalDir, "sessions")).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return out;
  }
  for (const name of files) {
    const file = join(journalDir, "sessions", name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > windowDays * DAY_MS) continue;
    const sessionId = name.replace(/\.jsonl$/, "");
    if (NOISE_SESSION_RE.test(sessionId)) {
      out.noiseSessions++;
      continue;
    }
    out.sessionsScanned++;
    const { parsed } = parseSessionFile(file, sessionId);
    if (parsed === undefined) continue;
    parsed.mtimeMs = mtimeMs;
    const attributed = parsed.projectId;
    if (attributed !== undefined && !include.has(attributed)) {
 // (J 兜底):绑到别项目的会话,若编辑路径全落在本项目根下 → 按路径族归给本项目。
      const fallback = attributeByEditedPaths(parsed.editedPaths, include, opts.projectRoots);
      if (fallback === undefined) continue; // 跨项目会话:不计入本项目
      parsed.projectId = fallback;
    }
    if (parsed.projectId === undefined) out.unattributedIncluded++;
    out.sessions.push(parsed);
  }
  out.sessions.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

/**
 * 采集 derived 层。projectKey 只做记录(快照归属由 refresh 决定);归因口径见文件头。
 * 纯读,不写任何文件;journalDir 不存在 → 空采集(不 throw)。
 */
export function harvestAtlas(journalDir: string, projectKey: string, opts: HarvestOptions = {}): AtlasHarvest {
  const windowDays = typeof opts.windowDays === "number" && opts.windowDays > 0 ? Math.floor(opts.windowDays) : 7;
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const minThemeSessions = typeof opts.minThemeSessions === "number" && opts.minThemeSessions > 0 ? opts.minThemeSessions : 2;
  const collected = collectWorkSessions(journalDir, opts);
  const sessions = collected.sessions;

  const base: AtlasHarvest = {
    harvestedAt: toIso(now),
    windowDays,
    projectKey,
    sessionsScanned: collected.sessionsScanned,
    noiseSessions: collected.noiseSessions,
    unattributedIncluded: collected.unattributedIncluded,
    themes: [],
    moduleActivity: [],
    reworkSignals: [],
  };

 // ── 主题簇:关键词 → 会话集合,按会话数贪心取前 6(每会话只归入首个命中的主题) ──
  const keywordSessions = new Map<string, { sessions: HarvestWorkSession[]; keywords: string[] }>();
  for (const session of sessions) {
    const keywords = titleKeywords(session.title);
    for (const keyword of keywords) {
      const entry = keywordSessions.get(keyword) ?? { sessions: [], keywords: [] };
      entry.sessions.push(session);
      keywordSessions.set(keyword, entry);
    }
  }
  const ranked = [...keywordSessions.entries()]
    .filter(([, entry]) => entry.sessions.length >= minThemeSessions)
    .sort((a, b) => b[1].sessions.length - a[1].sessions.length || a[0].localeCompare(b[0]));
  const claimed = new Set<string>();
  for (const [keyword, entry] of ranked) {
    if (base.themes.length >= MAX_THEMES) break;
    const fresh = entry.sessions.filter((s) => !claimed.has(s.sessionId));
    if (fresh.length < minThemeSessions) continue;
    for (const s of fresh) claimed.add(s.sessionId);
    base.themes.push({
      id: slugOf([keyword]),
      keywords: [keyword],
      sessions: fresh.length,
      titles: fresh.slice(-3).map((s) => (s.title.length > 60 ? s.title.slice(0, 60) + "…" : s.title)),
      firstSeen: toIso(fresh[0]!.mtimeMs),
      lastSeen: toIso(fresh[fresh.length - 1]!.mtimeMs),
    });
  }

 // ── 模块活动:路径 → 编辑会话数(去重),按会话数取前 15 ──
  const moduleMap = new Map<string, HarvestWorkSession[]>();
  for (const session of sessions) {
    for (const path of session.editedPaths) {
      const list = moduleMap.get(path) ?? [];
      list.push(session);
      moduleMap.set(path, list);
    }
  }
  base.moduleActivity = [...moduleMap.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_MODULES)
    .map(([path, list]) => ({
      path,
      editSessions: list.length,
      sampleSessions: list.slice(-4).map((s) => s.sessionId),
      firstSeen: toIso(list[0]!.mtimeMs),
      lastSeen: toIso(list[list.length - 1]!.mtimeMs),
    }));

 // code_sense 结构层集成:为热点模块补充依赖上下文(上游/下游/入口/风险)。
 // enrichModuleContext 在 refreshAtlasSnapshot 调用(那里有 repoRoot);此处不调

 // ── 返工信号:同一逻辑单元(路径按 logicalPathKey 归并,脚本+同名测试=1 个变更),
 // 先有非修复会话编辑、其后 7 天内有修复类会话再编辑 ──
 // atlas 机制注意:按裸路径记会把「safe-restart.cjs + 其 .test.ts」记成两条,虚高一半。
  const logicalMap = new Map<string, { display: string; sessions: HarvestWorkSession[] }>();
  for (const session of sessions) {
    for (const path of session.editedPaths) {
      const key = logicalPathKey(path);
      const entry = logicalMap.get(key) ?? { display: path, sessions: [] };
      entry.sessions.push(session);
      logicalMap.set(key, entry);
    }
  }
  const rework: AtlasReworkSignal[] = [];
  for (const [, entry] of logicalMap) {
    if (rework.length >= MAX_REWORK) break;
    const list = [...entry.sessions].sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (let i = 0; i < list.length; i++) {
      const builder = list[i]!;
      if (FIX_TITLE_RE.test(builder.title)) continue;
      const fixes = list.slice(i + 1).filter((s) => FIX_TITLE_RE.test(s.title) && s.mtimeMs - builder.mtimeMs <= 7 * DAY_MS);
      if (fixes.length === 0) continue;
      rework.push({
        path: entry.display,
        buildSession: builder.sessionId,
        fixSessions: fixes.map((s) => s.sessionId),
        gapMs: fixes[0]!.mtimeMs - builder.mtimeMs,
      });
      break; // 每逻辑单元只记最近一条建设→修复链(v1 不追多代)
    }
  }
  base.reworkSignals = rework.sort((a, b) => a.gapMs - b.gapMs).slice(0, MAX_REWORK);
 // P1 重复探索:≥3 会话 read_file 同一路径(每会话只算一次)
  {
    const readBy = new Map<string, Set<string>>();
    for (const session of sessions) {
      for (const rp of session.readPaths ?? []) {
        const set = readBy.get(rp) ?? new Set<string>();
        set.add(session.sessionId);
        readBy.set(rp, set);
      }
    }
    base.repeatExploration = [...readBy.entries()]
      .filter(([, ids]) => ids.size >= 3)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 10)
      .map(([rp, ids]) => ({ path: rp, sessions: ids.size }));
  }
  return base;
}

export interface RefreshAtlasResult {
  ok: boolean;
  code?: string;
  harvest?: AtlasHarvest;
  path?: string;
}

/**
 * 生成闭环:harvest → build(curated 事件重放)→ 快照合入 derived 层 → 落盘。
 * 每日(nightly update-graph 之后)与按需(机制收尾/人工)调用;derived 覆写,curated 不动。
 */
export function refreshAtlasSnapshot(
  root: string,
  projectKey: string,
  opts: HarvestOptions & { journalDir: string; reworkSummary?: AtlasReworkSummary },
): RefreshAtlasResult {
  const harvest = harvestAtlas(opts.journalDir, projectKey, opts);
 // code_sense 结构层集成:为热点模块补充依赖上下文(fail-soft,索引缺→context 不赋值)
  try { enrichModuleContext(harvest.moduleActivity, root); } catch { /* 索引不可读 */ }
  const built = build(root, projectKey);
  if (!built.ok || built.atlas === undefined) return { ok: false, code: built.code ?? "ATLAS_STORE_ERROR", harvest };
 // 返工因果链摘要由调用方(nightly)从台账读出传入(依赖单向:rework-chain → atlas-harvest)。
  const atlas: DirectionAtlas & { derived?: AtlasHarvest } = {
    ...built.atlas,
    derived: { ...harvest, ...(opts.reworkSummary !== undefined ? { reworkChains: opts.reworkSummary } : {}) },
  };
  const path = atlasJsonPath(root, projectKey);
  if (!writeAtlasFile(path, atlas)) return { ok: false, code: "ATLAS_STORE_ERROR", harvest };
  return { ok: true, harvest, path };
}

/* ------------------------------------------------------------------ *
 * 开工方向简报(消费面)
 * ------------------------------------------------------------------ */

const BRIEF_MAX_CHARS = 600;

/** 快照的宽松读视图(renderAtlasStartBrief 用;derived 可能缺)。 */
interface AtlasBriefView {
  goals?: Array<{ id?: unknown; title?: unknown; status?: unknown }>;
 /** agent 推进轨迹叠加层( super agent 管理主线;goalId → 按时间序的行)。 */
  goalProgress?: Record<string, Array<{ at?: unknown; note?: unknown; nextStep?: unknown }>>;
  timeline?: Array<{ reason?: unknown; from?: unknown; to?: unknown; at?: unknown }>;
  conflicts?: Array<{ status?: unknown; detail?: unknown }>;
  defectGenes?: Array<{ defectClass?: unknown; module?: unknown; count?: unknown; lastAt?: unknown }>;
  generatedAt?: unknown;
  derived?: AtlasHarvest;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** 任务/主线标题的匹配 token:ascii 词(≥3 字符,小写)+ CJK 二元组(与 world-model-tool 同口径)。 */
function goalMatchTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) ?? []) tokens.add(m.toLowerCase());
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** 两 token 集的交集大小(≥3 视为同主线;纯口径:交集比 Jaccard 更容错短标题)。 */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/** defectClass → 开工提示语(确定性映射;未列类别不出行)。 */
const DEFECT_CLASS_HINTS: Record<string, string> = {
  boundary: "先枚举被操作实体的取值全集(空值/边界)逐分支核对",
  contract: "先列出全部调用方/消费方并核对签名与语义",
  concurrency: "涉及共享状态先写明时序假设与失效条件",
  "missing-test": "先写边界测试再实现",
};

/** token 是否以「非标识符边界」出现在文本里(避免 panel.ts 命中 panel.tsx)。 */
function containsBoundedToken(text: string, token: string): boolean {
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

/** 任务文本是否碰到该模块(路径段后缀匹配:文件名/去扩展名/末两段路径)。 */
function taskTouchesModule(text: string, module: string): boolean {
  if (text === "" || module === "") return false;
  const segments = module.split("/").filter((s) => s !== "");
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1]!;
  const stem = base.replace(/\.[^./]+$/, "");
  const tokens = new Set<string>([base]);
  if (stem !== base && stem.length >= 3) tokens.add(stem);
  if (segments.length >= 2) tokens.add(`${segments[segments.length - 2]}/${base}`);
  for (const token of tokens) if (containsBoundedToken(text, token)) return true;
  return false;
}

/**
 * 缺陷基因选择器(残留 3:基因只有写入没有消费)。
 * 动机:开工简报只需要「前 2 类 + 提示语」,但简报之外(机制 brief/夜报)要看到全部命中与真实
 * 权重 → 选择逻辑抽成导出函数,简报按自己的行数与字数预算截断。判据与旧版逐字相同:
 * class 必须在 DEFECT_CLASS_HINTS 里、模块词命中 taskText;taskText 空 → []。
 * 返回按 count 降序(并列时 class、module 字典序)的**全部**命中,聚合键是 (defectClass, module)。
 */
/** 基因治理:注入侧 TTL(设想的 confidence_decay;超期未强化的基因不注入)。 */
export const GENE_MAX_AGE_DAYS = 60;

/**
 * P4 tips 灰度 A/B:基于 gene id + 日期的确定性伪随机 rollout。
 * 同一天同一个基因对所有任务给同一个 arm(treated/control),隔天自动翻转——
 * 避免「同一天内 treated 和 control 各半但任务难度不同」的混杂。
 */
export function geneRolloutArm(geneId: string, at?: number): "treated" | "control" {
  const day = Math.floor((at ?? Date.now()) / 86_400_000);
  let hash = 0;
  const input = `${geneId}:${day}`;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 100) < 50 ? "treated" : "control";
}

export function matchedDefectGenes(
  atlasJson: unknown,
  taskText: string,
  opts: { moduleExists?: (module: string) => boolean; now?: number; rollout?: boolean } = {},
): Array<{ defectClass: string; module: string; count: number }> {
  const text = (taskText ?? "").trim();
  if (text === "") return [];
  const atlas = (atlasJson ?? {}) as AtlasBriefView;
  const now = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const byKey = new Map<string, { defectClass: string; module: string; count: number }>();
  for (const gene of atlas.defectGenes ?? []) {
    const cls = typeof gene.defectClass === "string" ? gene.defectClass.trim() : "";
    if (DEFECT_CLASS_HINTS[cls] === undefined) continue;
    if (typeof gene.module !== "string" || !taskTouchesModule(text, gene.module)) continue;
 // 治理内核:①使用时校验——模块文件已删=知识腐坏,不注入;②TTL——lastAt 超期不注入。
    if (opts.moduleExists !== undefined && !opts.moduleExists(gene.module)) continue;
    const lastAt = Date.parse(typeof gene.lastAt === "string" ? gene.lastAt : "");
    if (Number.isFinite(lastAt) && now - lastAt > GENE_MAX_AGE_DAYS * 86_400_000) continue;
    const count = typeof gene.count === "number" && Number.isFinite(gene.count) && gene.count > 0 ? gene.count : 1;
    const key = `${cls}\u0000${gene.module}`;
    const hit = byKey.get(key);
    if (hit === undefined) byKey.set(key, { defectClass: cls, module: gene.module, count });
    else hit.count += count;
  }
 // P4 灰度:control 组的基因不注入(返回空——nightly 统计按 arm 分组对账)
  const allGenes = [...byKey.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.defectClass.localeCompare(b.defectClass) ||
      a.module.localeCompare(b.module),
  );
 // P4 灰度 opt-in:rollout=true 时才按 arm 过滤(control 组不返回);缺省=false(全量,测试兼容)
  if ((opts as { rollout?: boolean }).rollout === true) {
    return allGenes.filter((g) => geneRolloutArm(`${g.defectClass}:${g.module}`, opts.now) === "treated");
  }
  return allGenes;
}

/**
 * B:edit_file 首次改动某模块时的基因提示工厂(每任务每模块最多一次)。
 * 快照是懒装载的(开工简报段才算),所以第一参传 getter;命中时 onHint 回调用于 journal 留痕。
 * 返回空串=无提示(不追加回执);模块键按 gene.module 去重(同一模块不同缺陷类合并成一段)。
 */
export function createDefectGeneEditHint(
  getAtlasJson: () => unknown,
  onHint?: (info: { path: string; modules: string[]; classes: string[] }) => void,
): (rel: string) => string | undefined {
  const hinted = new Set<string>();
  return (rel: string) => {
    const atlasJson = getAtlasJson();
    if (atlasJson === undefined || atlasJson === null) return undefined;
    const hits = matchedDefectGenes(atlasJson, rel).filter((h) => !hinted.has(h.module));
    if (hits.length === 0) return undefined;
    for (const h of hits) hinted.add(h.module);
    const modules = [...new Set(hits.map((h) => h.module))];
    const classes = [...new Set(hits.map((h) => h.defectClass))];
    try { onHint?.({ path: rel, modules, classes }); } catch { /* 留痕失败不阻塞编辑 */ }
    const lines = hits.slice(0, 2).map((h) => `- ${h.defectClass}×${h.count}(${h.module}):本模块此前返工过,改动前核对对应决策点(契约/边界/并发/测试)`);
    return `<system-reminder>\n本模块历史缺陷基因:\n${lines.join("\n")}\n</system-reminder>`;
  };
}

/**
 * P0 决策点动态注入(设想的「改签名前必须列出全部 caller 并核对」):
 * agent 首次编辑**高影响模块**(code_sense context.riskLevel=high)时,在 edit_file 回执
 * 注入强制提示——上游调用方数量 + radiation 工具指路。每任务每模块只注入一次。
 * 与基因提示(geneEditHint)并列,但语义不同:基因=「栽过跟头」,高影响=「改了会波及很多」。
 */
export function createHighImpactEditWarning(
  getAtlasJson: () => unknown,
  onWarn?: (info: { path: string; upstream: number; isEntrypoint: boolean }) => void,
): (rel: string) => string | undefined {
  const warned = new Set<string>();
  return (rel: string) => {
    const atlasJson = getAtlasJson() as { derived?: { moduleActivity?: AtlasModuleActivity[] } } | undefined | null;
    if (atlasJson === undefined || atlasJson === null) return undefined;
    const normalized = String(rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const modules = atlasJson.derived?.moduleActivity ?? [];
    const hit = modules.find((m) => {
      if (m.context?.riskLevel !== "high") return false;
      const mPath = m.path.replace(/\\/g, "/");
      return normalized === mPath || normalized.endsWith("/" + mPath) || mPath.endsWith("/" + normalized);
    });
    if (hit === undefined || hit.context === undefined) return undefined;
    if (warned.has(hit.path)) return undefined;
    warned.add(hit.path);
    try { onWarn?.({ path: hit.path, upstream: hit.context.upstream, isEntrypoint: hit.context.isEntrypoint }); } catch { /* 留痕失败不阻塞 */ }
    const entry = hit.context.isEntrypoint ? ",入口函数" : "";
    return `<system-reminder>\n⚠️ 高影响模块:${hit.path}(${hit.context.upstream} 个上游调用方${entry})\n此改动会波及大量调用方——动手前:\n1. 用 code_sense action=radiation target=<本文件的导出符号> 拿四分面辐射清单\n2. 核对清单中的上游调用方是否需要同步修改\n3. 确认影响面已闭合再继续编辑\n</system-reminder>`;
  };
}

/**
 * 本模块历史缺陷基因行(atlas curated 层 consumption):任务文本命中模块 → 按 defectClass
 * 汇合 count,降序取前 2 类;无命中/无基因/类别无提示语 → 空数组(零变化)。
 * 选择逻辑改由 matchedDefectGenes 提供,本函数只管「前 2 类 + 行文案」,输出逐字不变。
 */
function renderDefectGeneLines(atlas: AtlasBriefView, taskText: string, opts: { moduleExists?: (m: string) => boolean; now?: number } = {}): string[] {
  const text = taskText.trim();
  if (text === "") return [];
 // 委托 matchedDefectGenes(单一事实源;治理过滤——模块存在性+TTL——同源生效)
  const shown = matchedDefectGenes(atlas, text, opts);
  const byClass = new Map<string, number>();
  for (const g of shown) byClass.set(g.defectClass, (byClass.get(g.defectClass) ?? 0) + g.count);
  const rows = [...byClass.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows
    .slice(0, 2)
    .map(([cls, count]) => `- 本模块历史缺陷基因:${cls}×${count}——${DEFECT_CLASS_HINTS[cls]}`);
}

/**
 * 会话开工「方向简报」(mechanisms.md #217 消费面):当前有效方向 + 最近转向 + 未决冲突 +
 * 本周主题/热点模块/返工信号 + 本模块历史缺陷基因(需第二参 taskText 命中模块才有)。
 * 纯函数、无时间戳(稳定前缀,prompt cache 友好);空快照/空内容 → 空串(调用方按空串跳过注入)。
 */
export /**
 * code_sense 结构层集成:为热点模块补充依赖上下文。
 * 读 .genie/sense-index/<hash>/index.json,按文件分组统计上游/下游边数+入口标志+风险分级。
 * fail-soft:索引不可读/文件不在索引 → context 不赋值(保持 undefined)。
 */
function enrichModuleContext(modules: AtlasModuleActivity[], repoRoot: string): void {
 // 用顶层 import 的 readFileSync/readdirSync/join(已在文件头导入);不加 require——ES 模块上下文不可用

 // 找 lampgenie-harness 根的索引
  const senseDir = join(repoRoot, ".genie", "sense-index");
  if (!existsSync(senseDir)) return;
  let indexFile: string | undefined;
  for (const name of readdirSync(senseDir)) {
    const candidate = join(senseDir, name, "index.json");
    if (!existsSync(candidate)) continue;
    try {
      const meta = JSON.parse(readFileSync(candidate, "utf8")) as { root?: string };
      if (meta.root === repoRoot) { indexFile = candidate; break; }
    } catch { /* 坏索引跳过 */ }
  }
  if (indexFile === undefined) return;

  const index = JSON.parse(readFileSync(indexFile, "utf8")) as {
    nodes: Array<{ id: string; file: string; kind: string; symKind?: string }>;
    edges: Array<{ from: string; to: string }>;
  };

 // 按文件分组节点 ID
  const fileNodeIds = new Map<string, Set<string>>();
  for (const node of index.nodes) {
    const set = fileNodeIds.get(node.file) ?? new Set<string>();
    set.add(node.id);
    fileNodeIds.set(node.file, set);
  }
 // 入口节点集合(kind=entrypoint 的文件)
  const entryFiles = new Set<string>();
  for (const node of index.nodes) {
    if (node.kind === "entrypoint") entryFiles.add(node.file);
  }

 // 边统计:from→to,按文件归属(排除同文件内边)
  const upstreamCount = new Map<string, number>();
  const downstreamCount = new Map<string, number>();
  for (const edge of index.edges) {
    const fromFile = edge.from.split("#")[0]!;
    const toFile = edge.to.split("#")[0]!;
    if (fromFile === toFile) continue; // 同文件内边不算
    downstreamCount.set(fromFile, (downstreamCount.get(fromFile) ?? 0) + 1);
    upstreamCount.set(toFile, (upstreamCount.get(toFile) ?? 0) + 1);
  }

  for (const mod of modules) {
    const normalized = mod.path.replace(/\\/g, "/").replace(/^\.\//, "");
    const upstream = upstreamCount.get(normalized) ?? 0;
    const downstream = downstreamCount.get(normalized) ?? 0;
    const isEntrypoint = entryFiles.has(normalized);
 // 风险分级:高影响(≥10 上游)或入口 → high;中等(≥3)→ medium;其余 → low
    const riskLevel: "high" | "medium" | "low" =
      upstream >= 10 || isEntrypoint ? "high" : upstream >= 3 ? "medium" : "low";
    mod.context = { upstream, downstream, isEntrypoint, riskLevel };
  }
}

export function renderAtlasStartBrief(atlasJson: unknown, taskText?: string, extraLines: string[] = [], opts: { moduleExists?: (m: string) => boolean; now?: number } = {}): string {
  const atlas = (atlasJson ?? {}) as AtlasBriefView;
  const lines: string[] = [];
 // super agent 主线驱动:方向行带上进度轨迹与下一步(goal_progress 的 nextStep
 // 在这里显形——「下一步」是主线被持续推动的抓手);任务文本与主线标题相似时点名关联,
 // 提醒(验收第⑤步)据此只对真的有主线的项目注入。
  const progressOf = atlas.goalProgress ?? {};
  const activeGoalRows = (atlas.goals ?? []).filter((g) => g.status === "active").slice(0, 3);
  for (const goal of activeGoalRows) {
    if (typeof goal.title !== "string" || goal.title.trim() === "") continue;
    const goalId = typeof goal.id === "string" ? goal.id : "";
    const rows = goalId !== "" ? progressOf[goalId] ?? [] : [];
    const lastNote = [...rows].reverse().find((r) => typeof r.note === "string" && r.note.trim() !== "");
    const nextStep = [...rows].reverse().find((r) => typeof r.nextStep === "string" && r.nextStep.trim() !== "");
    const progressPart = rows.length > 0
      ? `(进度 ${rows.length}${lastNote ? ` · 最近:${clip(String(lastNote!.note).trim(), 36)}` : ""}${nextStep ? `;下一步:${clip(String(nextStep!.nextStep).trim(), 50)}` : ""})`
      : "";
    lines.push(`- 方向:${clip(goal.title.trim(), 80)}${progressPart}`);
  }
 // 任务-主线自动关联:标题 token 重叠 ≥3(ascii 词 + CJK 二元组)→ 点名「疑似推进」,
 // 把「任务做完登记证据」的钩子递到 agent 手边(只点一条,避免简报变成任务清单)。
  if (typeof taskText === "string" && taskText.trim() !== "") {
    const taskTokens = goalMatchTokens(taskText);
    let linked: { id: string; title: string } | undefined;
    let bestOverlap = 0;
    for (const goal of activeGoalRows) {
      if (typeof goal.title !== "string" || typeof goal.id !== "string") continue;
      const overlap = tokenOverlap(taskTokens, goalMatchTokens(goal.title));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        linked = { id: goal.id, title: goal.title };
      }
    }
    if (linked !== undefined && bestOverlap >= 3) {
      lines.push(`- 本任务疑似推进主线「${clip(linked.title, 50)}」——完成后用 world_model action=goal_progress goalId=${linked.id} 登记 note+evidence`);
    }
  }
  const turns = (atlas.timeline ?? []).slice(-2).reverse();
  for (const turn of turns) {
    if (typeof turn.reason === "string" && turn.reason.trim() !== "") {
      lines.push(`- 最近转向:${clip(turn.reason.trim(), 90)}`);
    }
  }
  const openConflicts = (atlas.conflicts ?? []).filter((c) => c.status !== "resolved").slice(0, 2);
  for (const conflict of openConflicts) {
    if (typeof conflict.detail === "string" && conflict.detail.trim() !== "") {
      lines.push(`- 未决冲突:${clip(conflict.detail.trim(), 80)}`);
    }
  }
 // 缺陷基因(消费面):放在 derived 统计之前,避免被 BRIEF_MAX_CHARS 截掉尾巴。
  for (const line of renderDefectGeneLines(atlas, taskText ?? "", opts)) lines.push(line);
 // (D 简报插槽):外部(机制 brief/夜报/工序纪律卡)可插自己的行——位置固定在
 // 缺陷基因之后、影响面未闭合簇(derived 统计)之前,保持「本项目的历史教训 → 全局统计」的
 // 信息梯度;默认空数组 → 输出与旧版逐字一致。
  for (const line of extraLines) {
    if (typeof line === "string" && line.trim() !== "") lines.push(line);
  }
  const derived = atlas.derived;
  if (derived?.reworkChains !== undefined && (derived.reworkChains.fanoutClusters ?? 0) > 0) {
    const worst = derived.reworkChains.impactNotClosed?.[0];
    lines.push(
      `- 影响面未闭合簇:${derived.reworkChains.fanoutClusters} 个${worst ? `(最重:${worst.buildSession} 引发 ${worst.fixes} 修/${worst.units} 单元)` : ""}——动手前用 code_sense action=radiation target=<符号> 拿四分面清单`,
    );
  }
  if (derived !== undefined) {
    for (const theme of (derived.themes ?? []).slice(0, 3)) {
      const sample = theme.titles[theme.titles.length - 1] ?? "";
      lines.push(
        `- 本周主题:「${clip(theme.id, 24)}」×${theme.sessions} 会话${sample !== "" ? ` · 例:${clip(sample, 50)}` : ""}`,
      );
    }
    for (const module of (derived.moduleActivity ?? []).slice(0, 3)) {
      if (module.editSessions < 2) continue;
 // code_sense 结构层:高影响模块加风险标注(≥10 上游或入口=高影响面)
      const ctx = module.context;
      const riskTag = ctx?.riskLevel === "high"
        ? ` ⚠️高影响(${ctx.upstream} 上游调用方${ctx.isEntrypoint ? ",入口" : ""})`
        : ctx?.riskLevel === "medium" ? ` (${ctx.upstream} 上游)` : "";
      lines.push(`- 热点模块:${module.path}(${module.editSessions} 会话在改${riskTag})`);
    }
    for (const signal of (derived.reworkSignals ?? []).slice(0, 2)) {
      lines.push(`- 返工信号:${signal.path}(先建后修 ${Math.round(signal.gapMs / 3_600_000)}h)`);
    }
    for (const rep of (derived.repeatExploration ?? []).slice(0, 2)) {
      lines.push(`- 重复探索:${rep.path}(近窗口 ${rep.sessions} 会话已读过——先查 wiki/代码档案再探索)`);
    }
  }
  if (lines.length === 0) return "";
  const header = "## 方向简报(项目世界模型;供开工参考,与当前任务冲突时以任务为准)";
  const body = lines.join("\n");
  const text = `${header}\n${body}`;
  return text.length > BRIEF_MAX_CHARS ? clip(text, BRIEF_MAX_CHARS) : text;
}
