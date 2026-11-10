/**
 * codesense review 指令锚定:target 三形态/双格式/退出码语义/--deep 闸。
 * 全部走临时夹具仓(进程内 runCli / reviewCommand),不打真网络;
 * 桩 LLM 深审全链经 reviewCommand 的 llmOverride 注入(--deep+真凭证的联网路径由验收轮覆盖)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../src/cli.js";
import { reviewCommand } from "../src/review.js";
import { parseArgs } from "../src/args.js";
import type { ReviewLlm } from "@lampgenie/code-sense/review";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s) => (o.push(s), undefined), err: (s) => (e.push(s), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "csrev-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
  g("init -q"); g('config user.email t@t'); g('config user.name t');
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  g("add ."); g('commit -qm "init"');
  return dir;
}

let dirs: string[] = [];
let homeDir = "";
let savedHome: string | undefined;
function mk(): string {
  const d = gitRepo();
  dirs.push(d);
  return d;
}

beforeAll(() => {
  // 深审凭证闸测试要求环境干净(防外层 shell 带入)
  delete process.env.GENIE_LLM_BASE_URL;
  delete process.env.GENIE_LLM_MODEL;
  delete process.env.GENIE_LLM_API_KEY;
 // 凭证链接通后 runCli 会读真实 ~/.codesense/config.json——HOME 隔离保 hermetic
  savedHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "csrev-home-"));
  process.env.HOME = homeDir;
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

describe("codesense review:target 三形态与退出码", () => {
  it("未提交(缺省)/commit hash/branch 三形态,--json 可解析", async () => {
    const dir = mk();
    appendFileSync(join(dir, "a.ts"), "export const b = 2;\n");
    // 缺省=未提交
    const r1 = capture();
    const c1 = await runCli(["review", "--root", dir, "--json"], r1.io);
    const j1 = JSON.parse(r1.out());
    expect(j1.command).toBe("review");
    expect(j1.target.kind).toBe("uncommitted");
    expect(j1.target.files.map((f: { path: string }) => f.path)).toContain("a.ts");
    expect(j1.counts.blocker).toBe(0);
    expect(c1).toBe(0); // 无 blocker=0(孤独逻辑 warning 不影响)

    execSync("git add a.ts && git commit -qm c2", { cwd: dir });
    const hash = execSync("git rev-parse --short HEAD", { cwd: dir }).toString().trim();
    const r2 = capture();
    const c2 = await runCli(["review", hash, "--root", dir, "--json"], r2.io);
    expect(c2).toBe(0);
    expect(JSON.parse(r2.out()).target.kind).toBe("commit");

    execSync("git checkout -q -b feature", { cwd: dir });
    appendFileSync(join(dir, "a.ts"), "export const c = 3;\n");
    execSync("git commit -aqm c3", { cwd: dir });
    const r3 = capture();
    const c3 = await runCli(["review", "master", "--root", dir, "--json"], r3.io);
    expect(c3).toBe(0);
    const j3 = JSON.parse(r3.out());
    expect(j3.target.kind).toBe("branch");
    expect(j3.target.files[0].path).toBe("a.ts");
  });

  it("blocker 存在 → exit 1(markdown 含 Blocker 分组);干净变更 → exit 0", async () => {
    const dir = mk();
    appendFileSync(join(dir, "a.ts"), 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234";\n');
    const r = capture();
    const code = await runCli(["review", "--root", dir], r.io);
    expect(code).toBe(1);
    expect(r.out()).toContain("# 代码评审报告");
    expect(r.out()).toContain("Blocker");
    expect(r.out()).toContain("疑似凭证入库");
    expect(r.out()).toContain("a.ts");
  });

  it("非 git 根 → exit 1(引擎 fail-visible);非法 --rounds → exit 2", async () => {
    const plain = mkdtempSync(join(tmpdir(), "csrev-plain-"));
    dirs.push(plain);
    const r = capture();
    const code = await runCli(["review", "--root", plain], r.io);
    expect(code).toBe(1);
    expect(r.err()).toContain("codesense 错误");

    const dir = mk();
    const r2 = capture();
    const c2 = await runCli(["review", "--root", dir, "--rounds", "0"], r2.io);
    expect(c2).toBe(2);
    expect(r2.err()).toContain("--rounds");
  });

  it("--deep 缺凭证 → exit 2 + stderr 指路凭证链(不静默降级)", async () => {
    const dir = mk();
    const r = capture();
    const code = await runCli(["review", "--root", dir, "--deep"], r.io);
    expect(code).toBe(2);
    expect(r.err()).toContain("GENIE_LLM_BASE_URL"); // env 档仍在指路内
    expect(r.err()).toContain("codesense config"); // 凭证链指路(config/ask-file)
    expect(r.err()).toContain("ask-file");
  });

  it("--deep flag 三件套在场 → 凭证链接受(不再报缺凭证 exit 2;直连失败为运行错误 exit 1)", async () => {
    const dir = mk();
    const r = capture();
    // 127.0.0.1:9(discard 端口)ECONNREFUSED 立即失败——证明 flag 档进入直连而非凭证闸
    const code = await runCli(["review", "--root", dir, "--deep", "--base-url", "http://127.0.0.1:9", "--model", "m", "--api-key", "sk-x"], r.io);
    expect(code).toBe(1);
    expect(r.err()).not.toContain("凭证链");
    expect(r.err()).not.toContain("exit 2");
  });

  it("llmResolve 注入面:env/config 显式空 → 缺凭证 ReviewUsageError(exit 2 同语义)", async () => {
    const dir = mk();
    await expect(
      reviewCommand(parseArgs(["review", "--deep", "--root", dir]), { json: true, llmResolve: { env: {}, configFile: null } }),
    ).rejects.toThrow(/凭证链/);
  });
});

describe("codesense review:双格式同源与深审全链(桩)", () => {
  it("markdown 与 --json 同 findings 条数;markdown 含 severity 分组与 file:line", async () => {
    const dir = mk();
    appendFileSync(join(dir, "a.ts"), 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234";\n');
    const m = capture();
    await runCli(["review", "--root", dir], m.io);
    const j = capture();
    await runCli(["review", "--root", dir, "--json"], j.io);
    const parsed = JSON.parse(j.out());
    expect(parsed.findings.length).toBe(parsed.counts.total);
    expect(parsed.counts.blocker).toBe(1);
    // markdown 明细行数与 json findings 对齐(每条 finding 一个 "- **file:line**" 项)
    const mdItems = m.out().split("\n").filter((l) => l.startsWith("- **")).length;
    expect(mdItems).toBe(parsed.findings.length);
    expect(m.out()).toContain("**a.ts:");
  });

  it("桩 LLM 深审全链:rounds/grace/层明细/writeback 在 JSON 可见", async () => {
    const dir = mk();
    appendFileSync(join(dir, "a.ts"), "export const leaked = 42;\n");
    const stub: ReviewLlm = {
      async chat(prompt: string) {
        if (prompt.includes("事实核查员")) {
          return { content: JSON.stringify({ analysis: "保留", remove_indices: [], keep_indices: [0] }) };
        }
        if (prompt.includes("已确认的审查发现清单")) {
          return { content: JSON.stringify({ findings: [], summary: "无补充" }) };
        }
        return {
          content: JSON.stringify({
            findings: [{
              file: "a.ts", line: 2, severity: "warning",
              title: "桩发现:导出面扩张", detail: "新增导出 leaked 无调用方", scenario: "仅在测试桩语境",
              anchorText: "export const leaked = 42;",
            }],
            summary: "桩",
          }),
        };
      },
    };
    const r = await reviewCommand(parseArgs(["review", "--deep", "--rounds", "1", "--root", dir]), { json: true, llmOverride: stub });
    const j = r.json as {
      layers: { deep: { enabled: boolean; rounds: { round: number }[]; graceRoundRan: boolean } };
      findings: { title: string }[];
      writeback?: { posted: number; storePath: string };
    };
    expect(j.layers.deep.enabled).toBe(true);
    expect(j.layers.deep.rounds.length).toBe(1);
    expect(j.layers.deep.graceRoundRan).toBe(true);
    expect(j.findings.some((f) => f.title.includes("桩发现"))).toBe(true);
    // 行级回写店:有 findings 即建(引擎内建副作用,CLI 同源)
    expect(j.writeback?.posted).toBeGreaterThanOrEqual(1);
    expect(j.writeback?.storePath).toContain("review-comments.json");
    // markdown 深审行
    expect(r.text).toContain("LLM 深审: 1 轮");
    expect(r.blockers).toBe(0); // 桩给 warning → 无 blocker
  });
});
