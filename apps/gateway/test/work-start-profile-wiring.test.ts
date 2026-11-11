/**
 * 开工画像接线契约(读源码断言 + 纯函数行为):
 * - agent-wiring.ts 引入 work-start-profile 三件(probe/render/verify)与 sop-tips 的包装器;
 * - 先查 journal custom{type:"work.start.profile"} 去重(同一会话只注入一次);
 * - 仅 coding 类探测(taskClassState.value === "coding"),非 coding 零行为变化;
 * - 探测异常整段跳过并落 errors 审计(fail-soft,不阻塞任务);
 * - brief 追加进 composeSystemPrompt 的 base(稳定前缀),不是每条消息的 tip;
 * - 既有 SOP 卡与触发逻辑零改动(只有新增导出)。
 * 为什么用源码接线断言:本注入发生在 runWithAgent 内部(需真 provider/loop 才能跑到),
 * 单测无法低成本驱动全链路;接线面用逐条字面锚定,行为面由 work-start-profile.test.ts 覆盖。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { START_BRIEF_STOP_RULES, SOP_TIPS, renderStartProfileTip, sopTipText } from "../src/agent-wiring-sop-tips.js";

const src = readFileSync(join(process.cwd(), "src", "agent-wiring.ts"), "utf8");

describe("agent-wiring 接线:import 与探测入口", () => {
  it("引入 probeWorkStart/renderWorkStartBrief/verifyCommandsFor(work-start-profile.ts)", () => {
    expect(src).toMatch(/from "\.\/work-start-profile\.js"/);
    for (const sym of ["probeWorkStart", "renderWorkStartBrief", "verifyCommandsFor"]) {
      expect(src, sym).toContain(sym);
    }
  });

  it("引入 renderStartProfileTip(包装器在 sop-tips 模块,不自造第二套)", () => {
    expect(src).toMatch(/import \{[^}]*renderStartProfileTip[^}]*\} from "\.\/agent-wiring-sop-tips\.js"/);
  });

  it("探测 root 用项目 workdir(taskRoot),模型名按主 llm 读数", () => {
    expect(src).toContain("root: taskRoot,");
    expect(src).toContain("modelFamily: subagentModelNameOf(llm)");
  });
});

describe("agent-wiring 接线:一次注入与 coding 守卫", () => {
  it("journal 去重:扫 custom{type:work.start.profile, sessionId}", () => {
    expect(src).toMatch(/e\.kind === "custom" && e\.sessionId === task\.sessionId/);
    expect(src).toMatch(/\(e\.payload as \{ type\?: string \} \| undefined\)\?\.type === "work\.start\.profile"/);
    expect(src).toContain("alreadyProfiled");
  });

  it("仅 coding 类探测;非 coding 不探测不注入", () => {
    expect(src).toContain('taskClassState.value === "coding" && !alreadyProfiled');
  });

  it("审计留痕:落 custom work.start.profile(branch/dirty/commits/manifests/verifyCommands/errors)", () => {
    expect(src).toContain('type: "work.start.profile"');
    for (const field of ["branch:", "dirty: profile.dirtyFiles", "commits: profile.commits", "manifests: profile.manifests", "verifyCommands: verifyCommandsFor(profile)", "errors: profile.errors"]) {
      expect(src, field).toContain(field);
    }
 // 不含文件内容:payload 只放探测结论,不落 stdout 原文
    expect(src).not.toMatch(/payload:\s*\{[^}]*stdout/);
  });

  it("fail-soft:整体异常 catch 后只落 skipped 审计,不 throw 出开工", () => {
    expect(src).toContain("skipped: true");
    expect(src).toContain('probe: "work-start"');
    expect(src).toContain("let workStartBrief = \"\";");
  });
});

describe("agent-wiring 接线:brief 进稳定前缀", () => {
  it("brief 由 renderStartProfileTip(renderWorkStartBrief(...)) 合成", () => {
    expect(src).toContain("workStartBrief = renderStartProfileTip(renderWorkStartBrief(profile, { modelFamily: subagentModelNameOf(llm) }));");
  });

  it("追加到 composeSystemPrompt 的 base(system 稳定前缀),不是 loop tips", () => {
    expect(src).toMatch(/\+ projectMainline\s*\n?\s*(\/\/ [^\n]*\n\s*)?\+ workStartBrief,/);
 // 没有把 brief 塞进 buildLoopTips 的路径
    expect(src).not.toMatch(/startProfile/);
  });
});

describe("sop-tips 只新增导出:既有卡与触发零改动", () => {
  it("SOP_TIPS 键集合不变(无新增/删除阶段卡)", () => {
    expect(Object.keys(SOP_TIPS).sort()).toEqual(["close", "debug", "implement", "plan", "understand"]);
  });

  it("sopTipText 行为不变(未知 phase 空串;understand 卡首行不变)", () => {
    expect(sopTipText("verify")).toBe("");
    expect(sopTipText("understand").split("\n")[0]).toBe("SOP·理解(进入任务的第一件事)");
  });

  it("renderStartProfileTip:空正文空串,非空包成稳定前缀段落(不引入变化字符)", () => {
    expect(renderStartProfileTip("")).toBe("");
    const block = renderStartProfileTip(START_BRIEF_STOP_RULES.join("\n"));
    expect(block).toContain("## 开工画像(稳定前缀");
    expect(block).toContain(START_BRIEF_STOP_RULES[0]!);
    expect(renderStartProfileTip(START_BRIEF_STOP_RULES.join("\n"))).toBe(block);
  });
});
