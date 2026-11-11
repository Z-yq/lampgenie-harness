/**
 * 会话时间旅行:IO 层(内容寻址快照 / 恢复 / 截断 fork)。
 * 设计取舍:
 * - blob 按 sha256 内容寻址:同内容多步/多会话只存一份,恢复时按 manifest 里的 sha 取回。
 * - manifest 每步一份(`<dir>/<session>/<stepId>.json`),原子 tmp+rename —— 步骤没写完不算数。
 * - 所有 IO 异常 fail-soft 返回 code,不 throw 到调用方(时间旅行是旁路能力,绝不打断 agent 主链)。
 * - 恢复前校验目标路径在 root 内(归一 + 存在文件再 realpath),越界跳过,不给 ../ 留口子。
 * - 为什么快照要在工具执行前拍:见 time-travel.ts 顶部;store 只负责按计划把「执行前」的字节读下来。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  snapshotPlan,
  normalizeSnapshotPath,
  rewindPlan,
  forkPlan,
  boundaryOfStep,
  truncatePlan,
  SNAPSHOT_MAX_FILE_BYTES,
  type SnapshotFile,
  type SnapshotSkip,
} from "@lampgenie/runtime/agent/time-travel";
import type { Journal } from "@lampgenie/core";

export interface TimeTravelManifest {
  v: 1;
  sessionId: string;
  stepId: string;
 /** 采集时刻(ms)。 */
  at: number;
 /** 路径围栏根(采集时传入的 root;恢复按它校验越界)。 */
  root: string;
  files: SnapshotFile[];
  skipped: SnapshotSkip[];
}

export interface CaptureResult {
  ok: boolean;
  manifest?: TimeTravelManifest;
  skipped?: SnapshotSkip[];
  code?: string;
}

export interface PreviewResult {
  ok: boolean;
  files: SnapshotFile[];
  manifest?: TimeTravelManifest;
  code?: string;
}

export interface RestoreResult {
  ok: boolean;
  restored: number;
  deleted: number;
  missing: string[];
  code?: string;
}

export interface ForkEventsResult {
  ok: boolean;
  copied: number;
  dropped: number;
  code?: string;
}

/** 「只删对话」结果(不 throw;code 即失败原因,调用方原样回帧)。 */
export interface TruncateResult {
  ok: boolean;
  code: string;
}

export class TimeTravelStore {
  readonly root: string;
  readonly dir: string;
  private readonly journal?: Journal;

  constructor(opts: { root: string; dir?: string; journal?: Journal }) {
    this.root = path.resolve(opts.root);
    this.dir = opts.dir ? path.resolve(opts.dir) : path.join(this.root, ".genie", "time-travel");
    this.journal = opts.journal;
  }

  manifestPath(sessionId: string, stepId: string): string {
    return path.join(this.dir, safeSegment(sessionId), safeSegment(stepId) + ".json");
  }

  blobPath(sha: string): string {
    return path.join(this.dir, "blobs", sha);
  }

 /**
 * 采集一步的快照。paths 是「本步工具将要触碰」的原样参数(相对/绝对均可,越界被 snapshotPlan 跳过)。
 * 先 stat 拿字节数给 plan 判上限,再按 plan 读文件写 blob;manifest 原子落盘。
 */
  async capture(sessionId: string, stepId: string, root: string, paths: string[]): Promise<CaptureResult> {
    try {
      const fence = path.resolve(root || this.root);
      const list = Array.isArray(paths) ? paths : [];
 // 预 stat(只用于字节上限判定;读盘失败按不存在处理,真实存在性稍后再判)
      const sizes: Record<string, number> = {};
      for (const raw of list) {
        const norm = normalizeSnapshotPath(fence, raw);
        if (!norm) continue;
        try {
          const st = await fs.stat(norm.abs);
          if (st.isFile()) sizes[norm.rel] = st.size;
        } catch { /* 不存在=existed:false 候选 */ }
      }
      const plan = snapshotPlan({ paths: list, root: fence, sizes });
      const files: SnapshotFile[] = [];
      for (const f of plan.files) {
        const abs = path.join(fence, f.path);
        let st;
        try { st = await fs.stat(abs); } catch { st = undefined; }
        if (!st || !st.isFile()) {
          files.push({ path: f.path, existed: false, ...(f.binary ? { binary: true } : {}) });
          continue;
        }
        if (st.size > SNAPSHOT_MAX_FILE_BYTES) {
          plan.skipped.push({ path: f.path, reason: "too-large" });
          continue;
        }
        let buf: Buffer;
        try { buf = await fs.readFile(abs); } catch {
          files.push({ path: f.path, existed: false, ...(f.binary ? { binary: true } : {}) });
          continue;
        }
        const sha = createHash("sha256").update(buf).digest("hex");
        try { await this.writeBlob(sha, buf); } catch {
 // blob 落盘失败:仍记 manifest(恢复时会进 missing,不静默丢行)
        }
        files.push({ path: f.path, existed: true, sha, size: buf.length, ...(f.binary ? { binary: true } : {}) });
      }
      const manifest: TimeTravelManifest = {
        v: 1,
        sessionId,
        stepId,
        at: Date.now(),
        root: fence,
        files,
        skipped: plan.skipped,
      };
      await this.writeManifest(sessionId, stepId, manifest);
      return { ok: true, manifest, skipped: plan.skipped };
    } catch (err) {
      return { ok: false, skipped: [], code: "CAPTURE_FAILED:" + String(err).slice(0, 120) };
    }
  }

 /**
 * 边界校验:有 journal 时 stepId 必须在 journal 里有真实 step.start + message.agent 边界。
 * 未知边界返回稳定码 BOUNDARY_NOT_FOUND(不再静默退化成空文件列表);无 journal = 旧行为(ok)。
 * fail-soft:journal 读取异常返回 JOURNAL_ERROR,不 throw(时间旅行是旁路能力,绝不打断主链)。
 */
  private assertBoundary(sessionId: string, stepId: string): { ok: true } | { ok: false; code: string; reason: string } {
    if (!this.journal) return { ok: true };
    try {
      const events = this.journal.readAll();
      if (boundaryOfStep(events as never, sessionId, { stepId })) return { ok: true };
      return { ok: false, code: "BOUNDARY_NOT_FOUND", reason: `未知边界: session=${sessionId} step=${stepId}` };
    } catch (err) {
      return { ok: false, code: "JOURNAL_ERROR", reason: String(err).slice(0, 120) };
    }
  }

 /** 预览一步的 manifest 文件清单(不读 blob)。 */
  async preview(sessionId: string, stepId: string): Promise<PreviewResult> {
    const guard = this.assertBoundary(sessionId, stepId);
    if (!guard.ok) return { ok: false, files: [], code: guard.code };
    const manifest = await this.readManifest(sessionId, stepId);
    if (!manifest) return { ok: false, files: [], code: "MANIFEST_MISSING" };
    return { ok: true, files: manifest.files, manifest };
  }

 /**
 * 恢复到该步快照:existed=true 写回 blob;existed=false 且现在存在 → 删除;
 * blob 缺失 → missing(不写、不删)。目标路径越出 manifest.root → 跳过。
 */
  async restore(sessionId: string, stepId: string): Promise<RestoreResult> {
    const out: RestoreResult = { ok: false, restored: 0, deleted: 0, missing: [] };
    const guard = this.assertBoundary(sessionId, stepId);
    if (!guard.ok) return { ...out, code: guard.code };
    const manifest = await this.readManifest(sessionId, stepId);
    if (!manifest) return { ...out, code: "MANIFEST_MISSING" };
    try {
      const fence = path.resolve(manifest.root || this.root);
      const existsNow = async (rel: string): Promise<boolean> => {
        const abs = this.safeAbs(fence, rel);
        if (!abs) return false;
        try { await fs.stat(abs); return true; } catch { return false; }
      };
      const plan = rewindPlan({
        snapshot: manifest,
        dirExists: (rel) => {
          const abs = this.safeAbs(fence, rel);
          return !!abs;
        },
      });
 // dirExists 是同步签名,这里用异步探测修正「existed=false」的 delete 面
      const deletes: string[] = [];
      for (const rel of plan.delete) {
        if (await existsNow(rel)) deletes.push(rel);
      }
      for (const f of plan.restore) {
        const abs = await this.verifiedAbs(fence, f.path);
        if (!abs) continue;
        let buf: Buffer;
        try { buf = await fs.readFile(this.blobPath(String(f.sha))); } catch {
          out.missing.push(f.path);
          continue;
        }
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await atomicWrite(abs, buf);
          out.restored++;
        } catch (err) {
          out.missing.push(f.path);
          void err;
        }
      }
      for (const rel of deletes) {
        const abs = await this.verifiedAbs(fence, rel);
        if (!abs) continue;
        try { await fs.unlink(abs); out.deleted++; } catch { /* 已不在=不计 */ }
      }
      for (const rel of plan.missingBlobs) out.missing.push(rel);
      return { ...out, ok: true };
    } catch (err) {
      return { ...out, code: "RESTORE_FAILED:" + String(err).slice(0, 120) };
    }
  }

 /**
 * 「只删对话」:把 boundary 之后的对话作废(journal 追加 custom{session.truncate})。
 * 语义与文件快照解耦:不读盘、不写盘,只落一条审计/指令事件;真正生效在 deriveMessages
 * (loop 侧按 (boundary, T) 区间过滤消息类事件)。幂等键 `truncate:<sid>:<boundary>` 保证
 * 同一 boundary 重复调用不重复落盘(UI 重试/双端并发都不会叠加区间)。
 */
  async truncateMessages(sessionId: string, boundarySeq: number, journal?: Journal): Promise<TruncateResult> {
    const j = journal ?? this.journal;
    if (!j) return { ok: false, code: "JOURNAL_MISSING" };
    try {
      const plan = truncatePlan(j.readAll() as never, { boundarySeq });
      if (plan.code === "INVALID") return { ok: false, code: "INVALID" };
      if (plan.code === "NO_BOUNDARY") return { ok: false, code: "NO_BOUNDARY" };
      j.append({
        kind: "custom" as never,
        sessionId,
        payload: {
          type: "session.truncate",
          boundarySeq: plan.boundarySeq,
          at: Date.now(),
        } as never,
        idempotencyKey: `truncate:${sessionId}:${plan.boundarySeq}`,
      });
      return { ok: true, code: "OK" };
    } catch (err) {
      return { ok: false, code: "TRUNCATE_FAILED:" + String(err).slice(0, 120) };
    }
  }

 /**
 * 截断 fork:读 journal,只复制 seq<=atSeq 的会话事件到新 sessionId。
 * exclude 给会话分叉的既有排除集(任务生命周期噪声);幂等键必须剥除(journal 幂等表全局)。
 */
  async forkEvents(
    sessionId: string,
    atSeq: number,
    newSessionId: string,
    exclude?: ReadonlySet<string>,
  ): Promise<ForkEventsResult> {
    if (!this.journal) return { ok: false, copied: 0, dropped: 0, code: "JOURNAL_MISSING" };
    try {
      const all = this.journal.readAll();
      const plan = forkPlan(all as never, sessionId, { atSeq });
      let copied = 0;
      for (const e of plan.events) {
        if (exclude && exclude.has(e.kind)) continue;
        this.journal.append({
          kind: e.kind as never,
          sessionId: newSessionId,
          payload: (e.payload ?? {}) as never,
          ...(typeof e.time === "number" ? { time: e.time } : {}),
        });
        copied++;
      }
      return { ok: true, copied, dropped: plan.dropped };
    } catch (err) {
      return { ok: false, copied: 0, dropped: 0, code: "FORK_FAILED:" + String(err).slice(0, 120) };
    }
  }

 /** 归一 + 越界判定;存在文件再 realpath 复核(防符号链接跳出 root)。 */
  private safeAbs(fence: string, rel: string): string | null {
    const norm = normalizeSnapshotPath(fence, rel);
    if (!norm) return null;
    return norm.abs;
  }

 /** 恢复写盘/删除前的强校验:先归一,存在则 realpath 必须仍在 root 内(符号链接不越界)。 */
  private async verifiedAbs(fence: string, rel: string): Promise<string | null> {
    const abs = this.safeAbs(fence, rel);
    if (!abs) return null;
    try {
      const realFence = await fs.realpath(fence).catch(() => path.resolve(fence));
      const realTarget = await fs.realpath(abs);
      if (realTarget !== realFence && !realTarget.startsWith(realFence + path.sep)) return null;
    } catch { /* 目标还不存在(新建文件的回滚):归一判定已足够 */ }
    return abs;
  }

  private async writeManifest(sessionId: string, stepId: string, manifest: TimeTravelManifest): Promise<void> {
    const file = this.manifestPath(sessionId, stepId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, Buffer.from(JSON.stringify(manifest), "utf8"));
  }

  private async readManifest(sessionId: string, stepId: string): Promise<TimeTravelManifest | null> {
    try {
      const text = await fs.readFile(this.manifestPath(sessionId, stepId), "utf8");
      const parsed = JSON.parse(text) as TimeTravelManifest;
      if (!parsed || !Array.isArray(parsed.files)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeBlob(sha: string, buf: Buffer): Promise<void> {
    const file = this.blobPath(sha);
    try { await fs.access(file); return; } catch { /* 未存在 */ }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, buf);
  }
}

/** 原子写:同目录 tmp(random 后缀,并发不互撞) + rename。 */
async function atomicWrite(file: string, buf: Buffer): Promise<void> {
  const tmp = `${file}.tmp-${process.pid.toString(36)}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, buf);
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* 清理失败不掩盖原错 */ }
    throw err;
  }
}

/** 会话/步骤 id 做目录名:safe 字符集外一律替换,避免路径注入。 */
function safeSegment(text: string): string {
  const s = String(text ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return s.slice(0, 120) || "_";
}
