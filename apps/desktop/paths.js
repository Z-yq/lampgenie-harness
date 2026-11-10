/**
 * 桌面壳的路径解析与首启初始化。
 * 纯函数 + 只依赖 node 内置模块 —— 顶层**不得** require("electron"),
 * 以便 `node --test test/` 脱离 electron 直接跑。
 * 数据根设计(见 K2):
 * 桌面态不回退 process.cwd(),而是由壳解析出固定数据根,再经 env `GENIE_REPO_ROOT`
 * 注入给 gateway(repo-root.ts:7 已支持该 env 短路,不改其仓内语义)。
 */
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, dirname } = require("node:path");

/** .genie 下的目录骨架(与 gateway 实际读写面一致)。 */
const GENIE_SUBDIRS = [
  "journals",
  "experiences",
  "uploads",
  "memory",
  "plans",
  "agent-outputs",
  "llm-trace",
  "secrets",
  "browser-shots",
];

/** 最小配置:只有端口/面板/日志目录三项,**绝不写凭证**。 */
const MINIMAL_CONFIG = { gateway: { port: 7700, panel: true }, journal: { dir: ".genie/journals" } };

/**
 * 数据根解析,优先级四档:
 * 1. env.GENIE_DESKTOP_DATA_ROOT(显式覆盖,测试/多实例用)
 * 2. 便携态:PORTABLE_EXECUTABLE_DIR(electron-builder portable target 注入)→ <exe 目录>/user-data
 * 3. Windows:%APPDATA%\LampGenie(APPDATA 缺失退 homedir)
 * 4. 其他平台:~/.lampgenie-harness
 * 形参只放「决定数据根」的输入;execPath/resourcesPath 不参与本决策(打包态由 extraResources
 * 决定 gateway 位置,数据根与安装位置解耦),故不从签名里接收,避免调用方误以为能改落点。
 */
function resolveDataRoot({ env, platform, portableDir } = {}) {
  const e = env || process.env;
  const os = platform || process.platform;
  if (e.GENIE_DESKTOP_DATA_ROOT) return e.GENIE_DESKTOP_DATA_ROOT;
  const portable = e.PORTABLE_EXECUTABLE_DIR || portableDir;
  if (portable) return join(portable, "user-data");
  if (os === "win32") return join(e.APPDATA || homedir(), "LampGenie");
  return join(homedir(), ".lampgenie-harness");
}

/**
 * 从 startDir 向上找 pnpm-workspace.yaml 定位仓根(最多 8 层)。
 * 与 apps/gateway/src/repo-root.ts 思路相同,但本文件自带实现(不 import gateway 的 TS)。
 * 找不到返回 null。
 */
function findRepoRoot(startDir, maxDepth = 8) {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * gateway 产物目录:
 * - 打包态:<resources>/gateway(extraResources 的 to:gateway)
 * - dev 态:<仓根>/apps/gateway/dist(仓根可由 devRepoRoot 注入)
 * 找不到仓根返回 null(由 main.js 转错误页)。
 */
function resolveGatewayDir({ env, isPackaged, resourcesPath, devRepoRoot } = {}) {
  if (isPackaged) return join(resourcesPath, "gateway");
  const root = devRepoRoot || findRepoRoot(__dirname);
  if (!root) return null;
  return join(root, "apps", "gateway", "dist");
}

/** 端口候选序列 [start, end] 闭区间。 */
function listPortCandidates(start = 7701, end = 7720) {
  // 桌面默认从 7701 起:web 网关(WSL/服务器)固定 7700——WSL2 镜像网络下两端共用端口会互抢
 // (注意:桌面占 7700 后 web 网关「端口被占」;7870 同理走 RELAY_PORT=7871)。
  const out = [];
  for (let p = start; p <= end; p++) out.push(p);
  return out;
}

/**
 * 打包资源自检清单。
 * required=false 的项缺失只代表对应功能降级(例如 playwright-core 缺 → browser 工具不可用),
 * 不阻塞启动;required=true 缺 → 壳显示错误页并列出缺项(不允许静默 degrade)。
 */
function resourceChecklist(gatewayDir) {
  const items = [
    { name: "gateway.mjs", rel: "gateway.mjs", required: true },
    { name: "assets", rel: "assets", required: true },
    { name: "session-worker.mjs", rel: "session-worker.mjs", required: true },
    { name: "sense-index-worker.mjs", rel: "sense-index-worker.mjs", required: true },
    { name: "tree-sitter.wasm", rel: "tree-sitter.wasm", required: true },
    { name: "echo-child.mjs", rel: "echo-child.mjs", required: true },
    { name: "downloads/node-agent.mjs", rel: join("downloads", "node-agent.mjs"), required: false },
    { name: "node_modules/ts-morph", rel: join("node_modules", "ts-morph"), required: false },
    { name: "node_modules/playwright-core", rel: join("node_modules", "playwright-core"), required: false },
    { name: "node_modules/tree-sitter-wasms", rel: join("node_modules", "tree-sitter-wasms"), required: false },
    { name: "node_modules/web-tree-sitter", rel: join("node_modules", "web-tree-sitter"), required: false },
  ];
  const base = gatewayDir || "";
  return items.map(({ name, rel, required }) => {
    const abs = base ? join(base, rel) : rel;
    return { name, path: abs, required, missing: !existsSync(abs) };
  });
}

/**
 * 全量运行时自检(资源根 = <install>/resources)。
 * 这些组件让新 PC 零外部依赖:模型服务自带 ONNX 权重,浏览器自带 Chromium,
 * shell/git 自带 PortableGit。缺任一 → 对应**主能力降级**,但不再视为「安装坏了」:
 * 经验证 360 安全卫士会把 onnxruntime.dll / chrome_elf.dll 等当作可疑文件持续隔离,
 * 若这里判 required 就会把整个应用拦在启动页(核心对话/工具其实不需要评分 DLL)。
 * 因此全部标记 required=false,由 main.js 记警告 + 标题提示降级;
 * 发布 QA 可用 GENIE_REQUIRE_FULL_RUNTIME=1 恢复严格阻断。
 */
function fullRuntimeChecklist(resourcesDir) {
  const base = resourcesDir || "";
  const m = (...p) => join("runtime", "model-150m", ...p);
  const items = [
    { name: "runtime/model-150m/server.mjs", rel: m("server.mjs") },
    { name: "runtime/model-150m/lib/encode.mjs", rel: m("lib", "encode.mjs") },
    { name: "runtime/model-150m/lib/ort-engine.mjs", rel: m("lib", "ort-engine.mjs") },
    { name: "runtime/model-150m/onnx/config.json", rel: m("onnx", "config.json") },
    { name: "runtime/model-150m/onnx/tokenizer.json", rel: m("onnx", "tokenizer.json") },
    { name: "runtime/model-150m/onnx/model.onnx", rel: m("onnx", "model.onnx") },
    { name: "runtime/model-150m/onnx/model.onnx.data", rel: m("onnx", "model.onnx.data") },
    { name: "runtime/model-150m/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll", rel: m("node_modules", "onnxruntime-node", "bin", "napi-v6", "win32", "x64", "onnxruntime.dll") },
    { name: "runtime/model-150m/node_modules/@huggingface/tokenizers/package.json", rel: m("node_modules", "@huggingface", "tokenizers", "package.json") },
    { name: "browsers/chrome-win64/chrome.exe", rel: join("browsers", "chrome-win64", "chrome.exe") },
    { name: "git/bin/bash.exe", rel: join("git", "bin", "bash.exe") },
    { name: "git/cmd/git.exe", rel: join("git", "cmd", "git.exe") },
    { name: "sense-remote.tar.gz(远端代码认知运行时)", rel: "sense-remote.tar.gz" },
  ];
  return items.map(({ name, rel }) => {
    const abs = base ? join(base, rel) : rel;
    return { name, path: abs, required: false, missing: !existsSync(abs) };
  });
}

/**
 * 首启建数据根骨架(幂等):
 * <dataRoot>/.genie/{journals,experiences,uploads,memory,plans,agent-outputs,llm-trace,secrets,browser-shots}
 * <dataRoot>/logs
 * <dataRoot>/genie.config.json(不存在才写,flag:'wx' 防覆盖用户已有配置;不含凭证)
 */
function ensureDataRoot(dataRoot) {
  if (!dataRoot) throw new Error("ensureDataRoot: dataRoot 必填");
  for (const sub of GENIE_SUBDIRS) mkdirSync(join(dataRoot, ".genie", sub), { recursive: true });
  mkdirSync(join(dataRoot, "logs"), { recursive: true });

  const configPath = join(dataRoot, "genie.config.json");
  let configCreated = false;
  try {
    writeFileSync(configPath, `${JSON.stringify(MINIMAL_CONFIG, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    configCreated = true;
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
  }
  return { dataRoot, configPath, configCreated };
}

/** 是否已接入过模型(凭证面):.genie/secrets.json 存在且为非空对象才为 true。 */
function hasAnyCredential(dataRoot) {
  if (!dataRoot) return false;
  try {
    const raw = readFileSync(join(dataRoot, ".genie", "secrets.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

function readJsonFile(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 数据根里是否已具备可用的主轨 LLM 路由(fix S137-2)。
 * 为什么壳要自己判:gateway 的 LLM 装配发生在**进程启动时**——首启没有模型配置就 llm=off,
 * 之后用户在面板里配好模型只落盘,旧进程不会自愈(无 provider 实例可热切,agent loop 也没接线),
 * 表现就是「任务秒完成但只是 echo 回显」。壳据此决定要不要自动重启 gateway。
 * 判定口径与 gateway 装配同源(resolveTrackEndpoint 语义):
 *  1. coding.llm / audio.chat 的 model 非空;
 *  2. baseUrl 能解析:轨内自带 baseUrl,或 providerId 指向 providers[] 里有 baseUrl 的条目;
 *  3. 凭证能解析:apiKeyEnv 在 secrets.json 有值,或进程 env 里有该名,或编码轨兜底 GENIE_LLM_API_KEY。
 * 三步全过才算 ready(缺凭证=装配必然失败,重启也没用,不重启)。
 */
function llmRouteState(dataRoot, env = process.env) {
  const cfg = readJsonFile(join(dataRoot, "genie.config.json")) || {};
  const secrets = readJsonFile(join(dataRoot, ".genie", "secrets.json")) || {};
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  const coding = cfg.coding || {};
  const llm = coding.llm || {};
  const audioChat = (cfg.audio && cfg.audio.chat) || {};

  // 主轨口径与 gateway 一致:audio.chat 显式配置优先,否则 coding.llm
  const audioRef = audioChat.baseUrl || audioChat.model || audioChat.providerId ? audioChat : null;
  const ref = audioRef || llm;
  const track = audioRef ? "audio.chat" : "coding";

  if (!ref.model) return { ready: false, reason: "未配置模型(coding.llm.model 为空)" };

  const provider = ref.providerId ? providers.find((p) => p && p.id === ref.providerId) : undefined;
  const baseUrl = ref.baseUrl || (provider && provider.baseUrl);
  if (!baseUrl) {
    return { ready: false, reason: "未配置端点(coding.llm.baseUrl 与 providers[providerId].baseUrl 均缺失)" };
  }

  const keyEnv =
    ref.apiKeyEnv || (provider && provider.apiKeyEnv) || (track === "audio.chat" ? "GENIE_AUDIO_API_KEY" : "GENIE_LLM_API_KEY");
  const fromSecrets = typeof secrets[keyEnv] === "string" && secrets[keyEnv].length > 0;
  const fromEnv = typeof env[keyEnv] === "string" && env[keyEnv].length > 0;
  if (!fromSecrets && !fromEnv) {
    return { ready: false, reason: `缺少凭证(${keyEnv} 既不在 secrets.json 也不在环境变量)` };
  }

  return { ready: true, reason: `模型 ${ref.model} @ ${baseUrl}` };
}

module.exports = {
  GENIE_SUBDIRS,
  MINIMAL_CONFIG,
  resolveDataRoot,
  findRepoRoot,
  resolveGatewayDir,
  listPortCandidates,
  resourceChecklist,
  fullRuntimeChecklist,
  ensureDataRoot,
  hasAnyCredential,
  llmRouteState,
};