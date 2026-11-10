const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { buildTrayMenuTemplate, createTrayController } = require("../tray");

function fakeElectron() {
  const calls = { show: 0, newTask: 0, settings: 0, checkUpdate: 0, logs: 0, about: 0, quit: 0 };
  const made = { trays: [], menus: [] };
  class FakeTray {
    constructor(image) {
      this.image = image;
      this.handlers = new Map();
      this.tooltip = "";
      this.contextMenu = null;
      made.trays.push(this);
    }
    setToolTip(v) { this.tooltip = v; }
    setContextMenu(m) { this.contextMenu = m; }
    on(evt, cb) { this.handlers.set(evt, cb); }
    emit(evt) { const cb = this.handlers.get(evt); if (cb) cb(); }
    destroy() { this.destroyed = true; }
    displayBalloon() { this.balloon = true; }
  }
  const Menu = {
    buildFromTemplate(template) {
      const menu = { template };
      made.menus.push(menu);
      return menu;
    },
  };
  const nativeImage = { createFromDataURL: (url) => ({ url }) };
  const controller = createTrayController({
    Tray: FakeTray,
    Menu,
    nativeImage,
    platform: "win32",
    appName: "Genie Harness",
    onShow: () => { calls.show += 1; },
    onNewTask: () => { calls.newTask += 1; },
    onSettings: () => { calls.settings += 1; },
    onCheckUpdate: () => { calls.checkUpdate += 1; },
    onLogs: () => { calls.logs += 1; },
    onAbout: () => { calls.about += 1; },
    onQuit: () => { calls.quit += 1; },
    log: () => undefined,
  });
  return { controller, calls, made, FakeTray };
}

test("托盘菜单:显示/新建任务/设置/检查更新/日志/关于/退出 齐全且顺序稳定", () => {
  const tpl = buildTrayMenuTemplate({ appName: "Genie Harness" });
  const labels = tpl.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, [
    "显示 Genie Harness",
    "新建任务",
    "设置",
    "检查更新",
    "打开日志目录",
    "关于 Genie Harness",
    "退出 Genie Harness",
  ]);
  assert.equal(tpl.filter((i) => i.type === "separator").length, 3);
});

test("托盘控制器:创建/提示/菜单/点击唤醒/命令先唤醒再执行/销毁", () => {
  const { controller, calls, made, FakeTray } = fakeElectron();
  assert.ok(controller, "应创建托盘");
  const tray = made.trays[0];
  assert.ok(tray.image.url.startsWith("data:image/png;base64,"), "内联 PNG 图标");
  assert.match(tray.tooltip, /任务在后台继续运行/);
  assert.ok(tray.contextMenu, "应设置右键菜单");
  assert.ok(tray.handlers.has("click") && tray.handlers.has("double-click"), "单击/双击都应绑定");

  tray.emit("click");
  assert.equal(calls.show, 1);

  const items = tray.contextMenu.template;
  const find = (label) => items.find((i) => i.label === label);
  find("新建任务").click();
  assert.deepEqual(calls, { show: 2, newTask: 1, settings: 0, checkUpdate: 0, logs: 0, about: 0, quit: 0 }, "命令前应先唤醒");
  find("设置").click();
  assert.equal(calls.settings, 1);
  find("检查更新").click();
  assert.equal(calls.checkUpdate, 1);
  assert.equal(calls.show, 4, "检查更新也要先唤醒窗口(结果在面板里展示)");
  find("打开日志目录").click();
  assert.equal(calls.logs, 1);
  find("关于 Genie Harness").click();
  assert.equal(calls.about, 1);
  find("退出 Genie Harness").click();
  assert.equal(calls.quit, 1);

  controller.destroy();
  assert.equal(made.trays[0].destroyed, true);
});

test("托盘失败/平台不支持时返回 null(不阻塞启动,也不启用关闭到托盘)", () => {
  const Menu = { buildFromTemplate: (t) => t };
  const nativeImage = { createFromDataURL: () => ({}) };
  assert.equal(createTrayController({ Tray: null, Menu, nativeImage, platform: "win32" }), null);
  assert.equal(createTrayController({ Tray: class {}, Menu, nativeImage, platform: "darwin" }), null);
  const logs = [];
  class ThrowingTray { constructor() { throw new Error("no host"); } }
  const c = createTrayController({ Tray: ThrowingTray, Menu, nativeImage, platform: "linux", log: (m) => logs.push(m) });
  assert.equal(c, null);
  assert.ok(logs.some((m) => m.includes("create failed")));
});

test("main.js 接线:最小化/关闭进托盘、单实例唤醒、退出放行、GENIE_TRAY 开关", () => {
  const src = readFileSync(join(__dirname, "..", "main.js"), "utf8");
  assert.ok(src.includes("hideToTray(\"minimize\")"));
  assert.ok(src.includes("hideToTray(\"close\")"));
  assert.ok(src.includes("event.preventDefault()"));
  assert.ok(src.includes("setSkipTaskbar(true)"));
  assert.ok(src.includes("showMainWindow"));
  assert.ok(src.includes("GENIE_TRAY"));
  assert.ok(src.includes("trayQuitting = true"));
  assert.ok(src.includes("trayController.destroy()"));
  // 第二实例必须走 showMainWindow(从托盘恢复)
  const i = src.indexOf('app.on("second-instance"');
  assert.ok(src.slice(i, i + 260).includes("showMainWindow()"));
});