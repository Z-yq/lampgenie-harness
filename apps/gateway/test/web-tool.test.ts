/**
 * step-119 web_fetch/web_search 单测:
 * - HTML→markdown 零依赖转换(标题/链接/列表/代码块/实体);
 * - SSRF 防护(回环/私网/链路本地/IPv6/域名白名单);
 * - 大小/超时/content-type 上限(mock server,allowPrivate 仅单测旁路);
 * - web_search provider 解析(未配置 fail-visible + custom endpoint 真跑)与三家 payload 映射;
 * - 两工具 isReadOnly/isConcurrencySafe 声明。
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createWebFetchTool,
  createWebSearchTool,
  fetchPublicPage,
  htmlToMarkdown,
  extractHtmlTitle,
  decodeHtmlEntities,
  isPublicIp,
  parseIpv6,
  assertFetchableUrl,
  resolveSearchProvider,
  mapExaPayload,
  mapPerplexityPayload,
  mapDeepseekPayload,
  mapCustomPayload,
  WebToolError,
} from "../src/web-tool.js";

const HTML_PAGE = `<!DOCTYPE html><html><head><title>示例 &amp; 文档</title>
<style>.x{color:red}</style><script>window.bad=true</script></head>
<body><h1>主标题</h1><p>正文 <a href="/docs?x=1&amp;y=2">文档链接</a> 与 <b>加粗</b>。</p>
<ul><li>第一项</li><li>第二项</li></ul>
<pre><code>const a = 1 &lt; 2;</code></pre>
<table><tr><th>名称</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table>
</body></html>`;

describe("HTML → markdown 零依赖转换", () => {
  it("保留标题层级/绝对链接/列表/代码块/表格,丢弃 script/style", () => {
    const md = htmlToMarkdown(HTML_PAGE, "https://example.com/page");
    expect(md).toContain("# 主标题");
    expect(md).toContain("[文档链接](https://example.com/docs?x=1&y=2)");
    expect(md).toContain("- 第一项");
    expect(md).toContain("const a = 1 < 2;");
    expect(md).toContain("名称 | 值");
    expect(md).not.toContain("window.bad");
    expect(md).not.toContain("color:red");
  });

  it("标题提取 + 实体解码", () => {
    expect(extractHtmlTitle(HTML_PAGE)).toBe("示例 & 文档");
    expect(decodeHtmlEntities("a &lt; b &#65; &#x1F600;")).toBe("a < b A 😀");
    expect(decodeHtmlEntities("&nbsp;|&#x110000;|")).toBe(" ||");
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
  });

  it("拒绝非法链接目标(javascript:)", () => {
    const md = htmlToMarkdown('<a href="javascript:alert(1)">点我</a>', "https://example.com/");
    expect(md).toBe("点我");
  });
});

describe("SSRF 防护(地址判定)", () => {
  it("拒绝回环/私网/链路本地/元数据/组播/文档段", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
      "100.100.100.200", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "192.0.2.1", "198.18.0.1",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it("拒绝 IPv6 回环/ULA/链路本地/IPv4-mapped/NAT64 私网", () => {
    for (const ip of [
      "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
      "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "64:ff9b::10.0.0.1", "2002:7f00:1::1",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIp("64:ff9b::8.8.8.8")).toBe(true);
  });

  it("IPv6 解析支持 :: 压缩与嵌入 IPv4", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("2001:db8::1")).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIpv6("not-an-ip")).toBeNull();
  });

  it("URL 校验拒 localhost/凭证/非 http(s)/域名白名单外", () => {
    expect(() => assertFetchableUrl("http://localhost:7861/")).toThrow(/SSRF/);
    expect(() => assertFetchableUrl("http://foo.localhost/")).toThrow(/SSRF/);
    expect(() => assertFetchableUrl("http://user:pass@example.com/")).toThrow(/凭证/);
    expect(() => assertFetchableUrl("file:///etc/passwd")).toThrow(/协议/);
    expect(() => assertFetchableUrl("https://evil.example/x", ["example.com"])).toThrow(/白名单/);
    expect(assertFetchableUrl("https://sub.example.com/x", ["example.com"]).hostname).toBe("sub.example.com");
  });

  it("工具层直接拒绝本地地址(无网络请求)", async () => {
    const tool = createWebFetchTool({ env: {} });
    for (const url of ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/"]) {
      const out = String(await tool.execute({ url }));
      expect(out, url).toMatch(/^错误:/);
      expect(out, url).toMatch(/SSRF|localhost/);
    }
  });
});

// ---------------------------------------------------------------------------
// mock HTTP server(127.0.0.1):allowPrivate 是 fetchPublicPage 的单测旁路
// ---------------------------------------------------------------------------

let server: Server;
let base = "";
const sockets = new Set<import("node:net").Socket>();
let lastSearchAuth = "";
let lastSearchBody = "";

const BIG = Buffer.alloc(3 * 1024 * 1024, "a");

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("error", () => {});
    res.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML_PAGE);
      return;
    }
    if (url.pathname === "/text") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("纯文本正文\n第二行");
      return;
    }
    if (url.pathname === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 3]));
      return;
    }
    if (url.pathname === "/big-declared") {
      res.writeHead(200, { "content-type": "text/html", "content-length": String(BIG.length) });
      res.end(BIG);
      return;
    }
    if (url.pathname === "/big-stream") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write(BIG.subarray(0, 1024 * 1024));
      res.write(BIG.subarray(1024 * 1024));
      res.end();
      return;
    }
    if (url.pathname === "/slow") {
      // 永不响应,直到超时后客户端断开
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (url.pathname === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    if (url.pathname === "/custom-search" && req.method === "POST") {
      lastSearchAuth = String(req.headers.authorization ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        lastSearchBody = Buffer.concat(chunks).toString("utf-8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          answer: "汇总答案",
          results: [
            { title: "结果 A", url: "https://example.com/a", snippet: "摘要 A" },
            { title: "结果 B", url: "https://example.com/b", description: "摘要 B" },
            { title: "重复 A", url: "https://example.com/a", snippet: "重复" },
          ],
        }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("mock server 未取得端口");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("web_fetch 抓取与上限(mock server)", () => {
  it("抓取 HTML → markdown,带 title/status/bytes/length", async () => {
    const out = await fetchPublicPage(`${base}/ok`, { allowPrivate: true });
    expect(out.status).toBe(200);
    expect(out.ok).toBe(true);
    expect(out.title).toBe("示例 & 文档");
    expect(out.content).toContain("# 主标题");
    expect(out.bytes).toBeGreaterThan(0);
    expect(out.length).toBe(out.content.length);
    expect(out.truncated).toBe(false);
  });

  it("纯文本原样返回", async () => {
    const out = await fetchPublicPage(`${base}/text`, { allowPrivate: true });
    expect(out.content).toContain("纯文本正文");
    expect(out.title).toBe("");
  });

  it("重定向逐跳校验后跟随", async () => {
    const out = await fetchPublicPage(`${base}/redirect`, { allowPrivate: true });
    expect(out.finalUrl).toBe(`${base}/ok`);
    expect(out.content).toContain("# 主标题");
  });

  it("重定向上限明确报错", async () => {
    await expect(fetchPublicPage(`${base}/loop`, { allowPrivate: true, maxRedirects: 2 }))
      .rejects.toMatchObject({ code: "blocked_url" });
  });

  it("Content-Length 超上限提前拒绝", async () => {
    await expect(fetchPublicPage(`${base}/big-declared`, { allowPrivate: true, maxBytes: 1024 }))
      .rejects.toMatchObject({ code: "too_large" });
  });

  it("无 Content-Length 的流式超限截断并标记", async () => {
    const out = await fetchPublicPage(`${base}/big-stream`, { allowPrivate: true, maxBytes: 4096 });
    expect(out.truncated).toBe(true);
    expect(out.truncatedBy).toBe("bytes");
    expect(out.bytes).toBeLessThanOrEqual(4096);
  });

  it("超时明确报错", async () => {
    const started = Date.now();
    await expect(fetchPublicPage(`${base}/slow`, { allowPrivate: true, timeoutMs: 400 }))
      .rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  it("content-type 白名单拒绝二进制", async () => {
    await expect(fetchPublicPage(`${base}/binary`, { allowPrivate: true }))
      .rejects.toMatchObject({ code: "unsupported_content_type" });
  });

  it("content 超字符上限截断并标记", async () => {
    const out = await fetchPublicPage(`${base}/ok`, { allowPrivate: true, maxChars: 20 });
    expect(out.truncated).toBe(true);
    expect(out.truncatedBy).toBe("chars");
    expect(out.content).toContain("内容已截断");
  });
});

describe("web_search provider 解析与映射", () => {
  it("未配置 provider → fail-visible(列 env 名)", () => {
    const resolution = resolveSearchProvider({});
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toContain("未配置");
      expect(resolution.error).toContain("EXA_API_KEY");
      expect(resolution.error).toContain("GENIE_WEB_SEARCH_ENDPOINT");
    }
  });

  it("显式 provider 缺 key → 明确报错", () => {
    const resolution = resolveSearchProvider({ GENIE_WEB_SEARCH_PROVIDER: "exa" });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.error).toContain("provider=exa 缺少 key");
  });

  it("工具 execute 未配置 → 错误文本(不抛异常)", async () => {
    // searchTimeoutMs 压低:未配置 provider 时走 DDG 静态兜底,假网下要等连接超时;
    // 本用例只验「错误文本 fail-visible、不抛异常」,不需要真的等到真实超时。
    const tool = createWebSearchTool({ env: {}, searchTimeoutMs: 800 });
    const out = String(await tool.execute({ query: "test" }));
    expect(out).toMatch(/^错误:/);
    expect(out).toContain("未配置");
  });

  it("custom endpoint 真跑:key 从 env 透传,结果归一/去重/截断", async () => {
    const tool = createWebSearchTool({
      env: {
        GENIE_WEB_SEARCH_PROVIDER: "custom",
        GENIE_WEB_SEARCH_ENDPOINT: `${base}/custom-search`,
        GENIE_WEB_SEARCH_KEY: "test-key",
      } as NodeJS.ProcessEnv,
    });
    const out = String(await tool.execute({ query: "示例查询", max_results: 2 }));
    const parsed = JSON.parse(out) as {
      provider: string; query: string; count: number;
      results: { title: string; url: string; snippet: string }[];
    };
    expect(parsed.provider).toBe("custom");
    expect(parsed.query).toBe("示例查询");
    expect(parsed.count).toBe(2);
    expect(parsed.results[0]).toEqual({ title: "结果 A", url: "https://example.com/a", snippet: "摘要 A" });
    expect(parsed.results[1]).toEqual({ title: "结果 B", url: "https://example.com/b", snippet: "摘要 B" });
    expect(lastSearchAuth).toBe("Bearer test-key");
    expect(JSON.parse(lastSearchBody)).toMatchObject({ query: "示例查询", max_results: 2 });
  });

  it("Exa payload:highlights 首个非空作 snippet", () => {
    const mapped = mapExaPayload({
      results: [
        { url: "https://a.example/1", title: "A", highlights: ["", " 命中段落 "] },
        { url: "javascript:alert(1)", title: "bad" },
      ],
    });
    expect(mapped.results).toEqual([{ title: "A", url: "https://a.example/1", snippet: "命中段落" }]);
  });

  it("Perplexity payload:search_results 优先 + answer", () => {
    const mapped = mapPerplexityPayload({
      choices: [{ message: { content: "生成答案" } }],
      search_results: [{ title: "P", url: "https://p.example/1", snippet: "P 摘要" }],
      citations: ["https://ignored.example/"],
    });
    expect(mapped.answer).toBe("生成答案");
    expect(mapped.results).toEqual([{ title: "P", url: "https://p.example/1", snippet: "P 摘要" }]);
  });

  it("DeepSeek payload:web_search_tool_result + citations 拼 snippet", () => {
    const mapped = mapDeepseekPayload({
      content: [
        {
          type: "text",
          text: "检索结论",
          citations: [{ url: "https://d.example/1", cited_text: "被引段落" }],
        },
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", url: "https://d.example/1", title: "D" },
            { type: "web_search_result", url: "https://d.example/2", title: "D2" },
          ],
        },
      ],
    });
    expect(mapped.answer).toBe("检索结论");
    expect(mapped.results).toEqual([
      { title: "D", url: "https://d.example/1", snippet: "被引段落" },
      { title: "D2", url: "https://d.example/2", snippet: "" },
    ]);
  });

  it("自定义 payload:data/items 数组兼容", () => {
    expect(mapCustomPayload({ data: [{ name: "N", link: "https://c.example/1", content: "C" }] }).results)
      .toEqual([{ title: "N", url: "https://c.example/1", snippet: "C" }]);
    expect(mapCustomPayload([{ title: "root", url: "https://c.example/2" }]).results)
      .toEqual([{ title: "root", url: "https://c.example/2", snippet: "" }]);
  });
});

describe("工具声明(权限/并发)", () => {
  it("两工具均只读且并发安全", () => {
    const fetchTool = createWebFetchTool({ env: {} });
    const searchTool = createWebSearchTool({ env: {} });
    for (const tool of [fetchTool, searchTool]) {
      expect(tool.isReadOnly?.({})).toBe(true);
      expect(tool.isConcurrencySafe?.({})).toBe(true);
    }
  });

  it("参数 schema 暴露 url / query", () => {
    const fetchTool = createWebFetchTool({ env: {} });
    const searchTool = createWebSearchTool({ env: {} });
    expect((fetchTool.parameters as { required: string[] }).required).toContain("url");
    expect((searchTool.parameters as { required: string[] }).required).toContain("query");
  });

  it("WebToolError 保留分类", () => {
    const err = new WebToolError("x", "blocked_url");
    expect(err.code).toBe("blocked_url");
    expect(err).toBeInstanceOf(Error);
  });
});
