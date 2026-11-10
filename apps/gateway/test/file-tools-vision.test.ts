/**
 * view_image 工具单测(2026-10-25 主动读图通道;2026-10-30 多图化 paths 数组):
 * 白名单/超限/防穿越/多图失败隔离/哨兵返回格式;视觉哨兵由 loop 侧解析(桥测试在 harness-runtime)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools } from "../src/file-tools.js";
import { VISION_TOOL_SENTINEL } from "@lampgenie/runtime/agent/loop";

/** 1x1 透明 png(70B)。 */
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** 手工构造带指定尺寸的 PNG 头(仅尺寸解析消费 magic+IHDR,CRC 不校验)。 */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt8(8, 24);
  b.writeUInt8(6, 25);
  return b;
}

async function runTool(name: string, args: unknown, vision?: { mainHasVision?: boolean; vlm?: { chat: (m: { role: string; content: string; images?: string[] }[]) => Promise<{ content: string }> } }): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "viwtool-"));
  try {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(join(tmp, "pic.png"), PNG_1PX);
    writeFileSync(join(tmp, "sub", "photo.jpg"), PNG_1PX);
    writeFileSync(join(tmp, "logo.svg"), "<svg/>");
    writeFileSync(join(tmp, "pic.bmp"), PNG_1PX);
    // 二进制夹具(空字节触发 looksBinary):pdf/office/视频分级指路用例
    writeFileSync(join(tmp, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));
    writeFileSync(join(tmp, "deck.pptx"), Buffer.from([0x50, 0x4b, 0x00, 0x03]));
    writeFileSync(join(tmp, "clip.mp4"), Buffer.from([0x00, 0x00, 0x00, 0x18]));
    const tools = createFileTools({ root: tmp, sessionId: "s", ...(vision ? { vision } : {}) });
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error("工具不存在: " + name);
    return (await t.execute(args, undefined, { callId: "c" })) as string;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("view_image(主动读图通道)", () => {
  it("png 成功:返回视觉哨兵 + images 数组", async () => {
    const r = await runTool("view_image", { paths: ["pic.png"] });
    expect(r.startsWith(VISION_TOOL_SENTINEL)).toBe(true);
    const meta = JSON.parse(r.slice(VISION_TOOL_SENTINEL.length)) as { images: string[]; label: string };
    expect(meta.images).toHaveLength(1);
    expect(meta.images[0].startsWith("data:image/png;base64,")).toBe(true);
    expect(meta.label).toContain("pic.png");
  });

  it("旧单 path 形状兼容:仍可读一张", async () => {
    const r = await runTool("view_image", { path: "pic.png" });
    const meta = JSON.parse(r.slice(VISION_TOOL_SENTINEL.length)) as { images: string[] };
    expect(meta.images).toHaveLength(1);
  });

  it("多图一次:paths 两张全部注入,label 按序拼接", async () => {
    const r = await runTool("view_image", { paths: ["pic.png", "sub/photo.jpg"] });
    const meta = JSON.parse(r.slice(VISION_TOOL_SENTINEL.length)) as { images: string[]; label: string };
    expect(meta.images).toHaveLength(2);
    expect(meta.images[0].startsWith("data:image/png;base64,")).toBe(true);
    expect(meta.images[1].startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(meta.label).toContain("pic.png");
    expect(meta.label).toContain("photo.jpg");
  });

  it("失败隔离:一张不存在+一张存在 → 成功张仍进哨兵,失败行随 errors 返回", async () => {
    const r = await runTool("view_image", { paths: ["nope.png", "pic.png"] });
    expect(r.startsWith(VISION_TOOL_SENTINEL)).toBe(true);
    const meta = JSON.parse(r.slice(VISION_TOOL_SENTINEL.length)) as { images: string[]; errors?: string[] };
    expect(meta.images).toHaveLength(1);
    expect(meta.errors?.[0]).toContain("nope.png");
    expect(meta.errors?.[0]).toContain("不存在");
  });

  it("全失败:诚实报错并逐行列出原因", async () => {
    const r = await runTool("view_image", { paths: ["nope.png", "logo.svg"] });
    expect(r.startsWith(VISION_TOOL_SENTINEL)).toBe(false);
    expect(r).toContain("没有一张图片读取成功");
    expect(r).toContain("nope.png");
    expect(r).toContain("read_file");
  });

  it("超 4 张:拒绝并指明上限", async () => {
    const r = await runTool("view_image", { paths: ["pic.png", "pic.png", "pic.png", "pic.png", "pic.png"] });
    expect(r).toContain("一次最多 4 张");
    expect(r).not.toContain(VISION_TOOL_SENTINEL);
  });

  it("空 paths:拒绝", async () => {
    expect(await runTool("view_image", { paths: [] })).toContain("非空数组");
  });

  it("失败隔离在 VLM 兜底路径同样成立(成功张转描述,失败张报在文案)", async () => {
    const r = await runTool("view_image", { paths: ["nope.png", "pic.png"] }, {
      mainHasVision: false,
      vlm: { chat: async () => ({ content: "· 一个红色按钮「开始」" }) },
    });
    expect(r.startsWith("[VLM 图像描述 pic.png]")).toBe(true);
    expect(r).toContain("nope.png");
  });

  it("子目录 jpg 成功:mime 按扩展名映射 jpeg", async () => {
    const r = await runTool("view_image", { paths: ["sub/photo.jpg"] });
    const meta = JSON.parse(r.slice(VISION_TOOL_SENTINEL.length)) as { images: string[] };
    expect(meta.images[0].startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("白名单外(svg/bmp/无扩展名):明确报错并指路 read_file", async () => {
    expect(await runTool("view_image", { paths: ["logo.svg"] })).toContain("read_file");
    expect(await runTool("view_image", { paths: ["pic.bmp"] })).toContain("不支持");
  });

  it("路径越界(../ 与绝对路径):拒绝", async () => {
    expect(await runTool("view_image", { paths: ["../outside.png"] })).toContain("越出项目根");
    expect(await runTool("view_image", { paths: ["/etc/passwd.png"] })).toContain("越出项目根");
  });

  it("超 2MB:拒绝并给压缩建议", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "viwbig-"));
    try {
      writeFileSync(join(tmp, "big.png"), Buffer.alloc(2 * 1024 * 1024 + 1, 1));
      const tools = createFileTools({ root: tmp, sessionId: "s" });
      const t = tools.find((x) => x.name === "view_image")!;
      const r = (await t.execute({ paths: ["big.png"] }, undefined, { callId: "c" })) as string;
      expect(r).toContain("2MB 限额");
      expect(r).toContain("压缩");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("尺寸超限:超模型视觉上限的图拒绝注入(不返回哨兵、不进 images)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "viwsize-"));
    try {
      writeFileSync(join(tmp, "huge.png"), PNG_1PX);
      writeFileSync(join(tmp, "wide.png"), pngHeader(10144, 1146));
      const tools = createFileTools({ root: tmp, sessionId: "s" });
      const t = tools.find((x) => x.name === "view_image")!;
      const r = (await t.execute({ paths: ["wide.png"] }, undefined, { callId: "c" })) as string;
      expect(r.startsWith(VISION_TOOL_SENTINEL)).toBe(false);
      expect(r).toContain("图片超限");
      expect(r).toContain("10144x1146");
      expect(r).toContain("长边≤4000px");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("尺寸超限与合法图混批:合法张照旧注入,超限张只报错", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "viwmix-"));
    try {
      writeFileSync(join(tmp, "huge.png"), pngHeader(3330, 7022));
      writeFileSync(join(tmp, "ok.png"), PNG_1PX);
      const tools = createFileTools({ root: tmp, sessionId: "s" });
      const t = tools.find((x) => x.name === "view_image")!;
      const r = (await t.execute({ paths: ["huge.png", "ok.png"] }, undefined, { callId: "c" })) as string;
      expect(r.startsWith(VISION_TOOL_SENTINEL)).toBe(true);
      const meta = JSON.parse(r.slice(VISION_TOOL_SENTINEL.length)) as { images: string[]; errors?: string[] };
      expect(meta.images).toHaveLength(1);
      expect(meta.errors?.join("\n")).toContain("3330x7022");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("解析失败(未知/坏头)放行:不因解析器盲区拦正常图", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "viwunk-"));
    try {
      writeFileSync(join(tmp, "odd.png"), Buffer.from([0x01, 0x02, 0x03, 0x04]));
      const tools = createFileTools({ root: tmp, sessionId: "s" });
      const t = tools.find((x) => x.name === "view_image")!;
      const r = (await t.execute({ paths: ["odd.png"] }, undefined, { callId: "c" })) as string;
      expect(r.startsWith(VISION_TOOL_SENTINEL)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("isReadOnly 声明(权限闸门豁免,全部权限模式可用)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "viwro-"));
    try {
      const t = createFileTools({ root: tmp, sessionId: "s" }).find((x) => x.name === "view_image")!;
      expect(t.isReadOnly?.()).toBe(true);
      expect(t.isConcurrencySafe?.({})).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("VLM 兜底:主模型无视觉+vlm 配置 → 图转文字描述(不进视觉通道)", async () => {
    const r = await runTool("view_image", { paths: ["pic.png"] }, {
      mainHasVision: false,
      vlm: { chat: async (m) => {
        // 断言 vlm 收到带 images 的 user 消息
        const u = m.find((x) => x.role === "user") as { images?: string[] };
        expect(u?.images?.[0]?.startsWith("data:image/png;base64,")).toBe(true);
        return { content: "· 一个红色按钮「开始」\n· 顶部标题栏写着 DEMO" };
      } },
    });
    expect(r.startsWith("[VLM 图像描述 pic.png]")).toBe(true);
    expect(r).toContain("红色按钮");
    expect(r).not.toContain(VISION_TOOL_SENTINEL);
  });

  it("VLM 兜底:主模型无视觉+vlm 抛错 → 如实报错", async () => {
    const r = await runTool("view_image", { paths: ["pic.png"] }, {
      mainHasVision: false,
      vlm: { chat: async () => { throw new Error("401 无凭证"); } },
    });
    expect(r).toContain("视觉兜底模型调用失败");
    expect(r).toContain("401");
  });

  it("VLM 兜底:主模型无视觉+未配置 vlm → 明确报错(没有就不能处理图片)", async () => {
    const r = await runTool("view_image", { paths: ["pic.png"] }, { mainHasVision: false });
    expect(r).toContain("无视觉能力");
    expect(r).toContain("coding.vlm");
    expect(r).toContain("无法处理图片");
  });

  it("read_file 二进制分级指路:pdf/office/视频各有诚实出口", async () => {
    const r1 = await runTool("read_file", { path: "doc.pdf" });
    expect(r1).toContain("pdftotext");
    expect(r1).toContain("view_image");
    const r2 = await runTool("read_file", { path: "deck.pptx" });
    expect(r2).toContain("Office 文档");
    const r3 = await runTool("read_file", { path: "clip.mp4" });
    expect(r3).toContain("转关键帧截图");
  });
});
