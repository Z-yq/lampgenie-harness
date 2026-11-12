import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_VIDEO_BYTES, MAX_RECORD_MS,
  parseVideoDataUrl, parseKeyframes, strokeTimeline, processAnnotateRecord,
  type RecordDeps, type RecordMsg, type RecordStroke,
} from "../src/annotate-record.js";

/** 录屏批注(annotate.record)服务端纯逻辑回归。
 * 锁四件事:①dataURL 解析与 12MB 上限;②关键帧过滤(仅 jpeg / ≤4 张 / 单张 ≤2MB);
 * ③笔迹时间轴排序与文案(rect=框选 / pen=手绘);④主流程落盘 .webm + .record.json 与 fail-soft(无 parser 也投递)。
 * 不依赖网关、不依赖 LLM(依赖全注入)。
 * 跑法:cd apps/gateway && timeout 240 npx vitest run test/annotate-record.test.ts */

const B64 = (b: Buffer) => b.toString("base64");
const videoUrl = (b: Buffer) => "data:video/webm;base64," + B64(b);
const jpegUrl = (b: Buffer) => "data:image/jpeg;base64," + B64(b);

describe("parseVideoDataUrl", () => {
  it("合法 webm dataURL:base64 往返字节一致", () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01, 0x7f, 0xff, 0x42]);
    const parsed = parseVideoDataUrl(videoUrl(bytes));
    expect(parsed.mime).toBe("video/webm");
    expect(parsed.bytes.equals(bytes)).toBe(true);
  });
  it("带 codecs 参数的 webm 也认", () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const parsed = parseVideoDataUrl("data:video/webm;codecs=vp8;base64," + B64(bytes));
    expect(parsed.bytes.equals(bytes)).toBe(true);
  });
  it("非 video/webm 抛错", () => {
    expect(() => parseVideoDataUrl("data:video/mp4;base64,AAAA")).toThrow(/webm/);
    expect(() => parseVideoDataUrl("data:audio/webm;base64,AAAA")).toThrow(/webm/);
    expect(() => parseVideoDataUrl("随便一段文字")).toThrow(/webm/);
  });
  it("空 base64 抛错", () => {
    expect(() => parseVideoDataUrl("data:video/webm;base64,")).toThrow(/为空/);
    expect(() => parseVideoDataUrl("")).toThrow();
  });
  it("超过 MAX_VIDEO_BYTES 抛错", () => {
 // 12MB 上限只能靠「真造一段超限字节」触发(无注入点);一次性分配 ~13MB Buffer + ~17MB base64 字符串,可接受。
    const tooBig = Buffer.alloc(MAX_VIDEO_BYTES + 1024, 7);
    expect(() => parseVideoDataUrl(videoUrl(tooBig))).toThrow(/过大/);
 // 恰好等于上限:不抛(边界不误伤)
    const atLimit = Buffer.alloc(MAX_VIDEO_BYTES, 7);
    expect(parseVideoDataUrl(videoUrl(atLimit)).bytes.length).toBe(MAX_VIDEO_BYTES);
  });
});

describe("parseKeyframes", () => {
  const jpeg = (fill: number, size = 32) => Buffer.alloc(size, fill);
  it("空/缺省 → 空数组", () => {
    expect(parseKeyframes(undefined)).toEqual([]);
    expect(parseKeyframes([])).toEqual([]);
  });
  it("非 jpeg 前缀被跳过", () => {
    const out = parseKeyframes(["data:image/png;base64," + B64(jpeg(1)), "乱写", jpegUrl(jpeg(2))]);
    expect(out).toHaveLength(1);
    expect(out[0].equals(jpeg(2))).toBe(true);
  });
  it("最多取 4 张", () => {
    const list = [1, 2, 3, 4, 5, 6].map((n) => jpegUrl(jpeg(n)));
    const out = parseKeyframes(list);
    expect(out).toHaveLength(4);
    expect(out.map((b) => b[0])).toEqual([1, 2, 3, 4]);
  });
  it("单张 >2MB 被跳过(不影响同批其他帧)", () => {
    const huge = Buffer.alloc(2 * 1024 * 1024 + 1, 9);
    const out = parseKeyframes([jpegUrl(huge), jpegUrl(jpeg(5, 64))]);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(64);
  });
});

describe("strokeTimeline", () => {
  const rect: RecordStroke = { kind: "rect", t: 1000, x1: 10, y1: 20, x2: 110, y2: 80 };
  const pen: RecordStroke = { kind: "pen", t: 5000, x1: 300.4, y1: 200.6, x2: 310, y2: 210, points: [{ x: 300, y: 200 }, { x: 310, y: 210 }] };
  it("空输入返回空串", () => {
    expect(strokeTimeline([], 5000)).toBe("");
    expect(strokeTimeline(undefined as unknown as RecordStroke[], 0)).toBe("");
  });
  it("乱序输入按 t 升序,rect/pen 各自带「框选」「手绘」", () => {
    const text = strokeTimeline([pen, rect], 6000);
    expect(text.startsWith("时长 0:06")).toBe(true);
    const lines = text.split("\n").slice(1).filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("框选");
    expect(lines[0]).toContain("0:01");
    expect(lines[0]).toContain("(10,20)");
    expect(lines[0]).toContain("(110,80)");
    expect(lines[1]).toContain("手绘");
    expect(lines[1]).toContain("0:05");
    expect(lines[1]).toContain("2 点");
  });
});

describe("processAnnotateRecord(注入依赖,真落盘)", () => {
  const io = {
    mkdirSync: (p: string, o: { recursive: boolean }) => { mkdirSync(p, o); },
    existsSync: (p: string) => existsSync(p),
    writeFileSync: (p: string, d: Buffer | string, enc?: "utf8") => { if (enc) writeFileSync(p, d, enc); else writeFileSync(p, d); },
  };
  const STROKES: RecordStroke[] = [
    { kind: "rect", t: 800, x1: 100, y1: 100, x2: 220, y2: 180 },
    { kind: "pen", t: 1500, x1: 400, y1: 300, x2: 460, y2: 360, points: [{ x: 400, y: 300 }, { x: 460, y: 360 }] },
  ];

  function harness(opts: { parser?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "genie-rec-"));
    const proj = join(root, "demo");
    mkdirSync(proj, { recursive: true });
    const submitted: { role: string; sessionId: string; instruction: string; extra?: unknown }[] = [];
    const journal: { kind: string; sessionId: string; payload: unknown }[] = [];
    const base: RecordDeps = {
      projects: { list: () => [{ id: "p1", path: proj }], resolveWorkdir: () => proj },
      tm: {
        list: () => [],
        submit: (role, sessionId, instruction, extra) => { submitted.push({ role, sessionId, instruction, extra }); return { id: "task-1" }; },
      },
      journal: { append: (e) => { journal.push(e); } },
    };
    const deps: RecordDeps = opts.parser === false
      ? base
      : { ...base, parser: { model: "fake-omni", parse: async () => ({ taskBook: "## 用户意图\n把按钮改大", transcript: "把按钮改大" }) } };
    const msg: RecordMsg = {
      sessionId: "s1",
      projectId: "p1",
      videoUrl: videoUrl(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9, 9])),
      keyframes: [jpegUrl(Buffer.alloc(64, 3))],
      strokes: STROKES,
      durationMs: 2000,
      pageContext: "设置页",
    };
    return { root, proj, deps, msg, submitted, journal };
  }

  it("happy path:解析成功 → 落盘 .webm + .record.json + 投递新任务", async () => {
    const h = harness();
    try {
      const out = await processAnnotateRecord(h.deps, h.msg, io);
      expect(out.ok).toBe(true);
      expect(out.refined).toBe(true);
      expect(out.parseError).toBeUndefined();
      expect(out.taskId).toBe("task-1");
      expect(out.queued).toBe(false);
      expect(out.videoPath!.endsWith(".webm")).toBe(true);
      expect(out.feedbackPath!.endsWith(".record.json")).toBe(true);
      expect(existsSync(out.videoPath!)).toBe(true);
      expect(existsSync(out.feedbackPath!)).toBe(true);
      expect(readFileSync(out.videoPath!).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9, 9]))).toBe(true);
      const fb = JSON.parse(readFileSync(out.feedbackPath!, "utf8"));
      expect(fb.schemaVersion).toBe("record-minimal-1");
      expect(fb.durationMs).toBe(2000);
      expect(fb.strokes).toHaveLength(2);
      expect(fb.keyframes).toBe(1);
      expect(fb.capture.page).toBe("设置页");
      expect(fb.timeline).toContain("框选");
      expect(fb.video.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(h.submitted).toHaveLength(1);
      expect(h.submitted[0].instruction).toContain("把按钮改大");
      expect(h.journal.map((j) => (j.payload as { type: string }).type)).toEqual(["annotate.record.parse", "annotate.record"]);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("无 parser:fail-soft 仍 ok:true,模板任务书 + parseError,文件照常落盘", async () => {
    const h = harness({ parser: false });
    try {
      const out = await processAnnotateRecord(h.deps, h.msg, io);
      expect(out.ok).toBe(true);
      expect(out.refined).toBe(false);
      expect(out.parseError).toMatch(/未配置/);
      expect(out.taskId).toBe("task-1");
      expect(existsSync(out.videoPath!)).toBe(true);
      expect(existsSync(out.feedbackPath!)).toBe(true);
      expect(h.submitted[0].instruction).toContain("录屏");
      expect(h.submitted[0].instruction).toContain(out.videoPath!);
 // 只有一条 journal(无 parse 事件)
      expect(h.journal.map((j) => (j.payload as { type: string }).type)).toEqual(["annotate.record"]);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("拒绝路径:超时长 / 缺项目 / 坏视频 → ok:false 且不投递", async () => {
    const h = harness();
    try {
      const tooLong = await processAnnotateRecord(h.deps, { ...h.msg, durationMs: MAX_RECORD_MS + 60_000 }, io);
      expect(tooLong.ok).toBe(false);
      expect(tooLong.message).toMatch(/120s/);
      const noProj = await processAnnotateRecord(h.deps, { ...h.msg, projectId: undefined }, io);
      expect(noProj.ok).toBe(false);
      const badVideo = await processAnnotateRecord(h.deps, { ...h.msg, videoUrl: "data:video/mp4;base64,AAAA" }, io);
      expect(badVideo.ok).toBe(false);
      expect(h.submitted).toHaveLength(0);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});
