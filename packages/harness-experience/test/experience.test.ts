import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "../src/store";
import { distillFromTask, isProbeTask, isInfraFailure, SKILL_REVIEW_PROMPT } from "../src/distill";
import { recallExperiences, renderRecallBlock, runCurator } from "../src/recall";

function store(): { s: ExperienceStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-exp-"));
  return { s: new ExperienceStore(dir), dir };
}

describe("D1 store", () => {
  it("CRUD+frontmatter 校验(description>60 拒)+version 递增", async () => {
    const { s, dir } = store();
    const fm = await s.write({ category: "coding", name: "ts-esm-paths", description: "TS ESM 相对 import 需带扩展名或配 exports", created_by: "agent" }, "正文");
    expect(fm.version).toBe(1);
    const fm2 = await s.write({ category: "coding", name: "ts-esm-paths", description: "TS ESM 相对 import 需带扩展名或配 exports", created_by: "agent" }, "正文v2");
    expect(fm2.version).toBe(2);
    await expect(s.write({ category: "c", name: "x", description: "d".repeat(61), created_by: "agent" }, "b")).rejects.toThrow(/60/);
    // ledger 追加
    expect(s.ledger().filter((e) => e.action === "write")).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("remove:删目录级联+ledger 记 delete;不存在 false", async () => {
    const { s, dir } = store();
    await s.write({ category: "coding", name: "a", description: "甲", created_by: "agent" }, "正文a");
    await s.write({ category: "coding", name: "b", description: "乙", created_by: "agent" }, "正文b");
    expect(s.remove("coding", "a")).toBe(true);
    expect(s.read("coding", "a")).toBeNull();
    expect(s.index().map((e) => e.name)).toEqual(["b"]);
    // 目录级联删(SKILL.md+.usage.json 整目录);同类目另一条不受影响
    expect(existsSync(join(dir, "coding", "a"))).toBe(false);
    expect(existsSync(join(dir, "coding", "b", "SKILL.md"))).toBe(true);
    // ledger 审计
    const del = s.ledger().filter((e) => e.action === "delete");
    expect(del).toHaveLength(1);
    expect(del[0]!.category).toBe("coding");
    expect(del[0]!.name).toBe("a");
    // 不存在/重复删:false 不抛
    expect(s.remove("coding", "a")).toBe(false);
    expect(s.remove("nope", "nope")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("remove:多根(用户根条目)与 frontmatter name≠dirName 兜底路径", async () => {
    const proj = mkdtempSync(join(tmpdir(), "gh-exp-p-"));
    const user = mkdtempSync(join(tmpdir(), "gh-exp-u-"));
    const s = ExperienceStore.fromRoots([
      { dir: proj, scope: "project" as const, priority: 10 },
      { dir: user, scope: "user" as const, priority: 1 },
    ]);
    await s.write({ category: "coding", name: "proj-skill", description: "项目根", created_by: "agent" }, "p");
    // 用户根手写技能:目录名与 frontmatter name 不同(走线性兜底解析)
    mkdirSync(join(user, "coding", "odd-dir-name"), { recursive: true });
    writeFileSync(join(user, "coding", "odd-dir-name", "SKILL.md"),
      "---\nname: real-name\ndescription: 用户手写\n---\n\n正文", "utf-8");
    expect(s.read("coding", "real-name")?.name).toBe("real-name");
    // 写根条目可删
    expect(s.remove("coding", "proj-skill")).toBe(true);
    expect(s.read("coding", "proj-skill")).toBeNull();
    // 用户根条目(经 name 兜底解析到)可删:目录整个消失
    expect(s.remove("coding", "real-name")).toBe(true);
    expect(existsSync(join(user, "coding", "odd-dir-name"))).toBe(false);
    expect(s.index()).toEqual([]);
    rmSync(proj, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
  });
});

describe("D2 distill(LLM)", () => {
  it("fold-in 更新既有条目;负面清单话术在 prompt", async () => {
    const { s, dir } = store();
    await s.write({ category: "ops", name: "port-conflict", description: "端口占用先查残留进程", created_by: "agent" }, "旧正文");
    let capturedPrompt = "";
    let call = 0;
    const llm = {
      async chat(prompt: string) {
        capturedPrompt = prompt;
        call++;
        if (call === 1) {
          return { content: JSON.stringify({ ops: [{ op: "write", category: "ops", name: "port-conflict", description: "端口占用先查残留进程再 fuser -k", body: "新正文" }] }) };
        }
        return { content: '{"ops":[{"op":"skip","reason":"一次性任务"}]}' };
      },
    };
    const j = new MemoryJournal();
    const r = await distillFromTask(s, j, { id: "t1", sessionId: "s", instruction: "重启服务", state: "done" }, llm);
    expect(capturedPrompt).toContain("fold-in"); // prompt 纪律注入(prompt 检查移出 mock)
    expect(r.distilled).toBe(1);
    expect(s.read("ops", "port-conflict")!.version).toBe(2);
    expect(SKILL_REVIEW_PROMPT).toContain("未验证成功的尝试");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("D3 distill 确定性兜底", () => {
  it("failed 任务含错误文本→candidate 条目;done 无 LLM 不沉淀", async () => {
    const { s, dir } = store();
    const j = new MemoryJournal();
    j.append({ kind: "message.system", sessionId: "s", payload: { text: "Error: ENOENT config" } });
    const rf = await distillFromTask(s, j, { id: "abcd1234", sessionId: "s", instruction: "部署服务", state: "failed" });
    expect(rf.distilled).toBe(1);
    const fm = s.read("incidents", "task-abcd1234");
    expect(fm!.status).toBe("candidate");
    const rd = await distillFromTask(s, j, { id: "t2", sessionId: "s", instruction: "部署", state: "done" });
    expect(rd.distilled).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("skill 索引过滤 candidate(2026-10-29 token 轮 P3)", () => {
  // 实测病灶:incidents/task-* 9 条全是 distill.ts 确定性兜底的 candidate 条目,
  // description = `失败任务候选经验:${instruction.slice(0,50)}`——被截断的用户原话,
  // 出现过「做个小功能」「不对不对，反而更加矛盾了」这种零信息描述;
  // 正文是 journal 原文转储。它们占索引行额度却无法据以选择技能。
  it("candidate 不进 index();active 进;archived/disabled 也不进", async () => {
    const { s, dir } = store();
    await s.write({ category: "incidents", name: "c1", description: "失败任务候选经验:做个小功能", created_by: "agent", status: "candidate" }, "正文");
    await s.write({ category: "coding", name: "a1", description: "真知识:ESM 相对 import 要带扩展名", created_by: "agent", status: "active" }, "正文");
    const names = s.index().map((e) => `${e.category}/${e.name}`);
    expect(names).toContain("coding/a1");
    expect(names).not.toContain("incidents/c1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("回退开关 GENIE_SKILL_INDEX_CANDIDATE=on 让 candidate 重新进索引(排查用)", async () => {
    const { s, dir } = store();
    await s.write({ category: "incidents", name: "c2", description: "失败任务候选经验:捣鼓一下", created_by: "agent", status: "candidate" }, "正文");
    const prev = process.env.GENIE_SKILL_INDEX_CANDIDATE;
    process.env.GENIE_SKILL_INDEX_CANDIDATE = "on";
    try {
      expect(s.index().map((e) => e.name)).toContain("c2");
    } finally {
      if (prev === undefined) delete process.env.GENIE_SKILL_INDEX_CANDIDATE;
      else process.env.GENIE_SKILL_INDEX_CANDIDATE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("negative 过滤不影响 status 缺省(缺省=active)的既有条目", async () => {
    const { s, dir } = store();
    // write 不传 status → 缺省 active(store.ts:193),必须照常进索引
    await s.write({ category: "coding", name: "d1", description: "缺省 status 的常规经验", created_by: "agent" }, "正文");
    expect(s.index().map((e) => e.name)).toContain("d1");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("D4 recall", () => {
  it("关键词命中计分注入;无关 query 零注入;bump 计数", async () => {
    const { s, dir } = store();
    await s.write({ category: "coding", name: "pnpm-workspace-exports", description: "pnpm workspace exports 映射必须带 .ts 扩展名", created_by: "agent" }, "TS bundler 解析不自动补扩展名……");
    await s.write({ category: "ops", name: "log-buffering", description: "nohup 日志被 stdout 缓冲吞掉", created_by: "agent" }, "PYTHONUNBUFFERED=1……");
    const hit = recallExperiences(s, "pnpm workspace 的 exports 配置问题");
    expect(hit.length).toBeGreaterThan(0);
    expect(hit[0]!.name).toBe("pnpm-workspace-exports");
    const miss = recallExperiences(s, "完全无关的查询词组");
    expect(miss).toHaveLength(0);
    const block = renderRecallBlock(hit);
    expect(block).toContain("## 过往经验提示");
    expect(block).toContain("pnpm-workspace-exports");
    expect(s.usage("coding", "pnpm-workspace-exports").use_count).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("D5/D6 遥测+curator", () => {
  it("reuse_after_patch(patch 后再用计入);生命周期三态;archive 不删除", async () => {
    const { s, dir } = store();
    await s.write({ category: "c", name: "n1", description: "测试经验条目", created_by: "agent" }, "v1");
    await s.write({ category: "c", name: "n1", description: "测试经验条目", created_by: "agent" }, "v2"); // patch
    recallExperiences(s, "测试 经验"); // patch 后使用
    const u = s.usage("c", "n1");
    expect(u.patch_count).toBe(2);
    expect(u.reuse_after_patch).toBe(1);
    // 造旧:created_at 与 usage 时间线都回拨 16 天(recall 刚刷新过 last_used)
    const fm = s.read("c", "n1")!;
    const old = new Date(Date.now() - 16 * 864e5).toISOString();
    const body = readFileSync(join(dir, "c", "n1", "SKILL.md"), "utf-8").replace(fm.created_at, old);
    require("node:fs").writeFileSync(join(dir, "c", "n1", "SKILL.md"), body);
    const u0 = s.usage("c", "n1");
    require("node:fs").writeFileSync(join(dir, "c", "n1", ".usage.json"), JSON.stringify({ ...u0, last_used_at: old, last_patched_at: old }));
    const r1 = runCurator(s);
    expect(r1.staled).toContain("c/n1");
    // 再旧到 31 天 → archived(目录移 .archive,原位消失但文件在)
    const old2 = new Date(Date.now() - 32 * 864e5).toISOString();
    const fmNow = s.read("c", "n1")!;
    const body2 = readFileSync(join(dir, "c", "n1", "SKILL.md"), "utf-8").replace(fmNow.created_at, old2);
    require("node:fs").writeFileSync(join(dir, "c", "n1", "SKILL.md"), body2);
    const u1 = s.usage("c", "n1");
    require("node:fs").writeFileSync(join(dir, "c", "n1", ".usage.json"), JSON.stringify({ ...u1, last_used_at: old2, last_patched_at: old2 }));
    const r2 = runCurator(s);
    expect(r2.archived).toContain("c/n1");
    expect(existsSync(join(dir, ".archive", "c", "n1", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "c", "n1"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("designs/23 项目维度沉淀", () => {
  it("write 带 project → frontmatter 落盘且可读回;不带则字段缺席", async () => {
    const { s, dir } = store();
    await s.write({ category: "coding", name: "proj-bound", description: "带项目归属的经验", created_by: "agent", project: "lampgenie-harness" }, "正文");
    const fm = s.read("coding", "proj-bound")!;
    expect(fm.project).toBe("lampgenie-harness");
    const raw = readFileSync(join(dir, "coding", "proj-bound", "SKILL.md"), "utf-8");
    expect(raw).toContain("project: lampgenie-harness");
    await s.write({ category: "coding", name: "no-proj", description: "不带项目", created_by: "agent" }, "正文");
    expect(s.read("coding", "no-proj")!.project).toBeUndefined();
    const raw2 = readFileSync(join(dir, "coding", "no-proj", "SKILL.md"), "utf-8");
    expect(raw2).not.toContain("project:");
    rmSync(dir, { recursive: true, force: true });
  });

  it("distillFromTask 带 opts.project → 兜底条目带项目归属", async () => {
    const { s, dir } = store();
    const j = new MemoryJournal();
    j.append({ kind: "task.enqueue", sessionId: "s1", payload: { instruction: "跑测试" } });
    j.append({ kind: "task.fail", sessionId: "s1", payload: { instruction: "跑测试", result: "Error: ENOENT no file" } });
    const r = await distillFromTask(s, j, { id: "abcd1234-xyz", sessionId: "s1", instruction: "跑测试", state: "failed" }, undefined, { project: "lampgenie-harness" });
    expect(r.distilled).toBe(1);
    expect(s.read("incidents", "task-abcd1234")!.project).toBe("lampgenie-harness");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("探针任务不沉淀(2026-10-19 经验索引污染治理)", () => {
  const probes = [
    "你好",
    "派子代理",
    "回答 1+1",
    "只回复:好。",
    "用 browser 工具打开 https://example.com 看看",
    "用 run_workflow 工具执行以下 workflow 脚本(script 参数原样传入,不要改写):\n// workflow 板「A1 三节点流」",
    "图里是什么",
  ];
  for (const p of probes) {
    it("探针命中:" + JSON.stringify(p.slice(0, 20)), () => {
      expect(isProbeTask(p)).toBe(true);
    });
  }
  it("真实任务不误伤(长指令/真需求)", () => {
    expect(isProbeTask("修复权限下拉选中态与真实值不一致的问题:点开菜单后应显示当前权限档")).toBe(false);
    expect(isProbeTask("给 lampgenie-harness 增加 AGENTS.md 压缩机制,超过 4000 字符时压缩")).toBe(false);
    expect(isProbeTask("优化白板布局:入口在左、出口在右、主线高亮")).toBe(false);
  });
  it("failed 探针任务不落 incidents 经验(确定性兜底同门槛)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-probe-"));
    const store = new ExperienceStore(dir);
    const j = new MemoryJournal();
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "Error: boom" } });
    const r = await distillFromTask(store, j, { id: "t1", sessionId: "s1", instruction: "回答 1+1", state: "failed", result: "Error" });
    expect(r.distilled).toBe(0);
    expect(r.skipped.join()).toContain("探针");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("基础设施故障不沉淀(2026-10-19)", () => {
  it("LLM 400 配对错误/流超时/网关重启 → 不生成 incidents 经验", async () => {
    const samples = [
      'Error: LLM 400: {"error":{"code":"invalid_parameter_error","message":"An assistant message with \'tool_calls\' must be followed by tool messages responding to each \'tool_call_id\'."}}',
      "Error: MODEL_STREAM_IDLE_TIMEOUT",
      "网关重启中断(可重发)",
    ];
    for (const s of samples) expect(isInfraFailure(s)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "exp-infra-"));
    const store = new ExperienceStore(dir);
    const j = new MemoryJournal();
    j.append({ kind: "message.agent", sessionId: "s9", payload: { text: "Error: LLM 400" } });
    const r = await distillFromTask(store, j, { id: "t9", sessionId: "s9", instruction: "规划一下给本项目封装一个 desktop 应用 exe", state: "failed", result: samples[0] });
    expect(r.distilled).toBe(0);
    expect(r.skipped.join()).toContain("基础设施故障");
    rmSync(dir, { recursive: true, force: true });
  });
  it("真实任务教训仍可沉淀(非基础设施失败)", () => {
    expect(isInfraFailure("TypeError: x is undefined at foo.ts:12")).toBe(false);
  });
});
