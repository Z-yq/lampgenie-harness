/**
 *  开工前置门:基线新鲜度 + 规则旧措辞(2026-11)。
 * 契约:
 * a.readBaselineStatus 绝不抛错:真 git 仓覆盖 fresh/behind/ahead-warn/diverged,无 upstream 与
 *   非 git 目录一律 unknown(前者 reason=no-upstream)——「量不到」不等于「新鲜」,不能静默放行成 fresh;
 * b.fetch 策略:缺省不联网(fetched=false + note 说明本地引用可能过期);显式 fetch=true 才 fetch,
 *   失败/超时降级 unknown 且 reason 注明 fetch-failed,fetched 按实际成功置位;
 * c.接线决策是纯函数(planFreshnessSkip/planFreshnessAction):只有 behind 会拦,blockOnBehind=false
 *   或 GENIE_FRESHNESS_BLOCK=off 降级为警告——阻断口径可在无 gateway 时逐条断言;
 * d.旧措辞扫描:docs/**\/*.md + 根 AGENTS.md; 与 *archive* 目录不报;同文件同 old 只报首处;
 *   上限 50;坏表不抛但 ok=false;
 * e.CLI:check-rule-wording 干净 0 / 命中 2 / 坏表 1(真 spawn tsx 跑一次,证明 exit code 口径)。
 * f.接线存在性:源码静态断言(装配面起 loop 需真 provider/executor,成本过高)——把「接线点在
 *   首轮 runTurn 之前、behind 走 tm.setState failed + return」钉死。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readBaselineStatus, resolveUpstream, loadWordingTable, scanRuleWording,
  planFreshnessSkip, planFreshnessAction, renderFreshnessLine, renderWordingLines,
  type BaselineStatus, type GitRun,
} from "../src/startup-freshness.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  return String(execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"],
  })).trim();
}
function commit(cwd: string, file: string, content: string, msg: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", msg]);
}
function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "genie-fresh-"));
  git(dir, ["-c", "init.defaultBranch=master", "init", "-q"]);
  return dir;
}
/** 上游仓 + 它的本地克隆(origin/master 即 @{upstream})。 */
function repoWithRemote(): { up: string; local: string } {
  const up = newRepo();
  commit(up, "a.txt", "1\n", "init");
  const parent = mkdtempSync(join(tmpdir(), "genie-fresh-clone-"));
  git(parent, ["clone", "-q", up, "local"]);
  return { up, local: join(parent, "local") };
}

describe("readBaselineStatus(真 git 仓)", () => {
  it("fresh:本地与上游齐平 → 0/0、fetched=false、note 说明本地引用可能过期", () => {
    const { local } = repoWithRemote();
    const st = readBaselineStatus({ repoRoot: local });
    expect(st.state).toBe("fresh");
    expect(st.behind).toBe(0);
    expect(st.ahead).toBe(0);
    expect(st.baseRef).toBe("HEAD");
    expect(st.upstreamRef).toBe("origin/master");
    expect(st.fetched).toBe(false);
    expect(st.note).toContain("本地引用可能过期");
    expect(st.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("behind:上游多 3 提交 → behind=3(rev-list 左数=上游独有)", () => {
    const { up, local } = repoWithRemote();
    commit(up, "b.txt", "1\n", "up1");
    commit(up, "b.txt", "2\n", "up2");
    commit(up, "b.txt", "3\n", "up3");
    git(local, ["fetch", "-q", "origin"]);
    const st = readBaselineStatus({ repoRoot: local });
    expect(st.state).toBe("behind");
    expect(st.behind).toBe(3);
    expect(st.ahead).toBe(0);
  });

  it("ahead 超阈:本分支多 2 提交且 maxAhead=1 → ahead-warn(不拦)", () => {
    const { local } = repoWithRemote();
    commit(local, "c.txt", "1\n", "local1");
    commit(local, "c.txt", "2\n", "local2");
    const st = readBaselineStatus({ repoRoot: local, maxAhead: 1 });
    expect(st.state).toBe("ahead-warn");
    expect(st.ahead).toBe(2);
    expect(st.behind).toBe(0);
    // 阈值足够大 → 同仓回落 fresh(证明 ahead-warn 只由阈值触发,不是 ahead>0 就报)
    expect(readBaselineStatus({ repoRoot: local, maxAhead: 50 }).state).toBe("fresh");
  });

  it("diverged:上游 1 + 本分支 1 → diverged-warn", () => {
    const { up, local } = repoWithRemote();
    commit(up, "d.txt", "up\n", "up1");
    commit(local, "e.txt", "local\n", "local1");
    git(local, ["fetch", "-q", "origin"]);
    const st = readBaselineStatus({ repoRoot: local });
    expect(st.state).toBe("diverged-warn");
    expect(st.behind).toBe(1);
    expect(st.ahead).toBe(1);
  });

  it("无 upstream → unknown + reason=no-upstream(不冒充 fresh)", () => {
    const dir = newRepo();
    commit(dir, "a.txt", "1\n", "init");
    expect(resolveUpstream(dir)).toBeNull();
    const st = readBaselineStatus({ repoRoot: dir });
    expect(st.state).toBe("unknown");
    expect(st.reason).toBe("no-upstream");
    expect(st.upstreamRef).toBeNull();
  });

  it("非 git 目录 → unknown(不抛错)", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-fresh-nogit-"));
    const st = readBaselineStatus({ repoRoot: dir });
    expect(st.state).toBe("unknown");
    expect(st.reason).toBeTruthy();
    expect(st.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fetch:true 指向不存在的 remote → unknown + reason 注明 fetch-failed、fetched=false", () => {
    const { local } = repoWithRemote();
    const st = readBaselineStatus({ repoRoot: local, fetch: true, upstreamRef: "nosuchremote/master" });
    expect(st.state).toBe("unknown");
    expect(st.fetched).toBe(false);
    expect(st.reason).toContain("fetch-failed");
    expect(st.reason).toContain("nosuchremote");
  });
});

describe("readBaselineStatus(注入 runner:超时/失败降级 + fetch 语义)", () => {
  it("fetch 抛超时错 → unknown + reason 截断 ≤200 字,不向调用方抛", () => {
    const longErr = "fatal: unable to access remote: operation timed out " + "x".repeat(400);
    const run: GitRun = (args) => {
      if (args[0] === "fetch") { const e = new Error(longErr) as Error & { stderr: string }; e.stderr = longErr; throw e; }
      return "";
    };
    const st = readBaselineStatus({ repoRoot: "/tmp/fake", upstreamRef: "origin/master", fetch: true, timeoutMs: 500, run });
    expect(st.state).toBe("unknown");
    expect(st.fetched).toBe(false);
    expect(st.reason).toContain("fetch-failed");
    expect((st.reason ?? "").length).toBeLessThanOrEqual(200 + 40); // 前缀 + 截断体
  });

  it("fetch 成功后再计数:fetched=true、remote 取 upstreamRef 前段、timeoutMs 透传", () => {
    const seen: Array<{ args: string[]; timeoutMs?: number }> = [];
    const run: GitRun = (args, opts) => {
      seen.push({ args, timeoutMs: opts?.timeoutMs });
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-list") return "2\t1\n";
      return "";
    };
    const st = readBaselineStatus({ repoRoot: "/tmp/fake", upstreamRef: "upstream/master", fetch: true, timeoutMs: 1234, run });
    expect(st.state).toBe("diverged-warn");
    expect(st.behind).toBe(1);
    expect(st.ahead).toBe(2);
    expect(st.fetched).toBe(true);
    const fetchCall = seen.find((s) => s.args[0] === "fetch");
    expect(fetchCall?.args).toEqual(["fetch", "--quiet", "upstream"]);
    expect(fetchCall?.timeoutMs).toBe(1234);
  });

  it("rev-list 失败 → unknown + reason=rev-list-failed", () => {
    const run: GitRun = (args) => {
      if (args[0] === "rev-list") throw Object.assign(new Error("bad revision"), { stderr: "fatal: bad revision 'x...y'" });
      return args[0] === "rev-parse" ? "origin/master" : "";
    };
    const st = readBaselineStatus({ repoRoot: "/tmp/fake", run });
    expect(st.state).toBe("unknown");
    expect(st.reason).toContain("rev-list-failed");
    expect(st.reason).toContain("bad revision");
  });
});

describe("接线决策纯函数", () => {
  const behind: BaselineStatus = { state: "behind", behind: 3, ahead: 0, baseRef: "HEAD", upstreamRef: "origin/master", fetched: false, durationMs: 1 };

  it("planFreshnessSkip:非 coding→taskClass;env off→env;cfg.enabled=false→config;否则不跳", () => {
    expect(planFreshnessSkip({ taskClass: "qa", env: {} })).toEqual({ skip: true, reason: "taskClass" });
    expect(planFreshnessSkip({ taskClass: "coding", env: { GENIE_FRESHNESS: "off" } })).toEqual({ skip: true, reason: "env" });
    expect(planFreshnessSkip({ taskClass: "coding", cfg: { enabled: false }, env: {} })).toEqual({ skip: true, reason: "config" });
    expect(planFreshnessSkip({ taskClass: "coding", cfg: { enabled: true }, env: {} })).toEqual({ skip: false });
  });

  it("behind 缺省拦:消息含 behind 数/upstream/修复命令(git pull --rebase)", () => {
    const a = planFreshnessAction(behind, {}, {});
    expect(a.effect).toBe("blocked");
    expect(a.message).toContain("3 个提交");
    expect(a.message).toContain("origin/master");
    expect(a.message).toContain("git pull --rebase");
    expect(a.message).toContain("git fetch origin");
  });

  it("降级两路:GENIE_FRESHNESS_BLOCK=off 与 blockOnBehind=false 都变 warn-block-override", () => {
    expect(planFreshnessAction(behind, {}, { GENIE_FRESHNESS_BLOCK: "off" }).effect).toBe("warn-block-override");
    expect(planFreshnessAction(behind, { blockOnBehind: false }, {}).effect).toBe("warn-block-override");
    expect(planFreshnessAction(behind, { blockOnBehind: false }, { GENIE_FRESHNESS_BLOCK: "off" }).message).toContain("GENIE_FRESHNESS_BLOCK=off");
  });

  it("非 behind 态一律 proceed(diverged/ahead-warn/unknown 不拦)", () => {
    for (const state of ["fresh", "ahead-warn", "diverged-warn", "unknown"] as const) {
      expect(planFreshnessAction({ ...behind, state }, {}, {}).effect).toBe("proceed");
    }
  });

  it("renderFreshnessLine:含四要素,unknown 带 reason", () => {
    const line = renderFreshnessLine({ ...behind, state: "unknown", upstreamRef: null, reason: "no-upstream", note: "本地引用可能过期" });
    expect(line).toContain("state=unknown");
    expect(line).toContain("behind=3");
    expect(line).toContain("upstream=none");
    expect(line).toContain("reason=no-upstream");
  });

  it("renderWordingLines:≤10 条 + 旧→新", () => {
    const hits = Array.from({ length: 12 }, (_, i) => ({ file: "docs/x.md", line: i + 1, old: `旧${i}`, new: `新${i}` }));
    const text = renderWordingLines(hits);
    expect(text).toContain("共 12 处");
    expect(text).toContain("docs/x.md:1 「旧0」→ 「新0」");
    expect(text).not.toContain("docs/x.md:11"); // 只列前 10
  });
});

function wordingRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "genie-wording-"));
  mkdirSync(join(dir, ".genie"), { recursive: true });
  mkdirSync(join(dir, "docs", "sub"), { recursive: true });
  mkdirSync(join(dir, "docs", "archive"), { recursive: true });
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, ".genie", "rule-wording.json"), JSON.stringify({ rules: [{ old: "旧说法A", new: "现行说法A" }] }));
  writeFileSync(join(dir, "AGENTS.md"), "# 冠\n这里是旧说法A 出现在第二行\n");
  writeFileSync(join(dir, "docs", "x.md"), "# x\n旧说法A 在这里\n旧说法A 又一次(同文件同 old 只报首处)\n");
  writeFileSync(join(dir, "docs", "sub", "y.md"), "干净文档\n");
  writeFileSync(join(dir, "tasks", "old-plan.md"), "旧说法A\n");
  writeFileSync(join(dir, "docs", "archive", "z.md"), "旧说法A\n");
  return dir;
}

describe("规则旧措辞扫描", () => {
  it("表不存在 → ok+rules:[](不是错误)", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-wording-empty-"));
    expect(loadWordingTable(dir)).toEqual({ ok: true, rules: [] });
    expect(scanRuleWording({ repoRoot: dir })).toEqual({ ok: true, hints: [] });
  });

  it("命中:AGENTS.md 与 docs/x.md 各一处;tasks/ 与 docs/archive/ 不报;同文件同 old 只报首处", () => {
    const dir = wordingRepo();
    const table = loadWordingTable(dir);
    expect(table.ok).toBe(true);
    const res = scanRuleWording({ repoRoot: dir });
    expect(res.ok).toBe(true);
    expect(res.hints).toHaveLength(2);
    const agents = res.hints.find((h) => h.file === "AGENTS.md");
    expect(agents).toEqual({ file: "AGENTS.md", line: 2, old: "旧说法A", new: "现行说法A" });
    const x = res.hints.find((h) => h.file === "docs/x.md");
    expect(x?.line).toBe(2);
    expect(x?.new).toBe("现行说法A");
    expect(res.hints.some((h) => h.file.startsWith("tasks/"))).toBe(false);
    expect(res.hints.some((h) => h.file.includes("archive"))).toBe(false);
  });

  it("rule.files 正则限定扫描面(只扫匹配者)", () => {
    const dir = wordingRepo();
    const res = scanRuleWording({ repoRoot: dir, rules: [{ old: "旧说法A", new: "现行说法A", files: ["^docs/x\\.md$"] }] });
    expect(res.hints).toEqual([{ file: "docs/x.md", line: 2, old: "旧说法A", new: "现行说法A" }]);
    const none = scanRuleWording({ repoRoot: dir, rules: [{ old: "旧说法A", new: "现行说法A", files: ["^docs/sub/"] }] });
    expect(none.hints).toEqual([]);
  });

  it("坏表 → ok:false + error(不抛)", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-wording-bad-"));
    mkdirSync(join(dir, ".genie"), { recursive: true });
    writeFileSync(join(dir, ".genie", "rule-wording.json"), "{ 这不是 JSON ");
    const table = loadWordingTable(dir);
    expect(table.ok).toBe(false);
    const res = scanRuleWording({ repoRoot: dir });
    expect(res.ok).toBe(false);
    expect(res.hints).toEqual([]);
    expect(res.error).toContain("rule-wording.json");
    // 形状坏(缺 new/old 非字符串)同样 ok:false
    writeFileSync(join(dir, ".genie", "rule-wording.json"), JSON.stringify({ rules: [{ old: "" }] }));
    expect(loadWordingTable(dir).ok).toBe(false);
  });

  it("总上限 50 条", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-wording-cap-"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    for (let i = 0; i < 60; i++) writeFileSync(join(dir, "docs", `f${String(i).padStart(2, "0")}.md`), `旧说法A 第 ${i} 个\n`);
    const res = scanRuleWording({ repoRoot: dir, rules: [{ old: "旧说法A", new: "现行说法A" }] });
    expect(res.ok).toBe(true);
    expect(res.hints).toHaveLength(50);
  });
});

describe("CLI(真 spawn tsx)", () => {
  const TSX = join(REPO, "node_modules", ".bin", "tsx");
  function runCli(script: string, args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = String(execFileSync(TSX, [join(REPO, "scripts", script), ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }));
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
      return { status: Number(e.status ?? -1), stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
  }

  it("check-rule-wording:命中 exit 2(JSON 带 hints)", () => {
    const dir = wordingRepo();
    const r = runCli("check-rule-wording.mts", ["--json", "--root", dir], REPO);
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout) as { ok: boolean; hints: unknown[] };
    expect(out.ok).toBe(true);
    expect(out.hints.length).toBe(2);
  }, 120_000);

  it("check-rule-wording:干净仓 exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-wording-clean-"));
    const r = runCli("check-rule-wording.mts", ["--json", "--root", dir], REPO);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; hints: unknown[] };
    expect(out.ok).toBe(true);
    expect(out.hints).toEqual([]);
  }, 120_000);

  it("check-rule-wording:坏表 exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "genie-wording-badcli-"));
    mkdirSync(join(dir, ".genie"), { recursive: true });
    writeFileSync(join(dir, ".genie", "rule-wording.json"), "not json");
    const r = runCli("check-rule-wording.mts", ["--json", "--root", dir], REPO);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  }, 120_000);

  it("freshness CLI:真仓 fresh → exit 0 且 JSON state=fresh;behind 仓 → state=behind", () => {
    const { up, local } = repoWithRemote();
    const clean = runCli("freshness.mts", [], local);
    expect(clean.status).toBe(0);
    const st = JSON.parse(clean.stdout) as { state: string; behind: number; upstreamRef: string };
    expect(st.state).toBe("fresh");
    expect(st.upstreamRef).toBe("origin/master");
    commit(up, "b.txt", "1\n", "up1");
    git(local, ["fetch", "-q", "origin"]);
    const behindRun = runCli("freshness.mts", ["--json", "--fetch"], local);
    expect(behindRun.status).toBe(0);
    const st2 = JSON.parse(behindRun.stdout) as { state: string; behind: number; fetched: boolean };
    expect(st2.state).toBe("behind");
    expect(st2.behind).toBe(1);
    expect(st2.fetched).toBe(true);
  }, 120_000);
});

describe("接线静态断言(装配面:首轮 runTurn 之前)", () => {
  const src = readFileSync(join(REPO, "apps/gateway/src/agent-wiring.ts"), "utf8");

  it("导入 + 跳过/拦截/警告三条路径都在,且拦在 runTurn 之前", () => {
    expect(src).toContain('from "./startup-freshness.js"');
    expect(src).toContain("planFreshnessSkip({ taskClass: taskClassState.value");
    expect(src).toContain('type: "task.freshness"');
    expect(src).toContain('effect: "blocked"');
    expect(src).toContain("tm.setState(curFresh, \"failed\"");
    expect(src).toContain('type: "rule.wording"');
    expect(src).toContain("renderWordingLines(scan.hints)");
    const gate = src.indexOf("planFreshnessAction(freshStatus");
    const runTurn = src.indexOf("loop.runTurn(instruction + attachmentBlock");
    expect(gate).toBeGreaterThan(0);
    expect(runTurn).toBeGreaterThan(0);
    expect(gate).toBeLessThan(runTurn);
  });
});
