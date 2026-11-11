/**
 * 机制接线审计回归锚。
 * 背景:一批机制实现完成后,反复出现「代码在、但生产 7700 路径没接线 / 配置缺省关闭 /
 * 只接了主 agent 没接子代理」。本文件把「四条装配链(主 agent / 子代理 / super / session-worker)
 * 的真实入口」钉成源码级断言:
 *   - 构造点必须真的把选项传下去(不是定义了就完事);
 *   - 工具面必须真的挂上名字;
 *   - 收尾段必须真的落 journal 事件;
 *   - 配置 schema 必须真的收这两个键(否则配置写了会被 zod 静默剥离)。
 * 对「结构性未接线」的项用负面断言显式登记(未接线不得被当成 active)——
 * 这样将来谁真接线了,断言会提示把登记改成 active,而不是靠人记忆。
 * 为什么读源码而不跑行为:大多数入口在 runWithAgent 的收尾段,构造一次真实 loop 成本过高;
 * 源码断言能精确锁住「这行还在」。schema 侧同理(workspace 测试解析的是 core/dist,
 * 源码改了而 dist 未重建时会给出假红——接线审计要锁的是源码事实)。
 * 零反斜杠纪律:只用 includes 字面串。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const src = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf-8");
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

const WIRING = src("apps/gateway/src/agent-wiring.ts");
const CLOSEOUT = src("apps/gateway/src/task-closeout.ts");
const SUB = src("apps/gateway/src/llm-loop-backend.ts");
const SUPER = src("apps/gateway/src/super-agent.ts");
const WORKER = src("apps/gateway/src/session-worker.ts");
const WORKER_LIB = src("apps/gateway/src/session-worker-lib.ts");
const APP = src("apps/gateway/src/app.ts");
const SERVER = src("apps/gateway/src/server.ts");
const SCHEMA = src("packages/core/src/config/schema.ts");
const LOOP = src("packages/harness-runtime/src/agent/loop.ts");
const PROVIDER = src("packages/harness-runtime/src/agent/openai-provider.ts");
const PROFILES = src("packages/harness-runtime/src/agent/agent-profiles.ts");

describe(" 写前屏障: 选项四链透传 + worker flushStrict RPC ack", () => {
  it("主链与子代理链都把 writeBarrierOf(agentConfig) 传进 loop 构造", () => {
    // 主 loop:const writeBarrier = writeBarrierOf(agentConfig) + {...(writeBarrier ? { writeBarrier } : {})}
    expect(count(WIRING, "writeBarrierOf(agentConfig)")).toBeGreaterThanOrEqual(2);
    expect(WIRING).toContain("...(writeBarrier ? { writeBarrier } : {})");
  });

  it("super 链把 deps.writeBarrier 传给 AgentLoop", () => {
    expect(SUPER).toContain("...(deps.writeBarrier ? { writeBarrier: deps.writeBarrier } : {})");
  });

  it("worker 模式的 ProxyJournal.flushStrict 走 RPC ack(appendSync + flushStrict)", () => {
    expect(WORKER_LIB).toContain('"journal.flushStrict"');
    expect(WORKER_LIB).toContain('"journal.appendSync"');
  });
});

describe(" 图片 offload:主/子/super 三链都传 imageOffload", () => {
  it("主链与子代理链用 imageOffloadOf(repoRoot()) 注入 root", () => {
    expect(count(WIRING, "imageOffloadOf(repoRoot())")).toBeGreaterThanOrEqual(2);
  });

  it("子代理重派 loop 与首跑同值(this.opts.imageOffload)", () => {
    expect(SUB).toContain("imageOffload,");
    expect(SUB).toContain("this.opts.imageOffload");
  });

  it("super 链透传 deps.imageOffload", () => {
    expect(SUPER).toContain("...(deps.imageOffload ? { imageOffload: deps.imageOffload } : {})");
  });
});

describe(" todo 严格 +  job registry 工具面挂载", () => {
  it("主工具面传 allowParallelInProgress(绑定 schema 键)", () => {
    expect(WIRING).toContain(
      "allowParallelInProgress: agentConfig?.agent?.todoAllowParallelInProgress === true",
    );
  });

  it("主工具面挂 job 工具并绑定 registry/owner", () => {
    expect(WIRING).toContain("createJobTool({");
    expect(WIRING).toContain("registry: getJobRegistry(journal),");
  });

  it("session 结束时 disposeSessionJobs 在 finally 里回收", () => {
    expect(WIRING).toContain("await disposeSessionJobs(journal, task.sessionId);");
    expect(WIRING).toContain("后台 job 回收");
  });

  it("job 结算落 journal(custom job.done)", () => {
    expect(WIRING).toContain('type: "job.done"');
  });
});

describe("///// 收尾段与事件(主链)", () => {
  it(" 完成审计:缺省 warn + 事件 completion.audit(公共收尾模块)", () => {
    expect(WIRING).toContain("completionMode");
    expect(WIRING).toContain("?? \"warn\"");
    expect(WIRING).toContain("runTaskCloseout(");
    expect(CLOSEOUT).toContain('"completion.audit"');
  });

  it(" 变更账本:captureBaseline 在任务起点采集,收尾落 turn.change-ledger", () => {
    expect(WIRING).toContain("captureBaseline(taskRoot)");
    expect(CLOSEOUT).toContain('"turn.change-ledger"');
  });

  it(" 指导指标:收尾落 guidance.metrics", () => {
    expect(CLOSEOUT).toContain('"guidance.metrics"');
  });

  it(" 验证账本:verifyMode 缺省 warn + 事件 verify.ledger", () => {
    expect(WIRING).toContain("verifyMode");
    expect(CLOSEOUT).toContain('"verify.ledger"');
  });

  it(" 引用账本:cite_source 工具挂主工具面 + 收尾 citation.audit", () => {
    expect(WIRING).toContain("makeCiteSourceTool({");
    expect(CLOSEOUT).toContain('"citation.audit"');
  });

  it(" 交付物:deliverable 工具挂主工具面 + done 收尾逐项核对", () => {
    expect(WIRING).toContain("makeDeliverableTool({");
    expect(CLOSEOUT).toContain("readDeliverables(");
    expect(CLOSEOUT).toContain("verifyDeliverables(");
    expect(CLOSEOUT).toContain('"deliverable.verified"');
  });

  it("三条链同源:子代理与 super 都调同一公共收尾函数", () => {
    expect(SUB).toContain("runTaskCloseout({");
    expect(SUB).toContain('mode: "subagent"');
    expect(SUPER).toContain("runTaskCloseout({");
    expect(SUPER).toContain('mode: "super"');
  });
});

describe(" goal 护栏 /  用户停止 /  尾部修复入口", () => {
  it(" 任务终态后走 maybeContinueGoal(主链与 gateway onTaskDone 各一处)", () => {
 // 允许调用方在 sessionId 之后追加可选参数(如 expectedRevision):断言前缀而不是整行字面。
    expect(WIRING).toContain("maybeContinueGoal(tm, journal, llm, task.sessionId");
    expect(APP).toContain("maybeContinueGoal(taskManager, journal");
  });

  it(" 取消路径落 task.user_stopped 标记", () => {
    expect(WIRING).toContain('appendUserStoppedMarker(journal, { taskId: task.id');
    expect(WIRING).toContain('source: "cancel"');
  });

  it(" 尾部修复:autoResume 与 task_resume 两处入口都调用 repairTailBeforeResume", () => {
    expect(count(APP, "repairTailBeforeResume(")).toBeGreaterThanOrEqual(2);
    expect(SERVER).toContain("repairTailBeforeResume(opts.journal, task.sessionId)");
  });
});

describe(" LSP delta /  续写 /  模型错误策略 /  参数归一(无需 gateway 接线)", () => {
  it(" 子代理侧写前采集 baseline(与主 agent file-tools 同序)", () => {
    expect(SUB).toContain("if (settings.baseline === false) return undefined;");
    expect(SUB).toContain("await mod.collectBaselineDiagnostics(");
    expect(SUB).toContain("editCheckSuffixSafe(workdir, abs, lsp, base?.baseline, base?.baselineText)");
  });

  it(" 输出续写:loop 内 finishReason=length 触发续写分支", () => {
    expect(LOOP).toContain('res.finishReason === "length"');
  });

  it(" 模型错误策略:provider 真的调 classifyModelError", () => {
    expect(PROVIDER).toContain("classifyModelError(");
    expect(PROVIDER).toContain("model-error-policy");
  });

  it(" 工具参数归一:loop 走 executeTracked", () => {
    expect(LOOP).toContain("this.executeTracked(");
  });
});

describe(" 指令链 /  browser 默认开启", () => {
  it(" composeSystemPrompt 用 discoverAgentsMd(taskRoot) 自动收集指令链", () => {
    expect(WIRING).toContain("composeSystemPrompt({");
    expect(WIRING).toContain("discoverAgentsMd(taskRoot)");
  });

  it(" browser:配置缺省 enabled=true,且主工具面按开关挂载", () => {
    expect(SCHEMA).toContain("browser: z.object({");
    const browserBlock = SCHEMA.slice(
      SCHEMA.indexOf("browser: z.object({"),
      SCHEMA.indexOf("browser: z.object({") + 400);
    expect(browserBlock).toContain("enabled: z.boolean().default(true)");
    expect(WIRING).toContain("...(browserTool ? [browserTool] : [])");
  });
});

describe("配置面:schema 真的收收尾段开关(修复 citationAudit/completionAudit 缺失)", () => {
  it("citationAudit / completionAudit 与 changeAudit/verifyOnStop 同型声明", () => {
    expect(SCHEMA).toContain('citationAudit: z.enum(["off", "warn", "hard"]).optional()');
    expect(SCHEMA).toContain('completionAudit: z.enum(["off", "warn", "hard"]).optional()');
    expect(SCHEMA).toContain('changeAudit: z.enum(["hard", "warn", "off"]).optional()');
    expect(SCHEMA).toContain('verifyOnStop: z.enum(["off", "warn", "hard"]).optional()');
  });

  it("/ 的配置键也在 schema 里(writeBarrier / todoAllowParallelInProgress)", () => {
    expect(SCHEMA).toContain('writeBarrier: z.enum(["off", "hard"]).optional()');
    expect(SCHEMA).toContain("todoAllowParallelInProgress: z.boolean().optional()");
  });
});

describe("未接线登记(负面断言:这些不得被当成 active)", () => {
  it("子代理/super 链没有 ///// 收尾段(登记 partial,需抽公共 finally)", () => {
    for (const ev of ['"completion.audit"', '"citation.audit"', '"guidance.metrics"', '"verify.ledger"']) {
      expect(SUB.includes(ev)).toBe(false);
      expect(SUPER.includes(ev)).toBe(false);
    }
  });

  it("只读角色(explore/judge/test-analyst/planner)工具白名单无 job(登记 default-off)", () => {
    const exploreLine = PROFILES.split("\n").find((l) => l.includes('name: "explore"')) ?? "";
    expect(exploreLine).toContain('tools: ["read", "code_sense", "skill_view"]');
    expect(exploreLine.includes('"job"')).toBe(false);
  });

  it(" compactionInFlight 只有定义与单测,没有收尾/闸门消费方(登记 inert helper)", () => {
    expect(src("packages/harness-runtime/src/agent/auto-compact.ts")).toContain("export function compactionInFlight(");
    // 两个潜在消费方都不得引用它——引用即说明已接线,应把本断言改成 active
    expect(src("apps/gateway/src/compact-gate.ts").includes("compactionInFlight")).toBe(false);
    expect(src("apps/gateway/src/compact-hook.ts").includes("compactionInFlight")).toBe(false);
  });
});
