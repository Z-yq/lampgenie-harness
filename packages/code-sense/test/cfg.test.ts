/**
 * 函数级 CFG:语句级控制流图——真实语句/条件菱形/是·否/循环回边/switch/try/
 * return·throw·break·continue/注释与常量说明/长函数分页。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFileCfgs, cfgJson, pickFunction, renderCfgDot, renderCfgMermaid, renderCfgText,
  type CfgFunction,
} from "../src/sensing/cfg";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cfg-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, "utf8");
  return root;
}

const PY = `"""调度器模块。"""
MAX_RETRY = 3

def dispatch(kind, items):
    """按类型分发任务。

    返回处理数量。
    """
    done = 0
    # 前置校验
    if not kind or not items:
        return 0
    elif kind == "skip":
        return -1
    for item in items:
        if item.startswith("#"):
            continue
        try:
            done += 1
            if done > 10:
                raise ValueError("overflow")
        except ValueError as exc:
            done = 0
            continue
        finally:
            done += 0
    return done
`;

const TS = `/** 调度器:按类型分发任务。 */
export const MAX_RETRY = 3;

/** 按类型分发任务(TS 版)。 */
export function dispatch(kind: string, items: string[]): number {
  let done = 0;
  // 前置校验
  if (!kind || items.length === 0) {
    return 0;
  } else if (kind === "skip") {
    return -1;
  }
  for (const item of items) {
    try {
      if (item.startsWith("#")) {
        continue;
      }
      switch (item) {
        case "a":
          done += 1;
          break;
        case "b":
          done += 2;
        default:
          done += 3;
      }
      if (done > MAX_RETRY) throw new Error("overflow");
    } catch (err) {
      console.warn("failed", err);
    } finally {
      done += 0;
    }
  }
  return done;
}

export const arrow = (x: number) => x > 0 ? x : -x;
`;

const GO = `package main

const MAX_RETRY = 3

func dispatch(kind string, items []string) int {
	done := 0
	if kind == "" || len(items) == 0 {
		return 0
	} else if kind == "skip" {
		return -1
	}
	for _, item := range items {
		if item == "#" {
			continue
		}
		switch item {
		case "a":
			done += 1
		case "b":
			done += 2
		default:
			done += 3
		}
		if done > MAX_RETRY {
			break
		}
	}
	return done
}
`;

const C = `#define MAX_RETRY 3
static int dispatch(const char *kind, const char **items, int n) {
  int done = 0, i;
  if (!kind || n == 0) {
    return 0;
  } else if (strcmp(kind, "skip") == 0) {
    return -1;
  }
  for (i = 0; i < n; i++) {
    if (items[i][0] == '#') continue;
    switch (items[i][0]) {
      case 'a': done += 1; break;
      case 'b': done += 2;
      default: done += 3; break;
    }
    do {
      done += 1;
    } while (done < 0);
    if (done > MAX_RETRY) break;
  }
  return done;
}
`;

const JAVA = `public class Sample {
  static final int MAX_RETRY = 3;
  public int dispatch(String kind, java.util.List<String> items) {
    int done = 0;
    if (kind == null || items.isEmpty()) {
      return 0;
    } else if (kind.equals("skip")) {
      return -1;
    }
    for (String item : items) {
      if (item.startsWith("#")) continue;
      switch (item) {
        case "a":
          done += 1;
          break;
        case "b":
          done += 2;
        default:
          done += 3;
      }
      try {
        if (done > MAX_RETRY) throw new RuntimeException("overflow");
      } catch (RuntimeException e) {
        done = 0;
        continue;
      } finally {
        done += 0;
      }
    }
    return done;
  }
}
`;

const labels = (fn: CfgFunction): string[] => fn.edges.map((e) => e.label ?? "").filter(Boolean);
const texts = (fn: CfgFunction): string => fn.nodes.map((n) => `${n.text}\n${n.code ?? ""}`).join("\n");

describe("cfg: python", () => {
  it("语句/条件/循环/try/return/raise 与文档说明", async () => {
    const root = fixture({ "sample.py": PY });
    try {
      const r = await buildFileCfgs(root, "sample.py");
      expect(r).not.toBeNull();
      const fn = pickFunction(r!.functions, "dispatch")!;
      expect(fn).toBeTruthy();
      expect(fn.name).toBe("dispatch");
      expect(fn.line).toBe(4);
      expect(fn.doc).toContain("按类型分发任务");
      expect(fn.notes.some((n) => n.title === "函数速览")).toBe(true);
      expect(fn.description.purposeSource).toBe("docstring");
      expect(fn.description.purpose).toContain("按类型分发任务");
      expect(fn.description.params.map((p) => p.name)).toEqual(expect.arrayContaining(["kind", "items"]));
      expect(fn.description.returns.length).toBeGreaterThan(0);
      expect(fn.description.keyConditions.some((c) => c.includes("not kind"))).toBe(true);
      expect(fn.description.keyConditions.some((c) => c.includes("→"))).toBe(true);
      expect(fn.description.loops.some((l) => l.includes("for item in items"))).toBe(true);
      expect(fn.description.details).toContain("返回处理数量");
      expect(fn.description.sideEffects).toEqual([]);
      // 真实语句文本在节点里(不是抽象标签)
      expect(texts(fn)).toContain("done += 1");
      expect(texts(fn)).toContain('raise ValueError("overflow")');
      expect(fn.stats.returns).toBe(3);
      expect(fn.stats.throws).toBe(1);
      expect(fn.stats.loops).toBe(1);
      expect(fn.stats.decisions).toBeGreaterThanOrEqual(4);
      // 是/否/循环/退出/返回/抛出/异常 边
      const ls = labels(fn);
      for (const l of ["是", "否", "循环", "退出", "返回", "抛出", "异常"]) expect(ls).toContain(l);
      // elif 链(否 → 第二个条件)
      const conds = fn.nodes.filter((n) => n.kind === "cond");
      expect(conds.length).toBeGreaterThanOrEqual(3);
      // 循环组/异常组
      expect(fn.groups.some((g) => g.kind === "loop")).toBe(true);
      expect(fn.groups.some((g) => g.kind === "try")).toBe(true);
      expect(fn.groups.some((g) => g.kind === "catch")).toBe(true);
      expect(fn.groups.some((g) => g.kind === "finally")).toBe(true);
      // 内联注释挂到下一个语句
      expect(fn.nodes.some((n) => n.comment?.includes("前置校验"))).toBe(true);
      expect(fn.stats.calls).toContain("startswith");
      // mermaid 文本包含形状/标签/类
      const mmd = renderCfgMermaid(fn);
      expect(mmd).toContain("flowchart TD");
      expect(mmd).toContain("是");
      expect(mmd).toContain("cfgCond");
      expect(mmd).toContain("subgraph");
      // 无分页阈值以下不产生 pages
      expect(fn.pages).toBeUndefined();
      expect(renderCfgText(fn, { mermaid: false })).toContain("函数级控制流图");
      expect(JSON.stringify(cfgJson(fn))).toContain("dispatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("模块常量被函数引用时进入说明节点", async () => {
    const root = fixture({
      "c.py": `LIMIT = 10\ndef f(x):\n    if x > LIMIT:\n        return LIMIT\n    return x\n`,
    });
    try {
      const r = await buildFileCfgs(root, "c.py");
      const fn = pickFunction(r!.functions, "f")!;
      const note = fn.notes.find((n) => n.title === "模块常量");
      expect(note?.lines.join("\n")).toContain("LIMIT = 10");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cfg: typescript", () => {
  it("switch/case/default、try/catch、for-of、arrow、JSDoc", async () => {
    const root = fixture({ "sample.ts": TS });
    try {
      const r = await buildFileCfgs(root, "sample.ts");
      const fn = pickFunction(r!.functions, "dispatch")!;
      expect(fn.doc).toContain("按类型分发任务(TS 版)");
      expect(fn.description.purposeSource).toBe("docstring");
      expect(fn.description.purpose).toContain("按类型分发任务(TS 版)");
      expect(fn.description.params.map((p) => p.name)).toEqual(expect.arrayContaining(["kind", "items"]));
      expect(fn.description.sideEffects.some((s) => s.category === "日志/输出" && s.name === "warn")).toBe(true);
      expect(fn.notes.some((n) => n.title === "模块常量" && n.lines.join().includes("MAX_RETRY = 3"))).toBe(true);
      const ls = labels(fn);
      for (const l of ["是", "否", "进入", "循环", "退出", "case \"a\"", "case \"b\"", "default", "异常", "返回", "抛出"]) expect(ls).toContain(l);
      expect(fn.groups.some((g) => g.kind === "catch")).toBe(true);
      expect(fn.groups.some((g) => g.kind === "finally")).toBe(true);
      // switch 的 fallthrough:case b → default
      expect(fn.edges.some((e) => (e.label ?? "") === "继续")).toBe(true);
      // 箭头函数(表达式体 → 合成 return)
      const arrow = pickFunction(r!.functions, "arrow")!;
      expect(arrow).toBeTruthy();
      expect(arrow.nodes.some((n) => n.kind === "return" && n.text.includes("x > 0"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cfg: go / c / java", () => {
  it("go: if/else、range 循环、switch", async () => {
    const root = fixture({ "sample.go": GO });
    try {
      const r = await buildFileCfgs(root, "sample.go");
      const fn = pickFunction(r!.functions, "dispatch")!;
      const ls = labels(fn);
      for (const l of ["是", "否", "进入", "循环", "退出", "case \"a\"", "default", "break"]) expect(ls).toContain(l);
      expect(fn.groups.some((g) => g.kind === "loop")).toBe(true);
      expect(fn.nodes.some((n) => n.text.includes("for _, item := range items"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("c: if/else、for、do-while、switch、#define 常量", async () => {
    const root = fixture({ "sample.c": C });
    try {
      const r = await buildFileCfgs(root, "sample.c");
      const fn = pickFunction(r!.functions, "dispatch")!;
      const ls = labels(fn);
      for (const l of ["是", "否", "进入", "循环", "退出", "case 'a'", "default", "continue", "break"]) expect(ls).toContain(l);
      // do-while:进入 + 继续 + 退出
      expect(ls).toContain("继续");
      expect(fn.groups.filter((g) => g.kind === "loop").length).toBe(2);
      expect(fn.doc).toBeUndefined(); // #define 不是函数说明
      expect(fn.notes.some((n) => n.title === "模块常量")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("java: if/else、enhanced-for、switch、try/catch/finally、throw", async () => {
    const root = fixture({ "Sample.java": JAVA });
    try {
      const r = await buildFileCfgs(root, "Sample.java");
      const fn = pickFunction(r!.functions, "Sample.dispatch")!;
      expect(fn.className).toBe("Sample");
      const ls = labels(fn);
      for (const l of ["是", "否", "进入", "循环", "退出", "case \"a\"", "default", "异常", "抛出", "continue"]) expect(ls).toContain(l);
      expect(fn.groups.some((g) => g.kind === "catch")).toBe(true);
      expect(fn.groups.some((g) => g.kind === "finally")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cfg: 长函数分页与诚实边界", () => {
  it("长函数分页:节点全量保留,跨页边有跳转桩", async () => {
    const body = Array.from({ length: 80 }, (_, i) => `    x${i} = ${i}\n    if x${i} > 10:\n        x${i} = x${i} - 1`).join("\n");
    const root = fixture({ "long.py": `def long_fn(x):\n    x0 = x\n${body}\n    return x79\n` });
    try {
      const r = await buildFileCfgs(root, "long.py");
      const fn = pickFunction(r!.functions, "long_fn")!;
      expect(fn.nodes.length).toBeGreaterThan(80);
      expect(fn.pages?.length).toBeGreaterThan(1);
      expect(fn.pages!.every((p) => p.mermaid.includes("flowchart TD"))).toBe(true);
      // 跨页桩(至少一处)
      expect(fn.pages!.some((p) => p.mermaid.includes("第 ") && /← 第|→ 第/.test(p.mermaid))).toBe(true);
      // 每个真实节点恰好归属一页(分页元数据;跨页桩不计)
      for (const n of fn.nodes) {
        expect(fn.pages!.filter((p) => p.nodeIds.includes(n.id)).length).toBe(1);
      }
      // 分页说明进入 knownLimits
      expect(fn.knownLimits.some((l) => l.includes("分页展示"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--max-nodes 显式上限:截断并如实登记", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `    x${i} = ${i}`).join("\n");
    const root = fixture({ "m.py": `def many():\n${body}\n` });
    try {
      const r = await buildFileCfgs(root, "m.py", { maxNodes: 10 });
      const fn = pickFunction(r!.functions, "many")!;
      expect(fn.truncated).toBe(true);
      expect(fn.nodes.length).toBeLessThanOrEqual(11);
      expect(fn.knownLimits.some((l) => l.includes("--max-nodes"))).toBe(true);
      expect(fn.pages).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("语法错误整文件拒收;不支持语言返回 null", async () => {
    const root = fixture({ "bad.ts": "export function broken( {", "x.rs": "fn main() {}" });
    try {
      expect(await buildFileCfgs(root, "bad.ts")).toBeNull();
      expect(await buildFileCfgs(root, "x.rs")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("空函数体:start → end;DOT/JSON 可导出", async () => {
    const root = fixture({ "e.py": "def empty():\n    pass\n" });
    try {
      const r = await buildFileCfgs(root, "e.py");
      const fn = pickFunction(r!.functions, "empty")!;
      expect(fn.nodes.some((n) => n.kind === "start")).toBe(true);
      expect(fn.nodes.some((n) => n.kind === "end")).toBe(true);
      expect(fn.edges.some((e) => e.label === "空函数体")).toBe(true);
      expect(renderCfgDot(fn)).toContain("digraph");
      expect(cfgJson(fn)).toMatchObject({ name: "empty", file: "e.py" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
