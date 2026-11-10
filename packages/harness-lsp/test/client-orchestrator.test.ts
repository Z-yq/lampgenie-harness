import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withLspClient } from "../src/manager.js";
import { discoverServer, languageRouteOf, findExecutable } from "../src/servers.js";
import { checkEditedFile, editCheckSuffix } from "../src/diagnose.js";
import { externalFormat } from "../src/format.js";
import { disposeAllLspClients } from "../src/manager.js";
import { resolveLspSettings } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));
const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "harness-lsp-")); dirs.push(d); return d; };
const ORIGINAL_PY = process.env.GENIE_LSP_PYTHON_COMMAND;
const ORIGINAL_TS = process.env.GENIE_LSP_TYPESCRIPT_COMMAND;

afterAll(async () => {
  await disposeAllLspClients();
  if (ORIGINAL_PY === undefined) delete process.env.GENIE_LSP_PYTHON_COMMAND; else process.env.GENIE_LSP_PYTHON_COMMAND = ORIGINAL_PY;
  if (ORIGINAL_TS === undefined) delete process.env.GENIE_LSP_TYPESCRIPT_COMMAND; else process.env.GENIE_LSP_TYPESCRIPT_COMMAND = ORIGINAL_TS;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("LSP client(fake server,真实 stdio 协议)", () => {
  it("didOpen → publishDiagnostics 收包;didChange 后诊断更新", async () => {
    process.env.GENIE_LSP_PYTHON_COMMAND = `${process.execPath} ${FIXTURE}`;
    const root = mk();
    const abs = join(root, "x.py");
    writeFileSync(abs, "x = 1\nBAD = 2\n", "utf8");
    const route = languageRouteOf(abs)!;
    const server = discoverServer(route)!;
    expect(server).not.toBeNull();

    const first = await withLspClient(server, root, 3000, async (c) => {
      await c.syncDocument(abs, route.languageId, "x = 1\nBAD = 2\n");
      return c.collectDiagnostics(abs, 2000);
    });
    expect(first).not.toBeNull();
    expect(first!.map((d) => [d.line, d.severity, String(d.code)])).toEqual([[2, "error", "FAKE001"]]);

    const second = await withLspClient(server, root, 3000, async (c) => {
      await c.syncDocument(abs, route.languageId, "x = 1\ny = 2\n");
      return c.collectDiagnostics(abs, 2000);
    });
    expect(second).toEqual([]);
  }, 15_000);
});

describe("checkEditedFile 编排", () => {
  it("LSP 格式化(真往返)→ 写回磁盘 → 诊断针对格式化后内容", async () => {
    process.env.GENIE_LSP_PYTHON_COMMAND = `${process.execPath} ${FIXTURE}`;
    const root = mk();
    const abs = join(root, "fmt.py");
    writeFileSync(abs, "x = 1   \nBAD = 2\n", "utf8");
    const r = await checkEditedFile({ root, absPath: abs, settings: { enabled: true, timeoutMs: 3000 } });
    expect(r.formatted).toBe(true);
    expect(r.checker).toBe("lsp");
    expect(readFileSync(abs, "utf8")).toBe("x = 1\nBAD = 2\n");
    expect(r.rendered).toContain('<diagnostics file="fmt.py">');
    expect(r.rendered).toContain("L2:1 error FAKE001: found BAD token");

    writeFileSync(abs, "z = 3   \nBAD = 4\n", "utf8");
    const suffix = await editCheckSuffix({ root, absPath: abs, settings: { enabled: true, timeoutMs: 3000 } });
    expect(suffix).toContain("(保存格式化已应用)");
    expect(suffix).toContain("<diagnostics");
    expect(suffix).toContain("L2:");
  }, 15_000);

  it("TS:无 language server 时走编译器兜底(真类型错→修复后无诊断)", async () => {
    process.env.GENIE_LSP_TYPESCRIPT_COMMAND = "/nonexistent/typescript-language-server";
    const root = mk();
    const abs = join(root, "a.ts");
    writeFileSync(abs, 'const n: number = "x";\n', "utf8");
    const bad = await checkEditedFile({ root, absPath: abs, settings: { enabled: true, format: false, timeoutMs: 3000 } });
    expect(bad.checker).toBe("tsc");
    expect(bad.diagnostics.some((d) => String(d.code) === "TS2322" && d.line === 1)).toBe(true);
    expect(bad.rendered).toContain("error TS2322");

    writeFileSync(abs, "const n: number = 1;\n", "utf8");
    const good = await checkEditedFile({ root, absPath: abs, settings: { enabled: true, format: false, timeoutMs: 3000 } });
    expect(good.checker).toBe("tsc");
    expect(good.diagnostics).toEqual([]);
    expect(good.rendered).toBeNull();
  }, 20_000);

  it("fail-soft:server 命令不存在=不抛错、不阻塞、无诊断块", async () => {
    process.env.GENIE_LSP_PYTHON_COMMAND = "/nonexistent/python-lsp";
    const root = mk();
    const abs = join(root, "x.py");
    writeFileSync(abs, "x = 1\n", "utf8");
    const r = await checkEditedFile({ root, absPath: abs, settings: { enabled: true, timeoutMs: 500 } });
    expect(r.checker).toBe("none");
    expect(r.rendered).toBeNull();
    expect(readFileSync(abs, "utf8")).toBe("x = 1\n");
  }, 10_000);

  it("settings 缺省=关闭(低层语义);显式 {} = 开启", async () => {
    expect(resolveLspSettings(undefined).enabled).toBe(false);
    expect(resolveLspSettings({}).enabled).toBe(true);
    expect(resolveLspSettings({ enabled: false }).enabled).toBe(false);
  });
});

describe("外部 formatter 兜底", () => {
  it("Python:black 在 PATH 时从 stdin 格式化(缺失=null,跳过)", async () => {
    if (!findExecutable("black")) return; // 环境无 black:如实跳过,不造假
    const out = await externalFormat({ text: "x=1\n", absPath: "/tmp/x.py", root: "/tmp", family: "py", timeoutMs: 3000 });
    expect(out?.via).toBe("black");
    expect(out?.text).toContain("x = 1");
  }, 10_000);
});
