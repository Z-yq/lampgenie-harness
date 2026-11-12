import { SERVER_SRC } from "./panel-source.js";
/**
 *  能力暴露 allowlist 测试。
 * 三类证据:
 * 1. 对拍:panel 集合必须与 server.ts handleMessage 的 case 集合逐条一致(漏登记=面板静默 403,
 *    多登记=表外放行;两侧漂移都在这里失败)。
 * 2. 判定矩阵:readonly/agent 的允许与拒绝、未知 channel 默认拒、高权限 per-method。
 * 3. 真端口 e2e:createGatewayApp + 真 WebSocket,readonly 连接拒写放读、journal 有 client.denied。
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { parseClientMessage } from "@lampgenie/protocol";
import {
  CFG_SET_TOP_LEVEL_KEYS,
  CHANNEL_ALLOWLIST,
  PANEL_CHANNELS,
  READONLY_CHANNELS,
  AGENT_CHANNELS,
  UNIVERSAL_CHANNELS,
  isChannelAllowed,
  isClientMode,
  isMethodAllowed,
} from "../src/client-capabilities.js";

const SERVER_SRC = SERVER_SRC;
const SCHEMA_SRC = readFileSync(new URL("../../../packages/core/src/config/schema.ts", import.meta.url), "utf8");

/** server.ts 里 handleMessage 的顶层 case(4 空格缩进;嵌套 switch 的 case 更深,不会误收)。 */
function serverCaseList(): string[] {
  const out: string[] = [];
  for (const line of SERVER_SRC.split("\n")) {
    const m = /^    case "([a-zA-Z0-9._]+)":/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** ConfigSchema 顶层键(真源=packages/core/src/config/schema.ts)。 */
function configSchemaTopKeys(): string[] {
  const start = SCHEMA_SRC.indexOf("export const ConfigSchema = z.object({");
  expect(start, "ConfigSchema 定义存在").toBeGreaterThanOrEqual(0);
  const body = SCHEMA_SRC.slice(start, SCHEMA_SRC.indexOf("\n});", start));
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^  ([a-zA-Z][a-zA-Z0-9]*):/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

describe(" 能力暴露 allowlist", () => {
  it("对拍:panel 集合 == server.ts handleMessage case 集合(双向)", () => {
    const cases = serverCaseList();
    expect(cases.length).toBeGreaterThan(150); // 解析失效时立刻失败,而不是空集相等
    const panelAll = new Set<string>([...PANEL_CHANNELS, ...UNIVERSAL_CHANNELS]);
    const missing = cases.filter((c) => !panelAll.has(c));
    const extra = [...panelAll].filter((c) => !cases.includes(c));
    expect(missing, "allowlist 漏登记的既有 channel").toEqual([]);
    expect(extra, "allowlist 多登记的 channel(switch 无 case)").toEqual([]);
    expect(PANEL_CHANNELS.length).toBe(new Set(PANEL_CHANNELS).size);
    // 三档都必须是 panel 的子集(能力只收窄不放大)
    for (const ch of READONLY_CHANNELS) expect(panelAll.has(ch), "readonly 越出 panel:" + ch).toBe(true);
    for (const ch of AGENT_CHANNELS) expect(panelAll.has(ch), "agent 越出 panel:" + ch).toBe(true);
  });

  it("readonly 矩阵:放只读、拒写/终端/安装", () => {
    expect(isChannelAllowed("readonly", "task.list")).toBe(true);
    expect(isChannelAllowed("readonly", "task.detail.get")).toBe(true);
    expect(isChannelAllowed("readonly", "git.status")).toBe(true);
    expect(isChannelAllowed("readonly", "board.get")).toBe(true);
    for (const ch of ["cfg.set", "task.submit", "git.commit", "plugins.install", "term.session.open", "file.write", "board.save", "browser.view.command"]) {
      expect(isChannelAllowed("readonly", ch), ch).toBe(false);
    }
    // 引导/保活通道三档通用
    expect(isChannelAllowed("readonly", "client.mode")).toBe(true);
    expect(isChannelAllowed("readonly", "ping")).toBe(true);
  });

  it("agent 矩阵:task/session/permission 放行,高权限写面拒绝", () => {
    expect(isChannelAllowed("agent", "task.submit")).toBe(true);
    expect(isChannelAllowed("agent", "task.list")).toBe(true);
    expect(isChannelAllowed("agent", "session.status")).toBe(true);
    expect(isChannelAllowed("agent", "permission.respond")).toBe(true);
    expect(isChannelAllowed("agent", "git.push")).toBe(false);
    for (const ch of ["cfg.set", "git.commit", "term.exec", "plugins.install", "board.save", "file.write"]) {
      expect(isChannelAllowed("agent", ch), ch).toBe(false);
    }
  });

  it("task.schedule / task.schedule.cancel:panel 登记,readonly/agent 不入最小集", () => {
    for (const ch of ["task.schedule", "task.schedule.cancel"]) {
      expect(PANEL_CHANNELS, "panel 漏登记 " + ch).toContain(ch);
      expect(READONLY_CHANNELS, "readonly 不应登记 " + ch).not.toContain(ch);
      expect(AGENT_CHANNELS, "agent 不应登记 " + ch).not.toContain(ch);
      expect(isChannelAllowed("panel", ch), ch).toBe(true);
      expect(isChannelAllowed("readonly", ch), ch).toBe(false);
      expect(isChannelAllowed("agent", ch), ch).toBe(false);
      expect(isMethodAllowed("panel", ch, {}), "per-method 不拦 " + ch).toBe(true);
    }
  });

  it("未知 channel / 未知 mode 默认拒绝(不是 denylist)", () => {
    expect(isChannelAllowed("panel", "task.list")).toBe(true);
    expect(isChannelAllowed("panel", "no.such.channel")).toBe(false);
    expect(isChannelAllowed("readonly", "no.such.channel")).toBe(false);
    expect(isChannelAllowed("root", "task.list")).toBe(false);
    expect(isChannelAllowed(undefined, "task.list")).toBe(false);
    expect(isChannelAllowed("panel", "")).toBe(false);
    expect(isChannelAllowed("panel", "__proto__")).toBe(false);
    expect(isClientMode("panel")).toBe(true);
    expect(isClientMode("root")).toBe(false);
  });

  it("per-method:cfg.set 顶层键白名单 + git 写按档位", () => {
    expect(isMethodAllowed("panel", "cfg.set", { patch: { permissions: { mode: "default" } } })).toBe(true);
    expect(isMethodAllowed("panel", "cfg.set", { patch: { coding: { llm: { model: "x" } } } })).toBe(true);
    expect(isMethodAllowed("panel", "cfg.set", { patch: { secrets: {} } })).toBe(false);
    expect(isMethodAllowed("panel", "cfg.set", { patch: JSON.parse('{"__proto__":{}}') })).toBe(false);
    expect(isMethodAllowed("panel", "cfg.set", {})).toBe(false);
    expect(isMethodAllowed("panel", "cfg.set", { patch: [] as unknown })).toBe(false);
    expect(isMethodAllowed("panel", "git.commit", {})).toBe(true);
    expect(isMethodAllowed("panel", "git.push", {})).toBe(true);
    expect(isMethodAllowed("readonly", "git.push", {})).toBe(false);
    expect(isMethodAllowed("agent", "git.commit", {})).toBe(false);
    // 普通 channel 不受 per-method 影响
    expect(isMethodAllowed("readonly", "task.list", {})).toBe(true);
    expect(isMethodAllowed("readonly", "cfg.set", { patch: { permissions: {} } })).toBe(false);
  });

  it("cfg 顶层键:与 ConfigSchema 真源一致", () => {
    expect([...CFG_SET_TOP_LEVEL_KEYS].sort()).toEqual(configSchemaTopKeys().sort());
    expect(CFG_SET_TOP_LEVEL_KEYS).toContain("permissions");
    expect(CFG_SET_TOP_LEVEL_KEYS).toContain("browser");
    // 三档 allowlist 表结构完整
    expect(Object.keys(CHANNEL_ALLOWLIST).sort()).toEqual(["agent", "panel", "readonly"]);
  });

  it("协议:client.mode 入站消息可解析,空 mode 拒", () => {
    const ok = parseClientMessage(JSON.stringify({ v: 1, type: "client.mode", mode: "readonly" }));
    expect(ok && (ok as { mode?: string }).mode).toBe("readonly");
    const empty = parseClientMessage(JSON.stringify({ v: 1, type: "client.mode", mode: "" }));
    expect(empty).toBeNull();
  });
});

// ---- 真端口 e2e:readonly 拒写放读 + journal client.denied + panel 不受影响 ----
const ROOT = mkdtempSync(join(tmpdir(), "m72-clientmode-"));
const OLD_ROOT = process.env.GENIE_REPO_ROOT;
process.env.GENIE_REPO_ROOT = ROOT;
let app: GatewayApp | undefined;
const sockets: WebSocket[] = [];

afterAll(async () => {
  for (const ws of sockets) { try { ws.close(); } catch { /* 已关 */ } }
  if (app) { try { await app.close(); } catch { /* 已关 */ } }
  if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
  else process.env.GENIE_REPO_ROOT = OLD_ROOT;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
});

async function connect(port: number): Promise<{ ws: WebSocket; inbox: Record<string, unknown>[]; wait: (pred: (m: Record<string, unknown>) => boolean, label: string, timeout?: number) => Promise<Record<string, unknown>> }> {
  const ws = new WebSocket("ws://127.0.0.1:" + port);
  sockets.push(ws);
  const inbox: Record<string, unknown>[] = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((res, rej) => { ws.on("open", () => res()); ws.on("error", rej); });
  const wait = async (pred: (m: Record<string, unknown>) => boolean, label: string, timeout = 15000): Promise<Record<string, unknown>> => {
    const start = Date.now();
    for (;;) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeout) throw new Error("等待超时: " + label + " inbox=" + JSON.stringify(inbox.map((m) => m.type)));
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  return { ws, inbox, wait };
}

describe("server e2e:clientMode 闸 + journal", () => {
  it("readonly 后 cfg.set 被拒(journal client.denied)、task.list 正常;panel 连接不受影响", async () => {
    const port = 18000 + Math.floor(Math.random() * 1500);
    app = createGatewayApp({ port, journalDir: join(ROOT, ".genie", "journals") });
    const ro = await connect(port);
    await ro.wait((m) => m.type === "hello", "hello");

    ro.ws.send(JSON.stringify({ v: 1, type: "client.mode", mode: "readonly" }));
    const modeAck = await ro.wait((m) => m.type === "client.mode.result", "client.mode.result");
    expect(modeAck.ok).toBe(true);
    expect(modeAck.mode).toBe("readonly");

    // 写类被拒:未进 switch(不会到 cfg.set 的 readOnly 分支),code=permission-denied
    ro.ws.send(JSON.stringify({ v: 1, type: "cfg.set", sessionId: "m72-e2e", patch: { permissions: { mode: "default" } } }));
    const denied = await ro.wait((m) => m.type === "error", "error(permission-denied)");
    expect(denied.code).toBe("permission-denied");
    expect(String(denied.message)).toContain("clientMode=readonly");
    expect(String(denied.message)).toContain("cfg.set");

    // 只读放行
    ro.ws.send(JSON.stringify({ v: 1, type: "task.list" }));
    await ro.wait((m) => m.type === "task.list" && Array.isArray(m.tasks), "task.list");

    // 非法 mode:ok:false 且连接保持 readonly
    ro.ws.send(JSON.stringify({ v: 1, type: "client.mode", mode: "root" }));
    const badAck = await ro.wait((m) => m.type === "client.mode.result" && m.ok === false, "client.mode.result(false)");
    expect(badAck.mode).toBe("readonly");
    ro.ws.send(JSON.stringify({ v: 1, type: "git.push" }));
    const denied2 = await ro.wait((m) => m.type === "error" && String(m.message).includes("git.push"), "error(git.push)");
    expect(denied2.code).toBe("permission-denied");

    // journal 审计:client.denied 带 mode/channel
    const deniedEvents = app.journal.readAll().filter((e) => {
      const p = e.payload as { type?: string; mode?: string; channel?: string } | undefined;
      return e.kind === "custom" && p?.type === "client.denied";
    }).map((e) => e.payload as { mode: string; channel: string; at: number });
    expect(deniedEvents.length).toBeGreaterThanOrEqual(2);
    expect(deniedEvents.map((d) => d.channel)).toContain("cfg.set");
    expect(deniedEvents.every((d) => d.mode === "readonly")).toBe(true);
    expect(deniedEvents.every((d) => typeof d.at === "number")).toBe(true);

    // 另一条连接(未声明 mode=panel)不受影响
    const panel = await connect(port);
    await panel.wait((m) => m.type === "hello", "hello(panel)");
    panel.ws.send(JSON.stringify({ v: 1, type: "git.push" }));
    const panelErr = await panel.wait((m) => m.type === "error", "error(panel git.push)");
    // panel 放行后进 switch:git.push 在无 git 仓/无服务时回业务错,但绝不能是 permission-denied
    expect(panelErr.code).not.toBe("permission-denied");
  }, 40000);
});
