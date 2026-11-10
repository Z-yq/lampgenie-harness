import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildAttachmentInjection,
  classifyAttachment,
  isBinaryLikeMime,
  VISION_MAX_BYTES,
  VISION_MAX_IMAGES,
  type AttachmentLike,
} from "../src/agent-wiring.js";

/** 造一个可控字节数的小文件读取器(不落盘:纯函数把 readFile 作为依赖注入)。 */
function fakeReader(sizes: Record<string, number>, fill = 0x41) {
  return (p: string): Uint8Array => {
    const n = sizes[p];
    if (n === undefined) throw new Error("ENOENT: " + p);
    return new Uint8Array(n).fill(fill);
  };
}

const MB = 1024 * 1024;

describe("classifyAttachment(附件类别判定,mime 缺失按扩展名兜底)", () => {
  it("image/* 白名单(png/jpeg/jpg/gif/webp)判为 image", () => {
    for (const m of ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]) {
      expect(classifyAttachment("a.png", m)).toBe("image");
    }
    // 带参数/大写也归一
    expect(classifyAttachment("a.png", "IMAGE/PNG;charset=utf-8")).toBe("image");
  });

  it("拒绝 SVG(可带脚本,不进视觉通道)与白名单外 image 子类型", () => {
    expect(classifyAttachment("icon.svg", "image/svg+xml")).toBe("other");
    expect(classifyAttachment("a.bmp", "image/bmp")).toBe("other");
    expect(classifyAttachment("a.tiff", "image/tiff")).toBe("other");
  });

  it("mime 为空/通用值时按扩展名兜底:空 mime 的 .png 仍按图片处理", () => {
    expect(classifyAttachment("shot.PNG", "")).toBe("image");
    expect(classifyAttachment("shot.jpg", undefined)).toBe("image");
    expect(classifyAttachment("shot.jpeg", "application/octet-stream")).toBe("image");
    expect(classifyAttachment("clip.webm", "")).toBe("video");
    expect(classifyAttachment("notes.txt", "")).toBe("other");
  });

  it("非空且非 image/video/文档的 mime 以 mime 为准(不猜扩展名)", () => {
    // .png 名字但声明成 text/plain:按声明走文本(保守,不偷偷进视觉通道)
    expect(classifyAttachment("fake.png", "text/plain")).toBe("other");
    expect(classifyAttachment("data.bin", "application/json")).toBe("other");
  });

  it("文档类:mime 缺失/通用值(octet-stream)时按扩展名兜底判 doc", () => {
    // 浏览器给 .docx 的 type 常是空或 octet-stream —— 扩展名必须是唯一线索
    expect(classifyAttachment("report.docx", "")).toBe("doc");
    expect(classifyAttachment("slides.pptx", "application/octet-stream")).toBe("doc");
    expect(classifyAttachment("book.pdf", undefined)).toBe("doc");
    expect(classifyAttachment("pack.ZIP", "binary/octet-stream")).toBe("doc");
  });

  it("文档类:mime 白名单(pdf/OOXML/压缩包)直接判 doc", () => {
    expect(classifyAttachment("a.pdf", "application/pdf")).toBe("doc");
    expect(classifyAttachment("a.zip", "application/zip")).toBe("doc");
    expect(classifyAttachment("a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("doc");
    expect(classifyAttachment("a.doc", "application/msword")).toBe("doc");
    expect(classifyAttachment("a.epub", "application/epub+zip")).toBe("doc");
  });

  it("文本类附件仍归 other(不升级为 doc):.md/.txt/.csv 走原「read_attachment 可读」路径", () => {
    expect(classifyAttachment("notes.md", "text/markdown")).toBe("other");
    expect(classifyAttachment("notes.md", "")).toBe("other");
    expect(classifyAttachment("a.txt", "text/plain")).toBe("other");
    expect(classifyAttachment("a.csv", "text/csv")).toBe("other");
    expect(classifyAttachment("a.html", "text/html")).toBe("other");
  });

  it("video/* 判为 video", () => {
    expect(classifyAttachment("a.mp4", "video/mp4")).toBe("video");
  });
});

describe("buildAttachmentInjection(任务书「## 附件」块 + 视觉通道)", () => {
  const img = (name: string, size: number, mime = "image/png"): AttachmentLike => ({ name, path: "/tmp/" + name, mime, size });

  it("无附件 → 空块、无图", () => {
    const r = buildAttachmentInjection(undefined, fakeReader({}));
    expect(r.block).toBe("");
    expect(r.visionImages).toEqual([]);
    expect(buildAttachmentInjection([], fakeReader({})).block).toBe("");
  });

  it("① 限内图片:写「已进视觉通道」且返回 data URL", () => {
    const r = buildAttachmentInjection([img("pic.png", 1024)], fakeReader({ "/tmp/pic.png": 1024 }));
    expect(r.block).toBe("\n\n## 附件\n- [图片附件] pic.png(已进视觉通道;后续需要再看用 view_image /tmp/pic.png)");
    expect(r.visionImages).toHaveLength(1);
    expect(r.visionImages[0]!.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("② 单张超 2MB:写「未进视觉通道」且不返回 data URL(文案只提单张上限)", () => {
    const big = VISION_MAX_BYTES + 1;
    const r = buildAttachmentInjection([img("big.png", big)], fakeReader({ "/tmp/big.png": big }));
    expect(r.visionImages).toEqual([]);
    expect(r.block).toContain("- [图片附件] big.png(2.0MB 超单张上限 2.0MB,未进视觉通道;路径 /tmp/big.png)");
  });

  it("②'' 像素尺寸超限:即便 <2MB 也不进视觉通道(长边>4000 的截图会 400)", () => {
    // 造一个 10144x1146 的 PNG 头(事故实锤尺寸),体积很小但像素超限
    const png = Buffer.alloc(64);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(10144, 16);
    png.writeUInt32BE(1146, 20);
    const reader = () => new Uint8Array(png);
    const r = buildAttachmentInjection([img("wide.png", png.length)], reader, { sizeOf: () => png.length });
    expect(r.visionImages).toEqual([]);
    expect(r.block).toContain("10144x1146");
    expect(r.block).toContain("未进视觉通道");
  });

  it("②' 超限判定走 sizeOf:不把超大附件读进内存(生产传 statSync().size)", () => {    const big = VISION_MAX_BYTES + 1;
    let reads = 0;
    const r = buildAttachmentInjection([img("huge.png", big)], () => { reads++; return new Uint8Array(0); }, { sizeOf: () => big });
    expect(reads).toBe(0); // 判超限只 stat,不 readFile
    expect(r.visionImages).toEqual([]);
    expect(r.block).toContain("2.0MB 超单张上限 2.0MB,未进视觉通道");
  });

  it("③ 第 5 张图片:写「已达上限 4 张,本张未进」且不返回 data URL(文案只提总数上限)", () => {
    const atts = [1, 2, 3, 4, 5].map((i) => img("p" + i + ".png", 100));
    const sizes = Object.fromEntries(atts.map((a) => [a.path, 100]));
    const r = buildAttachmentInjection(atts, fakeReader(sizes));
    expect(r.visionImages).toHaveLength(VISION_MAX_IMAGES); // 前 4 张进通道
    expect(r.block).toContain("- [图片附件] p5.png(已达视觉通道上限 4 张,本张未进;需要看时用 view_image /tmp/p5.png)");
    expect(r.block.match(/已进视觉通道/g)).toHaveLength(4);
  });

  it("④ 视频:写「模型不接收视频内容」,不返回 data URL,且不写 read_attachment 可读", () => {
    const r = buildAttachmentInjection(
      [{ name: "demo.mp4", path: "/tmp/demo.mp4", mime: "video/mp4", size: 3 * MB }],
      fakeReader({ "/tmp/demo.mp4": 3 * MB }),
    );
    expect(r.visionImages).toEqual([]);
    expect(r.block).toContain("- [视频附件] demo.mp4(3.0MB,路径 /tmp/demo.mp4)——本地已预览;模型不接收视频内容");
    expect(r.block).toContain("如需分析请先转帧/截图或提供关键帧图片");
    expect(r.block).not.toContain("read_attachment 可读");
  });

  it("⑤ 文本附件:写「read_attachment 可读」并给出路径与 mime", () => {
    const r = buildAttachmentInjection([{ name: "log.txt", path: "/tmp/log.txt", mime: "text/plain" }], fakeReader({}));
    expect(r.block).toBe("\n\n## 附件\n- log.txt → /tmp/log.txt(text/plain)(read_attachment 可读)");
    expect(r.visionImages).toEqual([]);
  });

  it("⑦ 文档附件(docx):恰一行 [文档附件],含路径与 read_attachment,不含「用对应工具解析」,不返回 data URL", () => {
    const r = buildAttachmentInjection(
      [{ name: "report.docx", path: "/tmp/report.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4096 }],
      fakeReader({}),
    );
    expect(r.visionImages).toEqual([]); // 注入阶段不解析、不进通道
    const docLines = r.block.split("\n").filter((l) => l.startsWith("- "));
    expect(docLines).toHaveLength(1);
    expect(docLines[0]).toContain("[文档附件] report.docx");
    expect(docLines[0]).toContain("/tmp/report.docx");
    expect(docLines[0]).toContain("read_attachment");
    expect(r.block).not.toContain("用对应工具解析");
    expect(r.block).not.toContain("data:");
  });

  it("⑦' 通用 mime 的文档附件:按扩展名判 doc,大小未知时如实标注", () => {
    const r = buildAttachmentInjection([{ name: "a.pptx", path: "/tmp/a.pptx", mime: "application/octet-stream" }], fakeReader({}));
    expect(r.block).toContain("[文档附件] a.pptx(application/octet-stream)→ /tmp/a.pptx");
    expect(r.block).not.toContain("read_attachment 可读");
  });

  it("⑦'' 非 doc 二进制(pdf 之外的未知二进制):不再出现「用对应工具解析」假指路", () => {
    const r = buildAttachmentInjection([{ name: "x.bmp", path: "/tmp/x.bmp", mime: "image/bmp" }], fakeReader({}));
    expect(r.block).toContain("read_attachment 只能按文本读");
    expect(r.block).toContain("view_image 亦不支持");
    expect(r.block).not.toContain("用对应工具解析");
  });

  it("⑥ mime 缺失但有 .png 扩展名:按图片处理(进视觉通道,data URL 用 png)", () => {
    const r = buildAttachmentInjection([{ name: "paste.png", path: "/tmp/paste.png" }], fakeReader({ "/tmp/paste.png": 512 }));
    expect(r.visionImages).toHaveLength(1);
    expect(r.visionImages[0]!.startsWith("data:image/png;base64,")).toBe(true);
    expect(r.block).toContain("- [图片附件] paste.png(已进视觉通道;后续需要再看用 view_image /tmp/paste.png)");
  });

  it("gif/webp(白名单内)进视觉通道;svg(白名单外)只给路径", () => {
    const r = buildAttachmentInjection(
      [
        { name: "a.gif", path: "/tmp/a.gif", mime: "image/gif" },
        { name: "b.webp", path: "/tmp/b.webp", mime: "image/webp" },
        { name: "c.svg", path: "/tmp/c.svg", mime: "image/svg+xml" },
      ],
      fakeReader({ "/tmp/a.gif": 10, "/tmp/b.webp": 10 }),
    );
    expect(r.visionImages.map((u) => u.slice(5, u.indexOf(";")))).toEqual(["image/gif", "image/webp"]);
    expect(r.block).toContain("- c.svg → /tmp/c.svg(image/svg+xml)(read_attachment 可读)");
  });

  it("image/jpg 归一为 image/jpeg(Anthropic 只认 jpeg)", () => {
    const r = buildAttachmentInjection([{ name: "a.jpg", path: "/tmp/a.jpg", mime: "image/jpg" }], fakeReader({ "/tmp/a.jpg": 8 }));
    expect(r.visionImages[0]!.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("读取失败:写「读取失败」不炸、不进通道", () => {
    const r = buildAttachmentInjection([img("gone.png", 10)], fakeReader({}));
    expect(r.visionImages).toEqual([]);
    expect(r.block).toContain("- [图片附件读取失败] gone.png");
  });

  it("MVP 组合(1 限内图 + 1 视频 + 1 文本):块文本逐行如实", () => {
    const r = buildAttachmentInjection(
      [
        { name: "shot.png", path: "/tmp/shot.png", mime: "image/png", size: 2048 },
        { name: "demo.mp4", path: "/tmp/demo.mp4", mime: "video/mp4", size: 5 * MB },
        { name: "error.log", path: "/tmp/error.log", mime: "text/plain", size: 100 },
      ],
      fakeReader({ "/tmp/shot.png": 2048, "/tmp/demo.mp4": 5 * MB }),
    );
    expect(r.visionImages).toHaveLength(1);
    expect(r.block).toBe(
      "\n\n## 附件\n" +
        "- [图片附件] shot.png(已进视觉通道;后续需要再看用 view_image /tmp/shot.png)\n" +
        "- [视频附件] demo.mp4(5.0MB,路径 /tmp/demo.mp4)——本地已预览;模型不接收视频内容,如需分析请先转帧/截图或提供关键帧图片\n" +
        "- error.log → /tmp/error.log(text/plain)(read_attachment 可读)",
    );
  });

  it("单项一行(不写长段落:每附件恰一行)", () => {
    const atts = [img("a.png", 100), { name: "b.txt", path: "/tmp/b.txt", mime: "text/plain" }, { name: "c.mp4", path: "/tmp/c.mp4", mime: "video/mp4" }];
    const r = buildAttachmentInjection(atts, fakeReader({ "/tmp/a.png": 100, "/tmp/c.mp4": 100 }));
    expect(r.block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });

  it("列表上限 maxListed(缺省 8):第 9 个附件不入块,但显式提示「另有 N 个未列入」(review:不再静默丢弃)", () => {
    const atts = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ name: "f" + i + ".txt", path: "/tmp/f" + i + ".txt", mime: "text/plain" }));
    const r = buildAttachmentInjection(atts, fakeReader({}));
    expect(r.block).toContain("f8.txt");
    expect(r.block).not.toContain("f9.txt");
    expect(r.block).toContain("[另有 1 个附件未列入本节(单轮最多列 8 个)");
  });

  it("长粘贴临时文件(pasted-text-*.txt):只给路径不内联正文,提示用 read_attachment 取", () => {
    const r = buildAttachmentInjection(
      [
        { name: "pasted-text-20261028-120000.txt", path: "/tmp/pasted-text-20261028-120000.txt", mime: "text/plain" },
        { name: "notes.md", path: "/tmp/notes.md", mime: "text/markdown" },
      ],
      fakeReader({}),
    );
    expect(r.block).toContain("[粘贴长文本]");
    expect(r.block).toContain("read_attachment /tmp/pasted-text-20261028-120000.txt");
    const notesLine = r.block.split("\n").find((l) => l.indexOf("notes.md") >= 0) || "";
    expect(notesLine).not.toContain("[粘贴长文本]");
    expect(notesLine).toContain("read_attachment 可读");
  });

  it("列表未超限时不出「未列入」提示(零噪声)", () => {
    const atts = [1, 2, 3].map((i) => ({ name: "g" + i + ".txt", path: "/tmp/g" + i + ".txt", mime: "text/plain" }));
    const r = buildAttachmentInjection(atts, fakeReader({}));
    expect(r.block).not.toContain("未列入本节");
  });
});

describe("isBinaryLikeMime(read_attachment 类型门槛)", () => {
  it("图片/音视频/字体/压缩包/pdf/wasm 判为二进制", () => {
    for (const m of ["video/mp4", "image/png", "audio/mpeg", "font/woff2", "application/pdf", "application/zip", "application/wasm"]) {
      expect(isBinaryLikeMime(m)).toBe(true);
    }
  });

  it("文本类与缺省 mime 不拦;SVG 是文本可读", () => {
    expect(isBinaryLikeMime("text/plain")).toBe(false);
    expect(isBinaryLikeMime("application/json")).toBe(false);
    expect(isBinaryLikeMime("image/svg+xml")).toBe(false);
    expect(isBinaryLikeMime(undefined)).toBe(false);
    expect(isBinaryLikeMime("")).toBe(false);
  });
});

describe("源码断言:假指路措辞必须绝迹(不存在「对应工具」这个工具)", () => {
  it("agent-wiring.ts 不含「请用对应工具解析」/「用对应工具解析」", () => {
    const src = readFileSync(new URL("../src/agent-wiring.ts", import.meta.url), "utf-8");
    expect(src).not.toContain("请用对应工具解析");
    expect(src).not.toContain("用对应工具解析");
    // 文档附件必须走 doc-text 解析器接线(不是只改文案)
    expect(src).toContain("parseDocFile(");
    expect(src).toContain("[文档附件]");
  });
});