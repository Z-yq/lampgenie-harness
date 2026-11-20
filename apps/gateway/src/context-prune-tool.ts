/**
 * context_prune 工具(错误路径定向剪枝的 agent 面):
 * LLM 决策过程中发现之前的某条方案/探索路径错了 → 声明放弃 → 该路径积累的工具输出
 * 在下一次 deriveMessages 重放时折叠为占位(原因+原文头+寻址回查),教训留在声明点位,
 * 上下文还给正确路径。可选把教训登记进负面知识库(跨会话「此路不通」)。
 * 守门(为什么敢让 agent 自己剪):
 * - 零匹配拒(选择器给错,附本会话工具名分布帮助收窄);
 * - 节省 <500 tok 拒(破前缀的代价大于收益——cache-aware 纪律同源);
 * - 命中面 >60% 拒(那是「全删」不是「剪路径」,要求收窄);
 * - 不可逆回执(edit/write)与声明前最近 keepRecent 个结果由 derive 侧硬豁免;
 * - journal 原文永不动:审计/回放/面板照旧全量可查,折叠只发生在模型可见投影。
 */
import type { Journal } from "@lampgenie/core";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { recordDeadEnd } from "./negative-kb-store.js";
import {
  matchesDeclaration,
  PATH_PRUNE_IRREVERSIBLE_TOOLS,
  DEFAULT_PATH_PRUNE_KEEP_RECENT,
  segmentToolThreads,
  renderThreadLine,
  isFailureResult,
  type PathAbandonedDeclaration,
} from "@lampgenie/runtime/agent/path-prune";

export const CONTEXT_PRUNE_TOOL_NAME = "context_prune";

/** 节省下限(估算 tokens):低于它不值得破一次 prompt 前缀。 */
export const CONTEXT_PRUNE_MIN_TOKENS = 500;
/** 命中面上限(占本会话全部工具结果字符的比例):超过判定「范围过宽」。 */
export const CONTEXT_PRUNE_MAX_SCOPE_RATIO = 0.6;

function usage(): string {
  return [
    "context_prune 用法(发现之前的方案路径错了,把该路径积累的工具输出剪掉):",
    "· reason=<为什么这条路错了>(必填,进占位与教训)",
    "· tools=<工具名列表>(如 [\"terminal\",\"run_cmd\"])——只剪这些工具的结果",
    "· keywords=<关键词列表>(如 [\"docker-compose\",\"Dockerfile\"])——工具名/参数/输出头部任一命中",
    "· lesson=<教训:正确路径是什么 / 下次怎么避>(可选;给了会登记负面知识库,跨会话生效)",
    "· keepRecent=<声明前最近 N 个结果保留>(缺省 3;0=全剪)",
    "· dryRun=true 只预览不落账",
    "tools 与 keywords 至少给一个;两者都给取交集。剪的是「模型可见的上下文投影」,journal 原文不动,可随时按占位寻址重查。",
  ].join("\n");
}

/** 参数归一:列表或逗号串 → string[]。 */
function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  if (typeof v === "string" && v.trim() !== "") return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

interface ResultRow {
  seq: number;
  toolCallId: string;
  name: string;
  args: string;
  content: string;
}

/** 扫会话事件:tool.call 信息 + tool.result 行(供预演匹配与守门)。 */
function scanResults(journal: Journal, sessionId: string): ResultRow[] {
  const infos = new Map<string, { name: string; args: string }>();
  const rows: ResultRow[] = [];
  for (const e of journal.readAll()) {
    if (e.sessionId !== sessionId) continue;
    if (e.kind === "tool.call") {
      const p = (e.payload ?? {}) as { toolCallId?: unknown; name?: unknown; arguments?: unknown };
      if (typeof p.toolCallId === "string" && typeof p.name === "string") {
        infos.set(p.toolCallId, { name: p.name, args: typeof p.arguments === "string" ? p.arguments : "" });
      }
    } else if (e.kind === "tool.result") {
      const p = (e.payload ?? {}) as { toolCallId?: unknown; content?: unknown; modelContent?: unknown };
      if (typeof p.toolCallId !== "string") continue;
      const info = infos.get(p.toolCallId) ?? { name: "", args: "" };
      rows.push({
        seq: Number(e.seq),
        toolCallId: p.toolCallId,
        name: info.name,
        args: info.args,
        content: String(p.modelContent ?? p.content ?? ""),
      });
    }
  }
  return rows;
}

/** 预演:按 derive 同一套规则算命中行(不可逆豁免 + keepRecent 豁免 + fromSeq 下界)。 */
function previewMatches(rows: ResultRow[], decl: PathAbandonedDeclaration): ResultRow[] {
 // JS 陷阱:slice(-0) === slice(0) 全量——keepRecent<=0 特判成空豁免(与 loop.ts 同修)。
  const exemptIds = decl.keepRecent <= 0 ? [] : rows.slice(-decl.keepRecent).map((r) => r.toolCallId);
  const exempt = new Set(exemptIds);
  return rows.filter(
    (r) =>
      r.seq < decl.seq
      && (decl.fromSeq === undefined || r.seq >= decl.fromSeq)
      && !PATH_PRUNE_IRREVERSIBLE_TOOLS.has(r.name)
      && !exempt.has(r.toolCallId)
      && matchesDeclaration(decl, { name: r.name, arguments: r.args }, r.content.slice(0, 2000)),
  );
}

function approxTokens(chars: number): number {
 // 与 token-estimate 的字符近似同量级(CJK ~1.6 字/tok,ascii ~4 字/tok;取保守 3)。
  return Math.ceil(chars / 3);
}

/**
 * @param journal 任务 journal(worker 模式下是 ProxyJournal,append/readAll 同样可用)
 * @param sessionId 本会话
 * @param root 仓根(负面知识库落 .genie/rsi/negkb.jsonl)
 */
export function contextPruneTool(journal: Journal, sessionId: string, root: string): Tool {
  return {
    name: CONTEXT_PRUNE_TOOL_NAME,
    description:
      "Abandon a wrong path and prune its accumulated context: when you realize an earlier approach/exploration was wrong, declare it (reason + optional lesson) and all matching historical tool outputs collapse into small addressable placeholders on the next LLM request — the wrong path's bulk leaves your context, the lesson stays as a landmark. Optionally registers the lesson into the negative knowledge base (cross-session \"dead end\"). Use dryRun=true to preview. Journal originals are never modified (audit/replay intact).",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why this path is wrong (required; goes into every placeholder and the reminder)" },
        lesson: { type: "string", description: "The lesson: what the correct path is / how to avoid this next time (registered into negative KB when provided)" },
        tools: { type: "array", items: { type: "string" }, description: "Restrict pruning to these tool names (e.g. [\"terminal\",\"run_cmd\"])" },
        keywords: { type: "array", items: { type: "string" }, description: "Match tool name/args/output-head (e.g. [\"docker-compose\"])" },
        keepRecent: { type: "number", description: "Keep the most recent N results before the declaration (default 3; 0 = prune all matches)" },
        fromSeq: { type: "number", description: "Start anchor: only prune results with seq in [fromSeq, now) — pins the failing-decision span start so earlier same-keyword content stays (pick from the thread preview)" },
        fromToolCallId: { type: "string", description: "Start anchor by toolCallId (resolved to its seq; inclusive)" },
        dryRun: { type: "boolean", description: "Preview matches, savings AND the session's exploration threads (with fromSeq anchors) without writing the declaration" },
      },
      required: ["reason"],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        const reason = typeof a.reason === "string" ? a.reason.trim() : "";
        if (reason === "") return "context_prune 需要 reason(为什么这条路错了)\n" + usage();
        const tools = toList(a.tools).slice(0, 12);
        const keywords = toList(a.keywords).slice(0, 12);
        if (tools.length === 0 && keywords.length === 0) {
          return "tools 与 keywords 至少给一个(否则无法界定「哪条路径」)\n" + usage();
        }
        const keepRecentRaw = Number(a.keepRecent);
        const keepRecent = Number.isFinite(keepRecentRaw) && keepRecentRaw >= 0 && keepRecentRaw <= 20
          ? Math.floor(keepRecentRaw)
          : DEFAULT_PATH_PRUNE_KEEP_RECENT;
        const lesson = typeof a.lesson === "string" ? a.lesson.trim().slice(0, 400) : "";
        const dryRun = a.dryRun === true;

        const rows = scanResults(journal, sessionId);
        if (rows.length === 0) return "本会话还没有工具结果,无路径可剪。";

 // 起始锚点(v1.1):fromToolCallId → 该调用结果行的 seq(含端点);显式 fromSeq 直取。
 // 非法锚点(不存在的 id / 非正整数)拒——宁可拒也不静默丢锚点(丢=误折更早内容)。
        let fromSeq: number | undefined;
        if (typeof a.fromToolCallId === "string" && a.fromToolCallId.trim() !== "") {
          const anchor = rows.find((r) => r.toolCallId === a.fromToolCallId);
          if (anchor === undefined) {
            return `fromToolCallId=${a.fromToolCallId} 在本会话不存在——先 dryRun 看线程分段里的 seq 再锚定。`;
          }
          fromSeq = anchor.seq;
        } else if (a.fromSeq !== undefined) {
          const n = Number(a.fromSeq);
          if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
            return `fromSeq=${String(a.fromSeq)} 非法(要正整数 journal seq;先 dryRun 看线程分段)。`;
          }
          fromSeq = n;
        }

 // 预演声明(derive 侧同规则):匹配基于现有全部结果,豁免 = 最近 keepRecent 个。
        const decl: PathAbandonedDeclaration = {
          seq: Number.MAX_SAFE_INTEGER, // 预演用:现有全部结果都在声明之前
          reason: reason.slice(0, 300),
          lesson,
          tools: new Set(tools),
          keywords,
          keepRecent,
          ...(fromSeq !== undefined ? { fromSeq } : {}),
        };
        const matched = previewMatches(rows, decl);
        const matchedChars = matched.reduce((n, r) => n + r.content.length, 0);
 // 命中面分母(v1.1 修正):锚定时只算区间 [fromSeq, 现在) 内的字符——锚点前的内容
 // 已被排除在候选外,把它计进分母会把精准锚定误判成「过宽」。
        const universeRows = fromSeq !== undefined ? rows.filter((r) => r.seq >= fromSeq) : rows;
        const allChars = universeRows.reduce((n, r) => n + r.content.length, 0);
        const estTokens = approxTokens(matchedChars);

 // 线程分段:「失败决策的起始点」的可视化锚——同 (工具,目标) 的连续结果归一段。
        const threads = segmentToolThreads(rows);
        const tailCount = Math.min(threads.length, 10);
        const threadLines = threads.slice(-tailCount).map((th, i) => renderThreadLine(threads.length - tailCount + i, th));

        if (matched.length === 0) {
          const byTool = new Map<string, number>();
          for (const r of rows) byTool.set(r.name, (byTool.get(r.name) ?? 0) + 1);
          const dist = [...byTool.entries()].map(([n, c]) => `${n || "(未知)"}×${c}`).join("、");
 // 缺口#19 部分:自动死路检测——错误结果(本工具视角)≥3 条且未声明过时,
 // 建议首条失败 seq 为锚点的定向剪枝。纯文本建议,不自动执行(agent 确认后才动)。
          let deadEndHint = "";
          {
            const failed = rows.filter((r) => isFailureResult(r.content));
            const declared = journal.readAll().some((e) => e.sessionId === sessionId && e.kind === "custom"
              && (e.payload as { type?: string } | undefined)?.type === "context.path.abandoned");
            if (failed.length >= 3 && !declared) {
              const first = failed[0]!;
              const failedTools = [...new Set(failed.map((r) => r.name).filter((n) => n !== ""))];
              deadEndHint = `\n检测到 ${failed.length} 条未声明的失败结果,首条 seq=${first.seq},建议:context_prune(reason="失败路径收口", tools=[${failedTools.map((t) => `"${t}"`).join(",")}], fromSeq=${first.seq})`;
            }
          }
          return [
            `零匹配——检查 tools/keywords 拼写。本会话工具结果分布:${dist}`,
            ...(deadEndHint !== "" ? [deadEndHint] : []),
            "探索线程(最近段;锚定失败区间起点用 fromSeq):",
            ...threadLines,
          ].join("\n");
        }
        if (estTokens < CONTEXT_PRUNE_MIN_TOKENS) {
          return `命中 ${matched.length} 条但估算只省 ~${estTokens} tok(<${CONTEXT_PRUNE_MIN_TOKENS})——不值得为此破一次 prompt 前缀,上下文保持原样。要继续就扩大 keywords 或降 keepRecent。`;
        }
        const scopeRatio = allChars > 0 ? matchedChars / allChars : 0;
 // 过宽守门只拦「未锚定的模糊圈定」(v1.1):显式 fromSeq/fromToolCallId = 锚点∩关键词
 // 两因子收窄,锚定区间内全命中正是本意——此时 100% 合法,不再拦;keepRecent 仍保尾部。
        if (fromSeq === undefined && scopeRatio > CONTEXT_PRUNE_MAX_SCOPE_RATIO) {
          return [
            `命中面 ${(scopeRatio * 100).toFixed(0)}%(${matched.length}/${rows.length} 条)过宽(上限 ${CONTEXT_PRUNE_MAX_SCOPE_RATIO * 100}%)——这是「全删」不是「剪路径」。`,
            "收窄办法:①keywords 更专属;②用 fromSeq 把起点钉在失败区间的第一条(线程分段如下);③明确 keepRecent 保底。",
            ...threadLines,
          ].join("\n");
        }

        const tierCounts = { failure: 0, success: 0 };
        for (const r of matched) tierCounts[isFailureResult(r.content) ? "failure" : "success"] += 1;
        const matchedPreviewTierNote = `分档:失败档 ${tierCounts.failure} 条(压狠:结论+锚点)/成功档 ${tierCounts.success} 条(留细节:head/tail+寻址)`;
        const previewLines = matched
          .slice(0, 8)
          .map((r) => `  · seq=${r.seq} ${r.name || "?"} (${r.content.length} 字):${r.content.slice(0, 60).replace(/\s+/g, " ")}`);
        const preview = [
          `命中 ${matched.length}/${rows.length} 条${fromSeq !== undefined ? `(区间 [${fromSeq}, 现在))` : ""},涉及字符 ${matchedChars}/${allChars},估算省 ~${estTokens} tok:`,
          ...previewLines,
          ...(matched.length > 8 ? [`  …(共 ${matched.length} 条)`] : []),
          matchedPreviewTierNote,
          ...(fromSeq === undefined && threads.length > 1
            ? ["提示:未设起始锚点,更早的同关键词内容若被卷入,用 fromSeq 钉住失败区间起点(线程分段):", ...threadLines]
            : []),
        ].join("\n");

        if (dryRun) return `[dryRun 预览]\n${preview}\n(确认后去掉 dryRun 落账)`;

        const appended = journal.append({
          kind: "custom",
          sessionId,
          payload: {
            type: "context.path.abandoned",
            reason: reason.slice(0, 300),
            ...(lesson !== "" ? { lesson } : {}),
            tools,
            keywords,
            keepRecent,
            ...(fromSeq !== undefined ? { fromSeq } : {}),
            stats: { matched: matched.length, chars: matchedChars, estTokens, scopeRatio: Number(scopeRatio.toFixed(3)), outcomeTiers: tierCounts },
          },
        });

 // 教训进负面知识库(fail-soft:登记失败不影响剪枝本身)。
        let negkbNote = "";
        if (lesson !== "") {
          try {
            const rec = recordDeadEnd(root, {
              plan: `路径:${reason.slice(0, 120)}`,
              context: { taskClass: "coding" },
              failureEvidence: [{ kind: "abandon", detail: lesson.slice(0, 300), ref: `session:${sessionId}`, at: Date.now() }],
              scope: { keywords: keywords.length > 0 ? keywords : tools },
              confidence: 0.6,
            });
            negkbNote = rec.ok
              ? `;教训已入负面知识库(${rec.record?.id ?? "?"})`
              : `;负面知识库跳过(${(rec.codes ?? []).join(",")})`;
          } catch {
            negkbNote = ";负面知识库写入失败(不影响剪枝)";
          }
        }

        return [
          `✅ 已声明放弃该路径(seq=${appended.seq}),下次 LLM 请求起生效:`,
          preview,
          `教训提醒会留在声明点位;不可逆回执(edit/write)与最近 ${keepRecent} 个结果不受影响${negkbNote}。`,
        ].join("\n");
      } catch (err) {
        return `context_prune 错误:${String(err).slice(0, 200)}`;
      }
    },
  };
}
