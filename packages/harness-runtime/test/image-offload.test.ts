/**
 *  图片 offload 持久位置:纯函数层(image-offload.ts)契约。
 * 覆盖:错误识别(图片预算类 true / 其它 false)、按消息与消息内顺序落盘、同 hash 复用、
 * 占位行文本、非法 data URL 保留 + skipped、已占位不重复处理、投影校验。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isImageBudgetError,
  offloadImages,
  offloadProjectionPreserved,
  IMAGE_OFFLOAD_PLACEHOLDER,
  type OffloadableMessage,
} from "../src/agent/image-offload";

const PNG = "data:image/png;base64," + Buffer.from("hello-png-bytes").toString("base64");
const PNG2 = "data:image/png;base64," + Buffer.from("second-png").toString("base64");
const JPG = "data:image/jpeg;base64," + Buffer.from("jpeg-bytes").toString("base64");
const WEBP = "data:image/webp;base64," + Buffer.from("webp-bytes").toString("base64");
const sha1 = (s: string): string => createHash("sha1").update(Buffer.from(s, "base64")).digest("hex");

const userMsg = (content: string, images?: string[]): OffloadableMessage =>
  images ? { role: "user", content, images } : { role: "user", content };

describe("isImageBudgetError(识别规则)", () => {
  it("图片预算/尺寸类错误 → true(code 与文案两种形态)", () => {
    expect(isImageBudgetError("IMAGE_OFFLOAD_REQUIRED")).toBe(true);
    expect(isImageBudgetError(new Error("400 image too large: 10144x1146"))).toBe(true);
    expect(isImageBudgetError("image exceeds limit")).toBe(true);
    expect(isImageBudgetError("image dimensions exceed allowed values")).toBe(true);
    expect(isImageBudgetError("vision limit exceeded for this model")).toBe(true);
    expect(isImageBudgetError("该模型不支持图片输入")).toBe(true);
    expect(isImageBudgetError("图片尺寸过大,请压缩后重试")).toBe(true);
    expect(isImageBudgetError({ status: 400, body: '{"error":{"message":"image pixels over budget"}}' })).toBe(true);
    expect(isImageBudgetError({ code: "IMAGE_OFFLOAD_REQUIRED" })).toBe(true);
    // 挂在 cause / err 子对象上也要认
    expect(isImageBudgetError({ err: { detail: "image too large" } })).toBe(true);
    const e = new Error("wrapper");
    (e as Error & { cause?: unknown }).cause = new Error("IMAGE_OFFLOAD_REQUIRED");
    expect(isImageBudgetError(e)).toBe(true);
  });

  it("非图片错误一律 false(不许把别的 400/context 超限当图片问题)", () => {
    expect(isImageBudgetError("400 invalid_request_error: bad tool_calls")).toBe(false);
    expect(isImageBudgetError(new Error("context length exceeded"))).toBe(false);
    expect(isImageBudgetError("401 unauthorized")).toBe(false);
    expect(isImageBudgetError("messages[3].image[0]: unsupported image")).toBe(false);
    expect(isImageBudgetError(undefined)).toBe(false);
    expect(isImageBudgetError(null)).toBe(false);
    expect(isImageBudgetError({ status: 429 })).toBe(false);
    expect(isImageBudgetError(42)).toBe(false);
  });
});

describe("offloadImages(纯变换 + durable 落盘)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "img-offload-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("按消息顺序/消息内顺序落盘,正文追加占位行,images 清空", async () => {
    const messages: OffloadableMessage[] = [
      { role: "system", content: "sys" },
      userMsg("看这两张", [PNG, JPG]),
      { role: "assistant", content: "好" },
      userMsg("[视觉注入] 图片已注入", [WEBP]),
    ];
    const res = await offloadImages(messages, { root, sessionId: "s1" });
    expect(res.offloaded).toHaveLength(3);
    expect(res.skipped).toHaveLength(0);
    expect(res.offloaded.map((o) => [o.messageIndex, o.imageIndex])).toEqual([
      [1, 0], [1, 1], [3, 0],
    ]);
    // 文件名 = sha1.ext(jpeg → jpg),落在 <root>/.genie/image-offload/<sessionId>/
    const dir = join(root, ".genie", "image-offload", "s1");
    expect(res.offloaded[0]!.path).toBe(join(dir, `${sha1(Buffer.from("hello-png-bytes").toString("base64"))}.png`));
    expect(res.offloaded[1]!.path.endsWith(".jpg")).toBe(true);
    expect(res.offloaded[2]!.path.endsWith(".webp")).toBe(true);
    for (const o of res.offloaded) expect((await stat(o.path)).size).toBe(o.bytes);
    // 占位行:绝对路径 + sha1 前 12 位 + 字节数
    const m1 = res.messages[1]!;
    expect(m1.images).toBeUndefined();
    expect(m1.content.startsWith("看这两张")).toBe(true);
    const o0 = res.offloaded[0]!;
    expect(m1.content).toContain(`${IMAGE_OFFLOAD_PLACEHOLDER} ${o0.path} (sha1 ${o0.sha1.slice(0, 12)}, ${o0.bytes}B)]`);
    expect(m1.content.split("\n")).toHaveLength(3); // 原正文 + 两行占位
    // 其它消息不被改动
    expect(res.messages[0]).toBe(messages[0]);
    expect(res.messages[2]).toBe(messages[2]);
    expect(res.messages[3]!.content).toContain(IMAGE_OFFLOAD_PLACEHOLDER);
  });

  it("不改输入数组(深拷贝相关消息)", async () => {
    const messages = [userMsg("看图", [PNG])];
    const res = await offloadImages(messages, { root, sessionId: "s1" });
    expect(messages[0]!.images).toEqual([PNG]);
    expect(messages[0]!.content).toBe("看图");
    expect(res.messages).not.toBe(messages);
    expect(res.messages[0]!.images).toBeUndefined();
  });

  it("无图片 → offloaded=[] 且 messages 是原引用", async () => {
    const messages = [userMsg("纯文本"), { role: "assistant" as const, content: "ok" }];
    const res = await offloadImages(messages, { root, sessionId: "s1" });
    expect(res.offloaded).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.messages).toBe(messages);
    await expect(readdir(join(root, ".genie"))).rejects.toThrow();
  });

  it("同 hash 重复 → 复用已落盘文件(不重复写)", async () => {
    const first = await offloadImages([userMsg("a", [PNG])], { root, sessionId: "s1" });
    const file = first.offloaded[0]!.path;
    const mtime1 = (await stat(file)).mtimeMs;
    const second = await offloadImages([userMsg("b", [PNG])], { root, sessionId: "s1" });
    expect(second.offloaded[0]!.path).toBe(file);
    expect((await stat(file)).mtimeMs).toBe(mtime1); // 未重写
    expect(await readdir(join(root, ".genie", "image-offload", "s1"))).toEqual([`${sha1(Buffer.from("hello-png-bytes").toString("base64"))}.png`]);
  });

  it("已 offload 占位(hash 命中)→ offloaded=0、skipped 记 already-offloaded", async () => {
    const first = await offloadImages([userMsg("看图", [PNG])], { root, sessionId: "s1" });
    const withImages: OffloadableMessage[] = [
      { role: "user", content: first.messages[0]!.content, images: [PNG] },
    ];
    const res = await offloadImages(withImages, { root, sessionId: "s1" });
    expect(res.offloaded).toEqual([]);
    expect(res.skipped).toEqual([{ messageIndex: 0, imageIndex: 0, reason: "already-offloaded" }]);
    expect(res.messages).toBe(withImages); // 什么都没做 → 原引用
    expect(res.messages[0]!.content).toBe(withImages[0]!.content);
  });

  it("非法/非白名单 data URL → 保留原样并记 skipped(不静默删)", async () => {
    const bad = [
      "data:image/gif;base64,QUJD",        // 非白名单格式
      "data:image/png,QUJD",               // 缺 base64 声明
      "https://example.com/a.png",         // 不是 data URL
      "data:image/png;base64,",            // 空正文
    ];
    const messages = [userMsg("混着来", [PNG, ...bad])];
    const res = await offloadImages(messages, { root, sessionId: "s1" });
    expect(res.offloaded).toHaveLength(1);
    expect(res.skipped.map((s) => s.reason)).toEqual(["invalid-data-url", "invalid-data-url", "invalid-data-url", "invalid-data-url"]);
    expect(res.messages[0]!.images).toEqual(bad); // 坏的都留着
    expect(res.messages[0]!.content).toContain(IMAGE_OFFLOAD_PLACEHOLDER);
  });

  it("全部是非白名单 → 一条都不改,images 原样(原引用)", async () => {
    const messages = [userMsg("坏图", ["data:image/gif;base64,QUJD"])];
    const res = await offloadImages(messages, { root, sessionId: "s1" });
    expect(res.offloaded).toEqual([]);
    expect(res.messages).toBe(messages);
    expect(res.messages[0]!.images).toEqual(["data:image/gif;base64,QUJD"]);
  });

  it("写盘失败(根目录被普通文件占用)→ 抛错(调用方据此不重试)", async () => {
    const blocked = join(root, ".genie");
    await writeFile(blocked, "not a dir");
    await mkdir(join(root, "keep")); // 无关目标,只为确保 root 存在
    await expect(offloadImages([userMsg("看图", [PNG])], { root, sessionId: "s1" })).rejects.toThrow();
  });

  it("sessionId 带路径穿越字符 → 落盘目录被消毒(不越界)", async () => {
    const res = await offloadImages([userMsg("看图", [PNG])], { root, sessionId: "../../evil" });
    expect(res.offloaded).toHaveLength(1);
    expect(res.offloaded[0]!.path.startsWith(join(root, ".genie", "image-offload"))).toBe(true);
    expect(res.offloaded[0]!.path.includes("..")).toBe(false);
  });

  it("非 user 消息上的 images 不处理(tool/assistant 无图,防御性跳过)", async () => {
    const messages: OffloadableMessage[] = [
      { role: "assistant", content: "x", images: [PNG2] },
    ];
    const res = await offloadImages(messages, { root, sessionId: "s1" });
    expect(res.offloaded).toEqual([]);
    expect(res.messages).toBe(messages);
  });
});

describe("offloadProjectionPreserved(投影校验)", () => {
  it("条数与角色序列逐位相同 → true(正文/图片变化不影响)", () => {
    const before: OffloadableMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u", images: [PNG] },
    ];
    expect(offloadProjectionPreserved(before, [
      { role: "system", content: "s" },
      { role: "user", content: "u\n[image offloaded: /x (sha1 abc, 3B)]" },
    ])).toBe(true);
  });

  it("条数或角色序列变化 → false", () => {
    const a: OffloadableMessage[] = [{ role: "user", content: "u" }];
    expect(offloadProjectionPreserved(a, [])).toBe(false);
    expect(offloadProjectionPreserved(a, [{ role: "user", content: "u" }, { role: "user", content: "extra" }])).toBe(false);
    expect(offloadProjectionPreserved(a, [{ role: "assistant", content: "u" }])).toBe(false);
  });
});
