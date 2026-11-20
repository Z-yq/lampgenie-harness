/**
 * 移动端远程控制配对纯函数/状态机测试。
 * 覆盖:对外地址推导、IPv6/默认端口、二维码 SVG、token 校验、attach/detach、过期回收。
 */
import { describe, it, expect } from "vitest";
import { RemoteControlManager, buildConnectUrl, hostForUrl, renderQrSvg, resolvePublicHost } from "../src/remote-control.js";

describe("remote-control 对外地址", () => {
  it("GENIE_PUBLIC_HOST 带 scheme/端口;裸 host 用 gateway 端口;IPv6 加方括号", () => {
    const ifaces = [{ name: "eth0", address: "10.0.0.5", internal: false, family: "IPv4" }];
    expect(resolvePublicHost(undefined, ifaces, 7700)).toMatchObject({ host: "10.0.0.5", port: 7700, scheme: "http" });
    expect(resolvePublicHost("https://example.com:8443", ifaces, 7700)).toMatchObject({ host: "example.com", port: 8443, scheme: "https" });
    expect(resolvePublicHost("192.168.1.9:7800", ifaces, 7700)).toMatchObject({ host: "192.168.1.9", port: 7800 });
    expect(resolvePublicHost("https://[2001:db8::1]:9443", ifaces, 7700)).toMatchObject({ host: "2001:db8::1", port: 9443, scheme: "https" });
    expect(hostForUrl("2001:db8::1")).toBe("[2001:db8::1]");
  });

  it("仅 127.0.0.1 时给出可操作警告", () => {
    const base = resolvePublicHost(undefined, [{ name: "lo", address: "127.0.0.1", internal: true, family: "IPv4" }], 7700);
    expect(base.host).toBe("127.0.0.1");
    expect(base.warning).toContain("GENIE_PUBLIC_HOST");
  });

  it("默认端口省略;非默认端口显式", () => {
    expect(buildConnectUrl({ host: "example.com", port: 80, scheme: "http" }, "t")).toBe("http://example.com/m?pair=t");
    expect(buildConnectUrl({ host: "example.com", port: 443, scheme: "https" }, "t")).toBe("https://example.com/m?pair=t");
    expect(buildConnectUrl({ host: "example.com", port: 7700, scheme: "http" }, "t")).toBe("http://example.com:7700/m?pair=t");
  });
});

describe("remote-control 状态机", () => {
  it("start 幂等 → waiting;attach → connected;detach → waiting;stop → idle", () => {
    let now = 1_000_000;
    const mgr = new RemoteControlManager({
      getPort: () => 7700,
      now: () => now,
      envHost: () => "192.168.1.10",
      ifaces: () => [],
      ttlMs: 60_000,
    });
    const s1 = mgr.start();
    expect(s1.state).toBe("waiting");
    expect(s1.clients).toBe(0);
    expect(s1.connectUrl).toMatch(/^http:\/\/192\.168\.1\.10:7700\/m\?pair=/);
    expect(s1.qrSvg).toContain("<svg");
    const token = new URL(s1.connectUrl!).searchParams.get("pair")!;
    expect(mgr.verifyToken(token)).toBe(true);
    expect(mgr.verifyToken("nope")).toBe(false);

    const s2 = mgr.start(); // 幂等:同 token
    expect(new URL(s2.connectUrl!).searchParams.get("pair")).toBe(token);

    const client = {};
    mgr.attach(client);
    expect(mgr.status().state).toBe("connected");
    expect(mgr.status().clients).toBe(1);

    mgr.detach(client);
    expect(mgr.status().state).toBe("waiting");

    mgr.stop();
    expect(mgr.status().state).toBe("idle");
    expect(mgr.verifyToken(token)).toBe(false);
  });

  it("过期且无手机在线时回收;有手机在线不断线;重启生成新 token", () => {
    let now = 0;
    const mgr = new RemoteControlManager({
      getPort: () => 7700,
      now: () => now,
      envHost: () => "example.com",
      ifaces: () => [],
      ttlMs: 1000,
    });
    const s1 = mgr.start();
    const token1 = new URL(s1.connectUrl!).searchParams.get("pair")!;
    const client = {};
    mgr.attach(client);
    now = 5000; // 过期但有手机在线
    expect(mgr.status().state).toBe("connected");
    mgr.detach(client);
    const expired = mgr.status();
    expect(expired.state).toBe("idle");
    expect(expired.expired).toBe(true);
    expect(mgr.verifyToken(token1)).toBe(false);

    now = 6000;
    const s2 = mgr.start();
    const token2 = new URL(s2.connectUrl!).searchParams.get("pair")!;
    expect(token2).not.toBe(token1);
    expect(token2).toHaveLength(64);
  });

  it("二维码是 SVG 且内容可扫(包含 path)", () => {
    const svg = renderQrSvg("http://example.com/m?pair=abc");
    expect(svg).toContain("<svg");
    expect(svg).toContain("path");
  });
});