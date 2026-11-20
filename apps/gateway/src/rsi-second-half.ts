/**
 * · RSI「后半句」零水流修复:周期集中器。
 * 背景(1604A 审计):后半句五判定全未达成——实验账本 0 条/证据图 6 节点 0 边/决策质量库
 * 不存在/Tool Foundry 零孵化/tool-upgrades·pins 空/prompt book 缺/ROI 只有成本侧。
 * 根因不是缺 store(全部在场),是**零生产写者**:没人调 linkEvidence/record/mine/
 * recordSavings/initBook。本模块在周期(finishCycle)把九项一次性接上水流:
 * ① 证据边配对:nightly 队列候选的 evidenceRefs(sessionId)∩图内 anti-pattern 节点
 * (source.note "session <sid>")→ 对同 ref 的 fact 节点落 supports 边(幂等 DUPLICATE 跳过);
 * ② Tool Foundry 孵化:journal 近窗 terminal 命令签名归一聚合(A1 跨会话重复检测)→
 * observe→mine(≥3 次 ≥2 会话)→shadow(journal 回放口径)→register(§14.2④ 机器闸:
 * data 层可逆+零风险)→data-tool 注册 + tool-upgrades init 首条 + 版本基线钉扎;
 * ③ 决策质量记账:实验登记/工具孵化/提示词版本三类机制裁决落 decisions.jsonl
 * (evidenceRefs 引 experiment id / foundry cand id / prompt rev;幂等 id 显式),
 * 周期 aggregate 聚合 patterns;
 * ④ 提示词书版本化:initBook(真实内置文本)→saveRevision v2(origin=rsi)→acceptDefault
 * 把 current 打回 1:版本序列在册、运行行为逐字不变(可回滚);
 * ⑤ ROI 节省侧:nightly 增量水位跳过的事件数 × 上周期 token/事件比 估算入账
 * (evidenceRefs 带方法与两处真源锚点;无真源不写,不造假);
 * ⑥ 熔断(breaker 0 字节):判定=非真缺口(ledger 只在 ROI pause/baseline 时写,
 * 零 adopt→零 baseline,从未触发即正常),本模块零行为改动,结论见 报告。
 * 纪律:全确定性零 LLM;每分项独立 try/catch fail-soft(器失败不挡周期);
 * 样本不足如实 pending/waiting,不凑数;幂等(重复 flush 不重复落盘)。
 * 依赖纪律:同仓 store 静态 import;不引 agent loop;IO 失败折叠进 codes 不 throw。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readQueue } from "./nightly-store.js";
import { addEvidence, linkEvidence, loadEvidenceGraph } from "./evidence-graph-store.js";
import { evaluateShadow, listCandidates, mine, observe, register, startShadow } from "./tool-foundry-store.js";
import { registerDataTool } from "./data-tool-store.js";
import { initUpgrade, listUpgrades } from "./tool-upgrade-store.js";
import { createPins } from "./tool-pins-store.js";
import { aggregate as dqAggregate, record as dqRecord, decisionsPath } from "./decision-quality-store.js";
import { acceptDefault, initBook, loadBook, saveRevision } from "./prompt-version-store.js";
import { recordSavings } from "./rsi-cost-store.js";

/** flush 汇总(逐分项计数;codes 聚合稳定码)。 */
export interface SecondHalfSummary {
  at: number;
  links: { added: number; skipped: number; nodes: number };
  foundry: { observed: number; candidates: number; registered: string[]; dataTools: string[]; upgrades: string[] };
  decisions: { recorded: number; patterns: number };
  promptBook: { initialized: boolean; revisions: string[] };
  savings: { entries: number; tokensSaved: number; method: string };
  pins: number;
  codes: string[];
}

/** 项目键(通用化):RSI 数据按「网关根目录名」分项目——不是硬编码 lampgenie-harness;
 * 打包发行/他人项目安装时,项目键自动跟随安装根(与 nightly run.projectId 同源)。 */
function projectKeyOf(root: string): string {
  const norm = String(root || "").replace(/[\\/]+$/, "");
  const base = norm.split(/[\\/]/).pop();
  return base !== undefined && base !== "" ? base : "project";
}

/* ------------------------------------------------------------------ *
 * ① 证据边配对:主张(fact)↔ 验证观察(anti-pattern)
 * ------------------------------------------------------------------ */

/** 落「主张-证据」supports 边;返回 {added, skipped, nodes}。nodes=本轮补建的会话级观察节点。 */
export function linkEvidenceFromCandidates(root: string, now: number): { added: number; skipped: number; nodes: number; codes: string[] } {
  const out = { added: 0, skipped: 0, nodes: 0, codes: [] as string[] };
 // 候选 → evidenceRefs(sessionId;全量读,包括已消费:配对是图治理,不依赖消费状态)。
  const pending = new Map<string, { sessions: string[]; reason: string; projectId: string }>();
  for (const line of readQueue(root)) {
    const candidate = (line as { candidate?: { id?: unknown; evidenceRefs?: unknown; reason?: unknown } ; projectId?: unknown }).candidate;
    const id = typeof candidate?.id === "string" ? candidate.id : "";
    if (id === "") continue;
    const sessions = Array.isArray(candidate?.evidenceRefs)
      ? candidate!.evidenceRefs!.filter((s): s is string => typeof s === "string")
      : [];
    const reason = typeof candidate?.reason === "string" ? candidate.reason : "";
    const projectId = typeof (line as { projectId?: unknown }).projectId === "string" ? String((line as { projectId: unknown }).projectId) : projectKeyOf(root);
    const prev = pending.get(id);
    pending.set(id, {
      sessions: prev ? [...new Set([...prev.sessions, ...sessions])] : sessions,
      reason: prev?.reason ?? reason,
      projectId: prev?.projectId ?? projectId,
    });
  }
  if (pending.size === 0) {
    out.codes.push("SECOND_HALF_LINK_NO_CANDIDATES");
    return out;
  }
 // 图索引:sessionId → anti-pattern 观察节点;候选 id → fact 节点(statement 尾 `(候选 <id>)`,精确全文匹配)。
  interface NodeLike { id: string; kind: string; statement: string; source?: { note?: unknown } }
  const { graph } = loadEvidenceGraph(root);
  const bySession = new Map<string, string[]>();
  const byCandId = new Map<string, string>();
  for (const node of Object.values(graph.nodes) as NodeLike[]) {
    const note = typeof node.source?.note === "string" ? node.source.note : "";
    const sessionMatch = /^session (\S+)$/.exec(note);
    if (node.kind === "anti-pattern" && sessionMatch !== null) {
      const sid = sessionMatch[1] ?? "";
      const list = bySession.get(sid) ?? [];
      list.push(node.id);
      bySession.set(sid, list);
    }
    if (node.kind === "fact") {
      const candMatch = /\(候选 ([\w-]+)\)$/.exec(node.statement);
      const candId = candMatch?.[1] ?? "";
      if (candId !== "") byCandId.set(candId, node.id);
    }
  }
 // 修2:上游字段补齐——1604A 点名「全部主张悬空无支撑」的根因不止是零边,还有
 // 「候选 evidenceRefs(会话清单)从未作为观察进图」。为 evidenceRef 会话补会话级验证观察节点
 // (source.note=session <sid>,statement 稳定幂等),「主张-证据」才在图内可表达。
 // 每候选最多补 5 个会话节点(其余会话的 journal 锚点已在 queue.evidenceRefs,不重复建)。
  const MAX_OBS_NODES_PER_CANDIDATE = 5;
  for (const [candId, entry] of pending) {
    const factId = byCandId.get(candId);
    if (factId === undefined) continue;
    let linked = 0;
    for (const sid of entry.sessions) {
      let antiIds = bySession.get(sid);
      if (antiIds === undefined || antiIds.length === 0) {
        if (out.nodes >= MAX_OBS_NODES_PER_CANDIDATE * pending.size || linked >= MAX_OBS_NODES_PER_CANDIDATE) break;
        const created = addEvidence(root, {
          kind: "anti-pattern",
          statement: `${entry.reason || "会话实证"}(观察 ${candId} @${sid})`,
          source: { note: `session ${sid}` },
          observedAt: now,
          projectId: entry.projectId,
        });
        if (!created.ok || created.id === undefined) continue;
        antiIds = [created.id];
        bySession.set(sid, antiIds);
        out.nodes += 1;
      }
      for (const antiId of antiIds) {
        const res = linkEvidence(root, {
          from: antiId,
          to: factId,
          type: "supports",
          note: ` 主张-证据配对:会话 ${sid} 的实证观察支撑候选 ${candId} 的主张`,
          at: now,
        });
        if (res.ok) {
          out.added += 1;
          linked += 1;
        } else if (res.code === "EVIDENCE_DUPLICATE") out.skipped += 1;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ② Tool Foundry 孵化链(journal terminal 签名聚合)
 * ------------------------------------------------------------------ */

/** 命令 → 签名:token 化 + 归一(绝对路径→<path>、文件名/相对路径→<file>、数字→<n>、环境赋值→K=…),取前 8 token。 */
export function signatureOfCommand(command: string): string {
  const raw = command.trim().length > 400 ? command.trim().slice(0, 400) : command.trim();
  if (raw === "") return "";
  const tokens = raw.split(/\s+/).map((token) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return `${token.slice(0, token.indexOf("="))}=…`;
    if (token.startsWith("/") && token.indexOf("/", 1) !== -1) return "<path>";
 // 数字(含小数)先于文件判定:45.6 的 .6 会像扩展名,顺序不能反。
    if (/^\d+(\.\d+)?$/.test(token)) return "<n>";
 // 修2:文件名/带扩展名路径归一为 <file>——真跑注意 566 观察 0 候选,根因是
 // 测试脚本/产物文件名(每个任务不同)把同一机械序列(设计 18 A2:cd+PATH+node <脚本>)分裂成
 // 无数单会话签名;参数化点正是该文件位,归一后才符合「固定前缀命令链反复出现」的检测语义。
    if (/\.[A-Za-z0-9]{1,4}$/.test(token) && !token.startsWith("-")) return "<file>";
    return token;
  });
  return tokens.slice(0, 8).join(" ");
}

interface SignatureStat {
 /** 会话 → 该会话内此签名是否全部成功(首条命令的回执口径)。 */
  sessions: Map<string, boolean>;
  sampleCommand: string;
}

/** 扫 journal 近窗会话,聚合跨会话重复的 terminal 命令签名(每会话每签名只计一次观察)。 */
export function harvestTerminalSignatures(
  journalDir: string,
  opts: { now: number; windowDays?: number; maxFiles?: number } = { now: 0 },
): { stats: Map<string, SignatureStat>; filesScanned: number } {
  const now = opts.now;
  const windowMs = (opts.windowDays ?? 7) * 86_400_000;
  const maxFiles = opts.maxFiles ?? 25;
  const stats = new Map<string, SignatureStat>();
  const sessionsDir = join(journalDir, "sessions");
  if (!existsSync(sessionsDir)) return { stats, filesScanned: 0 };
  let names: string[] = [];
  try {
    names = readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { stats, filesScanned: 0 };
  }
 // mtime 窗口过滤 + 新→旧排序 + 上限(近窗足够覆盖跨会话高频签名;防全量扫描拖慢)。
  const windowed: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    try {
      const st = statSync(join(sessionsDir, name));
      if (st.mtimeMs >= now - windowMs) windowed.push({ name, mtime: st.mtimeMs });
    } catch { /* 文件消失/不可读跳过 */ }
  }
  windowed.sort((a, b) => b.mtime - a.mtime);
  let filesScanned = 0;
  for (const { name } of windowed.slice(0, maxFiles)) {
    let text: string;
    try {
      text = readFileSync(join(sessionsDir, name), "utf-8");
    } catch {
      continue;
    }
    if (text.length > 5_000_000) continue; // 超大会话跳过(9p 慢盘保护)
    filesScanned += 1;
    const sid = name.replace(/\.jsonl$/, "");
 // 一遍扫描:terminal 调用 + 按工具调用 id 配对回执成败。
    const results = new Map<string, boolean>();
    const calls: Array<{ command: string; callId: string }> = [];
    for (const line of text.split("\n")) {
      if (!line.includes('"tool')) continue;
      let event: { kind?: unknown; payload?: { toolCallId?: unknown; name?: unknown; arguments?: unknown; content?: unknown } };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      const payload = event.payload ?? {};
      if (event.kind === "tool.call" && payload.name === "terminal" && typeof payload.arguments === "string") {
        try {
          const args = JSON.parse(payload.arguments) as { action?: unknown; command?: unknown; commands?: unknown };
          if (args.action !== "send") continue;
          const commands = Array.isArray(args.commands)
            ? args.commands.filter((c): c is string => typeof c === "string")
            : typeof args.command === "string" ? [args.command] : [];
          for (const command of commands) {
            calls.push({ command, callId: String(payload.toolCallId ?? "") });
          }
        } catch { /* 参数非 JSON 跳过 */ }
      } else if (event.kind === "tool.result" && payload.name === "terminal" && typeof payload.content === "string") {
        try {
          const content = JSON.parse(payload.content) as { ok?: unknown };
          results.set(String(payload.toolCallId ?? ""), content.ok === true);
        } catch {
          results.set(String(payload.toolCallId ?? ""), false);
        }
      }
    }
    for (const call of calls) {
      const signature = signatureOfCommand(call.command);
      if (signature === "") continue;
      const stat = stats.get(signature) ?? { sessions: new Map<string, boolean>(), sampleCommand: call.command };
      if (!stat.sessions.has(sid)) {
        stat.sessions.set(sid, results.get(call.callId) === true);
        stats.set(signature, stat);
      }
    }
  }
  return { stats, filesScanned };
}

/** 已落盘观察的 (signature|sessionId) 集合(幂等:重复 flush 不重复追加观察行)。 */
function existingObservationKeys(root: string): Set<string> {
  const keys = new Set<string>();
  try {
    const text = readFileSync(join(root, ".genie", "rsi", "foundry.jsonl"), "utf-8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as { type?: unknown; observation?: { signature?: unknown; sessionId?: unknown } };
        if (parsed.type === "observation" && typeof parsed.observation?.signature === "string" && typeof parsed.observation?.sessionId === "string") {
          keys.add(`${parsed.observation.signature}|${parsed.observation.sessionId}`);
        }
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 文件不存在 = 空集 */ }
  return keys;
}

/** foundry 全链:观察(签名×会话逐条)→挖掘→shadow(journal 回放口径)→注册→data 层登记 + tool-upgrades 首条。 */
export async function incubateFromJournal(
  root: string,
  opts: { journalDir: string; now: number },
): Promise<SecondHalfSummary["foundry"] & { codes: string[] }> {
  const out: SecondHalfSummary["foundry"] & { codes: string[] } = {
    observed: 0, candidates: 0, registered: [], dataTools: [], upgrades: [], codes: [],
  };
  const { stats } = harvestTerminalSignatures(opts.journalDir, { now: opts.now });
  const knownObs = existingObservationKeys(root);
 // 观察:每签名每会话一条(跨会话频次/会话数门槛由 mine 判)。
  for (const [signature, stat] of stats) {
    for (const [sid, success] of stat.sessions) {
      if (knownObs.has(`${signature}|${sid}`)) continue;
      const sample = stat.sampleCommand.length > 120 ? `${stat.sampleCommand.slice(0, 120)}…` : stat.sampleCommand;
      const res = observe(root, {
        sessionId: sid,
        projectId: projectKeyOf(root),
        kind: "command-sequence",
        signature,
        steps: [sample],
        cost: { tokens: 0, wallMs: 0, toolCalls: 1 },
        success,
        ...(success ? {} : { failureMode: "session-had-failure" }),
      });
      if (res.ok) out.observed += 1;
    }
  }
  if (out.observed === 0) {
    out.codes.push("SECOND_HALF_FOUNDRY_NO_OBSERVATIONS");
    return out;
  }
  const mined = mine(root);
  const fresh = mined.candidates ?? [];
  out.candidates = fresh.length;
  for (const candidate of fresh) {
    const shadowStart = startShadow(root, candidate.id);
    if (!shadowStart.ok) {
      out.codes.push(...shadowStart.codes);
      continue;
    }
 // shadow 证据 = journal 回放口径:该签名观察的会话数与全成功会话数(>=3 次 80% 门槛由 runtime 判)。
    const stat = stats.get(candidate.sourceSignature);
    if (stat === undefined) continue;
    const runs = stat.sessions.size;
    const successes = [...stat.sessions.values()].filter(Boolean).length;
    const evaluated = evaluateShadow(root, candidate.id, { runs, successes, minRuns: 3, minSuccessRate: 0.8 });
    if (!evaluated.ok) {
      out.codes.push(...evaluated.codes.filter((code) => code !== "FOUNDRY_LOW_REUSE"));
      continue;
    }
 // §14.2④ 机器闸:data 层(L3)工具注册=可逆(目录降级+继任者提示)+零 riskFlags → 自动生效。
    const registered = register(root, candidate.id, { approved: true });
    if (!registered.ok) {
      out.codes.push(...registered.codes);
      continue;
    }
    out.registered.push(candidate.name);
    const projected = listCandidates(root, { status: "registered" }).find((entry) => entry.id === candidate.id);
    const spec = projected?.dataToolSpec;
    if (spec === undefined) {
      out.codes.push("SECOND_HALF_FOUNDRY_NO_SPEC");
      continue;
    }
    const dataTool = registerDataTool(root, spec);
    if (dataTool.ok) out.dataTools.push(candidate.name);
    else out.codes.push(...dataTool.codes.filter((code) => code !== "DATA_TOOL_NEEDS_APPROVAL"));
 // tool-upgrades 首条:孵化工具版本登记(from→to 由协议段位承载,init 记起点)。
    const known = new Set(listUpgrades(root).upgrades.map((entry) => entry.name));
    if (!known.has(candidate.name)) {
      const upgrade = initUpgrade(root, { name: candidate.name, version: "1.0.0", at: opts.now });
      if (upgrade.ok) out.upgrades.push(candidate.name);
      else out.codes.push(...upgrade.codes);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ③ 决策质量记账(机制裁决 → decisions;聚合 → patterns)
 * ------------------------------------------------------------------ */

/** 已落盘的 decision id 集合(幂等去重)。 */
function existingDecisionIds(root: string): Set<string> {
  const ids = new Set<string>();
  try {
    const text = readFileSync(decisionsPath(root), "utf-8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as { type?: unknown; record?: { id?: unknown } };
        if (parsed.type === "decision" && typeof parsed.record?.id === "string") ids.add(parsed.record.id);
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 文件不存在 = 空集 */ }
  return ids;
}

function recordDecisionQuietly(root: string, input: Record<string, unknown>): boolean {
  const res = dqRecord(root, input);
  return res.record !== undefined;
}

/**
 * 机制裁决记账 + 聚合:
 * - 近 7 天登记的实验(ledger createdAt)且未记过 → plan 类决策(evidenceRefs 引 experiment id);
 * - 本轮注册的 foundry 工具 → tool-choice 类决策(evidenceRefs 引 cand id);
 * - prompt v2 修订 → plan 类决策(evidenceRefs 引 prompt:key@rev);
 * - 最后 aggregate 聚合 patterns(样本少时如实零模式)。
 */
export async function recordSecondHalfDecisions(
  root: string,
  opts: { now: number; foundryRegistered: Array<{ id: string; name: string }>; promptRevisions: string[]; experimentIds: string[] },
): Promise<{ recorded: number; patterns: number; codes: string[] }> {
  const out = { recorded: 0, patterns: 0, codes: [] as string[] };
  const known = existingDecisionIds(root);
  const base = {
    sessionId: "rsi-cycle",
    context: { projectId: projectKeyOf(root), taskClass: "coding" },
    cost: { tokens: 0, wallMs: 0, toolCalls: 0 },
    source: "session" as const,
  };
  for (const expId of opts.experimentIds) {
    const id = `dq-exp-${expId}`;
    if (known.has(id)) continue;
    if (recordDecisionQuietly(root, {
      ...base, id, type: "plan", at: opts.now,
      choice: `experiment:${expId} 登记(候选→实验翻译)`,
      outcome: "success",
      evidenceRefs: [expId],
      note: " 机制裁决记账:实验账本登记",
    })) out.recorded += 1;
  }
  for (const item of opts.foundryRegistered) {
    const id = `dq-foundry-${item.id}`;
    if (known.has(id)) continue;
    if (recordDecisionQuietly(root, {
      ...base, id, type: "tool-choice", at: opts.now,
      choice: `foundry-register:${item.name}(journal 签名聚合→shadow 回放→机器闸注册)`,
      outcome: "success",
      evidenceRefs: [item.id],
      note: " 机制裁决记账:首个 RSI 自孵工具",
    })) out.recorded += 1;
  }
  for (const key of opts.promptRevisions) {
    const id = `dq-prompt-${key}`;
    if (known.has(id)) continue;
    if (recordDecisionQuietly(root, {
      ...base, id, type: "plan", at: opts.now,
      choice: `prompt-version:${key} v2 种子修订(记录+可回滚,acceptDefault 保行为)`,
      outcome: "success",
      evidenceRefs: [`prompt:${key}@2`],
      note: " 机制裁决记账:提示词版本化",
    })) out.recorded += 1;
  }
  try {
    const aggregated = dqAggregate(root, { now: opts.now });
    out.patterns = aggregated.patterns.length;
    out.codes.push(...aggregated.codes.filter((code) => code !== "DQ_EMPTY"));
  } catch {
    out.codes.push("SECOND_HALF_DQ_AGGREGATE_FAILED");
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ④ 提示词书版本化(initBook → v2 → acceptDefault 保行为)
 * ------------------------------------------------------------------ */

/** 建立 book(真实内置文本)并给每个 key 落 v2 种子修订;acceptDefault 把 current 打回 1(行为不变)。 */
export async function seedPromptBookV2(root: string, opts: { now: number }): Promise<{ initialized: boolean; revisions: string[]; codes: string[] }> {
  const out = { initialized: false, revisions: [] as string[], codes: [] as string[] };
 // 动态 import:loop-support 属 agent-wiring 大图,静态引会让 CLI/nightly 路径背上整包依赖。
  const { SYSTEM_LITE, systemForTaskClass } = await import("./agent-wiring/loop-support.js");
  const builtins: Record<string, string> = {
    "system.coding": systemForTaskClass("coding"),
    "system.coding.lite": SYSTEM_LITE,
  };
  const loaded = await loadBook(root);
  const keys = Object.keys(loaded.book?.keys ?? {});
  if (keys.length === 0) {
    const created = await initBook(root, { builtins, at: opts.now });
    if (!created.ok) {
      out.codes.push(...created.codes);
      return out;
    }
    out.initialized = true;
  }
  for (const key of Object.keys(builtins)) {
    const current = await loadBook(root);
    const history = current.book?.keys?.[key];
    if (history === undefined) {
      out.codes.push("PROMPT_UNKNOWN_KEY");
      continue;
    }
    if (history.revisions.length > 1) continue; // 已有 v2:幂等跳过
    const v2Text = `${builtins[key]}\n[rsi-prompt-version v2-seed:本版为版本化基线(可回滚/canary 分流占位);acceptDefault 已保持内置生效]`;
    const saved = await saveRevision(root, {
      key,
      text: v2Text,
      baseRevision: 1,
      origin: "rsi",
      author: "rsi-second-half",
      note: " v2 种子修订:建立版本序列以启用回滚与按版本分流;不激活",
      approval: { ok: true, by: "rsi-auto-gate" },
      at: opts.now,
    });
    if (!saved.ok) {
      out.codes.push(...saved.codes);
      continue;
    }
 // current=2 会改变生效文本 → 立即 acceptDefault 回内置(current→1),行为逐字不变。
    const restored = await acceptDefault(root, key);
    if (!restored.ok && restored.codes.length > 0) out.codes.push(...restored.codes);
    out.revisions.push(key);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ⑤ ROI 节省侧(增量水位 × 单位事件成本,估算入账)
 * ------------------------------------------------------------------ */

/** 从 nightly session-stats 全量汇总增量水位(Σ eventsRead / Σ eventsSkipped=增量跳过的事件数)。 */
function sumIncrementalStats(root: string): { eventsRead: number; eventsSkipped: number } {
  const out = { eventsRead: 0, eventsSkipped: 0 };
  const base = join(root, ".genie", "rsi", "nightly");
  if (!existsSync(base)) return out;
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(base, d.name));
  } catch {
    return out;
  }
  for (const dir of projectDirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".session-stats.json"));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf-8")) as { sessions?: Array<{ eventsRead?: unknown; eventsSkipped?: unknown }> };
        for (const s of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
          const read = Number(s.eventsRead ?? 0);
          const skipped = Number(s.eventsSkipped ?? 0);
          if (Number.isFinite(read)) out.eventsRead += read;
          if (Number.isFinite(skipped)) out.eventsSkipped += skipped;
        }
      } catch { /* 坏文件跳过 */ }
    }
  }
  return out;
}

/** 从增量水位估算并入账一笔节省;无真源(session-stats/成本行缺失)时零写入。 */
export function recordIncrementalSavings(root: string, opts: { now: number }): { entries: number; tokensSaved: number; method: string; codes: string[] } {
  const out = { entries: 0, tokensSaved: 0, method: "skip", codes: [] as string[] };
 // 真源①:nightly session-stats 汇总(Σ eventsRead / Σ eventsSkipped=上轮已读本轮跳过)。
  const { eventsRead, eventsSkipped } = sumIncrementalStats(root);
  if (!(eventsRead > 0) || !(eventsSkipped > 0)) {
    out.codes.push("SECOND_HALF_SAVING_NO_INCREMENT");
    return out;
  }
 // 真源②:最近一条 cost 行(tokens.total;同周期归账)。
  let costRow: { id?: unknown; cycleId?: unknown; at?: unknown; tokens?: { total?: unknown } } | undefined;
  try {
    const text = readFileSync(join(root, ".genie", "rsi", "cost.jsonl"), "utf-8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as { type?: unknown } & typeof costRow;
        if (parsed.type !== "cost") continue;
        if (costRow === undefined || String(parsed.at ?? "") > String(costRow.at ?? "")) costRow = parsed;
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 无成本台账 */ }
  const costTotal = Number(costRow?.tokens?.total ?? 0);
  if (!(costTotal > 0) || costRow?.cycleId === undefined) {
    out.codes.push("SECOND_HALF_SAVING_NO_COST_SOURCE");
    return out;
  }
 // 幂等:同周期只入账一条(按 cycleId+skipped 签名)。
  const savingId = `rsi-saving-incremental-${String(costRow.cycleId)}-sk${eventsSkipped}`;
  try {
    const text = readFileSync(join(root, ".genie", "rsi", "cost.jsonl"), "utf-8");
    if (text.includes(`"id":"${savingId}"`)) {
      out.codes.push("SECOND_HALF_SAVING_DUPLICATE");
      return out;
    }
  } catch { /* 读失败按无重复处理 */ }
  const rate = costTotal / eventsRead;
  const saved = Math.round(eventsSkipped * rate);
  if (!(saved > 0)) {
    out.codes.push("SECOND_HALF_SAVING_ZERO");
    return out;
  }
  const res = recordSavings(root, {
    id: savingId,
    cycleId: String(costRow.cycleId),
    at: new Date(opts.now).toISOString(),
    mechanismId: "nightly",
    projectId: projectKeyOf(root),
    tokensSaved: saved,
    evidenceRefs: [
      `cursor:eventsRead=${eventsRead}`,
      `cursor:eventsSkipped=${eventsSkipped}`,
      `cost:${String(costRow.id ?? "")}`,
      "method:skipped×(上周期cost.tokens.total/eventsRead);估算口径,置信度低(假设跳过事件与均摊成本同质)",
    ],
  });
  if (res.ok) {
    out.entries = 1;
    out.tokensSaved = saved;
    out.method = `skipped=${eventsSkipped} × rate=${rate.toFixed(3)} tok/event (cost ${costTotal}/${eventsRead})`;
  } else {
    out.codes.push(...res.codes);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ② 基因灰度 A/B 节省入账(P0 saving 采集器)
 * ------------------------------------------------------------------ */

/** 单臂统计(仅统计有 token 数据的会话;shown 优先于 held——同会话两者都有时算处理臂,与 nightly 一致)。 */
export interface GeneAbArmStats {
  count: number;
  tokens: number;
}

/** 纯函数:从会话统计行算 A/B 节省(可单测;不读盘)。 */
export function geneAbSavingsFromSessions(
  sessions: Array<{ sessionId?: unknown; inputTokens?: unknown; geneBriefShown?: unknown; geneBriefHeld?: unknown }>,
  opts: { minSample?: number } = {},
): {
  ok: boolean;
  saving: number;
  shown: GeneAbArmStats;
  held: GeneAbArmStats;
  method: string;
  evidence: string[];
  codes: string[];
} {
  const minSample = typeof opts.minSample === "number" && opts.minSample > 0 ? Math.floor(opts.minSample) : 3;
  const shown: GeneAbArmStats = { count: 0, tokens: 0 };
  const held: GeneAbArmStats = { count: 0, tokens: 0 };
  const shownIds: string[] = [];
  const heldIds: string[] = [];
  for (const s of sessions) {
    if (!s || typeof s !== "object") continue;
    const tok = typeof s.inputTokens === "number" && Number.isFinite(s.inputTokens) ? s.inputTokens : 0;
    if (tok <= 0) continue;
    const id = typeof s.sessionId === "string" ? s.sessionId : "";
    if (s.geneBriefShown === true) {
      shown.count += 1;
      shown.tokens += tok;
      if (id !== "" && shownIds.length < 8) shownIds.push(id);
    } else if (s.geneBriefHeld === true) {
      held.count += 1;
      held.tokens += tok;
      if (id !== "" && heldIds.length < 8) heldIds.push(id);
    }
  }
  const codes: string[] = [];
  const evidence = [
    `geneAB:shown=${shown.count} held=${held.count}`,
    ...shownIds.map((id) => `shown:${id}`),
    ...heldIds.map((id) => `held:${id}`),
  ];
  if (shown.count < minSample || held.count < minSample) {
    codes.push("GENE_AB_INSUFFICIENT");
    return { ok: false, saving: 0, shown, held, method: `insufficient(shown=${shown.count}/held=${held.count} < ${minSample})`, evidence, codes };
  }
  const shownAvg = shown.tokens / shown.count;
  const heldAvg = held.tokens / held.count;
  const diff = heldAvg - shownAvg;
  if (!(diff > 0)) {
    codes.push("GENE_AB_NO_EFFECT");
    return { ok: false, saving: 0, shown, held, method: `no-effect(heldAvg=${heldAvg.toFixed(0)} <= shownAvg=${shownAvg.toFixed(0)})`, evidence, codes };
  }
  const saving = Math.round(diff * shown.count);
  return {
    ok: saving > 0,
    saving,
    shown,
    held,
    method: `geneAB:(heldAvg ${heldAvg.toFixed(0)} - shownAvg ${shownAvg.toFixed(0)}) × shown ${shown.count};对照=命中但灰度扣住;估算口径,置信度低`,
    evidence,
    codes,
  };
}

/** 读最近 14 天的 session-stats,按 sessionId 合并(后者覆盖;含 tokens 与 gene 标记)。 */
function loadRecentSessionStats(root: string): Array<{ sessionId?: unknown; inputTokens?: unknown; geneBriefShown?: unknown; geneBriefHeld?: unknown }> {
  const dir = join(root, ".genie", "rsi", "nightly", projectKeyOf(root));
  const merged = new Map<string, { sessionId?: unknown; inputTokens?: unknown; geneBriefShown?: unknown; geneBriefHeld?: unknown }>();
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".session-stats.json")).sort(); } catch { return []; }
  for (const file of files.slice(-14)) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf-8")) as { sessions?: unknown };
      if (!Array.isArray(parsed.sessions)) continue;
      for (const s of parsed.sessions) {
        if (!s || typeof s !== "object") continue;
        const id = typeof (s as { sessionId?: unknown }).sessionId === "string" ? (s as { sessionId: string }).sessionId : "";
        if (id === "") continue;
        merged.set(id, s as { sessionId?: unknown; inputTokens?: unknown; geneBriefShown?: unknown; geneBriefHeld?: unknown });
      }
    } catch { /* 坏文件跳过 */ }
  }
  return [...merged.values()];
}

/** 落一笔基因 A/B 节省(同日幂等:同签名只入账一次)。 */
export function recordGeneAbSavings(root: string, opts: { now: number }): { entries: number; tokensSaved: number; method: string; codes: string[] } {
  const out = { entries: 0, tokensSaved: 0, method: "skip", codes: [] as string[] };
  const result = geneAbSavingsFromSessions(loadRecentSessionStats(root));
  if (!result.ok) {
    out.method = result.method;
    out.codes.push(...result.codes);
    return out;
  }
  const day = new Date(opts.now).toISOString().slice(0, 10);
  const id = `rsi-saving-gene-ab-${day}-${result.shown.count}x${result.held.count}-${result.saving}`;
  try {
    const text = readFileSync(join(root, ".genie", "rsi", "cost.jsonl"), "utf-8");
    if (text.includes(`"id":"${id}"`)) {
      out.codes.push("SECOND_HALF_GENE_AB_DUPLICATE");
      return out;
    }
  } catch { /* 无台账按无重复 */ }
  const res = recordSavings(root, {
    id,
    cycleId: `gene-ab-${day}`,
    at: new Date(opts.now).toISOString(),
    mechanismId: "geneAb",
    projectId: projectKeyOf(root),
    tokensSaved: result.saving,
    evidenceRefs: [...result.evidence, `method:${result.method}`],
  });
  if (res.ok) {
    out.entries = 1;
    out.tokensSaved = result.saving;
    out.method = result.method;
  } else {
    out.codes.push(...res.codes);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 总入口:周期集中器
 * ------------------------------------------------------------------ */

/** 实验台账近 7 天登记的实验 id(决策记账输入;幂等由 dq id 去重保证)。 */
function recentExperimentIds(root: string, now: number): string[] {
  const ids: string[] = [];
  try {
    const text = readFileSync(join(root, ".genie", "experiments", "ledger.jsonl"), "utf-8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as { type?: unknown; at?: unknown; experiment?: { id?: unknown; createdAt?: unknown } };
        if (parsed.type !== "record") continue;
        const createdAt = Number(parsed.experiment?.createdAt ?? 0);
        if (createdAt >= now - 7 * 86_400_000 && typeof parsed.experiment?.id === "string") ids.push(parsed.experiment.id);
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 台账不存在 = 空 */ }
  return ids;
}

/** 周期:五分项独立 fail-soft,任一失败不挡其余与周期本身。 */
export async function runSecondHalfFlush(root: string, opts: { now?: number; journalDir?: string } = {}): Promise<SecondHalfSummary> {
  const now = opts.now ?? Date.now();
  const journalDir = opts.journalDir ?? join(root, ".genie", "journals");
  const summary: SecondHalfSummary = {
    at: now,
    links: { added: 0, skipped: 0, nodes: 0 },
    foundry: { observed: 0, candidates: 0, registered: [], dataTools: [], upgrades: [] },
    decisions: { recorded: 0, patterns: 0 },
    promptBook: { initialized: false, revisions: [] },
    savings: { entries: 0, tokensSaved: 0, method: "skip" },
    pins: 0,
    codes: [],
  };
  try {
    const links = linkEvidenceFromCandidates(root, now);
    summary.links = { added: links.added, skipped: links.skipped, nodes: links.nodes };
    summary.codes.push(...links.codes);
  } catch {
    summary.codes.push("SECOND_HALF_LINKS_FAILED");
  }
  try {
    const foundry = await incubateFromJournal(root, { journalDir, now });
    summary.foundry = {
      observed: foundry.observed,
      candidates: foundry.candidates,
      registered: foundry.registered,
      dataTools: foundry.dataTools,
      upgrades: foundry.upgrades,
    };
    summary.codes.push(...foundry.codes);
  } catch {
    summary.codes.push("SECOND_HALF_FOUNDRY_FAILED");
  }
  try {
    const prompt = await seedPromptBookV2(root, { now });
    summary.promptBook = { initialized: prompt.initialized, revisions: prompt.revisions };
    summary.codes.push(...prompt.codes);
  } catch {
    summary.codes.push("SECOND_HALF_PROMPT_FAILED");
  }
  try {
    const savings = recordIncrementalSavings(root, { now });
    summary.savings = { entries: savings.entries, tokensSaved: savings.tokensSaved, method: savings.method };
    summary.codes.push(...savings.codes);
  } catch {
    summary.codes.push("SECOND_HALF_SAVING_FAILED");
  }
 // P0 saving 采集器:基因灰度 A/B——shown vs held 同签名会话的输入 token 差。
  try {
    const geneAb = recordGeneAbSavings(root, { now });
    if (geneAb.entries > 0) {
      summary.savings.entries += geneAb.entries;
      summary.savings.tokensSaved += geneAb.tokensSaved;
      summary.savings.method = summary.savings.method === "skip" ? geneAb.method : `${summary.savings.method} + ${geneAb.method}`;
    } else if (summary.savings.method === "skip") {
      summary.savings.method = geneAb.method;
    }
    summary.codes.push(...geneAb.codes);
  } catch {
    summary.codes.push("SECOND_HALF_GENE_AB_FAILED");
  }
  try {
    const registeredIds = listCandidates(root, { status: "registered" });
    const decisions = await recordSecondHalfDecisions(root, {
      now,
      foundryRegistered: registeredIds.map((entry) => ({ id: entry.id, name: entry.name })),
      promptRevisions: summary.promptBook.revisions,
      experimentIds: recentExperimentIds(root, now),
    });
    summary.decisions = { recorded: decisions.recorded, patterns: decisions.patterns };
    summary.codes.push(...decisions.codes);
  } catch {
    summary.codes.push("SECOND_HALF_DECISIONS_FAILED");
  }
 // 版本基线钉扎:首个自孵工具的目录快照(后续升级的对照;DUPLICATE=已存在,容忍)。
  if (summary.foundry.dataTools.length > 0) {
    try {
      const catalog: Record<string, { latest: string; versions: string[] }> = {};
      for (const name of summary.foundry.dataTools) catalog[name] = { latest: "1.0.0", versions: ["1.0.0"] };
      const pins = await createPins(root, { sessionId: "rsi-foundry-baseline", catalog });
      if (pins.ok) summary.pins = 1;
    } catch {
      summary.codes.push("SECOND_HALF_PINS_FAILED");
    }
  }
  return summary;
}
