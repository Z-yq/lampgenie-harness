/**
 * 堆预算自适应测试:①扩展名→语言档分类;②估算=基线+Σ系数×文件数(合成夹具精确对账);
 * ③tier 三档(ok/warn/risk 按预算比);④risk 降数解(MAX_FILES 下限/透传 env);⑤建议堆帽 clamp。
 * 环境变量(GENIE_SENSE_HEAP_MB/GENIE_SENSE_MAX_FILES)逐用例保存恢复,不泄漏。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estimateIndexMemory, applyBudgetReduce, budgetReduceEnv, extClassOf, MB_PER_FILE, BASELINE_MB, MIN_SCAN_LIMIT } from "../src/heap-budget.js";

const tmps: string[] = [];
function mkroot(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `csheap-${tag}-`));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  delete process.env.GENIE_SENSE_HEAP_MB;
  delete process.env.GENIE_SENSE_MAX_FILES;
});

const ENV_KEYS = ["GENIE_SENSE_HEAP_MB", "GENIE_SENSE_MAX_FILES"] as const;
function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  } finally {
    /* set 阶段不抛 */
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

/** 合成仓:nPy 个 .py + nTs 个 .ts(可选 nCpp 个 .cpp),每个 100 字节。 */
function fixture(nPy: number, nTs: number, nCpp = 0): string {
  const root = mkroot(`f${nPy}x${nTs}x${nCpp}`);
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  const body = "def f():\n    pass\n".slice(0, 100).padEnd(100, "#") + "\n";
  const tsBody = "export function f(): number { return 1; }".padEnd(100, "#") + "\n";
  const cppBody = "int f(int x) { return x; }\n".padEnd(100, "#") + "\n";
  for (let i = 0; i < nPy; i++) writeFileSync(join(src, `m${i}.py`), body);
  for (let i = 0; i < nTs; i++) writeFileSync(join(src, `m${i}.ts`), tsBody);
  for (let i = 0; i < nCpp; i++) writeFileSync(join(src, `m${i}.cpp`), cppBody);
  return root;
}

describe(" 堆预算自适应", () => {
  it("①扩展名→语言档分类(engine 扫描面全覆盖)", () => {
    expect(extClassOf("a.py")).toBe("py");
    expect(extClassOf("a.go")).toBe("go");
    expect(extClassOf("a.java")).toBe("java");
    expect(extClassOf("a.cpp")).toBe("cpp");
    expect(extClassOf("a.h")).toBe("cpp");
    expect(extClassOf("a.hpp")).toBe("cpp");
    expect(extClassOf("a.ts")).toBe("ts");
    expect(extClassOf("a.tsx")).toBe("ts");
    expect(extClassOf("a.mjs")).toBe("ts");
  });

  it("②估算=基线+Σ系数×文件数(40 py + 20 ts → 700+16+3=719)", async () => {
    const root = fixture(40, 20);
    await withEnv({ GENIE_SENSE_HEAP_MB: undefined }, async () => {
      const est = await estimateIndexMemory(root);
      expect(est.files).toBe(60);
      expect(est.byClass).toEqual({ ts: 20, go: 0, java: 0, py: 40, cpp: 0 });
      const want = Math.round(BASELINE_MB + MB_PER_FILE.py * 40 + MB_PER_FILE.ts * 20);
      expect(est.estMb).toBe(want);
      expect(est.tier).toBe("ok"); // 预算=进程堆帽×0.8(本机 2096→1677)≫719
      expect(est.reducedMaxFiles).toBeUndefined();
    });
  });

  it("③tier warn:预算的 75%~100% 区间贴线告警", async () => {
    const root = fixture(40, 20); // est 719
    await withEnv({ GENIE_SENSE_HEAP_MB: "900" }, async () => {
      const est = await estimateIndexMemory(root);
      expect(est.budgetMb).toBe(900);
      expect(est.estMb).toBeGreaterThan(900 * 0.75);
      expect(est.estMb).toBeLessThanOrEqual(900);
      expect(est.tier).toBe("warn");
    });
  });

  it("④tier risk:超预算→降数解+env 透传;解触下限时 overBudgetAfterReduce 如实", async () => {
    const root = fixture(2250, 0); // est 700+900=1600
    await withEnv({ GENIE_SENSE_HEAP_MB: "800" }, async () => {
      const est = await estimateIndexMemory(root);
      expect(est.tier).toBe("risk");
      expect(est.reducedMaxFiles).toBeDefined();
      // 解 =(800-700)/0.4 = 250 → clamp 到下限 300;300 仍超(700+120=820>800)→ overBudgetAfterReduce
      expect(est.reducedMaxFiles).toBe(MIN_SCAN_LIMIT);
      expect(est.reducedMaxFiles!).toBeLessThanOrEqual(est.files);
      expect(est.overBudgetAfterReduce).toBe(true);
      expect(est.notes.join("\n")).toContain("如实告警");
      // env 落地(applyBudgetReduce 直接写进程,budgetReduceEnv 返回键值供 fork)
      const saved = process.env.GENIE_SENSE_MAX_FILES;
      const reduced = applyBudgetReduce(est);
      expect(reduced).toBe(est.reducedMaxFiles);
      expect(process.env.GENIE_SENSE_MAX_FILES).toBe(String(reduced));
      if (saved === undefined) delete process.env.GENIE_SENSE_MAX_FILES;
      else process.env.GENIE_SENSE_MAX_FILES = saved;
      const forkEnv = budgetReduceEnv(est);
      expect(forkEnv).toEqual({ GENIE_SENSE_MAX_FILES: String(est.reducedMaxFiles) });
    });
  });

  it("⑤建议堆帽 clamp(1024~4096,256 整,est×1.35);超进程预算→risk 降数", async () => {
    const small = fixture(4, 0); // est 701.6→702 → ×1.35≈948 → clamp 1024
    // 6000 cpp(引擎扫描上限)→ est 700+0.55×6000=4000 → ×1.35=5400 → clamp 4096
    const big = fixture(0, 0, 6000);
    await withEnv({ GENIE_SENSE_HEAP_MB: undefined }, async () => {
      const e1 = await estimateIndexMemory(small);
      expect(e1.recommendedHeapMb).toBe(1024);
      const e2 = await estimateIndexMemory(big);
      expect(e2.recommendedHeapMb).toBe(4096);
      // est×1.35 > 4096;进程预算 1677 < est → risk 降数
      expect(e2.tier).toBe("risk");
      expect(e2.reducedMaxFiles).toBeDefined();
      expect(e2.overBudgetAfterReduce).toBeUndefined(); // (1677-700)/0.55=1776<6000 → 解在区间内
    });
  });
});
