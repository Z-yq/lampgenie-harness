/**
 * 重复读取去重:同文件同 mtime + 行段已在上下文 → 不再重复注入正文,只回短提示。
 * 主 agent(createFileTools)与子代理(llmLoopReadOnlyTools)两条路径都测:
 * ①首次全读含正文 ②重复全读→「重复读取·已省略」且不含正文 ③部分窗口重读→省略
 * ④未覆盖窗口→放行注正文 ⑤mtime 变化→放行 ⑥clearReadFiles 后→放行 ⑦force=true→放行
 * 另有 view_image:首看注入 / 同图同 mtime 再看→「已看过·未重复注入」且哨兵不含该图 / force 重注 /
 * 部分跳过写进 payload.note / VLM 兜底分支同样先判重(不重复花 VLM token)。
 * 全部离线可跑(临时目录真文件;mtime 用 utimesSync 改)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { VISION_TOOL_SENTINEL } from "@lampgenie/runtime/agent/loop";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { clearReadFiles } from "@lampgenie/runtime/agent/read-file-state";
import { createFileTools } from "../src/file-tools.js";
import { llmLoopReadOnlyTools } from "../src/llm-loop-backend.js";

const dirs: string[] = [];
const sessions: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "rdd-")); dirs.push(d); return d; };
const sid = (tag: string) => { const s = `rdd-${tag}-${Math.random().toString(36).slice(2)}`; sessions.push(s); return s; };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of sessions.splice(0)) clearReadFiles(s);
});

const BODY_MARK = "MARK-BODY";
/** 800 行夹具(每行带唯一标识,便于断言正文是否真被注入)。 */
const mkProbe = (dir: string): string => {
  const p = join(dir, "probe.txt");
  writeFileSync(p, Array.from({ length: 800 }, (_, i) => `line${i + 1} ${BODY_MARK}`).join("\n"), "utf-8");
  return p;
};
/** 1x1 透明 png。 */
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const mainReadFile = (root: string, sessionId: string): Tool =>
  createFileTools({ root, journal: new MemoryJournal(), sessionId }).find((t) => t.name === "read_file")!;
const subReadFile = (root: string, child: string, parent?: string): Tool =>
  llmLoopReadOnlyTools([root], new Map(), { value: child }, parent).find((t) => t.name === "read_file")!;
const run = async (t: Tool, args: unknown): Promise<string> => String(await t.execute(args, undefined, { callId: "c1" }));

// ---------------- 主 agent 路径(createFileTools) ----------------
describe("主 agent read_file 重复读取去重", () => {
  it("①首次全读:含正文(零改动)", async () => {
    const root = mk(); mkProbe(root);
    const t = mainReadFile(root, sid("m1"));
    const r = await run(t, { path: "probe.txt" });
    expect(r).toContain(BODY_MARK);
    expect(r).toContain("line1 ");
    expect(r).not.toContain("重复读取·已省略");
  });

  it("②重复全读:短提示、不含正文、报已读次数", async () => {
    const root = mk(); mkProbe(root);
    const t = mainReadFile(root, sid("m2"));
    await run(t, { path: "probe.txt" });
    const r2 = await run(t, { path: "probe.txt" });
    expect(r2).toContain("[重复读取·已省略]");
    expect(r2).toContain("自第 1 次读取后未变");
    expect(r2).toContain("(全文)");
    expect(r2).toContain("force=true");
    expect(r2).not.toContain(BODY_MARK); // 正文未被重复注入
  });

  it("③部分窗口读后再读该窗口:省略;再次重读次数递增", async () => {
    const root = mk(); mkProbe(root);
    const t = mainReadFile(root, sid("m3"));
    expect(await run(t, { path: "probe.txt", offset: 10, limit: 20 })).toContain(BODY_MARK);
    const r2 = await run(t, { path: "probe.txt", offset: 10, limit: 20 });
    expect(r2).toContain("[重复读取·已省略]");
    expect(r2).toContain("(10-29)");
    expect(r2).not.toContain(BODY_MARK);
    // 读未覆盖窗口 → 放行(④),此时登记行段合并且次数递增
    expect(await run(t, { path: "probe.txt", offset: 500, limit: 5 })).toContain(BODY_MARK);
    // 覆盖窗口再读(1-29 与 500-504 已读):10-29 仍应省略,且次数=2
    const r4 = await run(t, { path: "probe.txt", offset: 10, limit: 20 });
    expect(r4).toContain("自第 2 次读取后未变");
  });

  it("④读未覆盖窗口:放行并注入正文", async () => {
    const root = mk(); mkProbe(root);
    const t = mainReadFile(root, sid("m4"));
    await run(t, { path: "probe.txt", offset: 1, limit: 100 });
    const r = await run(t, { path: "probe.txt", offset: 300, limit: 50 });
    expect(r).toContain("line300 ");
    expect(r).not.toContain("重复读取·已省略");
  });

  it("⑤mtime 变化:放行(文件变过必须重读)", async () => {
    const root = mk();
    const p = mkProbe(root);
    const t = mainReadFile(root, sid("m5"));
    await run(t, { path: "probe.txt" });
    const future = new Date(Date.now() + 10_000);
    utimesSync(p, future, future);
    const r = await run(t, { path: "probe.txt" });
    expect(r).toContain(BODY_MARK);
    expect(r).not.toContain("重复读取·已省略");
  });

  it("⑥clearReadFiles 后:放行(压缩/会话回收清台账)", async () => {
    const root = mk(); mkProbe(root);
    const s = sid("m6");
    const t = mainReadFile(root, s);
    await run(t, { path: "probe.txt" });
    expect((await run(t, { path: "probe.txt" })).includes(BODY_MARK)).toBe(false);
    clearReadFiles(s);
    const r = await run(t, { path: "probe.txt" });
    expect(r).toContain(BODY_MARK);
  });

  it("⑦force=true:放行重新注入", async () => {
    const root = mk(); mkProbe(root);
    const t = mainReadFile(root, sid("m7"));
    await run(t, { path: "probe.txt" });
    expect((await run(t, { path: "probe.txt" })).includes(BODY_MARK)).toBe(false);
    const r = await run(t, { path: "probe.txt", force: true });
    expect(r).toContain(BODY_MARK);
    expect(r).not.toContain("重复读取·已省略");
  });
});

// ---------------- 子代理路径(llmLoopReadOnlyTools) ----------------
describe("子代理 read_file 重复读取去重(判重键=子代理自己的 session)", () => {
  it("①首次全读:含正文 + 行数尾注", async () => {
    const root = mk(); mkProbe(root);
    const t = subReadFile(root, sid("s1"));
    const r = await run(t, { path: join(root, "probe.txt") });
    expect(r).toContain(BODY_MARK);
    expect(r).toContain("(共 800 行;本次显示 1-800)");
    expect(r).not.toContain("重复读取·已省略");
  });

  it("②重复全读:短提示 + 保留行数尾注,不含正文", async () => {
    const root = mk(); mkProbe(root);
    const t = subReadFile(root, sid("s2"));
    await run(t, { path: join(root, "probe.txt") });
    const r2 = await run(t, { path: join(root, "probe.txt") });
    expect(r2).toContain("[重复读取·已省略]");
    expect(r2).toContain("(全文)");
    expect(r2).toContain("(共 800 行;本次显示 1-800)");
    expect(r2).not.toContain(BODY_MARK);
  });

  it("③部分窗口重读:省略;④未覆盖窗口放行", async () => {
    const root = mk(); mkProbe(root);
    const t = subReadFile(root, sid("s3"));
    expect(await run(t, { path: join(root, "probe.txt"), offset: 100, limit: 40 })).toContain(BODY_MARK);
    const r2 = await run(t, { path: join(root, "probe.txt"), offset: 100, limit: 40 });
    expect(r2).toContain("[重复读取·已省略]");
    expect(r2).toContain("(100-139)");
    expect(r2).not.toContain(BODY_MARK);
    const r3 = await run(t, { path: join(root, "probe.txt"), offset: 600, limit: 10 });
    expect(r3).toContain("line600 ");
    expect(r3).not.toContain("重复读取·已省略");
  });

  it("⑤mtime 变化:放行", async () => {
    const root = mk();
    const p = mkProbe(root);
    const t = subReadFile(root, sid("s5"));
    await run(t, { path: p });
    const future = new Date(Date.now() + 10_000);
    utimesSync(p, future, future);
    const r = await run(t, { path: p });
    expect(r).toContain(BODY_MARK);
    expect(r).not.toContain("重复读取·已省略");
  });

  it("⑥clearReadFiles 后:放行", async () => {
    const root = mk(); mkProbe(root);
    const s = sid("s6");
    const t = subReadFile(root, s);
    await run(t, { path: join(root, "probe.txt") });
    expect((await run(t, { path: join(root, "probe.txt") })).includes(BODY_MARK)).toBe(false);
    clearReadFiles(s);
    expect(await run(t, { path: join(root, "probe.txt") })).toContain(BODY_MARK);
  });

  it("⑦force=true:放行;父键已读不算子代理上下文(判重键=子键)", async () => {
    const root = mk(); mkProbe(root);
    const child = sid("s7-child");
    const parent = sid("s7-parent");
    const t = subReadFile(root, child, parent);
    await run(t, { path: join(root, "probe.txt") });
    expect((await run(t, { path: join(root, "probe.txt"), force: true })).includes(BODY_MARK)).toBe(true);
    // 新子代理(父键已有该文件已读事实)照样能看到正文:判重只看自己的键
    const t2 = subReadFile(root, sid("s7-other"), parent);
    const r = await run(t2, { path: join(root, "probe.txt") });
    expect(r).toContain(BODY_MARK);
  });
});

// ---------------- view_image 去重 ----------------
describe("view_image 重复注入去重(视觉 token 面)", () => {
  const mkImg = (dir: string, name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, PNG_1PX);
    return p;
  };
  const imgTool = (root: string, sessionId: string, vision?: Parameters<typeof createFileTools>[0]["vision"]): Tool =>
    createFileTools({ root, journal: new MemoryJournal(), sessionId, ...(vision ? { vision } : {}) }).find((t) => t.name === "view_image")!;

  it("首看注入 → 同图同 mtime 再看:纯文本「已看过·未重复注入」且无哨兵;force 重注", async () => {
    const root = mk(); mkImg(root, "pic.png");
    const t = imgTool(root, sid("v1"));
    const r1 = await run(t, { paths: ["pic.png"] });
    expect(r1.startsWith(VISION_TOOL_SENTINEL)).toBe(true);
    expect((JSON.parse(r1.slice(VISION_TOOL_SENTINEL.length)) as { images: string[] }).images).toHaveLength(1);
    const r2 = await run(t, { paths: ["pic.png"] });
    expect(r2).not.toContain(VISION_TOOL_SENTINEL); // 全跳过 → 纯文本,不返回哨兵
    expect(r2).toContain("[已看过·未重复注入] pic.png");
    expect(r2).toContain("force=true");
    const r3 = await run(t, { paths: ["pic.png"], force: true });
    expect(r3.startsWith(VISION_TOOL_SENTINEL)).toBe(true);
    expect((JSON.parse(r3.slice(VISION_TOOL_SENTINEL.length)) as { images: string[] }).images).toHaveLength(1);
  });

  it("部分跳过:其余照常走哨兵,跳过项写进 payload.note", async () => {
    const root = mk(); mkImg(root, "a.png"); mkImg(root, "b.png");
    const t = imgTool(root, sid("v2"));
    await run(t, { paths: ["a.png"] });
    const r = await run(t, { paths: ["a.png", "b.png"] });
    expect(r.startsWith(VISION_TOOL_SENTINEL)).toBe(true);
    const p = JSON.parse(r.slice(VISION_TOOL_SENTINEL.length)) as { images: string[]; label: string; note?: string[] };
    expect(p.images).toHaveLength(1);
    expect(p.note?.join("\n")).toContain("[已看过·未重复注入] a.png");
    expect(p.label).toContain("b.png");
  });

  it("mtime 变化后重看:重新注入", async () => {
    const root = mk();
    const p = mkImg(root, "pic.png");
    const t = imgTool(root, sid("v3"));
    await run(t, { paths: ["pic.png"] });
    const future = new Date(Date.now() + 10_000);
    utimesSync(p, future, future);
    expect((await run(t, { paths: ["pic.png"] })).startsWith(VISION_TOOL_SENTINEL)).toBe(true);
  });

  it("VLM 兜底分支同样先判重(不重复花 VLM token)", async () => {
    const root = mk(); mkImg(root, "pic.png");
    let calls = 0;
    const vision = { mainHasVision: false, vlm: { chat: async () => { calls++; return { content: "一张 1x1 透明图" }; } } };
    const t = imgTool(root, sid("v4"), vision);
    expect(await run(t, { paths: ["pic.png"] })).toContain("[VLM 图像描述");
    const r2 = await run(t, { paths: ["pic.png"] });
    expect(calls).toBe(1); // 第二次没再调 VLM
    expect(r2).toContain("[已看过·未重复注入] pic.png");
  });
});
