const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * 升级健壮性静态契约:
 * electron-builder 的 handleUninstallResult 在旧卸载失败时会弹 MB_OK 阻塞 modal(/S 静默也弹),
 * 经验证导致安装挂起。我们通过自定义 include 接管:
 *   - customUnInstallCheck / customUnInstallCheckCurrentUser 定义后,template 直接 Return,不再弹窗/Quit;
 *   - customInit 结束旧进程树,并兜底清理旧安装目录内的残留进程。
 * 这里锁住这些锚点,防止后续改动把修复删掉。
 */
test("installer.nsh: 旧卸载失败接管 + customInit 进程清理锚点", () => {
  const src = readFileSync(join(__dirname, "..", "build", "installer.nsh"), "utf8");
  assert.ok(src.includes("!macro customUnInstallCheck"), "缺少 installer 侧 customUnInstallCheck");
  assert.ok(src.includes("!macro customUnInstallCheckCurrentUser"), "缺少 currentUser 分支");
  assert.ok(src.includes("continue") || src.includes("覆盖安装"), "缺少继续覆盖语义");
  assert.ok(src.includes("ClearErrors"), "必须清错误,否则后续 IfErrors 会误判");
  assert.ok(!/MessageBox\s+MB_OK/.test(src), "自定义脚本不得自己弹阻塞 modal");
  assert.ok(src.includes("taskkill /F /IM LampGenie.exe'"), "customInit 必须结束应用进程");
 // 应用内更新:安装器是 LampGenie 的子进程,/T 会把安装器自己杀掉(经验证:
  // 点「安装并重启」后应用消失、版本没变、无安装日志)。异名子进程由目录扫描兜底。
  assert.ok(!src.includes("LampGenie.exe /T"), "taskkill 不得带 /T(会自杀安装器)");
  assert.ok(src.includes("!macro customCheckAppRunning"), "缺少 CHECK_APP_RUNNING 误报修复");
  assert.ok(src.includes("${IfNot} ${Silent}") && src.includes("DeleteRegKey"), "缺少非静默向导跳过旧卸载的修复");
  assert.ok(src.includes("genieKillProcessesUnderDir"), "缺少旧安装目录进程兜底");
  assert.ok(src.includes("${UNINSTALL_REGISTRY_KEY}"), "未读旧安装位置");
  // 快捷方式:提权内层实例里 NSIS CreateShortCut 可能失败;这里只保留 best-effort,真正的入口由
  // 应用首启 main.js ensureShortcuts()(shell.writeShortcutLink,用户态)自愈。
  assert.ok(src.includes("!macro customInstall"), "缺少 customInstall 快捷方式 best-effort");
  assert.ok(src.includes("CreateShortCut \"$SMPROGRAMS"), "缺少开始菜单 best-effort");
  assert.ok(src.includes("CreateShortCut \"$DESKTOP"), "缺少桌面 best-effort");
  assert.ok(!src.includes("install-diag.log"), "生产安装器不应写诊断文件");
  assert.ok(!src.includes("nsExec::ExecToStack"), "不应再依赖提权内层 PowerShell 子进程");
});