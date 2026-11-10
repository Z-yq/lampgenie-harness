import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { servePanel } from "../src/panel.js";

/** 附件端到端的结构+行为回归。
 * 真 UI 在 panel.ts 模板字符串内(浏览器侧脚本,code_index/code_sense 不可见),这里锁关键面:
 * 输入区真预览(图片缩略图/视频首帧 chip)/聊天流回看(媒体卡走 /uploads 读盘)/lightbox 三路关闭/
 * GET /uploads 的 Range + 越界防护/POST /upload 与 GET /uploads 前缀不互相打歪。
 * 落盘测试用临时 GENIE_REPO_ROOT(不污染真实仓 .genie/uploads)。 */
const TMP_ROOT = mkdtempSync(join(tmpdir(), "genie-att-test-"));
const OLD_ROOT = process.env.GENIE_REPO_ROOT;
process.env.GENIE_REPO_ROOT = TMP_ROOT;

const PORT = 7911;
const BASE = "http://127.0.0.1:" + PORT;
const panel = servePanel(PORT, () => {});

const upDir = join(TMP_ROOT, ".genie", "uploads", "vitest-att");
mkdirSync(upDir, { recursive: true });

afterAll(async () => {
  await panel.close();
  if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
  else process.env.GENIE_REPO_ROOT = OLD_ROOT;
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(): Promise<string> {
  await wait(120);
  const res = await fetch(BASE + "/");
  expect(res.status).toBe(200);
  return await res.text();
}

describe("附件:输入区预览 / 聊天流回看 / lightbox / /uploads 读盘", () => {
  it("B+F 输入区真预览与 lightbox 标记齐(缩略图/视频 chip/三路关闭/键盘可达)", async () => {
    const html = await fetchHtml();
    for (const marker of [
      // 分类型白名单与上限(明确拒绝,不静默丢弃)
      "const ATT_MAX_IMG = 8 * 1024 * 1024, ATT_MAX_VID = 50 * 1024 * 1024, ATT_MAX_TXT = 8 * 1024 * 1024",
      "const ATT_MAX_DOC = 64 * 1024 * 1024",
      "const ATT_TEXT_EXT = [",
      "const ATT_IMG_MIME = [", "const ATT_VID_MIME = [",
      "const ATT_DOC_EXT = [", "const ATT_DOC_MIME = [",
      "function attKind(name, mime)", "function attLimitOf(kind)", "function attSize(n)", "function attTag(name, mime)",
      "function attUpload(file)", "function attPostUpload(file, sid, extra)",
      'toast("不支持的类型:" + file.name', 'toast("附件超限:" + file.name',
      // preview 数据:图片 dataURL / 视频 objectUrl(移除时 revoke 防泄漏)
      "r.readAsDataURL(file)", "URL.createObjectURL(file)", "URL.revokeObjectURL(a.objectUrl)",
      "function attDrop(i)",
      // 输入区 chip:图片 40-48px 缩略图 + 视频首帧,点击开 lightbox
      '<img class="att-thumb"', 'class="att-chip att-media"',
      // 属性顺序不写死(缩略图带 tabindex/role/aria-label 后才是 data-alb):断言留给下方正则「同一标签内」校验
      'class="att-vthumb"', 'el.src = el.dataset.vsrc',
      // 容器换行 + 不溢出
      ".att-bar{display:flex;gap:6px;flex-wrap:wrap;padding:4px 2px;max-height:132px;overflow-y:auto",
      // lightbox:遮罩/关闭按钮/Esc/点遮罩 + 焦点回来源
      'id="attLightbox"', 'id="attLbClose"', 'id="attLbMedia"',
      ".att-lightbox{position:fixed;inset:0;z-index:150;background:var(--overlay)",
      "function attLightboxOpen(src, kind, name, meta, from)",
      "function attLightboxClose()",
      'e.target === box', 'e.key === "Escape" && box.classList.contains("on")',
      "src.focus()", 'box.setAttribute("aria-hidden", "true")',
      // 共用点击委托(同一点击语义覆盖输入区与聊天流两处)
      't.closest("[data-alb]")',
 // 附件数量上限 + 长文本粘贴转临时附件(对齐 ZCode)
      "const ATT_MAX_COUNT = 8",
      "const ATT_PASTE_TEXT_MIN_CHARS = 15 * 1024",
      "function attPasteTextAsFile(text)",
      "function attClipboardTabular(text)",
      '"pasted-text-"',
      "pastedText",
      // 文本附件 chip/卡可点开全文(lightbox 文本分支)
      'class="att-chip att-text"',
      ".att-lb-text{",
      ".att-chip.att-text{cursor:pointer}",
      "function attLbLoadText(src)",
    ]) {
      expect(html, "缺少标记:" + marker).toContain(marker);
    }
    // review nit:上面把「缩略图与 data-alb」拆成两条互不相关的断言会漏网——
    // 这里退回「同一标签内」校验(容忍属性顺序变化,但两者必须同属一个媒体标签)。
    // review 二轮:守卫必须覆盖全部三类媒体标签(输入区 img/video + 聊天流 img),只守 att-thumb 会漏。
    for (const [css, tag] of [["att-thumb", "img"], ["att-vthumb", "video"]]) {
      const tags = html.match(new RegExp("<" + tag + ' class="' + css + '"[^>]*>', "g")) || [];
      expect(tags.length, "未找到媒体标签:" + css).toBeGreaterThan(0);
      expect(tags.some((t) => t.indexOf("data-alb=") >= 0), css + " 必须自带 data-alb(lightbox 钩子)").toBe(true);
    }
  });

  it("B3 三条入口(选择/拖拽/粘贴)都汇入 attUpload;粘贴接受图片与视频", async () => {
    const html = await fetchHtml();
    expect(html).toContain('$("attInput").onchange = () => { for (const f of $("attInput").files) attUpload(f);');
    expect(html).toContain("for (const f of e.dataTransfer.files) attUpload(f);");
    expect(html).toContain('$("instruction").addEventListener("paste"');
    expect(html).toContain('if (ty.indexOf("image/") !== 0 && ty.indexOf("video/") !== 0) continue;');
    // 三条入口同判定同上限:类型/限额只在 attUpload 一处(入口不各自复制逻辑)
    expect(html.match(/function attUpload\(file\)/g)?.length).toBe(1);
    expect(html.match(/const kind = attKind\(file.name, file.type\)/g)?.length).toBe(1);
  });

  it("D 聊天流回看:媒体卡走 /uploads 读盘(旧事件无 preview 一样显示),文本卡保留", async () => {
    const html = await fetchHtml();
    for (const marker of [
      "function attRowHtml(list)",
      // 数据源:path → /uploads?path=(浏览器读不到 journal 绝对路径)
      'return "/uploads?path=" + encodeURIComponent(String(a.path)) + "&name="',
      "function attSrc(a)",
      // 图片真实缩略图 / 视频就地播放器 / 文本文件卡
      '<img class="att-cthumb"',
      '<video class="att-cvid" controls preload="metadata" src=',
      'class="att-zoom"',
      ".att-card img.att-cthumb{width:72px",
      // message.user 渲染接线(旧「图/文」字卡已换成 attRowHtml)
      "const attsHtml = (ev.payload.attachments || []).length",
      "? attRowHtml(ev.payload.attachments)",
      'id="instruction"',
    ]) {
      expect(html, "缺少标记:" + marker).toContain(marker);
    }
    // 无 attachments 的用户消息渲染零变化(分支仍在,且不再出现旧的「图/文」字卡拼装)
    expect(html).not.toContain('(a.mime && a.mime.indexOf("image") === 0 ? "图" : "文")');
    // 点聊天流视频本体=播放/拖进度,不夺去开 lightbox(放大走「放大」按钮)
    expect(html).toContain('e.target.tagName === "VIDEO" && e.target.hasAttribute("controls")');
  });

  it("E /uploads 路由存在且带越界防护;POST /upload 与 GET /uploads 不互相打歪", async () => {
    const html = await fetchHtml();
    for (const marker of [
      // 聊天流读盘 src 形态(浏览器侧,模板里)
      'return "/uploads?path=" + encodeURIComponent(String(a.path)) + "&name="',
    ]) {
      expect(html, "缺少标记:" + marker).toContain(marker);
    }
    // 服务端路由/handler 在模板字符串之外(servePanel 的 TS 代码),真源读 src/panel.ts;
    // 行为面另由本文件后面的 GET /uploads 端到端断言锁死。
    const src = readFileSync(fileURLToPath(new URL("../src/panel.ts", import.meta.url)), "utf8");
    for (const marker of [
      // 精确路径 + method 区分(前缀重叠不打歪:POST 只认 "/upload" 或 "/upload?")
      'if (req.method === "POST" && (req.url === "/upload" || (req.url !== undefined && req.url.indexOf("/upload?") === 0)))',
      'if (req.method === "GET" && req.url !== undefined && (req.url === "/uploads" || req.url.indexOf("/uploads?") === 0))',
      // 越界防护:规范化 + realpath + 相对根判定 + 拒 ..
      "const normAbs = (p: string): string =>",
 // 对齐现状实现(原 marker 是 upRoot/realRoot 旧形态,源码已改为 realRoots + lex 归一化;
      //   旧断言自 c0e13fa 起就一直红着,与本轮改动无关,此处只把 marker 校正到当前真源)
      "const realRoots = allowRoots.map((r) => { try { return nodeFsAll.realpathSync(r); }",
      "relative(rr, p)",
      'if (qPath.indexOf("..") >= 0 || qName.indexOf("..") >= 0)',
      "拒绝:符号链接指向白名单目录之外",
      "拒绝:路径不在白名单目录(.genie/uploads、.genie/browser-shots)之内",
      // Range + 后缀判型(不信任 query 的 mime)
      'range.indexOf("bytes=") === 0',
      "content-range",
      '"accept-ranges": "bytes"',
      "function attMimeByName(p: string): string",
      "const MIME_BY_EXT: Record<string, string> = {",
      '.mp4": "video/mp4', '.webm": "video/webm', '.png": "image/png', '.jpg": "image/jpeg',
      // 服务端按类型限额(视频 50MB / 文档 64MB / 其它 8MB),仍有硬上限
      "const VIDEO_UPLOAD_LIMIT = 50 * 1024 * 1024;",
      "const DOC_UPLOAD_LIMIT = 64 * 1024 * 1024;",
      "const UPLOAD_LIMIT = 8 * 1024 * 1024;",
      "function isDocName(lower: string): boolean",
      "const limit = isVideo ? VIDEO_UPLOAD_LIMIT : isDoc ? DOC_UPLOAD_LIMIT : UPLOAD_LIMIT;",
    ]) {
      expect(src, "缺少标记:" + marker).toContain(marker);
    }
  });

  it("行为(纯函数):类型白名单/分类型上限/大小格式化/媒体 src 回退(--> /uploads 读盘)", async () => {
    const html = await fetchHtml();
    const sliceTopFn = (header: string) => {
      const i = html.indexOf(header);
      expect(i, "找不到函数:" + header).toBeGreaterThan(0);
      const j = html.indexOf("\n}\n", i);
      expect(j, header + " 未闭合").toBeGreaterThan(i);
      return html.slice(i, j + 2);
    };
    const consts = html.slice(html.indexOf("const ATT_MAX_IMG"), html.indexOf("function attExt("));
    const src = consts + [
      sliceTopFn("function attExt("),
      sliceTopFn("function attKind("),
      sliceTopFn("function attLimitOf("),
      sliceTopFn("function attSize("),
      sliceTopFn("function attTag("),
      sliceTopFn("function attSrc("),
    ].join("\n");
    const att = new Function(src + "\nreturn { attExt, attKind, attLimitOf, attSize, attTag, attSrc, ATT_MAX_VID, ATT_MAX_DOC };")() as {
      attExt: (n: string) => string;
      attKind: (n: string, m: string) => string;
      attLimitOf: (k: string) => number;
      attSize: (n: number) => string;
      attTag: (n: string, m: string) => string;
      attSrc: (a: Record<string, unknown>) => string;
      ATT_MAX_VID: number;
      ATT_MAX_DOC: number;
    };

    // 图片白名单(允许的 image/* 子集)
    expect(att.attKind("a.png", "image/png")).toBe("image");
    expect(att.attKind("a.JPG", "image/jpeg")).toBe("image");
    expect(att.attKind("a.webp", "image/webp")).toBe("image");
    // 视频白名单(mp4/webm/mov 等)
    expect(att.attKind("v.mp4", "video/mp4")).toBe("video");
    expect(att.attKind("v.webm", "video/webm")).toBe("video");
    expect(att.attKind("v.mov", "video/quicktime")).toBe("video");
    // 文本/代码:按 mime 或扩展名(旧上传无 mime 也认得出)
    expect(att.attKind("n.md", "text/markdown")).toBe("text");
    expect(att.attKind("i.json", "application/json")).toBe("text");
    expect(att.attKind("s.ts", "")).toBe("text");
    expect(att.attKind("c.py", "")).toBe("text");
    expect(att.attKind("d.csv", "")).toBe("text");
    expect(att.attKind("x.yaml", "application/octet-stream")).toBe("text");
 // 文档类( ppt/docx/xlsx/pdf/zip 都要能传):mime 或后缀任一命中即 doc
    expect(att.attKind("spec.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("doc");
    expect(att.attKind("spec.docx", "application/octet-stream")).toBe("doc");
    expect(att.attKind("deck.pptx", "")).toBe("doc");
    expect(att.attKind("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("doc");
    expect(att.attKind("manual.pdf", "application/pdf")).toBe("doc");
    expect(att.attKind("arc.zip", "application/zip")).toBe("doc");
    expect(att.attKind("arc.zip", "")).toBe("doc");
    expect(att.attKind("legacy.doc", "application/msword")).toBe("doc");
    expect(att.attKind("bak.tar.gz", "")).toBe("doc"); // 复合后缀:末段 .gz 判 doc,不被 text 兜底吞掉
    expect(att.attKind("bundle.tar", "")).toBe("doc");
    expect(att.attKind("blob", "application/pdf")).toBe("doc"); // 无后缀也能靠 mime 认出
    // doc 与 text 不打架:.md 仍在 text(不进 DOC_EXT),.docx 不是 text
    expect(att.attKind("n.md", "")).toBe("text");
    expect(att.attKind("spec.docx", "text/plain")).toBe("doc"); // 后缀优先于可疑 mime
    // 不在清单内 → ""(调用方 attUpload 明确 toast 拒绝,不静默丢弃)
    expect(att.attKind("evil.exe", "application/x-msdownload")).toBe("");
    expect(att.attKind("raw.bin", "application/octet-stream")).toBe("");
    expect(att.attKind("bin", "")).toBe("");
    expect(att.attKind("weird.svgz", "image/svgz")).toBe("");
    // 分类型上限:视频 50MB / 图片 8MB / 文档 64MB / 文本 8MB
    expect(att.attLimitOf("video")).toBe(50 * 1024 * 1024);
    expect(att.attLimitOf("doc")).toBe(64 * 1024 * 1024);
    expect(att.ATT_MAX_DOC).toBe(64 * 1024 * 1024);
    expect(att.ATT_MAX_VID).toBe(50 * 1024 * 1024);
    expect(att.attLimitOf("image")).toBe(8 * 1024 * 1024);
    expect(att.attLimitOf("text")).toBe(8 * 1024 * 1024);
    // 大小格式化(拒绝提示要写清实际大小)
    expect(att.attSize(900)).toBe("900 B");
    expect(att.attSize(2048)).toBe("2.0 KB");
    expect(att.attSize(9 * 1024 * 1024)).toBe("9.0 MB");
    expect(att.attTag("readme.md", "text/markdown")).toBe("MD");
    expect(att.attTag("probe", "video/mp4")).toBe("MP4");
    // src 回退链:preview(dataURL)> objectUrl(本地视频)> /uploads?path=(聊天流/旧会话读盘)
    expect(att.attSrc({ preview: "data:image/png;base64,AA", path: "/x" })).toBe("data:image/png;base64,AA");
    expect(att.attSrc({ objectUrl: "blob:http://l/1", path: "/x" })).toBe("blob:http://l/1");
    expect(att.attSrc({ path: "/r/.genie/uploads/s/1-a b.png", name: "a b.png" }))
      .toBe("/uploads?path=" + encodeURIComponent("/r/.genie/uploads/s/1-a b.png") + "&name=" + encodeURIComponent("a b.png"));
    expect(att.attSrc({ name: "no-path.txt" })).toBe("");
  });

  it("行为:attUpload 对不支持类型/超限明确拒绝(不进上传通道);合法图片走 dataURL、视频走 objectUrl", async () => {
    const html = await fetchHtml();
    const sliceTopFn = (header: string) => {
      const i = html.indexOf(header);
      expect(i).toBeGreaterThan(0);
      const j = html.indexOf("\n}\n", i);
      return html.slice(i, j + 2);
    };
    const consts = html.slice(html.indexOf("const ATT_MAX_IMG"), html.indexOf("function attExt("));
    const src = consts + [
      sliceTopFn("function attExt("),
      sliceTopFn("function attKind("),
      sliceTopFn("function attLimitOf("),
      sliceTopFn("function attSize("),
      sliceTopFn("function attUpload("),
    ].join("\n");

    const toasts: string[] = [];
    const posted: { file: { name: string; size: number; type: string }; extra: Record<string, unknown> }[] = [];
    const mk = () => {
      const f = new Function("toast", "attPostUpload", "currentSid", "FileReader", "URL", "pendingAtts",
        src + "\nreturn { attUpload };") as (
          toast: (t: string, e?: boolean) => void,
          post: (file: unknown, sid: string, extra: Record<string, unknown>) => void,
          sid: unknown, FR: unknown, URLx: unknown, pend: unknown[],
        ) => { attUpload: (f: unknown) => void };
      const objUrls: string[] = [];
      const revoked: string[] = [];
      const URLStub = {
        createObjectURL: () => { const u = "blob:http://local/" + (objUrls.length + 1); objUrls.push(u); return u; },
        revokeObjectURL: (u: string) => revoked.push(u),
      };
      class FRStub {
        result = "data:text/plain;base64,AAAA";
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL() { if (this.onload) setTimeout(() => this.onload && this.onload(), 0); }
        readAsArrayBuffer() { /* 本版已不用 */ }
      }
      const api = f((t) => toasts.push(t), (file, sid, extra) => posted.push({ file: file as { name: string; size: number; type: string }, extra }), "__draft__", FRStub, URLStub, []);
      return { attUpload: api.attUpload, objUrls, revoked };
    };

    // 1) 不支持的类型 → 明确拒绝,且不进上传通道
    const a = mk();
    a.attUpload({ name: "evil.exe", size: 10, type: "application/x-msdownload" });
    expect(toasts[toasts.length - 1]).toContain("不支持的类型:evil.exe");
    expect(posted.length).toBe(0);
    // 2) 超该类型上限 → 明确拒绝(文件名 + 实际大小 + 上限)
    const b = mk();
    b.attUpload({ name: "big-video.mp4", size: 51 * 1024 * 1024, type: "video/mp4" });
    expect(toasts[toasts.length - 1]).toContain("附件超限:big-video.mp4");
    expect(toasts[toasts.length - 1]).toContain("51.0 MB");
    expect(toasts[toasts.length - 1]).toContain("50.0 MB");
    expect(posted.length).toBe(0);
    // 图片 9MB(视频同级但图片上限 8MB)→ 拒绝
    const c = mk();
    c.attUpload({ name: "big.png", size: 9 * 1024 * 1024, type: "image/png" });
    expect(toasts[toasts.length - 1]).toContain("附件超限:big.png");
    expect(posted.length).toBe(0);
    // 3) 合法图片 → 走 FileReader dataURL 存 preview
    const d = mk();
    d.attUpload({ name: "ok.png", size: 1024, type: "image/png" });
    await wait(20);
    expect(posted.length).toBe(1);
    expect(posted[0].extra.kind).toBe("image");
    expect(String(posted[0].extra.preview).indexOf("data:")).toBe(0);
    // 4) 合法视频 → objectUrl(不读 base64,不占内存)
    const e2 = mk();
    e2.attUpload({ name: "ok.mp4", size: 20 * 1024 * 1024, type: "video/mp4" });
    expect(posted[1].extra.kind).toBe("video");
    expect(String(posted[1].extra.objectUrl)).toContain("blob:");
    expect(e2.objUrls.length).toBe(1);
    // 5) 文档(.docx/.pdf/.zip)现在被接受:直接上传,不走 FileReader 的 dataURL 也不建 objectUrl(64MB 转 base64 会炸内存)
    const f1 = mk();
    f1.attUpload({ name: "spec.docx", size: 10 * 1024 * 1024, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(posted[2].extra.kind).toBe("doc");
    expect(posted[2].extra.preview).toBeUndefined();
    expect(posted[2].extra.objectUrl).toBeUndefined();
    expect(f1.objUrls.length).toBe(0);
    f1.attUpload({ name: "manual.pdf", size: 20 * 1024 * 1024, type: "application/pdf" });
    expect(posted[3].extra.kind).toBe("doc");
    f1.attUpload({ name: "arc.zip", size: 1024, type: "application/zip" });
    expect(posted[4].extra.kind).toBe("doc");
    // 文档超 64MB → 明确拒绝(文案写明「文档」上限)
    f1.attUpload({ name: "huge.pptx", size: 65 * 1024 * 1024, type: "" });
    expect(toasts[toasts.length - 1]).toContain("附件超限:huge.pptx");
    expect(toasts[toasts.length - 1]).toContain("64.0 MB");
    expect(toasts[toasts.length - 1]).toContain("文档");
    expect(posted.length).toBe(5);
  });

  it("行为:移除附件时 revokeObjectURL(视频);lightbox 开→关 语义(img/video 分支与焦点回位)", async () => {
    const html = await fetchHtml();
    const sliceTopFn = (header: string) => {
      const i = html.indexOf(header);
      expect(i).toBeGreaterThan(0);
      const j = html.indexOf("\n}\n", i);
      return html.slice(i, j + 2);
    };
    const src = [
      sliceTopFn("function attDrop("),
      sliceTopFn("function attLightboxOpen("),
      sliceTopFn("function attLightboxClose("),
    ].join("\n");
    // 简易 DOM 桩:$ 返回带 classList/textContent/innerHTML/focus/querySelector 的假元素;
    // innerHTML 赋值记录到 lbInner,供断言 <img> / <video controls autoplay> 分支。
    const boxes: Record<string, { on: boolean; attrs: Record<string, string>; innerHTML: string; text: string; focused: number }> = {};
    const mk = (id: string) => (boxes[id] = boxes[id] || { on: false, attrs: {}, innerHTML: "", text: "", focused: 0 });
    let lbInner = "";
    const toasts: string[] = [];
    const f = new Function("toast", "esc", "$", "URL", "pendingAtts", "attRender", src + "\nreturn { attDrop, attLightboxOpen, attLightboxClose };") as (
      toast: (t: string, e?: boolean) => void, esc: (s: unknown) => string, sel: (id: string) => unknown,
      URLx: unknown, pend: unknown[], render: () => void) => { attDrop: (i: number) => void; attLightboxOpen: (s: string, k: string, n: string, m: string, from: unknown) => void; attLightboxClose: () => void };
    const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const revoked: string[] = [];
    const sel = (id: string) => {
      if (id === "attLightbox") return { classList: { add: () => { mk("lb").on = true; }, remove: () => { mk("lb").on = false; }, contains: () => mk("lb").on }, setAttribute: (k: string, v: string) => { mk("lb").attrs[k] = v; } };
      if (id === "attLbMedia") return {
        get innerHTML() { return lbInner; },
        set innerHTML(v: string) { lbInner = v; },
        querySelector: () => null,
      };
      if (id === "attLbName") return { set textContent(v: string) { mk("name").text = v; }, get textContent() { return mk("name").text; } };
      if (id === "attLbMeta") return { set textContent(v: string) { mk("meta").text = v; }, get textContent() { return mk("meta").text; } };
      if (id === "attLbClose") return { focus: () => { mk("close").focused++; } };
      return null;
    };
    const pend: Record<string, unknown>[] = [{ name: "v.mp4", objectUrl: "blob:http://local/9" }, { name: "p.png", size: 1 }];
    const api = f((t) => toasts.push(t), esc, sel, { revokeObjectURL: (u: string) => revoked.push(u) }, pend, () => { /* 渲染桩:本用例只查数据面 */ });

    // 移除视频附件 → revoke objectUrl,列表少一项
    api.attDrop(0);
    expect(revoked).toEqual(["blob:http://local/9"]);
    expect(pend.length).toBe(1);
    expect(pend[0].name).toBe("p.png");
    // 移除图片(无 objectUrl)→ 不调 revoke
    api.attDrop(0);
    expect(revoked.length).toBe(1);
    expect(pend.length).toBe(0);

    // lightbox:图片分支(contain img)/ 视频分支(controls autoplay)
    let fromFocused = 0;
    const fromEl = { focus: () => { fromFocused++; } };
    api.attLightboxOpen("data:image/png;base64,AA", "image", "p.png", "2.0 KB", fromEl);
    expect(mk("lb").on).toBe(true);
    expect(lbInner).toContain('<img src="data:image/png;base64,AA"');
    expect(mk("name").text).toBe("p.png");
    expect(mk("meta").text).toContain("图片");
    expect(mk("close").focused).toBeGreaterThan(0); // 开即焦点进关闭钮(键盘可达)
    api.attLightboxClose();
    expect(mk("lb").on).toBe(false);
    expect(lbInner).toBe("");
    expect(fromFocused).toBe(1); // 关闭后焦点回来源元素
    api.attLightboxOpen("/uploads?path=x", "video", "v.mp4", "51.0 MB", fromEl);
    expect(lbInner).toContain("<video");
    expect(lbInner).toContain("controls");
    expect(lbInner).toContain("autoplay");
    expect(mk("meta").text).toContain("视频");
    api.attLightboxClose();
    expect(fromFocused).toBe(2);
    // 无 src 时不打开(明确 toast,不是静默失败)
    api.attLightboxOpen("", "image", "x.png", "", fromEl);
    expect(mk("lb").on).toBe(false);
    expect(toasts[toasts.length - 1]).toContain("该附件无可用预览源");
  });

  it("行为:attRowHtml 渲染(图片真缩略图/视频就地播放器/文本卡;旧事件无 preview 走 /uploads)", async () => {
    const html = await fetchHtml();
    const sliceTopFn = (header: string) => {
      const i = html.indexOf(header);
      expect(i).toBeGreaterThan(0);
      const j = html.indexOf("\n}\n", i);
      return html.slice(i, j + 2);
    };
    const consts = html.slice(html.indexOf("const ATT_MAX_IMG"), html.indexOf("function attExt("));
    const src = consts + [
      sliceTopFn("function attExt("),
      sliceTopFn("function attKind("),
      sliceTopFn("function attSize("),
      sliceTopFn("function attTag("),
      sliceTopFn("function attSrc("),
      sliceTopFn("function attRowHtml("),
    ].join("\n");
    const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const run = new Function("esc", src + "\nreturn { attRowHtml };") as (e: (s: unknown) => string) => { attRowHtml: (l: unknown[]) => string };
    const { attRowHtml } = run(esc);

    // 图片:真实缩略图 src 走 /uploads?path=(journal 只给绝对路径),可点开大图
    const h1 = attRowHtml([{ name: "shot.png", path: "/repo/.genie/uploads/s/1-shot.png", mime: "image/png", size: 2048 }]);
    expect(h1).toContain('<img class="att-cthumb"');
    // review 二轮:同标签守卫(把 data-alb 落在该 <img> 上这件事锁死,不靠两条互不相关的断言)
    expect((h1.match(/<img class="att-cthumb"[^>]*>/g) || []).some((t) => t.indexOf("data-alb=") >= 0), "聊天流缩略图必须自带 data-alb").toBe(true);
    expect(h1).toContain('data-alb="/uploads?path=' + encodeURIComponent("/repo/.genie/uploads/s/1-shot.png").replace(/&/g, "&amp;"));
    expect(h1).toContain('src="/uploads?path=' + encodeURIComponent("/repo/.genie/uploads/s/1-shot.png").replace(/&/g, "&amp;"));
    expect(h1).toContain("|image|shot.png|2.0 KB");
    expect(h1).toContain("PNG");
    expect(h1, "不再用「图」字占位").not.toContain(">图<");
    // 视频:就地播放器 controls preload=metadata + 放大按钮(点击本体是播放/拖进度)
    const h2 = attRowHtml([{ name: "clip.mp4", path: "/repo/.genie/uploads/s/2-clip.mp4", mime: "video/mp4", size: 9 * 1024 * 1024 }]);
    expect(h2).toContain('<video class="att-cvid" controls preload="metadata" src=');
    expect(h2).toContain('class="att-zoom"');
    expect(h2).toContain("|video|clip.mp4|9.0 MB");
    // 文本/代码:文件卡(扩展名标识 + 名 + 大小);有 src 时整卡可点开全文(lightbox 文本分支)
    const h3 = attRowHtml([{ name: "notes.md", path: "/repo/.genie/uploads/s/3-notes.md", mime: "text/markdown", size: 300 }]);
    expect(h3).toContain('<span class="att-kind">MD</span>');
    expect(h3).toContain("notes.md");
    expect(h3).toContain("300 B");
    expect(h3).toContain("|text|notes.md|300 B");
    expect(h3).toContain('title="点击查看全文"');
    expect(h3).not.toContain("<video");
    // 旧事件缺 mime/size 也照常显示(纯 path 后缀判型;无 size 不显示假 0 B)
    const h4 = attRowHtml([{ name: "old.png", path: "/repo/.genie/uploads/s/4-old.png" }]);
    expect(h4).toContain('<img class="att-cthumb"');
    expect(h4).toContain("|image|old.png|0 B");
    expect(h4).not.toContain("att-meta");
    // 文档(docx/pdf/zip):纯标签卡(扩展名徽标 + 名 + 大小),刻意不挂 data-alb(点开把二进制当文本渲染是乱码)
    const h7 = attRowHtml([{ name: "spec.docx", path: "/repo/.genie/uploads/s/7-spec.docx", mime: "application/octet-stream", size: 10 * 1024 * 1024 }]);
    expect(h7).toContain('<span class="att-kind">DOCX</span>');
    expect(h7).toContain("spec.docx");
    expect(h7).toContain("10.0 MB");
    expect(h7, "文档卡不能挂 data-alb").not.toContain("data-alb=");
    expect(h7).toContain('title="文档附件:发送后由 agent 解析内容"');
    expect(h7).not.toContain("<img");
    expect(h7).not.toContain("<video");
    const h8 = attRowHtml([{ name: "manual.pdf", path: "/u/8-manual.pdf", mime: "application/pdf", size: 2048 }]);
    expect(h8).toContain('<span class="att-kind">PDF</span>');
    expect(h8).not.toContain("data-alb=");
    // 无 path(数据缺失)→ 退回文本卡,不产出坏 src,也不挂 data-alb(点开会报错)
    const h5 = attRowHtml([{ name: "ghost.png", mime: "image/png" }]);
    expect(h5).not.toContain("<img");
    expect(h5).not.toContain("data-alb=");
    expect(h5).toContain("ghost.png");
    // 混合:三类同批渲染都在
    const h6 = attRowHtml([
      { name: "a.png", path: "/u/a.png", mime: "image/png", size: 10 },
      { name: "b.mp4", path: "/u/b.mp4", mime: "video/mp4", size: 20 },
      { name: "c.txt", path: "/u/c.txt", mime: "text/plain", size: 30 },
    ]);
    expect(h6).toContain("att-cthumb");
    expect(h6).toContain("att-cvid");
    expect(h6).toContain('<span class="att-kind">TXT</span>');
    expect(h6.match(/class="att-card/g)?.length).toBe(3);
  });

  it("页面内联脚本编译即验(vm.Script):无 TS 标注/语法错(整页 SyntaxError 老坑)", async () => {
    const html = await fetchHtml();
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((code, i) => {
      expect(() => new Script(code), "script#" + i + " 语法错误").not.toThrow();
    });
  });

  it("行为:POST /upload 视频名放宽到 50MB 内可传;文本仍 8MB 硬限", async () => {
    // 9MB 的 .mp4(超旧 8MB 硬编码限额 → 必须 200,证明按类型放宽)
    const vid = Buffer.alloc(9 * 1024 * 1024, 7);
    const r1 = await fetch(BASE + "/upload?sid=vitest-att&name=" + encodeURIComponent("clip.mp4"), { method: "POST", body: vid });
    expect(r1.status).toBe(200);
    const j1 = await r1.json() as { path: string; name: string; size: number };
    expect(j1.name).toBe("clip.mp4");
    expect(existsSync(j1.path)).toBe(true);
    expect(j1.path.indexOf(join(TMP_ROOT, ".genie", "uploads")) === 0).toBe(true);
    // 9MB 的 .txt → 413(文本/图片 8MB 上限,防绕过前端直发)
    const txt = Buffer.alloc(9 * 1024 * 1024, 65);
    const r2 = await fetch(BASE + "/upload?sid=vitest-att&name=" + encodeURIComponent("big.txt"), { method: "POST", body: txt });
    expect(r2.status).toBe(413);
    const j2 = await r2.json() as { error: string };
    expect(j2.error).toContain("8MB");
 // 10MB 的 .docx → 200(文档 64MB 档,不能被 8MB 其它档打回; ppt/docx/xlsx/pdf/zip 放行)
    const docxBytes = Buffer.alloc(10 * 1024 * 1024, 68);
    const r4 = await fetch(BASE + "/upload?sid=vitest-att&name=" + encodeURIComponent("deck.docx"), { method: "POST", body: docxBytes });
    expect(r4.status).toBe(200);
    const j4 = await r4.json() as { path: string; name: string; size: number };
    expect(j4.name).toBe("deck.docx");
    expect(j4.size).toBe(docxBytes.length);
    expect(existsSync(j4.path)).toBe(true);
    // 65MB 的 .pptx → 413(超文档 64MB 档,文案写「文档」)
    const bigPpt = Buffer.alloc(65 * 1024 * 1024, 69);
    const r5 = await fetch(BASE + "/upload?sid=vitest-att&name=" + encodeURIComponent("huge.pptx"), { method: "POST", body: bigPpt });
    expect(r5.status).toBe(413);
    const j5 = await r5.json() as { error: string };
    expect(j5.error).toContain("64MB");
    expect(j5.error).toContain("文档");
    // 无 query 的裸 POST /upload 也走同一分支(sid 落 common;不断言路径只断言不 404)
    const r3 = await fetch(BASE + "/upload", { method: "POST", body: "x" });
    expect(r3.status).toBe(200);
  });

  it("行为:GET /uploads 读盘 200+正确 content-type;Range→206;越界/穿越/软链→403;缺失→404", async () => {
    // 造两个真附件(图片/视频)落临时 uploads
    const png = join(upDir, "shot.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const mp4 = join(upDir, "clip.mp4");
    writeFileSync(mp4, Buffer.alloc(64 * 1024, 5));
    const tx = join(upDir, "note.md");
    writeFileSync(tx, "# 标题");

    // 1) 图片:200 + image/png + Accept-Ranges
    const g1 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(png) + "&name=shot.png");
    expect(g1.status).toBe(200);
    expect(g1.headers.get("content-type")).toBe("image/png");
    expect(g1.headers.get("accept-ranges")).toBe("bytes");
    expect((await g1.arrayBuffer()).byteLength).toBe(8);

    // 2) 视频:200 + video/mp4;Range 请求 → 206 + content-range(拖动进度条必需)
    const g2 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(mp4));
    expect(g2.status).toBe(200);
    expect(g2.headers.get("content-type")).toBe("video/mp4");
    const g3 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(mp4), { headers: { Range: "bytes=0-1023" } });
    expect(g3.status).toBe(206);
    expect(g3.headers.get("content-range")).toBe("bytes 0-1023/65536");
    expect((await g3.arrayBuffer()).byteLength).toBe(1024);
    const g4 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(mp4), { headers: { Range: "bytes=65530-" } });
    expect(g4.status).toBe(206);
    expect(g4.headers.get("content-range")).toBe("bytes 65530-65535/65536");
    const g5 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(mp4), { headers: { Range: "bytes=999999-" } });
    expect(g5.status).toBe(416);

    // 3) 文本:后缀判型(不信任 query 里给的 mime —— 谎报 image/png 仍回 text/markdown)
    const g6 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(tx) + "&mime=image/png");
    expect(g6.status).toBe(200);
    expect(g6.headers.get("content-type")).toContain("text/markdown");

    // 4) 越界:uploads 目录外 → 403(不读盘、不泄露存在性)
    const outside = join(TMP_ROOT, "secret.txt");
    writeFileSync(outside, "不该被读到");
    const d1 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(outside));
    expect(d1.status).toBe(403);
    // 系统路径
    const d2 = await fetch(BASE + "/uploads?path=" + encodeURIComponent("/etc/hostname"));
    expect(d2.status).toBe(403);
    // .. 穿越(即便词法上能落回 uploads 内,也一律拒)
    const d3 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(join(upDir, "..", "..", "..", "..", "..", "etc", "hostname")));
    expect(d3.status).toBe(403);
    const d4 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(upDir + "/../uploads/vitest-att/shot.png"));
    expect(d4.status).toBe(403);
    // 相对路径 → 403
    const d5 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(".genie/uploads/vitest-att/shot.png"));
    expect(d5.status).toBe(403);
    // 软链逃逸:uploads 内的软链指向根外文件 → 403
    const link = join(upDir, "escape.txt");
    try { symlinkSync(outside, link); } catch (e) { /* 平台不支持软链则跳过该子断言 */ }
    if (existsSync(link)) {
      const d6 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(link));
      expect(d6.status).toBe(403);
    }
    // 缺失文件(uploads 内合法路径但不存在)→ 404
    const d7 = await fetch(BASE + "/uploads?path=" + encodeURIComponent(join(upDir, "nope.png")));
    expect(d7.status).toBe(404);
  });
});