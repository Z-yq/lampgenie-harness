/**
 * 回归锁:「捕获 config.browser 子对象」vs「每次调用现读」。
 *
 * cfg.set 走 main.ts 的 `Object.assign(config, next)`,会**整体替换** config.browser 为新对象;
 * 旧实现把子对象捕获进闭包,于是面板「一键启用浏览器」写完配置后 cfg.enabled() 仍返回 false。
 * 本文件的第 2 条用例就是那条回归锁:同一个 cfg 对象必须读到替换后的新子对象。
 */
import { describe, expect, it } from "vitest";
import { browserCfgFrom } from "../src/app.js";

describe("browserCfgFrom:配置热生效(每次调用现读 config.browser)", () => {
  it("初始 enabled:false → cfg.enabled() === false", () => {
    const cfg = browserCfgFrom({ browser: { enabled: false } });
    expect(cfg.enabled()).toBe(false);
  });

  it("cfg.set 式热更新(整体替换子对象)后,同一个 cfg 读到 enabled:true", () => {
    const container: Record<string, unknown> = { browser: { enabled: false } };
    const cfg = browserCfgFrom(container);
    expect(cfg.enabled()).toBe(false);

    // main.ts 的做法:Object.assign(config, next) —— browser 子对象被整体换掉
    Object.assign(container, { browser: { enabled: true } });
    expect(cfg.enabled()).toBe(true); // 旧实现(捕获子对象)此处仍是 false
  });

  it("缺 browser 段 = 缺省可用,其余键有缺省值", () => {
    const cfg = browserCfgFrom({});
    expect(cfg.enabled()).toBe(true);
    expect(cfg.allowDomains()).toEqual([]);
    expect(cfg.idleMinutes?.()).toBe(30);
    expect(cfg.profile?.()).toBe("persistent");
    expect(cfg.profileDir?.()).toBe(".genie/browser-profile");
    expect(typeof cfg.headless?.()).toBe("boolean");

    // config 整体缺失(测试缺省装配)同样按缺省可用
    expect(browserCfgFrom(undefined).enabled()).toBe(true);
  });

  it("idleMinutes/profile/headless/allowDomains 随 Object.assign 一起热更新", () => {
    const container: Record<string, unknown> = {
      browser: { idleMinutes: 5, profile: "ephemeral", headless: false, allowDomains: ["a.example"] },
    };
    const cfg = browserCfgFrom(container);
    expect(cfg.idleMinutes?.()).toBe(5);
    expect(cfg.profile?.()).toBe("ephemeral");
    expect(cfg.headless?.()).toBe(false);
    expect(cfg.allowDomains()).toEqual(["a.example"]);

    Object.assign(container, { browser: { idleMinutes: 90, profile: "persistent", headless: true, allowDomains: ["b.example"] } });
    expect(cfg.idleMinutes?.()).toBe(90);
    expect(cfg.profile?.()).toBe("persistent");
    expect(cfg.headless?.()).toBe(true);
    expect(cfg.allowDomains()).toEqual(["b.example"]);
  });
});
