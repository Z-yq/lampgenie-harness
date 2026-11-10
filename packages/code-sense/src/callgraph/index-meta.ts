/**
 * 索引元数据面(2026-11-08):indexDir / meta.json / fp.json 的单一实现。
 *
 * 背景(7700 会话审计实锤):①根预算闸每次冷启动要全仓 walk 判大小,9p 慢盘 15s deadline
 * 随机超时 → 正常 monorepo 被误判「巨根」降级成工作区扇出;②过期判定依赖的全量指纹在
 * 冷进程 2s 预算内永远走不完(实测 7.5s)→ indexStale 恒「不过期」,索引可静默陈旧 8 天。
 *
 * 本模块提供两块小而持久的事实:
 *  - meta.json:构建产物身份(builtAt/srcCount/nodes/edges),根预算闸读 1KB 即可判「已知小仓」,
 *    不必再走全仓;也让外部工具/诊断面不必解析 30MB index.json。
 *  - fp.json:最近一次完整源文件指纹(at/count/maxMtime)。冷启动直接读盘上结论,把「未知→
 *    暂不过期」换成「有据可依」;后台异步 walk 完成后刷新,跨进程复用。
 *
 * 零重依赖(只用 node:fs/crypto/path):gateway 的 sense-root-gate 可静态 import,
 * 不会把 ts-morph/engine 拉进启动路径。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 索引目录:<root>/.genie/sense-index/<sha1(root) 前 12 位>。 */
export function indexDir(root: string): string {
  const h = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return join(root, ".genie", "sense-index", h);
}

export interface IndexMeta {
  version: 1;
  root: string;
  builtAt: number;
  /** 构建时源文件计数(与 C2fIndex.srcCount 同口径)。 */
  srcCount?: number;
  /** 构建时源文件最大 mtimeMs(与 C2fIndex.srcMtime 同口径)。 */
  srcMtime?: number;
  nodes: number;
  edges: number;
  extractorVersion?: number;
  /** 2026-11-08 全覆盖:文件级去向计数(scanned = indexed + symbolLess + skipped + error)。 */
  fileStatus?: { scanned: number; indexed: number; symbolLess: number; skipped: number; error: number };
}

export interface FingerprintRecord {
  /** 本次完整 walk 的完成时刻(不是开始时点)。 */
  at: number;
  count: number;
  maxMtime: number;
}

export function indexMetaPath(root: string): string {
  return join(indexDir(root), "meta.json");
}

export function fingerprintRecordPath(root: string): string {
  return join(indexDir(root), "fp.json");
}

function readJson<T>(p: string, ok: (v: unknown) => v is T): T | null {
  if (!existsSync(p)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(p, "utf-8"));
    return ok(v) ? v : null;
  } catch {
    return null;
  }
}

function isMeta(v: unknown): v is IndexMeta {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && typeof o.root === "string" && typeof o.builtAt === "number"
    && typeof o.nodes === "number" && typeof o.edges === "number";
}

function isFp(v: unknown): v is FingerprintRecord {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.at === "number" && typeof o.count === "number" && typeof o.maxMtime === "number"
    && Number.isFinite(o.at) && Number.isFinite(o.count) && Number.isFinite(o.maxMtime);
}

/** 读构建元数据(小文件;缺席/损坏=null,调用方降级)。 */
export function readIndexMeta(root: string): IndexMeta | null {
  return readJson(indexMetaPath(root), isMeta);
}

/** 写构建元数据(失败容忍:元数据是加速件,不影响索引本身)。 */
export function writeIndexMeta(root: string, meta: IndexMeta): void {
  try {
    mkdirSync(indexDir(root), { recursive: true });
    writeFileSync(indexMetaPath(root), JSON.stringify(meta));
  } catch {
    /* 只读盘/权限异常:静默降级(下次构建重试) */
  }
}

/** 读最近一次完整指纹(冷启动即用;缺席=从未有人完整走过,调用方按未知处理)。 */
export function readFingerprintRecord(root: string): FingerprintRecord | null {
  return readJson(fingerprintRecordPath(root), isFp);
}

/** 写完整指纹(只由完成全部目录 walk 的路径调用;失败容忍)。 */
export function writeFingerprintRecord(root: string, rec: FingerprintRecord): void {
  try {
    mkdirSync(indexDir(root), { recursive: true });
    writeFileSync(fingerprintRecordPath(root), JSON.stringify(rec));
  } catch {
    /* 同上 */
  }
}