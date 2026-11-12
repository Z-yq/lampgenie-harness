/**
 * fixG(交付过程优化官 G四件的单测面:
 * G1 codeReviewTool checkpoint 基线接线——任务带 checkpoint 时 review 只审本任务变更集
 *    (diff 无别人的在途改动),checkpoint 缺席回退全仓;fast:true 只跑确定性层(零 LLM)。
 * G2/G3 提示词纪律在场断言(派发与等待/验证轮次自省)+ task_output waitSec 语义。
 * G4 restore 收编统一文案「网关重启中断(可重发)」+ 面板渲染分支/重发按钮标记在场。
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codeReviewTool } from "../src/agent-wiring.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { Task } from "@lampgenie/core";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { PANEL_SRC as panel } from "./panel-source.js";
import { AGENT_WIRING_SRC } from "./panel-source.js";

/** 共享工作区双改动现场:b.ts=开工前已在途(别人的),a.ts/mine-new.ts=本任务开工后改的。
 * 快照形态与生产环境 checkpointCreate 一致(git stash create 悬空 commit,不动工作区)。 */
function dualChangeRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-fixg1-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
  g("init -q"); g('config user.email t@t'); g('config user.name t');
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  g("add ."); g('commit -qm "init"');
  appendFileSync(join(dir, "b.ts"), "export const otherAgent = 1;\n"); // 别人的在途改动
  const base = execSync("git stash create", { cwd: dir }).toString().trim();
  if (!base) throw new Error("stash create 未产出快照");
  appendFileSync(join(dir, "a.ts"), "export const mine = 2;\n"); // 本任务 tracked 改动
  writeFileSync(join(dir, "mine-new.ts"), "export const fresh = 1;\n"); // 本任务新文件
  return { dir, base };
}

/** 读最近一次 review 会话落盘(.genie/reviews/<id>.json)的受审文件清单。 */
function lastReviewFiles(dir: string): string[] {
  const revDir = join(dir, ".genie", "reviews");
  const ids = readdirSync(revDir).filter((f) => f.endsWith(".json")).sort();
  const sess = JSON.parse(readFileSync(join(revDir, ids.at(-1)!), "utf-8")) as { target: { files: { path: string }[] } };
  return sess.target.files.map((f) => f.path);
}

describe("fixG1 codeReviewTool checkpoint 基线接线", () => {
  it("任务带 checkpoint→只审本任务变更集(diff 无别人的在途文件);journal 落 baseSha", async () => {
    const { dir, base } = dualChangeRepo();
    const j = new MemoryJournal();
    const out = String(await codeReviewTool(dir, undefined, j, "sess-g1", undefined, base).execute({}));
    expect(out).toContain("基线=任务 checkpoint"); // summary 如实标注口径
    const ev = j.readAll().find((e) => e.kind === "review.findings")?.payload as { baseSha?: string };
    expect(ev?.baseSha).toBe(base);
    const files = lastReviewFiles(dir);
    expect(files).toContain("a.ts");
    expect(files).toContain("mine-new.ts"); // untracked 照旧收集
    expect(files).not.toContain("b.ts"); // 干扰文件不进本任务变更集
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("checkpoint 缺席→回退全仓未提交(两份改动都在),payload 无 baseSha 且如实无基线标注", async () => {
    const { dir } = dualChangeRepo();
    const j = new MemoryJournal();
    const out = String(await codeReviewTool(dir, undefined, j, "sess-g1b", undefined, null).execute({}));
    expect(out).not.toContain("基线=任务 checkpoint");
    const ev = j.readAll().find((e) => e.kind === "review.findings")?.payload as { baseSha?: string };
    expect(ev?.baseSha).toBeUndefined();
    const files = lastReviewFiles(dir);
    expect(files).toContain("a.ts");
    expect(files).toContain("b.ts"); // 全仓口径:别人的在途改动也在
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("显式 target 优先(不叠加基线);fast:true 零 LLM 调用秒级返回", async () => {
    const { dir, base } = dualChangeRepo();
    // fast:深审 LLM 一次都不该被调
    let llmCalls = 0;
    const spyLlm: LlmProvider = { async chat() { llmCalls++; return { content: "{}" }; } };
    const j = new MemoryJournal();
    const out = String(await codeReviewTool(dir, spyLlm, j, "sess-g1c").execute({ fast: true }));
    expect(llmCalls).toBe(0);
    expect(out).toContain("确定性");
    const ev = j.readAll().find((e) => e.kind === "review.findings")?.payload as { fast?: boolean };
    expect(ev?.fast).toBe(true);
    // 显式 target:即使带 baseSha 也走 commit 口径(回执含 commit 审查,无基线标注)
    const hash = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
    const out2 = String(await codeReviewTool(dir, undefined, new MemoryJournal(), "sess-g1d", undefined, base).execute({ target: hash }));
    expect(out2).not.toContain("基线=任务 checkpoint");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("fixG2/G3 提示词纪律与工具语义在场", () => {
  const src = AGENT_WIRING_SRC;

  it("G2:分档纪律含派发与等待纪律(不空轮询/并行派/等待零 LLM 通道)", () => {
    expect(src).toContain("fixG2 派发与等待纪律");
    expect(src).toContain("同一条消息里并行派");
    expect(src).toContain("12 连空轮询");
 // 等待通道升级为 wait:true / waitFor:"result"(挂起零 LLM);waitSec 保留快照/短等
    expect(src).toContain("spawn(wait:true)");
    expect(src).toContain('waitFor:\"result\"');
  });

  it("G2:task_output 工具描述明确等待语义(waitFor 等到底;waitSec 非轮询间隔)", () => {
    expect(src).toContain("挂起直到终态");
    expect(src).toContain("零 LLM");
    expect(src).toContain("短等");
  });

  it("G3:完工验收含验证轮次自省(连续 3 轮失败停修跑循环)", () => {
    expect(src).toContain("fixG3 验证轮次自省");
    expect(src).toContain("连续 3 轮失败");
    expect(src).toContain("×58");
  });

  it("G1b:完工验收第 2 步绑 checkpoint 变更集口径+fast 复跑", () => {
    expect(src).toContain("审的是**本任务变更集**");
    expect(src).toContain("fast:true");
  });

  it("G1 追加:环境噪声纪律+深审超时可收工在场;回退口径带甄别归属提示", () => {
    expect(src).toContain("环境噪声纪律");
    expect(src).toContain("环境噪声(别会话在途改动)");
    expect(src).toContain("深审超时=可收工");
    expect(src).toContain("时间盒就是终止条件");
    expect(src).toContain("不要补跑深审");
    expect(src).toContain("findings 需甄别归属");
  });
});

describe("fixG4 重启收编文案与面板渲染", () => {
  it("restore 收编 running/blocked→interrupted(可续跑);queued 原样;不动 updatedAt", () => {
    const tm = new TaskSupervisor();
    const t: Task = {
      id: "fixg4-t1", sessionId: "sess-g4", instruction: "被重启打断的任务书原文",
      state: "running", createdAt: 1700000000000, updatedAt: 1700000005000,
    };
    const collected = tm.restore([t]);
    expect(collected).toHaveLength(1);
    const after = collected[0]!;
    expect(after.state).toBe("interrupted"); // :外因中断≠人为取消
    expect(after.result).toContain("网关重启中断");
    expect(after.result).toContain("fixg4-t1"); // 回执带原任务书 id
    expect(after.updatedAt).toBe(1700000005000); // 时间是事实,收编不篡改
 // 终态任务原样保留(不重复收编);queued 原样重排队
    const done: Task = { ...t, id: "fixg4-t2", state: "done", result: "ok" };
    expect(tm.restore([done])).toHaveLength(0);
    const queued: Task = { ...t, id: "fixg4-t3", state: "queued" };
    expect(tm.restore([queued])).toHaveLength(0);
    expect(tm.get("fixg4-t3")!.state).toBe("queued");
  });

  it("面板:task.cancel/progress(cancelled) 渲染分支+「重发」按钮+绑定标记在场(源结构锁)", () => {
    // 渲染分支两形态都认(journal 取消终态实际 kind=task.progress+state=cancelled)
    expect(panel).toContain('ev.payload.state === "cancelled"');
    // 重启中断系统行+重发按钮(err-banner 通道形态,新老文案都识别)
    expect(panel).toContain("任务因网关重启中断");
    expect(panel).toContain('data-act="resend-cancel"');
    expect(panel).toContain("/重启中断/");
    // 绑定:按 data-task 取回原任务书回填提交
    expect(panel).toContain('.err-banner button[data-act="resend-cancel"]');
  });
});

describe("上下文卫生纪律(2026-10-20 繁重 coding 拆子任务,主上下文只进结论)", () => {
  const aw = AGENT_WIRING_SRC;
  it("系统提示含拆派纪律与子代理返回要求", () => {
    expect(aw).toContain("上下文卫生纪律");
    expect(aw).toContain("主上下文只进结论不进过程");
    expect(aw).toContain("按板拆成子任务派 spawn_subagent");
    expect(aw).toContain("不要贴大段原始输出");
  });
  it("grep 大输出尾注在场(file-tools 源码级锚)", () => {
    const ft = readFileSync(resolve(__dirname, "../src/file-tools.ts"), "utf-8");
    expect(ft).toContain("CONTEXT_HYGIENE_BYTES");
    expect(ft).toContain("[上下文卫生]");
  });
  it("核心纪律卡随每条用户消息注入(2026-10-20 口径;2026-10-21 瘦身=只留系统纪律,派发类移入 dispatch tip)", () => {
    expect(aw).toContain("核心纪律卡");
    expect(aw).toContain("系统纪律;直接执行,不要复述此段");
    expect(aw).toContain("DISPATCH_TIP");
    expect(aw).toContain("buildLoopTips");
  });
  it("五硬阶段流程与简明扼要 instruct 在场(2026-10-20)", () => {
    expect(aw).toContain("五硬阶段流程");
    expect(aw).toContain("task_phase");
    expect(aw).toContain("理解任务→规划→开始实施→开始验收→完成");
    expect(aw).toContain("不涉及的阶段也要显式声明不涉及");
    expect(aw).toContain("输出风格:简明扼要");
    expect(aw).toContain("不要长篇大论");
    // 分档回调:小改直做 + 大开发派子 agent + 自己斟酌
    expect(aw).toContain("小步文件修改(单文件更正、小修小补)自己上手");
    expect(aw).toContain("新模块功能开发、大型系统开发、多模块开发");
    expect(aw).toContain("自己斟酌");
  });
  it("terminal hygieneNote 开关在场(共享包默认关,主 agent 装配开)", () => {
    const tt = readFileSync(resolve(__dirname, "../../../packages/harness-terminal/src/tool.ts"), "utf-8");
    expect(tt).toContain("contextHygiene");
    expect(tt).toContain("hygieneNote");
    expect(aw).toContain("contextHygiene: {}");
  });
});
