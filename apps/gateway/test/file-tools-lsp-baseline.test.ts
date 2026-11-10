/**
 * 接线验证:主 agent file-tools 的 write/edit 走「写前 baseline + 写后 delta」,
 * 只把**新增** ERROR 附在工具结果后;已有错误不刷屏。
 * 用 tsc 兜底(本机无 typescript-language-server),命令覆盖为不存在路径以强制走兜底分支。
 */
import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools } from "../src/file-tools.js";
import { MemoryJournal } from "@lampgenie/core";

const dirs: string[] = [];
const ORIGINAL_TS = process.env.GENIE_LSP_TYPESCRIPT_COMMAND;
process.env.GENIE_LSP_TYPESCRIPT_COMMAND = "/nonexistent/typescript-language-server";

const mk = () => { const d = mkdtempSync(join(tmpdir(), "lsp-baseline-")); dirs.push(d); return d; };

afterAll(() => {
  if (ORIGINAL_TS === undefined) delete process.env.GENIE_LSP_TYPESCRIPT_COMMAND; else process.env.GENIE_LSP_TYPESCRIPT_COMMAND = ORIGINAL_TS;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function toolsOf(root: string, lsp: { enabled: boolean; format?: boolean; timeoutMs?: number; baseline?: boolean }) {
  const journal = new MemoryJournal();
  const tools = createFileTools({ root, journal, sessionId: "t-baseline", lsp });
  const byName = new Map(tools.map((t) => [t.name, t] as const));
  return { exec: (name: string, args: unknown) => byName.get(name)!.execute(args) as Promise<string> };
}

const BAD = 'const n: number = "x";\n';

describe(" 写前 baseline × 写后 delta", () => {
  it("新文件写错 → 全量报(基线为空)", async () => {
    const root = mk();
    const { exec } = toolsOf(root, { enabled: true, format: false, timeoutMs: 3000 });
    const out = await exec("write_file", { path: "a.ts", content: BAD });
    expect(out).toContain("已创建 a.ts");
    expect(out).toContain("error TS2322");
  }, 30_000);

  it("覆写已存在且带旧错误的文件 → 旧错误不报(行漂移也不报)", async () => {
    const root = mk();
    const { exec } = toolsOf(root, { enabled: true, format: false, timeoutMs: 3000 });
    // 先建一个带错误的文件(用作 baseline 来源)
    await exec("write_file", { path: "b.ts", content: BAD });
    // 覆写:错误仍在,只是被前置注释行推后(行号漂移)
    const out = await exec("write_file", { path: "b.ts", content: "// head\n// head2\n// head3\n" + BAD });
    expect(out).toContain("已覆写 b.ts");
    expect(out).not.toContain("<diagnostics");
    expect(readFileSync(join(root, "b.ts"), "utf8")).toContain("// head3");
  }, 30_000);

  it("edit_file 引入新错误 → 只报新的那条", async () => {
    const root = mk();
    const { exec } = toolsOf(root, { enabled: true, format: false, timeoutMs: 3000 });
    const clean = "const a = 1;\n";
    await exec("write_file", { path: "c.ts", content: clean });
    // 局部编辑把干净行换成类型错
    const out = await exec("edit_file", { path: "c.ts", old_string: "const a = 1;", new_string: 'const a: number = "s";' });
    expect(out).toContain("已编辑 c.ts");
    expect(out).toContain("error TS2322");
  }, 30_000);

  it("edit_file 在旧错误仍在的情况下只改无关行 → 不重复报旧错误", async () => {
    const root = mk();
    const { exec } = toolsOf(root, { enabled: true, format: false, timeoutMs: 3000 });
    await exec("write_file", { path: "d.ts", content: BAD + "const ok = 1;\n" });
    const out = await exec("edit_file", { path: "d.ts", old_string: "const ok = 1;", new_string: "const ok = 2;" });
    expect(out).toContain("已编辑 d.ts");
    expect(out).not.toContain("<diagnostics");
  }, 30_000);

  it("修掉旧错误 → 无诊断块", async () => {
    const root = mk();
    const { exec } = toolsOf(root, { enabled: true, format: false, timeoutMs: 3000 });
    await exec("write_file", { path: "e.ts", content: BAD });
    const out = await exec("edit_file", { path: "e.ts", old_string: 'const n: number = "x";', new_string: "const n: number = 1;" });
    expect(out).not.toContain("<diagnostics");
  }, 30_000);

  it("baseline:false → 旧行为(覆写仍全量报旧错误)", async () => {
    const root = mk();
    const { exec } = toolsOf(root, { enabled: true, format: false, timeoutMs: 3000, baseline: false });
    await exec("write_file", { path: "f.ts", content: BAD });
    const out = await exec("write_file", { path: "f.ts", content: "// x\n" + BAD });
    expect(out).toContain('<diagnostics file="f.ts">');
    expect(out).toContain("error TS2322");
  }, 30_000);

  it("仓库内既有文件(baseline 有错)+ 新文件 → 两条链路各自正确", async () => {
    const root = mk();
    const existing = join(root, "g.ts");
    writeFileSync(existing, BAD, "utf8");
    const { exec } = toolsOf(root, { enabled: true, format: false, timeoutMs: 3000 });
    // 未 read_file 前拒绝覆写(保鲜闸)→ 说明 baseline 采集发生在围栏判定之后
    const denied = await exec("write_file", { path: "g.ts", content: "// y\n" + BAD });
    expect(denied).toContain("错误:");
    expect(readFileSync(existing, "utf8")).toBe(BAD);
  }, 30_000);
});
