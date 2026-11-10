/**
 * 进程内 LLM 子代理后端(完整 ZCode 机制移植):角色工具集(worker=读+写+bash;explore=只读)/
 * 系统提示角色化/结果回流。真 TaskSupervisor 不需要——直接驱动后端。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend, llmLoopReadOnlyTools } from "../src/llm-loop-backend.js";
import { codeSenseTool } from "../src/sense-tool.js";
import { boardSkillBody } from "../src/board-skills.js";

function fakeLlm(script: Array<{ content: string; toolCalls?: { id: string; name: string; arguments: string }[] }>) {
  let i = 0;
  return { async chat() { const r = script[Math.min(i, script.length - 1)]!; i++; return r; } } as never;
}

describe("llm-loop backend(完整角色机制)", () => {
  it("worker 角色工具集=只读四件+write_file/edit_file/run_cmd;explore=只读(step-061:读面补 glob)", async () => {
    const roots = [tmpdir()];
    expect(llmLoopReadOnlyTools(roots).map((t) => t.name)).toEqual(["read_file", "glob", "list_dir", "grep"]);
  });

  it("worker:write_file 落盘+run_cmd 执行(端到端真写真跑)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-"));
    const backend = new LlmLoopBackend({
      llm: fakeLlm([
        { content: "写文件", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: join(dir, "out.txt"), content: "hello worker" }) }] },
        { content: "跑命令", toolCalls: [{ id: "r1", name: "run_cmd", arguments: JSON.stringify({ command: "cat out.txt | wc -c" }) }] },
        { content: "完成报告:文件写入并验证,11 字节" },
      ]),
      roots: [dir], workdir: dir, role: "worker",
    });
    const events: string[] = [];
    let result: { ok: boolean; finalText?: string } | undefined;
    const handle = await backend.spawn({ taskId: "t1", instructions: "写文件", workdir: dir, permissions: "sandbox" }, (e) => { events.push(e.type); if (e.type === "result") result = e.result; });
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
    expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("hello worker");
    expect(result?.ok).toBe(true);
    expect(result?.finalText).toContain("11 字节");
    expect(events).toContain("ready");
    void handle;
  }, 20_000);

  it("explore 角色:write_file 不在工具面(只读纪律机制化)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-e-"));
    let sawTools: string[] = [];
    const backend = new LlmLoopBackend({
      llm: { async chat(_m: unknown, tools: { name: string }[]) { sawTools = tools.map((t) => t.name); return { content: "done" }; } } as never,
      roots: [dir], workdir: dir, role: "explore",
    });
    await backend.spawn({ taskId: "t2", instructions: "探索", workdir: dir, permissions: "readonly" }, () => {});
    expect(sawTools).not.toContain("write_file");
    expect(sawTools).toContain("grep");
  }, 15_000);

  it("code_sense 在授予面 → 系统提示注入调用手册(含 branches);未授予不注入(2026-10-21)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-cs-"));
    const holder: { with?: string; without?: string } = {};
    const sysGrabber = (key: "with" | "without") =>
      ({ async chat(m: unknown) {
        const msgs = m as { role: string; content: string }[];
        holder[key] = msgs.find((x) => x.role === "system")?.content ?? holder[key];
        return { content: "done" };
      } } as never);
    const withSense = new LlmLoopBackend({
      llm: sysGrabber("with"), roots: [dir], workdir: dir, role: "explore",
      extraTools: [codeSenseTool(dir)],
    });
    await withSense.spawn({ taskId: "tcs1", instructions: "探索", workdir: dir, permissions: "readonly" }, () => {});
    await new Promise((r) => setTimeout(r, 400));
    expect(holder.with ?? "").toContain("code_sense 调用手册");
    expect(holder.with ?? "").toContain("action=impact");
    expect(holder.with ?? "").toContain("action=branches");
    expect(holder.with ?? "").toContain("mode=debug");

    const without = new LlmLoopBackend({
      llm: sysGrabber("without"), roots: [dir], workdir: dir, role: "explore",
    });
    await without.spawn({ taskId: "tcs2", instructions: "探索", workdir: dir, permissions: "readonly" }, () => {});
    await new Promise((r) => setTimeout(r, 400));
    expect(holder.without ?? "").not.toContain("code_sense 调用手册");
  }, 15_000);

  it("steering:运行中注入指令,最终报告反映转向内容", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-s-"));
    // 多步脚本:先空转两步(给 steer 留窗口),最后一步不再调工具
    let step = 0;
    const backend = new LlmLoopBackend({
      llm: { async chat(_m: unknown, tools: { name: string }[]) {
        step++;
        if (step <= 2) return { content: `step${step}`, toolCalls: [{ id: "s" + step, name: "grep", arguments: JSON.stringify({ pattern: "anything" }) }] };
        return { content: "最终报告(含转向)" };
      } } as never,
      roots: [dir], workdir: dir, role: "explore",
    });
    let handle: import("@lampgenie/executors").SubagentHandle | undefined;
    let result: { ok: boolean; finalText?: string } | undefined;
    const spawned = await backend.spawn({ taskId: "ts", instructions: "调查", workdir: dir, permissions: "readonly" }, (e) => {
      if (e.type === "result") result = e.result;
    }).then((h) => { handle = h; return h; });
    void spawned;
    // 中途转向(等第一步跑完)
    await new Promise((r) => setTimeout(r, 400));
    const steered = await handle!.steer("重点调查 config 目录");
    expect(steered, "steer 应成功").toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    expect(result?.ok).toBe(true);
    expect(result?.finalText).toContain("最终报告");
  }, 20_000);

  it("路径越界防护:read_file 拒绝仓库根外路径", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-g-"));
    const tools = llmLoopReadOnlyTools([dir]);
    const readFile = tools.find((t) => t.name === "read_file")!;
    const out = String(await readFile.execute({ path: "/etc/passwd" }));
    expect(out.startsWith("错误:")).toBe(true);
  });

  // step-064 回归门禁:白名单声明与工具池零交集=装配错配,必须 fail-visible,
  // 不允许静默启动无 tools 的纯文本子 loop(provider 对空 tools 不带 tools 字段)。
  it("白名单错配 fail-visible:声明 tokens 与工具池零交集→spawn 即抛错,不产 result 事件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-wl-"));
    const backend = new LlmLoopBackend({
      llm: { async chat() { throw new Error("纯文本子 loop 不应被启动"); } } as never,
      roots: [dir], workdir: dir, role: "worker",
      toolWhitelist: ["typo_tool", "nonexistent_group"],
    });
    const events: string[] = [];
    await expect(
      backend.spawn({ taskId: "twl", instructions: "不该跑起来", workdir: dir, permissions: "sandbox" }, (e) => { events.push(e.type); }),
    ).rejects.toThrow(/工具面为空/);
    expect(events, "fail-visible 必须发生在 ready/任何事件之前").toEqual([]);
  });

  it("白名单命中正常路径不误伤:声明 read 组→工具面含 read_file(grep),spawn 正常", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-wlok-"));
    let sawTools: string[] = [];
    const backend = new LlmLoopBackend({
      llm: { async chat(_m: unknown, tools: { name: string }[]) { sawTools = tools.map((t) => t.name); return { content: "done" }; } } as never,
      roots: [dir], workdir: dir, role: "explore",
      toolWhitelist: ["read", "skill_view"],
    });
    await backend.spawn({ taskId: "twlok", instructions: "调查", workdir: dir, permissions: "readonly" }, () => {});
    expect(sawTools).toContain("read_file");
    expect(sawTools).toContain("grep");
    expect(sawTools).not.toContain("write_file");
  }, 15_000);

  // step-064 回归(承 step-062 遗留①「终止后端中断语义」):handle.cancel 必须**立即**打断
  // in-flight LLM 调用并落终态(result ok=false),不得等 deadline 兜底。fake LLM 按 fetch 同款
  // 语义响应 abort signal(reject on abort)=真实 fetch 中断行为的可测替身。
  it("cancel 即时中断:in-flight LLM 调用被 abort 打断,2s 内落 cancelled 终态", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-cancel-"));
    const backend = new LlmLoopBackend({
      llm: { async chat(_m: unknown, _t: unknown, signal?: AbortSignal) {
        await new Promise((_res, rej) => {
          if (signal?.aborted) return rej(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          signal?.addEventListener("abort", () => rej(signal.reason instanceof Error ? signal.reason : new Error("aborted")), { once: true });
        });
        return { content: "不该到达" };
      } } as never,
      roots: [dir], workdir: dir, role: "worker",
      stallTimeoutMs: 60_000, // 干扰项置远:终态必须来自 cancel 而非 watchdog
    });
    let result: { ok: boolean; error?: { kind?: string } } | undefined;
    const handle = await backend.spawn({ taskId: "tcancel", instructions: "长任务", workdir: dir, permissions: "sandbox" }, (e) => {
      if (e.type === "result") result = e.result as typeof result;
    });
    await new Promise((r) => setTimeout(r, 300)); // 等 loop 建立且 LLM 在飞
    const t0 = Date.now();
    await handle.cancel("graceful");
    for (let i = 0; i < 40 && !result; i++) await new Promise((r) => setTimeout(r, 50));
    expect(result, "cancel 后 2s 内必须落终态(不等 deadline/watchdog)").toBeTruthy();
    expect(Date.now() - t0, "终态时延 <2s(即时中断语义)").toBeLessThan(2_000);
    expect(result!.ok).toBe(false);
    expect(result!.error?.kind).toBe("cancelled");
  }, 15_000);

  it("防死 watchdog:无动静超阈值→强制退出+卡点报告(阈值注入 300ms)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-stall-"));
    const backend = new LlmLoopBackend({
      // 挂死的 LLM 调用:永不返回(且不响应 abort 的极端形态)
      llm: { async chat() { await new Promise(() => {}); } } as never,
      roots: [dir], workdir: dir, role: "worker", stallTimeoutMs: 300,
    });
    let result: { ok: boolean; finalText?: string; error?: { kind?: string } } | undefined;
    await backend.spawn({ taskId: "tstall", instructions: "会挂起的任务", workdir: dir, permissions: "sandbox" }, (e) => {
      if (e.type === "result") result = e.result as typeof result;
    });
    // watchdog 触发(tick=250ms 起)+二级保险(cancel 后 10s 终局)→ 上限 12s
    await new Promise((r) => setTimeout(r, 12_000));
    expect(result, "12s 内必须拿到 result(防死兜底)").toBeTruthy();
    expect(result!.ok).toBe(false);
    expect(result!.error?.kind).toBe("stalled");
    expect(result!.finalText).toContain("无任何动静");
    expect(result!.finalText).toContain("卡点");
  }, 20_000);
});

describe("子代理与 coding agent 同构(2026-10-20):事件保真 + 流式/压缩透传", () => {
  it("trimSubLoopEvent:llm.trace 结构化(不再是 raw);message.agent 保留 usage", async () => {
    const { trimSubLoopEvent } = await import("../src/llm-loop-backend.js");
    const tr = trimSubLoopEvent("llm.trace", {
      file: "/x/.genie/llm-trace/subagent-t1-sub/call-0001-t1s0.json",
      turn: 3, step: 2, model: "GLM-5.3", durationMs: 1234, ttftMs: 120,
      usage: { inputTokens: 10, outputTokens: 5 }, messageRoles: ["system", "user"],
      toolCalls: ["terminal"], error: "LLM 网络错误(已重试 2 次,建连类): fetch failed (ConnectTimeoutError)",
    });
    expect(tr).toMatchObject({ file: expect.stringContaining("subagent-t1-sub"), turn: 3, step: 2, model: "GLM-5.3", durationMs: 1234, ttftMs: 120 });
    expect((tr as { usage?: object }).usage).toMatchObject({ inputTokens: 10 });
    expect((tr as { error?: string }).error).toContain("ConnectTimeoutError");
    expect(tr.raw).toBeUndefined();
    const ma = trimSubLoopEvent("message.agent", { text: "回复", turn: 1, step: 0, llmMs: 100, reasoning: "想", usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 2 } });
    expect((ma as { usage?: object }).usage).toMatchObject({ inputTokens: 7, cachedTokens: 2 });
  });

  it("onStream/compactHook/microcompact 透传:子 loop 收到同源配置(打字机+压缩不再是主轨专属)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmlb-par-"));
    const streams: string[] = [];
    const compacts: string[] = [];
    const backend = new LlmLoopBackend({
      llm: fakeLlm([{ content: "好" }]),
      roots: [dir], workdir: dir, role: "worker",
      onStream: (ev: { type: string }) => { streams.push(ev.type); },
      compactHook: async (_j: unknown, sid: unknown) => { compacts.push(String(sid)); },
      microcompact: { thresholdTokens: 100 },
    });
    await backend.spawn({ taskId: "tp1", instructions: "回复", workdir: dir, permissions: "sandbox" }, () => {});
    await new Promise((r) => setTimeout(r, 1200));
    expect(streams).toContain("llm-begin");
    expect(streams).toContain("llm-end");
    expect(compacts.some((s) => s === "subagent-tp1")).toBe(true);
  }, 20_000);
});

it("planner 角色专属板规范注入;非 planner 不注入(2026-10-26 分阶段技能化)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llmlb-pl-"));
  const grab = (key: string) => ({ async chat(m: unknown) {
    const msgs = m as { role: string; content: string }[];
    (globalThis as Record<string, unknown>)[key] = msgs.find((x) => x.role === "system")?.content ?? "";
    return { content: "done" };
  } } as never);
  const planner = new LlmLoopBackend({ llm: grab("__plSys"), roots: [dir], workdir: dir, role: "planner" });
  await planner.spawn({ taskId: "tpl1", instructions: "规划", workdir: dir, permissions: "readonly" }, () => {});
  const worker = new LlmLoopBackend({ llm: grab("__wkSys"), roots: [dir], workdir: dir, role: "worker" });
  await worker.spawn({ taskId: "tpl2", instructions: "干活", workdir: dir, permissions: "sandbox" }, () => {});
  await new Promise((r) => setTimeout(r, 500));
  const pl = String((globalThis as Record<string, unknown>).__plSys ?? "");
  const wk = String((globalThis as Record<string, unknown>).__wkSys ?? "");
  expect(pl).toContain("planner 板规范");
  expect(pl).toContain("控制流程图");
  expect(pl).toContain("交板自检");
  // 2026-10-26 用户口径:13 类画法拆到 board-skills 的 collect/draw/audit;
  // 系统提示只保留调度器+通用硬规则+板型索引,不再把所有类型规则一次性塞进来。
  for (const m of [
    "先判型,再按需加载", 'skill_view(category="board"', "<boardType>/collect", "<boardType>/audit",
    "板型索引", "code=代码开发", "ui-func=UI+功能", "通用硬规则(全板型",
    "modify/delete 必带 before", "symbolRef", "P0 accept", "scale",
  ]) {
    expect(pl).toContain(m);
  }
  // 类型细节必须在对应 skill 里可加载(系统提示不再背 13 类全文)。
  expect(pl).not.toContain("纯 UI=docKind=page 页面结构板");
  expect(boardSkillBody("ui", "draw")).toContain("纯 UI");
  expect(boardSkillBody("fault", "draw")).toContain("根因");
  expect(boardSkillBody("code", "draw")).toContain("symbolRef");
  expect(wk).not.toContain("planner 板规范");
}, 15_000);
