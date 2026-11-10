/**
 * 交付物声明账本:deliverable 工具 + 回读/核对/渲染纯函数。
 * 「说交付了就必须真交付」——模型产出报告/PPT/图片/导出件后登记路径,收尾
 * 自动核对文件是否还在(声明后删除、改成目录、变成符号链接都算缺失)。
 * 落 journal `custom/deliverable.declared`(append-only,同 taskId+processPath 幂等:
 * 重复 declare 不新增行,只刷新 at/size);收尾核对结论落 `custom/deliverable.verified`。
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Tool } from "@lampgenie/runtime/agent/loop";

export const DELIVERABLE_TOOL_NAME = "deliverable";

/** journal 面最小接口(测试注入假 journal)。 */
export interface DeliverableJournal {
  append(e: { kind: "custom"; sessionId: string; payload: Record<string, unknown>; idempotencyKey?: string }): unknown;
  readAll(): { kind: string; sessionId?: string; payload?: unknown; seq?: number }[];
}

export interface DeliverableRecord {
  taskId: string;
  /** 模型给的原始路径(相对路径原样保留,便于回执对账)。 */
  inputPath: string;
  /** 解析后的真实路径(realpath;幂等键与核对都以它为准)。 */
  processPath: string;
  size: number;
  mtimeMs: number;
  note?: string;
  at: number;
  seq?: number;
}

export interface VerifiedDeliverable {
  path: string;
  ok: boolean;
  size?: number;
  /** 缺失原因:missing(不存在)/ not-file(变成目录等非普通文件)/ symlink(被换成符号链接)。 */
  reason?: "missing" | "not-file" | "symlink";
}

function payloadType(p: unknown): string | undefined {
  const t = (p as { type?: unknown } | undefined)?.type;
  return typeof t === "string" ? t : undefined;
}

/** 本任务已声明的交付物(同 processPath 取最新一条,按声明顺序返回)。 */
export function readDeliverables(journal: DeliverableJournal, sessionId: string, taskId: string): DeliverableRecord[] {
  const byPath = new Map<string, DeliverableRecord>();
  for (const e of journal.readAll()) {
    if (e.kind !== "custom" || e.sessionId !== sessionId) continue;
    if (payloadType(e.payload) !== "deliverable.declared") continue;
    const p = e.payload as Record<string, unknown>;
    if (String(p.taskId ?? "") !== taskId) continue;
    const processPath = String(p.processPath ?? "");
    if (!processPath) continue;
    byPath.set(processPath, {
      taskId,
      inputPath: String(p.inputPath ?? ""),
      processPath,
      size: typeof p.size === "number" ? p.size : 0,
      mtimeMs: typeof p.mtimeMs === "number" ? p.mtimeMs : 0,
      ...(typeof p.note === "string" && p.note ? { note: p.note } : {}),
      at: typeof p.at === "number" ? p.at : 0,
      ...(typeof e.seq === "number" ? { seq: e.seq } : {}),
    });
  }
  return [...byPath.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** 逐项 stat 核对:不存在 / 变成目录 / 变成符号链接都算缺失(ok=false)。 */
export function verifyDeliverables(list: readonly DeliverableRecord[]): VerifiedDeliverable[] {
  return list.map((d) => {
    const path = d.processPath;
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) return { path, ok: false, reason: "symlink" as const };
      if (!st.isFile()) return { path, ok: false, reason: "not-file" as const };
      return { path, ok: true, size: st.size };
    } catch {
      return { path, ok: false, reason: "missing" as const };
    }
  });
}

const REASON_TEXT: Record<string, string> = {
  missing: "缺失(文件不存在)",
  "not-file": "缺失(已不是普通文件)",
  symlink: "缺失(已变成符号链接)",
};

/** 「## 交付物」段(无声明返回 "");缺失项点名原因。 */
export function renderDeliverables(items: readonly VerifiedDeliverable[]): string {
  if (!items.length) return "";
  const lines = items.map((it) =>
    it.ok
      ? `- ${it.path} — 存在(${it.size ?? 0} bytes)`
      : `- ${it.path} — ${REASON_TEXT[it.reason ?? "missing"] ?? "缺失"}`,
  );
  return ["## 交付物", ...lines].join("\n");
}

/** 缺失项警告行;全在返回 ""。 */
export function renderDeliverableWarning(items: readonly VerifiedDeliverable[]): string {
  const bad = items.filter((it) => !it.ok);
  if (!bad.length) return "";
  return `[交付物] 声明后缺失/变更:${bad.map((b) => b.path).join("、")}——交付物必须真实存在,补回或改声明。`;
}

export interface DeliverableToolOptions {
  journal: DeliverableJournal;
  sessionId: string;
  taskId: string;
  /** 相对路径的解析根(任务根;绝对路径原样用)。 */
  root: string;
}

/** deliverable 工具:登记一个真实存在的普通文件。 */
export function makeDeliverableTool(opts: DeliverableToolOptions): Tool {
  const { journal, sessionId, taskId, root } = opts;
  return {
    name: DELIVERABLE_TOOL_NAME,
    description:
      "登记一份交付物(产出报告/PPT/图片/导出件后调用)。参数 path(必填;相对路径按任务根解析)、note(可选,≤200 字)。" +
      "只接受真实存在的普通文件(目录/符号链接/不存在会报错);任务收尾自动核对存在性。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "交付文件路径(相对任务根或绝对路径)" },
        note: { type: "string", description: "一句话说明(≤200 字)" },
      },
      required: ["path"],
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    async execute(args: unknown) {
      const a = (args ?? {}) as { path?: unknown; note?: unknown };
      const inputPath = typeof a.path === "string" ? a.path.trim() : "";
      if (!inputPath) return "错误:path 不能为空(要登记交付文件的项目相对路径或绝对路径)";
      const abs = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
      let lst;
      try {
        lst = lstatSync(abs);
      } catch {
        return `错误:文件不存在:${abs}`;
      }
      if (lst.isSymbolicLink()) return `错误:不接受符号链接:${abs}(请登记真实文件路径)`;
      if (!lst.isFile()) return `错误:不是普通文件:${abs}(目录请登记其中的具体文件)`;
      let processPath = abs;
      try {
        processPath = realpathSync(abs);
      } catch { /* realpath 失败(竞态删除)退回 resolve 路径,stat 会兜底 */ }
      let st;
      try {
        st = statSync(processPath);
      } catch {
        return `错误:文件已不存在:${processPath}`;
      }
      const note = typeof a.note === "string" ? a.note.trim().slice(0, 200) : "";
      const at = Date.now();
      const payload: Record<string, unknown> = {
        type: "deliverable.declared",
        taskId,
        inputPath,
        processPath,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ...(note ? { note } : {}),
        at,
      };
      try {
        // 幂等:同 taskId+processPath 用同一 idempotencyKey(重申不新增行),就地刷新 at/size/mtime。
        const ev = journal.append({
          kind: "custom",
          sessionId,
          payload,
          idempotencyKey: `deliverable:${taskId}:${processPath}`,
        }) as { payload?: Record<string, unknown> } | undefined;
        const live = ev?.payload;
        if (live && live !== payload) {
          live.size = st.size;
          live.mtimeMs = st.mtimeMs;
          live.at = at;
          if (note) live.note = note;
        }
      } catch { /* 留痕失败不影响回执 */ }
      return `已登记交付物:${processPath}(${st.size} bytes)`;
    },
  };
}
