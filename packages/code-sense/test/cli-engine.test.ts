import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCli, runCliReview, parseCliOutput, toFindings, CliEngineUnavailable, CliEngineFailed } from "../src/review/cli-engine";
import { codeReview } from "../src/review/index";

// 真实协议 fixture(ocr v1.12.13 jsonOutput 信封,字段/形态照抄真二进制实跑产物)。
const ENVELOPE = JSON.stringify({
  status: "complete",
  llm: { provider: "genie-maas", model: "deepseek-v4.1-flash" },
  message: "Review complete: 3 finding(s).",
  summary: { files_reviewed: 2, comments: 3, total_tokens: 20585 },
  tool_calls: { total: 4, by_tool: {}, failure: 0, failure_by_tool: {}, failure_details: [] },
  comments: [
    { path: "calc.ts", content: "add 的实现是减法,语义与命名相反", existing_code: "  return a - b;", start_line: 2, end_line: 2, category: "bug", severity: "critical" },
    { path: "tmp_dbg.py", content: "os 导入未使用", existing_code: "import os", start_line: 1, end_line: 1, category: "maintainability", severity: "low" },
    { path: "x.ts", content: "白名单外 severity 如实降 warning;行号缺失钳 1", category: "style" },
  ],
}, null, 2);

function fakeCli(scriptBody: string): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gh-cli-"));
  const bin = join(dir, "fake-ocr.mjs");
  writeFileSync(bin, scriptBody);
  const launcher = join(dir, "fake-ocr"); // 无扩展名可执行(shebang→execFile 可直起)
  writeFileSync(launcher, `#!/usr/bin/env node\nimport "${bin.replace(/\\/g, "/")}";\n`);
  chmodSync(launcher, 0o755);
  return { bin: launcher, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-clirev-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
  g("init -q"); g("config user.email t@t"); g("config user.name t");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  g("add ."); g("commit -qm init");
  return dir;
}

describe("ocr CLI 子进程评审引擎(真实 jsonOutput 协议,v1.12.13 实跑实证)", () => {
  it("信封解析:comments 映射;severity critical→blocker/low→nit/白名单外→warning;existing_code→锚", () => {
    const finds = parseCliOutput(ENVELOPE);
    expect(finds).toHaveLength(3);
    expect(finds[0]).toMatchObject({ path: "calc.ts", line: 2, severity: "critical", rule: "bug", existingCode: "  return a - b;" });
    const fs2 = toFindings(finds);
    expect(fs2[0]).toMatchObject({ file: "calc.ts", line: 2, severity: "blocker", title: "bug", source: "cli" });
    expect(fs2[0]!.anchorText).toBe("  return a - b;"); // 无 diff 前缀不清洗
    expect(fs2[1]!.severity).toBe("nit");
    expect(fs2[2]!.severity).toBe("warning"); // severity 缺失 → 诚实降档
    expect(fs2[2]!.line).toBe(1); // 行号缺失 → 1
  });

  it("锚清洗:全部行带 diff + 前缀时剥掉,混排不剥", () => {
    const finds = parseCliOutput(JSON.stringify({ comments: [
      { path: "a.ts", content: "x", existing_code: "+const a = 1;\n+const b = 2;", start_line: 1, severity: "high" },
      { path: "b.ts", content: "y", existing_code: "+const a = 1;\n const b = 2;", start_line: 1, severity: "high" },
    ] }));
    const fs2 = toFindings(finds);
    expect(fs2[0]!.anchorText).toBe("const a = 1;\nconst b = 2;");
    expect(fs2[1]!.anchorText).toBe("+const a = 1;\n const b = 2;");
  });

  it("非 JSON stdout(进度噪声)与坏信封:零发现不冒充;无 comments 数组=零发现", () => {
    expect(parseCliOutput("progress 42%\nanother log line")).toEqual([]);
    expect(parseCliOutput('{"status":"complete","message":"no issues"}')).toEqual([]);
    expect(parseCliOutput('{"status":"error","comments":"not-array"}')).toEqual([]);
  });

  it("detect:在位 true,缺失 false;runCliReview 对缺失二进制 fail-visible", async () => {
    const { bin, cleanup } = fakeCli(`process.stdout.write(${JSON.stringify(ENVELOPE)});\n`);
    expect(detectCli(bin)).toBe(true);
    expect(detectCli("/nonexistent/ocr-xyz")).toBe(false);
    expect(detectCli("definitely-not-a-real-bin-xyz")).toBe(false);
    const finds = await runCliReview(bin, { kind: "uncommitted" }, { cwd: tmpdir() });
    expect(finds).toHaveLength(3);
    cleanup();
    await expect(runCliReview("/nonexistent/ocr-xyz", { kind: "uncommitted" })).rejects.toMatchObject({ name: "CliEngineUnavailable" });
    await expect(runCliReview("/nonexistent/ocr-xyz", { kind: "uncommitted" })).rejects.toBeInstanceOf(CliEngineUnavailable);
  });

  it("超时:慢 CLI 被 kill → CliEngineFailed(可见失败)", async () => {
    const { bin, cleanup } = fakeCli(`process.stdout.write('{"comments":[]}');\nsetTimeout(() => {}, 30_000);\n`);
    await expect(runCliReview(bin, { kind: "uncommitted" }, { timeoutMs: 300 })).rejects.toBeInstanceOf(CliEngineFailed);
    cleanup();
  });

  it("codeReview 接入:env opt-in 合并 source=cli;cli:false 显式关(env 在也不跑);不设 env 则不跑", async () => {
    const dir = gitRepo();
    const { bin, cleanup } = fakeCli(`process.stdout.write(${JSON.stringify(ENVELOPE)});\n`);
 // 引用孤儿检查:发现引用的文件必须真实存在(untracked 收集会进审查目标)——
    // 夹具世界自洽=CLI 回报的 calc.ts/tmp_dbg.py/x.ts 都落盘
    for (const [name, body] of [["calc.ts", "export function add(a: number, b: number): number {\n  return a - b;\n}\n"], ["tmp_dbg.py", "import os\n"], ["x.ts", "export const x = 1;\n"]] as const) {
      writeFileSync(join(dir, name), body);
    }
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    process.env.GENIE_REVIEW_CLI = bin;
    try {
      const r1 = await codeReview(dir);
      expect(r1.findings.some((f) => f.source === "cli" && f.file === "calc.ts")).toBe(true);
      expect(r1.summary).not.toContain("CLI 失败");
      const r2 = await codeReview(dir, { cli: false }); // 钩子语义:env 在也显式关
      expect(r2.findings.some((f) => f.source === "cli")).toBe(false);
      delete process.env.GENIE_REVIEW_CLI;
      const r3 = await codeReview(dir);
      expect(r3.findings.some((f) => f.source === "cli")).toBe(false);
      const r4 = await codeReview(dir, { reviewCli: bin }); // opts 直传优先
      expect(r4.findings.some((f) => f.source === "cli")).toBe(true);
    } finally {
      delete process.env.GENIE_REVIEW_CLI;
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("codeReview:env 指向缺失二进制 → 失败可见(summary 注记),主链不阻塞", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    process.env.GENIE_REVIEW_CLI = "/nonexistent/ocr-xyz";
    try {
      const r = await codeReview(dir);
      expect(r.summary).toContain("不可用");
      expect(r.findings.length).toBeGreaterThan(0); // 确定性层照常
    } finally {
      delete process.env.GENIE_REVIEW_CLI;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
