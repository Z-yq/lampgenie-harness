/**
 * gateway 子进程托管(step-136 P0-2/P0-3/P0-4)。
 * 允许 require("electron") 之外的一切 node 内置;本文件不 import electron(保持可单测)。
 */
const { spawn } = require("node:child_process");
const { createWriteStream, existsSync, mkdirSync } = require("node:fs");
const { get } = require("node:http");
const { createServer } = require("node:net");
const { join } = require("node:path");

const { listPortCandidates } = require("./paths");

const RECENT_LINES = 20;
const STOP_GRACE_MS = 3000;

/**
 * 全量运行时 env(resources/runtime + browsers + git)。
 * 只有 key 文件存在才注入,dev 态(无 .stage 产物)整体跳过、行为与旧版一致。
 * 路径一律绝对路径:gateway 的 cwd 是数据根,相对路径会解析错。
 */
function fullRuntimeEnv(resourcesDir) {
  if (!resourcesDir) return {};
  const runtime = join(resourcesDir, "runtime");
  const modelDir = join(runtime, "model-150m");
  // ONNX 运行时:server.mjs + onnx 模型随包,不再需要 Python/torch。
  if (!existsSync(join(modelDir, "server.mjs")) || !existsSync(join(modelDir, "onnx"))) return {};
  const env = {
    GENIE_MODEL_150M_DIR: modelDir,
    GENIE_MODEL_150M_ONNX_DIR: join(modelDir, "onnx"),
  };
  const chrome = join(resourcesDir, "browsers", "chrome-win64", "chrome.exe");
  if (existsSync(chrome)) env.CHROME_PATH = chrome;
  const senseTar = join(resourcesDir, "sense-remote.tar.gz");
  if (existsSync(senseTar)) env.GENIE_SENSE_REMOTE_TAR = senseTar;
  const gitRoot = join(resourcesDir, "git");
  const bash = join(gitRoot, "bin", "bash.exe");
  if (existsSync(bash)) {
    env.GENIE_SHELL_BIN = bash;
    // cmd/git.exe 是 PATH 上的 git;usr/bin 提供给 bash 的 coreutils(ls/grep/sed/awk)。
    // Windows 的 process.env 键通常是 `Path`(大小写不敏感):沿用原键名,避免 spawn env
    // 里同时出现 Path 与 PATH 两个键、由 libuv 决定谁生效。
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    env[pathKey] = [join(gitRoot, "cmd"), join(gitRoot, "bin"), join(gitRoot, "mingw64", "bin"), process.env[pathKey] || ""].join(";");
  }
  return env;
}

/**
 * 起 gateway 子进程。
 * K1:必须注入 ELECTRON_RUN_AS_NODE=1,否则 process.execPath(打包态 = LampGenie.exe)
 * 会再启一个 GUI 实例而不是 Node 解释器(gateway 内部 fork 的子进程继承该 env)。
 * K2:GENIE_REPO_ROOT 指向桌面数据根,短路 repo-root.ts 的 cwd 回退。
 * K5:NODE_PATH 指向随包的 gateway/node_modules(ts-morph / playwright-core 等 external)。
 * K6:全量运行时(模型/Chromium/git)经 resourcesDir 注入路径,新 PC 不依赖外部安装。
 */
function startGateway({ gatewayDir, dataRoot, port, logs, onExit, resourcesDir } = {}) {
  mkdirSync(logs, { recursive: true });
  const logPath = join(logs, "gateway.log");
  const logStream = createWriteStream(logPath, { flags: "a" });

  const entry = join(gatewayDir, "gateway.mjs");
  const child = spawn(process.execPath, [entry], {
    cwd: dataRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...fullRuntimeEnv(resourcesDir),
      ELECTRON_RUN_AS_NODE: "1",
      GENIE_REPO_ROOT: dataRoot,
      GENIE_GATEWAY_PORT: String(port),
      // 桌面内嵌团队 relay 默认 7871:与 web 侧 7870 错开(镜像网络互抢,同 listPortCandidates);
      // 用户显式设置了 RELAY_PORT 时不覆盖。
      ...(process.env.RELAY_PORT ? {} : { RELAY_PORT: "7871" }),
      GENIE_PANEL: "1",
      NODE_PATH: join(gatewayDir, "node_modules"),
    },
  });

  const recent = [];
  let stopped = false;

  function pushLines(prefix, chunk) {
    const text = String(chunk);
    logStream.write(text.endsWith("\n") ? text : `${text}\n`);
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      recent.push(`${prefix}${line}`);
      while (recent.length > RECENT_LINES) recent.shift();
    }
  }

  child.stdout.on("data", (c) => pushLines("", c));
  child.stderr.on("data", (c) => pushLines("[stderr] ", c));
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  child.on("exit", (code, signal) => {
    logStream.write(`${new Date().toISOString()} gateway exit code=${code} signal=${signal} stopped=${stopped}\n`);
    logStream.end();
    if (typeof onExit === "function") onExit({ code, signal, stopped });
  });
  child.on("error", (err) => {
    logStream.write(`${new Date().toISOString()} gateway spawn error: ${err && err.message}\n`);
    logStream.end();
    if (typeof onExit === "function") onExit({ code: null, signal: null, stopped, error: err });
  });

  async function stop() {
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      // 兜底:强制杀之后最多再等 2s,避免调用方(窗口关闭/退出)被无限拖住。
      const hardCap = () => setTimeout(done, 2000);
      const timer = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          // Windows 无 SIGKILL,用 taskkill 连子孙进程一起收(K1 的 fork 子进程)。
          // 必须等 taskkill 真正结束再 resolve:否则调用方(如 Electron 主进程)立刻 quit 时,
          // 进程树可能尚未被收掉,留下残留进程与占用端口的时间窗。
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("exit", hardCap);
          killer.on("error", hardCap);
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            /* 已退出 */
          }
          hardCap();
        }
      }, STOP_GRACE_MS);
      child.once("exit", done);
    });
  }

  return {
    child,
    logPath,
    port,
    recentOutput: () => recent.slice(),
    restartable: () => !stopped,
    stop,
  };
}

/**
 * 就绪探测:轮询 GET /,status < 500 且 body 含 <!DOCTYPE 或 <html 即认为面板已起
 * (避免把 5xx 错误页当成功)。
 */
function probeReady(port, { timeoutMs = 60000, intervalMs = 200 } = {}) {
  const startedAt = Date.now();
  let lastError = "";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const deadline = setTimeout(() => finish({ ok: false, ms: Date.now() - startedAt, lastError: lastError || "timeout" }), timeoutMs);

    const attempt = () => {
      if (settled) return;
      let done = false;
      const req = get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        // res 的 error 必须接:响应头已到、读 body 期间 socket 被重置时 Node 在 IncomingMessage
        // 上触发 'error',无监听=未捕获异常冒泡(uncaughtException),而 req 的 error 不会兜住它。
        res.on("error", (err) => {
          done = true;
          lastError = (err && err.code) || "response error";
          if (!settled) setTimeout(attempt, intervalMs);
        });
        res.on("data", (c) => {
          if (body.length < 65536) body += c;
        });
        res.on("end", () => {
          done = true;
          const status = res.statusCode || 0;
          const looksPanel = /<!doctype/i.test(body) || /<html/i.test(body);
          // 就绪判定收紧到 2xx:4xx 的 HTML 错误页(404 默认页等)同样含 <html>,若按 <500 判会
          // 把错误页当成就绪,壳随后加载到错误页而不是面板。
          if (status >= 200 && status < 300 && looksPanel) finish({ ok: true, ms: Date.now() - startedAt, lastError: "" });
          else {
            lastError = `status=${status} panel=${looksPanel}`;
            setTimeout(attempt, intervalMs);
          }
        });
      });
      // req 的 'timeout' 由 node:http 在 timeout 选项到期时发出(非应用层事件)。
      req.on("timeout", () => {
        lastError = "request timeout";
        req.destroy();
      });
      req.on("error", (err) => {
        done = true;
        lastError = (err && err.code) || (err && err.message) || "request error";
        setTimeout(attempt, intervalMs);
      });
      req.on("close", () => {
        if (!done && !settled) setTimeout(attempt, intervalMs);
      });
    };

    attempt();
  });
}

/** 从候选序列里找第一个可绑定的端口;全占用返回 null。 */
function findFreePort({ candidates, host = "127.0.0.1" } = {}) {
  const ports = candidates || listPortCandidates();
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= ports.length) {
        resolve(null);
        return;
      }
      const port = ports[i++];
      const server = createServer();
      server.unref();
      server.once("error", () => {
        server.close(() => {});
        tryNext();
      });
      server.listen({ port, host, exclusive: true }, () => {
        server.close(() => resolve(port));
      });
    };
    tryNext();
  });
}

module.exports = { startGateway, probeReady, findFreePort, fullRuntimeEnv, RECENT_LINES, STOP_GRACE_MS };