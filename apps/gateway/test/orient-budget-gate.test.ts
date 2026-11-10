/**
 * 扫描根预算闸(2026-10-21 7700 两次挂死根因修复;2026-10-23 起守护面=code_sense 工具语义面
 * +warmIndex,开工 orient 注入链已按用户口径删除):
 * - rootScanVerdict:有界 walk 估算文件数/体积,超阈值(缺省 5000 文件/800MB,env 可调)→ 拒绝;
 *   fail-safe:阈值收紧即拒,memo TTL 内复用旧判定;
 * - code_sense 工具:超预算根返回显式拒绝+收窄指引,不进扫描。
 * 实锤背景:工作区根 /mnt/e/workship/genie(9p 巨型非 git 根)被当 taskRoot 时,主进程内
 * codeSense(plan) 全量扫描把 libuv 线程池 D 态占死,网关 HTTP 全停(当日两次挂死)。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootScanVerdict, codeSenseTool } from "../src/agent-wiring.js";
import { detectWorkspaceRepos } from "../src/sense-root-gate.js";
import { writeIndexMeta } from "@lampgenie/code-sense/callgraph/index-meta";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";

// env 互斥(与 file-tools 同款):threads pool 共享 process.env,动 GENIE_SENSE_* 开关必须串行。
beforeAll(async () => { await acquireEnvLock("orient-gate"); }, 240_000);
afterAll(() => { releaseEnvLock("orient-gate"); });

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "orientgate-")); dirs.push(d); return d; };
const ENV_KEYS = ["GENIE_SENSE_ORIENT_MAX_FILES", "GENIE_SENSE_ORIENT_MAX_MB", "GENIE_SENSE_GATE_TTL_MS",
  "GENIE_SENSE_GATE_DEADLINE_MS", "GENIE_SENSE_GATE_META_TRUST_MS", "GENIE_SENSE_REPOS_TTL_MS",
  "GENIE_SENSE_FP_BUDGET_MS", "GENIE_SENSE_MAX_INDEX_AGE_MS"] as const;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("rootScanVerdict 有界预算闸", () => {
  it("小根放行(实计文件数/体积);阈值收紧后同一根被拒(文件数档)", async () => {
    const d = mk();
    writeFileSync(join(d, "a.ts"), "1");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "b.ts"), "2");
    process.env.GENIE_SENSE_GATE_TTL_MS = "0"; // 每次重算(memo 失效)
    const ok = await rootScanVerdict(d);
    expect(ok.ok).toBe(true);
    expect(ok.files).toBe(2);
    expect(ok.bytesMb).toBeLessThan(1);
    process.env.GENIE_SENSE_ORIENT_MAX_FILES = "1";
    const blocked = await rootScanVerdict(d);
    expect(blocked.ok).toBe(false);
    expect(String(blocked.reason)).toContain("文件数达上限 1");
  });

  it("体积档:源码体积超阈值拒绝", async () => {
    const d = mk();
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    process.env.GENIE_SENSE_ORIENT_MAX_MB = "0.001"; // ~1KB
    writeFileSync(join(d, "big.ts"), "x".repeat(200_000));
    const v = await rootScanVerdict(d);
    expect(v.ok).toBe(false);
    expect(String(v.reason)).toContain("源码体积超");
  });

  it("计费口径只算源码:大体积非源码文件不推高体积/文件数(2026-11-02 假巨仓修复)", async () => {
    const d = mk();
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    process.env.GENIE_SENSE_ORIENT_MAX_MB = "0.001"; // ~1KB:旧口径 300KB 二进制必炸,新口径不计
    writeFileSync(join(d, "logo.png"), Buffer.alloc(300_000, 1));
    writeFileSync(join(d, "pnpm-lock.yaml"), "x".repeat(300_000));
    const v = await rootScanVerdict(d);
    expect(v.ok).toBe(true);
    expect(v.files).toBe(0);
  });

  it("memo:TTL 内复用旧判定(阈值变化不生效);TTL=0 每次重算", async () => {
    const d = mk();
    writeFileSync(join(d, "a.ts"), "1");
    process.env.GENIE_SENSE_GATE_TTL_MS = "600000";
    const v1 = await rootScanVerdict(d);
    expect(v1.ok).toBe(true);
    process.env.GENIE_SENSE_ORIENT_MAX_FILES = "1";
    const v2 = await rootScanVerdict(d);
    expect(v2.ok).toBe(true); // memo 命中:阈值变化在 TTL 内不生效
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    const v3 = await rootScanVerdict(d);
    expect(v3.ok).toBe(false); // TTL=0 重算:新阈值生效
  });
});

describe("code_sense 工具闸", () => {
  it("超预算根 → 显式拒绝+收窄指引,不进扫描", async () => {
    const d = mk();
    for (let i = 0; i < 3; i++) writeFileSync(join(d, "f" + i + ".ts"), "x");
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    process.env.GENIE_SENSE_ORIENT_MAX_FILES = "2";
    const tool = codeSenseTool(d);
    const out = String(await tool.execute({ query: "项目结构" }));
    // 2026-10-30 契约升级:拒绝文本从「超出主进程扫描预算」升级为工作区感知版
    // (单一巨仓=CLI 显式构建指引;工作区根=子仓收窄三条出路)。拒绝必须带路。
    expect(out).toContain("已拒绝对该根自动语义扫描");
    expect(out).toContain("codesense index"); // 单一巨仓出路:人类显式 CLI
    expect(out).toContain("GENIE_SENSE_ORIENT_MAX_FILES");
  });
});

describe("rootScanVerdict index-meta 短路(2026-11-08)", () => {
  it("有新鲜 meta 且 srcCount 在预算内:不走 walk,直接放行(source=index-meta)", async () => {
    const d = mk();
    writeFileSync(join(d, "a.ts"), "1");
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    writeIndexMeta(d, { version: 1, root: d, builtAt: Date.now(), srcCount: 7, nodes: 10, edges: 20 });
    const v = await rootScanVerdict(d);
    expect(v.ok).toBe(true);
    expect(v.source).toBe("index-meta");
    expect(v.files).toBe(7); // 来自 meta,不是 walk(磁盘只有 1 个文件)
  });

  it("meta 超龄 → 回真实 walk 复核(source=walk)", async () => {
    const d = mk();
    writeFileSync(join(d, "a.ts"), "1");
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    writeIndexMeta(d, { version: 1, root: d, builtAt: Date.now() - 25 * 3600_000, srcCount: 7, nodes: 10, edges: 20 });
    const v = await rootScanVerdict(d);
    expect(v.source).toBe("walk");
    expect(v.files).toBe(1);
  });
});

describe("工作区子仓识别(2026-11-08)", () => {
  it("git 仓根:包目录不再被认成子仓(detectWorkspaceRepos=[])", async () => {
    const d = mk();
    mkdirSync(join(d, ".git"));
    mkdirSync(join(d, "apps", "gateway"), { recursive: true });
    writeFileSync(join(d, "apps", "gateway", "package.json"), "{}");
    process.env.GENIE_SENSE_REPOS_TTL_MS = "0";
    expect(await detectWorkspaceRepos(d)).toEqual([]);
  });

  it("非 git 工作区:package.json 子目录仍按子仓发现(旧行为保留)", async () => {
    const d = mk();
    mkdirSync(join(d, "genie-voice"), { recursive: true });
    writeFileSync(join(d, "genie-voice", "package.json"), "{}");
    process.env.GENIE_SENSE_REPOS_TTL_MS = "0";
    const repos = await detectWorkspaceRepos(d);
    expect(repos.map((r) => r.name)).toContain("genie-voice");
  });
});
