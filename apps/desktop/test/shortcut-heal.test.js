const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * 快捷方式自愈契约(2026-11-09):安装器提权内层实例里 NSIS CreateShortCut 与子进程 PowerShell
 * 都不可用(实测),入口改由应用首启用 Electron shell.writeShortcutLink(用户态,带 AUMID)补齐。
 */
test("main.js: ensureShortcuts 用 shell.writeShortcutLink + AUMID,尊重桌面重定向", () => {
  const src = readFileSync(join(__dirname, "..", "main.js"), "utf8");
  assert.ok(src.includes("function ensureShortcuts()"), "缺少 ensureShortcuts");
  assert.ok(src.includes("shell.writeShortcutLink(link, \"create\""), "未用 Electron 原生写快捷方式");
  assert.ok(src.includes("appUserModelId: \"com.genie.harness\""), "未写 AUMID");
  assert.ok(src.includes("app.getPath(\"desktop\")"), "桌面路径未走 getPath(尊重重定向)");
  assert.ok(src.includes("Microsoft\", \"Windows\", \"Start Menu\", \"Programs\""), "开始菜单路径缺失");
  assert.ok(src.includes("GENIE_NO_SHORTCUT_HEAL"), "缺少关闭开关");
  assert.ok(src.includes("!app.isPackaged || process.platform !== \"win32\""), "未限定打包态 Windows");
  // 必须在 bootstrap 里被调用
  const i = src.indexOf("async function bootstrap()");
  const j = src.indexOf("ensureShortcuts();", i);
  assert.ok(j > i, "bootstrap 未调用 ensureShortcuts");
});
