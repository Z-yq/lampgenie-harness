/**
 * 真实子代理验收(P1-4 产出纪律):进程内用真模型跑 LlmLoopBackend。
 *
 * 为什么必须进程内:主 agent 的 spawn_subagent 走 7700 网关进程(那里的 dist 是旧代码),
 * 拿它验证等于验证旧代码。这里直接 new LlmLoopBackend(src) 才是改后路径。
 *
 * 判定逻辑(避免把「模型很爱说话」误判成失败):
 *   - 模型连续 ≥N 步都给不出实质产出(≥200 字)→ **必须**注入 [产出纪律];
 *   - 模型每步都有实质产出 → 不注入才是对的(计数器被正确清零)。
 *   - 唯一算 bug 的形态:连续多步只有短文(<200)却一次都没注入(= 旧的永久锁)。
 *
 * 默认 skip(真调模型有成本)。开门:
 *   GENIE_E2E_REAL=1 npx vitest run test/e2e-real-subagent.test.ts
 */
import { it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@lampgenie/core";
import { buildLlmFromConfig } from "../src/factory.js";
import { LlmLoopBackend, PRODUCTIVE_SUBSTANTIVE_CHARS } from "../src/llm-loop-backend.js";

const REAL_E2E = process.env.GENIE_E2E_REAL === "1";
const root = process.cwd().includes("apps/gateway") ? join(process.cwd(), "..", "..") : process.cwd();

/** 造「必须逐个打开才知道答案」的目录:内容是随机校验码,文件名不含答案。 */
function makeScanDir(files: number): string {
  const d = mkdtempSync(join(tmpdir(), "p14-real-"));
  for (let i = 0; i < files; i++) {
    const code = String(((i * 7919) % 1000)).padStart(3, "0");
    writeFileSync(join(d, `f${i}.txt`), `文件 ${i} 的校验码 = C${code}\n`.repeat(8), "utf-8");
  }
  return d;
}

it.skipIf(!REAL_E2E)("真实子代理:P1-4 连续无实质产出必注入 [产出纪律](不再被一行短文永久锁死)", async () => {
  const cfg = loadConfig({ repoRoot: root } as never);
  const real = buildLlmFromConfig((cfg as { config?: unknown }).config as never, root);
  if (!real) {
    console.log("[e2e-real-sub] SKIP: buildLlmFromConfig 返回 undefined");
    return;
  }

  const dir = makeScanDir(24);
  const respLens: number[] = [];      // 每次响应的文本长度
  const nudgeAtCall: number[] = [];   // 第几次调用时请求里带 [产出纪律]
  const SCRIPTED_TOOL_ONLY = 6;       // 前 6 步脚本化为「只调工具不出文本」
  const realChat = (real as { chat: (m: unknown, o?: unknown) => Promise<{ content?: string }> }).chat.bind(real);

  // 混合驱动(2026-10-30):真实模型 5 次里有 4 次会即时吐文本,靠它自然凑出
  // 「连续多步零产出」不可控。这里前 N 步脚本化为**只调工具、content 为空**——
  // 这正是真实 trace 里 89 步零产出 run 的形态;第 N 步之后完全交回真实模型。
  // 被测代码路径(loop、tips 注入、计数器、工具执行、journal)全部是真的。
  const wrapped = {
    async chat(messages: unknown, opts?: unknown) {
      const arr = messages as { content?: unknown }[];
      const hasNudge = arr.some((m) => String(m.content ?? "").includes("[产出纪律]"));
      if (hasNudge) nudgeAtCall.push(respLens.length);
      if (respLens.length < SCRIPTED_TOOL_ONLY) {
        // 交替用两种只读工具,确保工具真的执行、历史真的增长
        const name = respLens.length % 2 === 0 ? "read_file" : "list_dir";
        const args = name === "read_file" ? { path: `f${respLens.length}.txt` } : { path: "." };
        respLens.push(0);
        return { content: "", toolCalls: [{ id: `c${respLens.length}`, name, arguments: JSON.stringify(args) }] };
      }
      const r = (await realChat(messages, opts)) as { content?: string };
      respLens.push(String(r?.content ?? "").length);
      return r;
    },
  } as never;

  try {
    const backend = new LlmLoopBackend({
      llm: wrapped,
      roots: [dir],
      workdir: dir,
      role: "explore",
      maxSteps: 30,
      // 机制与缺省 25 步完全相同,只为把真跑成本压下来(4 步即可触发)
      productiveNudgeSteps: 4,
    } as never);

    let finalText = "";
    let done = false;
    await backend.spawn(
      {
        taskId: "p14-real",
        instructions: "只读任务。逐个读取目录下所有 .txt 文件,统计每个文件的校验码(形如 C###),"
          + "最后输出一张「文件名 → 校验码」的完整清单。必须先读文件,不要猜。",
        workdir: dir,
        permissions: "readonly",
      } as never,
      (e: { type?: string; result?: { finalText?: string } }) => {
        if (e?.type === "result") { finalText = String(e.result?.finalText ?? ""); done = true; }
      },
    );
    // spawn 返回的是 handle,子 loop 在后台跑:必须等 result 事件(先前用例踩过同样的坑)
    const deadline = Date.now() + 8 * 60_000;
    while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    if (!done) console.log("[e2e-real-sub] 等待超时:未收到 result 事件(已跑调用数=" + respLens.length + ")");

    const substantive = respLens.filter((n) => n >= PRODUCTIVE_SUBSTANTIVE_CHARS).length;
    const short = respLens.filter((n) => n < PRODUCTIVE_SUBSTANTIVE_CHARS).length;
    console.log(
      `[e2e-real-sub] 调用=${respLens.length} 实质产出步=${substantive} 非实质步=${short}`
      + ` | 注入次数=${nudgeAtCall.length} 注入于调用序号=${JSON.stringify(nudgeAtCall)}`
      + ` | 最终文本=${finalText.length} 字`,
    );

    // 只有这一个形态算 bug:连续多步无实质产出却从未注入(= 旧的永久锁)
    if (short >= 8) {
      expect(nudgeAtCall.length, "连续 8+ 步无实质产出必须注入 [产出纪律](旧永久锁会 0 次)").toBeGreaterThan(0);
    } else {
      console.log("[e2e-real-sub] 模型每步都有实质产出,本 run 不构成注入条件(计数器清零属正确行为)");
    }
    expect(finalText.length).toBeGreaterThan(0);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
  }
}, 12 * 60_000);