import { describe, it, expect, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import { readFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  parsePngDataUrl, snapRegion, snapPoint, normalizeNotes, buildFeedback, buildInstruction, capturePaths,
  processAnnotateSubmit, normalizeCapture, normalizePageContext, parseJpegDataUrl,
} from "../src/annotate.js";
import { parseClientMessage, ClientMessage, ServerMessage } from "@lampgenie/protocol";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

/** 截图标注(面板自有能力)的服务端契约回归。
 * 锁四件事:①PNG 解析与尺寸上限;②几何规整规则(
 * 取整/夹边/x2≥x1+1);③feedback-minimal-4 兼容导出结构(id/kind/annotations 编号/image 描述符);
 * ④协议消息双向可解析。UI 面在 panel.ts 模板字符串内,这里锁结构性锚点(按钮/覆盖层/提交链)。 */

const HERE = dirname(fileURLToPath(import.meta.url));
import { PANEL_SRC } from "./panel-source.js";

/** 手工构造 PNG 头(仅 parsePngDataUrl 消费的 magic+IHDR 前 24 字节;CRC 不校验,补齐 33 字节)。 */
function pngBytes(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt8(8, 24);
  b.writeUInt8(6, 25);
  return "data:image/png;base64," + b.toString("base64");
}

/** 手工构造 JPEG 头(FFD8+SOF0 段带尺寸;仅 parseJpegDataUrl 消费)。 */
function jpegBytes(w: number, h: number): string {
  const b = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
    0x03, 0x01, 0x22, 0x00, 0xff, 0xda, 0x00, 0x02,
  ]);
  return "data:image/jpeg;base64," + b.toString("base64");
}

describe("annotate 解析", () => {
  it("合法 PNG:尺寸+sha256 从字节实测", () => {
    const info = parsePngDataUrl(pngBytes(640, 400));
    expect(info.width).toBe(640);
    expect(info.height).toBe(400);
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(info.bytes.length).toBe(33);
  });
  it("非法输入逐类拒绝", () => {
    expect(() => parsePngDataUrl("data:image/jpeg;base64,AAAA")).toThrow(/dataURL/);
    expect(() => parsePngDataUrl("data:image/png;base64,####")).toThrow();
    expect(() => parsePngDataUrl("data:image/png;base64," + Buffer.alloc(10).toString("base64"))).toThrow(/PNG|IHDR/);
    expect(() => parsePngDataUrl(pngBytes(0, 10))).toThrow(/尺寸/);
    expect(() => parsePngDataUrl(pngBytes(40000, 10))).toThrow(/尺寸/);
    expect(() => parsePngDataUrl(pngBytes(32767, 32767))).toThrow(/尺寸/); // >3200 万像素
  });
});

describe("几何规整(区域/点批注语义)", () => {
  it("区域:取整+夹边+右下开区间(x2≥x1+1)", () => {
    expect(snapRegion({ x1: 10.4, y1: 20.6, x2: 100.5, y2: 80.2 }, 200, 100)).toEqual({ x1: 10, y1: 21, x2: 101, y2: 80 });
    expect(snapRegion({ x1: -5, y1: -5, x2: 999, y2: 999 }, 200, 100)).toEqual({ x1: 0, y1: 0, x2: 200, y2: 100 });
    expect(snapRegion({ x1: 50, y1: 50, x2: 50, y2: 50 }, 200, 100)).toEqual({ x1: 50, y1: 50, x2: 51, y2: 51 });
    expect(snapRegion({ x1: 199, y1: 99, x2: 199, y2: 99 }, 200, 100)).toEqual({ x1: 199, y1: 99, x2: 200, y2: 100 });
  });
  it("点:取整+夹边到 0..w-1", () => {
    expect(snapPoint({ x: 10.6, y: 20.2 }, 200, 100)).toEqual({ x: 11, y: 20 });
    expect(snapPoint({ x: -3, y: 999 }, 200, 100)).toEqual({ x: 0, y: 99 });
  });
});

describe("批注规整与导出", () => {
  const notes = [
    { kind: "region", source: { x1: 1.2, y1: 2.8, x2: 30, y2: 40 }, text: "按钮太小" },
    { kind: "point", point: { x: 50.5, y: 60.2 }, text: "这里对齐有误" },
    { kind: "global", text: "整体间距偏紧" },
  ] as const;
  it("normalizeNotes:文本必填/未知类型拒绝/几何规整落地", () => {
    const out = normalizeNotes(notes as never, 200, 100);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: "region", source: { x1: 1, y1: 3, x2: 30, y2: 40 }, text: "按钮太小" });
    expect(out[1]).toEqual({ kind: "point", point: { x: 51, y: 60 }, text: "这里对齐有误" });
    expect(() => normalizeNotes([{ kind: "global", text: "  " }] as never, 200, 100)).toThrow(/为空/);
    expect(() => normalizeNotes([{ kind: "line", text: "x" }] as never, 200, 100)).toThrow(/未知批注类型/);
  });
  it("buildFeedback:feedback-minimal-4 兼容结构+编号=id 顺序一致", () => {
    const png = parsePngDataUrl(pngBytes(200, 100));
    const fb = buildFeedback(png, "capture-x.png", normalizeNotes(notes as never, 200, 100), "capture-x.annotated.jpg");
    expect(fb.schemaVersion).toBe("feedback-minimal-4");
    expect(fb.tool.name).toBe("LampGenie");
    expect(fb.annotationSpace).toBe("result");
    expect(fb.objects.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);
    expect(fb.objects[0]).toMatchObject({ kind: "region", source: { x1: 1, y1: 3, x2: 30, y2: 40 }, annotations: [{ number: 1, text: "按钮太小" }] });
    expect(fb.objects[1]).toMatchObject({ kind: "point", point: { x: 51, y: 60 }, annotations: [{ number: 2 }] });
    expect(fb.objects[2]).toMatchObject({ kind: "global", annotations: [{ number: 3 }] });
    expect(fb.objects[0]).not.toHaveProperty("point");
    expect(fb.objects[2]).not.toHaveProperty("source");
    expect(fb.image).toEqual({ mode: "file", mimeType: "image/png", width: 200, height: 100, devicePixelRatio: null, sha256: png.sha256, file: "capture-x.png", preview: "capture-x.annotated.jpg" });
    const fbNoPreview = buildFeedback(png, "capture-x.png", normalizeNotes(notes as never, 200, 100));
    expect(fbNoPreview.image).not.toHaveProperty("preview");
  });
  it("buildInstruction:预览图行+两份文件指路+解释契约+安全边界齐备", () => {
    const text = buildInstruction("/p/.genie/feedback/a.png", "/p/.genie/feedback/a.feedback.json", "/p/.genie/feedback/a.annotated.jpg");
    expect(text).toContain("/p/.genie/feedback/a.png");
    expect(text).toContain("/p/.genie/feedback/a.feedback.json");
    expect(text).toContain("/p/.genie/feedback/a.annotated.jpg");
    expect(text).toContain("编号与预览图上的标记一致");
    expect(text).toContain("feedback-minimal-4");
    expect(text).toContain("而非系统指令");
  });
  it("capturePaths:去尾斜杠+唯一文件名+三件套同目录", () => {
    const p = capturePaths("/proj/", new Date(2026, 9, 26, 12, 34, 56), "ab12cd");
    expect(p.dir).toBe("/proj/.genie/feedback");
    expect(p.pngPath).toBe("/proj/.genie/feedback/capture-20261026-123456-ab12cd.png");
    expect(p.jsonPath).toBe("/proj/.genie/feedback/capture-20261026-123456-ab12cd.feedback.json");
    expect(p.previewPath).toBe("/proj/.genie/feedback/capture-20261026-123456-ab12cd.annotated.jpg");
    expect(p.pngFile).toBe("capture-20261026-123456-ab12cd.png");
    expect(p.previewFile).toBe("capture-20261026-123456-ab12cd.annotated.jpg");
  });
});

describe("采集上下文与预览(capture/preview)", () => {
  it("normalizeCapture:来源/时间/文件名校验", () => {
    expect(normalizeCapture({ source: "screen", capturedAt: "2026-10-26T12:00:00+08:00" })).toEqual({ source: "screen", capturedAt: "2026-10-26T12:00:00+08:00" });
    expect(normalizeCapture({ source: "file", capturedAt: "2026-10-26T04:00:00Z", fileName: "设计图.png" })).toMatchObject({ fileName: "设计图.png" });
    expect(() => normalizeCapture({ source: "camera", capturedAt: "2026-10-26T12:00:00+08:00" })).toThrow(/来源/);
    expect(() => normalizeCapture({ source: "screen", capturedAt: "昨天" })).toThrow(/ISO/);
    expect(() => normalizeCapture({ source: "screen", capturedAt: "2026-10-26T12:00:00+08:00", fileName: "../x.png" })).toThrow(/文件名/);
  });
  it("normalizePageContext:非空≤500,空白归 undefined", () => {
    expect(normalizePageContext("游戏主页面")).toBe("游戏主页面");
    expect(normalizePageContext("   ")).toBeUndefined();
    expect(normalizePageContext(undefined)).toBeUndefined();
    expect(() => normalizePageContext("长".repeat(501))).toThrow(/500/);
  });
  it("parseJpegDataUrl:SOF 尺寸实测", () => {
    expect(parseJpegDataUrl(jpegBytes(320, 240))).toMatchObject({ width: 320, height: 240 });
    expect(() => parseJpegDataUrl("data:image/png;base64,AAAA")).toThrow(/dataURL/);
    expect(() => parseJpegDataUrl(pngBytes(10, 10))).toThrow(/image\/jpeg/);
  });
});

describe("协议与面板锚点", () => {
  it("annotate.submit 可被 ClientMessage 解析;annotate.result 属于 ServerMessage", () => {
    const msg = { v: 1, type: "annotate.submit", sessionId: "web-1", dataUrl: pngBytes(10, 10), notes: [{ kind: "global", text: "ok" }] };
    expect(parseClientMessage(JSON.stringify(msg))?.type).toBe("annotate.submit");
    expect(() => ClientMessage.parse({ ...msg, notes: [] })).toThrow(); // 空批注拒绝
    expect(ServerMessage.safeParse({ v: 1, type: "annotate.result", ok: true, feedbackPath: "/x" }).success).toBe(true);
    expect(ServerMessage.safeParse({ v: 1, type: "annotate.result", ok: false, message: "m" }).success).toBe(true);
  });
  it("panel.ts 结构锚点:按钮/覆盖层/编辑器/提交链(预览+capture)/导入/重做/回执分发", () => {
    expect(PANEL_SRC).toContain('id="shotBtn"');
    expect(PANEL_SRC).toContain('id="capOverlay"');
    expect(PANEL_SRC).toContain('id="annEditor"');
    expect(PANEL_SRC).toContain('type: "annotate.submit"');
    expect(PANEL_SRC).toContain("previewDataUrl");
    expect(PANEL_SRC).toContain("pageContext");
    expect(PANEL_SRC).toContain('id="annPage"');
    expect(PANEL_SRC).toContain('id="annImportBtn"');
    expect(PANEL_SRC).toContain('id="annRedoBtn"');
    expect(PANEL_SRC).toContain("window.__annTestOpen");
    expect(PANEL_SRC).toContain('m.type === "annotate.result"');
    expect(PANEL_SRC).toContain("getDisplayMedia");
    expect(PANEL_SRC).toContain("beforeunload");
  });
});

describe("processAnnotateSubmit 全链(依赖注入+真实临时目录)", () => {
  const TMP = mkdtempSync(join(tmpdir(), "genie-ann-e2e-"));
  const PROJECT_ROOT = join(TMP, "proj");
  const realIo = { mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, writeFileSync: fs.writeFileSync };
  const PNG = pngBytes(8, 6);
  const PREVIEW = jpegBytes(8, 6);
  afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ } });

  function deps(over?: { running?: boolean; remote?: boolean }) {
    mkdirSync(PROJECT_ROOT, { recursive: true });
    const submitted: { instruction: string; projectId?: string }[] = [];
    const enqueued: { instruction: string; projectId?: string }[] = [];
    const journalEntries: unknown[] = [];
    return {
      deps: {
        projects: {
          list: () => [{ id: "p1", path: over?.remote ? "remote:ssh:host@x:/w" : PROJECT_ROOT }],
          resolveWorkdir: (id?: string) => (id === "p1" && !over?.remote ? PROJECT_ROOT : TMP),
        },
        tm: {
          list: () => (over?.running ? [{ sessionId: "s1", state: "running" }] : []),
          submit: (_src: string, _sid: string, instruction: string, o?: { projectId?: string }) => {
            submitted.push({ instruction, projectId: o?.projectId });
            return { id: "task-1" };
          },
        },
        journal: { append: (e: unknown) => { journalEntries.push(e); } },
        queueApi: { enqueue: (m: { instruction: string; projectId?: string }) => { enqueued.push(m); return {}; } },
      },
      submitted, enqueued, journalEntries,
    };
  }
  const MSG = { sessionId: "s1", dataUrl: PNG, projectId: "p1", notes: [
    { kind: "region" as const, source: { x1: 1, y1: 2, x2: 5, y2: 4 }, text: "第一个意见" },
    { kind: "global" as const, text: "整体意见" },
  ] };

  it("闲会话:落盘三件(原图+预览+反馈)+capture/page 上下文+新任务投递", async () => {
    const d = deps();
    const out = await processAnnotateSubmit(d.deps, {
      ...MSG,
      previewDataUrl: PREVIEW,
      capture: { source: "file", capturedAt: "2026-10-26T12:00:00+08:00", fileName: "设计图.png" },
      pageContext: "设置页",
    }, realIo);
    expect(out.ok).toBe(true);
    expect(out.queued).toBe(false);
    expect(out.taskId).toBe("task-1");
    expect(existsSync(out.imagePath!)).toBe(true);
    expect(existsSync(out.previewPath!)).toBe(true);
    expect(existsSync(out.feedbackPath!)).toBe(true);
    const fb = JSON.parse(readFileSync(out.feedbackPath!, "utf8"));
    expect(fb.schemaVersion).toBe("feedback-minimal-4");
    expect(fb.objects).toHaveLength(2);
    const pngOnDisk = readFileSync(out.imagePath!);
    expect(pngOnDisk.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    expect(fb.image.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fb.image.preview).toMatch(/\.annotated\.jpg$/);
    expect(fb.capture).toEqual({ source: "file", capturedAt: "2026-10-26T12:00:00+08:00", fileName: "设计图.png", page: "设置页", pageSource: "agent" });
    expect(d.submitted[0].projectId).toBe("p1");
    expect(d.submitted[0].instruction).toContain(out.feedbackPath!);
    expect(d.submitted[0].instruction).toContain(out.previewPath!);
    expect(d.journalEntries).toHaveLength(1);
  });
  it("无预览/无 capture:按 screen+当前时间补全,不写 image.preview", async () => {
    const d = deps();
    const out = await processAnnotateSubmit(d.deps, MSG, realIo);
    expect(out.ok).toBe(true);
    expect(out.previewPath).toBeUndefined();
    const fb = JSON.parse(readFileSync(out.feedbackPath!, "utf8"));
    expect(fb.image).not.toHaveProperty("preview");
    expect(fb.capture).toMatchObject({ source: "screen" });
    expect(fb.capture.page).toBeUndefined();
  });
  it("movement/children:dx 换算+缩放省略+子批注编号全局连续", async () => {
    const d = deps();
    const out = await processAnnotateSubmit(d.deps, { ...MSG, dataUrl: pngBytes(200, 100), notes: [
      { kind: "region", source: { x1: 10, y1: 20, x2: 40, y2: 60 }, text: "把这块右移", movement: { rect: { x1: 50, y1: 20, x2: 80, y2: 60 } }, children: [
        { source: { x1: 52, y1: 22, x2: 70, y2: 40 }, text: "里面的字加大" },
        { source: { x1: 52, y1: 42, x2: 78, y2: 58 }, text: "边框改圆角" },
      ] },
      { kind: "global", text: "整体还行" },
    ] }, realIo);
    expect(out.ok).toBe(true);
    const fb = JSON.parse(readFileSync(out.feedbackPath!, "utf8"));
    expect(fb.objects[0].movement).toEqual({ rect: { x1: 50, y1: 20, x2: 80, y2: 60 }, dx: 40, dy: 0 });
    expect(fb.objects[0].children.map((c: any) => c.annotations[0].number)).toEqual([2, 3]);
    expect(fb.objects[1].annotations[0].number).toBe(4); // 全局批注编号跨 children 连续
    // 空文本位移批注:annotations 留空(纯布局意图)
    const out2 = await processAnnotateSubmit(d.deps, { ...MSG, notes: [
      { kind: "region", source: { x1: 1, y1: 1, x2: 5, y2: 5 }, text: "", movement: { rect: { x1: 3, y1: 3, x2: 7, y2: 7 } } },
    ] }, realIo);
    if (!out2.ok) console.log("out2 message:", out2.message);
    expect(out2.ok).toBe(true);
    const fb2 = JSON.parse(readFileSync(out2.feedbackPath!, "utf8"));
    expect(fb2.objects[0].annotations).toEqual([]);
    expect(fb2.objects[0].movement.dx).toBe(2);
    // 非位移 region 空文本仍拒绝
    const out3 = await processAnnotateSubmit(d.deps, { ...MSG, notes: [{ kind: "region", source: { x1: 1, y1: 1, x2: 5, y2: 5 }, text: "" }] }, realIo);
    expect(out3.ok).toBe(false);
  });
  it("预览尺寸与原图不一致拒绝且不留半成品", async () => {
    const d = deps();
    const out = await processAnnotateSubmit(d.deps, { ...MSG, previewDataUrl: jpegBytes(99, 99) }, realIo);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("尺寸");
    expect(d.submitted).toHaveLength(0);
  });
  it("忙会话:入队不建任务,文件照常落盘", async () => {
    const d = deps({ running: true });
    const out = await processAnnotateSubmit(d.deps, MSG, realIo);
    expect(out).toMatchObject({ ok: true, queued: true });
    expect(d.enqueued).toHaveLength(1);
    expect(d.submitted).toHaveLength(0);
    expect(existsSync(out.feedbackPath!)).toBe(true);
  });
  it("远程项目拒绝落盘", async () => {
    const d = deps({ remote: true });
    const out = await processAnnotateSubmit(d.deps, MSG, realIo);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("远程项目");
  });
  it("未选项目拒绝", async () => {
    const d = deps();
    const out = await processAnnotateSubmit(d.deps, { ...MSG, projectId: undefined }, realIo);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("本地项目");
  });
  it("prepareAttachments:附件随任务/入队投递,钩子抛错不阻塞反馈", async () => {
    const d = deps();
    const seen: { submitted?: unknown; enqueued?: unknown } = {};
    d.deps.tm.submit = (_s, _sid, instruction, o) => { seen.submitted = o; return { id: "task-att" }; };
    const out = await processAnnotateSubmit(
      { ...d.deps, prepareAttachments: (info) => (info.previewPath ? [{ name: "a.annotated.jpg", path: "/uploads/x.jpg", mime: "image/jpeg", size: 123 }] : undefined) },
      { ...MSG, previewDataUrl: PREVIEW }, realIo);
    expect(out.ok).toBe(true);
    expect((seen.submitted as { attachments?: unknown[] }).attachments).toHaveLength(1);
    // 忙会话同路
    const d2 = deps({ running: true });
    const out2 = await processAnnotateSubmit(
      { ...d2.deps, prepareAttachments: () => [{ name: "x", path: "/y" }] },
      MSG, realIo);
    expect(out2.ok).toBe(true);
    expect(d2.enqueued[0]).toMatchObject({ attachments: [{ name: "x" }] });
    // 钩子抛错:反馈照常投递
    const d3 = deps();
    const out3 = await processAnnotateSubmit({ ...d3.deps, prepareAttachments: () => { throw new Error("disk full"); } }, MSG, realIo);
    expect(out3.ok).toBe(true);
    expect(d3.submitted).toHaveLength(1);
  });
  it("坏图拒绝且不留半成品", async () => {
    const d = deps();
    const out = await processAnnotateSubmit(d.deps, { ...MSG, dataUrl: "data:image/png;base64,AAAA" }, realIo);
    expect(out.ok).toBe(false);
    expect(d.submitted).toHaveLength(0);
  });
});

describe("annotate.submit 经真实 WS 网关(echo 执行器,不经 LLM)", () => {
  const WS_ROOT = mkdtempSync(join(tmpdir(), "genie-ann-ws-"));
  const PROJ = join(WS_ROOT, "demo");
  const OLD_ROOT = process.env.GENIE_REPO_ROOT;
  const PORT = 7943;
  let app: GatewayApp | null = null;

  beforeEach(() => {
    process.env.GENIE_REPO_ROOT = WS_ROOT;
    mkdirSync(PROJ, { recursive: true });
  });
  afterAll(async () => {
    if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = OLD_ROOT;
    try { rmSync(WS_ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  });

  it("project.add→annotate.submit→回执 ok+盘上成对文件+任务创建", async () => {
    app = createGatewayApp({ port: PORT, executor: new EchoChildBackend(), journalDir: join(WS_ROOT, ".genie", "journals") });
    const ws = new WebSocket("ws://127.0.0.1:" + PORT);
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    const wait = async (pred: (m: Record<string, unknown>) => boolean, label: string, timeout = 15000): Promise<Record<string, unknown>> => {
      const hit = inbox.find(pred);
      if (hit) return hit;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        await new Promise((r) => setTimeout(r, 50));
        const h = inbox.find(pred);
        if (h) return h;
      }
      throw new Error("等待超时: " + label);
    };
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: PROJ }));
    const added = await wait((m) => m.type === "project.list.result" && (m.projects as { path: string }[]).some((p) => p.path === PROJ), "project.add ack");
    const projectId = String((added.projects as { path: string; id: string }[]).find((p) => p.path === PROJ)!.id);
    ws.send(JSON.stringify({ v: 1, type: "annotate.submit", sessionId: "ann-e2e-1", dataUrl: pngBytes(64, 48), notes: [
      { kind: "region", source: { x1: 2, y1: 3, x2: 40, y2: 30 }, text: "标题层级不对" },
      { kind: "point", point: { x: 50, y: 40 }, text: "按钮应该在这里" },
      { kind: "global", text: "整体配色偏暗" },
    ], previewDataUrl: jpegBytes(64, 48), capture: { source: "screen", capturedAt: "2026-10-26T12:00:00+08:00" }, pageContext: "主页面" } as never));
    const result = await wait((m) => m.type === "annotate.result", "annotate.result");
    expect(result.ok).toBe(true);
    expect(result.queued).toBe(false);
    expect(String(result.feedbackPath)).toContain(join(PROJ, ".genie", "feedback"));
    expect(existsSync(String(result.imagePath))).toBe(true);
    expect(existsSync(String(result.previewPath))).toBe(true);
    const fb = JSON.parse(readFileSync(String(result.feedbackPath), "utf8"));
    expect(fb.objects.map((o: { kind: string }) => o.kind)).toEqual(["region", "point", "global"]);
    expect(fb.objects[2].annotations[0].text).toBe("整体配色偏暗");
    expect(fb.image.preview).toBe(String(result.previewPath).split("/").pop());
    expect(fb.capture).toMatchObject({ source: "screen", page: "主页面", pageSource: "agent" });
    // 聊天侧可见性:预览复制进 /uploads 白名单根(.genie/uploads/<sid>/annotate-*)
    const uploadsDir = join(WS_ROOT, ".genie", "uploads", "ann-e2e-1");
    expect(fs.readdirSync(uploadsDir).some((f) => f.startsWith("annotate-") && f.endsWith(".annotated.jpg"))).toBe(true);
 // 列表帧只带索引(协议索引化):正文改按 id 走 task.detail.get 往返。
    ws.send(JSON.stringify({ v: 1, type: "task.list" }));
    const tl = await wait((m) => m.type === "task.list" && Array.isArray(m.tasks) && m.tasks.some((t: { sessionId: string }) => t.sessionId === "ann-e2e-1"), "task.list");
    const annRow = (tl.tasks as { sessionId: string; id: string; instruction?: string }[]).find((t) => t.sessionId === "ann-e2e-1")!;
    expect(annRow.instruction).toBeUndefined();
    ws.send(JSON.stringify({ v: 1, type: "task.detail.get", taskId: annRow.id }));
    const detail = await wait((m) => m.type === "task.detail.result" && m.taskId === annRow.id, "task.detail.result");
    const annTask = detail.task as { id: string; instruction: string } | null;
    expect(annTask!.instruction).toContain(String(result.feedbackPath));
    // 审计:journal 落 annotate.submit custom 条目(sharded 布局不假设具体文件,递归扫)
    const journalDir = join(WS_ROOT, ".genie", "journals");
    const found = fs.readdirSync(journalDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .some((e) => readFileSync(join(e.parentPath ?? journalDir, e.name), "utf8").includes("annotate.submit"));
    expect(found).toBe(true);
    ws.close();
  }, 40000);
});

/** 录音批注 + 小模型整理(2026-11 新增轨):两者都 fail-soft——转写失败只带 voiceError,
 * 整理失败回落模板任务书,提交与落盘都不受影响。 */
describe("annotate.submit 录音转写与任务书整理", () => {
  const ROOT = mkdtempSync(join(tmpdir(), "genie-ann-voice-"));
  const PROJ = join(ROOT, "proj");
  mkdirSync(PROJ, { recursive: true });
  const io = { mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, writeFileSync: fs.writeFileSync };
  const AUDIO_URL = "data:audio/webm;codecs=opus;base64," + Buffer.from("opus-bytes").toString("base64");
  const PNG2 = pngBytes(8, 6);
  const TRANSCRIPT = "左上角按钮太小\n整体间距偏紧";

  /** 合规的整理输出(原话逐字在场,否则 refineInstruction 会回落)。 */
  const GOOD_REFINE = [
    "## 用户意图", "把标注里指出的两处问题一并改掉。",
    "## 问题清单", "- 现象:按钮偏小 / 图上位置:右上 / 用户原话:「第一个意见」", "- 现象:间距偏紧 / 图上位置:全图 / 用户原话:「整体意见」",
    "- 现象:口述补充 / 图上位置:左上 / 用户原话:「左上角按钮太小」", "- 现象:口述补充 / 图上位置:全图 / 用户原话:「整体间距偏紧」",
    "## 期望结果", "按钮可点性达标。", "## 优先级建议", "P1。", "## 验收标准", "按钮不小于 32px。",
  ].join("\n");

  function mkDeps(over?: { refineContent?: string; voiceThrows?: boolean }) {
    const submitted: { instruction: string; projectId?: string }[] = [];
    const journalEntries: { kind: string; payload: { type?: string } }[] = [];
    const deps = {
      projects: { list: () => [{ id: "p1", path: PROJ }], resolveWorkdir: () => PROJ },
      tm: {
        list: () => [] as { sessionId: string; state: string }[],
        submit: (_s: string, _sid: string, instruction: string, o?: { projectId?: string }) => {
          submitted.push({ instruction, ...(o?.projectId ? { projectId: o.projectId } : {}) });
          return { id: "task-1" };
        },
      },
      journal: { append: (e: unknown) => { journalEntries.push(e as never); } },
      refine: {
        enabled: true,
        llm: { chat: async () => ({ content: over?.refineContent ?? GOOD_REFINE }) },
      },
      voice: {
        model: "qwen3.8-omni-flash",
        parser: async () => {
          if (over?.voiceThrows) throw new Error("HTTP 500 upstream");
          return { text: TRANSCRIPT, segments: [{ at: "左上", text: "左上角按钮太小" }, { at: "整体", text: "整体间距偏紧" }] };
        },
      },
    };
    return { deps, submitted, journalEntries };
  }

  const MSG = {
    sessionId: "s1", dataUrl: PNG2, projectId: "p1",
    notes: [
      { kind: "region" as const, source: { x1: 1, y1: 1, x2: 4, y2: 4 }, text: "第一个意见" },
      { kind: "global" as const, text: "整体意见" },
    ],
    audioUrl: AUDIO_URL,
  };

  it("带 audioUrl + 假转写器:落盘 .webm + 转写进任务书 + 走整理", async () => {
    const d = mkDeps();
    const out = await processAnnotateSubmit(d.deps, MSG, io);
    expect(out.ok).toBe(true);
    expect(out.refined).toBe(true);
    expect(out.voiceError).toBeUndefined();
    expect(out.voicePath!.endsWith(".webm")).toBe(true);
    expect(existsSync(out.voicePath!)).toBe(true);
    expect(readFileSync(out.voicePath!).toString()).toBe("opus-bytes");
    const instruction = d.submitted[0].instruction;
    expect(instruction).toContain("左上角按钮太小");
    expect(instruction).not.toContain("未经 LLM 整理");
  });

  it("转写抛错:ok:true 且带 voiceError,音频仍在盘上", async () => {
    const d = mkDeps({ voiceThrows: true });
    const out = await processAnnotateSubmit(d.deps, MSG, io);
    expect(out.ok).toBe(true);
    expect(out.voiceError).toContain("HTTP 500");
    expect(existsSync(out.voicePath!)).toBe(true);
    expect(d.submitted[0].instruction).toContain("录音解析失败");
    expect(d.submitted[0].instruction).toContain(out.voicePath!);
  });

  it("收到 audioUrl 但未配置转写器:voiceError 说明缺凭证,提交照常", async () => {
    const d = mkDeps();
    const { voice: _voice, ...noVoice } = d.deps as typeof d.deps & { voice?: unknown };
    const out = await processAnnotateSubmit(noVoice, MSG, io);
    expect(out.ok).toBe(true);
    expect(out.voiceError).toContain("未配置");
    expect(d.submitted[0].instruction).toContain("录音解析失败");
  });

  it("整理失败(refine 回 false):instruction 末尾有「未经 LLM 整理」", async () => {
    const d = mkDeps({ refineContent: "## 用户意图\n整理时把原话改了" });
    const out = await processAnnotateSubmit({ ...d.deps, voice: undefined } as never, { ...MSG, audioUrl: undefined }, io);
    expect(out.ok).toBe(true);
    expect(out.refined).toBe(false);
    const instruction = d.submitted[0].instruction;
    expect(instruction.trimEnd().endsWith("(注:本次任务书未经 LLM 整理)")).toBe(true);
  });

  it("journal 落 annotate.voice / annotate.refine 两条(不含音频内容/凭证)", async () => {
    const d = mkDeps();
    await processAnnotateSubmit(d.deps, MSG, io);
    const types = d.journalEntries.map((e) => e.payload.type);
    expect(types).toContain("annotate.voice");
    expect(types).toContain("annotate.refine");
    const voice = d.journalEntries.find((e) => e.payload.type === "annotate.voice")!.payload as Record<string, unknown>;
    expect(voice.ok).toBe(true);
    expect(voice.chars).toBe(TRANSCRIPT.length);
    expect(JSON.stringify(d.journalEntries)).not.toContain("opus-bytes");
    expect(JSON.stringify(d.journalEntries)).not.toContain("sk-");
  });

  it("转写失败也落 journal(ok:false + reason)", async () => {
    const d = mkDeps({ voiceThrows: true });
    await processAnnotateSubmit(d.deps, MSG, io);
    const voice = d.journalEntries.find((e) => e.payload.type === "annotate.voice")!.payload as Record<string, unknown>;
    expect(voice.ok).toBe(false);
    expect(String(voice.reason)).toContain("HTTP 500");
  });
});
