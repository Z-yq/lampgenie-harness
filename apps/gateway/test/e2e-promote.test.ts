/**
 * scripts/e2e-promote.mjs(机制):E2E 晋升事务 + 覆盖率审计。
 * 全部用例在临时目录里造 pending / 正式目录 / matrix,不碰仓库真实文件,不起网关、不 build。
 * 覆盖:dry-run 不写盘、apply 成功写三处、skip/only 拒绝、count 与真实 test() 数不一致拒绝、
 * 缺 fixture / 目标已存在无 force 拒绝、写盘失败整体回滚、matrix upsert 保留其它行、row.id 重复拒绝、CLI 退出码。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = fileURLToPath(new URL("../../../scripts/e2e-promote.mjs", import.meta.url));

interface PromoteModule {
  countTests(text: string): number;
  findSkipOnly(text: string): Array<{ line: number; text: string }>;
  loadPlan(file: string): { cases: PlanCase[] };
  validatePlan(
    root: string,
    plan: unknown,
    opts?: { apply?: boolean; reviewed?: boolean; force?: boolean },
  ): { ok: boolean; errors: string[]; warnings: string[]; actions: Array<Record<string, unknown>> };
  auditPlan(root: string, plan: unknown): { ok: boolean; errors: string[] };
  applyPlan(
    root: string,
    plan: unknown,
    opts?: { reviewed?: boolean; force?: boolean },
  ): {
    ok: boolean;
    applied: Array<Record<string, unknown>>;
    matrixPath?: string | string[];
    errors?: string[];
    rolledBack?: boolean;
  };
  dryRun(
    root: string,
    plan: unknown,
    opts?: { force?: boolean; log?: (s: string) => void },
  ): { ok: boolean; errors: string[] };
  parseArgs(argv: string[]): Record<string, unknown>;
  main(argv: string[]): number;
}

interface PlanCase {
  id: string;
  from: string;
  to: string;
  fixtures?: Array<{ from: string; to: string }>;
  matrix?: { path: string; row: Record<string, unknown> };
  reviewed?: boolean;
}

let mod: PromoteModule;

beforeEach(async () => {
  if (!mod) mod = (await import(SCRIPT)) as unknown as PromoteModule;
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "genie-e2e-promote-"));
}

const GOOD_SPEC = `import { it, expect } from "vitest";
// it("注释里的不算")
it("a works", () => { expect(1).toBe(1); });
it("b works", () => { expect(2).toBe(2); });
`;

const MATRIX = {
  cases: [{ id: "case-keep", status: "covered", spec: "test/ui/existing.spec.cjs", count: 1 }],
};

interface Seed {
  specText?: string;
  fixtures?: boolean;
  matrix?: "file" | "missing" | "dir" | "readonly";
  targetExists?: boolean;
  rowOverride?: Record<string, unknown>;
  cases?: PlanCase[];
}

function seed(root: string, opts: Seed = {}) {
  const specText = opts.specText ?? GOOD_SPEC;
  mkdirSync(join(root, "test/ui/pending/fixtures"), { recursive: true });
  mkdirSync(join(root, "test/ui/fixtures"), { recursive: true });
  writeFileSync(join(root, "test/ui/pending/a.spec.cjs"), specText);
  if (opts.fixtures !== false) {
    writeFileSync(join(root, "test/ui/pending/fixtures/a.html"), "<h1>a</h1>");
  }
  if (opts.targetExists) writeFileSync(join(root, "test/ui/a.spec.cjs"), "// old\n");

  const matrixMode = opts.matrix ?? "file";
  if (matrixMode === "file") {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/e2e-matrix.json"), `${JSON.stringify(MATRIX, null, 2)}\n`);
  } else if (matrixMode === "dir") {
    mkdirSync(join(root, "docs/e2e-matrix.json"), { recursive: true });
  } else if (matrixMode === "readonly") {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/e2e-matrix.json"), `${JSON.stringify(MATRIX, null, 2)}\n`);
    chmodSync(join(root, "docs/e2e-matrix.json"), 0o444);
  }

  const row = {
    id: "case-a",
    status: "covered",
    spec: "test/ui/a.spec.cjs",
    count: 2,
    ...(opts.rowOverride ?? {}),
  };
  const caseA: PlanCase = {
    id: "case-a",
    from: "test/ui/pending/a.spec.cjs",
    to: "test/ui/a.spec.cjs",
    fixtures: [{ from: "test/ui/pending/fixtures/a.html", to: "test/ui/fixtures/a.html" }],
    matrix: { path: "docs/e2e-matrix.json", row },
    reviewed: true,
  };
  return { cases: opts.cases ?? [caseA] };
}

function snip(spec: string): string {
  return spec.replace(/\bit\(/g, "it.skip(");
}

describe("countTests / findSkipOnly", () => {
  it("注释行里的 it( 不计入", () => {
    expect(mod.countTests(GOOD_SPEC)).toBe(2);
    expect(mod.countTests(`// it("x")\n/* it("y") */\ntest("z", ()=>{});`)).toBe(1);
    expect(mod.countTests("")).toBe(0);
  });

  it("抓出 .skip( / .only( / skip: / only:", () => {
    expect(mod.findSkipOnly(GOOD_SPEC)).toHaveLength(0);
    expect(mod.findSkipOnly(`it.skip("a", ()=>{});`)[0].line).toBe(1);
    expect(mod.findSkipOnly(`\nit.only("b", ()=>{});`)[0].line).toBe(2);
    expect(mod.findSkipOnly(`describe("x", { skip: true }, ()=>{});`)).toHaveLength(1);
    expect(mod.findSkipOnly(`describe.only("x", ()=>{});`)).toHaveLength(1);
    // 注释掉的 skip 不算
    expect(mod.findSkipOnly(`// it.skip("a")`)).toHaveLength(0);
  });
});

describe("validatePlan 全量对账", () => {
  let root = "";
  beforeEach(() => {
    root = tmpRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("合法计划通过,并给出将执行的动作", () => {
    const plan = seed(root);
    const res = mod.validatePlan(root, plan, {});
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.actions.filter((a) => a.op === "copy")).toHaveLength(2);
    expect(res.actions.filter((a) => a.op === "matrix-upsert")).toHaveLength(1);
  });

  it("spec 含 .skip( / .only( 拒绝(半转正)", () => {
    const plan = seed(root, { specText: snip(GOOD_SPEC), rowOverride: { count: 2 } });
    expect(mod.validatePlan(root, plan, {}).errors.join("\n")).toMatch(/skip\/only/);
    const plan2 = seed(root, { specText: `it.only("a", ()=>{});`, rowOverride: { count: 1 } });
    const res2 = mod.validatePlan(root, plan2, {});
    expect(res2.ok).toBe(false);
    expect(res2.errors.join("\n")).toMatch(/skip\/only/);
  });

  it("matrix count 与真实 test() 数不一致 → 拒绝并给 expected/got", () => {
    const plan = seed(root, { rowOverride: { count: 3 } });
    const res = mod.validatePlan(root, plan, {});
    expect(res.ok).toBe(false);
    const msg = res.errors.join("\n");
    expect(msg).toContain("expected 2");
    expect(msg).toContain("got 3");
  });

  it("缺 fixture 拒绝", () => {
    const plan = seed(root, { fixtures: false });
    const res = mod.validatePlan(root, plan, {});
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/fixtures\[0\] from 不存在/);
  });

  it("目标已存在且无 force → 拒绝;有 force 通过", () => {
    const plan = seed(root, { targetExists: true });
    expect(mod.validatePlan(root, plan, {}).errors.join("\n")).toMatch(/目标已存在/);
    expect(mod.validatePlan(root, plan, { force: true }).ok).toBe(true);
  });

  it("from 不是文件 / from 不存在拒绝", () => {
    const plan = seed(root);
    plan.cases[0].from = "test/ui/pending/nope.spec.cjs";
    expect(mod.validatePlan(root, plan, {}).errors.join("\n")).toMatch(/from 不存在/);
  });

  it("row.status 非 covered 拒绝;row.id 重复拒绝", () => {
    const plan = seed(root, { rowOverride: { status: "pending" } });
    expect(mod.validatePlan(root, plan, {}).errors.join("\n")).toMatch(/status 只能是 covered/);

    const root2 = tmpRoot();
    try {
      const p2 = seed(root2);
      p2.cases.push({ ...p2.cases[0] });
      const res = mod.validatePlan(root2, p2, {});
      expect(res.ok).toBe(false);
      expect(res.errors.join("\n")).toMatch(/id 重复/);
      expect(res.errors.join("\n")).toMatch(/matrix.row.id 重复/);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("matrix JSON 坏 / dry-run 下 matrix 缺失都拒绝", () => {
    const root2 = tmpRoot();
    try {
      const plan = seed(root2);
      writeFileSync(join(root2, "docs/e2e-matrix.json"), "{ not json");
      expect(mod.validatePlan(root2, plan, {}).errors.join("\n")).toMatch(/matrix JSON 解析失败/);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
    const root3 = tmpRoot();
    try {
      const plan = seed(root3, { matrix: "missing" });
      expect(mod.validatePlan(root3, plan, {}).errors.join("\n")).toMatch(/matrix.path 不存在/);
      // apply 模式下才允许新建
      const res = mod.validatePlan(root3, plan, { apply: true, reviewed: true });
      expect(res.ok).toBe(true);
      expect(res.warnings.join("\n")).toMatch(/apply 时新建/);
    } finally {
      rmSync(root3, { recursive: true, force: true });
    }
  });

  it("apply 需要 CLI --reviewed 且每个 case.reviewed=true", () => {
    const plan = seed(root);
    expect(mod.validatePlan(root, plan, { apply: true, reviewed: false }).errors.join("\n")).toMatch(
      /需要 CLI --reviewed/,
    );
    const plan2 = seed(root);
    plan2.cases[0].reviewed = false;
    expect(mod.validatePlan(root, plan2, { apply: true, reviewed: true }).errors.join("\n")).toMatch(
      /case.reviewed=true/,
    );
  });
});

describe("dryRun / applyPlan", () => {
  let root = "";
  beforeEach(() => {
    root = tmpRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("dry-run 不写盘,并打印将执行的动作", () => {
    const plan = seed(root);
    const before = readFileSync(join(root, "docs/e2e-matrix.json"), "utf8");
    const logs: string[] = [];
    const res = mod.dryRun(root, plan, { log: (s) => logs.push(s) });
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, "test/ui/a.spec.cjs"))).toBe(false);
    expect(existsSync(join(root, "test/ui/fixtures/a.html"))).toBe(false);
    expect(readFileSync(join(root, "docs/e2e-matrix.json"), "utf8")).toBe(before);
    expect(logs.join("\n")).toContain("dry-run");
    expect(logs.join("\n")).toContain("copy test/ui/pending/a.spec.cjs -> test/ui/a.spec.cjs");
    expect(logs.join("\n")).toContain("matrix-upsert docs/e2e-matrix.json (row.id=case-a)");
    expect(logs.join("\n")).toContain("校验通过");
  });

  it("apply 成功:写 spec + fixture + matrix(upsert 保留其它行,2 空格 + 换行)", () => {
    const plan = seed(root);
    const res = mod.applyPlan(root, plan, { reviewed: true });
    expect(res.ok).toBe(true);
    expect(res.rolledBack).toBe(false);
    expect(res.matrixPath).toBe("docs/e2e-matrix.json");
    expect(res.applied.map((a) => a.op)).toEqual(["copy", "copy", "matrix-upsert"]);

    expect(readFileSync(join(root, "test/ui/a.spec.cjs"), "utf8")).toBe(GOOD_SPEC);
    expect(readFileSync(join(root, "test/ui/fixtures/a.html"), "utf8")).toBe("<h1>a</h1>");

    const raw = readFileSync(join(root, "docs/e2e-matrix.json"), "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toContain('"id": "case-a"');
    const data = JSON.parse(raw);
    expect(data.cases.map((r: { id: string }) => r.id)).toEqual(["case-keep", "case-a"]);
    expect(data.cases[1]).toMatchObject({ status: "covered", spec: "test/ui/a.spec.cjs", count: 2 });
    // 保留其它行原样
    expect(data.cases[0]).toEqual(MATRIX.cases[0]);
  });

  it("apply 同一 matrix 多 case:一次读一次写,新行按 id 追加且保留其它行", () => {
    const plan = seed(root);
    const caseB: PlanCase = {
      id: "case-b",
      from: "test/ui/pending/b.spec.cjs",
      to: "test/ui/b.spec.cjs",
      matrix: {
        path: "docs/e2e-matrix.json",
        row: { id: "case-b", status: "covered", spec: "test/ui/b.spec.cjs", count: 1 },
      },
      reviewed: true,
    };
    writeFileSync(join(root, "test/ui/pending/b.spec.cjs"), `test("only one", ()=>{});\n`);
    plan.cases.push(caseB);
    const res = mod.applyPlan(root, plan, { reviewed: true });
    expect(res.ok).toBe(true);
    expect(res.applied.filter((a) => a.op === "matrix-upsert")).toHaveLength(1);
    const data = JSON.parse(readFileSync(join(root, "docs/e2e-matrix.json"), "utf8"));
    expect(data.cases.map((r: { id: string }) => r.id)).toEqual(["case-keep", "case-a", "case-b"]);
  });

  it("apply 拒绝非 reviewed 计划(不写盘)", () => {
    const plan = seed(root);
    const res = mod.applyPlan(root, plan, { reviewed: true });
    expect(res.ok).toBe(true);
    // 反向:改回未 review
    const root2 = tmpRoot();
    try {
      const p2 = seed(root2);
      p2.cases[0].reviewed = false;
      const r2 = mod.applyPlan(root2, p2, { reviewed: true });
      expect(r2.ok).toBe(false);
      expect(r2.rolledBack).toBe(false);
      expect(existsSync(join(root2, "test/ui/a.spec.cjs"))).toBe(false);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("写后审计失败回滚:matrix 是目录导致写失败 → 源在、目标不留残留、matrix 原内容恢复", () => {
    const plan = seed(root, { matrix: "dir" });
    // 目录里先放一份「原内容」以便断言恢复语义(指向矩阵文件本身不可读,故这里用另一个文件的对照)
    const matrixDir = join(root, "docs/e2e-matrix.json");
    expect(existsSync(matrixDir)).toBe(true);
    writeFileSync(join(matrixDir, "keep.txt"), "keep");

    const res = mod.applyPlan(root, plan, { reviewed: true });
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect((res.errors ?? []).join("\n")).toMatch(/执行失败/);
    // 源文件仍在(未被搬走)
    expect(readFileSync(join(root, "test/ui/pending/a.spec.cjs"), "utf8")).toBe(GOOD_SPEC);
    // 本次新建的目标文件被删除,不留残留
    expect(existsSync(join(root, "test/ui/a.spec.cjs"))).toBe(false);
    expect(existsSync(join(root, "test/ui/fixtures/a.html"))).toBe(false);
    // matrix 未被破坏
    expect(readFileSync(join(matrixDir, "keep.txt"), "utf8")).toBe("keep");
  });

  it("审计失败回滚:matrix row.spec 指向含 skip 的既有文件 → 整体回滚到写盘前", () => {
    const plan = seed(root, { rowOverride: { spec: "test/ui/other.spec.cjs" } });
    const matrixBefore = readFileSync(join(root, "docs/e2e-matrix.json"), "utf8");
    // 预置 row.spec 指向的文件:count 对得上(2)但含 .skip( → validate 只告警,apply 后 audit 必失败
    writeFileSync(join(root, "test/ui/other.spec.cjs"), snip(GOOD_SPEC));
    const res = mod.applyPlan(root, plan, { reviewed: true });
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect((res.errors ?? []).join("\n")).toMatch(/审计失败:matrix row\.spec 含 skip\/only/);
    // 目标与 fixture 均无残留
    expect(existsSync(join(root, "test/ui/a.spec.cjs"))).toBe(false);
    expect(existsSync(join(root, "test/ui/fixtures/a.html"))).toBe(false);
    // matrix 原内容逐字恢复
    expect(readFileSync(join(root, "docs/e2e-matrix.json"), "utf8")).toBe(matrixBefore);
    // 源仍在
    expect(readFileSync(join(root, "test/ui/pending/a.spec.cjs"), "utf8")).toBe(GOOD_SPEC);
  });

  it("matrix 只读导致写失败 → 回滚且返回 rolledBack(非 root 时有效)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 忽略权限位
    const plan = seed(root, { matrix: "readonly" });
    const before = readFileSync(join(root, "docs/e2e-matrix.json"), "utf8");
    const res = mod.applyPlan(root, plan, { reviewed: true });
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(existsSync(join(root, "test/ui/a.spec.cjs"))).toBe(false);
    expect(readFileSync(join(root, "docs/e2e-matrix.json"), "utf8")).toBe(before);
  });
});

describe("CLI", () => {
  let root = "";
  beforeEach(() => {
    root = tmpRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(args: string[]) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: root });
  }

  it("缺 --plan → 非零退出并打印用法", () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("--plan");
    expect(`${r.stdout}${r.stderr}`).toContain("用法");
  });

  it("--help 退出 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--reviewed");
  });

  it("默认 dry-run:校验通过退出 0 且不写盘", () => {
    const plan = seed(root);
    writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
    const r = run(["--plan", "plan.json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("copy test/ui/pending/a.spec.cjs -> test/ui/a.spec.cjs");
    expect(existsSync(join(root, "test/ui/a.spec.cjs"))).toBe(false);
  });

  it("--apply 无 --reviewed → 拒绝,非零退出,不写盘", () => {
    const plan = seed(root);
    writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
    const r = run(["--plan", "plan.json", "--apply"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--reviewed");
    expect(existsSync(join(root, "test/ui/a.spec.cjs"))).toBe(false);
  });

  it("--apply --reviewed 成功:退出 0 且写盘", () => {
    const plan = seed(root);
    writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
    const r = run(["--plan", "plan.json", "--apply", "--reviewed"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("晋升完成");
    expect(existsSync(join(root, "test/ui/a.spec.cjs"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "docs/e2e-matrix.json"), "utf8")).cases).toHaveLength(2);
  });

  it("校验失败(dry-run)→ 退出 1 并逐条打印错误", () => {
    const plan = seed(root, { rowOverride: { count: 5 } });
    writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
    const r = run(["--plan", "plan.json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("expected 2, got 5");
  });

  it("--root 指定晋升根", () => {
    const plan = seed(root);
    const planFile = join(tmpRoot(), "plan.json");
    try {
      writeFileSync(planFile, JSON.stringify(plan));
      const r = spawnSync(process.execPath, [SCRIPT, "--plan", planFile, "--root", root], {
        encoding: "utf8",
        cwd: tmpdir(),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("校验通过");
    } finally {
      rmSync(dirname(planFile), { recursive: true, force: true });
    }
  });

  it("计划文件不存在 → 非零退出", () => {
    const r = run(["--plan", "nope.json"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("计划");
  });
});

describe("loadPlan / parseArgs", () => {
  it("loadPlan 读计划并抛坏 JSON", () => {
    const root = tmpRoot();
    try {
      const plan = seed(root);
      writeFileSync(join(root, "p.json"), JSON.stringify(plan));
      expect(mod.loadPlan(join(root, "p.json")).cases).toHaveLength(1);
      writeFileSync(join(root, "bad.json"), "{oops");
      expect(() => mod.loadPlan(join(root, "bad.json"))).toThrow(/解析失败/);
      writeFileSync(join(root, "nocases.json"), JSON.stringify({ x: 1 }));
      expect(() => mod.loadPlan(join(root, "nocases.json"))).toThrow(/缺 cases/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parseArgs 认全参数", () => {
    expect(mod.parseArgs(["--plan", "p.json", "--apply", "--reviewed", "--force", "--root", "/x"])).toMatchObject({
      plan: "p.json",
      apply: true,
      reviewed: true,
      force: true,
      root: "/x",
    });
  });
});

