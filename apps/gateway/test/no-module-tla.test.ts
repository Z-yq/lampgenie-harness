/**
 * 模块级 TLA 禁入护栏(exit 13 坑第 5 次后)。
 * 背景:gateway 的 RSI store 族曾用「两跳动态 import + 顶层 await」解耦 runtime——该形态
 * 在 bundle 里退化为运行时解析,进启动路径即网关静默 exit 13(evidence-graph 11-12 / atlas
 * 11-14 / negkb+experiment+gap+defect-lineage 11-17,五犯)。 已全量改静态导入;
 * 本护栏扫描 src,阻止模块级 TLA 再被引入(函数内懒加载不受限——生产已证安全)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../src");

/** 模块级(列 0)顶层 await 形态:const x = await loadXxx / const x = await import(...)。 */
const MODULE_LEVEL_TLA = /^(?:const|let)\s+\w+(?:\s*:\s*[^=]+)?=\s*await\s+(?:load\w+\(\)|import\()/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "panel" || entry.name === "agent-wiring") out.push(...listTsFiles(p));
    } else if (entry.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("模块级 TLA 禁入(exit 13 护栏)", () => {
  it("src 下不得出现列 0 的 `const x = await loadXxx()/import(...)`(五犯坑防回归)", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (MODULE_LEVEL_TLA.test(line)) offenders.push(`${file.replace(SRC + "/", "")}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(offenders, `发现模块级 TLA(改静态 import;函数内懒加载不受限):\n${offenders.join("\n")}`).toEqual([]);
  });
});
