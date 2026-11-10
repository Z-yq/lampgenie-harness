/**
 * codesense wiki(step-118):持久 repo wiki 的 CLI 面。
 * list/get/rebuild/audit/ask;rebuild 的 LLM 走既有凭证链(flag>env>config>ask-file),
 * 无凭证=确定性骨架(显式降级,不冒充)。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { flagBool, flagStr, expandTilde, type ParsedArgs } from "./args.js";
import { resolveProjectRoot } from "./registry.js";
import {
  askWiki, auditWikiCitations, getWikiPage, listWiki, rebuildWiki,
} from "@lampgenie/code-sense/wiki";
import type { WikiLlm } from "@lampgenie/code-sense/wiki";

export class WikiUsageError extends Error {}

function wikiRoot(p: ParsedArgs): { root: string; source: string } {
  const explicit = flagStr(p, "root");
  if (explicit) {
    const root = resolve(expandTilde(explicit));
    if (!existsSync(root)) throw new WikiUsageError(`--root 不存在: ${root}`);
    return { root, source: "--root" };
  }
  const hit = resolveProjectRoot(process.cwd());
  if (hit) return { root: hit.root, source: hit.source };
  return { root: process.cwd(), source: "cwd" };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export interface WikiCmdResult {
  text: string;
  json?: unknown;
  /** 未生成/页不存在:exit 1(不冒充空结果)。 */
  miss?: boolean;
  /** 用法/配置错误:exit 2。 */
  usage?: boolean;
}

export async function wikiCommand(p: ParsedArgs, json: boolean): Promise<WikiCmdResult> {
  const sub = p._[1] ?? "list";
  const { root, source } = wikiRoot(p);
  if (sub === "list") {
    const r = await listWiki(root);
    const jsonOut = { root, rootSource: source, ...r };
    if (!r.exists || !r.manifest) {
      return {
        text: `未生成 wiki: ${r.dir}\n  运行 codesense wiki rebuild${source === "cwd" ? " --root <项目根>" : ""} 生成`,
        json: { ...jsonOut, note: "未生成" }, miss: true,
      };
    }
    const m = r.manifest;
    const lines = [
      `wiki: ${m.repo} · ${m.pages.length} 页 · 生成 ${new Date(m.generatedAt).toISOString()}`,
      `git: ${m.gitHead ? m.gitHead.slice(0, 12) : "(无 sha)"} · LLM: ${m.llm.enabled ? `on(${m.llm.pages.length} 页${m.llm.failed ? `,失败 ${m.llm.failed}` : ""})` : "off(确定性骨架)"} · 引用 ${m.citationAudit.passed}/${m.citationAudit.checked}`,
    ];
    for (const pg of m.pages) {
      lines.push(`  ${pg.id.padEnd(28)} ${pg.title}  [${pg.generator}] ${pg.citations.length} refs · ${fmtBytes(pg.bytes)}`);
    }
    if (m.flow) {
      lines.push(`  flow: ${m.flow.source === "index" ? "符号级" : "词法级"} · ${m.flow.level} 层 · ${m.flow.nodes} 节点/${m.flow.edges} 边 · 入口 ${m.flow.entries} · 功能线 ${m.flow.features.length}${m.flow.omittedNodes || m.flow.omittedEdges ? ` · 裁剪 ${m.flow.omittedNodes} 节点/${m.flow.omittedEdges} 边` : ""}`);
    }
    if (m.degraded.length > 0) for (const d of m.degraded) lines.push(`  [降级] ${d.layer}: ${d.reason}`);
    return { text: lines.join("\n"), json: jsonOut };
  }

  if (sub === "get") {
    const pageId = p._[2];
    if (!pageId) throw new WikiUsageError("用法: codesense wiki get <page-id> [--root dir] [--json](page-id 见 wiki list)");
    const r = await getWikiPage(root, pageId);
    if (!r) return { text: `页不存在: ${pageId}(运行 codesense wiki list 查看页 id)`, json: { error: "not-found", pageId }, miss: true };
    return { text: r.markdown, json: { page: r.page, markdown: r.markdown, manifest: { repo: r.manifest.repo, gitHead: r.manifest.gitHead, generatedAt: r.manifest.generatedAt } } };
  }

  if (sub === "audit") {
    const pageId = p._[2];
    const r = await auditWikiCitations(root, pageId);
    const lines = [`引用抽检:${r.passed}/${r.checked} 通过${r.failed ? `,${r.failed} 失败` : ""}`];
    for (const f of r.failures.slice(0, 20)) lines.push(`  FAIL ${f.page} ${f.file}:${f.line} — ${f.reason}`);
    return { text: lines.join("\n"), json: r, miss: r.failed > 0 };
  }

  if (sub === "ask") {
    const q = p._.slice(2).join(" ").trim();
    if (!q) throw new WikiUsageError('用法: codesense wiki ask "<问题>" [--root dir] [--json]');
    const r = await askWiki(root, q);
    const symbols = r.symbols ?? [];
    const lines = [`问题: ${r.question}`, `关键词: ${r.keywords.join(", ") || "(无)"}`, ""];
    // 符号优先(2026-10-21):页面零命中时不再只回「(无)」——符号候选 + 源码行兜底。
    if (symbols.length > 0) {
      lines.push("候选符号:");
      for (const s of symbols.slice(0, 8)) {
        lines.push(`  ${s.name} — ${s.file}:${s.line}${s.expanded ? " [1 跳扩展]" : ""}`);
        const rel = [
          s.callers.length ? `被谁调: ${s.callers.map((x) => x.name).join(", ")}` : "",
          s.callees.length ? `调谁: ${s.callees.map((x) => x.name).join(", ")}` : "",
        ].filter(Boolean).join(" | ");
        if (rel) lines.push(`     ${rel}`);
        if (s.reasons.length) lines.push(`     原因: ${s.reasons.join(" · ")}`);
      }
      lines.push("");
    }
    lines.push("命中页面:");
    if (r.pages.length === 0) lines.push("  (无)");
    for (const pg of r.pages) lines.push(`  ${pg.id} — ${pg.title}(score ${pg.score}${pg.via === "symbol" ? ", 符号归属" : ""})`);
    lines.push("", "grep 命中:");
    if (r.matches.length === 0) lines.push("  (无)");
    for (const m of r.matches.slice(0, 12)) lines.push(`  ${m.file}:${m.line} — ${m.text}`);
    if (symbols.length > 0) {
      lines.push("", "下一步(可直接复制):");
      for (const s of symbols.filter((x) => !x.expanded).slice(0, 2)) {
        lines.push(`  codesense symbol ${s.name}`);
        lines.push(`  codesense impact ${s.name}`);
      }
    }
    lines.push("", r.note);
    if (r.symbolDegraded) lines.push(`[降级] ${r.symbolDegraded}`);
    return {
      text: lines.join("\n"), json: r,
      miss: r.pages.length === 0 && r.matches.length === 0 && symbols.length === 0,
    };
  }

  if (sub === "rebuild") {
    const noLlm = flagBool(p, "no-llm");
    let llm: WikiLlm | undefined;
    let model: string | undefined;
    const notes: string[] = [];
    if (!noLlm) {
      const { resolveLlmConfig, makeSenseLlm, makeAskFileLlm } = await import("./llm-config.js");
      try {
        const r = resolveLlmConfig();
        if (r?.kind === "direct") {
          llm = makeSenseLlm(r.cfg);
          model = r.cfg.model;
          notes.push(`LLM: on(${r.source};${r.cfg.model})`);
        } else if (r?.kind === "ask-file") {
          llm = makeAskFileLlm(r.dir);
          notes.push(`LLM: ask-file(${r.dir})`);
        } else {
          notes.push("LLM: off(无凭证;确定性骨架)");
        }
      } catch (err) {
        notes.push(`LLM: off(${String(err).slice(0, 160)};确定性骨架)`);
      }
    } else {
      notes.push("LLM: off(--no-llm;确定性骨架)");
    }
    const pagesRaw = flagStr(p, "pages");
    const maxLlmPages = pagesRaw === undefined ? undefined : Number(pagesRaw);
    if (maxLlmPages !== undefined && (!Number.isInteger(maxLlmPages) || maxLlmPages < 0)) {
      throw new WikiUsageError("--pages 必须是 ≥0 的整数");
    }
    const res = await rebuildWiki(root, {
      refresh: flagBool(p, "refresh"),
      ...(llm ? { llm } : {}),
      ...(model ? { llmModel: model } : {}),
      // 显式 --no-llm 才允许 «refresh + 显式关 LLM» 降级覆盖既有 LLM 页;无凭证导致的 off 不算显式。
      explicitNoLlm: noLlm,
      flow: !flagBool(p, "no-flow"),
      config: maxLlmPages === undefined ? {} : { maxLlmPages },
    });
    const m = res.manifest;
    const lines = [
      ...notes,
      `根: ${root}(${source})`,
      res.hit ? `缓存命中: ${res.reason}` : `${res.reason} · ${res.durationMs}ms`,
      ...(res.warnings ?? []).map((w) => `[warn] ${w}`),
      `页: ${m.pages.length} · 重建 ${res.rebuilt.length} / 复用 ${res.reused.length}${res.removed.length ? ` / 删除 ${res.removed.length}` : ""} · LLM 调用 ${res.llmCalls}`,
      `引用: ${m.citationAudit.passed}/${m.citationAudit.checked} 通过 · 丢弃无据小节 ${m.citationAudit.droppedSections}`,
      `输出: ${(await listWiki(root)).dir}`,
    ];
    for (const d of m.degraded) lines.push(`[降级] ${d.layer}: ${d.reason}(激活: ${d.howToActivate})`);
    for (const pg of m.pages) lines.push(`  ${pg.id.padEnd(28)} [${pg.generator}] ${pg.citations.length} refs · ${fmtBytes(pg.bytes)}`);
    return { text: lines.join("\n"), json: { root, ...res } };
  }

  throw new WikiUsageError(`未知 wiki 子命令: ${sub}(支持 list/get/rebuild/audit/ask)`);
}
