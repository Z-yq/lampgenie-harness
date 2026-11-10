/**
 * 代码级落目标:把白板节点从「描述」升级为「可执行验收契约」的判定层(纯函数,零 IO)。
 * 背景注意:桌面 exe 任务里白板节点「首启引导」在板上、step.md 的 DoD 也写了「无 API Key 首启有引导」,
 * 但既没实现也没人核对,最终交付了 llm=off/echo 的应用被用户吐槽「根本不干活」。根因三条:
 * ① 白板节点无验收绑定(写了 DoD 就没人对);② 完工无证据门(宣称完成零成本);
 * ③ 子代理零报告时父 agent 无证据可用。
 * 本模块划定三件事:落板校验(P0 必须带 accept)、覆盖率核对(有证据才算过)、用户旅程冒烟模板。
 * 语义约定(写清契约,后续人/agent 按此判定):
 * - phase=P0 的节点 = 必做落目标;accept 非空且每条 cmd 非空才允许落板。
 * - 节点「有证据」(covered)= 其 accept 里至少一条 cmd 有对应 evidence。
 * - 节点「通过」(passed)= 其 accept 里**每条** cmd 都有 ok=true 的 evidence。
 * - 覆盖率 = passed / P0 节点总数(门:100% 才允许宣称完成;covered 率单独展示便于区分「跑过但失败」)。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { BoardDoc, BoardEvidence } from "@lampgenie/protocol";
import type { BoardContractIssue, BoardNodeT, EdgeLike } from "./board-contract/shared.js";

/** 兼容窗口(重构):校验实现已迁到 board-contract/;
 * 此文件保留原导出路径,3 个消费方(agent-wiring 动态 import、落板零改动。 */
export { validateChangeContract, validateBoardTypeConformance } from "./board-contract/index.js";
export type { BoardContractIssue, BoardNodeT } from "./board-contract/shared.js";

/** call 边与索引调用关系的核对(只提示):两端都有 symbolRef 时,查调用方的 callees 是否含被调方。
 * 索引不可用/查不到符号 → 跳过(不猜);virtual 边与 data/verify/nav 边不适用。 */
export function validateCallEdges(
  nodes: BoardNodeT[],
  edges: EdgeLike[] | undefined,
  calleesOf?: (symbol: string) => string[] | null): BoardContractIssue[] {
  if (!edges || !calleesOf) return [];
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const issues: BoardContractIssue[] = [];
  for (const e of edges) {
    if (e.virtual === true) continue;
    if ((e.kind ?? "call") !== "call") continue;
    const from = byId.get(String(e.from));
    const to = byId.get(String(e.to));
    const fromName = String(from?.symbolRef?.name ?? "").trim();
    const toName = String(to?.symbolRef?.name ?? "").trim();
    if (!fromName || !toName) continue;
    const callees = calleesOf(fromName);
    if (callees && !callees.includes(toName)) {
      issues.push({
        nodeId: `${e.from}->${e.to}`,
        label: `${from?.label ?? e.from}→${to?.label ?? e.to}`,
        problems: [`call 边与索引调用关系不符(${fromName} 的 callees 不含 ${toName})`],
      });
    }
  }
  return issues;
}

/** 落板校验:返回缺失项清单(空=通过)。P0 必须带至少一条 accept,每条 cmd 非空字符串。 */
export function validateP0Accepts(nodes: BoardNodeT[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const n of nodes) {
    if (n.phase !== "P0") continue;
    const accepts = Array.isArray(n.accept) ? n.accept : [];
    const label = `${n.id}「${n.label}」`;
    if (accepts.length === 0) {
      problems.push(`${label} 缺 accept(phase=P0 必须给出可执行验收,如 {cmd:"pnpm vitest run test/x.test.ts",expect:"7 passed"})`);
      continue;
    }
    const bad = accepts
      .map((a, i) => ({ i, cmd: typeof a?.cmd === "string" ? a.cmd.trim() : "" }))
      .filter((x) => x.cmd === "");
    if (bad.length) problems.push(`${label} 的 accept 第 ${bad.map((b) => b.i + 1).join("/")} 条 cmd 为空字符串`);
  }
  return { ok: problems.length === 0, problems };
}

export interface P0NodeStatus {
  id: string;
  label: string;
  /** accept 条数。 */
  acceptCount: number;
  /** 有证据的 cmd 数(任一**未过期** evidence 命中即算)。 */
  evidencedCount: number;
  /** ok=true 的 cmd 数(=通过该条验收)。 */
  passedCount: number;
  covered: boolean;
  passed: boolean;
 /** 还没有 ok=true 证据的 cmd 原文(报告直接点名)。 */
  missing: string[];
 /** 证据过期明细:证据落账后目标文件被改动/消失,该 evidence 不算覆盖、不算通过。 */
  stale: P0StaleEvidence[];
}

/** 一条过期证据:哪个 cmd、哪个文件、变了还是没了。 */
export interface P0StaleEvidence {
  cmd: string;
  file: string;
  reason: "changed" | "missing";
}

/** 证据指纹校验:落账后目标文件被改动/消失 → 该 evidence 过期。
 * 只在读时计算,不回写板(不篡改历史证据);无 files 的旧 evidence 永远不算过期(逐字兼容)。
 * 说明:不缓存 sha256——缓存会让「内容变但 mtime/size 被还原」漏判成通过,而这正是本机制要防的
 * 假通过;单次读 ≤12 个小文件(捕获时已限 512KB/文件),成本可忽略。 */
export function staleFilesOfEvidence(ev: BoardEvidence): P0StaleEvidence[] {
  const files = Array.isArray(ev.files) ? ev.files : [];
  const out: P0StaleEvidence[] = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string" || f.path === "") continue;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(f.path);
    } catch {
      out.push({ cmd: ev.cmd, file: f.path, reason: "missing" });
      continue;
    }
    if (!st.isFile()) {
      out.push({ cmd: ev.cmd, file: f.path, reason: "missing" });
      continue;
    }
    if (st.size !== f.size || Math.abs(st.mtimeMs - f.mtimeMs) > 0.5) {
      out.push({ cmd: ev.cmd, file: f.path, reason: "changed" });
      continue;
    }
    // 有 sha256 才比内容(内容变而 mtime/size 恰好未变的场景);读失败按过期处理(磁盘已不可读)。
    if (f.sha256) {
      try {
        if (createHash("sha256").update(readFileSync(f.path)).digest("hex") !== f.sha256) {
          out.push({ cmd: ev.cmd, file: f.path, reason: "changed" });
        }
      } catch {
        out.push({ cmd: ev.cmd, file: f.path, reason: "missing" });
      }
    }
  }
  return out;
}

/** board_read / audit 摘要共用的一段过期证据提示:空串=无过期。
 * 入参直接吃 computeP0Coverage 的结果(防重复 stat/sha256)。audit 文本已接线;
 * board_read 摘要渲染在 agent-wiring 的 renderBoardText,该文件本轮被另一任务占用(文件面禁改),
 * 其接线列为残留。 */
export function staleSummaryOf(cov: Pick<P0Coverage, "stale">, max = 5): string {
  if (!cov.stale.length) return "";
  return `⚠ 证据过期 ${cov.stale.length} 条(目标文件在证据之后被改动,需重跑验收并重新回填 evidence):`
    + cov.stale.slice(0, max).map((st) => `证据过期:${st.cmd} ← ${st.file} 在证据后${st.reason === "missing" ? "被删除" : "变更"}`).join("; ")
    + (cov.stale.length > max ? ` …(共 ${cov.stale.length} 条)` : "");
}


export interface P0Coverage {
  total: number;
  covered: number;
  passed: number;
  /** passed/total,0~1(total=0 时记 1,无 P0 落目标视为无门要过)。 */
  rate: number;
  nodes: P0NodeStatus[];
 /** 过期证据汇总(节点级明细见 nodes[].stale):数量+前 5 条由调用方渲染。 */
  stale: Array<P0StaleEvidence & { nodeId: string }>;
}

/** action=audit format=json 的结构化结果:execute 仍返回字符串,JSON 是字符串内容,
 * 协议/工具返回类型零变更;CLI/WS/面板可 JSON.parse 后按 grand/writers/boards 消费。 */
export interface BoardAuditJsonResult {
  ok: boolean;
  /** 全量 P0 合计(scope 分区时只含本写者可见节点)。 */
  grand: { total: number; passed: number; rate: number; covered: number };
  /** all=true 按写者 id 前缀分组的 P0 通过/总数。 */
  writers: Record<string, { passed: number; total: number }>;
  boards: Array<{
    taskId: string;
    title: string;
    status: string;
    docKind: string;
    boardType?: string;
    scale?: string;
    coverage: P0Coverage;
    contractIssues: string[];
 /** 板型一致性门:与通用契约自检分开,便于按类型消费/统计。 */
    typeIssues: string[];
    symbolIssues: string[];
  }>;
  contractIssues: string[];
  /** 板型一致性门(13 类规范);空数组=通过。 */
  typeIssues: string[];
  symbolIssues: string[];
  /** 空态/无板/写者分区为空时的原因。 */
  reason?: string;
}

/** 核对:逐 P0 节点算证据/通过状态与总覆盖率。 */
export function computeP0Coverage(doc: Pick<BoardDoc, "nodes">): P0Coverage {
  const nodes: P0NodeStatus[] = [];
  for (const n of doc.nodes) {
    // 阶段泳道(ph-*)只表达五阶段,不是设计节点/落目标——即使被误标 phase=P0 也不计入覆盖率。
    if (String(n.id).startsWith("ph-")) continue;
    if (n.phase !== "P0") continue;
    const accepts = (n.accept ?? []).filter((a) => typeof a?.cmd === "string" && a.cmd.trim() !== "");
    const evidence = (n.evidence ?? []) as BoardEvidence[];
    const missing: string[] = [];
    const stale: P0StaleEvidence[] = [];
    let evidencedCount = 0;
    let passedCount = 0;
    for (const a of accepts) {
      const hits = evidence.filter((e) => e.cmd === a.cmd);
 // 过期证据不算覆盖、不算通过(无 files 的旧证据 staleFiles 恒空 = 行为逐字不变)。
      const live: BoardEvidence[] = [];
      for (const e of hits) {
        const bad = staleFilesOfEvidence(e);
        if (bad.length) stale.push(...bad);
        else live.push(e);
      }
      if (live.length) evidencedCount++;
      if (live.some((e) => e.ok)) passedCount++;
      else missing.push(a.cmd);
    }
    nodes.push({
      id: n.id,
      label: n.label,
      acceptCount: accepts.length,
      evidencedCount,
      passedCount,
      covered: acceptedCovered(accepts.length, evidencedCount),
      passed: accepts.length > 0 && passedCount === accepts.length,
      missing,
      stale,
    });
  }
  const total = nodes.length;
  const passed = nodes.filter((s) => s.passed).length;
  return {
    total,
    covered: nodes.filter((s) => s.covered).length,
    passed,
    rate: total === 0 ? 1 : passed / total,
    nodes,
    stale: nodes.flatMap((s) => s.stale.map((x) => ({ ...x, nodeId: s.id }))),
  };
}

function acceptedCovered(acceptCount: number, evidencedCount: number): boolean {
  return acceptCount > 0 && evidencedCount > 0;
}

/** 核对文本(agent 面回执 / 每 N 步再锚定提醒共用同一措辞,防两处漂移)。 */
export function renderP0Status(doc: Pick<BoardDoc, "title" | "status" | "nodes">, opts: { maxMissing?: number } = {}): string {
  const cov = computeP0Coverage(doc);
  if (cov.total === 0) {
    return `P0 落目标覆盖率:无 P0 节点(纯探索/问答任务可无落目标;产品/打包类任务必须挂 P0 冒烟节点)。`;
  }
  const pct = Math.round(cov.rate * 100);
  const L: string[] = [
    `P0 落目标覆盖率 ${cov.passed}/${cov.total}(${pct}%)· 有证据 ${cov.covered}/${cov.total} · 板「${doc.title}」状态 ${doc.status}`,
  ];
  for (const s of cov.nodes) {
    const tag = s.passed ? "✅通过" : s.covered ? "⚠️有证据未通过" : "❌无证据";
    L.push(`- ${tag} ${s.id}「${s.label}」验收 ${s.acceptCount} 条/证据覆盖 ${s.evidencedCount} 条/通过 ${s.passedCount} 条`);
    const max = opts.maxMissing ?? 3;
    for (const m of s.missing.slice(0, max)) L.push(`    · 待跑:${m}`);
    for (const st of s.stale.slice(0, max)) {
      L.push(`    · 证据过期:${st.cmd} ← ${st.file} 在证据后${st.reason === "missing" ? "被删除" : "变更"}`);
    }
  }
  if (cov.stale.length > 0) {
    L.push(staleSummaryOf(cov));
  }
  if (cov.passed < cov.total) {
    L.push(`未覆盖 ${cov.total - cov.passed} 个 P0 节点:${cov.nodes.filter((s) => !s.passed).map((s) => s.id).join(", ")}——补跑验收并回填 evidence 之前,禁止宣称任务完成。`);
  } else {
    L.push("全部 P0 节点已通过验收,可进入收尾汇报。");
  }
  return L.join("\n");
}

/** 节点上有 ok=true 证据时把 done 置 true(回填证据的唯一副作用,保持「落实」与「验收」同步)。 */
export function markDoneFromEvidence(n: BoardNodeT): boolean {
  const acceptCmds = new Set((n.accept ?? []).map((a) => a.cmd));
  const okAll = acceptCmds.size > 0 && [...acceptCmds].every((cmd) => (n.evidence ?? []).some((e) => e.cmd === cmd && e.ok));
  return okAll;
}

/** P0-4 用户旅程冒烟模板(产品/桌面/打包类任务起点):正路走通 + 负面断言(禁 echo/llm=off)。
 * 负面断言是这次事故的关键——「程序能启动」不等于「真的在干活」,必须显式断言不得出现占位执行器回显。 */
export const SMOKE_TEMPLATE = {
  id: "smoke",
  phase: "P0" as const,
  kind: "tool" as const,
  label: "用户旅程冒烟",
  summary: "启动→配置→跑真实任务→负面断言(禁 echo/llm=off)",
  change: "add" as const,
  targets: [] as string[],
  accept: [
    { cmd: "启动产品(桌面 exe/服务)并确认主界面可用", expect: "主窗口/首页可用,无崩溃与控制台致命错误", type: "manual" as const, note: "启动冒烟" },
    { cmd: "按用户旅程配置(至少覆盖首启引导与必要设置项)", expect: "首启无配置时出现引导;配置写入后重启仍生效", type: "manual" as const, note: "配置冒烟" },
    { cmd: "在配置后执行一次真实任务(要求模型/主链路真实产出)", expect: "产出非占位内容(真实模型输出/真实业务结果)", type: "manual" as const, note: "执行冒烟" },
    { cmd: "负面断言:真实任务链路中不得出现 echo 回显或 llm=off 占位执行", expect: "日志/界面/回执中不出现 echo 回显、llm=off、placeholder 执行器标识", type: "negative" as const, note: "负面断言(事故直指项)" },
  ],
};

/** P1 环境预检模板(打包/安装类任务开工前跑,把 wine32/NSIS 这类环境坑提前暴露)。 */
export const PACKAGING_PREFLIGHT = {
  id: "preflight",
  phase: "P1" as const,
  kind: "tool" as const,
  label: "打包环境预检",
  summary: "wine32/NSIS/签名工具在场性预检",
  change: "add" as const,
  targets: [] as string[],
  accept: [
    { cmd: "检查打包所需工具链在场(wine32/NSIS/签名/electron-builder 依赖)", expect: "全部在场;缺失项显式列出并说明替代交付形态(如仅 win-unpacked)", type: "command" as const, note: "环境预检" },
  ],
};

/** 冒烟模板的节点骨架(供工具/提示词复用;调用方按需改 label/summary 与 accept 内容)。 */
export function smokeTemplateNode(over?: Partial<BoardNodeT>): BoardNodeT {
  return { ...(SMOKE_TEMPLATE as unknown as BoardNodeT), ...(over ?? {}) };
}