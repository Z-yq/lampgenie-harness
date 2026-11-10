/**
 * 调试脚本:对 ZCode 实跑 code_sense 四剖面,取证时延/结果形态/降级链。
 * 用法: tsx scripts/debug-codesense-zcode.ts [剖面...]
 */
import { codeSense, renderForLlm } from "../packages/code-sense/src/index";

const ROOT = new URL("../ZCode", import.meta.url).pathname;

async function timed(label: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    const json = JSON.stringify(r) ?? "";
    console.log(`\n===== ${label} (${ms}ms, ${json.length}B) =====`);
    return r as Record<string, unknown>;
  } catch (err) {
    console.log(`\n===== ${label} 异常 =====`);
    console.log(String(err).slice(0, 500));
    return null;
  }
}

function summarize(label: string, r: Record<string, unknown> | null) {
  if (!r) return;
  const out: string[] = [`[${label}] mode=${r.mode}`];
  if (r.autoDecision) out.push(`auto=${JSON.stringify(r.autoDecision)}`);
  out.push(`state=${JSON.stringify(r.projectState)}`);
  if (r.degraded) out.push(`degraded=${JSON.stringify(r.degraded).slice(0, 300)}`);
  if (r.callchain) {
    const cc = r.callchain as {
      center: { name: string; file: string; line: number };
      upstream: unknown[]; downstream: unknown[];
      mermaid?: string; mermaidNodes?: unknown[]; mermaidTruncated?: boolean;
    };
    out.push(`center=${cc.center.name} @${cc.center.file.split("/").slice(-2).join("/")}:${cc.center.line} up=${cc.upstream.length} down=${cc.downstream.length}`);
    if (cc.mermaid) {
      out.push(`关系图(面向人,${cc.mermaidNodes?.length ?? "?"} 节点${cc.mermaidTruncated ? ",已裁剪" : ""}):`);
      out.push(cc.mermaid);
    }
  }
  if (r.signatures) out.push(`signatures=${Object.keys(r.signatures).length}`);
  if (r.matches) out.push(`matches=${(r.matches as unknown[]).length}`);
  if (r.modules) out.push(`modules=${(r.modules as unknown[]).length}`);
  if (r.hotspots) out.push(`hotspots=${(r.hotspots as unknown[]).length}`);
  if (r.sequence) out.push(`sequence=present`);
  if (r.pageflow) {
    const pf = r.pageflow as { pages?: unknown[]; edges?: unknown[]; mermaid?: string };
    out.push(`pageflow pages=${pf.pages?.length ?? "?"} edges=${pf.edges?.length ?? "?"} mermaid=${pf.mermaid ? pf.mermaid.length + "B" : "none"}`);
  }
  if (r.evidence) out.push(`evidence=${(r.evidence as unknown[]).length}`);
  if (r.budget) out.push(`budget=${JSON.stringify(r.budget)}`);
  console.log(out.join("\n  "));
}

const which = process.argv.slice(2);
const runAll = which.length === 0;

if (runAll || which.includes("debug")) {
  // 真实符号:ZCode client 的 tabStore(workspace 项目模型,step-035 移植真源)
  const r = await timed("debug: tabStore", () => codeSense(ROOT, "tabStore", { mode: "debug" }));
  summarize("debug: tabStore", r);
  if (r?.callchain?.mermaid) console.log("\n----- LLM 增强信息(面向 LLM) -----\n" + renderForLlm(r as never));
}
if (runAll || which.includes("debug2")) {
  const r = await timed("debug: logMemoryDiagnostics", () => codeSense(ROOT, "logMemoryDiagnostics", { mode: "debug" }));
  summarize("debug: logMemoryDiagnostics", r);
}
if (runAll || which.includes("debug3")) {
  const r = await timed("debug: file:line 形态", () => codeSense(ROOT, "packages/ui/src/logger.ts:98", { mode: "debug" }));
  summarize("debug: file:line", r);
}
if (runAll || which.includes("explore")) {
  const r = await timed("explore: '权限审批'", () => codeSense(ROOT, "权限审批", { mode: "explore" }));
  summarize("explore: 权限审批", r);
}
if (runAll || which.includes("explore2")) {
  const r = await timed("explore: 'PermissionBroker'", () => codeSense(ROOT, "PermissionBroker", { mode: "explore" }));
  summarize("explore: PermissionBroker", r);
}
if (runAll || which.includes("plan")) {
  const r = await timed("plan(无 LLM,静态降级)", () => codeSense(ROOT, "架构总览", { mode: "plan" }));
  summarize("plan", r);
}
if (runAll || which.includes("ui")) {
  const r = await timed("ui: 页面流", () => codeSense(ROOT, "前端页面流", { mode: "ui" }));
  summarize("ui", r);
}
if (runAll || which.includes("auto")) {
  const r = await timed("auto: 'tabStore 没初始化'", () => codeSense(ROOT, "tabStore 没初始化", { mode: "auto" }));
  summarize("auto", r);
}
console.log("\n完成");
