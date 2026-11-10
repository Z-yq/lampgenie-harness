const test = require("node:test");
const assert = require("node:assert/strict");
const { buildApplicationMenuTemplate, MENU_COMMANDS } = require("../app-menu");

function menuByLabel(template, label) {
  return template.find((m) => m.label === label);
}
function itemByLabel(menu, label) {
  return (menu.submenu || []).find((i) => i.label === label);
}

test("Windows 模板:文件/编辑/视图/窗口/帮助齐全,编辑与视图走标准 role", () => {
  const t = buildApplicationMenuTemplate({ platform: "win32" });
  const labels = t.map((m) => m.label);
  assert.deepEqual(labels, ["文件", "编辑", "视图", "窗口", "帮助"]);
  const edit = menuByLabel(t, "编辑").submenu;
  for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
    assert.ok(edit.some((i) => i.role === role), "缺编辑 role " + role);
  }
  const view = menuByLabel(t, "视图").submenu;
  for (const role of ["reload", "forceReload", "toggleDevTools", "togglefullscreen"]) {
    assert.ok(view.some((i) => i.role === role), "缺视图 role " + role);
  }
  assert.ok(!t.some((m) => m.label === "Genie Harness"), "Windows 不应有 macOS 应用菜单");
});

test("缩放项只展示键位、不注册 accelerator(键盘路径归 main.js,防双放大)", () => {
  const calls = [];
  const t = buildApplicationMenuTemplate({ platform: "win32", onZoom: (k) => calls.push(k) });
  const view = menuByLabel(t, "视图").submenu;
  const zoomIn = itemByLabel(menuByLabel(t, "视图"), "放大");
  const zoomOut = itemByLabel(menuByLabel(t, "视图"), "缩小");
  const zoomReset = itemByLabel(menuByLabel(t, "视图"), "重置缩放");
  for (const item of [zoomIn, zoomOut, zoomReset]) {
    assert.equal(item.registerAccelerator, false);
    assert.match(item.accelerator, /^CmdOrCtrl\+/);
  }
  zoomIn.click();
  zoomOut.click();
  zoomReset.click();
  assert.deepEqual(calls, ["in", "out", "reset"]);
  // 视图菜单里不应出现 Electron 自带的 zoom role(它会绕过持久化)
  assert.ok(!view.some((i) => ["zoomIn", "zoomOut", "resetZoom"].includes(i.role)));
});

test("文件菜单发命令:新建任务/设置 + 命令 id 稳定", () => {
  const ids = [];
  const t = buildApplicationMenuTemplate({ platform: "win32", onCommand: (id) => ids.push(id) });
  const file = menuByLabel(t, "文件").submenu;
  const newTask = itemByLabel(menuByLabel(t, "文件"), "新建任务");
  const settings = itemByLabel(menuByLabel(t, "文件"), "设置");
  assert.equal(newTask.accelerator, "CmdOrCtrl+N");
  assert.equal(settings.accelerator, "CmdOrCtrl+,");
  newTask.click();
  settings.click();
  assert.deepEqual(ids, [MENU_COMMANDS.newTask, MENU_COMMANDS.openSettings]);
  assert.ok(file.some((i) => i.role === "quit"));
});

test("帮助菜单:检查更新/日志/数据目录 + 关于;macOS 额外应用菜单", () => {
  const helpCalls = [];
  let about = 0;
  const t = buildApplicationMenuTemplate({
    platform: "win32",
    onHelp: (k) => helpCalls.push(k),
    onAbout: () => { about += 1; },
  });
  itemByLabel(menuByLabel(t, "帮助"), "检查更新…").click();
  itemByLabel(menuByLabel(t, "帮助"), "打开日志目录").click();
  itemByLabel(menuByLabel(t, "帮助"), "打开数据目录").click();
  itemByLabel(menuByLabel(t, "帮助"), "关于 Genie Harness").click();
  assert.deepEqual(helpCalls, ["update", "logs", "data"]);
  assert.equal(about, 1);

  const mac = buildApplicationMenuTemplate({ platform: "darwin", appName: "Genie Harness" });
  assert.equal(mac[0].label, "Genie Harness");
  assert.ok(mac[0].submenu.some((i) => i.role === "about"));
  assert.ok(mac[0].submenu.some((i) => i.role === "quit"));
});