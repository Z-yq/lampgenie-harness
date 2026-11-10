/**
 * agent 工具 `wait_until`( session 验证落地):条件等待原语。
 * 经验证(journal 11-01→11-08,134 session):582 次「sleep N; tail/grep 日志」式终端轮询、
 * 累计 sleep 13.4h——模型在等外部进程/脚本产出(文件出现/增长/含串)或终端静默时,
 * 唯一手段是 sleep+读,每个猜测周期烧一轮完整 LLM 往返。本工具把「等条件」变成一次
 * 挂起调用:挂起期间 loop 停在本工具 promise 上(task_output waitFor 同机制),零 LLM
 * 消耗;条件满足即返回并附现场快照(尾部行/字节/行数),省掉「醒了再查一次」的往返。
 * 分工(与既有等待原语不重叠):
 * - 等子代理终态 → task_output(waitFor:"result");
 * - 等自己启动的后台命令 → job(action:"wait");
 * - 等自己发的终端命令 → terminal send(wait:true 默认);
 * - 等**外部进程/文件系统**产出或终端输出静默 → 本工具(此前只能 sleep 轮询的缺口)。
 * 设计纪律:
 * - 只读(isReadOnly=true):不产生副作用,权限闸豁免,可与其它只读探测同批并行;
 * - 挂起=execute promise 内 500ms 节律轮询(task_output 同形态),signal 中止不挡取消;
 * - 自带超时(缺省 120s,上限 600s)→ 登记 SELF_MANAGED_TIMEOUT_TOOLS 豁免统一帽;
 * - 文件路径走 fencePath 围栏(与 read_file 同口径,项目根内);
 * - terminal_idle 用 service.list() 的 info 采样(不消费输出、不触碰会话活跃度),
 *   idle 判据=总产出字节(buffer.endCursor)持续不变 ≥ idleMs,或会话已退出。
 */
import { promises as fsp } from "node:fs";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { fencePath } from "./file-tools.js";
import { clampLine } from "./input-boundary.js";

/** terminal 面最小依赖(TerminalSessionService 结构兼容;生产直接传实例)。 */
export interface WaitUntilTerminalLike {
  list(owner: string): Array<{ id: string; status: string; cursor: number; exitCode?: number | null }>;
}

export interface CreateWaitUntilToolOptions {
  /** terminal owner(生产=task.sessionId;与 terminal 工具同 owner 域)。 */
  owner: string;
  /** 文件条件围栏根(生产=taskRoot)。 */
  root: string;
  /** terminal 服务(缺省=terminal_idle 条件不可用,其余条件不受影响)。 */
  terminalService?: WaitUntilTerminalLike;
}

interface FileCondition {
  path?: string;
  contains?: string;
  minLines?: number;
  minBytes?: number;
  /** 大小稳定毫秒数(写者已收尾;与 contains/minLines 等同时给时须全满足)。 */
  stableMs?: number;
}

interface TerminalIdleCondition {
  sessionId?: string;
  /** 静默判据毫秒(缺省 3000)。 */
  idleMs?: number;
}

interface WaitUntilArgs {
  file?: FileCondition;
  terminalIdle?: TerminalIdleCondition;
  timeoutSec?: number;
}

const TICK_MS = 500;
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
/** contains/尾部快照的读量上限:超 8MB 的文件只扫尾部 4MB(大日志不整读)。 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const TAIL_SCAN_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_TAIL_LINES = 5;
const SNAPSHOT_MAX_CHARS = 1500;

function err(msg: string): string {
  return JSON.stringify({ ok: false, code: "INVALID_INPUT", error: msg });
}

/** 读文件内容(大文件只取尾部),返回 null=读失败(视为未就绪,继续等)。 */
async function readForScan(abs: string, size: number): Promise<string | null> {
  try {
    if (size <= MAX_SCAN_BYTES) return await fsp.readFile(abs, "utf-8");
    const fh = await fsp.open(abs, "r");
    try {
      const start = Math.max(0, size - TAIL_SCAN_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf-8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** 现场快照的尾部行(每行 ≤200 字符,总量 ≤SNAPSHOT_MAX_CHARS)。 */
function tailLines(text: string): string[] {
  const lines = text.replace(/\n+$/, "").split("\n");
  const picked = lines.slice(-SNAPSHOT_TAIL_LINES).map((l) => clampLine(l));
  let total = 0;
  const out: string[] = [];
  for (const l of picked) {
    total += l.length + 1;
    if (total > SNAPSHOT_MAX_CHARS) break;
    out.push(l);
  }
  return out;
}

export function createWaitUntilTool(opts: CreateWaitUntilToolOptions): Tool {
  const { owner, root, terminalService } = opts;
  return {
    name: "wait_until",
    description:
      "条件等待原语:挂起直到条件满足或超时(**挂起期间零 LLM 消耗**,一次调用替代「sleep N; tail/grep」式轮询——实测该模式一轮烧一次全量上下文往返)。" +
      "条件满足即返回**现场快照**(文件大小/行数/尾部行),通常无需再查一次。两类条件(二选一):" +
      "①file={path, contains?, minLines?, minBytes?, stableMs?}——等文件出现/包含某串/行数字节数达标/大小稳定 stableMs 毫秒(写者收尾);多项同时给=须全满足;" +
      "②terminalIdle={sessionId, idleMs?=3000}——等某终端会话输出静默 idleMs 毫秒(外部长任务跑完的自然信号;总产出字节不再增长或会话已退出)。" +
      "分工:等子代理→task_output(waitFor:\"result\");等自己的后台命令→job(wait);等终端命令本身→terminal send 默认等待;等**外部进程产出/静默**→本工具。" +
      "timeoutSec 缺省 120、上限 600;超时返回 ok:false+当前快照,可加大重试或转人工排查。",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "object",
          description: "文件条件(项目相对路径,围栏同 read_file)",
          properties: {
            path: { type: "string", description: "项目相对路径" },
            contains: { type: "string", description: "等文件包含该串(如日志里的完成标记/PASS/done)" },
            minLines: { type: "number", description: "等行数 ≥ N" },
            minBytes: { type: "number", description: "等字节数 ≥ N" },
            stableMs: { type: "number", description: "等文件大小稳定 N 毫秒(增量写者已收尾;建议 ≥2000)" },
          },
          required: ["path"],
        },
        terminalIdle: {
          type: "object",
          description: "终端静默条件(等某会话输出停止增长)",
          properties: {
            sessionId: { type: "string", description: "terminal 会话 id(open 返回)" },
            idleMs: { type: "number", description: "静默判据毫秒(缺省 3000)" },
          },
          required: ["sessionId"],
        },
        timeoutSec: { type: "number", description: "总超时秒数(缺省 120,上限 600;超时返回当前快照)" },
      },
    },
    isReadOnly: () => true,
    // 纯等待无副作用(与 task_output 同口径):可与其它只读探测在同一步并行发。
    isConcurrencySafe: () => true,
    async execute(args: unknown, signal?: AbortSignal): Promise<string> {
      const a = (args ?? {}) as WaitUntilArgs;
      const hasFile = a.file != null && typeof a.file === "object";
      const hasIdle = a.terminalIdle != null && typeof a.terminalIdle === "object";
      if (hasFile === hasIdle) return err("必须且只能给一个条件:file 或 terminalIdle");
      const timeoutSec = Math.min(Math.max(Number(a.timeoutSec) || DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);
      const deadline = Date.now() + timeoutSec * 1000;

      // ── 条件闭包:每次 tick 求值,返回 {met, snapshot};stable/idle 的首见时刻记在闭包里。
      //    needSnapshot=true 时才读文件内容出尾部快照(tick 轮询不整读大文件,终态才算一次)──
      let evalCondition: (needSnapshot: boolean) => Promise<{ met: boolean; snapshot: Record<string, unknown> }>;

      if (hasFile) {
        const fc = a.file!;
        const rel = String(fc.path ?? "");
        if (!rel.trim()) return err("file.path 必填");
        const abs = await fencePath(root, rel);
        if (!abs) return err(`路径非法或越出项目根(${rel});只接受项目内相对路径`);
        const wantContains = typeof fc.contains === "string" && fc.contains.length > 0;
        const wantMinLines = typeof fc.minLines === "number" && fc.minLines > 0;
        const wantMinBytes = typeof fc.minBytes === "number" && fc.minBytes > 0;
        const wantStable = typeof fc.stableMs === "number" && fc.stableMs > 0;
        if (!wantContains && !wantMinLines && !wantMinBytes && !wantStable) {
          return err("file 条件至少给 contains/minLines/minBytes/stableMs 之一(缺省=只等文件出现也可以,但建议给明确判据)");
        }
        let lastSize = -1;
        let lastMtime = -1;
        let lastStableAt = 0;
        evalCondition = async (needSnapshot: boolean) => {
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = await fsp.stat(abs);
            if (!st.isFile()) return { met: false, snapshot: { type: "file", path: rel, note: "目标存在但不是普通文件" } };
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            return { met: false, snapshot: { type: "file", path: rel, exists: false } };
          }
          const now = Date.now();
 // 稳定判据=size+mtime 双不变(审计加固):日志轮转/truncate 后重写同长度内容
          // 时 size 不变但 mtime 必变——单一 size 判据会假稳定,双判据把稳定钟重置。
          if (size !== lastSize || mtimeMs !== lastMtime) { lastSize = size; lastMtime = mtimeMs; lastStableAt = now; }
          const stableFor = wantStable ? now - lastStableAt : Number.POSITIVE_INFINITY;
          const snapshot: Record<string, unknown> = { type: "file", path: rel, bytes: size, exists: true };
          let met = true;
          if (wantMinBytes && size < (fc.minBytes as number)) met = false;
          // 内容读取只在该读的时候读:条件需要(contains/minLines)或终态快照;纯 stat 条件 tick 零读盘。
          if (met && (wantContains || wantMinLines || needSnapshot)) {
            const text = await readForScan(abs, size);
            if (text == null) {
              met = false;
            } else {
              const lineCount = text === "" ? 0 : text.split("\n").length;
              if (needSnapshot) {
                snapshot.lines = lineCount;
                snapshot.tail = tailLines(text);
              }
              if (wantMinLines && lineCount < (fc.minLines as number)) met = false;
              if (met && wantContains && !text.includes(fc.contains as string)) {
                met = false;
                if (needSnapshot) snapshot.note = `未包含目标串(已扫 ${size <= MAX_SCAN_BYTES ? "全文件" : "尾部 4MB"})`;
              }
            }
          }
          if (wantStable) {
            snapshot.stableMs = Math.round(stableFor);
            if (stableFor < (fc.stableMs as number)) met = false;
          }
          return { met, snapshot };
        };
      } else {
        if (!terminalService) return err("terminal 面未接入,terminalIdle 条件不可用");
        const tc = a.terminalIdle!;
        const sid = String(tc.sessionId ?? "");
        if (!sid.trim()) return err("terminalIdle.sessionId 必填");
        const idleMs = Math.min(Math.max(Number(tc.idleMs) || 3000, 500), 60_000);
        let lastCursor = -1;
        let cursorStableAt = 0;
        evalCondition = async (_needSnapshot: boolean) => {
          const info = terminalService.list(owner).find((s) => s.id === sid);
          if (!info) return { met: false, snapshot: { type: "terminal_idle", sessionId: sid, note: "会话不存在(可能已关闭;用 terminal list 查)" } };
          const now = Date.now();
          const cursor = info.cursor; // info.cursor=buffer.endCursor(总产出字节,环淘汰不减)=产出水位
          if (cursor !== lastCursor) { lastCursor = cursor; cursorStableAt = now; }
          const idleFor = now - cursorStableAt;
          const exited = info.status !== "running";
          const met = exited || idleFor >= idleMs;
          return {
            met,
            snapshot: {
              type: "terminal_idle", sessionId: sid, status: info.status,
              ...(info.exitCode !== null && info.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
              idleMs: Math.round(idleFor),
              ...(exited ? { note: "会话已退出" } : {}),
            },
          };
        };
      }

      // ── 挂起循环(task_output 同形态):500ms 节律;signal 中止;超时返回快照 ──
      let aborted = false;
      const onAbort = () => { aborted = true; };
      signal?.addEventListener("abort", onAbort, { once: true });
      const startedAt = Date.now();
      let last: { met: boolean; snapshot: Record<string, unknown> } = { met: false, snapshot: {} };
      try {
        for (;;) {
          last = await evalCondition(false);
          if (last.met || aborted || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
        // 终态(满足/超时)再求值一次拿现场快照(尾部行等;tick 轮询从不读内容)。
        if (!aborted) last = await evalCondition(true);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      const waitedMs = Date.now() - startedAt;
      if (aborted) {
        return JSON.stringify({ ok: false, aborted: true, waitedMs, snapshot: last.snapshot, note: "父任务已取消,等待中止" });
      }
      if (last.met) {
        return JSON.stringify({ ok: true, met: true, waitedMs, ...last.snapshot });
      }
      return JSON.stringify({
        ok: false, timedOut: true, waitedMs, timeoutSec,
        snapshot: last.snapshot,
        hint: "条件在超时内未满足。确认判据写对了(路径/包含串/阈值)后可加大 timeoutSec 重试;外部进程可能已死,建议读快照现场判断。",
      });
    },
  };
}
