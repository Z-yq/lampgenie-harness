/**
 * 聊天消息文件路径 → IDE 打开 契约测试。
 * 做法同 panel-md-image.test.ts:servePanel 取真面板 HTML → 切出 PAGE 内源码 → new Function 求值(零构建链)。
 * 覆盖:路径扫描(cfScanText)/行号拆分/URL 与版本号不误链/markdown 相对链接/归一化/归属解析(最长前缀+越界)/
 * DOM 链接化幂等与容器跳过(迷你 DOM 桩)/PAGE 静态接线(MutationObserver + a.chat-file 委托)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { servePanel } from "../src/panel.js";

const PORT = 7941;

/** 从面板 HTML 里切出 cf 段源码(常量 + 函数到 cfProbeHit 结束)。 */
function extractCfBlock(html: string): string {
  const start = html.indexOf("const CF_BS = String.fromCharCode(92)");
  expect(start, "未找到 CF 段起点").toBeGreaterThan(0);
  const anchor = "function cfProbeHit(m) {";
  const ai = html.indexOf(anchor, start);
  expect(ai, "未找到 cfProbeHit").toBeGreaterThan(start);
  let depth = 0, started = false, j = ai;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(start, j);
}

type Part = { t: "text"; v: string } | { t: "path"; v: string; line: number } | { t: "link"; label: string; path: string; line: number };
type Hit = { pid: string; label: string; root: string; rel: string; line: number } | null;
type Api = {
  cfScanText: (s: string, noMd?: boolean) => Part[];
  cfSplitLine: (s: string) => { path: string; line: number };
  cfNormPath: (s: string) => string;
  cfResolvePath: (s: string) => Hit;
  linkifyFilePaths: (root: unknown) => number;
};

let api: Api;
const panel = servePanel(PORT, () => { /* 不需要 WS */ });
let pageHtml = "";

/* ---- 迷你 DOM 桩:只实现 linkifyFilePaths / cfLinkifyNode 触碰的面 ---- */
function makeDom() {
  type N = any;
  const isSelMatch = (el: N, sel: string) => {
    for (const one of String(sel).split(",")) {
      const s = one.trim();
      if (!s) continue;
      if (s.charAt(0) === ".") { if (String(el.className || "").split(/\s+/).indexOf(s.slice(1)) >= 0) return true; continue; }
      if (s.charAt(0) === "[") continue;
      if (String(el.nodeName || "").toLowerCase() === s.toLowerCase()) return true;
    }
    return false;
  };
  const mkText = (v: string): N => ({ nodeType: 3, nodeValue: v, parentNode: null });
  const mkEl = (tag: string): N => {
    const el: N = {
      nodeType: 1, nodeName: String(tag).toUpperCase(), className: "", children: [] as N[], parentNode: null as N,
      attrs: {} as Record<string, string>, _text: "",
      appendChild(n: N) {
        if (n.nodeType === 11) { for (const c of n.children.slice()) el.appendChild(c); n.children = []; return n; }
        n.parentNode = el; el.children.push(n); return n;
      },
      replaceChild(nw: N, old: N) {
        const i = el.children.indexOf(old);
        if (i < 0) throw new Error("replaceChild: not a child");
        if (nw.nodeType === 11) { const kids = nw.children.slice(); nw.children = []; for (const k of kids) { k.parentNode = el; } el.children.splice(i, 1, ...kids); }
        else { nw.parentNode = el; el.children[i] = nw; }
        old.parentNode = null;
        return old;
      },
      setAttribute(k: string, v: string) { el.attrs[k] = String(v); },
      getAttribute(k: string) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
      closest(sel: string) { let p: N = el; while (p && p.nodeType === 1) { if (isSelMatch(p, sel)) return p; p = p.parentNode; } return null; },
    };
    Object.defineProperty(el, "textContent", { get: () => el._text, set: (v: string) => { el._text = String(v); } });
    Object.defineProperty(el, "ownerDocument", { get: () => doc });
    return el;
  };
  const mkFrag = (): N => {
    const f: N = { nodeType: 11, children: [] as N[], appendChild(n: N) { f.children.push(n); return n; } };
    return f;
  };
  const allTexts = (n: N, out: N[]) => { if (n.nodeType === 3) { out.push(n); return out; }
    for (const c of (n.children || [])) allTexts(c, out); return out; };
  const doc: N = {
    createTextNode: (v: string) => mkText(v),
    createElement: (t: string) => mkEl(t),
    createDocumentFragment: () => mkFrag(),
    createTreeWalker(root: N, _w: number, _f: unknown) {
      const list = allTexts(root, []); let i = 0;
      return { nextNode: () => (i < list.length ? list[i++] : null) };
    },
  };
  const root = mkEl("div");
  return { root, doc, mkEl, mkText };
}

beforeAll(async () => {
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  pageHtml = html;
  const block = extractCfBlock(html);
  // ideNorm 是 PAGE 内既有纯函数(cfRootCands 依赖),按源码一并求值
  const normSrc = 'function ideNorm(p) { let s = String(p || ""); while (s.endsWith("/")) s = s.slice(0, -1); return s; }';
  const factory = new Function(
    "ideRoot", "projects", "sysMeta",
    normSrc + "\n" + block + "\nreturn { cfScanText, cfSplitLine, cfNormPath, cfResolvePath, linkifyFilePaths };",
  ) as (root: unknown, projects: unknown, sysMeta: unknown) => Api;
  api = factory(
    { pid: "p-rel", label: "rel", path: "/repo/rel" },
    [
      { id: "p-rel", label: "rel", path: "/repo/rel" },
      { id: "p-deep", label: "deep", path: "/repo/rel/nested/pkg" },
      { id: "p-other", label: "other", path: "/repo/other" },
    ],
    { repoRoot: "/repo/harness" },
  );
}, 30_000);

afterAll(async () => { await panel.close(); });

const paths = (out: Part[]) => out.filter((p) => p.t === "path") as Array<{ t: "path"; v: string; line: number }>;

describe("cfScanText 路径扫描", () => {
  it("① 裸相对路径 + 绝对路径都成段", () => {
    const out = api.cfScanText("看 apps/gateway/src/panel.ts 与 /repo/rel/docs/code-flow/34.png 两处");
    const ps = paths(out);
    expect(ps.map((p) => p.v)).toEqual(["apps/gateway/src/panel.ts", "/repo/rel/docs/code-flow/34.png"]);
  });

  it("② 带行号:path:12 → line=12,锚文本含行号", () => {
    const ps = paths(api.cfScanText("见 src/panel.ts:1234 处"));
    expect(ps).toHaveLength(1);
    expect(ps[0].v).toBe("src/panel.ts");
    expect(ps[0].line).toBe(1234);
  });

  it("③ markdown 相对链接 [文字](路径) → link 段(标签取文字)", () => {
    const out = api.cfScanText("参考 [流程文档](docs/a.md) 与 [带行](src/x.ts:9)");
    const ls = out.filter((p) => p.t === "link") as Array<{ t: "link"; label: string; path: string; line: number }>;
    expect(ls.map((l) => l.label + "|" + l.path + "|" + l.line)).toEqual([
      "流程文档|docs/a.md|0",
      "带行|src/x.ts|9",
    ]);
  });

  it("④ 不链 http(s)/mailto/版本号/时间/纯数字", () => {
    const cases = [
      "https://example.com/a/b.ts",
      "http://x.io/readme.md",
      "mailto:dev@x.io",
      "版本 v1.2.3 已发布",
      "会议 12:30 开始",
      "仅数字 12345",
      "a.b",
    ];
    for (const c of cases) expect(paths(api.cfScanText(c)), c).toHaveLength(0);
  });

  it("⑤ 非白名单扩展名不链(如 .xyz/.lock)", () => {
    expect(paths(api.cfScanText("看 foo.xyz 和 pnpm.lock"))).toHaveLength(0);
  });

  it("⑥ noMd(pre/code 内):不解析 markdown 字面,裸路径仍链", () => {
    const out = api.cfScanText("[x](docs/a.md) 与 src/a.ts", true);
    expect(out.filter((p) => p.t === "link")).toHaveLength(0);
    // markdown 目标的字面(紧跟 ]() 也不链,避免改代码字面;裸路径照链
    expect(paths(out).map((p) => p.v)).toEqual(["src/a.ts"]);
  });

  it("⑦ 尾标点/右括号不入路径", () => {
    const ps = paths(api.cfScanText("(见 src/panel.ts)。下一句"));
    expect(ps.map((p) => p.v)).toEqual(["src/panel.ts"]);
  });
});

describe("cfNormPath / cfSplitLine", () => {
  it("归一化:反斜杠、引号、尾标点、反引号包裹", () => {
    expect(api.cfNormPath("`apps\\gateway\\src\\panel.ts`")).toBe("apps/gateway/src/panel.ts");
    expect(api.cfNormPath('"docs/a.md",')).toBe("docs/a.md");
    expect(api.cfNormPath("<src/b.ts>")).toBe("src/b.ts");
  });

  it("拆行号仅在扩展名命中时生效", () => {
    expect(api.cfSplitLine("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
    expect(api.cfSplitLine("12:30")).toEqual({ path: "12:30", line: 0 });
  });
});

describe("cfResolvePath 归属解析", () => {
  it("① 绝对路径按最长前缀命中项目(嵌套项目优先于父项目)", () => {
    expect(api.cfResolvePath("/repo/rel/nested/pkg/src/a.ts")).toMatchObject({ pid: "p-deep", rel: "src/a.ts" });
    expect(api.cfResolvePath("/repo/rel/docs/b.md")).toMatchObject({ pid: "p-rel", rel: "docs/b.md" });
    expect(api.cfResolvePath("/repo/harness/apps/gateway/src/panel.ts")).toMatchObject({ pid: "__harness__", rel: "apps/gateway/src/panel.ts" });
  });

  it("② 相对路径走当前 ideRoot", () => {
    expect(api.cfResolvePath("apps/gateway/src/panel.ts:77")).toMatchObject({ pid: "p-rel", rel: "apps/gateway/src/panel.ts", line: 77 });
  });

  it("③ 越界 ../ 与未注册根 → null(negative)", () => {
    expect(api.cfResolvePath("../../etc/passwd")).toBeNull();
    expect(api.cfResolvePath("/etc/passwd")).toBeNull();
    expect(api.cfResolvePath("/repo/rel/../other/a.ts")).toBeNull(); // 绝对路径里的 .. 也判越界
    expect(api.cfResolvePath("/no/such/root/a.ts")).toBeNull();
  });
});

describe("linkifyFilePaths DOM 链接化", () => {
  it("① 文本节点包成 a.chat-file(data-path/data-line),原文字保留", () => {
    const d = makeDom();
    d.root.appendChild(d.mkText("改 src/panel.ts:88 与 docs/a.md"));
    expect(api.linkifyFilePaths(d.root)).toBe(1);
    const anchors = d.root.children.filter((c: any) => c.nodeType === 1);
    expect(anchors).toHaveLength(2);
    expect(anchors[0].getAttribute("data-path")).toBe("src/panel.ts");
    expect(anchors[0].getAttribute("data-line")).toBe("88");
    expect(anchors[1].getAttribute("data-path")).toBe("docs/a.md");
    expect(d.root.children.filter((c: any) => c.nodeType === 3).map((c: any) => c.nodeValue).join("|")).toBe("改 | 与 ");
  });

  it("② 幂等:二次调用 a.chat-file 数量不变(a 内文本被跳过)", () => {
    const d = makeDom();
    d.root.appendChild(d.mkText("src/a.ts 与 b/c.ts"));
    api.linkifyFilePaths(d.root);
    const n1 = d.root.children.filter((c: any) => c.nodeType === 1).length;
    api.linkifyFilePaths(d.root);
    const n2 = d.root.children.filter((c: any) => c.nodeType === 1).length;
    expect(n2).toBe(n1);
    expect(n1).toBe(2);
  });

  it("③ 跳过 a/script/style/textarea 容器(negative)", () => {
    for (const tag of ["a", "script", "style", "textarea"]) {
      const d = makeDom();
      const box = d.mkEl(tag);
      d.root.appendChild(box);
      box.appendChild(d.mkText("src/a.ts"));
      expect(api.linkifyFilePaths(d.root), tag).toBe(0);
    }
  });

  it("④ pre/code 内裸路径仍可点,markdown 字面不被解析", () => {
    const d = makeDom();
    const pre = d.mkEl("pre");
    d.root.appendChild(pre);
    pre.appendChild(d.mkText("[x](docs/a.md) src/a.ts"));
    api.linkifyFilePaths(d.root);
    const anchors = pre.children.filter((c: any) => c.nodeType === 1);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    const ps = anchors.map((a: any) => a.getAttribute("data-path"));
    expect(ps).toContain("src/a.ts");
    expect(ps.indexOf("docs/a.md")).toBeLessThan(0);
  });

  it("⑤ 早退:短文本/无点文本零包裹", () => {
    const d = makeDom();
    d.root.appendChild(d.mkText("abc"));
    d.root.appendChild(d.mkText("没有扩展名的一串中文"));
    expect(api.linkifyFilePaths(d.root)).toBe(0);
  });
});

describe("PAGE 静态接线契约", () => {
  it("① MutationObserver 挂 #chatBody + 60ms debounce + 处理期 disconnect", () => {
    expect(pageHtml).toContain("new MutationObserver");
    expect(pageHtml).toMatch(/cfObs\.observe\(box, \{ childList: true, subtree: true, characterData: true \}\)/);
    expect(pageHtml).toContain("cfTimer = setTimeout(cfPump, 60)");
    expect(pageHtml).toMatch(/cfObs\.disconnect\(\)/);
    expect(pageHtml).toMatch(/cfObserveChat\(\)/);
  });

  it("② 点击委托:a.chat-file 与 #chatBody 内 a.cite 都走 openPathInIde", () => {
    expect(pageHtml).toContain('closest("a.chat-file")');
    expect(pageHtml).toContain("openPathInIde(cfA.dataset.path");
    expect(pageHtml).toContain('a.closest("#chatBody")');
    // 非聊天视图仍保留旧浮层(negative)
    expect(pageHtml).toContain("fvOpen(a.dataset.path, Number(a.dataset.line)); return;");
  });

  it("③ 未改 mdToHtml / renderCodeBlock / mdInlineScan(围栏分支零改动)", () => {
    expect(pageHtml).toContain("function mdToHtml(text, q, io)");
    expect(pageHtml).toContain("function renderCodeBlock(lines, lang0)");
    expect(pageHtml).toContain("function mdInlineScan(s, depth, io)");
    // 链接化是渲染后补锚:mdToHtml 体内不得出现 chat-file
    const mdStart = pageHtml.indexOf("function mdToHtml(text, q, io)");
    const mdEnd = pageHtml.indexOf("function ", mdStart + 10);
    expect(pageHtml.slice(mdStart, mdEnd)).not.toContain("chat-file");
  });

  it("④ 缺失路径不改 IDE 状态:探针未命中只 toast(negative)", () => {
    expect(pageHtml).toContain("function cfProbeHit(m)");
    expect(pageHtml).toMatch(/if \(!okFile\) \{ toast\("打不开 "/);
    // cfOpenNow 只在探针命中后被调用
    const probe = extractCfBlock(pageHtml).slice(extractCfBlock(pageHtml).indexOf("function cfProbeHit"));
    expect(probe).toContain("cfOpenNow(rec.hit");
  });
});
