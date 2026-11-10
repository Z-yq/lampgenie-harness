/**
 * M108 写后诊断升级:写前 baseline + 只报新增 ERROR。
 * 用 fake LSP(.py)+ 注入内容做真 checker 往返;纯函数层(subtractBaseline / renderDiagnostics)直测。
 */
import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEditedFile, collectBaselineDiagnostics, editCheckSuffix, makeLineMapper, renderDiagnostics, subtractBaseline } from "../src/diagnose.js";
import { disposeAllLspClients } from "../src/manager.js";
import { resolveLspSettings } from "../src/types.js";
import type { DiagnosticItem } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));
const ORIGINAL_PY = process.env.GENIE_LSP_PYTHON_COMMAND;
process.env.GENIE_LSP_PYTHON_COMMAND = `${process.execPath} ${FIXTURE}`;

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "harness-lsp-delta-")); dirs.push(d); return d; };

afterAll(async () => {
  await disposeAllLspClients();
  if (ORIGINAL_PY === undefined) delete process.env.GENIE_LSP_PYTHON_COMMAND; else process.env.GENIE_LSP_PYTHON_COMMAND = ORIGINAL_PY;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const err = (line: number, message: string, code = "E1", source = "fake"): DiagnosticItem =>
  ({ line, column: 1, severity: "error", code, message, source });
const warn = (line: number, message: string, code = "W1"): DiagnosticItem =>
  ({ line, column: 1, severity: "warning", code, message });

describe("subtractBaseline:同 message 去重 + 一对一消费", () => {
  it("baseline 2 个旧 error,写后仍有 → 全丢弃(空)", () => {
    const base = [err(3, "bad a"), err(7, "bad b")];
    expect(subtractBaseline(base, [err(3, "bad a"), err(7, "bad b")])).toEqual([]);
  });

  it("写后新增 1 条 → 只留这条", () => {
    const base = [err(3, "bad a")];
    const out = subtractBaseline(base, [err(3, "bad a"), err(9, "brand new")]);
    expect(out.map((d) => d.message)).toEqual(["brand new"]);
  });

  it("同 message 多条 baseline 只消费一次(不互相掩盖)", () => {
    const base = [err(3, "same")];
    const out = subtractBaseline(base, [err(3, "same"), err(20, "same")]);
    expect(out.map((d) => d.line)).toEqual([20]);
  });

  it("code/source 不同 = 不同诊断(不当 pre-existing)", () => {
    const out = subtractBaseline([err(3, "bad", "E1", "a")], [err(3, "bad", "E2", "a")]);
    expect(out).toHaveLength(1);
  });
});

describe("行位移对消(写前插 3 行 / 改行内容)", () => {
  it("makeLineMapper:前缀区不动,后缀区整体平移", () => {
    const map = makeLineMapper("a\nb\nc\n", "x\ny\nz\na\nb\nc\n");
    expect([map(1), map(2), map(3)]).toEqual([4, 5, 6]);
    expect(map(9)).toBe(12);
  });

  it("写前插 3 行 → 旧 error 行号漂移(3→6)仍被去重", () => {
    const base = [err(3, "bad token")];
    const out = subtractBaseline(base, [err(6, "bad token")], "l1\nl2\nBAD\n", "n1\nn2\nn3\nl1\nl2\nBAD\n");
    expect(out).toEqual([]);
  });

  it("漂移超出 ±2 容差且无文本映射 → 视为新增", () => {
    const out = subtractBaseline([err(3, "bad token")], [err(40, "bad token")]);
    expect(out).toHaveLength(1);
  });

  it("容差内(±2)认作 pre-existing", () => {
    expect(subtractBaseline([err(3, "m")], [err(5, "m")])).toEqual([]);
    expect(subtractBaseline([err(3, "m")], [err(6, "m")])).toHaveLength(1);
  });
});

describe("renderDiagnostics:只报 ERROR / 上限 / 转义 / note", () => {
  it("warning 缺省不输出;includeWarnings=true 才输出", () => {
    const items = [err(2, "boom"), warn(1, "unused")];
    expect(renderDiagnostics("a.ts", items)).toBe('<diagnostics file="a.ts">\nL2:1 error E1: boom\n</diagnostics>');
    expect(renderDiagnostics("a.ts", items, 20, { includeWarnings: true })).toContain("L1:1 warning W1: unused");
  });

  it("只有 warning 且未开启 includeWarnings → null(不追加)", () => {
    expect(renderDiagnostics("a.ts", [warn(1, "unused")])).toBeNull();
  });

  it(">20 条截断并注明 +N", () => {
    const items = Array.from({ length: 25 }, (_, i) => err(i + 1, `e${i}`));
    const block = renderDiagnostics("a.ts", items)!;
    expect(block).toContain("…(+5 more)");
    expect(block.split("\n").filter((l) => l.startsWith("L")).length).toBe(20);
  });

  it("控制字符折叠 + HTML 转义", () => {
    const block = renderDiagnostics("a.ts", [err(1, "bad\u0000<tag> & \u001bthing")])!;
    expect(block).toContain("bad <tag> & thing".replace("<", "&lt;").replace(">", "&gt;").replace("& ", "&amp; "));
    expect(block).not.toContain("\u0000");
    expect(block).not.toContain("\u001b");
  });

  it("字符预算 4096:超长消息被截断(块长 ≤ 4096)", () => {
    const items = Array.from({ length: 20 }, (_, i) => err(i + 1, "x".repeat(400)));
    const block = renderDiagnostics("a.ts", items)!;
    expect(block.length).toBeLessThanOrEqual(4096);
    expect(block).toContain("more)");
  });

  it("note 属性(baseline 不可用)写入块并转义", () => {
    const block = renderDiagnostics("a.ts", [err(1, "boom")], 20, { note: 'baseline 不可用,仅报当前 ERROR "x"' })!;
    expect(block.startsWith('<diagnostics file="a.ts" note="baseline 不可用,仅报当前 ERROR &quot;x&quot;">')).toBe(true);
  });
});

describe("checkEditedFile × baseline 端到端(fake LSP)", () => {
  const settings = { enabled: true, format: false, timeoutMs: 3000 };

  it("baseline 2 个旧 error 写后仍在 → 无 rendered;插 3 行漂移也被去重", async () => {
    const root = mk();
    const abs = join(root, "a.py");
    const before = "x = 1\nBAD = 2\ny = 3\nBAD = 4\n";
    writeFileSync(abs, before, "utf8");
    const base = await collectBaselineDiagnostics({ root, absPath: abs, text: before, settings });
    expect(base!.map((d) => d.line)).toEqual([2, 4]);

    const after = "n1 = 0\nn2 = 0\nn3 = 0\nx = 1\nBAD = 2\ny = 3\nBAD = 4\n";
    writeFileSync(abs, after, "utf8");
    const r = await checkEditedFile({ root, absPath: abs, settings, baseline: base, baselineText: before });
    expect(r.baseline).toBe("ok");
    expect(r.diagnostics.map((d) => d.line)).toEqual([5, 7]); // 写后全量仍在
    expect(r.newDiagnostics).toEqual([]);
    expect(r.rendered).toBeNull();

    const suffix = await editCheckSuffix({ root, absPath: abs, settings, baseline: base, baselineText: before });
    expect(suffix).toBe("");
  }, 20_000);

  it("写后新增 1 个 error → 只输出这条", async () => {
    const root = mk();
    const abs = join(root, "b.py");
    const before = "BAD = 1\n";
    writeFileSync(abs, before, "utf8");
    const base = await collectBaselineDiagnostics({ root, absPath: abs, text: before, settings });
    const after = "BAD = 1\nNEWBAD = 2\n";
    writeFileSync(abs, after, "utf8");
    const r = await checkEditedFile({ root, absPath: abs, settings, baseline: base, baselineText: before });
    expect(r.newDiagnostics.map((d) => d.line)).toEqual([2]);
    expect(r.rendered).toContain("L2:4 error FAKE001: found BAD token");
    expect(r.rendered).not.toContain("L1:");
  }, 20_000);

  it("新文件(baseline=[])→ 全量报 ERROR", async () => {
    const root = mk();
    const abs = join(root, "c.py");
    writeFileSync(abs, "BAD = 1\n", "utf8");
    const r = await checkEditedFile({ root, absPath: abs, settings, baseline: [], baselineText: "" });
    expect(r.newDiagnostics.map((d) => d.line)).toEqual([1]);
    expect(r.rendered).toContain("error FAKE001");
  }, 20_000);

  it("baseline 不可用(null)→ 块带 note,仍只报 ERROR,不阻塞", async () => {
    const root = mk();
    const abs = join(root, "d.py");
    writeFileSync(abs, "BAD = 1\nok = 2\n", "utf8");
    const r = await checkEditedFile({ root, absPath: abs, settings, baseline: null, baselineText: "x" });
    expect(r.baseline).toBe("unavailable");
    expect(r.rendered).toContain('note="baseline 不可用,仅报当前 ERROR"');
    expect(r.rendered).toContain("error FAKE001");
  }, 20_000);

  it("不传 baseline = 旧行为(全量报告)", async () => {
    const root = mk();
    const abs = join(root, "e.py");
    writeFileSync(abs, "BAD = 1\n", "utf8");
    const r = await checkEditedFile({ root, absPath: abs, settings });
    expect(r.baseline).toBe("off");
    expect(r.rendered).toContain("error FAKE001");
  }, 20_000);

  it("baseline:false = 旧行为(即使传了 baseline 也不对消)", async () => {
    const root = mk();
    const abs = join(root, "f.py");
    writeFileSync(abs, "BAD = 1\n", "utf8");
    const r = await checkEditedFile({ root, absPath: abs, settings: { ...settings, baseline: false }, baseline: [err(1, "found BAD token", "FAKE001", "fake-lsp")], baselineText: "BAD = 1\n" });
    expect(r.baseline).toBe("off");
    expect(r.rendered).toContain("error FAKE001");
  }, 20_000);

  it("非代码文件 / 关闭 LSP → 空串(与旧版一致)", async () => {
    const root = mk();
    const md = join(root, "a.md");
    writeFileSync(md, "# hi\n", "utf8");
    expect(await editCheckSuffix({ root, absPath: md, settings })).toBe("");
    expect(await collectBaselineDiagnostics({ root, absPath: md, text: "# hi\n", settings })).toEqual([]);
    const py = join(root, "g.py");
    writeFileSync(py, "BAD = 1\n", "utf8");
    expect(await editCheckSuffix({ root, absPath: py, settings: { enabled: false } })).toBe("");
    expect(await collectBaselineDiagnostics({ root, absPath: py, text: "BAD = 1\n", settings: { enabled: false } })).toBeNull();
  }, 20_000);
});

describe("settings 向后兼容", () => {
  it("新增 baseline/includeWarnings 有缺省,旧字段语义不变", () => {
    const s = resolveLspSettings({ enabled: true, maxDiagnostics: 5 });
    expect(s.baseline).toBe(true);
    expect(s.includeWarnings).toBe(false);
    expect(s.maxDiagnostics).toBe(5);
    expect(resolveLspSettings({ baseline: false }).baseline).toBe(false);
    expect(resolveLspSettings({ includeWarnings: true }).includeWarnings).toBe(true);
    expect(resolveLspSettings(undefined).baseline).toBe(true);
  });
});
