/**
 * arch-policy(架构策略门)单测:全部用 mkdtemp 临时仓夹具,不依赖本仓真实 .genie/arch-policy.json。
 * 覆盖:
 * ①入座(unmanaged-new-file):同 package 内但不属于任何 module root 的新文件 → 违规;managed root 内新文件 → 干净;
 * ②跨层(cross-layer-import):layer 白名单 / module.allowImport 两条放行口径;目标不在任何 module 内不报;
 * ③深导入(deep-import):绕过 module.entry 的内部文件 → 违规,命中 entry → 干净;
 * ④例外:rule+files 命中即豁免;expires < today 不豁免且进 expiredExceptions;
 * ⑤policy 校验:errors 带路径(缺 owner / 缺 expires / 未知键 / 类型错),坏 policy → CLI code 3;
 * ⑥baseline ratchet:首跑 2 → --update 0 落盘 → 复跑 0 且 baselined>0 → 新增违规 2 → detail 变化视为新违规 2;
 * ⑦--changed:--base 只查变更文件(未变更的旧违规不报);无 upstream 且无 --base → 降级全量 + fallback-full-scan note;
 * ⑧exit 码:干净 0 / 新鲜违规 2 / 无 policy 0(+no-policy note)/ 显式 --policy 缺失 3。
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fingerprint,
  loadBaselineFile,
  parsePolicy,
  runCli,
  scanPolicy,
} from "../src/arch-policy.ts";
import type { CliReport, Policy } from "../src/arch-policy.ts";

// ---------------------------------------------------------------- 临时仓夹具

const dirs: string[] = [];

function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "arch-policy-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFile(repo: string, rel: string, content: string): string {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

function writeJson(repo: string, rel: string, value: unknown): string {
  return writeFile(repo, rel, `${JSON.stringify(value, null, 2)}\n`);
}

/** 每个夹具自带 package.json,确保「package 作用域」(scopeRoots 来自 module root 最近的 package.json)生效。 */
function writePkg(repo: string, dir: string, name: string): void {
  writeJson(repo, `${dir}/package.json`, { name, version: "0.0.0", private: true });
}

function mkPolicy(raw: unknown): Policy {
  const { policy, errors } = parsePolicy(raw);
  if (!policy) throw new Error(`夹具 policy 不合法:${JSON.stringify(errors)}`);
  return policy;
}

interface PairOpts {
  layers?: unknown;
  appExtra?: Record<string, unknown>;
  libExtra?: Record<string, unknown>;
  exceptions?: unknown[];
  ignore?: string[];
}

/** 两模块(app→pkg)基础 policy:默认 app 只许 import app,即 app→lib 是跨层违规。 */
function pairPolicy(o: PairOpts = {}): unknown {
  return {
    version: 1,
    layers: o.layers ?? [
      { name: "app", mayImport: ["app"] },
      { name: "pkg", mayImport: [] },
    ],
    modules: [
      { id: "app", root: "apps/app/src", layer: "app", managed: true, ...(o.appExtra ?? {}) },
      { id: "lib", root: "pkgs/lib/src", layer: "pkg", managed: true, ...(o.libExtra ?? {}) },
    ],
    exceptions: o.exceptions ?? [],
    ...(o.ignore ? { ignore: o.ignore } : {}),
  };
}

/** app(pkg 层 lib)二模块临时仓,主文件无 import。 */
function appLibRepo(): string {
  const repo = makeRepo();
  writePkg(repo, "apps/app", "@t/app");
  writePkg(repo, "pkgs/lib", "@t/lib");
  writeFile(repo, "apps/app/src/main.ts", "export const app = 1;\n");
  writeFile(repo, "pkgs/lib/src/index.ts", "export const libValue = 1;\n");
  return repo;
}

const CROSS_LAYER_FILE = 'import { libValue } from "@t/lib";\nexport const v = libValue;\n';

// ---------------------------------------------------------------- ① 入座

describe("arch-policy 判据", () => {
  it("未入座新文件报 unmanaged-new-file,managed root 内新文件不报", () => {
    const repo = appLibRepo();
    // 同 package(apps/app)内、但不在任何 module root(apps/app/src)下的新文件
    writeFile(repo, "apps/app/scripts/loose.ts", "export const loose = 1;\n");
    // managed root 内的新文件:正常入座
    writeFile(repo, "apps/app/src/fresh.ts", "export const fresh = 1;\n");
    const policy = mkPolicy(pairPolicy());

    const res = scanPolicy({
      repoRoot: repo,
      policy,
      untracked: ["apps/app/scripts/loose.ts", "apps/app/src/fresh.ts"],
      today: "2026-01-01",
    });
    expect(res.violations.map((v) => [v.rule, v.file])).toEqual([
      ["unmanaged-new-file", "apps/app/scripts/loose.ts"],
    ]);
    expect(res.violations[0]?.message).toContain("not seated in any module root");
    expect(res.violations[0]?.hash).toBe(
      fingerprint("unmanaged-new-file", "apps/app/scripts/loose.ts", res.violations[0]!.detail),
    );

    // 无 git 信号:无法区分存量/新增,保守地把 module 所在 package 内全部源文件当候选 → 松散文件被报出
    const full = scanPolicy({ repoRoot: repo, policy, today: "2026-01-01" });
    expect(full.violations.map((v) => [v.rule, v.file])).toEqual([["unmanaged-new-file", "apps/app/scripts/loose.ts"]]);
    expect(full.checkedFiles).toEqual([
      "apps/app/src/fresh.ts",
      "apps/app/src/main.ts",
      "pkgs/lib/src/index.ts",
    ]);
    expect(full.notes).toContain("unmanaged-detection-degraded:no-git(all-scope-files)");
  });

  // ---------------------------------------------------------------- ② 跨层

  it("跨层导入按 layer/allowImport 判定,范围外目标不报", () => {
    const repo = appLibRepo();
    writeFile(repo, "apps/app/src/main.ts", CROSS_LAYER_FILE);
    // 不在任何 module root 内的包:它的文件不属于本门禁,导入它不产生违规
    writePkg(repo, "pkgs/core", "@t/core");
    writeFile(repo, "pkgs/core/src/index.ts", "export const coreValue = 1;\n");
    writeFile(
      repo,
      "apps/app/src/uses-core.ts",
      'import { coreValue } from "../../../pkgs/core/src/index.ts";\nexport const c = coreValue;\n',
    );

    const strict = scanPolicy({ repoRoot: repo, policy: mkPolicy(pairPolicy()), today: "2026-01-01" });
    expect(strict.violations.map((v) => ({ rule: v.rule, file: v.file, detail: v.detail }))).toEqual([
      {
        rule: "cross-layer-import",
        file: "apps/app/src/main.ts",
        detail: "layer app may not import pkg: app -> lib",
      },
    ]);
    expect(strict.checkedFiles).toContain("apps/app/src/uses-core.ts");
    expect(strict.violations.some((v) => v.file === "apps/app/src/uses-core.ts")).toBe(false);

    // layer 白名单放行
    const relaxedLayers = mkPolicy(
      pairPolicy({
        layers: [
          { name: "app", mayImport: ["app", "pkg"] },
          { name: "pkg", mayImport: [] },
        ],
      }),
    );
    expect(scanPolicy({ repoRoot: repo, policy: relaxedLayers, today: "2026-01-01" }).violations).toEqual([]);

    // module.allowImport 显式放行(即使 layer 不允许):按 module id / 按 layer 名都算
    const allowById = mkPolicy(pairPolicy({ appExtra: { allowImport: ["lib"] } }));
    expect(scanPolicy({ repoRoot: repo, policy: allowById, today: "2026-01-01" }).violations).toEqual([]);
    const allowByLayer = mkPolicy(pairPolicy({ appExtra: { allowImport: ["pkg"] } }));
    expect(scanPolicy({ repoRoot: repo, policy: allowByLayer, today: "2026-01-01" }).violations).toEqual([]);
  });

  // ---------------------------------------------------------------- ③ 深导入

  it("深导入:绕过 module.entry 的内部文件报 deep-import,命中 entry 不报", () => {
    const repo = appLibRepo();
    writeFile(repo, "pkgs/lib/src/internal.ts", "export const internalValue = 1;\n");
    writeFile(
      repo,
      "apps/app/src/main.ts",
      'import { internalValue } from "@t/lib/internal";\nexport const v = internalValue;\n',
    );
    writeFile(
      repo,
      "apps/app/src/via-entry.ts",
      'import { libValue } from "@t/lib";\nexport const v = libValue;\n',
    );
    const policy = mkPolicy(
      pairPolicy({
        // 跨层放行 pkg,只留深导入一条判据
        layers: [
          { name: "app", mayImport: ["app", "pkg"] },
          { name: "pkg", mayImport: [] },
        ],
        libExtra: { entry: "pkgs/lib/src/index.ts" },
      }),
    );

    const res = scanPolicy({ repoRoot: repo, policy, today: "2026-01-01" });
    expect(res.violations.map((v) => [v.rule, v.file])).toEqual([["deep-import", "apps/app/src/main.ts"]]);
    expect(res.violations[0]?.detail).toBe("deep import into lib bypasses entry pkgs/lib/src/index.ts");
    expect(res.violations[0]?.line).toBe(1);
    // 正好 import entry 的文件不报
    expect(res.checkedFiles).toContain("apps/app/src/via-entry.ts");
  });

  // ---------------------------------------------------------------- ④ 例外

  it("例外:有效例外豁免违规,过期例外不豁免并进 expiredExceptions", () => {
    const repo = appLibRepo();
    writeFile(repo, "apps/app/src/main.ts", CROSS_LAYER_FILE);
    const exception = {
      id: "ex-1",
      rule: "cross-layer-import",
      files: ["apps/app/src/**"],
      reason: "迁移期临时放行",
      owner: "arch-team",
      expires: "2099-12-31",
    };

    const active = scanPolicy({
      repoRoot: repo,
      policy: mkPolicy(pairPolicy({ exceptions: [exception] })),
      today: "2026-01-01",
    });
    expect(active.violations).toEqual([]);
    expect(active.exempted.map((e) => [e.rule, e.file, e.exceptionId])).toEqual([
      ["cross-layer-import", "apps/app/src/main.ts", "ex-1"],
    ]);
    expect(active.expiredExceptions).toEqual([]);

    const expired = scanPolicy({
      repoRoot: repo,
      policy: mkPolicy(pairPolicy({ exceptions: [{ ...exception, expires: "2020-01-01" }] })),
      today: "2026-01-01",
    });
    expect(expired.violations.map((v) => v.rule)).toEqual(["cross-layer-import"]);
    expect(expired.exempted).toEqual([]);
    expect(expired.expiredExceptions.map((e) => e.id)).toEqual(["ex-1"]);
  });
});

// ---------------------------------------------------------------- ⑤ policy 校验

describe("policy 校验", () => {
  const layers = [{ name: "app", mayImport: [] }];
  const moduleOk = { id: "app", root: "apps/app/src", layer: "app", managed: true };

  it("缺 owner/缺 expires/未知键/类型错都带路径,坏 policy 让 CLI 返回 3", () => {
    const missingOwner = parsePolicy({
      version: 1,
      layers,
      modules: [moduleOk],
      exceptions: [{ id: "e1", rule: "deep-import", reason: "临时放行理由", expires: "2099-01-01" }],
    });
    expect(missingOwner.policy).toBeUndefined();
    expect(missingOwner.errors.map((e) => e.path)).toContain("policy.exceptions[0].owner");

    const missingExpires = parsePolicy({
      version: 1,
      layers,
      modules: [moduleOk],
      exceptions: [{ id: "e1", rule: "deep-import", reason: "临时放行理由", owner: "arch-team" }],
    });
    expect(missingExpires.errors.map((e) => e.path)).toContain("policy.exceptions[0].expires");

    const unknownKey = parsePolicy({
      version: 1,
      layers,
      modules: [{ ...moduleOk, seat: "legacy" }],
      exceptions: [],
    });
    expect(unknownKey.errors.map((e) => e.path)).toContain("policy.modules[0].seat");

    const badType = parsePolicy({
      version: 1,
      layers,
      modules: [{ ...moduleOk, managed: "yes" }],
      exceptions: [],
    });
    expect(badType.errors.map((e) => e.path)).toContain("policy.modules[0].managed");
    expect(badType.policy).toBeUndefined();

    // CLI:默认路径存在但 JSON 坏 → 3
    const brokenJson = makeRepo();
    writeFile(brokenJson, ".genie/arch-policy.json", "{ 这不是 JSON ");
    const badJsonRun = runCli(["--check"], brokenJson);
    expect(badJsonRun.code).toBe(3);
    expect(badJsonRun.output).toContain("JSON 解析失败");

    // CLI:显式 --policy 指向「结构非法」的 policy → 3 且 report.notes 带 policy-error
    const brokenShape = makeRepo();
    writeJson(brokenShape, "broken/policy.json", {
      version: 1,
      layers,
      modules: [{ ...moduleOk, managed: "yes" }],
      exceptions: [],
    });
    const badShapeRun = runCli(["--check", "--policy", "broken/policy.json"], brokenShape);
    expect(badShapeRun.code).toBe(3);
    expect(badShapeRun.report?.notes).toContain("policy-error");
    expect(badShapeRun.errors?.map((e) => e.path)).toContain("policy.modules[0].managed");
  });
});

// ---------------------------------------------------------------- ⑥ baseline ratchet

describe("baseline ratchet", () => {
  it("首跑 2、update 落盘、复跑 0、新增违规 2、detail 变化视为新违规", () => {
    const repo = appLibRepo();
    writePkg(repo, "pkgs/core", "@t/core");
    writeFile(repo, "pkgs/core/src/index.ts", "export const coreValue = 1;\n");
    writePkg(repo, "pkgs/tool", "@t/tool");
    writeFile(repo, "pkgs/tool/src/index.ts", "export const toolValue = 1;\n");
    writeFile(repo, "apps/app/src/main.ts", CROSS_LAYER_FILE);
    writeJson(repo, ".genie/arch-policy.json", {
      version: 1,
      layers: [
        { name: "app", mayImport: ["app"] },
        { name: "pkg", mayImport: [] },
        { name: "tools", mayImport: [] },
      ],
      modules: [
        { id: "app", root: "apps/app/src", layer: "app", managed: true },
        { id: "lib", root: "pkgs/lib/src", layer: "pkg", managed: true },
        { id: "core", root: "pkgs/core/src", layer: "pkg", managed: true },
        { id: "tool", root: "pkgs/tool/src", layer: "tools", managed: true },
      ],
      exceptions: [],
    });

    // ① 首跑:无 baseline → 全部是新违规 → 2
    const first = runCli(["--check", "--json"], repo);
    expect(first.code).toBe(2);
    const firstReport = JSON.parse(first.output) as CliReport;
    expect(Object.keys(firstReport).sort()).toEqual([
      "baselined",
      "checkedFiles",
      "expiredExceptions",
      "notes",
      "ok",
      "policy",
      "violations",
    ]);
    expect(firstReport.ok).toBe(false);
    expect(firstReport.violations.map((v) => [v.rule, v.file])).toEqual([
      ["cross-layer-import", "apps/app/src/main.ts"],
    ]);
    expect(firstReport.baselined).toBe(0);
    expect(firstReport.notes).toContain("baseline-missing");

    // ② --update:落盘 baseline,exit 0
    const update = runCli(["--update"], repo);
    expect(update.code).toBe(0);
    expect(update.output).toContain("baseline 已写入");
    const baselinePath = join(repo, ".genie", "arch-policy-baseline.json");
    expect(existsSync(baselinePath)).toBe(true);
    const loadedBaseline = loadBaselineFile(baselinePath);
    expect(loadedBaseline.error).toBeUndefined();
    expect(loadedBaseline.baseline?.entries.length).toBe(1);
    expect(loadedBaseline.baseline?.entries[0]?.detailHash).toBe(
      fingerprint("cross-layer-import", "apps/app/src/main.ts", firstReport.violations[0]!.detail),
    );

    // ③ 复跑:已知违规被 ratchet 掉 → 0 且 baselined>0
    const second = runCli(["--check", "--json"], repo);
    expect(second.code).toBe(0);
    const secondReport = JSON.parse(second.output) as CliReport;
    expect(secondReport.ok).toBe(true);
    expect(secondReport.violations).toEqual([]);
    expect(secondReport.baselined).toBeGreaterThan(0);

    // ④ 新增一条违规(新文件导入另一层) → 2,只有新的这条 fresh
    writeFile(repo, "apps/app/src/second.ts", 'import { coreValue } from "@t/core";\nexport const s = coreValue;\n');
    const third = runCli(["--check", "--json"], repo);
    expect(third.code).toBe(2);
    const thirdReport = JSON.parse(third.output) as CliReport;
    expect(thirdReport.violations.map((v) => v.file)).toEqual(["apps/app/src/second.ts"]);
    expect(thirdReport.baselined).toBe(1);

    // 先把这个新增违规也收编进 baseline,确保后面只观察「detail 变化」这一条
    expect(runCli(["--update"], repo).code).toBe(0);
    expect(runCli(["--check", "--json"], repo).code).toBe(0);
    const adopted = loadBaselineFile(baselinePath);
    expect(adopted.baseline?.entries.length).toBe(2);
    const knownHashes = new Set((adopted.baseline?.entries ?? []).map((e) => e.detailHash));

    // ⑤ 改动违规所在文件,使 detail 变(跨层目标换成 tools 层)→ 指纹变 → 视为新违规 → 2
    writeFile(repo, "apps/app/src/main.ts", 'import { toolValue } from "@t/tool";\nexport const v = toolValue;\n');
    const fourth = runCli(["--check", "--json"], repo);
    expect(fourth.code).toBe(2);
    const fourthReport = JSON.parse(fourth.output) as CliReport;
    expect(fourthReport.violations.map((v) => v.file)).toEqual(["apps/app/src/main.ts"]);
    expect(fourthReport.violations[0]?.detail).toBe("layer app may not import tools: app -> tool");
    expect(knownHashes.has(fourthReport.violations[0]!.hash)).toBe(false);
    // second.ts 仍在基线内,被 ratchet
    expect(fourthReport.baselined).toBe(1);
  });
});

// ---------------------------------------------------------------- ⑦ --changed

const gitAvailable = ((): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function gitRun(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitAll(repo: string, message: string): string {
  gitRun(repo, ["add", "-A"]);
  gitRun(repo, [
    "-c",
    "user.email=arch-policy@test.local",
    "-c",
    "user.name=arch-policy-test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
  return gitRun(repo, ["rev-parse", "HEAD"]);
}

describe("--changed", () => {
  it.skipIf(!gitAvailable)("--base 只查变更文件,无 upstream 且无 --base 降级全量并记 note", () => {
    const repo = appLibRepo();
    writePkg(repo, "pkgs/core", "@t/core");
    writeFile(repo, "pkgs/core/src/index.ts", "export const coreValue = 1;\n");
    writeJson(repo, ".genie/arch-policy.json", {
      version: 1,
      layers: [
        { name: "app", mayImport: ["app"] },
        { name: "pkg", mayImport: [] },
      ],
      modules: [
        { id: "app", root: "apps/app/src", layer: "app", managed: true },
        { id: "lib", root: "pkgs/lib/src", layer: "pkg", managed: true },
        { id: "core", root: "pkgs/core/src", layer: "pkg", managed: true },
      ],
      exceptions: [],
    });

    // 提交 1:已存在一条「旧违规」(之后不再改动)
    writeFile(repo, "apps/app/src/old.ts", CROSS_LAYER_FILE);
    gitRun(repo, ["init", "-q"]);
    const firstSha = commitAll(repo, "c1: 旧违规落地");

    // 提交 2:新增一个同样违规的文件(本次变更)
    writeFile(repo, "apps/app/src/new.ts", CROSS_LAYER_FILE);
    commitAll(repo, "c2: 新增变更文件");

    // 只查变更文件:旧违规(未变更)不报
    const changed = runCli(["--changed", "--base", firstSha, "--json"], repo);
    expect(changed.code).toBe(2);
    const changedReport = JSON.parse(changed.output) as CliReport;
    expect(changedReport.checkedFiles).toBe(1);
    expect(changedReport.violations.map((v) => v.file)).toEqual(["apps/app/src/new.ts"]);
    expect(changedReport.notes).toContain(`changed-base:${firstSha}`);
    expect(changedReport.notes).toContain("changed-files:1");

    // 对照:全量检查两条都在(证明 --changed 确实缩小了范围)
    const full = runCli(["--check", "--json"], repo);
    expect(full.code).toBe(2);
    const fullReport = JSON.parse(full.output) as CliReport;
    expect(fullReport.violations.map((v) => v.file)).toEqual([
      "apps/app/src/new.ts",
      "apps/app/src/old.ts",
    ]);

    // 无 upstream 且不给 --base → 降级全量 + note 明说
    const fallback = runCli(["--changed", "--json"], repo);
    const fallbackReport = JSON.parse(fallback.output) as CliReport;
    expect(fallbackReport.notes.some((n) => n.includes("fallback-full-scan"))).toBe(true);
    expect(fallbackReport.violations.map((v) => v.file)).toEqual([
      "apps/app/src/new.ts",
      "apps/app/src/old.ts",
    ]);
    expect(fallbackReport.checkedFiles).toBe(fullReport.checkedFiles);
  });
});

// ---------------------------------------------------------------- ⑨ module.root glob

describe("module.root glob", () => {
  it("glob root 展开后覆盖其下文件,glob 之外的新文件仍报未入座", () => {
    const repo = makeRepo();
    writePkg(repo, "pkgs/a", "@t/a");
    writeFile(repo, "pkgs/a/src/index.ts", "export const a = 1;\n");
    writeFile(repo, "pkgs/a/src/extra.ts", "export const b = 2;\n");
    writeFile(repo, "pkgs/a/stray.ts", "export const c = 3;\n");
    const policy = mkPolicy({
      version: 1,
      layers: [{ name: "pkg", mayImport: ["pkg"] }],
      modules: [{ id: "pkgs", root: "pkgs/*/src", layer: "pkg", managed: true }],
      exceptions: [],
    });
    const res = scanPolicy({
      repoRoot: repo,
      policy,
      untracked: ["pkgs/a/src/extra.ts", "pkgs/a/stray.ts"],
      today: "2026-11-08",
    });
    expect(res.checkedFiles).toEqual(["pkgs/a/src/extra.ts", "pkgs/a/src/index.ts"]);
    expect(res.violations.map((v) => [v.rule, v.file])).toEqual([["unmanaged-new-file", "pkgs/a/stray.ts"]]);
  });
});

// ---------------------------------------------------------------- ⑧ exit 码

describe("exit 码", () => {
  it("干净 0、新鲜违规 2、无 policy 0 且 note no-policy、显式 --policy 缺失 3", () => {
    const clean = appLibRepo();
    writeJson(clean, ".genie/arch-policy.json", pairPolicy());
    const cleanRun = runCli(["--check"], clean);
    expect(cleanRun.code).toBe(0);
    expect(cleanRun.output).toContain("OK");

    const dirty = appLibRepo();
    writeJson(dirty, ".genie/arch-policy.json", pairPolicy());
    writeFile(dirty, "apps/app/src/main.ts", CROSS_LAYER_FILE);
    expect(runCli(["--check"], dirty).code).toBe(2);

    // 未采用架构策略门:没有 .genie/arch-policy.json 且未显式 --policy → 0 + no-policy note
    const bare = appLibRepo();
    const noPolicy = runCli(["--check", "--json"], bare);
    expect(noPolicy.code).toBe(0);
    const noPolicyReport = JSON.parse(noPolicy.output) as CliReport;
    expect(noPolicyReport.ok).toBe(true);
    expect(noPolicyReport.notes).toContain("no-policy");

    // 显式指定了一个不存在的 policy:不再当「未采用」放过 → 3
    const missing = runCli(["--check", "--policy", "missing.json"], bare);
    expect(missing.code).toBe(3);
    expect(missing.report?.notes).toContain("policy-error");
    const missingJson = runCli(["--check", "--policy", "missing.json", "--json"], bare);
    expect(missingJson.code).toBe(3);
    const missingReport = JSON.parse(missingJson.output) as CliReport & { errors?: { path: string }[] };
    expect(missingReport.ok).toBe(false);
    expect(missingReport.errors?.[0]?.path).toContain("missing.json");
  });
});
