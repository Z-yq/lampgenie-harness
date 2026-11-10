/**
 * 语义功能影响边界 store + CLI:采集 / 形状容错 / 采纳落盘 / drift 聚合 / 报告 / 退出码。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FB_STORE_CODES,
  acceptSemantics,
  boundaryStatePath,
  collectBrief,
  listDrift,
  report,
} from "../src/feature-boundary-store";

const tempDirs: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "genie-feature-boundary-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const FEATURE_ID = "feat-share-panel";
// 夹具刻意做成「共享组件 + 缺 owner 表面 + depth1/depth2 混合」:
// 入口/写流/codeRef 三层证据都齐(must 不缺证),但 surface 缺 authoritativeOwner → drift;
// ui-orphan 没有任何 code 候选 owner + 有 submit → unresolvedOwners + depth3Required。
const FEATURE = {
  id: FEATURE_ID,
  name: "共享面板",
  entries: ["share-panel"],
  dataFlows: [{ from: "share-panel", to: "share-store", kind: "write" as const }],
};
const SURFACES = [
  {
    id: "ui-panel",
    name: "面板页",
    featureId: FEATURE_ID,
    steps: { draft: "share-panel", validate: "share-panel", submit: "share-store" },
  },
  { id: "ui-orphan", name: "孤儿页", featureId: FEATURE_ID, steps: { submit: "orphan-submit" } },
];
const CODE_REFS = [
  { id: "share-panel", module: "share-panel", file: "apps/gateway/src/share-panel.ts", symbol: "SharePanel", depth: 1 as const },
  { id: "share-store", module: "share-store", file: "apps/gateway/src/share-store.ts", symbol: "ShareStore", depth: 2 as const },
];

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
  return path;
}

/** 一份完整可采集的输入集(返回 CollectBriefOpts 形状 + 根目录)。 */
function fixtures(over: { feature?: unknown; surfaces?: unknown; code?: unknown } = {}): {
  root: string;
  opts: { featureFile: string; surfacesFile: string; codeFile: string };
} {
  const root = tmpRoot();
  const featureFile = writeJson(root, "feature.json", over.feature ?? FEATURE);
  const surfacesFile = writeJson(root, "surfaces.json", over.surfaces ?? SURFACES);
  const codeFile = writeJson(root, "code.json", over.code ?? CODE_REFS);
  return { root, opts: { featureFile, surfacesFile, codeFile } };
}

const INVALID = "FB_INVALID";

describe("collectBrief 采集", () => {
  it("裸数组形状采集成功,codes 以 FB_BUILT 开头并以恰一个 E2E 码结尾", () => {
    const { root, opts } = fixtures();
    const result = collectBrief(root, opts);
    expect(result.ok).toBe(true);
    expect(result.brief?.featureId).toBe(FEATURE_ID);
    const codes = result.codes;
    expect(codes[0]).toBe("FB_BUILT");
    const e2e = codes.filter((c) => c === "FB_E2E_ALLOWED" || c === "FB_E2E_BLOCKED");
    expect(e2e).toHaveLength(1);
    expect(codes[codes.length - 1]).toBe(e2e[0]);
  });

  it("包裹对象形状({feature}/{surfaces}/{codeRefs})同样可采集", () => {
    const { root, opts } = fixtures({
      feature: { feature: FEATURE },
      surfaces: { surfaces: SURFACES },
      code: { codeRefs: CODE_REFS },
    });
    const result = collectBrief(root, opts);
    expect(result.ok).toBe(true);
    expect(result.brief?.featureId).toBe(FEATURE_ID);
    expect(result.codes[0]).toBe("FB_BUILT");
  });

  it("{features:[...]} 按包裹层 id 选择功能,{code:[...]} 亦可", () => {
    const other = { ...FEATURE, id: "feat-other", name: "别的功能" };
    const { root, opts } = fixtures({
      feature: { id: "feat-other", features: [FEATURE, other] },
      code: { code: CODE_REFS },
    });
    const result = collectBrief(root, opts);
    expect(result.ok).toBe(true);
    expect(result.brief?.featureId).toBe("feat-other");
  });

  it("输入文件缺失 → ok=false + FB_INVALID + FB_STORE_MISSING_INPUT,且不带 brief", () => {
    const { root, opts } = fixtures();
    const result = collectBrief(root, { ...opts, codeFile: join(root, "nope.json") });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([INVALID, FB_STORE_CODES.MISSING_INPUT]);
    expect("brief" in result).toBe(false);
  });

  it("坏 JSON → ok=false + FB_STORE_BAD_JSON,不抛异常", () => {
    const { root, opts } = fixtures();
    const bad = join(root, "bad.json");
    writeFileSync(bad, "{ not json ", "utf-8");
    const result = collectBrief(root, { ...opts, surfacesFile: bad });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([INVALID, FB_STORE_CODES.BAD_JSON]);
  });

  it("形状不合法(缺 id/name)→ ok=false + FB_STORE_BAD_SHAPE", () => {
    const { root, opts } = fixtures({ feature: { name: "没有 id" } });
    const result = collectBrief(root, opts);
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([INVALID, FB_STORE_CODES.BAD_SHAPE]);
  });
});

describe("语义采纳(accepted)合并", () => {
  it("acceptedFile({by,at}) 合入 brief.semanticsAccepted", () => {
    const { root, opts } = fixtures();
    const acceptedFile = writeJson(root, "accepted.json", { by: "alice", at: "2026-01-01T00:00:00.000Z" });
    const result = collectBrief(root, { ...opts, acceptedFile });
    expect(result.ok).toBe(true);
    expect(result.brief?.semanticsAccepted).toEqual({ by: "alice", at: "2026-01-01T00:00:00.000Z" });
  });

  it("acceptedFile 的 {accepted:{by,at}} / {semanticsAccepted:{by,at}} 包裹形状都认", () => {
    const { root, opts } = fixtures();
    const wrapped = writeJson(root, "accepted-wrapped.json", { accepted: { by: "bob", at: "2026-02-02T00:00:00.000Z" } });
    const nested = writeJson(root, "accepted-nested.json", { semanticsAccepted: { by: "carol", at: "2026-03-03T00:00:00.000Z" } });
    expect(collectBrief(root, { ...opts, acceptedFile: wrapped }).brief?.semanticsAccepted).toEqual({
      by: "bob",
      at: "2026-02-02T00:00:00.000Z",
    });
    expect(collectBrief(root, { ...opts, acceptedFile: nested }).brief?.semanticsAccepted).toEqual({
      by: "carol",
      at: "2026-03-03T00:00:00.000Z",
    });
  });

  it("state 文件自动提供 accepted(不经 acceptedFile)", () => {
    const { root, opts } = fixtures();
    const written = acceptSemantics(root, FEATURE_ID, { by: "dave" });
    expect(written.ok).toBe(true);
    const result = collectBrief(root, opts);
    expect(result.ok).toBe(true);
    expect(result.brief?.semanticsAccepted?.by).toBe("dave");
  });

  it("accept 前 E2E 阻塞,accept 后 collectBrief 自动放行(FB_E2E_ALLOWED)", () => {
    const { root, opts } = fixtures();
    const before = collectBrief(root, opts);
    expect(before.ok).toBe(true);
    expect(before.codes).toContain("FB_E2E_BLOCKED");
    expect(before.codes).not.toContain("FB_E2E_ALLOWED");
    expect(before.codes).toContain("FB_DRIFT");
    expect(before.codes).toContain("FB_UNRESOLVED_OWNER");
    expect(before.brief?.driftCandidates.map((d) => d.target)).toContain("surface:ui-panel");
    expect(before.brief?.unresolvedOwners).toContain("surface:ui-orphan");

    const accepted = acceptSemantics(root, FEATURE_ID, { by: "tester", brief: before.brief });
    expect(accepted.ok).toBe(true);

    const after = collectBrief(root, opts);
    expect(after.ok).toBe(true);
    expect(after.codes).toContain("FB_E2E_ALLOWED");
    expect(after.codes).not.toContain("FB_E2E_BLOCKED");
  });

  it("acceptSemantics 落盘路径与快照内容正确", () => {
    const { root, opts } = fixtures();
    const brief = collectBrief(root, opts).brief;
    const result = acceptSemantics(root, FEATURE_ID, { by: "erin", brief });
    const expectedPath = boundaryStatePath(root, FEATURE_ID);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(expectedPath);
    expect(result.codes).toContain("FB_ACCEPTED");
    expect(existsSync(expectedPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(snapshot.featureId).toBe(FEATURE_ID);
    expect(snapshot.accepted.by).toBe("erin");
    expect(Number.isNaN(Date.parse(snapshot.accepted.at))).toBe(false);
    expect(snapshot.updatedAt).toBe(snapshot.accepted.at);
    expect(snapshot.brief.featureId).toBe(FEATURE_ID);
  });

  it("featureId 路径穿越被拒:不写盘、返回 FB_INVALID", () => {
    const root = tmpRoot();
    for (const bad of ["../escape", "a/b", "a\\b", "with space", ""]) {
      const result = acceptSemantics(root, bad, { by: "mallory" });
      expect(result.ok).toBe(false);
      expect(result.codes).toEqual([INVALID]);
      expect(result.path).toBe("");
    }
    expect(existsSync(join(root, ".genie"))).toBe(false);
    expect(existsSync(join(root, "..", "escape.json"))).toBe(false);
  });
});

describe("drift 聚合与报告", () => {
  it("boundaryStatePath 形状 = <root>/.genie/rsi/boundaries/<featureId>.json", () => {
    const root = tmpRoot();
    expect(boundaryStatePath(root, "feat-x")).toBe(join(root, ".genie", "rsi", "boundaries", "feat-x.json"));
  });

  it("listDrift 聚合多份快照的 driftCandidates,并跳过坏文件", () => {
    const root = tmpRoot();
    const dir = join(root, ".genie", "rsi", "boundaries");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "feat-a.json"),
      JSON.stringify({
        featureId: "feat-a",
        accepted: { by: "u", at: "2026-01-01T00:00:00.000Z" },
        brief: { driftCandidates: [{ target: "ui-panel", reason: "表面步骤与语义不符" }] },
      }),
      "utf-8",
    );
    writeFileSync(
      join(dir, "feat-b.json"),
      JSON.stringify({
        featureId: "feat-b",
        brief: {
          driftCandidates: [
            { target: "share-store", reason: "代码引用深度变了" },
            { target: "share-panel", reason: "入口改签名" },
          ],
        },
      }),
      "utf-8",
    );
    writeFileSync(join(dir, "broken.json"), "{oops", "utf-8");
    writeFileSync(join(dir, "notes.txt"), "忽略非 json", "utf-8");

    const drift = listDrift(root);
    expect(drift).toHaveLength(3);
    expect(drift.map((entry) => `${entry.featureId}:${entry.target}`)).toEqual([
      "feat-a:ui-panel",
      "feat-b:share-store",
      "feat-b:share-panel",
    ]);
    expect(drift[0].reason).toBe("表面步骤与语义不符");
  });

  it("listDrift 在目录不存在时返回空数组", () => {
    expect(listDrift(tmpRoot())).toEqual([]);
  });

  it("report 文本含 featureId、五级分组、E2E 状态与 codes 行", () => {
    const { root, opts } = fixtures();
    const result = report(root, opts);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("featureId: feat-share-panel");
    for (const level of ["must", "should", "conditional", "invariant", "evidence"]) {
      expect(result.text).toContain(`[${level}]`);
    }
    expect(result.text).toMatch(/e2e: (ALLOWED|BLOCKED)/);
    expect(result.text).toContain(`codes: ${result.codes.join(", ")}`);
    expect(result.text).toContain("depth3Required:");
    expect(result.text).toContain("unresolvedOwners");
    expect(result.codes[0]).toBe("FB_BUILT");
  });

  it("report 在采集失败时返回 ok=false 且文本带 FB_STORE_* 码", () => {
    const { root, opts } = fixtures();
    const result = report(root, { ...opts, featureFile: join(root, "missing.json") });
    expect(result.ok).toBe(false);
    expect(result.text).toContain(FB_STORE_CODES.MISSING_INPUT);
    expect(result.codes).toContain(INVALID);
  });
});

// ---------------------------------------------------------------- CLI(--experimental-strip-types)

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(REPO_ROOT, "scripts", "feature-boundary.mts");

/** 找一个支持 --experimental-strip-types 的 node(Node 20 不支持,仓内 nvm 常有 22/24)。 */
function stripTypesNode(): string | undefined {
  const candidates = [process.execPath];
  const nvmDir = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmDir)) {
    const versions = readdirSync(nvmDir)
      .filter((name) => /^v\d+/.test(name))
      .sort((a, b) => Number(a.slice(1).split(".")[0]) - Number(b.slice(1).split(".")[0]));
    for (const version of versions) {
      const bin = join(nvmDir, version, "bin", "node");
      if (existsSync(bin)) candidates.push(bin);
    }
  }
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["--experimental-strip-types", "-e", "process.exit(0)"], { stdio: "ignore" });
    if (probe.status === 0) return bin;
  }
  return undefined;
}

const NODE_BIN = stripTypesNode();
const itCli = NODE_BIN === undefined ? it.skip : it;

function runCli(args: string[], cwd = REPO_ROOT): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(NODE_BIN as string, ["--experimental-strip-types", CLI, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("CLI scripts/feature-boundary.mts", () => {
  itCli("--help → exit 0 且打印用法", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("用法:node --experimental-strip-types scripts/feature-boundary.mts");
  });

  itCli("缺必填参数(无 --code)→ exit 1 且 stderr 提示", () => {
    const { root, opts } = fixtures();
    const res = runCli(["--root", root, "--feature", opts.featureFile, "--surfaces", opts.surfacesFile]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--code");
  });

  itCli("未知参数 → exit 1", () => {
    const res = runCli(["--bogus", "x"]);
    expect(res.status).toBe(1);
  });

  itCli("E2E 阻塞 → exit 2,文本含 BLOCKED 与 FB_E2E_BLOCKED", () => {
    const { root, opts } = fixtures();
    const res = runCli(["--root", root, "--feature", opts.featureFile, "--surfaces", opts.surfacesFile, "--code", opts.codeFile]);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("e2e: BLOCKED");
    expect(res.stdout).toContain("FB_E2E_BLOCKED");
  });

  itCli("--accept-by tester 后 → exit 0、--json 形状完整、state 落盘", () => {
    const { root, opts } = fixtures();
    const blocked = runCli([
      "--root",
      root,
      "--feature",
      opts.featureFile,
      "--surfaces",
      opts.surfacesFile,
      "--code",
      opts.codeFile,
    ]);
    expect(blocked.status).toBe(2);

    const res = runCli([
      "--root",
      root,
      "--feature",
      opts.featureFile,
      "--surfaces",
      opts.surfacesFile,
      "--code",
      opts.codeFile,
      "--accept-by",
      "tester",
      "--json",
    ]);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.featureId).toBe(FEATURE_ID);
    expect(Array.isArray(payload.items)).toBe(true);
    expect(Array.isArray(payload.driftCandidates)).toBe(true);
    expect(Array.isArray(payload.unresolvedOwners)).toBe(true);
    expect(typeof payload.depth3Required).toBe("boolean");
    expect(payload.semanticsAccepted.by).toBe("tester");
    expect(payload.canWriteE2E).toBe(true);
    expect(payload.codes).toContain("FB_E2E_ALLOWED");
    expect(existsSync(boundaryStatePath(root, FEATURE_ID))).toBe(true);
  });

  itCli("输入文件缺失 → exit 2 且给出 FB_STORE_MISSING_INPUT", () => {
    const { root, opts } = fixtures();
    const res = runCli([
      "--root",
      root,
      "--feature",
      join(root, "nope.json"),
      "--surfaces",
      opts.surfacesFile,
      "--code",
      opts.codeFile,
      "--json",
    ]);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout).codes).toContain(FB_STORE_CODES.MISSING_INPUT);
  });
});
