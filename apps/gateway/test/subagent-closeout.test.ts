/**
 * 子代理收尾接线:所有终态(done/deadline/串台采用)统一走 task-closeout(mode="subagent"),
 * finalText 写回收尾段;写角色挂 deliverable、只读角色不挂。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";

interface ScriptStep { content: string; toolCalls?: { id: string; name: string; arguments: string }[] }

function scripted(steps: ScriptStep[], holder: { tools: string[] }) {
  let i = 0;
  return {
    async chat(_m: unknown, tools: { name: string }[] = []) {
      holder.tools = tools.map((t) => t.name);
      const r = steps[Math.min(i, steps.length - 1)]!;
      i++;
      return r;
    },
  } as never;
}

const waitFor = async <T,>(fn: () => T | undefined, timeoutMs: number): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 30));
  }
};

describe("子代理终态收尾", () => {
  it("worker:六机制落子 journal、终稿含「## 收尾审计」,工具面含 deliverable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-closeout-"));
    const holder = { tools: [] as string[] };
    const loopEvents: { kind: string; payload?: unknown }[] = [];
    const backend = new LlmLoopBackend({
      llm: scripted([
        { content: "写文件", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: join(dir, "a.ts"), content: "export const a = 1;" }) }] },
        { content: "登记", toolCalls: [{ id: "d1", name: "deliverable", arguments: JSON.stringify({ path: "a.ts", note: "代码" }) }] },
        { content: "完成:见 a.ts" },
      ], holder),
      roots: [dir], workdir: dir, role: "worker", maxSteps: 6,
      onLoopEvent: (e) => loopEvents.push(e as never),
    });
    let result: { ok?: boolean; finalText?: string } | undefined;
    await backend.spawn({ taskId: "sub-co", instructions: "调研并写文件", workdir: dir, permissions: "sandbox" } as never, (e) => {
      if (e.type === "result") result = e.result as typeof result;
    });
    await waitFor(() => result, 20_000);

    expect(holder.tools).toContain("deliverable");
    expect(result?.finalText).toContain("## 收尾审计");
    // custom 事件在子 journal 入账时被压成 raw JSON,按 type 子串核对六类齐全。
    const raws = loopEvents
      .filter((e) => e.kind === "custom")
      .map((e) => String((e.payload as { raw?: string } | undefined)?.raw ?? ""));
    for (const t of ["turn.change-ledger", "guidance.metrics", "verify.ledger", "citation.audit", "deliverable.verified", "completion.audit"]) {
      expect(raws.some((r) => r.includes(`"type":"${t}"`)), `缺事件 ${t}`).toBe(true);
    }
  }, 30_000);

  it("explore 只读角色:不挂 deliverable / cite_source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-closeout-r-"));
    const holder = { tools: [] as string[] };
    const backend = new LlmLoopBackend({
      llm: scripted([{ content: "done" }], holder),
      roots: [dir], workdir: dir, role: "explore", maxSteps: 4,
    });
    let result: { ok?: boolean } | undefined;
    await backend.spawn({ taskId: "sub-ro", instructions: "探索", workdir: dir, permissions: "readonly" } as never, (e) => {
      if (e.type === "result") result = e.result as typeof result;
    });
    await waitFor(() => result, 15_000);
    expect(holder.tools).not.toContain("deliverable");
    expect(holder.tools).not.toContain("cite_source");
  }, 25_000);

  it("deadline 收割(partial)同样经过收尾包装", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-closeout-d-"));
    const backend = new LlmLoopBackend({
      llm: { async chat() { return new Promise(() => { /* 永不返回,触发 deadline 收割 */ }); } } as never,
      roots: [dir], workdir: dir, role: "explore",
      deadlineMs: 100, deadlineGraceMs: 200,
    });
    let result: { ok?: boolean; finalText?: string } | undefined;
    await backend.spawn({ taskId: "sub-dl", instructions: "探索", workdir: dir, permissions: "readonly" } as never, (e) => {
      if (e.type === "result") result = e.result as typeof result;
    });
    await waitFor(() => result, 15_000);
    expect(result?.ok).toBe(true);
    expect(result?.finalText).toContain("[deadline 收割]");
  }, 25_000);

  it("串台守卫采用子 journal 产出(非正常返回路径)同样收尾", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-closeout-x-"));
    const usable = "调查报告:电子签网页建议放在 apps/web-sign/ 目录(工作区当前尚无前端目录)。技术栈取 vite+react,路由注册方式沿用网关 panel.ts 单页挂载。\n"
      + "证据:package.json workspaces 声明;apps/ 目录清单;电子签涉及签署流程与网页路由注册方式如上,仓库根目录结构为 pnpm monorepo。";
    const TASK = "只读勘察,不要修改任何文件。目标:判断电子签网页应该放在工作区哪个位置、用什么技术栈。需要查清并逐条给出证据:仓库根目录结构、现有前端技术栈、路由注册方式。";
    const noop = () => ({ id: "c", name: "list_dir", arguments: JSON.stringify({ path: "." }) });
    const backend = new LlmLoopBackend({
      llm: scripted([
        { content: "", toolCalls: [noop()] },
        { content: usable, toolCalls: [noop()] },
        { content: "商品导入 Excel 请联系服务商;本段与任务书主题无关,纯异题内容占位。" },
      ], { tools: [] }),
      roots: [dir], workdir: dir, role: "explore", maxSteps: 6,
    });
    let result: { ok?: boolean; finalText?: string; note?: string } | undefined;
    await backend.spawn({ taskId: "sub-x", instructions: TASK, workdir: dir, permissions: "readonly" } as never, (e) => {
      if (e.type === "result") result = e.result as typeof result;
    });
    await waitFor(() => result, 20_000);
    expect(result?.note).toContain("[crosstalk-guard]");
    expect(result?.finalText).toContain("apps/web-sign");
  }, 30_000);
});
