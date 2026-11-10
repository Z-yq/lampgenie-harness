import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

// step-137 消息流视觉分层:内联脚本语法门 + 板色令牌/板式类名齐备 + 行调子与 JSON 着色真实行为。
// 契约守卫:面板是单文件模板页,样式层任何改动都必须先保证页面脚本可解析、七主题令牌不缺项。

// 从页面 HTML 里切出顶层函数源码(花括号配平),塞进 sandbox 执行——用于验证页面内函数真实行为。
function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

describe("step-137 视觉分层校验", () => {
  it("页面脚本可解析 + 令牌/板式齐备 + 行调子与 JSON 着色行为正确", async () => {
    const p = servePanel(7897, () => {});
    const res = await fetch("http://127.0.0.1:7897/");
    expect(res.status).toBe(200);
    const html = await res.text();

    // 1) 语法门:每个内联 script 必须能被 node:vm 编译
    const { Script } = await import("node:vm");
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((code, i) => {
      expect(() => new Script(code), "script#" + i + " 语法错误").not.toThrow();
    });

    // 2) 板色令牌(:root + light + 五套主题,至少 7 处定义)
    for (const tok of ["--surf-code", "--surf-term", "--surf-json", "--surf-hit", "--surf-card", "--surf-fail"]) {
      const n = (html.split(tok).length - 1);
      expect(n, tok + " 定义次数").toBeGreaterThanOrEqual(7);
    }
    // 3) 板式类名与行级调子 CSS 存在
    for (const cls of ["code-wrap is-code", "is-term", "is-json", "tl-err", "tl-warn", "tl-cmd", "gr-blk", "diag-box"]) {
      expect(html, cls).toContain(cls);
    }

    // 4) 行为:切出 lineToneOf / jsonStrEnd / jsonValueHtml / jsonLineHtml 在 sandbox 里跑
    const src = ["esc", "jsonStrEnd", "jsonValueHtml", "jsonLineHtml", "lineToneOf"]
      .map((n) => extractFn(html, n)).join("\n");
    const sandbox = {
      JSON_BS: String.fromCharCode(92), JSON_DQ: String.fromCharCode(34),
    };
    const api = new Function("sb", "with(sb){" + src + "\n;return {lineToneOf: lineToneOf, jsonLineHtml: jsonLineHtml};}")(
      sandbox,
    ) as {
      lineToneOf: (l: string, kind?: string) => string;
      jsonLineHtml: (l: string) => string;
    };

    // 行调子:错误/警告/命令行/注释/普通 各行归位(仅终端板 kind=term 生效)
    expect(api.lineToneOf("TypeError: x is undefined", "term")).toBe("tl-err");
    expect(api.lineToneOf("构建失败:3 个包", "term")).toBe("tl-err");
    expect(api.lineToneOf("(退出码非零:1)", "term")).toBe("tl-err");
    expect(api.lineToneOf("warning: unused var", "term")).toBe("tl-warn");
    expect(api.lineToneOf("$ pnpm build", "term")).toBe("tl-cmd");
    expect(api.lineToneOf("// 说明行", "term")).toBe("tl-dim");
    expect(api.lineToneOf("普通一行输出 xxx", "term")).toBe("");
    // 非终端板(源码/通用文本)不做行调子——避免正文里出现 error 字样被误标红
    expect(api.lineToneOf("TypeError: x is undefined")).toBe("");
    expect(api.lineToneOf("构建失败:3 个包", "code")).toBe("");

    // JSON 着色:key→jk,字符串值→js,数字→jn,布尔→jb
    const k = api.jsonLineHtml('  "file": "src/a.ts",');
    expect(k).toContain('<span class="jk">&quot;file&quot;</span>');
    expect(k).toContain('<span class="js">');
    expect(k).toContain("&quot;src/a.ts&quot;</span>");
    const ncol = api.jsonLineHtml('  "line": 42,');
    expect(ncol).toContain("42,</span>");
    const b = api.jsonLineHtml('  "ok": true,');
    expect(b).toContain('<span class="jb">');
    // 转义引号不误切(字符串里含 \" 时收尾定位要跳过)
    const escq = api.jsonLineHtml('  "msg": "say \\"hi\\"",');
    expect(escq).toContain("say");

    // 5) 板式真实产物:切出 codeLinesBlock/trBlockPreview/trRunCmd 及最小依赖桩,验终端板真的带上类名
    // foldTermFrames 必须一并切出:trBlockPreview 的 kind:"term" 路径直调它(2026-10-20 加入),
    // 漏切=沙箱里 ReferenceError(实测曾现);它自身零外部依赖,纯函数直切即可。
    const rsrc = ["codeLinesBlock", "trBlockPreview", "trRunCmd", "lineToneOf", "foldTermFrames"]
      .map((n) => extractFn(html, n)).join("\n");
    const stub = {
      esc: (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      hl: (m: string) => m,
      clip: (s: unknown, n: number) => String(s).slice(0, n),
      parseArgs: (s: unknown) => { try { return JSON.parse(String(s)); } catch { return null; } },
      ic: () => "", trChip: (t: string) => "<span class=tc>" + t + "</span>",
      trChipB: (l: string, v: unknown) => "<span class=tc>" + l + v + "</span>",
      exitBadge: (c: number) => "<span class=exit>" + c + "</span>",
      TR_CAP_CHARS: 40000, tkLineMap: () => new Map(),
    };
    const r = new Function("sb", "with(sb){" + rsrc + "\n;return {codeLinesBlock: codeLinesBlock, trRunCmd: trRunCmd};}")(stub) as {
      codeLinesBlock: (t: string, q: string, n: number, toks: unknown, opts?: { kind?: string; fail?: boolean }) => string;
      trRunCmd: (a: string, t: string, q: string, c: boolean) => string;
    };
    // 普通文本板:无 is-term,行不加调子
    const plain = r.codeLinesBlock("hello\nworld", "", 2, null);
    expect(plain).toContain('class="code-wrap"');
    expect(plain).not.toContain("is-term");
    // 终端板:is-term + 错误行 tl-err + 命令行 tl-cmd
    const termHtml = r.codeLinesBlock("$ pnpm build\nTypeError: boom\n正常一行", "", 3, null, { kind: "term" });
    expect(termHtml).toContain("code-wrap is-term");
    expect(termHtml).toContain('class="cl tl-cmd"');
    expect(termHtml).toContain('class="cl tl-err"');
    expect(termHtml).toContain('class="cl">正常一行');
    // run_cmd 非零退出码:整板红边(tc-fail)
    const failHtml = r.trRunCmd(JSON.stringify({ command: "pnpm tsc" }), "boom\n(退出码非零:1)", "", false);
    expect(failHtml).toContain("is-term tc-fail");
    // 成功 run_cmd:不挂 tc-fail
    const okHtml = r.trRunCmd(JSON.stringify({ command: "echo hi" }), "hi", "", false);
    expect(okHtml).toContain("is-term");
    expect(okHtml).not.toContain("tc-fail");

    await p.close();
  });
});