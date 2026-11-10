# desktop 壳(Windows exe 封装)

Electron 窗口 + **内置 gateway 进程托管**。壳零业务逻辑:面板/会话/工具全部在 gateway(panel.ts)。

```
main.js             窗口、单实例锁、启动链编排、错误页、退出回收
gateway-process.js  spawn gateway / 探活 / 找空闲端口 / 优雅停止(可用 electron)
paths.js            数据根、gateway 产物目录、端口候选、资源自检、首启初始化(纯 node,无 electron)
logger.js           logs/desktop.log 滚动 5MB×3(纯 node)
electron-builder.yml  打包配置(NSIS 安装包 + portable 单文件)
test/paths.test.js  paths.js 单测(node:test)
```

## 开发态运行(两种)

```bash
# 方式 A:壳自起 gateway(推荐,接近打包态行为)
pnpm --filter @lampgenie/gateway build   # 产出 apps/gateway/dist(必须先 build)
pnpm --filter @lampgenie/desktop start

# 方式 B:直连已跑的外部 gateway(原有流程,未回退)
pnpm --filter @lampgenie/gateway dev
GENIE_DESKTOP_URL=http://127.0.0.1:7700 pnpm --filter @lampgenie/desktop start
```

`GENIE_DESKTOP_URL` 一旦设置,**壳不拉子进程、不做端口探测**,直接加载该地址(dev 热更新场景用)。

dev 态数据根:默认 `~/.lampgenie-harness`(Linux/mac)/ `%APPDATA%\LampGenie`(Windows);
可用 `GENIE_DESKTOP_DATA_ROOT=/tmp/xx` 覆盖到任意目录(注意:该目录会作为 `GENIE_REPO_ROOT` 注入 gateway)。

## 打包命令

```bash
cd apps/desktop
pnpm run dist:dir    # 只出 dist/win-unpacked(不下载 NSIS,先验证资源布局)
pnpm run dist:win    # 轻量包:NSIS 安装包 + portable 单文件(不含模型/浏览器/git)
pnpm run dist:full   # 全量包:先 stage ONNX 模型/Chromium/PortableGit 再打包(新 PC 零依赖)
```

三个脚本都先串行 `pnpm -w --filter @lampgenie/gateway build` + 依赖 staging(`scripts/stage-gateway-deps.mjs`),避免打出空壳或缺依赖的残包。`dist:full` 额外跑 `scripts/stage-full-runtime.mjs`(幂等,组件齐全自动跳过;`--force` 重建)。三个脚本还会跑 `scripts/stage-electron-dist.mjs`(从缓存/GitHub 解出 Windows Electron 到 `.stage/electron-dist`,配合 `electronDist` 实现离线打包;@electron/get 在本机网络下会 ECONNRESET)。

产物(全量包实测产出;括号内为轻量包体量):
- `dist/LampGenie Setup <ver>.exe` —— NSIS 安装包(**0.0.8 全量 666MB**;轻量 104MB)
- `dist/LampGenie-<ver>-portable.exe` —— 便携单文件(**626MB**;轻量 103MB)
- `dist/LampGenie Setup <ver>.exe.blockmap` —— 差分更新用

两者均为 NSIS-3 Unicode PE32,内含 `app-64.7z` 载荷(0.0.8 约 **1.9GB 未压缩**:gateway 123MB + ONNX 596MB + onnxruntime 23MB + Chromium 436MB + PortableGit 388MB + Electron)。安装后首启会用包内 Node/ONNX 自动拉起 150M 模型(加载+warmup 约 2–5s,之后常驻)。0.0.4 起无代码签名(`win.signAndEditExecutable:false`,避免下载 winCodeSign;exe 无自定义图标/版本资源,版本以 asar 内 package.json 为准)。0.0.5 起 NSIS 前置 `customInit`(`build/installer.nsh`)会先结束 LampGenie 进程树再装,覆盖升级不再因 exe/dll 被占用而跳文件。

### Windows 桌面端:WSL / SSH 连接向导

桌面端默认工作环境是 Windows(默认工作区 = Windows 数据根)。WSL 与 SSH 都走**连接向导**
(`添加项目 → 远程连接`),不是从本地目录选择器直接挑远端目录:

1. **连接目标**:WSL 页签列出本机发行版(`wsl -l -q`);SSH 页签填主机/用户/密码(或私钥)。
2. **连接中安装工作区服务**:`agent-stdio` 上传到目标 `~/.genie/`
   (node <14 用 `.cjs`,≥14 用 `.mjs`;WSL 首次要求发行版内已装 Node.js)。
3. **确认连接无误**:ping 工作区服务,回显 server 版本 + node 版本;同时安装**代码认知/评审运行时**
   (`code-sense` CLI + 自带 Node 20,约 40MB,落到远端 `~/.genie/genie-sense`)——之后 `code_sense` /
   `code_review` 也在远端执行(索引建在远端项目的 `.genie/sense-index`);装不上/不响应会明确报错。
4. **服务返回目录**:目录浏览由工作区服务列出(不是 Windows UNC 共享;连接用根 `/` 通道)。
5. **选目录加项目**:登记为 `remote:wsl:<发行版>:<POSIX>` / `remote:ssh:<host>:<port>:<user>:<POSIX>`。

项目建立后,**文件读写 / 目录操作 / grep / git / 终端 / agent 工具全部走目标内的工作区服务**(持久 stdio 管道);
WSL 终端为 `wsl.exe --cd <posix> --exec bash`。服务部署失败可经项目菜单「优化远程连接」重试。
工程档案 / `code_sense` 索引仍在本机(远程项目不建本地档案)。

### Linux/WSL 上构建的前置(装 wine)

electron-builder 的 NSIS 步骤需要 wine;**只装 wine64 不够** —— NSIS stub 是 32 位,会报
`err:process:exec_process ... not supported on this system` 与 `⨯ wine process failed 123`。必须:

```bash
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y --no-install-recommends wine64 wine32:i386
sudo ln -sf /usr/bin/wine64-stable /usr/local/bin/wine   # 发行包只提供 wine64-stable 这个名字
export WINEPREFIX=$HOME/.wine-genie WINEDEBUG=-all WINEDLLOVERRIDES="mscoree,mshtml="
wine wineboot --init                                      # 用新 prefix 初始化,WoW64 才会就绪
cd apps/desktop && npx electron-builder --win
```

验证 WoW64 就绪:`ls $WINEPREFIX/drive_c/windows/syswow64` 有内容(旧 prefix 没有,必须重建)。

⚠️ wine 下 `wine "Setup.exe" /S` **不落盘**(EXIT=0 但 drive_c 下无安装目录),不能当安装成功证据;安装/卸载/双击行为需 Windows 实机验证。产物完整性请用 `7z l` 查载荷清单。

## 数据位置

| 形态 | 数据根 |
|---|---|
| 便携版(portable)| `<exe 所在目录>\user-data`(`PORTABLE_EXECUTABLE_DIR` 环境变量由 electron-builder 注入) |
| 安装版 / 一般 Windows | `%APPDATA%\LampGenie` |
| 非 Windows / dev | `~/.lampgenie-harness` |
| 显式覆盖 | `GENIE_DESKTOP_DATA_ROOT` |

数据根下会初始化:

```
%APPDATA%\LampGenie\
  genie.config.json                最小配置({gateway:{port,panel},journal:{dir}};**不含凭证**;已存在则不覆盖)
  .genie\{journals,experiences,uploads,memory,plans,agent-outputs,llm-trace,secrets,browser-shots}\
  logs\{desktop,gateway}.log       5MB 滚动 desktop.log.1~.3
```

数据根经 env `GENIE_REPO_ROOT` 注入 gateway(不改 `repo-root.ts` 的仓内语义)。

## 日志

- `%APPDATA%\LampGenie\logs\desktop.log` —— 壳:启动参数、端口、探活耗时、重启、退出
- `%APPDATA%\LampGenie\logs\gateway.log` —— gateway 子进程 stdout/stderr 全量
- 错误页右下角有「打开日志目录」,点开即 `shell.openPath(logsDir)`

## 全量运行时(新 PC 零外部依赖,`dist:full`)

`dist:full` 会在打包前跑 `scripts/stage-full-runtime.mjs`,把外部依赖搬进 `resources/`:

| 目录 | 内容 | 用途 |
|---|---|---|
| `resources/runtime/model-150m` | ONNX 服务(`server.mjs` + `lib/` + `onnx/model.onnx` + `model.onnx.data` 596MB fp32,外部数据格式 + tokenizer)+ `node_modules`(`onnxruntime-node` win32-x64 + `@huggingface/tokenizers`) | 本地 150M 模型服务(**不再随 Python/torch**) |
| `resources/browsers/chrome-win64` | Chrome for Testing(与 playwright-core 1.64 同 revision) | browser 工具 |
| `resources/git` | PortableGit(bash + git + coreutils) | 终端/hooks/子代理的 POSIX 语义,git 面板 |

接入方式(`gateway-process.js` 的 `fullRuntimeEnv`,仅打包态注入):

- `GENIE_MODEL_150M_DIR` + `GENIE_MODEL_150M_ONNX_DIR` → 网关 boot 自动拉起 ONNX 模型服务(默认 8105);
- `CHROME_PATH` → `browser` 工具直接启动随包 Chromium;
- `GENIE_SHELL_BIN` → 随包 `git/bin/bash.exe`;`PATH` 前置 `git/cmd`、`git/bin`、`git/mingw64/bin`。

打包态启动会跑 `fullRuntimeChecklist`(见 `paths.js`),缺任一组件 → 错误页并列出缺项;
排障可用 `GENIE_ALLOW_PARTIAL_RUNTIME=1` 降级为警告。产物验收:

```bash
node scripts/verify-artifact.mjs --full   # 五件套 + 全量运行时(含权重体量下限)
node scripts/verify-artifact.mjs --proto  # 两个 bundle 协议版本一致
```

## 环境诊断与已知降级(Windows)

启动时会做资源自检(`resourceChecklist`),**必需项缺失直接错误页并列出缺项**(不静默降级):

必需:`gateway.mjs`、`assets/`、`sense-index-worker.mjs`、`tree-sitter.wasm`、`echo-child.mjs`
全量包另需:`runtime/model-150m`、`browsers/chrome-win64`、`git`(见上一节)

| 能力 | 依赖 | 桌面 Windows 状态 |
|---|---|---|
| 面板 / 会话 / journal | 无 | ✅ |
| code_sense / code_index | tree-sitter-wasms + web-tree-sitter + fork 子进程 | ✅ 随包 + `ELECTRON_RUN_AS_NODE=1`(否则子进程会再启一个 GUI 实例) |
| code_review | ts-morph | ✅ 随包 |
| 本地 150M 模型(上下文评分/剪枝) | 随包 ONNX fp32(`model.onnx`+`model.onnx.data` 596MB)+ onnxruntime-node | ✅ 随包,网关 boot 自动拉起(加载+warmup 约 5–10s,之后常驻) |
| browser 工具 | playwright-core + 随包 Chromium | ✅ 随包(`CHROME_PATH` 注入),不依赖本机 Chrome |
| 终端 / hooks / bash 子代理 | 随包 PortableGit bash | ✅ POSIX 语义可用(`GENIE_SHELL_BIN` 注入) |
| git 相关面板(git-service/worktree/team/issues) | 随包 `git.exe` | ✅ `PATH` 前置随包 git |
| 外部 CLI 后端(dsh/zcode/opencode/ACP) | 外部 CLI | ❌ 桌面版不随包 |
| 下载 `node-agent.mjs` | `downloads/node-agent.mjs` | ✅ 随包 |

其他运行时行为:

- **端口冲突自动让位**:依次试 7700..7720,全部占用 → 错误页。面板前端用 `location.host` 跟随,无需配置。
- **崩溃重启**:gateway 非主动退出 → 1s 后重启,连续 3 次失败 → 错误页(带子进程末 20 行输出 + 日志路径)。
- **单实例**:二次双击只聚焦已有窗口,不会起第二份 gateway。
- **关窗回收**:SIGTERM → 3s 未退则 Windows `taskkill /T /F`;`before-quit` / `will-quit` 双兜底。
- **无凭证首启**:不嵌套第二套表单,只在窗口标题提示「首次使用请在面板设置页接入模型」。

## 测试

```bash
cd apps/desktop && node --test test/
```

`paths.js` 顶层不 require electron,可直接用 node 跑: `node -e "require('./apps/desktop/paths.js')"`。

红线未变:`contextIsolation`+`sandbox` 全开、`nodeIntegration` 关、外链转系统浏览器、应用菜单置空。