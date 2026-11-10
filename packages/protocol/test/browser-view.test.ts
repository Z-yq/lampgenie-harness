import { describe, expect, it } from "vitest";
import {
  BrowserViewFrame,
  BrowserViewCommand,
  BrowserViewEvent,
  BrowserViewSubscribed,
  BrowserViewCommandResult,
  ClientMessage,
  ServerMessage,
  PROTOCOL_VERSION,
} from "../src/index.js";

/**
 * 内置浏览器视图协议(2026-10-21 移植 ZCode browser-use)。
 * 断言两件事:①5 条消息的 zod 校验正/负例;②挂载进 Client/Server union 后
 * discriminatedUnion 能正确分派(不与被其它消息类型吞掉)。
 */
describe("browser.view 协议", () => {
  const V = PROTOCOL_VERSION;

  it("client: browser.view.open 可选 tabId", () => {
    expect(BrowserViewOpen_parse({ v: V, type: "browser.view.open" }).ok).toBe(true);
    expect(BrowserViewOpen_parse({ v: V, type: "browser.view.open", tabId: "t1" }).ok).toBe(true);
    expect(BrowserViewOpen_parse({ v: V, type: "browser.view.open", tabId: 3 }).ok).toBe(false);
  });

  it("client: browser.view.command 需要非空 action", () => {
    expect(ClientMessage.safeParse({ v: V, type: "browser.view.command", action: "navigate", args: { op: "back" } }).success).toBe(true);
    expect(ClientMessage.safeParse({ v: V, type: "browser.view.command", action: "" }).success).toBe(false);
    expect(ClientMessage.safeParse({ v: V, type: "browser.view.command" }).success).toBe(false);
  });

  it("client: browser.view.close 与 open 走不同 union 分支", () => {
    const r = ClientMessage.safeParse({ v: V, type: "browser.view.close", tabId: "t2" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe("browser.view.close");
  });

  it("server: frame 正例(含 hitRegions)与负例(seq 非整数/dim 负数)", () => {
    const frame = {
      v: V, type: "browser.view.frame", tabId: "t1", seq: 3,
      imageB64: "AAAA", width: 1280, height: 720,
      viewport: { width: 1280, height: 720 }, url: "https://example.com", title: "Example", ts: 1,
      hitRegions: [{ ref: "e1", x: 0, y: 0, w: 10, h: 10 }],
    };
    expect(BrowserViewFrame.safeParse(frame).success).toBe(true);
    expect(BrowserViewFrame.safeParse({ ...frame, seq: 1.5 }).success).toBe(false);
    expect(BrowserViewFrame.safeParse({ ...frame, width: -1 }).success).toBe(false);
    expect(BrowserViewFrame.safeParse({ ...frame, hitRegions: [{ ref: "e1", x: 0, y: 0, w: 10 }] }).success).toBe(false);
    // 缺 url/title 必填 → 拒
    const { url: _u, ...noUrl } = frame;
    expect(BrowserViewFrame.safeParse(noUrl).success).toBe(false);
  });

  it("server: event kind 限定四态", () => {
    expect(BrowserViewEvent.safeParse({ v: V, type: "browser.view.event", tabId: "t1", kind: "nav", url: "u" }).success).toBe(true);
    expect(BrowserViewEvent.safeParse({ v: V, type: "browser.view.event", tabId: "t1", kind: "crash", message: "boom" }).success).toBe(true);
    expect(BrowserViewEvent.safeParse({ v: V, type: "browser.view.event", tabId: "t1", kind: "spawn" }).success).toBe(false);
  });

  it("server: subscribed 允许 tabId=null(无 tab)与 tabs 缺省", () => {
    expect(BrowserViewSubscribed.safeParse({ v: V, type: "browser.view.subscribed", tabId: null, ok: false, message: "无打开的 tab" }).success).toBe(true);
    expect(BrowserViewSubscribed.safeParse({ v: V, type: "browser.view.subscribed", tabId: "t1", ok: true, tabs: [{ id: "t1", url: "u", title: "T", active: true }] }).success).toBe(true);
    expect(BrowserViewSubscribed.safeParse({ v: V, type: "browser.view.subscribed", tabId: "t1", ok: true, tabs: [{ id: "t1" }] }).success).toBe(false);
  });

  it("server: command.result 承载错误文本(ok=false 也合法)", () => {
    expect(BrowserViewCommandResult.safeParse({ v: V, type: "browser.view.command.result", tabId: null, action: "eval", ok: false, text: "[browser] 白名单外" }).success).toBe(true);
    expect(BrowserViewCommandResult.safeParse({ v: V, type: "browser.view.command.result", tabId: "t1", action: "x", ok: true }).success).toBe(false);
  });

  it("挂进 ServerMessage union 后 type 不被其它分支篡改", () => {
    const r = ServerMessage.safeParse({ v: V, type: "browser.view.frame", tabId: "t1", seq: 0, imageB64: "", width: 0, height: 0, viewport: { width: 800, height: 600 }, url: "", title: "", ts: 0 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe("browser.view.frame");
  });
});

function BrowserViewOpen_parse(x: unknown) {
  const r = ClientMessage.safeParse(x);
  return { ok: r.success };
}
