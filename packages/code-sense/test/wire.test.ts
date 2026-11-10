/**
 * wire:用本仓真实文件做只读断言(行扫描不需要索引)。
 *
 * 断言口径按「结构事实」而非固定行号——server.ts/panel.ts 由其它会话并行修改时,
 * 行号会漂移,但 track.view 三处齐、workers.list 已声明+有 handler、真实缺口存在
 * 这些事实不应漂移。
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { scanWire, renderWire, WIRE_PATHS } from "../src/wire/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const r = scanWire(ROOT);

function row(type: string) {
  const t = r.types.find((x) => x.type === type);
  expect(t, `type ${type} 应出现在 wire 扫描结果`).toBeTruthy();
  return t!;
}

describe("wire 协议表面(本仓真实文件)", () => {
  it("解析出 ClientMessage/ServerMessage 两个 union,无未解析成员", () => {
    expect(r.unions.map((u) => u.name)).toEqual(expect.arrayContaining(["ClientMessage", "ServerMessage"]));
    expect(r.unions.find((u) => u.name === "ClientMessage")?.members.length).toBeGreaterThan(100);
    expect(r.unions.find((u) => u.name === "ServerMessage")?.members.length).toBeGreaterThan(50);
    expect(r.unresolved).toEqual([]);
  });

  it("track.view:声明+handler+发送点三处齐", () => {
    const t = row("track.view");
    expect(t.unions.map((u) => u.name)).toContain("ClientMessage");
    expect(t.handlers.length).toBeGreaterThan(0);
    expect(t.handlers[0]!.file).toBe(WIRE_PATHS.server);
    expect(t.sends.some((s) => s.file === WIRE_PATHS.panel)).toBe(true);
    expect(t.status).toBe("ok");
  });

  it("workers.list:能识别为新增消息(声明 + 服务端 handler)", () => {
    const t = row("workers.list");
    expect(t.unions.map((u) => u.name)).toContain("ClientMessage");
    expect(t.handlers.length).toBeGreaterThan(0);
    expect(t.handlers[0]!.file).toBe(WIRE_PATHS.server);
    // 当前面板尚未发送:应落进 D 类提示(若后续补了发送点,这条断言自动失效)
    if (t.sends.length === 0) {
      expect(r.orphans.declaredNeverSent.map((x) => x.type)).toContain("workers.list");
    }
  });

  it("fallthrough 分组:git.status/git.diff 共享物理 handler 行", () => {
    const status = row("git.status").handlers[0]!;
    const diff = row("git.diff").handlers[0]!;
    expect(status.handlerLine).toBe(diff.handlerLine);
    expect(status.group).toEqual(expect.arrayContaining(["git.status", "git.diff", "git.pull"]));
  });

  it("能报出真实孤儿(实测存在,不臆造)", () => {
    const neverSent = new Set(r.orphans.declaredNeverSent.map((x) => x.type));
    const recvUndeclared = new Set(r.orphans.receiveUndeclared.map((x) => x.type));
    // file.write/workers.list:声明+handler 都在,但 panel/assets 从不发送;
    // track.view.result 等:服务端已发、面板已收,但 ServerMessage union 未声明。
    expect(neverSent.has("file.write") || neverSent.has("workers.list")).toBe(true);
    expect(recvUndeclared.has("track.view.result") || recvUndeclared.has("usage.view.result")).toBe(true);
  });

  it("人类可读面:按 union 分组 + 孤儿 + 已知边界", () => {
    const text = renderWire(r);
    expect(text).toContain("[ClientMessage]");
    expect(text).toContain("[ServerMessage]");
    expect(text).toContain("孤儿");
    expect(text).toContain("已知边界");
    expect(text).toContain("track.view");
    expect(text).toContain("workers.list");
  });

  it("--changed:git 工作区信息可结构化返回(无 git 时诚实降级)", () => {
    const c = scanWire(ROOT, { changed: true }).changed;
    expect(c?.enabled).toBe(true);
    expect(Array.isArray(c?.files)).toBe(true);
    expect(Array.isArray(c?.types)).toBe(true);
  });
});
