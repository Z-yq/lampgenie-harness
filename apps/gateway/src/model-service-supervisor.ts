/**
 * 内置 150M 模型服务监管。
 * 生命周期:
 *   gateway boot → 探活(已有健康服务=接管,不重复拉起)
 *                → 本地 URL + autoStart + 路径齐全 → spawn uvicorn(services/model-150m)
 *                → /health 轮询至 ready → running
 *                → 子进程异常退出 → backoff 重启(最多 10 次)
 *   gateway SIGINT/SIGTERM → 停本进程拉起的子进程组(外部服务不动)
 * 边界:
 * - 只接管 loopback providerUrl;外部 provider 不启动本地服务。
 * - 模型仓库/checkpoint 缺失=missing + 明示跑 setup.sh,不静默假装 ready。
 * - 子进程 detached + unref:gateway 崩溃时模型服务可存活;下次 boot 探活直接接管。
 * - 日志落 .genie/logs/model-150m.log,不把模型加载日志灌进 gateway 主日志。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "@lampgenie/core";

export type ModelServiceState =
  | "disabled"
  | "external"
  | "missing"
  | "starting"
  | "running"
  | "failed"
  | "stopped";

export interface ModelServiceStatus {
  state: ModelServiceState;
  providerUrl: string;
  port: number;
  pid?: number;
  restarts: number;
  lastError?: string;
  logPath: string;
  serviceDir: string;
}

interface SupervisorOptions {
  repoRoot: string;
  config: Config;
  log?: (line: string) => void;
}

const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_RESTARTS = 10;

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function portOfUrl(url: string, fallback: number): number {
  try {
    const port = Number(new URL(url).port);
    return Number.isFinite(port) && port > 0 ? port : fallback;
  } catch {
    return fallback;
  }
}

export class Model150mSupervisor {
  private readonly repoRoot: string;
  private readonly config: Config;
  private readonly logLine: (line: string) => void;
  private readonly serviceDir: string;
  private readonly logPath: string;
  private child?: ChildProcess;
  private stopping = false;
  private started = false;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private status: ModelServiceStatus;

  constructor(opts: SupervisorOptions) {
    this.repoRoot = opts.repoRoot;
    this.config = opts.config;
    this.logLine = opts.log ?? ((line) => console.log(line));
    // 全量桌面包:模型服务随安装包分发(GENIE_MODEL_150M_DIR);dev/7700 仍走仓内 services/model-150m。
    this.serviceDir = process.env.GENIE_MODEL_150M_DIR || join(opts.repoRoot, "services", "model-150m");
    this.logPath = join(opts.repoRoot, ".genie", "logs", "model-150m.log");
    const ms = opts.config.context.modelScoring;
    const port = portOfUrl(ms.providerUrl, ms.localService.port);
    this.status = {
      state: "stopped",
      providerUrl: ms.providerUrl,
      port,
      restarts: 0,
      logPath: this.logPath,
      serviceDir: this.serviceDir,
    };
  }

  statusOf(): ModelServiceStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const ms = this.config.context.modelScoring;
    if (!ms.localService.autoStart) {
      this.status.state = "disabled";
      this.log("[model-150m] localService.autoStart=false,网关不启动内置模型");
      return;
    }
    if (!isLoopbackUrl(ms.providerUrl)) {
      this.status.state = "external";
      this.log(`[model-150m] providerUrl=${ms.providerUrl} 非 loopback,不启动本地服务(外部 provider 模式)`);
      return;
    }
    await this.ensureRunning();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || !child.pid) {
      this.status.state = "stopped";
      return;
    }
    this.log(`[model-150m] stopping pid=${child.pid}`);
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    }
    this.status.state = "stopped";
  }

  private async ensureRunning(): Promise<void> {
    const health = await this.probeHealth();
    if (health.ok) {
      this.status.state = "external";
      this.status.pid = health.pid;
      this.log(`[model-150m] 已有健康服务,接管不重复拉起: ${this.status.providerUrl}`);
      return;
    }
    const ms = this.config.context.modelScoring.localService;
    // ONNX 模式(桌面全量包默认):server.mjs + onnx 模型存在即走 Node/onnxruntime,不再依赖 Python/torch。
    const nodeEntry = join(this.serviceDir, "server.mjs");
    const onnxDir = process.env.GENIE_MODEL_150M_ONNX_DIR || join(this.serviceDir, "onnx");
    const preferred = process.env.GENIE_MODEL_150M_ONNX || join(onnxDir, "model.onnx");
    const fp32Model = join(onnxDir, "model.fp32.onnx");
    if (existsSync(nodeEntry) && (existsSync(preferred) || existsSync(fp32Model))) {
      await this.spawnAndWait({ kind: "onnx", dir: onnxDir, model: existsSync(preferred) ? preferred : fp32Model });
      return;
    }
    // 兼容旧 Python 服务(dev 未导出 ONNX 的仓):行为与历史一致。
    const repo = ms.repoPath || process.env.GENIE_MODEL_150M_REPO || join(this.serviceDir, "upstream");
    const checkpoint = ms.checkpointPath || process.env.GENIE_MODEL_150M_CKPT || join(this.serviceDir, "jevlite.pt");
    if (!existsSync(repo) || !existsSync(checkpoint)) {
      this.status.state = "missing";
      this.status.lastError =
        `缺少 ONNX 模型(server.mjs + ${preferred})或旧 Python 上游/checkpoint(repo=${repo}, ckpt=${checkpoint});` +
        "先跑 services/model-150m/tools/export_onnx.py,或运行 setup.sh 一次";
      this.log(`[model-150m] 内置模型未安装:${this.status.lastError}`);
      return;
    }
    await this.spawnAndWait({ kind: "python", repo, checkpoint });
  }

  private async spawnAndWait(launch: { kind: "onnx"; dir: string; model: string } | { kind: "python"; repo: string; checkpoint: string }): Promise<void> {
    if (this.stopping) return;
    const ms = this.config.context.modelScoring.localService;
    const port = this.status.port;
    mkdirSync(dirname(this.logPath), { recursive: true });
    const fd = openSync(this.logPath, "a");
    let cmd: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    let label: string;
    if (launch.kind === "onnx") {
      cmd = process.execPath;
      args = [join(this.serviceDir, "server.mjs"), "--port", String(port), "--dir", launch.dir, "--model", basename(launch.model)];
      env = {
        ...process.env,
        // 桌面态 process.execPath = LampGenie.exe:必须按 Node 语义跑(否则再开一个 GUI 实例)。
        ELECTRON_RUN_AS_NODE: "1",
        MODEL_DIR: launch.dir,
        MODEL_FILE: basename(launch.model),
        ORT_THREADS: String(ms.threads),
        MAX_BATCH_SIZE: String(ms.maxBatchSize),
        MAX_WAIT_MS: String(ms.maxWaitMs),
        MAX_QUEUE: String(ms.maxQueue),
        REQUEST_TIMEOUT_S: String(ms.requestTimeoutS),
        MAX_ROWS: String(ms.maxRows),
      };
      label = `${cmd} server.mjs --port ${port} --model ${basename(launch.model)}(onnx)`;
    } else {
      const venvPython = process.platform === "win32"
        ? join(this.serviceDir, ".venv", "Scripts", "python.exe")
        : join(this.serviceDir, ".venv", "bin", "python");
      const python = ms.python || process.env.GENIE_MODEL_150M_PYTHON || (existsSync(venvPython) ? venvPython : "python3");
      cmd = python;
      args = ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", String(port)];
      env = {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        MODEL_REPO: launch.repo,
        MODEL_CKPT: launch.checkpoint,
        MODEL_THREADS: String(ms.threads),
        // 基座/tokenizer 已由 setup.sh 预下载;离线加载避免每次 boot 访问 HF
        // (国内直连常挂起,且网关启动窗口不该消耗在网络上)。显式设 0 可覆盖。
        HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE || "1",
        TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE || "1",
        HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET || "1",
        MAX_BATCH_SIZE: String(ms.maxBatchSize),
        MAX_WAIT_MS: String(ms.maxWaitMs),
        MAX_QUEUE: String(ms.maxQueue),
        REQUEST_TIMEOUT_S: String(ms.requestTimeoutS),
        MAX_ROWS: String(ms.maxRows),
        ...(ms.device ? { MODEL_DEVICE: ms.device } : {}),
      };
      label = `${python} -m uvicorn server:app --port ${port}(python)`;
    }
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: this.serviceDir,
        env,
        stdio: ["ignore", fd, fd],
        detached: true,
      });
    } catch (err) {
      closeSync(fd);
      this.status.state = "failed";
      this.status.lastError = `spawn 失败: ${String(err)}`;
      this.log(`[model-150m] ${this.status.lastError}。日志: ${this.logPath}`);
      this.scheduleRestart();
      return;
    }
    closeSync(fd);
    child.unref();
    this.child = child;
    this.status.state = "starting";
    this.status.pid = child.pid;
    this.status.lastError = undefined;
    this.log(`[model-150m] 启动 pid=${child.pid ?? "?"} ${label};日志 ${this.logPath}`);
    child.once("error", (err) => {
      this.status.state = "failed";
      this.status.lastError = `子进程错误: ${String(err)}`;
      this.log(`[model-150m] ${this.status.lastError}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.status.pid = undefined;
      if (this.stopping) return;
      this.log(`[model-150m] 子进程退出 code=${code ?? "?"} signal=${signal ?? "?"};检查是否可接管/重启`);
      void this.probeHealth().then((health) => {
        if (health.ok) {
          this.status.state = "external";
          this.status.pid = health.pid;
          this.log("[model-150m] 退出后发现健康服务,按外部服务接管");
          return;
        }
        this.status.state = "failed";
        this.status.lastError = `子进程退出 code=${code ?? "?"} signal=${signal ?? "?"}`;
        this.scheduleRestart();
      });
    });

    const deadline = Date.now() + this.config.context.modelScoring.localService.startupTimeoutMs;
    while (!this.stopping && Date.now() < deadline) {
      if (child.exitCode !== null) return; // exit handler owns restart/state
      const health = await this.probeHealth();
      if (health.ok) {
        this.status.state = "running";
        this.status.pid = health.pid ?? child.pid;
        this.status.lastError = undefined;
        this.log(`[model-150m] ready pid=${this.status.pid ?? "?"} url=${this.status.providerUrl}`);
        return;
      }
      await sleep(1_000);
    }
    if (!this.stopping) {
      this.status.state = "failed";
      this.status.lastError = `启动超时(${this.config.context.modelScoring.localService.startupTimeoutMs}ms),见 ${this.logPath}`;
      this.log(`[model-150m] ${this.status.lastError}`);
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || !this.config.context.modelScoring.localService.autoStart) return;
    if (this.status.restarts >= MAX_RESTARTS) {
      this.log(`[model-150m] 已达最大重启次数 ${MAX_RESTARTS},停止自动拉起(修好后重启网关)`);
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(this.status.restarts, RESTART_DELAYS_MS.length - 1)]!;
    this.status.restarts += 1;
    this.status.state = "starting";
    this.log(`[model-150m] ${delay}ms 后重启(第 ${this.status.restarts}/${MAX_RESTARTS} 次)`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.ensureRunning();
    }, delay);
    this.restartTimer.unref?.();
  }

  private async probeHealth(): Promise<{ ok: boolean; pid?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const res = await fetch(`http://127.0.0.1:${this.status.port}/health`, { signal: controller.signal });
      if (!res.ok) return { ok: false };
      const body = await res.json() as { ok?: unknown; batching?: { pid?: unknown } };
      const batching = body.batching as { pid?: unknown } | undefined;
      const pid = typeof batching?.pid === "number" ? batching.pid : undefined;
      return { ok: body.ok === true, ...(pid ? { pid } : {}) };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private log(line: string): void {
    this.logLine(line);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
