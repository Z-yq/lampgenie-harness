/**
 * 开工画像单测:探测(fail-soft)/verify 命令选择/稳定前缀渲染(确定性+裁剪)。
 * 全部注入假 exec + 临时 /tmp 目录(不碰真实 git 状态,不依赖仓内 manifests)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeWorkStart,
  verifyCommandsFor,
  renderWorkStartBrief,
  editFormatHint,
  WORK_START_BRIEF_MAX_CHARS,
  VERIFY_COMMANDS_MAX,
  type WorkStartProfile,
} from "../src/work-start-profile.js";
import { START_BRIEF_STOP_RULES } from "../src/agent-wiring-sop-tips.js";

type Reply = { ok?: boolean; stdout?: string; stderr?: string } | "throw";

/** 假 exec:按 `cmd arg1 arg2` 精确键取假输出;未配置=失败(ok:false)。 */
function fakeExec(replies: Record<string, Reply>) {
  return (cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } => {
    const key = [cmd, ...args].join(" ");
    const r = replies[key];
    if (r === "throw") throw new Error("boom: " + key);
    if (!r) return { ok: false, stdout: "", stderr: "not configured: " + key };
    return { ok: r.ok !== false, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

const GIT_OK: Record<string, Reply> = {
  "git rev-parse --abbrev-ref HEAD": { stdout: "feature/m168\n" },
  "git status --porcelain": { stdout: " M a.ts\n?? b.ts\n" },
  "git log -5 --oneline": { stdout: "aaa111 one\nbbb222 two\nccc333 three\n" },
  "git worktree list --porcelain": { stdout: "worktree /repo\nHEAD aaa\n\nworktree /repo-wt\nHEAD bbb\n" },
};

/** 临时根目录 + 指定文件;返回 cleanup。 */
function mkRoot(files: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "m168-profile-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const emptyManifests = { packageJson: false, pnpmWorkspace: false, pyproject: false, cargo: false, goMod: false };

function profileOf(p: Partial<WorkStartProfile>): WorkStartProfile {
  return { root: "/repo", manifests: { ...emptyManifests }, errors: [], ...p };
}

describe("probeWorkStart:各探测项", () => {
  it("A. 假 git 输出 → branch/dirty/commits 正确解析", async () => {
    const { root, cleanup } = mkRoot();
    try {
      const p = await probeWorkStart({ root, exec: fakeExec(GIT_OK) });
      expect(p.branch).toBe("feature/m168");
      expect(p.dirtyFiles).toBe(2); // " M a.ts" + "?? b.ts"
      expect(p.commits).toEqual(["aaa111 one", "bbb222 two", "ccc333 three"]);
      expect(p.errors).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("worktree list --porcelain 解析出 worktree 路径", async () => {
    const { root, cleanup } = mkRoot();
    try {
      const p = await probeWorkStart({ root, exec: fakeExec(GIT_OK) });
      expect(p.worktrees).toEqual(["/repo", "/repo-wt"]);
    } finally {
      cleanup();
    }
  });

  it("manifest 存在性按 root 下真实文件判定", async () => {
    const { root, cleanup } = mkRoot({ "package.json": "{}", "pnpm-workspace.yaml": "packages: []\n", "go.mod": "module x\n" });
    try {
      const p = await probeWorkStart({ root, exec: fakeExec(GIT_OK) });
      expect(p.manifests).toEqual({ packageJson: true, pnpmWorkspace: true, pyproject: false, cargo: false, goMod: true });
    } finally {
      cleanup();
    }
  });

  it("package.json scripts.test 被读取(verify 判据)", async () => {
    const { root, cleanup } = mkRoot({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    try {
      const p = await probeWorkStart({ root, exec: fakeExec(GIT_OK) });
      expect(p.testScript).toBe("vitest run");
    } finally {
      cleanup();
    }
  });

  it("package.json 非法 JSON 不抛,只落 errors", async () => {
    const { root, cleanup } = mkRoot({ "package.json": "{ not json" });
    try {
      const p = await probeWorkStart({ root, exec: fakeExec(GIT_OK) });
      expect(p.testScript).toBeUndefined();
      expect(p.errors.some((e) => e.probe === "package.json")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("probeWorkStart:包管理器判定", () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ["pnpm-lock → pnpm", { "pnpm-lock.yaml": "lockfileVersion: 9\n" }, "pnpm"],
    ["yarn.lock → yarn", { "yarn.lock": "# yarn\n" }, "yarn"],
    ["package-lock → npm", { "package-lock.json": "{}" }, "npm"],
    ["pyproject + uv.lock → uv", { "pyproject.toml": "[project]\n", "uv.lock": "x\n" }, "uv"],
    ["pyproject 无 uv.lock → pip", { "pyproject.toml": "[project]\n" }, "pip"],
    ["Cargo.toml → cargo", { "Cargo.toml": "[package]\n" }, "cargo"],
    ["go.mod → go", { "go.mod": "module x\n" }, "go"],
  ];
  for (const [name, files, want] of cases) {
    it(name, async () => {
      const { root, cleanup } = mkRoot(files);
      try {
        const p = await probeWorkStart({ root, exec: fakeExec(GIT_OK) });
        expect(p.packageManager).toBe(want);
      } finally {
        cleanup();
      }
    });
  }

  it("锁文件优先级:pnpm-lock 压过 package-lock", async () => {
    const { root, cleanup } = mkRoot({ "pnpm-lock.yaml": "x\n", "package-lock.json": "{}" });
    try {
      const p = await probeWorkStart({ root, exec: fakeExec(GIT_OK) });
      expect(p.packageManager).toBe("pnpm");
    } finally {
      cleanup();
    }
  });
});

describe("probeWorkStart:fail-soft(探测失败不阻塞开工)", () => {
  it("B. 假 exec 全失败 → 四项探测各落一条 errors,brief 仍可生成", async () => {
    const { root, cleanup } = mkRoot({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    try {
      const p = await probeWorkStart({ root, exec: fakeExec({}) });
      const probes = p.errors.map((e) => e.probe).sort();
      expect(probes).toEqual(["branch", "log", "status", "worktree"]);
      expect(p.branch).toBeUndefined();
      expect(p.dirtyFiles).toBeUndefined();
 // manifests 仍工作(与 git 无关),verify 命令照出
      expect(p.manifests.packageJson).toBe(true);
      expect(verifyCommandsFor(p).length).toBeGreaterThan(0);
      const brief = renderWorkStartBrief(p);
      expect(brief).toContain("开工画像(");
      expect(brief).toContain("探测失败:");
    } finally {
      cleanup();
    }
  });

  it("exec 抛异常也不外溢(逐项 catch 记 errors)", async () => {
    const { root, cleanup } = mkRoot();
    try {
      const p = await probeWorkStart({
        root,
        exec: () => {
          throw new Error("spawn git ENOENT");
        },
      });
      expect(p.errors).toHaveLength(4);
      expect(p.errors[0]!.error).toContain("ENOENT");
    } finally {
      cleanup();
    }
  });

  it("root 为空串也不抛(空态可渲染)", async () => {
    const p = await probeWorkStart({ root: "", exec: fakeExec({}) });
    expect(p.root).toBe("");
    expect(renderWorkStartBrief(p)).toContain("开工画像(root=? branch=?");
  });

  it("git 成功但输出空(status 空=工作区干净 → dirty=0)", async () => {
    const { root, cleanup } = mkRoot();
    try {
      const p = await probeWorkStart({
        root,
        exec: fakeExec({
          "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
          "git status --porcelain": { stdout: "" },
          "git log -5 --oneline": { stdout: "" },
          "git worktree list --porcelain": { stdout: "worktree /repo\n" },
        }),
      });
      expect(p.dirtyFiles).toBe(0);
      expect(p.commits).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("verifyCommandsFor:可执行命令选择", () => {
  it("C. pnpm-workspace → 含 -r 的 build/test", () => {
    const cmds = verifyCommandsFor(profileOf({ manifests: { ...emptyManifests, pnpmWorkspace: true } }));
    expect(cmds).toContain("pnpm -r run build");
    expect(cmds).toContain("pnpm -r test");
  });

  it("package.json 有 scripts.test:npm 仓 → npm test;默认 → pnpm test", () => {
    const base = { packageJson: true } as const;
    expect(verifyCommandsFor(profileOf({ manifests: { ...emptyManifests, ...base }, testScript: "vitest run", packageManager: "npm" }))).toContain("npm test");
    expect(verifyCommandsFor(profileOf({ manifests: { ...emptyManifests, ...base }, testScript: "vitest run", packageManager: "pnpm" }))).toContain("pnpm test");
    expect(verifyCommandsFor(profileOf({ manifests: { ...emptyManifests, ...base }, testScript: "vitest run", packageManager: "yarn" }))).toContain("yarn test");
  });

  it("package.json 无 scripts.test → 不产生 test 命令", () => {
    const cmds = verifyCommandsFor(profileOf({ manifests: { ...emptyManifests, packageJson: true } }));
    expect(cmds).toEqual([]);
  });

  it("pyproject → pytest -q;Cargo → cargo test;go.mod → go test ./...", () => {
    expect(verifyCommandsFor(profileOf({ manifests: { ...emptyManifests, pyproject: true } }))).toEqual(["pytest -q"]);
    expect(verifyCommandsFor(profileOf({ manifests: { ...emptyManifests, cargo: true } }))).toEqual(["cargo test"]);
    expect(verifyCommandsFor(profileOf({ manifests: { ...emptyManifests, goMod: true } }))).toEqual(["go test ./..."]);
  });

  it("空 manifests → 空数组", () => {
    expect(verifyCommandsFor(profileOf({}))).toEqual([]);
  });

  it("全生态齐备 → 去重且不超过 VERIFY_COMMANDS_MAX", () => {
    const cmds = verifyCommandsFor(
      profileOf({
        manifests: { packageJson: true, pnpmWorkspace: true, pyproject: true, cargo: true, goMod: true },
        testScript: "vitest run",
        packageManager: "pnpm",
      }),
    );
    expect(cmds.length).toBeLessThanOrEqual(VERIFY_COMMANDS_MAX);
    expect(new Set(cmds).size).toBe(cmds.length);
  });
});

describe("renderWorkStartBrief:稳定前缀渲染", () => {
  it("A. 头部含 root/branch/dirty/commits 与验证命令", async () => {
    const { root, cleanup } = mkRoot({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "pnpm-workspace.yaml": "packages: []\n" });
    try {
      const p = await probeWorkStart({ root, exec: fakeExec(GIT_OK) });
      const brief = renderWorkStartBrief(p);
      expect(brief).toContain(`root=${root}`);
      expect(brief).toContain("branch=feature/m168");
      expect(brief).toContain("dirty=2");
      expect(brief).toContain("commits=3");
      expect(brief).toContain("验证命令:");
      expect(brief).toContain("- pnpm -r run build");
    } finally {
      cleanup();
    }
  });

  it("E. 同输入渲染两次逐字相同(无时间戳/随机数)", () => {
    const p = profileOf({ branch: "main", dirtyFiles: 1, commits: ["abc one"], worktrees: ["/a", "/b"] });
    expect(renderWorkStartBrief(p)).toBe(renderWorkStartBrief(p));
    expect(renderWorkStartBrief(p, { modelFamily: "gpt-5" })).toBe(renderWorkStartBrief(p, { modelFamily: "gpt-5" }));
  });

  it("停止规则三条全量在 brief 中", () => {
    const brief = renderWorkStartBrief(profileOf({}));
    for (const rule of START_BRIEF_STOP_RULES) expect(brief).toContain(rule);
    expect(brief).toContain("停止规则:");
  });

  it("D. gpt 家族 → apply_patch 提示;其它模型 → edit_file 精确替换", () => {
    expect(renderWorkStartBrief(profileOf({}), { modelFamily: "gpt-5-codex" })).toContain("apply_patch");
    const other = renderWorkStartBrief(profileOf({}), { modelFamily: "claude-sonnet-4" });
    expect(other).toContain("编辑格式: edit_file 精确替换");
    expect(other).not.toContain("编辑格式: gpt 家族");
  });

  it("有 errors 时附「探测失败:」行", () => {
    const brief = renderWorkStartBrief(profileOf({ errors: [{ probe: "branch", error: "git 不可用" }] }));
    expect(brief).toContain("探测失败: branch=git 不可用");
  });

  it("F. 超长输入按 验证命令→commits→worktree 裁剪,停止规则永不裁", () => {
    const commits = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(3, "0")} ${"x".repeat(80)}`);
    const worktrees = Array.from({ length: 8 }, (_, i) => `/repo-wt-${i}-${"y".repeat(40)}`);
    const brief = renderWorkStartBrief(
      profileOf({
        manifests: { ...emptyManifests, pnpmWorkspace: true },
        commits,
        worktrees,
      }),
    );
    expect(brief.length).toBeLessThanOrEqual(WORK_START_BRIEF_MAX_CHARS);
    for (const rule of START_BRIEF_STOP_RULES) expect(brief).toContain(rule);
    expect(brief).not.toContain("验证命令:"); // 第一档被裁
    expect(brief).not.toContain("近期提交:"); // commits 先于 worktree 被裁
  });

  it("短输入保留 commits 与 worktree(不被无谓裁剪)", () => {
    const brief = renderWorkStartBrief(profileOf({ commits: ["abc one"], worktrees: ["/a", "/b"] }));
    expect(brief).toContain("近期提交:");
    expect(brief).toContain("worktree:");
  });

  it("超长 root 被收敛到展示上限,不挤掉停止规则", () => {
    const longRoot = "/" + "z".repeat(3000);
    const brief = renderWorkStartBrief(profileOf({ root: longRoot }));
    expect(brief.length).toBeLessThanOrEqual(WORK_START_BRIEF_MAX_CHARS);
    for (const rule of START_BRIEF_STOP_RULES) expect(brief).toContain(rule);
  });
});

describe("editFormatHint / START_BRIEF_STOP_RULES 常量", () => {
  it("gpt/codex/o3 → apply_patch;空与未知 → edit_file", () => {
    for (const m of ["gpt-4o", "gpt-5-codex", "o3-mini", "OpenAI/gpt-4.1"]) expect(editFormatHint(m)).toContain("apply_patch");
    for (const m of ["", undefined, "claude-sonnet-4", "deepseek-v3", "glm-4.6"]) expect(editFormatHint(m)).toContain("edit_file");
  });

  it("停止规则恰三条,每条是短句(≤60 字,行式卡纪律)", () => {
    expect(START_BRIEF_STOP_RULES).toHaveLength(3);
    for (const r of START_BRIEF_STOP_RULES) {
      expect(r.length).toBeGreaterThan(8);
      expect(r.length).toBeLessThanOrEqual(60);
    }
  });
});
