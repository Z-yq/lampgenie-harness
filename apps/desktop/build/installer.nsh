; 覆盖升级健壮性(2026-11-09 用户实测驱动)
;
; 事故:旧卸载器返回 2 时,electron-builder 模板的 handleUninstallResult 会弹 MB_OK 阻塞
; modal("Failed to uninstall old application files ... : 2"),静默安装(/S)也弹 → 无人在场时挂起。
;
; 两层修复:
; 1) customInit:结束旧安装目录下的所有进程(GateineHarness 进程树 + 目录内残留 Chrome),
;    让旧卸载器有机会成功;
; 2) customUnInstallCheck / customUnInstallCheckCurrentUser:接管卸载结果处理——失败只写
;    DetailPrint 并 ClearErrors,继续覆盖安装,不再弹 modal 也不 Quit。
;    (模板里 handleUninstallResult 命中这两个宏后会直接 Return,原生弹窗分支不再编译执行。)

; 结束指定目录下的进程(仅当路径前缀匹配;不误杀用户自己的 Chrome)。
; 注意:本宏插入点是 .onInit,LogicLib/defines 已可用;PowerShell 里的 $_ 必须写 $$_ 防 NSIS 展开。
!macro genieKillProcessesUnderDir DIR
  nsExec::ExecToLog "powershell -NoProfile -ExecutionPolicy Bypass -Command $\"Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and ($$_.Path.ToLower().StartsWith('${DIR}'.ToLower())) } | Stop-Process -Force -ErrorAction SilentlyContinue$\""
!macroend

!macro customInit
  ; 旧安装位置(覆盖安装时才有):用于兜底结束 browser 工具拉起、已脱离进程树的 Chrome。
  ReadRegStr $R9 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R9 == ""
    ReadRegStr $R9 HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}" InstallLocation
  ${endIf}
  ; 1) 主进程 + 子进程树(gateway 与主进程同名,按映像名即可命中)。
  ;    ⚠️ 不能用 /T:应用内更新时安装器是 LampGenie 的子进程,/T 会把安装器自己一起杀掉
  ;    (2026-11-09 实测:点「安装并重启」后应用消失、版本没变、无任何安装日志)。
  ;    Chrome 等异名子进程由下面的目录扫描兜底。
  nsExec::ExecToLog 'taskkill /F /IM LampGenie.exe'
  ; 2) 兜底:旧安装目录内的残留进程(Chrome 被 detach 或跨会话残留时 /T 杀不到)
  ${if} $R9 != ""
    !insertmacro genieKillProcessesUnderDir "$R9"
  ${endIf}
  ; 非静默向导:模板 uninstallOldVersion 在旧卸载器失败时会弹「无法关闭」重试/取消框
  ; (静默模式 /SD IDCANCEL 自动继续)。这里在向导流程直接摘掉旧卸载注册项,跳过旧卸载、
  ; 以覆盖安装继续,避免用户被阻塞(残留旧文件由覆盖/首启自愈处理)。
  ${IfNot} ${Silent}
    DeleteRegKey HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}"
  ${EndIf}
  Sleep 1500
!macroend

; 非静默向导「LampGenie 无法关闭」误报修复(2026-11-09):
; 模板 CHECK_APP_RUNNING 的 FIND_PROCESS 用 $INSTDIR 前缀匹配进程;向导流程中 $INSTDIR
; 可能为空/过宽,会把任意进程当成应用自己 → 卡在 MB_RETRYCANCEL 重试框。
; 这里覆盖为「只按映像名结束本应用进程」,安装前置达成且不误报。
; 注意:同样不加 /T——应用内更新时安装器自己是 LampGenie 的后代进程,/T 会自杀。
!macro customCheckAppRunning
  nsExec::ExecToLog 'taskkill /F /IM LampGenie.exe'
  Sleep 1200
!macroend

; 卸载结果接管:无论“启动失败”还是“退出码非 0”,都继续装,不弹窗、不 Quit。
!macro genieUninstallContinue
  ${if} ${Errors}
    DetailPrint "旧版本卸载器无法启动:跳过卸载,继续覆盖安装"
  ${elseIf} $R0 != 0
    DetailPrint "旧版本卸载失败(exit=$R0):跳过卸载,继续覆盖安装"
  ${else}
    DetailPrint "旧版本已卸载:继续安装"
  ${endIf}
  ClearErrors
!macroend

!macro customUnInstallCheck
  !insertmacro genieUninstallContinue
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro genieUninstallContinue
!macroend

; 快捷方式自愈(2026-11-09):360 等会清理「无效快捷方式」;electron-builder 升级时沿用旧链接,
; 被删后不会补建 → 开始菜单/桌面没有入口,Windows toast 的 AUMID 也失去载体。
; 实测根因:安装段在 UAC 提权内层实例执行,**NSIS 原生 CreateShortCut 在该上下文总是失败**
; (返回 ERROR 且无 .lnk),但同一实例的文件写入与 PowerShell WScript.Shell COM 正常。
; 因此用 build/genie-shortcut.ps1(File 到 $PLUGINSDIR)创建链接并写 AUMID;原生调用仅作兜底。
; 快捷方式(2026-11-09):安装段在 UAC 提权内层实例执行,实测 NSIS CreateShortCut 与子进程 PowerShell
; 均不可用(ERROR / ps_exit=error),这里保留一次原生 best-effort;真正的入口由应用首启
; main.js ensureShortcuts() 用 Electron shell.writeShortcutLink 自愈(用户态,带 AUMID)。
!macro customInstall
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
!macroend