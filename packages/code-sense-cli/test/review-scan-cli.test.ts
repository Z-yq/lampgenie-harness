/**
 * codesense review --scan / --sessions / --resume / --compare 的 CLI 契约。
 * 进程内 runCli + 临时夹具仓;不联网、不 --deep。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "csrev-scan-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: d, stdio: "pipe" });
  g("init -q"); g("config user.email t@t"); g("config user.name t");
  return d;
}
function put(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function commitAll(root: string): void {
  execSync("git add -A && git commit -qm fixture", { cwd: root, stdio: "pipe" });
}

const dirs: string[] = [];
let homeDir = "";
let savedHome: string | undefined;

beforeAll(() => {
  delete process.env.GENIE_LLM_BASE_URL;
  delete process.env.GENIE_LLM_MODEL;
  delete process.env.GENIE_LLM_API_KEY;
  savedHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "csrev-scan-home-"));
  process.env.HOME = homeDir;
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

const BAD = 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456";\n';

describe("codesense review --scan", () => {
  it("指定目录全文件扫描:kind=scan、blocker→exit 1、会话落盘;--include 收窄", async () => {
    const d = repo();
    dirs.push(d);
    put(d, "src/a.ts", BAD);
    put(d, "src/b.py", "print('x')\n");
    put(d, "other/c.ts", BAD);
    put(d, "node_modules/dep/x.js", "x\n");
    commitAll(d);

    const r = capture();
    const code = await runCli(["review", "--scan", "src", "--root", d, "--json"], r.io);
    expect(code).toBe(1);
    const j = JSON.parse(r.out());
    expect(j.command).toBe("review");
    expect(j.target.kind).toBe("scan");
    expect(j.target.scan.scannedFiles).toBe(2);
    expect(j.target.files.map((f: { path: string }) => f.path).sort()).toEqual(["src/a.ts", "src/b.py"]);
    expect(j.counts.blocker).toBe(1);
    expect(j.findings.some((f: { title: string }) => f.title === "疑似凭证入库")).toBe(true);
    expect(j.session?.id).toBeTruthy();
    expect(existsSync(join(d, ".genie", "reviews", `${j.session.id}.json`))).toBe(true);
    expect(existsSync(join(d, ".genie", "review-comments.json"))).toBe(false);

    const r2 = capture();
    const code2 = await runCli(["review", "--scan", "src", "--include", "*.ts", "--root", d, "--json"], r2.io);
    expect(code2).toBe(1);
    const j2 = JSON.parse(r2.out());
    expect(j2.target.files.map((f: { path: string }) => f.path)).toEqual(["src/a.ts"]);
  });

  it("--sessions 列出会话;--resume 继承 scan 范围并输出四态;--compare 不写血缘", async () => {
    const d = repo();
    dirs.push(d);
    put(d, "src/a.ts", BAD);
    commitAll(d);

    const r1 = capture();
    expect(await runCli(["review", "--scan", "src", "--root", d, "--json"], r1.io)).toBe(1);
    const j1 = JSON.parse(r1.out());
    const id1 = j1.session.id as string;

    const list = capture();
    expect(await runCli(["review", "--sessions", "--root", d, "--json"], list.io)).toBe(0);
    const jl = JSON.parse(list.out());
    expect(jl.sessions.length).toBe(1);
    expect(jl.sessions[0].id).toBe(id1);

    // 修好 → resume:已修复 1;继承 src 范围(不扫 other)
    put(d, "other/x.ts", BAD);
    put(d, "src/a.ts", "const key = process.env.API_KEY;\n");
    const r2 = capture();
    expect(await runCli(["review", "--resume", id1, "--root", d, "--json"], r2.io)).toBe(0);
    const j2 = JSON.parse(r2.out());
    expect(j2.target.kind).toBe("scan");
    expect(j2.target.files.map((f: { path: string }) => f.path)).toEqual(["src/a.ts"]); // 继承 paths=src
    expect(j2.compare.baseline).toBe(id1);
    expect(j2.compare.counts.resolved).toBe(1);
    expect(j2.compare.counts.new).toBe(0);
    expect(j2.session.resumedFrom).toBe(id1);
    const id2 = j2.session.id as string;

    // 重新引入 → compare id2:复现 1(更早的 id1 出现过)
    put(d, "src/a.ts", BAD);
    const r3 = capture();
    expect(await runCli(["review", "--compare", id2, "--root", d, "--json"], r3.io)).toBe(1);
    const j3 = JSON.parse(r3.out());
    expect(j3.compare.counts.reappeared).toBe(1);
    expect(j3.compare.counts.new).toBe(0);
    expect(j3.session.resumedFrom).toBeUndefined();

    const reviews = readdirSync(join(d, ".genie", "reviews")).filter((n) => n.endsWith(".json"));
    expect(reviews.length).toBe(3);
  });

  it("用法错误 exit 2:基线不存在/扫描路径不存在/scan+impact", async () => {
    const d = repo();
    dirs.push(d);
    put(d, "a.ts", "export const a = 1;\n");
    commitAll(d);

    const r1 = capture();
    expect(await runCli(["review", "--resume", "no-such-session", "--root", d], r1.io)).toBe(2);
    expect(r1.err()).toContain("基线会话不存在");

    const r2 = capture();
    expect(await runCli(["review", "--scan", "no-such-dir", "--root", d], r2.io)).toBe(2);
    expect(r2.err()).toContain("扫描路径不存在");

    const r3 = capture();
    expect(await runCli(["review", "--scan", "--impact", "--root", d], r3.io)).toBe(2);
    expect(r3.err()).toContain("--impact");
  });

  it("--scan --deep 经 CLI 包装走 stub 深审(scanDeep + anchor 定位可见)", async () => {
    const d = repo();
    dirs.push(d);
    put(d, "src/a.ts", "export const a = 1;\nexport const b = 2;\n");
    commitAll(d);
    const stub: ReviewLlm = {
      async chat(prompt: string) {
        if (prompt.includes("事实核查员")) return { content: JSON.stringify({ analysis: "保留", remove_indices: [], keep_indices: [0] }) };
        if (prompt.includes("完整源文件") && prompt.includes("第 1 轮评审")) {
          return { content: JSON.stringify({ findings: [{ file: "src/a.ts", line: 2, severity: "warning", title: "桩发现", detail: "export const b", scenario: "测试", anchorText: "export const b = 2;" }] }) };
        }
        return { content: JSON.stringify({ findings: [] }) };
      },
    };
    const r = await reviewCommand(parseArgs(["review", "--scan", ".", "--deep", "--rounds", "1", "--root", d]), { json: true, llmOverride: stub });
    const j = r.json as { scanDeep?: { batches: number; filesReviewed: number }; findings: { title: string; line: number }[]; target: { kind: string } };
    expect(j.target.kind).toBe("scan");
    expect(j.scanDeep?.batches).toBe(1);
    expect(j.findings.some((f) => f.title === "桩发现" && f.line === 2)).toBe(true);
    expect(r.text).toContain("scan 深审");
    expect(r.text).toContain("会话:");
  });
});
