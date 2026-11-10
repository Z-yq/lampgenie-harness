/**
 * 全文件扫描 + 会话续跑/比较(引擎层)。
 * 全部临时夹具仓/目录,无网络;深审走桩 LLM。
 */
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  codeReview, collectScanTarget, compareFindings, listReviewSessions, loadReviewSession,
  matchGlob, planScanBatches, toScanPseudoDiff,
  type Finding, type ReviewLlm,
} from "../src/review/index";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function repo(): string {
  const d = tmp("gh-scan-");
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: d, stdio: "pipe" });
  g("init -q"); g("config user.email t@t"); g("config user.name t");
  return d;
}
function put(root: string, rel: string, content: string | Buffer): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function commitAll(root: string): void {
  execSync("git add -A && git commit -qm fixture", { cwd: root, stdio: "pipe" });
}
function freeFinding(anchor: string, file = "a.ts", line = 1, title = "同一个问题"): Finding {
  return { file, line, severity: "warning", title, detail: `关于 ${anchor}`, anchorText: anchor };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("D1 scan 枚举/过滤/预算", () => {
  it("git 面:继承 .gitignore + 默认排除 vendored/生成物 + include/exclude/path", async () => {
    const d = repo();
    put(d, ".gitignore", ".env\nnode_modules/\ndist/\n");
    put(d, "src/a.ts", "export const a = 1;\n");
    put(d, "src/b.py", "print('hi')\n");
    put(d, "docs/readme.md", "# hi\n");
    put(d, "node_modules/pkg/index.js", "module.exports = 1;\n");
    put(d, "dist/bundle.js", "bundled\n");
    put(d, "vendor/lib/x.ts", "export const v = 1;\n");
    put(d, ".env", "SECRET=1\n");
    put(d, "package-lock.json", "{}\n");
    commitAll(d);

    const all = await collectScanTarget(d);
    expect(all.kind).toBe("scan");
    expect(all.scan!.source).toBe("git");
    const paths = all.files.map((f) => f.path).sort();
    expect(paths).toEqual(["docs/readme.md", "src/a.ts", "src/b.py"]);

    const ts = await collectScanTarget(d, { include: ["*.ts"] });
    expect(ts.files.map((f) => f.path)).toEqual(["src/a.ts"]);

    const noPy = await collectScanTarget(d, { exclude: ["src/b.py"] });
    expect(noPy.files.map((f) => f.path)).not.toContain("src/b.py");
    expect(noPy.files.map((f) => f.path)).toContain("src/a.ts");

    const scoped = await collectScanTarget(d, { paths: ["src"] });
    expect(scoped.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.py"]);

    await expect(collectScanTarget(d, { paths: ["../outside"] })).rejects.toThrow(/越界/);
    await expect(collectScanTarget(d, { paths: ["no-such-dir"] })).rejects.toThrow(/不存在/);
  });

  it("文件数上限/单文件截断/二进制跳过,全部如实登记", async () => {
    const d = repo();
    put(d, "a.ts", "export const a = 1;\n");
    put(d, "b.ts", "export const b = 1;\n");
    put(d, "big.ts", "x".repeat(49) + "\n");
    put(d, "bin.dat", Buffer.from([0, 1, 2, 3, 4, 5]));
    commitAll(d);

    const capped = await collectScanTarget(d, { maxFiles: 2 });
    expect(capped.files.length).toBe(2);
    expect(capped.scan!.eligibleFiles).toBeGreaterThanOrEqual(3);
    expect(capped.scan!.skipped.overFileLimit).toBeGreaterThanOrEqual(1);
    expect(capped.truncated).toBe(true);

    const trunc = await collectScanTarget(d, { maxFileBytes: 20 });
    const big = trunc.files.find((f) => f.path === "big.ts")!;
    expect(big).toBeTruthy();
    expect(big.content!.length).toBe(20);
    expect(trunc.scan!.truncatedCount).toBe(1);
    expect(trunc.scan!.truncatedFiles[0]).toMatchObject({ path: "big.ts", bytes: 50, keptBytes: 20 });
    expect(trunc.scan!.skipped.binary).toBe(1);
  });

  it("非 git 目录回退 walk + 根 .gitignore 简读", async () => {
    const d = tmp("gh-scan-plain-");
    put(d, ".gitignore", "*.log\n");
    put(d, "src/a.ts", "export const a = 1;\n");
    put(d, "node_modules/x/index.js", "x\n");
    put(d, "debug.log", "noise\n");
    const t = await collectScanTarget(d);
    expect(t.scan!.source).toBe("walk");
    const paths = t.files.map((f) => f.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("node_modules/x/index.js");
    expect(paths).not.toContain("debug.log");
  });

  it("glob 语义与伪 diff 行号契约", () => {
    expect(matchGlob("*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(matchGlob("src/**", "src/deep/a.ts")).toBe(true);
    expect(matchGlob("**/generated/**", "pkg/generated/x.ts")).toBe(true);
    expect(matchGlob("**/*.{js,ts}", "x/y.ts")).toBe(true);
    expect(matchGlob("test/fixtures", "test/fixtures/a.json")).toBe(true); // 无通配符目录模式覆盖子路径

    const p = toScanPseudoDiff("a.ts", "line1\nline2\n");
    expect(p.lines).toBe(2);
    expect(p.diffText).toContain("@@ -0,0 +1,2 @@");
    expect(p.diffText).toContain("+line1\n+line2");
  });
});

describe("D2 scan 确定性评审 + 会话落盘", () => {
  it("全文件扫描出凭证/调试发现;不写 diff 回写店;会话落 .genie/reviews", async () => {
    const d = repo();
    put(d, "bad.ts", 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456";\nconsole.log("debug");\n');
    put(d, "clean.ts", "export const ok = 1;\n");
    commitAll(d);

    const r = await codeReview(d, { scan: {} });
    expect(r.target.kind).toBe("scan");
    expect(r.scan!.scannedFiles).toBe(2);
    expect(r.summary).toContain("全文件扫描");
    expect(r.summary).toContain("未注入 LLM");
    expect(r.summary).toContain("scan 模式不跑 diff 语义反模式");
    const titles = r.findings.map((f) => f.title);
    expect(titles).toContain("疑似凭证入库");
    expect(titles).toContain("疑似调试输出残留");
    expect(r.findings.find((f) => f.title === "疑似凭证入库")!.severity).toBe("blocker");
    expect(existsSync(join(d, ".genie", "review-comments.json"))).toBe(false);
    expect(r.session).toBeTruthy();
    expect(existsSync(r.session!.path)).toBe(true);
    const saved = loadReviewSession(d, r.session!.id)!;
    expect(saved.kind).toBe("scan");
    expect(saved.counts.total).toBe(r.findings.length);
    expect(saved.target.scanStats?.scannedFiles).toBe(2);
  });

  it("深审分批:桩 finding 经 anchor 定位到真实行号;预算超限只跑首批并登记跳过", async () => {
    const d = repo();
    put(d, "src/a.ts", "export const a = 1;\nexport const b = 2;\n");
    commitAll(d);
    const prompts: string[] = [];
    const llm: ReviewLlm = {
      async chat(p) {
        prompts.push(p);
        if (p.includes("事实核查员")) return { content: JSON.stringify({ analysis: "保留", remove_indices: [], keep_indices: [0] }) };
        if (p.includes("完整源文件") && p.includes("第 1 轮评审")) {
          return { content: JSON.stringify({ findings: [{ file: "src/a.ts", line: 2, severity: "warning", title: "桩发现", detail: "export const b 未使用", scenario: "测试", anchorText: "export const b = 2;" }] }) };
        }
        return { content: JSON.stringify({ findings: [] }) };
      },
    };
    const r = await codeReview(d, { scan: {}, llm, maxRounds: 1 });
    expect(r.scanDeep!.batches).toBe(1);
    expect(prompts.some((p) => p.includes("全文件扫描"))).toBe(true);
    expect(prompts.some((p) => p.includes("只审变更"))).toBe(false); // scan 提示词不沿用 diff 纪律
    const f = r.findings.find((x) => x.title === "桩发现")!;
    expect(f).toBeTruthy();
    expect(f.line).toBe(2);
    expect((f as Finding & { resolution?: string }).resolution).toBe("anchor");

    // 9 个 20k 文件 → 2 批;预算 1 token:首批必跑、第二批整批跳过并登记
    const d2 = repo();
    for (let i = 0; i < 9; i++) put(d2, `f${i}.ts`, "// " + "x".repeat(20_000) + "\n");
    commitAll(d2);
    let calls = 0;
    const llm2: ReviewLlm = { async chat() { calls++; return { content: JSON.stringify({ findings: [] }) }; } };
    const r2 = await codeReview(d2, { scan: { maxTokens: 1 }, llm: llm2, maxRounds: 1 });
    const firstBatch = planScanBatches(r2.target.files)[0]!;
    expect(r2.scanDeep!.batches).toBe(1);
    expect(r2.scanDeep!.filesReviewed).toBe(firstBatch.length);
    expect(r2.scanDeep!.filesSkippedByBudget).toBe(r2.target.files.length - firstBatch.length);
    expect(calls).toBe(1);
    expect(r2.summary).toContain(`预算跳过 ${r2.target.files.length - firstBatch.length} 文件`);
    expect(planScanBatches([{ path: "x", status: "scanned", diffText: "", content: "x" }]).length).toBe(1);
  });
});

describe("D3 会话四态比较", () => {
  it("compareFindings:新增/已修复/未变/复现 四态", () => {
    const A = freeFinding("const a = 1;");
    const B = freeFinding("const b = 2;");
    const C = freeFinding("const c = 3;");
    const D = freeFinding("const c = 3;", "a.ts", 4, "更早的同一问题");
    const E = freeFinding("const e = 5;");
    const cmp = compareFindings(
      [A, B],
      [{ ...A, line: 9 }, C, E],
      [[A], [B], [D]],
    );
    // C 在更早会话(D)出现过且基线没有 → 复现;E 从未出现 → 新增
    expect(cmp.counts).toEqual({ new: 1, resolved: 1, unchanged: 1, reappeared: 1 });
    expect(cmp.unchanged[0]!.line).toBe(9); // 未变携带当前行号
    expect(cmp.resolved[0]!.title).toBe(B.title);
    expect(cmp.reappeared[0]!.detail).toContain("const c = 3;");
    expect(cmp.new[0]!.detail).toContain("const e = 5;");
  });

  it("真实两轮:修复→resolved;重新引入→reappeared;会话文件带 baseline/resumedFrom", async () => {
    const d = repo();
    const bad = 'const key = "sk-abcdefghijklmnopqrstuvwxyz123456";\n';
    put(d, "x.ts", bad);
    commitAll(d);

    const r1 = await codeReview(d, { scan: {} });
    expect(r1.findings.some((f) => f.title === "疑似凭证入库")).toBe(true);
    const id1 = r1.session!.id;

    // 修好:第二轮以第一轮为基线
    put(d, "x.ts", "const key = process.env.API_KEY;\n");
    const r2 = await codeReview(d, { scan: {}, session: { baseline: id1, resumedFrom: id1 } });
    expect(r2.compare!.baseline).toBe(id1);
    expect(r2.compare!.counts.resolved).toBe(1);
    expect(r2.compare!.counts.unchanged).toBe(0);
    const saved2 = loadReviewSession(d, r2.session!.id)!;
    expect(saved2.baseline).toBe(id1);
    expect(saved2.resumedFrom).toBe(id1);

    // 重新引入:第三轮以第二轮为基线;第一轮出现过 → 复现而非新增
    put(d, "x.ts", bad);
    const r3 = await codeReview(d, { scan: {}, session: { baseline: r2.session!.id } });
    expect(r3.compare!.counts.reappeared).toBe(1);
    expect(r3.compare!.counts.new).toBe(0);

    const all = listReviewSessions(d);
    expect(all.length).toBe(3);
    expect(all.map((s) => s.id)).toEqual([id1, r2.session!.id, r3.session!.id]);
  });

  it("基线缺失/类型不一致 fail-visible", async () => {
    const d = repo();
    put(d, "a.ts", "export const a = 1;\n");
    commitAll(d);
    await expect(codeReview(d, { scan: {}, session: { baseline: "nope-000000" } })).rejects.toThrow(/基线会话不存在/);
    // 先造一个 diff 会话,再用 scan 对比 → 类型不一致
    const rDiff = await codeReview(d);
    await expect(codeReview(d, { scan: {}, session: { baseline: rDiff.session!.id } })).rejects.toThrow(/会话类型不一致/);
  });
});
