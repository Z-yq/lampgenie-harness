const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/** preload 桥契约:只暴露固定方法;通知/菜单/通知点击通道必须存在。 */
test("titlebar-preload:通知与菜单桥锚点", () => {
  const src = readFileSync(join(__dirname, "..", "titlebar-preload.js"), "utf8");
  assert.ok(src.includes('invoke("genie:notify"'));
  assert.ok(src.includes("onMenuCommand"));
  assert.ok(src.includes("genie:menu-command"));
  assert.ok(src.includes("onNotificationClick"));
  assert.ok(src.includes("genie:notification-click"));
  assert.ok(src.includes("onDeepLink"));
  assert.ok(src.includes("genie:deep-link"));
  // 版本检查/应用内更新:白名单动作 + 状态订阅
  assert.ok(src.includes('invoke("genie:update"'));
  assert.ok(src.includes("update-state"));
  for (const act of ["check", "configure", "download", "dismiss", "openPage", "install"]) {
    assert.ok(src.includes(act), "更新桥缺少动作 " + act);
  }
  // 不暴露任意通道发送能力
  assert.ok(!/send:\s*\(/.test(src), "不应暴露通用 send");
  assert.ok(!src.includes("ipcRenderer.send("), "preload 不应直接 send 任意通道");
});