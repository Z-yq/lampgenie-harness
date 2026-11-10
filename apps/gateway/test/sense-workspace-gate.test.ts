/**
 * 巨根治理单测:预算闸接全自动路径 + 工作区收窄。
 * 背景:结构面 action=impact 曾绕过闸直通 ensureIndex → risk 档采样重建(5160 文件)压垮 9p
 * (收割 ×2 + 网关停顿 90s)。新语义:超预算根自动路径一律不扫不建;工作区根给收窄出路
 * (显式 root 参数 / target 前缀自动收窄 / symbol·impact 已索引子仓扇出)。拒绝必须带路。
 */
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectWorkspaceRepos, refineRootForTarget, workspaceRefusalText, reposMemo,
} from "../src/sense-root-gate.js";
import { dispatchSenseArgs } from "../src/sense-tool.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";

// env 互斥( flake 修复):本文件多处在测压低 GENIE_SENSE_* 阈值;threads pool 共享
// process.env,与 orient-budget-gate 合跑时其 afterEach 删 env 会把本文件的阈值中途拆掉
// (经验证:阈值失效→工作区根被放行→走直查分支→断言「根已自动收窄」拿到「尚未就绪」)。
beforeAll(async () => { await acquireEnvLock("orient-gate"); }, 240_000);
afterAll(() => { releaseEnvLock("orient-gate"); });

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-wsgate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个工作区根:两个子仓(带标记文件)+ 一个普通目录。 */
function workspace(): string {
  const root = tmp();
  mkdirSync(join(root, "repoA", "src"), { recursive: true });
  writeFileSync(join(root, "repoA", "package.json"), JSON.stringify({ name: "a", description: "A 仓:测试用" }));
  writeFileSync(join(root, "repoA", "src", "a.ts"), "export function fa() { return 1; }\n");
  mkdirSync(join(root, "repoB"), { recursive: true });
  writeFileSync(join(root, "repoB", "pyproject.toml"), '[project]\nname = "b"\ndescription = "B 仓:py"\n');
  writeFileSync(join(root, "repoB", "b.py"), "def fb():\n    return 2\n");
  mkdirSync(join(root, "plain"), { recursive: true });
  writeFileSync(join(root, "plain", "x.txt"), "not a repo\n");
  return root;
}

describe("detectWorkspaceRepos 子仓探测", () => {
  // TTL 缓存不得影响断言(用例中途翻转 indexed):压 0 强制每次重算
  beforeEach(() => { process.env.GENIE_SENSE_REPOS_TTL_MS = "0"; });
  afterEach(() => { delete process.env.GENIE_SENSE_REPOS_TTL_MS; });
  it("只认带仓标记的直接子目录;描述从 package.json/pyproject 取;indexed 按 .genie/sense-index 判", async () => {
    const root = workspace();
    const repos = await detectWorkspaceRepos(root);
    expect(repos.map((r) => r.name)).toEqual(["repoA", "repoB"]);
    expect(repos[0]!.description).toContain("A 仓");
    expect(repos[1]!.description).toContain("B 仓");
    expect(repos[0]!.indexed).toBe(false);
    mkdirSync(join(root, "repoA", ".genie", "sense-index"), { recursive: true });
    expect((await detectWorkspaceRepos(root))[0]!.indexed).toBe(true);
  });
  it("空目录/不存在=空清单(不抛)", async () => {
    expect(await detectWorkspaceRepos(join(tmp(), "nope"))).toEqual([]);
  });
  it("两层深子仓(pnpm monorepo 的 apps/与 packages/ 下)能被探测(2026-11-02 下探修复)", async () => {
    const root = tmp();
    mkdirSync(join(root, "apps", "gateway"), { recursive: true });
    writeFileSync(join(root, "apps", "gateway", "package.json"), "{}");
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "package.json"), "{}");
    mkdirSync(join(root, "node_modules", "fake"), { recursive: true });
    writeFileSync(join(root, "node_modules", "fake", "package.json"), "{}"); // 重目录不下探
    const repos = await detectWorkspaceRepos(root);
    expect(repos.map((r) => r.name)).toEqual(["apps/gateway", "packages/core"]);
  });
});

describe("detectWorkspaceRepos TTL 缓存(2026-11-04)", () => {
  afterEach(() => {
    // memo 只清 tmp 测试根,真实仓根缓存不动
    for (const k of [...reposMemo.keys()]) if (k.startsWith(tmpdir())) reposMemo.delete(k);
  });
  it("TTL 内复用(不重扫);过期/压 0 后重算出新清单", async () => {
    process.env.GENIE_SENSE_REPOS_TTL_MS = "60000";
    try {
      const root = tmp();
      mkdirSync(join(root, "r1"), { recursive: true });
      writeFileSync(join(root, "r1", "package.json"), "{}");
      expect((await detectWorkspaceRepos(root)).map((r) => r.name)).toEqual(["r1"]);
      mkdirSync(join(root, "r2"), { recursive: true }); // 新增子仓:TTL 内不可见(缓存复用)
      writeFileSync(join(root, "r2", "package.json"), "{}");
      expect((await detectWorkspaceRepos(root)).map((r) => r.name)).toEqual(["r1"]);
      process.env.GENIE_SENSE_REPOS_TTL_MS = "0"; // 强制重算
      expect((await detectWorkspaceRepos(root)).map((r) => r.name)).toEqual(["r1", "r2"]);
    } finally {
      delete process.env.GENIE_SENSE_REPOS_TTL_MS;
    }
  });
  it("memo 按根隔离:不同根各回各清单,路径不串", async () => {
    const a = workspace();
    const b = workspace();
    expect((await detectWorkspaceRepos(a)).map((r) => r.name)).toEqual(["repoA", "repoB"]);
    expect((await detectWorkspaceRepos(b)).map((r) => r.name)).toEqual(["repoA", "repoB"]);
    expect((await detectWorkspaceRepos(a))[0]!.path).toBe(join(a, "repoA"));
    expect((await detectWorkspaceRepos(b))[0]!.path).toBe(join(b, "repoA"));
  });
});

describe("refineRootForTarget 路径收窄", () => {
  it("相对路径带子仓名前缀(含恰为子仓名)→收窄;绝对路径落在子仓内→收窄", async () => {
    const root = workspace();
    const repos = await detectWorkspaceRepos(root);
    expect(refineRootForTarget(root, repos, "repoA/src/a.ts")).toBe(join(root, "repoA"));
    expect(refineRootForTarget(root, repos, "repoA")).toBe(join(root, "repoA"));
    expect(refineRootForTarget(root, repos, join(root, "repoB", "b.py"))).toBe(join(root, "repoB"));
  });
  it("不带前缀/越界/其它仓路径=不收(null)", async () => {
    const root = workspace();
    const repos = await detectWorkspaceRepos(root);
    expect(refineRootForTarget(root, repos, "src/a.ts")).toBeNull();
    expect(refineRootForTarget(root, repos, "../etc")).toBeNull();
    expect(refineRootForTarget(root, repos, "plain/x.txt")).toBeNull();
  });
});

describe("workspaceRefusalText 拒绝必须带路", () => {
  it("工作区根:含子仓清单+三条出路;单一巨仓:含 CLI 显式构建指引", async () => {
    const root = workspace();
    const repos = await detectWorkspaceRepos(root);
    const v = { ok: false, files: 5000, bytesMb: 4123, reason: "文件数达上限 5000" };
    const txt = workspaceRefusalText(root, v, repos, "建索引");
    expect(txt).toContain("repoA");
    expect(txt).toContain('root="repoA"');
    expect(txt).toContain("自动收窄");
    expect(txt).toContain("扇出");
    const single = workspaceRefusalText(root, v, [], "扫描");
    expect(single).toContain("codesense index");
    expect(single).toContain("GENIE_SENSE_ORIENT_MAX_FILES");
  });
});

describe("dispatchSenseArgs root 参数", () => {
  it("root 解析进 structural/semantic;空白=undefined(旧调用零影响)", () => {
    const a = dispatchSenseArgs({ action: "impact", target: "fa", root: "repoA" });
    expect(a).toMatchObject({ kind: "structural", rootOverride: "repoA" });
    const m = dispatchSenseArgs({ mode: "debug", query: "fa", root: "repoB" });
    expect(m).toMatchObject({ kind: "semantic", rootOverride: "repoB" });
    const plain = dispatchSenseArgs({ action: "impact", target: "fa" });
    expect(plain).not.toHaveProperty("rootOverride");
    expect(dispatchSenseArgs({ action: "impact", target: "fa", root: "  " })).not.toHaveProperty("rootOverride");
  });
});

describe("codeSenseTool 巨根分流(端到端,env 压低阈值造超预算)", () => {
  it("工作区根上 file 带 repoA 前缀→自动收窄到 repoA 执行(不再拒绝)", async () => {
    process.env.GENIE_SENSE_ORIENT_MAX_FILES = "2"; // 压低:工作区根 2 源文件(a.ts+b.py)必超;repoA 1 源文件放行(非源码不计费)
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    try {
      const root = workspace();
      const { codeSenseTool } = await import("../src/sense-tool.js");
      const out = String(await codeSenseTool(root).execute({ action: "file", target: "repoA/src/a.ts" }));
      expect(out).toContain("根已自动收窄→repoA");
      expect(out).not.toContain("已拒绝"); // 收窄成功=不再拒
    } finally {
      delete process.env.GENIE_SENSE_ORIENT_MAX_FILES;
      delete process.env.GENIE_SENSE_GATE_TTL_MS;
    }
  }, 30_000);

  it("工作区根上裸 symbol→已索引子仓扇出+未索引子仓点名(不触发整根构建)", async () => {
    process.env.GENIE_SENSE_ORIENT_MAX_FILES = "2";
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    try {
      const root = workspace();
      // repoA 造一个真实盘上索引(单 ts 文件,buildC2fIndex 毫秒~秒级;saveIndex 落 .genie/sense-index/<hash>)
      const { buildC2fIndex, saveIndex } = await import("@lampgenie/code-sense/callgraph/c2f");
      saveIndex(join(root, "repoA"), buildC2fIndex(join(root, "repoA")));
      const { codeSenseTool } = await import("../src/sense-tool.js");
      const out = String(await codeSenseTool(root).execute({ action: "symbol", target: "fa" }));
      expect(out).toContain("工作区扇出");
      expect(out).toContain("repoA");
      expect(out).toContain("repoB"); // 未索引子仓如实点名
      expect(out).not.toContain("后台进行中"); // 绝不谎称「后台构建中」
    } finally {
      delete process.env.GENIE_SENSE_ORIENT_MAX_FILES;
      delete process.env.GENIE_SENSE_GATE_TTL_MS;
    }
  }, 30_000);

  it("ensureIndex 对超预算根拒绝(不 fork);codeIndexQuery 回工作区指引而非「后台进行中」", async () => {
    process.env.GENIE_SENSE_ORIENT_MAX_FILES = "2";
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    try {
      const root = workspace();
      const sm = await import("../src/sense-index-manager.js");
      await expect(sm.ensureIndex(root)).rejects.toThrow("预算闸拒绝");
      const q = await sm.codeIndexQuery(root, "entrypoints", "");
      expect(q).toContain("多仓工作区"); // 拒绝带路,不是「尚未就绪/后台构建中」
      expect(q).toContain("repoA");
    } finally {
      delete process.env.GENIE_SENSE_ORIENT_MAX_FILES;
      delete process.env.GENIE_SENSE_GATE_TTL_MS;
    }
  }, 30_000);

  it("root 参数显式收窄到子仓:小根放行正常执行", async () => {
    process.env.GENIE_SENSE_GATE_TTL_MS = "0";
    try {
      const root = workspace();
      const { codeSenseTool } = await import("../src/sense-tool.js");
      const out = String(await codeSenseTool(root).execute({ action: "file", target: "src/a.ts", root: "repoA" }));
      expect(out).toContain("根已收窄→repoA");
      // 子仓小根:不再有拒绝话术;文件符号表语义(fa 在场或「无索引符号」都是子仓根的真实回答)
      expect(out).not.toContain("已拒绝");
    } finally {
      delete process.env.GENIE_SENSE_GATE_TTL_MS;
    }
  }, 30_000); // 9p 慢盘合跑负载下 5s 默认盒贴线翻车(2026-11-04 实测 5015ms);与同类 e2e 对齐显式盒

  it("root 越界/不存在:确定性纠偏,不静默忽略", async () => {
    const root = workspace();
    const { codeSenseTool } = await import("../src/sense-tool.js");
    const esc = String(await codeSenseTool(root).execute({ action: "file", target: "src/a.ts", root: "../../etc" }));
    expect(esc).toContain("工作区之外");
    const missing = String(await codeSenseTool(root).execute({ action: "file", target: "src/a.ts", root: "no-such-repo" }));
    expect(missing).toContain("不存在");
  });
});
