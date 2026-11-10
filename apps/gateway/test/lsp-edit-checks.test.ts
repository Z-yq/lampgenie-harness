/**
 * 接线验证:主 agent file-tools 与进程内子代理 write/edit 成功路径都附加
 * `<diagnostics>`。用 tsserver 兜底(本机无 typescript-language-server),命令覆盖为不存在
 * 路径以强制走兜底分支。
 */
import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools } from "../src/file-tools.js";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";
import { MemoryJournal } from "@lampgenie/core";

const dirs: string[] = [];
const ORIGINAL_TS = process.env.GENIE_LSP_TYPESCRIPT_COMMAND;
process.env.GENIE_LSP_TYPESCRIPT_COMMAND = "/nonexistent/typescript-language-server";

const mk = () => { const d = mkdtempSync(join(tmpdir(), "lsp-wiring-")); dirs.push(d); return d; };

afterAll(async () => {
  if (ORIGINAL_TS === undefined) delete process.env.GENIE_LSP_TYPESCRIPT_COMMAND; else process.env.GENIE_LSP_TYPESCRIPT_COMMAND = ORIGINAL_TS;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function toolsOf(root: string, lsp: { enabled: boolean; format?: boolean; timeoutMs?: number }) {
  const journal = new MemoryJournal();
  const tools = createFileTools({ root, journal, sessionId: "t-lsp", lsp });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { exec: (name: string, args: unknown) => byName.get(name)!.execute(args) as Promise<string> };
}

describe("主 agent file-tools × LSP 诊断", () => {
  it("write_file 引入类型错 → 返回 <diagnostics>(行号/严重级/消息);修复后不追加", async () => {
    const root = mk();
    const { exec } = toolsOf(root, { enabled: true, format: false, timeoutMs: 3000 });
    const bad = await exec("write_file", { path: "a.ts", content: 'const n: number = "x";\n' });
    expect(bad).toContain("已创建 a.ts");
    expect(bad).toContain('<diagnostics file="a.ts">');
    expect(bad).toContain("L1:7 error TS2322:");
    expect(bad).toContain("not assignable to type 'number'");

    const good = await exec("edit_file", { path: "a.ts", old_string: 'const n: number = "x";', new_string: "const n: number = 1;" });
    expect(good).toContain("已编辑 a.ts");
    expect(good).not.toContain("<diagnostics");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const n: number = 1;\n");
  }, 20_000);

  it("lsp 关闭(缺省低层语义)= 结果与旧版一致,无诊断块", async () => {
    const root = mk();
    const journal = new MemoryJournal();
    const tools = createFileTools({ root, journal, sessionId: "t-plain" });
    const write = tools.find((t) => t.name === "write_file")!;
    const out = await write.execute({ path: "a.ts", content: 'const n: number = "x";\n' }) as string;
    expect(out).not.toContain("<diagnostics");
  }, 10_000);
});

describe("进程内子代理 worker write × LSP 诊断", () => {
  it("write_file 工具结果携带诊断(与主 agent 同语义)", async () => {
    const dir = mk();
    const file = join(dir, "sub.ts");
    let step = 0;
    const backend = new LlmLoopBackend({
      llm: { async chat() {
        step++;
        if (step === 1) {
          return { content: "写文件", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: file, content: 'const s: string = 42;\n' }) }] };
        }
        return { content: "完成" };
      } } as never,
      roots: [dir], workdir: dir, role: "worker",
      lsp: { enabled: true, format: false, timeoutMs: 3000 },
      onLoopEvent: (e) => {
        if (e.kind === "tool.result") toolResults.push(String(e.payload.content ?? ""));
      },
    });
    const toolResults: string[] = [];
    let result: { ok: boolean } | undefined;
    await backend.spawn({ taskId: "lsp-sub", instructions: "写一个 TS 文件", workdir: dir, permissions: "sandbox" }, (e) => {
      if (e.type === "result") result = e.result as { ok: boolean };
    });
    const deadline = Date.now() + 10_000;
    while (!result && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(result?.ok).toBe(true);
    expect(toolResults.join("\n")).toContain("<diagnostics");
    expect(toolResults.join("\n")).toContain("TS2322");
  }, 20_000);
});
