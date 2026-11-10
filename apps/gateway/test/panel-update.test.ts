import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/**
 * 版本检查/应用内更新面板侧(2026-11-09):桌面壳 update-check 状态机驱动。
 * 这里锁「面板只渲染状态、动作全部走白名单 IPC」的契约,避免出现第二套更新判断。
 */
describe("面板版本更新横幅", () => {
  const fetchHtml = async (port: number) => {
    const panel = servePanel(port, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      return await res.text();
    } finally {
      await panel.close();
    }
  };

  it("侧栏横幅结构:标题/说明/下载/说明/稍后 + 画布浮层同源", async () => {
    const html = await fetchHtml(7961);
    expect(html).toContain('id="updateBar"');
    for (const id of ["upTitle", "upSub", "upAction", "upMore", "upLater"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("sb-update");
    // 浏览器态(无 genieWindow.updates)不出现:默认 display:none
    expect(html).toContain('class="sb-update" id="updateBar" style="display:none"');
    // 新用户默认画布形态:侧栏被收起,必须有画布可见的浮层载体
    expect(html).toContain('id="updateFloat"');
    for (const id of ["upfTitle", "upfSub", "upfAction", "upfMore", "upfLater"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("body.cv-shell #updateFloat.on");
  });

  it("状态机渲染:available/downloading/downloaded 与强制更新不可忽略", async () => {
    const html = await fetchHtml(7962);
    expect(html).toContain("function bindUpdateBridge()");
    const i = html.indexOf("function bindUpdateBridge()");
    const block = html.slice(i, i + 6200);
    expect(block).toContain('status === "available"');
    expect(block).toContain('status === "downloading"');
    expect(block).toContain('status === "downloaded"');
    expect(block).toContain("state.mandatory ? \"必须更新 \"");
    expect(block).toContain("later.style.display = state.mandatory ? \"none\" : \"\"");
    expect(block).toContain("state.progress.percent");
    expect(block).toContain("安装并重启");
    expect(block).toContain("sha256");
    // 发布者签名状态:已验证 / 未签名降级提示
    expect(block).toContain("signatureStatus");
    expect(block).toContain("发布者签名已验证");
    expect(block).toContain("更新源未签名");
    // 未签名安装需用户确认(force)
    expect(html).toContain("needsConfirm");
    expect(html).toContain("force: true");
    expect(html).toContain("window.confirm");
  });

  it("手动检查有终态提示,自动检查不打扰", async () => {
    const html = await fetchHtml(7963);
    expect(html).toContain('status === "checking" && state.manual');
    expect(html).toContain('status === "up-to-date" && state.manual');
    expect(html).toContain('status === "error" && state.manual');
    expect(html).toContain('status === "disabled" && state.manual');
    expect(html).toContain("正在检查更新");
    expect(html).toContain("已是最新版本");
  });

  it("动作全部走 preload 白名单:check/download/install/dismiss/openPage", async () => {
    const html = await fetchHtml(7964);
    for (const m of ["onState", "getState", "configure", "download", "install", "dismiss", "openPage"]) {
      expect(html).toContain(`bridge.updates.${m}`);
    }
    // 点更新通知 → 横幅提到眼前
    expect(html).toContain('p.status !== "update"');
  });

  it("设置页应用更新:更新源可配置,保存走 configure,回显不打断输入", async () => {
    const html = await fetchHtml(7965);
    expect(html).toContain('id="upCfg"');
    expect(html).toContain('id="upFeedUrl"');
    expect(html).toContain('id="upSave"');
    expect(html).toContain('id="upCfgState"');
    expect(html).toContain("bridge.updates.configure(");
    expect(html).toContain("已保存更新源");
    // 状态推送时若用户正在输入,不覆盖输入框
    expect(html).toContain('document.activeElement !== feedInput');
    expect(html).toContain('feedInput.value = String(state.feedUrl || "")');
  });
});