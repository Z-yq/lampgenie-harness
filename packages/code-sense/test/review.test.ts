import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReviewTarget, deterministicFindings, codeReview, changedSymbols, deriveImpact, type ReviewLlm, type ReviewTarget, type Finding } from "../src/review/index";
import { REVIEW_PROMPT } from "../src/review/prompt";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-rev-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
  g("init -q"); g('config user.email t@t'); g('config user.name t');
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  g("add ."); g('commit -qm "init"');
  return dir;
}

describe("D1 diff 收集三形态", () => {
  it("uncommitted/commit/branch", async () => {
    const dir = gitRepo();
    // uncommitted
    appendFileSync(join(dir, "a.ts"), "export const b = 2;\n");
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    execSync("git add a.ts new.ts", { cwd: dir }); // staged
    const t1 = await collectReviewTarget(dir);
    expect(t1.kind).toBe("uncommitted");
    expect(t1.files.map((f) => f.path)).toContain("a.ts");
    // commit
    execSync('git commit -qm "c2"', { cwd: dir });
    const hash = execSync("git rev-parse --short HEAD", { cwd: dir }).toString().trim();
    const t2 = await collectReviewTarget(dir, hash);
    expect(t2.kind).toBe("commit");
    expect(t2.files.length).toBeGreaterThan(0);
    // branch
    execSync("git checkout -q -b feature", { cwd: dir });
    appendFileSync(join(dir, "a.ts"), "export const c = 3;\n");
    execSync('git commit -aqm "c3"', { cwd: dir });
    const t3 = await collectReviewTarget(dir, "master");
    expect(t3.kind).toBe("branch");
    expect(t3.files[0]!.path).toBe("a.ts");
    rmSync(dir, { recursive: true, force: true });
  });

  it("未跟踪文件收集( §2.1):新生文件进审查,点文件/生成物目录跳过", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "fresh.ts"), "export const fresh = 1;\n");
    writeFileSync(join(dir, ".env"), "SECRET=abc\n");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "bundle.js"), "x");
    const t = await collectReviewTarget(dir);
    const paths = t.files.map((f) => f.path);
    expect(paths).toContain("fresh.ts");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("dist/bundle.js");
    rmSync(dir, { recursive: true, force: true });
  });
});

// fixG1:任务变更集基线(checkpoint sha)——review 只审本任务开工后的改动,不把共享工作区里
// 更早的在途改动(别的 agent 的)滚进来;sha 失效回退全仓未提交并如实标注。
describe("fixG1 checkpoint 基线(baseSha)", () => {
  /** 造「共享工作区双改动」现场:b.ts=开工前已在途(别人的),a.ts/c.ts=本任务开工后改的。 */
  function dualChangeRepo(): { dir: string; base: string } {
    const dir = mkdtempSync(join(tmpdir(), "gh-revbase-"));
    const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
    g("init -q"); g('config user.email t@t'); g('config user.name t');
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
    g("add ."); g('commit -qm "init"');
    // 别人的在途改动(开工前已存在、未提交)
    appendFileSync(join(dir, "b.ts"), "export const otherAgent = 1;\n");
    // 开工快照(git stash create,同 gateway checkpointCreate 形态:悬空 commit,不动工作区)
    const base = execSync("git stash create", { cwd: dir }).toString().trim();
    if (!base) throw new Error("stash create 未产出快照(前置改动缺失)");
    // 本任务的改动:改 tracked + 新增 untracked
    appendFileSync(join(dir, "a.ts"), "export const mine = 2;\n");
    writeFileSync(join(dir, "mine-new.ts"), "export const fresh = 1;\n");
    return { dir, base };
  }

  it("diff 正确性:基线在场→只含本任务文件(tracked+untracked),不含别人的在途改动", async () => {
    const { dir, base } = dualChangeRepo();
    const t = await collectReviewTarget(dir, undefined, base);
    expect(t.kind).toBe("uncommitted");
    expect(t.baseSha).toBe(base);
    expect(t.baseFallback).toBeUndefined();
    const paths = t.files.map((f) => f.path);
    expect(paths).toContain("a.ts"); // 本任务 tracked 改动
    expect(paths).toContain("mine-new.ts"); // 本任务新文件(untracked 照旧收集)
    expect(paths).not.toContain("b.ts"); // 别人的在途改动被基线挡在门外
    rmSync(dir, { recursive: true, force: true });
  });

  it("缺 sha→回退全仓未提交(两份改动都进,无基线标注)", async () => {
    const { dir } = dualChangeRepo();
    const t = await collectReviewTarget(dir);
    expect(t.baseSha).toBeUndefined();
    expect(t.baseFallback).toBeUndefined();
    const paths = t.files.map((f) => f.path);
    expect(paths).toContain("a.ts");
    expect(paths).toContain("b.ts"); // 全仓口径:别人的在途改动也在
    rmSync(dir, { recursive: true, force: true });
  });

  it("坏 sha→不抛,baseFallback 如实标注+回退全仓", async () => {
    const { dir } = dualChangeRepo();
    const t = await collectReviewTarget(dir, undefined, "deadbeefdeadbeef");
    expect(t.baseSha).toBeUndefined();
    expect(String(t.baseFallback)).toContain("回退全仓未提交");
    expect(t.files.map((f) => f.path)).toContain("b.ts");
    rmSync(dir, { recursive: true, force: true });
  });

  it("codeReview summary 标注基线口径(在场=本任务变更集;回退=如实说)", async () => {
    const { dir, base } = dualChangeRepo();
    const r1 = await codeReview(dir, { baseSha: base }); // 无 llm=确定性层 only
    expect(r1.summary).toContain("基线=任务 checkpoint");
    expect(r1.summary).toContain("本任务开工后的变更");
    const r2 = await codeReview(dir, { baseSha: "deadbeefdeadbeef" });
    expect(r2.summary).toContain("回退全仓未提交");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("D2 确定性检查", () => {
  it("凭证 blocker/dist blocker/调试残留 nit", () => {
    const det = deterministicFindings({
      kind: "uncommitted",
      files: [
        { path: "config.ts", status: "added", diffText: "+const key = \"sk-abcdefghijklmnopqrstuvwxyz123456\";" },
        { path: "dist/bundle.js", status: "modified", diffText: "+bundled" },
        { path: "x.ts", status: "modified", diffText: "+console.log('debug x')" },
        { path: "ok.ts", status: "modified", diffText: "+const fine = 1;" },
      ],
      totalLines: 10, truncated: false,
    });
    const titles = det.map((d) => d.title);
    expect(det.find((d) => d.title.includes("凭证"))!.severity).toBe("blocker");
    expect(det.find((d) => d.file === "dist/bundle.js")!.severity).toBe("blocker");
    expect(det.find((d) => d.title.includes("调试"))!.severity).toBe("nit");
    expect(det.find((d) => d.file === "ok.ts")).toBeUndefined();
  });
});

describe("D3 LLM 深审层(多轮编排+防幻觉+定位+回写 装配)", () => {
  const FINDING: Finding = {
    file: "a.ts", line: 1, severity: "warning", title: "未校验输入",
    detail: "b 直接使用", scenario: "当 X 时", anchorText: "export const b = 2;",
  };

  /** 深审 mock:纯函数按 prompt 内容分支(无状态,幂等二次运行行为一致)。 */
  function deepLlm(): ReviewLlm {
    return {
      async chat(p) {
        if (p.includes("事实核查员")) return { content: JSON.stringify({ analysis: "核查保留", remove_indices: [], keep_indices: [0] }) };
        if (p.includes("第 1 轮评审") && !p.includes("上一版输出无法解析")) return { content: "这不是 JSON" };
        if (p.includes("第 1 轮评审")) return { content: JSON.stringify({ findings: [FINDING] }) };
        return { content: '{"findings":[]}' }; // 后续轮/grace/重定位
      },
    };
  }

  it("总入口:坏 JSON 重试→confirmed→anchor 定位→防幻觉→行级回写,summary 含装配统计", async () => {
    const dir = gitRepo();
    appendFileSync(join(dir, "a.ts"), "export const b = 2;\n");
    const r = await codeReview(dir, { llm: deepLlm(), maxRounds: 3 });
    const llmF = r.findings.find((f) => f.title === "未校验输入");
    expect(llmF).toBeTruthy();
    expect(llmF!.scenario).toBe("当 X 时");
    // 定位引擎接线生效:anchorText 在 diff 中逐字命中 → anchor 档精确行号
    expect((llmF as Finding & { resolution?: string }).resolution).toBe("anchor");
    expect(llmF!.line).toBe(2);
    // 多轮编排:第 1 轮重试成功拿到 1 条;第 2 轮零新增 → 早停,grace 不跑
    expect(r.rounds?.length).toBe(2);
    expect(r.rounds![0]!.newFindings.length).toBe(1);
    expect(r.rounds![1]!.newFindings.length).toBe(0);
    expect(r.rounds![1]!.earlyStopped).toBe(true);
    expect(r.graceRoundRan).toBe(false);
    expect(r.summary).toContain("LLM 深审 2 轮");
    expect(r.summary).toContain("anchor 1");
    // 行级回写接线:店落盘 + 幂等(同发现二次审查零重发)
    expect(r.writeback).toBeTruthy();
    expect(r.writeback!.posted).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, ".genie", "review-comments.json"))).toBe(true);
    const r2 = await codeReview(dir, { llm: deepLlm(), maxRounds: 3 });
    expect(r2.writeback!.posted).toBe(0);
    expect(r2.writeback!.unchanged).toBeGreaterThanOrEqual(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("总入口:确定性+LLM 合并,无 LLM 显式声明", async () => {
    const dir = gitRepo();
    appendFileSync(join(dir, "a.ts"), "+console.log('dbg')\n");
    const r = await codeReview(dir); // 无 LLM
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.summary).toContain("未注入 LLM");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("D4 影响面联动", () => {
  it("impact 注入深审 prompt(断言 prompt 内容)", async () => {
    const dir = gitRepo();
    appendFileSync(join(dir, "a.ts"), "export const b = 2;\n");
    const prompts: string[] = [];
    const llm: ReviewLlm = { async chat(p) { prompts.push(p); return { content: '{"findings":[]}' }; } };
    await codeReview(dir, {
      llm, maxRounds: 1,
      impact: [{ symbol: "createGatewayApp", upstream: ["apps/gateway/src/main.ts:20"], downstream: ["apps/gateway/src/server.ts:28"] }],
    });
    expect(prompts.some((p) => p.includes("createGatewayApp"))).toBe(true);
    expect(prompts.some((p) => p.includes("apps/gateway/src/main.ts:20"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("changedSymbols 提取(去重/只认新增导出);deriveImpact 无索引=空数组", () => {
    const t = {
      kind: "uncommitted", totalLines: 4, truncated: false,
      files: [{
        path: "x.ts", status: "modified",
        diffText: "+export const foo = 1;\n+export const foo = 1;\n+export function bar() {}\n+const notExported = 2;\n-export const gone = 3;",
      }],
    } as ReviewTarget;
    expect(changedSymbols(t)).toEqual(["foo", "bar"]);
    expect(changedSymbols({ kind: "uncommitted", files: [], totalLines: 0, truncated: false })).toEqual([]);
    expect(deriveImpact("/nonexistent-root-xyz", t)).toEqual([]);
  });
});

describe("D6 prompt 契约(防漂移)", () => {
  it("关键纪律语句在", () => {
    expect(REVIEW_PROMPT).toContain("be certain");
    expect(REVIEW_PROMPT).toContain("只看 diff 不够");
    expect(REVIEW_PROMPT).toContain("不奉承");
    expect(REVIEW_PROMPT).toContain("scenario");
  });
});
