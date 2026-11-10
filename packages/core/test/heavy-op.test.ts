import { describe, it, expect } from "vitest";
import {
  classifyHeavyOp,
  isHeavyCommand,
  loadHeavyOpConfig,
  DEFAULT_HEAVY_OP_RULES,
  DEFAULT_HEAVY_OP_EXEMPTS,
} from "../src/permission/heavy-op";

describe("heavy-op 判定表(step-071 D1)", () => {
  it("build 类:pnpm/npm/yarn build、tsc -b、next/vite build、go/cargo build 命中", () => {
    for (const cmd of [
      "pnpm build",
      "pnpm run build",
      "pnpm --filter web build",
      "npm run build",
      "yarn build",
      "tsc -b",
      "tsc --build",
      "next build",
      "vite build",
      "go build ./...",
      "cargo build --release",
    ]) {
      const m = classifyHeavyOp(cmd);
      expect(m, cmd).not.toBeNull();
      expect(m!.kind).toBe("cmd.heavy");
      expect(m!.category, cmd).toBe("build");
    }
  });

  it("install 类:pnpm/npm/yarn add|install、pip/apt/brew install 命中", () => {
    for (const cmd of ["pnpm install", "pnpm add zod", "npm i", "npm install", "yarn add left-pad", "pip install requests", "apt-get install -y curl", "brew install ripgrep"]) {
      const m = classifyHeavyOp(cmd);
      expect(m, cmd).not.toBeNull();
      expect(m!.category, cmd).toBe("install");
    }
  });

  it("full-test 类:pnpm/npm test、vitest run、jest、pytest、cargo test 命中", () => {
    for (const cmd of ["pnpm test", "pnpm run test", "npm test", "yarn test", "vitest run", "npx vitest run tests/a.test.ts", "jest", "pytest -q", "cargo test"]) {
      const m = classifyHeavyOp(cmd);
      expect(m, cmd).not.toBeNull();
      expect(m!.category, cmd).toBe("full-test");
    }
  });

  it("bulk 类:pnpm -r/--recursive、turbo run、nx run-many、lerna run、npm --workspaces 命中", () => {
    for (const cmd of ["pnpm -r build", "pnpm --recursive test", "turbo run build", "nx run-many -t build", "lerna run test", "npm test --workspaces"]) {
      const m = classifyHeavyOp(cmd);
      expect(m, cmd).not.toBeNull();
    }
  });

  it("链式命令:cd x && pnpm build 整串 search 命中(env 前缀/路径前缀同域)", () => {
    const m = classifyHeavyOp("cd /repo && pnpm build && echo done");
    expect(m).not.toBeNull();
    expect(m!.category).toBe("build");
    expect(classifyHeavyOp("CI=1 npm run build")).not.toBeNull();
  });

  it("豁免:单文件 vitest --maxWorkers=1(两种参数顺序)不判重;全量 vitest run 不豁免", () => {
    expect(classifyHeavyOp("npx vitest run test/foo.test.ts --maxWorkers=1")).toBeNull();
    expect(classifyHeavyOp("vitest run --maxWorkers=1 src/a.spec.tsx")).toBeNull();
    // 缺 maxWorkers=1 → 不豁免
    expect(classifyHeavyOp("vitest run test/foo.test.ts")?.category).toBe("full-test");
    // 缺文件(全量)→ 不豁免
    expect(classifyHeavyOp("vitest run --maxWorkers=1")?.category).toBe("full-test");
  });

  it("负例不误伤:grep/read/cat/tsc --noEmit 单包/ls/git status 全放行", () => {
    for (const cmd of ["grep -rn foo src/", "cat package.json", "ls -la", "tsc --noEmit -p tsconfig.json", "git status --short", "node script.ts", "echo hello", "npm run lint"]) {
      expect(classifyHeavyOp(cmd), cmd).toBeNull();
    }
  });

  it("自定义表与豁免表可注入;空命令=null", () => {
    const rules = [{ category: "deploy", patterns: ["\\bxantos\\s+deploy\\b"], note: "部署" }];
    expect(classifyHeavyOp("xantos deploy --prod", rules, [])?.category).toBe("deploy");
    expect(classifyHeavyOp("pnpm build", rules, [])).toBeNull(); // 自定义表不含默认类
    expect(classifyHeavyOp("xantos deploy --dry", rules, ["deploy\\s+--dry\\b"])).toBeNull(); // 豁免命中
    expect(classifyHeavyOp("xantos deploy --prod", rules, ["deploy\\s+--dry\\b"])?.category).toBe("deploy"); // 豁免不命中
    expect(isHeavyCommand("  ")).toBe(false);
    expect(isHeavyCommand("pnpm build")).toBe(true);
  });

  it("默认表形态:kind=cmd.heavy、带 note、模式 source 可回读(审计可解释)", () => {
    const m = classifyHeavyOp("pnpm build")!;
    expect(m.pattern).toBe(DEFAULT_HEAVY_OP_RULES[0]!.patterns[0]);
    expect(typeof m.note).toBe("string");
    expect(DEFAULT_HEAVY_OP_EXEMPTS.length).toBeGreaterThan(0);
  });
});

describe("env 可配置扩展(step-071)", () => {
  it("GENIE_HEAVY_OP_EXTRA_RULES 追加(只增不删);GENIE_HEAVY_OP_EXEMPT 追加豁免", () => {
    const cfg = loadHeavyOpConfig({
      GENIE_HEAVY_OP_EXTRA_RULES: JSON.stringify([{ category: "render", patterns: ["\\bblender\\s+-b\\b"], note: "渲染" }]),
      GENIE_HEAVY_OP_EXEMPT: JSON.stringify(["\\bpnpm\\s+build\\b.*--dry-run"]),
    });
    expect(cfg.rules.some((r) => r.category === "render")).toBe(true);
    expect(cfg.rules.some((r) => r.category === "build")).toBe(true); // 默认表仍在
    expect(cfg.exempts.length).toBe(DEFAULT_HEAVY_OP_EXEMPTS.length + 1);
    expect(classifyHeavyOp("blender -b scene.blend", cfg.rules, cfg.exempts)?.category).toBe("render");
  });

  it("坏 JSON / 形态错 / 非法正则显式抛错(fail-visible,不静默变全放行)", () => {
    expect(() => loadHeavyOpConfig({ GENIE_HEAVY_OP_EXTRA_RULES: "{bad" })).toThrow(/不是合法 JSON/);
    expect(() => loadHeavyOpConfig({ GENIE_HEAVY_OP_EXTRA_RULES: '{"a":1}' })).toThrow(/数组/);
    expect(() => loadHeavyOpConfig({ GENIE_HEAVY_OP_EXTRA_RULES: JSON.stringify([{ category: "x", patterns: ["([bad"] }]) })).toThrow();
    expect(() => loadHeavyOpConfig({ GENIE_HEAVY_OP_EXEMPT: "not-json" })).toThrow(/不是合法 JSON/);
    expect(() => loadHeavyOpConfig({ GENIE_HEAVY_OP_EXEMPT: JSON.stringify([42]) })).toThrow(/string\[\]/);
  });

  it("env 缺省=纯默认表(不读真环境,测试注入隔离)", () => {
    const cfg = loadHeavyOpConfig({});
    expect(cfg.rules).toEqual(DEFAULT_HEAVY_OP_RULES);
    expect(cfg.exempts).toEqual(DEFAULT_HEAVY_OP_EXEMPTS);
  });
});
