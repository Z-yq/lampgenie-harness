import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePythonFile } from "../src/adapters/python";

describe("D12/D20 Python structural(轻量解析器)", () => {
  it("2026-10-22 P1 spawn 边:Process(target=fn)/Thread(target=fn) 成边(launcher→worker)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-"));
    const rel = "master.py";
    writeFileSync(join(dir, rel), [
      "from multiprocessing import Process",
      "",
      "def worker_main():",
      "    pass",
      "",
      "def run_master():",
      "    p = Process(target=worker_main, args=(1,))",
      "    p.start()",
    ].join("\n"));
    const r = await parsePythonFile(dir, rel);
    const spawn = r.edges.find((x) => x.toName === "worker_main");
    expect(spawn).toBeDefined(); // 旧图完全看不见 launcher→worker
    expect(spawn!.from).toContain("run_master");
    rmSync(dir, { recursive: true, force: true });
  });

  it("def/class 提取+self 归属调用+tier=structural", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-"));
    const rel = "svc.py";
    writeFileSync(join(dir, rel), [
      "class Service:",
      "    def run(self):",
      "        return self.prepare()",
      "",
      "    def prepare(self):",
      "        return 1",
      "",
      "def standalone(x):",
      "    return standalone(x - 1) if x > 0 else 0",
    ].join("\n"));
    const r = await parsePythonFile(dir, rel);
    const names = r.symbols.map((s) => s.name);
    expect(names).toContain("run");
    expect(names).toContain("prepare");
    expect(names).toContain("standalone");
    // run → prepare(self 归属,ast 档)
    const e = r.edges.find((x) => x.toName === "prepare")!;
    expect(e.tier).toBe("structural");
    expect(e.evidenceKind).toBe("ast");
    expect(e.from).toContain("Service.run");
    rmSync(dir, { recursive: true, force: true });
  });

  it("type hint 有则取,无则不猜(D20)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py2-"));
    writeFileSync(join(dir, "m.py"), "def f(a: int, b, c=1):\n    pass\n");
    const r = await parsePythonFile(dir, "m.py");
    const sig = r.symbols[0]!.signature!;
    const a = sig.params.find((p) => p.name === "a")!;
    const b = sig.params.find((p) => p.name === "b")!;
    expect(a.type).toBe("int");
    expect(b.type).toBeUndefined(); // 无 hint:不猜
    rmSync(dir, { recursive: true, force: true });
  });

  it("多行签名 def(tree-sitter 补盲):不误归前一个兄弟函数(2026-10-14 实仓实测确认 render_memory_block)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py3-"));
    const rel = "render.py";
    writeFileSync(join(dir, rel), [
      "def period_start(days: int = 7) -> str:",
      "    return str(days)",
      "",
      "",
      "def render_memory_block(recall: dict[str, int] | None, *,",
      "                        include_title: bool = True) -> str:",
      "    return str(recall)",
      "",
    ].join("\n"));
    const r = await parsePythonFile(dir, rel);
    const rmb = r.symbols.find((s) => s.name === "render_memory_block");
    expect(rmb).toBeTruthy(); // 多行签名 def 必须被 tree-sitter 补盲捞到
    expect(rmb!.container).toBeUndefined(); // 顶层函数:不得误归前面的 period_start
    expect(rmb!.id).toBe(`${rel}#render_memory_block`);
    expect(rmb!.line).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("多行签名嵌套 def:容器按 AST 行界取最内层", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py4-"));
    const rel = "nested.py";
    writeFileSync(join(dir, rel), [
      "class Handler:",
      "    def dispatch(self,",
      "                 req):",
      "        def inner(payload,",
      "                  flag=False):",
      "            return flag",
      "        return inner(req)",
      "",
    ].join("\n"));
    const r = await parsePythonFile(dir, rel);
    const dispatch = r.symbols.find((s) => s.name === "dispatch");
    const inner = r.symbols.find((s) => s.name === "inner");
    expect(dispatch).toBeTruthy();
    expect(inner).toBeTruthy();
    expect(inner!.container).toBe("dispatch"); // 最内层包含,不跳层归 Handler
    expect(inner!.id).toBe(`${rel}#dispatch.inner`);
    rmSync(dir, { recursive: true, force: true });
  });

  it("真实 Python 仓冒烟:能解析出符号(self 归属);设 CODESENSE_PY_CORPUS 指向任一 py 仓即可跑", async () => {
    const GENIE = process.env.CODESENSE_PY_CORPUS || "";
    if (!GENIE) return; // 未提供语料目录时跳过(不造假)
    // 选一个存在的 py 文件
    const { readdirSync, statSync } = await import("node:fs");
    const find = (d: string): string | null => {
      for (const f of readdirSync(d)) {
        const full = join(d, f);
        if (statSync(full).isDirectory()) { const r = find(full); if (r) return r; }
        else if (f.endsWith(".py") && statSync(full).size > 2000) return full;
      }
      return null;
    };
    const pyFile = find(GENIE);
    if (!pyFile) return; // 环境无素材时跳过(不造假)
    const rel = pyFile.replace(GENIE + "/", "");
    const r = await parsePythonFile(GENIE, rel);
    expect(r.symbols.length).toBeGreaterThan(0);
    expect(r.symbols.every((s) => s.line > 0)).toBe(true);
  }, 30_000);
});

describe("多行签名函数体+跨文件候选(2026-10-14 校验轮实仓实测确认)", () => {
  it("多行签名 def 的函数体也扫调用边(build_evidence_pack 形态:此前调用边全 0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-ml-"));
    const rel = "adapter.py";
    writeFileSync(join(dir, rel), [
      "class A1Agent:",
      "    def build_evidence_pack(self, user_id: str, max_events: int = 600,",
      "                            relation_hints=None) -> dict:",
      "        return self._pack(user_id)",
      "",
      "    def _pack(self, uid: str) -> dict:",
      "        return {\"u\": uid}",
      "",
    ].join("\n"));
    try {
      const r = await parsePythonFile(dir, rel);
      // 符号在(tree-sitter 补盲,既有行为)
      expect(r.symbols.map((s) => s.name)).toContain("build_evidence_pack");
      // 新增:函数体内的 self.x 调用边(此前 defRanges 不含多行签名 → 调用 0)
      const e = r.edges.find((x) => x.toName === "_pack");
      expect(e).toBeTruthy();
      expect(e!.from).toContain("build_evidence_pack");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("import 名单内的裸调用发跨文件候选(to=\"\");未 import 的不猜", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-xf-"));
    const rel = "page.py";
    writeFileSync(join(dir, rel), [
      "from render import render_block",
      "",
      "",
      "def render_page(r):",
      "    return render_block(r)",
      "",
      "def other(r):",
      "    return mystery_fn(r)",
      "",
    ].join("\n"));
    try {
      const r = await parsePythonFile(dir, rel);
      const cand = r.crossFileCandidates?.find((x) => x.toName === "render_block");
      expect(cand).toBeTruthy();
      expect(cand!.from).toContain("render_page");
      expect(cand!.to).toBe("");
      // 未 import 的名字不发射(避免为每个库函数发幻边)
      expect(r.crossFileCandidates?.some((x) => x.toName === "mystery_fn")).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("容器修复+括号多行 import(2026-10-14 校验轮二批实测确认)", () => {
  it("三引号字符串内容弹掉缩进栈后,AST 修复 container/id/kind(self 边恢复)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-cls-"));
    const rel = "agent.py";
    writeFileSync(join(dir, rel), [
      "class Agent:",
      "    PROMPT = \"\"\"说明文档:",
      "这一行顶格(字符串内容),会把 class 从正则缩进栈弹掉",
      "\"\"\"",
      "",
      "    def _coverage(self, ents):",
      "        return self._semantic_coverage(ents)",
      "",
      "    def _semantic_coverage(self, ents):",
      "        return set()",
      "",
    ].join("\n"));
    try {
      const r = await parsePythonFile(dir, rel);
      const cov = r.symbols.find((s) => s.name === "_coverage");
      expect(cov?.container).toBe("Agent");
      expect(cov?.kind).toBe("method");
      expect(cov?.id).toBe(`${rel}#Agent._coverage`);
      // self 边经修复后的 container 兄弟查找直连(ast 档)
      const e = r.edges.find((x) => x.toName === "_semantic_coverage");
      expect(e?.to).toContain("Agent._semantic_coverage");
      expect(e?.evidenceKind).toBe("ast");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("括号多行 from-import:名单行进 import 名单,发跨文件候选", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-pi-"));
    const rel = "app.py";
    writeFileSync(join(dir, rel), [
      "def handler(r):",
      "    from .render import (",
      "        render_block,",
      "        render_title as rt,",
      "    )",
      "    return render_block(r), rt(r)",
      "",
    ].join("\n"));
    try {
      const r = await parsePythonFile(dir, rel);
      const names = (r.crossFileCandidates ?? []).map((c) => c.toName).sort();
      expect(names).toContain("render_block");
 // RC-O:别名 import 的候选 toName 回落原名(render_title)——merge 层按
      // 目标符号名解析;旧语义 toName=绑定名 rt 必失配丢边(正是 redash 丢失形态)
      expect(names).toContain("render_title");
      expect(names).not.toContain("rt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("同模块多次 import 合并(deepwiki-open rag.py 实证:覆盖式 set 丢名)", () => {
  it("两次 from x import 不同函数:名单合并,两次懒导入调用都发跨文件候选", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-imp-"));
    try {
      writeFileSync(join(dir, "config.py"), "def get_embedder_type():\n    return 1\n\ndef get_embedder_config():\n    return 2\n");
      writeFileSync(join(dir, "rag.py"), [
        "class RAG:",
        "    def __init__(self):",
        "        from config import get_embedder_type",
        "        self.t = get_embedder_type()",
        "        if self.t:",
        "            from config import get_embedder_config",
        "            self.c = get_embedder_config()",
      ].join("\n"));
      const r = await parsePythonFile(dir, "rag.py");
      const names = (r.crossFileCandidates ?? []).map((c) => c.toName);
      expect(names).toContain("get_embedder_type"); // 修复前被第二次 import 覆盖丢失
      expect(names).toContain("get_embedder_config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
