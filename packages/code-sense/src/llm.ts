/**
 * code_sense 结果 → LLM 增强信息文本( §9 分工:图给人,增强信息给 LLM)。
 * 原则:比裸 JSON 省 token 且信号前置;诚实标注 tier/kind/降级;file:line 全保(可点回源)。
 * mermaid 源不进 LLM 文本(图面向人;LLM 消费结构化行)。
 */
import type { CodeSenseResult } from "./index";

const LIST_CAP = 20;

function sig(s: unknown): string {
  const v = s as { params?: { name: string; type?: string; optional?: boolean }[]; returnType?: string } | undefined;
  if (!v) return "";
  // import("/abs/path/to/x") 前缀剥成 x(ts-morph 对跨文件类型输出完整模块路径,噪声)
  const tidy = (t: string) => t.replace(/import\("[^"]*"\)\./g, "");
  const params = (v.params ?? []).map((p) => p.name + (p.type ? ": " + tidy(p.type).slice(0, 40) : "") + (p.optional ? "?" : "")).join(", ");
  return `(${params})${v.returnType ? " → " + tidy(v.returnType).slice(0, 60) : ""}`;
}

export function renderForLlm(r: CodeSenseResult): string {
  const out: string[] = [];
  const head = [`[code_sense ${r.mode}]`, `项目态=${r.projectState}`, `缓存=${r.cache.hit ? "命中" : "重建"}`];
  if (r.autoDecision) head.push(`auto=${r.autoDecision.picked}(${r.autoDecision.reason})`);
  out.push(head.join(" · "));

  if (r.degraded && r.degraded.length > 0) {
    for (const d of r.degraded) out.push(`[降级] ${d.layer}: ${d.reason} (激活: ${d.howToActivate})`);
  }

  if (r.callchain) {
    const c = r.callchain;
    out.push(`圆心(定义处): ${c.center.name} — ${c.center.file}:${c.center.line}`);
    for (const [name, s] of Object.entries(r.signatures ?? {})) out.push(`签名 ${name}${sig(s)}`);
    if (r.typeDefs && Object.keys(r.typeDefs).length > 0) {
      out.push(`类型定义:`);
      for (const [t, d] of Object.entries(r.typeDefs)) out.push(`  ${t} → ${d.file}:${d.line}`);
    }
    if (c.downstream.length > 0) {
      out.push(`下游 ${c.downstream.length} 条(caller→callee):`);
      for (const e of c.downstream.slice(0, LIST_CAP)) out.push(`  → ${e.toName ?? nameTail(e.to)} @ ${e.file}:${e.line} [${e.evidenceKind}/${e.tier}]`);
      if (c.downstream.length > LIST_CAP) out.push(`  …共 ${c.downstream.length} 条`);
    }
    if (c.upstream.length > 0) {
      out.push(`上游 ${c.upstream.length} 条:`);
      for (const e of c.upstream.slice(0, LIST_CAP)) out.push(`  ← ${nameTail(e.from)} @ ${e.file}:${e.line} [${e.evidenceKind}/${e.tier}]`);
      if (c.upstream.length > LIST_CAP) out.push(`  …共 ${c.upstream.length} 条`);
    }
    if (c.mermaid) out.push(`(关系图 ${c.mermaidNodes?.length ?? "?"} 节点已生成,面向面板展示)`);
  }

  if (r.references && r.references.length > 0) {
    out.push(`全仓引用 ${r.referenceCount ?? r.references.length} 处(词法级,封顶 80):`);
    for (const m of r.references.slice(0, 12)) out.push(`  ${m.file}:${m.line} ${m.text.slice(0, 60)}`);
    if (r.references.length > 12) out.push(`  …共 ${r.references.length} 处`);
  }

  if (r.sequence) {
    out.push(`静态时序 ${r.sequence.steps.length} 步(≠运行序,异步边界 ${r.sequence.asyncBoundaries} 处):`);
    for (const s of r.sequence.steps.slice(0, 12)) {
      out.push(`  ${s.order}. ${s.caller} → ${s.callee} ${s.line ? "@" + s.line + " " : ""}[${s.asyncBoundary}]`);
    }
  }

  if (r.symbols && r.symbols.length > 0) {
 // 符号优先召回:LLM 消费面先看候选符号(带 file:line + 关系 + 原因),
    // grep 行命中只作补充证据(降权)。
    out.push(`候选符号 ${r.symbols.length} 个(符号优先召回):`);
    for (const s of r.symbols.slice(0, 10)) {
      const rel = [
        s.callers.length ? `被调 ${s.callers.slice(0, 2).map((c) => c.name).join(",")}` : "",
        s.callees.length ? `调用 ${s.callees.slice(0, 2).map((c) => c.name).join(",")}` : "",
      ].filter(Boolean).join(" · ");
      out.push(`  ${s.name} — ${s.file}:${s.line}${rel ? ` (${rel})` : ""}${s.reasons.length ? ` [${s.reasons.join(";")}]` : ""}`);
    }
  }

  if (r.matches && r.matches.length > 0) {
    out.push(`grep 命中 ${r.matches.length} 条:`);
    for (const m of r.matches.slice(0, LIST_CAP)) out.push(`  ${m.file}:${m.line} ${m.text.trim().slice(0, 80)}`);
    if (r.matches.length > LIST_CAP) out.push(`  …共 ${r.matches.length} 条`);
  }

  if (r.modules && r.modules.length > 0) {
    out.push(`模块 ${r.modules.length} 个(静态推导):`);
    for (const m of r.modules.slice(0, LIST_CAP)) out.push(`  - ${m.name}: ${m.responsibility.slice(0, 100)} (${m.entryFile})`);
  }
  if (r.hotspots && r.hotspots.length > 0) out.push(`git 热点: ${r.hotspots.slice(0, 8).join(", ")}`);

  if (r.pageflow) {
    out.push(`页面 ${r.pageflow.pages.length} 个 / 边 ${r.pageflow.edges.length} 条:`);
    for (const p of r.pageflow.pages.slice(0, 12)) out.push(`  页 ${p.route} (${p.file})${p.components.length ? " 入口:" + p.components.join(",") : ""}`);
    for (const e of r.pageflow.edges.slice(0, 12)) out.push(`  ${e.from} --${e.kind}/${e.trigger}--> ${e.to} @ ${e.evidence.path}:${e.evidence.line} [${e.tier}]`);
  }

  // senseB22:app 路由画像(自写 switchView 族 SPA 的前端路由表;与 pageflow 三形态互补)
  if (r.routes) {
    const rr = r.routes;
    if (rr.router) {
      out.push(`app 路由 ${rr.routes.length} 个视图(路由器 ${rr.router.name} @ ${rr.router.file}:${rr.router.line}):`);
      for (const route of rr.routes.slice(0, LIST_CAP)) {
        const opens = route.opens.slice(0, 4).map((o) => `${o.fn}:${o.line}${o.trigger ? `(${o.trigger})` : ""}`).join("、");
        const entries = route.entries.slice(0, 6).map((e) => `${e.name}:${e.line}`).join("、");
        out.push(`  视图 ${route.view} (${route.file})${opens ? ` 打开: ${opens}` : ""}${entries ? ` · 入口渲染: ${entries}` : ""}`);
      }
      if (rr.routes.length > LIST_CAP) out.push(`  …共 ${rr.routes.length} 个视图`);
    } else {
      out.push(`app 路由: 未检出路由器(${rr.degraded[0] ?? "无自写路由形态"})`);
    }
  }

  if (r.architecture) out.push(`架构图: ${r.architecture.nodes.length} 节点 ${r.architecture.edges.length} 边(mermaid 面向面板)`);

  if (r.api) {
    const a = r.api;
    out.push(`HTTP 接口 ${a.endpoints.length} 个(框架: ${a.frameworks.join(",") || "未识别"}):`);
    for (const e of a.endpoints.slice(0, LIST_CAP)) {
      out.push(`  ${e.method} ${e.path}${e.handler ? ` → ${e.handler}` : ""} @ ${e.file}:${e.line}${e.prefixInferred ? " (前缀跨文件未解析)" : ""}`);
      if (e.semantic) out.push(`    语义(模型解读,证据锚=上行): ${e.semantic}`);
      if (e.impactSummary) out.push(`    影响面: 直接调用方 ${e.impactSummary.directCallers} / 文件 ${e.impactSummary.fileCount} / 测试 ${e.impactSummary.testCount}`);
    }
    if (a.endpoints.length > LIST_CAP) out.push(`  …共 ${a.endpoints.length} 个`);
    if (a.reconcile) {
      out.push(`规范对账(${a.reconcile.spec.file}): 一致 ${a.reconcile.both.length} / 仅规范 ${a.reconcile.specOnly.length} / 仅代码 ${a.reconcile.codeOnly.length}`);
    }
  }

  if (r.state) {
    const s = r.state;
    out.push(`状态机 ${s.machines.length} 个:`);
    for (const m of s.machines.slice(0, 8)) {
      if (m.form === "redux-slice" && m.redux) {
        out.push(`  ${m.name} [redux-slice](动作驱动非具名状态机) 字段: ${m.redux.stateFields.join(",") || "-"};动作: ${m.redux.actions.join(",") || "-"}`);
        continue;
      }
      out.push(`  ${m.name} [${m.form}] 状态(${m.states.length}): ${m.states.slice(0, 10).join(",")}`);
      for (const t of m.transitions.slice(0, 12)) {
        out.push(`    ${t.from} --${t.trigger ?? ""}→ ${t.to} @ ${t.evidence.file}:${t.evidence.line}`);
      }
    }
    if (s.statusHints.length > 0) out.push(`  DB status 词法提示 ${s.statusHints.length} 条(词法级,可能含误判,仅人工排查入口)`);
  }

  if (r.algo) {
    const g = r.algo;
    out.push(`算法画像 ${g.profiles.length} 文件(模块聚合 ${g.modules.length} 目录):`);
    for (const m of g.modules.slice(0, 10)) out.push(`  ${m.dir}: ${m.kinds.join("+")} (${m.files} 文件)`);
    for (const p of g.profiles.slice(0, 10)) {
      out.push(`  ${p.file} [${p.kinds.join(",")}] 信号: ${p.signals.slice(0, 4).map((s) => `${s.pattern}@${s.line}`).join("; ")}`);
      if (p.entryPoints.length > 0) out.push(`    入口: ${p.entryPoints.slice(0, 3).map((e) => `${e.name}@${e.line}`).join(", ")}`);
      for (const w of g.walkthroughs?.[p.file] ?? []) out.push(`    导读(模型解读,证据锚=信号行): ${w}`);
    }
  }

  if (r.budget.truncated) out.push(`[预算] 结果已裁剪,省略 ${r.budget.omittedCount} 条`);
  return out.join("\n");
}

function nameTail(id: string): string {
  const i = id.lastIndexOf("#");
  return i >= 0 ? id.slice(i + 1) : id;
}
