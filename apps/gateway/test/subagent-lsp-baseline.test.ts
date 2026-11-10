/**
 * M108 收尾:进程内子代理(workerWriteTools)的 write_file / edit_file 也走
 * 「写前 baseline + 写后 delta」——只报新增 ERROR,旧错误不刷屏;baseline:false 回旧行为。
 * 与主 agent file-tools 同序:baseline 采集必须在 writeFileSync 之前。
 * 用 tsc 兜底(本机无 typescript-language-server),命令覆盖为不存在路径以强制走兜底分支。
 */
import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";

const dirs: string[] = [];
const ORIGINAL_TS = process.env.GENIE_LSP_TYPESCRIPT_COMMAND;
process.env.GENIE_LSP_TYPESCRIPT_COMMAND = "/nonexistent/typescript-language-server";

const mk = () => { const d = mkdtempSync(join(tmpdir(), "sub-lsp-baseline-")); dirs.push(d); return d; };

afterAll(() => {
  if (ORIGINAL_TS === undefined) delete process.env.GENIE_LSP_TYPESCRIPT_COMMAND; else process.env.GENIE_LSP_TYPESCRIPT_COMMAND = ORIGINAL_TS;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BAD = 'const n: number = "x";\n';
const BAD_NEW = 'const k: string = 42;\n';

type Step = { name: string; args: Record<string, unknown> };

/** 驱动一个 worker 子代理:按 steps 依次发出工具调用(首步可含 read_file 过编辑保鲜闸),收集 tool.result。 */
async function runWorker(dir: string, steps: Step[], lsp: { enabled: boolean; format?: boolean; timeoutMs?: number; baseline?: boolean }) {
  let i = 0;
  const toolResults: string[] = [];
  const backend = new LlmLoopBackend({
    llm: { async chat() {
      const s = steps[i++];
      if (!s) return { content: "完成" };
      return { content: "调用工具", toolCalls: [{ id: "c" + i, name: s.name, arguments: JSON.stringify(s.args) }] };
    } } as never,
    roots: [dir], workdir: dir, role: "worker",
    lsp,
    onLoopEvent: (e) => {
      if (e.kind === "tool.result") toolResults.push(String(e.payload.content ?? ""));
    },
  });
  let result: { ok: boolean } | undefined;
  await backend.spawn({ taskId: "sub-lsp-baseline", instructions: "按步骤改文件", workdir: dir, permissions: "sandbox" }, (e) => {
    if (e.type === "result") result = e.result as { ok: boolean };
  });
  const deadline = Date.now() + 10_000;
  while (!result && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { result, out: toolResults.join("\n---\n"), results: toolResults };
}

const LSP = { enabled: true, format: false, timeoutMs: 3000 };

describe("进程内子代理 × 写前 baseline / 写后 delta", () => {
  it("write_file 覆写带旧类型错的文件、只改注释 → 不报旧错误(行漂移也不报)", async () => {
    const dir = mk();
    writeFileSync(join(dir, "a.ts"), BAD, "utf8");
    const { result, out } = await runWorker(dir, [
      { name: "read_file", args: { path: join(dir, "a.ts") } },
      { name: "write_file", args: { path: join(dir, "a.ts"), content: "// head\n// head2\n" + BAD } },
    ], LSP);
    expect(result?.ok).toBe(true);
    expect(out).toContain("已写入");
    expect(out).not.toContain("<diagnostics");
  }, 30_000);

  it("write_file 引入新的类型错 → 只报新增那条", async () => {
    const dir = mk();
    writeFileSync(join(dir, "b.ts"), "const ok = 1;\n", "utf8");
    const { out } = await runWorker(dir, [
      { name: "read_file", args: { path: join(dir, "b.ts") } },
      { name: "write_file", args: { path: join(dir, "b.ts"), content: "const ok = 1;\n" + BAD_NEW } },
    ], LSP);
    expect(out).toContain("<diagnostics");
    expect(out).toContain("TS2322");
  }, 30_000);

  it("edit_file 在旧错误仍在时只改无关行 → 不重复报旧错误", async () => {
    const dir = mk();
    writeFileSync(join(dir, "c.ts"), BAD + "const ok = 1;\n", "utf8");
    const { out } = await runWorker(dir, [
      { name: "read_file", args: { path: join(dir, "c.ts") } },
      { name: "edit_file", args: { path: join(dir, "c.ts"), old_string: "const ok = 1;", new_string: "const ok = 2;" } },
    ], LSP);
    expect(out).toContain("已编辑");
    expect(out).not.toContain("<diagnostics");
  }, 30_000);

  it("edit_file 引入新错误 → 报新增", async () => {
    const dir = mk();
    writeFileSync(join(dir, "d.ts"), "const a = 1;\n", "utf8");
    const { out } = await runWorker(dir, [
      { name: "read_file", args: { path: join(dir, "d.ts") } },
      { name: "edit_file", args: { path: join(dir, "d.ts"), old_string: "const a = 1;", new_string: 'const a: number = "s";' } },
    ], LSP);
    expect(out).toContain("TS2322");
  }, 30_000);

  it("baseline:false → 旧行为(覆写仍全量报旧错误)", async () => {
    const dir = mk();
    writeFileSync(join(dir, "e.ts"), BAD, "utf8");
    const { out } = await runWorker(dir, [
      { name: "read_file", args: { path: join(dir, "e.ts") } },
      { name: "write_file", args: { path: join(dir, "e.ts"), content: "// x\n" + BAD } },
    ], { ...LSP, baseline: false });
    expect(out).toContain("<diagnostics");
    expect(out).toContain("TS2322");
  }, 30_000);

  it("新文件 → 基线为空,写错全量报(与主 agent 同语义)", async () => {
    const dir = mk();
    const { out } = await runWorker(dir, [
      { name: "write_file", args: { path: join(dir, "f.ts"), content: BAD } },
    ], LSP);
    expect(out).toContain("<diagnostics");
    expect(out).toContain("TS2322");
  }, 30_000);
});
