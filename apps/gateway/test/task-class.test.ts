/**
 * 任务类别(理解阶段定类,tips/plan-gate 全消费同一结果):
 * - classifyTaskClass 纯函数:写代码信号优先(复合指令必须落 coding)→办公/产出 →问答/调研;
 *   保守缺省 coding(错判代价不对称:QA 多看编码纪律只是 token 负担,编码任务丢验收纪律才是损失);
 * - systemForTaskClass:qa 免流程/验收仪式但保留 code_sense 用法;office 只留通用段;
 *   两类都带更正路径(task_phase taskClass="coding");
 * - plan-gate 按类:非编码类不启用白板硬闸(office 指令直接写文件不再被拦)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { classifyTaskClass, systemForTaskClass, SYSTEM } from "../src/agent-wiring.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const apps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); delete process.env.GENIE_PERMISSION_RULES; });

describe("classifyTaskClass(初判启发式)", () => {
  it("写代码信号优先:符号/测试/debug/重构 → coding;复合指令「修 bug 顺便出表格」也落 coding", () => {
    expect(classifyTaskClass("修 createGatewayApp 的启动问题")).toBe("coding");
    expect(classifyTaskClass("给 parser 模块加单元测试")).toBe("coding");
    expect(classifyTaskClass("重构 callChainExtractor")).toBe("coding");
    expect(classifyTaskClass("为什么登录接口一直报错?查一下")).toBe("coding"); // debug 优先于问句
    expect(classifyTaskClass("修一下这个 bug,顺便把结果整理成表格")).toBe("coding"); // 写代码信号压过办公信号
    expect(classifyTaskClass("fix the login bug")).toBe("coding");
  });

  it("办公/产出信号 → office(2026-10-24 补词:整理一份/速查/清单)", () => {
    expect(classifyTaskClass("做一份 PPT 介绍这个项目")).toBe("office");
    expect(classifyTaskClass("在 eval-scratch/ 新建 notes.md,整理一份常用命令速查,写完自查格式")).toBe("office");
    expect(classifyTaskClass("把这份数据整理成 Excel 表格")).toBe("office");
    expect(classifyTaskClass("翻译这份文档成英文")).toBe("office");
    expect(classifyTaskClass("帮我写一份周报")).toBe("office");
  });

  it("交付物锚(2026-11-04 观测实锚):「写一篇…文章」先于内容词——文章本体是交付物、代码只是题材", () => {
    // 观测原句形态:内容词「修复/排障/验证」齐全,但交付物是文章 → office(旧:误判 coding 交仪式税)
    expect(classifyTaskClass("调研 lampgenie-harness 的 journal 运行数据,写一篇《压缩死亡螺旋事故复盘》技术文章,讲清修复设计与排障过程")).toBe("office");
    expect(classifyTaskClass("写一篇调研报告")).toBe("office");
    expect(classifyTaskClass("修 bug 后写一篇复盘,把根因讲清楚")).toBe("office"); // 交付物是复盘文章
    // 负向:「一篇」不是写作动词锚时不得误吞编码/问答任务
    expect(classifyTaskClass("分析一篇论文并实现其算法")).toBe("coding"); // 无(写|出|整理|润色|排版)一篇,「一篇论文」非交付锚
    expect(classifyTaskClass("做个小功能")).toBe("coding"); // 既有陷阱句保持(泛动词永不进词表)
  });

  it("问答/调研信号 → qa(含英文问句词;2026-10-24 补词:哪个/哪几/多少/?任意位置);无信号缺省 coding(保守)", () => {
    expect(classifyTaskClass("这个项目是干什么的")).toBe("qa");
    expect(classifyTaskClass("7700 网关的入口文件是哪个?经过哪几步?简要回答,不改代码。")).toBe("qa"); // 「。」结尾问句
    expect(classifyTaskClass("这个模块跑了多少 token?")).toBe("qa");
    expect(classifyTaskClass("看看 modules 目录的结构")).toBe("qa");
    expect(classifyTaskClass("两种方案有什么区别?")).toBe("qa");
    expect(classifyTaskClass("查一下配置文件路径在哪")).toBe("qa");
    expect(classifyTaskClass("what does this repo do")).toBe("qa");
    expect(classifyTaskClass("explain the login flow")).toBe("qa");
    expect(classifyTaskClass("how to fix the parser bug")).toBe("coding"); // fix/debug 信号压过问句
    expect(classifyTaskClass("随便干点什么")).toBe("coding"); // 缺省
  });
});

describe("systemForTaskClass(系统纪律段按类)", () => {
  it("coding=全文(与 SYSTEM 恒等)", () => {
    expect(systemForTaskClass("coding")).toBe(SYSTEM);
  });
  it("qa:免五阶段/plan-gate/验收四步,保留派发+code_sense 用法+更正路径", () => {
    const s = systemForTaskClass("qa");
    expect(s).toContain("任务类别(qa 问答/调研)");
    expect(s).not.toContain("五硬阶段流程");
    expect(s).not.toContain("规划委托纪律");
    expect(s).not.toContain("完工验收四步");
    expect(s).not.toContain("影响面纪律");
    expect(s).toContain("code_sense 用法"); // 调研查代码高频
    expect(s).toContain('task_phase(taskClass="coding")');
  });
  it("office:只留通用段(无 code_sense 用法),带产出要求+技能指路+自查+更正路径", () => {
    const s = systemForTaskClass("office");
    expect(s).toContain("任务类别(office 办公/产出)");
    expect(s).not.toContain("五硬阶段流程");
    expect(s).not.toContain("code_sense 用法");
    expect(s).toContain("交付前自查");
    expect(s).toContain('task_phase(taskClass="coding")');
 // 办公方法论下沉为技能族,系统段必须点名指路(否则模型不知道有这套规则)
    for (const name of ["office-writing", "office-pptx", "office-docx", "office-xlsx", "office-report"]) {
      expect(s).toContain(`builtin/${name}`);
    }
    expect(s).toContain("mermaid");
 // 系统段要带「开工四问 + 论点四段」
    expect(s).toContain("开工四问");
    expect(s).toContain("面向谁报告");
    expect(s).toContain("论据");
  });
});

describe("更正闭环(e2e):理解阶段定类,agent 可更正,plan-gate 随类切换", () => {
  it("qa 初判 → task_phase(taskClass=coding) 更正 → 无板写文件重新被 plan-gate 拦", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "write_file", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
    const seen: string[] = [];
    const sid = "taskclass-fix-1";
    const app = createGatewayApp({
      port: 0,
      llm: { async chat(_m: unknown) {
        const m = JSON.stringify(_m);
        if (m.includes("独立上下文")) return { content: "子代理完成" };
        seen.push(m);
        const step = seen.length - 1;
        // 第一步:理解阶段发现要改代码 → 更正任务类别
        if (step === 0) return { content: "", toolCalls: [{ id: "p1", name: "task_phase", arguments: JSON.stringify({ phase: "understand", taskClass: "coding" }) }] };
        // 第二步:无板直写——更正回 coding 后应被 plan-gate 硬拦;第三步收尾(假 LLM 不空转)
        if (step === 1) return { content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "out/fix.txt", content: "x" }) }] };
        return { content: "写文件被 plan-gate 拦截,按指路先落板。" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "这个项目从哪里启动?");
    for (let k = 0; k < 160; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // 初判=qa(系统提示免五阶段),但更正后写文件被拦——类别切换即刻生效
    expect(seen[0] ?? "").toContain("任务类别(qa 问答/调研)");
    // 更正回执补发编码纪律(P1-1:规则与执法同时到场——五阶段/验收四步随 task_phase 结果送达)
    expect(seen[1] ?? "").toContain("编码纪律即刻生效");
    expect(seen[1] ?? "").toContain("完工验收四步");
    expect(seen[2] ?? "").toContain("plan-gate");
  }, 45_000);
});

describe("plan-gate 按类放行(e2e)", () => {
 // 白板适用面:office 从「软免板」改硬闸——无板直写现在被拦,出路=board_upsert
  // boardType="composition"(作业思路板)或 exemptReason 留痕。kickoff 纪律卡口径同步改为「免五阶段 +
  // 先落作业思路板」,仍不含「plan-gate 硬闸」「五阶段流程」字样。
  it("office 指令:无板直写被 plan-gate 拦并指路作业思路板;kickoff 纪律卡为办公版(无 plan-gate 硬闸字样)", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "write_file", pattern: "*", action: "allow" }]);
    const seen: string[] = [];
    const sid = "taskclass-office-1";
    const app = createGatewayApp({
      port: 0,
      llm: { async chat(_m: unknown) {
        const m = JSON.stringify(_m);
        if (m.includes("独立上下文")) return { content: "子代理完成" };
        seen.push(m);
        const step = seen.length - 1;
        if (step > 0) return { content: "PPT 大纲已写入,交付。" };
        return { content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "out/deck-note.txt", content: "ppt 大纲" }) }] };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "做一份 PPT 介绍这个项目");
    for (let k = 0; k < 160; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // kickoff 卡为办公版:有产出要求/自查,无 plan-gate/五阶段字样
    const first = seen[0] ?? "";
    expect(first).toContain("办公/产出类任务");
    expect(first).not.toContain("plan-gate 硬闸");
    expect(first).not.toContain("五阶段流程");
 // 硬闸口径:动笔前先落作业思路板(composition);确无表达结构才用 exemptReason 豁免
    expect(first).toContain("作业思路板");
    expect(first).toContain("composition");
    expect(first).toContain("exemptReason");
    // 无板直写被拦:回执指路作业思路板(exemptReason 出口同给)
    expect(seen[1] ?? "").toContain("作业思路板");
    expect(seen[1] ?? "").toContain("exemptReason");
 // 审计锚:task.context 落账,类别/卡片版/系统提示段标志确定性可查
    const ctx = app.journal.readAll().find((e) => e.kind === "task.context");
    expect(ctx).toBeTruthy();
    const cp = ctx?.payload as { taskClass?: string; card?: string; flags?: Record<string, boolean> };
    expect(cp.taskClass).toBe("office");
    expect(cp.card).toBe("office 版");
    expect(cp.flags?.fivePhase).toBe(false);
    expect(typeof cp.systemSha).toBe("string");
  }, 45_000);

  it("qa 指令:系统提示免五阶段;每10步锚为 qa 版(不含阶段锚)", async () => {
    const seenSys: string[] = [];
    const sid = "taskclass-qa-1";
    const app = createGatewayApp({
      port: 0,
      llm: { async chat(_m: unknown) {
        const m = JSON.stringify(_m);
        if (m.includes("独立上下文")) return { content: "qa 子代理完成" };
        seenSys.push(m);
        return { content: "结论:这是一个五段式测试任务,无需阶段仪式。" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "这个项目的入口在哪里?");
    for (let k = 0; k < 120; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const first = seenSys[0] ?? "";
    expect(first).toContain("任务类别(qa 问答/调研)");
    expect(first).not.toContain("五硬阶段流程");
    // kickoff 卡为问答版
    expect(first).toContain("问答/调研类任务");
 // coding 版纪律卡带降级提示:误判可由 agent 自纠向下
    expect(String(systemForTaskClass("coding"))).toContain("五硬阶段流程"); // coding 全文不受影响
  }, 45_000);
});

describe("直达实施路由(e2e,2026-10-24 理解阶段路由判定)", () => {
  it("明确小改:understand→implement(route=direct)→无板直写不拦;回执带理解自查/直达纪律", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "write_file", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
    const seen: string[] = [];
    const sid = "taskroute-direct-1";
    const app = createGatewayApp({
      port: 0,
      llm: { async chat(_m: unknown) {
        const m = JSON.stringify(_m);
        if (m.includes("独立上下文")) return { content: "子代理完成" };
        seen.push(m);
        const step = seen.length - 1;
        if (step === 0) return { content: "", toolCalls: [{ id: "p1", name: "task_phase", arguments: JSON.stringify({ phase: "understand" }) }] };
        if (step === 1) return { content: "", toolCalls: [{ id: "p2", name: "task_phase", arguments: JSON.stringify({ phase: "implement", route: "direct" }) }] };
        if (step === 2) return { content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "eval-scratch/direct.txt", content: "x" }) }] };
        return { content: "小改完成。" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "把 config.ts 里的超时改成 30 秒,明确小改");
    for (let k = 0; k < 200; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // understand 回执带理解自查(三问+类别+路由判定)
    expect(seen[1] ?? "").toContain("理解阶段自查");
    expect(seen[1] ?? "").toContain("直达实施"); // 路由判定指引在理解回执里
    // implement 回执带直达纪律
    expect(seen[2] ?? "").toContain("直达实施纪律");
    // 无板直写不被拦(非 rejected 回执),并落 task.route + direct-route 留痕
    expect(seen[3] ?? "").not.toContain("\"status\":\"rejected\""); // 无拒绝回执=直写放行(SYSTEM 本含 plan-gate 字样,不能拿它当判据)
    const evs = app.journal.readAll();
    expect(evs.some((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "task.route")).toBe(true);
    expect(evs.some((e) => e.kind === "custom" && (e.payload as { type?: string; effect?: string }).type === "plan.gate" && (e.payload as { effect?: string }).effect === "direct-route")).toBe(true);
  }, 45_000);
});

describe("板规范固化(2026-10-25 变更契约图)", () => {
  it("board_upsert 描述含控制流程图/与仓库的关系/硬规则/四类 accept;SYSTEM 任务书四要素", () => {
    const aw = readFileSync(resolve(__dirname, "../src/agent-wiring.ts"), "utf8");
    const docs = readFileSync(resolve(__dirname, "../src/tool-full-docs.ts"), "utf8");
 // 工具面瘦身:board_upsert 的完整画法搬到 tool-full-docs.ts(BOARD_UPSERT_FULL_DOC),
    // agent-wiring 只留 wire description。断言按各自真实去处校验,别让「文本搬家」被当成口径丢失。
    for (const m of ["现状控制流程图", "改动徽标", "与仓库的关系", "禁止臆造", "accept 四类", "over+body"]) {
      expect(docs, `tool-full-docs:${m}`).toContain(m);
    }
    for (const m of ["契约自检", "targets/symbolRef", "任务书四要素"]) {
      expect(aw, `agent-wiring:${m}`).toContain(m);
    }
  });

  it("audit 幻影引用核对 e2e:板挂不存在符号的 symbolRef → audit 回执点名断链", async () => {
    process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "board_upsert", pattern: "*", action: "allow" }]);
    const seen: string[] = [];
    const sid = "boardaudit-1";
    const app = createGatewayApp({
      port: 0,
      llm: { async chat(_m: unknown) {
        const m = JSON.stringify(_m);
        if (m.includes("独立上下文")) return { content: "子代理完成" };
        seen.push(m);
        const step = seen.length - 1;
        if (step === 0) return { content: "", toolCalls: [{ id: "b1", name: "board_upsert", arguments: JSON.stringify({ title: "契约图测试", nodes: [
          { id: "n1", label: "幻影模块", summary: "测断链", change: "modify", before: "旧", phase: "P0", symbolRef: { name: "zzPhantomSymbolXyz", file: "apps/gateway/src/main.ts" }, accept: [{ cmd: "echo ok", expect: "ok" }] },
        ] }) }] };
        if (step === 1) return { content: "", toolCalls: [{ id: "a1", name: "board_upsert", arguments: JSON.stringify({ action: "audit" }) }] };
        return { content: "板审计完成。" };
      } } as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    apps.push(app);
    app.taskManager.submit("user", sid, "修改 main.ts 的启动逻辑,先落变更契约图");
    for (let k = 0; k < 200; k++) {
      const t = app.taskManager.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // audit 回执(第三请求)点名断链
    expect(seen[2] ?? "").toContain("symbolRef 核对");
    expect(seen[2] ?? "").toContain("断链=幻影引用");
    expect(seen[2] ?? "").toContain("zzPhantomSymbolXyz");
  }, 45_000);
});
