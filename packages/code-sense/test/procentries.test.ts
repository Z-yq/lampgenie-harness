/**
 * 进程入口扫描( P1):五语言形态面 + 路径过滤 + 索引缺席降级 + spawn 边联动。
 * 依据:agent_alpha webrtc_multiprocess_server.py(main@94 → run_master)在扇出榜 top-300 之外。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanProcessEntriesSync, renderProcessEntries } from "../src/sensing/procentries";

const TMP: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cs-procentries-"));
  TMP.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
afterEach(() => {
  for (const d of TMP.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FAKE_INDEX = (nodes: { name: string; file: string; line: number }[]) => ({
  version: 1 as const,
  root: "/x",
  gitHead: "",
  builtAt: 0,
  buildMs: 0,
  nodes: nodes.map((n) => ({ id: `${n.file}#${n.name}`, name: n.name, file: n.file, line: n.line, kind: "trunk" as const, outCount: 0, inCount: 0 })),
  edges: [],
  byFile: {},
  byName: Object.fromEntries([...new Set(nodes.map((n) => n.name))].map((name) => [name, nodes.filter((n) => n.name === name).map((n) => `${n.file}#${n.name}`)])),
});

describe("scanProcessEntriesSync 五语言形态面", () => {
  it("py __main__ 守卫:守卫行+块内调用符号解析(同文件优先);js require.main;package.json bin", () => {
    const dir = fixture({
      "launcher.py": [
        "import asyncio",
        "from worker_mod import worker_main",
        "def main():",
        "    return worker_main()",
        "if __name__ == \"__main__\":",
        "    asyncio.run(main())",
    ].join("\n"),
      "cli.cjs": "if (require.main === module) {\n  run();\n}\n",
      "package.json": JSON.stringify({ name: "t", bin: { "t-cli": "./cli.cjs" } }),
    });
    const idx = FAKE_INDEX([{ name: "main", file: "launcher.py", line: 3 }]);
    const r = scanProcessEntriesSync(dir, idx);
    const py = r.entries.find((e) => e.kind === "py-main");
    expect(py?.file).toBe("launcher.py");
    expect(py?.line).toBe(5);
    expect(py?.calls.join(",")).toContain("main"); // 同文件符号解析
    expect(r.entries.some((e) => e.kind === "js-bin" && e.file === "cli.cjs")).toBe(true);
    const bin = r.entries.find((e) => e.kind === "pkg-bin");
    expect(bin?.label).toContain("t-cli");
  });

  it("py 守卫单引号形态 + asyncio.run 特判(裸名回退)", () => {
    const dir = fixture({
      "svc.py": "def run():\n    pass\n\nif __name__ == '__main__':\n    run()\n",
    });
    const r = scanProcessEntriesSync(dir, null);
    const py = r.entries.find((e) => e.kind === "py-main");
    expect(py?.line).toBe(4);
    expect(py?.calls).toContain("run"); // 无索引=裸名
  });

  it("守卫行假阳性:文档注释/模式串里的 require.main/import.meta.main 不算入口(2026-10-26)", () => {
    const dir = fixture({
      "scanner.ts": [
        "/**",
        " * js/ts(node): `require.main === module` / `import.meta.main`(deno 形态)",
        " */",
        'const patterns = ["require.main === module", "import.meta.main"];',
        "export const x = patterns.length;",
      ].join("\n"),
      "real.cjs": "if (require.main === module) {\n  run();\n}\n",
    });
    const r = scanProcessEntriesSync(dir, null);
    expect(r.entries.filter((e) => e.kind === "js-bin").map((e) => e.file)).toEqual(["real.cjs"]);
  });

  it("c/go/java main 符号面(读索引);索引缺席=显式降级不猜", () => {
    const dir = fixture({ "placeholder.txt": "x\n" });
    const idx = FAKE_INDEX([
      { name: "main", file: "src/main.c", line: 10 },
      { name: "main", file: "cmd/foo/main.go", line: 5 },
      { name: "main", file: "src/App.java", line: 20 },
      { name: "main", file: "src/other.py", line: 1 }, // py main 不是进程入口面(守卫面才是)
    ]);
    const r = scanProcessEntriesSync(dir, idx);
    expect(r.entries.some((e) => e.kind === "c-main" && e.file === "src/main.c")).toBe(true);
    expect(r.entries.some((e) => e.kind === "go-main" && e.file === "cmd/foo/main.go")).toBe(true);
    expect(r.entries.some((e) => e.kind === "java-main" && e.file === "src/App.java")).toBe(true);
    expect(r.entries.some((e) => e.file === "src/other.py")).toBe(false);
    const r2 = scanProcessEntriesSync(dir, null);
    expect(r2.indexAvailable).toBe(false);
    expect(r2.entries.filter((e) => e.kind === "c-main" || e.kind === "go-main" || e.kind === "java-main")).toHaveLength(0);
  });

  it("scripts/测试降序但不滤(进程入口如实呈现);非产品路径滤;空仓=如实空态", () => {
    const dir = fixture({
      "scripts/audit_tool.py": "if __name__ == \"__main__\":\n    audit()\n",
      "server.py": "if __name__ == \"__main__\":\n    serve()\n",
    });
    const def = scanProcessEntriesSync(dir, null);
    // scripts 不滤(NON_PRODUCT_SEGS 语义不含它),但排序沉底——生产启动器在前
    expect(def.entries.map((e) => e.file)).toEqual(["server.py", "scripts/audit_tool.py"]);
    expect(def.filtered).toBe(0);
    const docs = fixture({ "docs/demo.py": "if __name__ == \"__main__\":\n    pass\n" });
    expect(scanProcessEntriesSync(docs, null).entries).toHaveLength(0); // docs=真过滤
    const empty = scanProcessEntriesSync(fixture({ "lib.py": "def f():\n    pass\n" }), null);
    expect(empty.entries).toHaveLength(0);
    expect(renderProcessEntries(empty)[0]!).toContain("无发现");
  });

  it("渲染:首节标签与箭头链(→ 调用符号)", () => {
    const dir = fixture({
      "web_server.py": "def main():\n    pass\n\nif __name__ == \"__main__\":\n    main()\n",
    });
    const idx = FAKE_INDEX([{ name: "main", file: "web_server.py", line: 1 }]);
    const lines = renderProcessEntries(scanProcessEntriesSync(dir, idx));
    expect(lines[0]).toContain("进程入口(1");
    expect(lines[1]).toContain("[py] web_server.py:4 __main__@4 → main");
  });
});
