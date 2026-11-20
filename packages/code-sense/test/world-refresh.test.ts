/**
 * world 产物同代刷新测试:saveIndex 尾部挂钩 refreshWorldAfterSave。
 * A 同代:saveIndex 后 world/manifest.json 在场、fp.builtAt===idx.builtAt、skeleton 非空、
 * drill.json.indexBuiltAt===idx.builtAt;
 * B env 闸:GENIE_WORLD_AUTOREFRESH=0 → 全新根 saveIndex 后 world 目录不存在;
 * C fail-open:<indexDir>/world 预占为普通文件(mkdirSync 必炸)→ saveIndex 不抛、index.json 照常落盘;
 * D 直调 refreshWorldAfterSave 同障碍 → ok:false 带 error,不抛。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildC2fIndex, saveIndex, indexDir, type C2fIndex } from "../src/callgraph/c2f";
import { refreshWorldAfterSave, type WorldRefreshResult } from "../src/world/refresh";
import { worldDir, worldSkeletonPath, readWorldManifest, readDrillCorpus } from "../src/world/store";

let ws = "";
let index: C2fIndex;
const extraRoots: string[] = [];
const envBackup = process.env.GENIE_WORLD_AUTOREFRESH;

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "csworld-refresh-"));
  mkdirSync(join(ws, "core"), { recursive: true });
  writeFileSync(join(ws, "core", "util.ts"), [
    'export function coreUtil(x: number): string { return "v" + x; }',
    "",
  ].join("\n"));
  writeFileSync(join(ws, "main.ts"), [
    'import { coreUtil } from "./core/util";',
    "export function runApp(): string { return coreUtil(1); }",
    "",
  ].join("\n"));
  index = await buildC2fIndex(ws);
}, 60_000);

afterAll(() => {
  if (ws) rmSync(ws, { recursive: true, force: true });
  for (const r of extraRoots) rmSync(r, { recursive: true, force: true });
});

afterEach(() => {
  if (envBackup === undefined) delete process.env.GENIE_WORLD_AUTOREFRESH;
  else process.env.GENIE_WORLD_AUTOREFRESH = envBackup;
});

function freshRoot(prefix: string): string {
  const r = mkdtempSync(join(tmpdir(), prefix));
  extraRoots.push(r);
  return r;
}

/** 把 <indexDir>/world 预占为普通文件:writeWorldArtifact 的 mkdirSync 必炸。 */
function blockWorldDir(root: string): void {
  mkdirSync(indexDir(root), { recursive: true });
  writeFileSync(join(indexDir(root), "world"), "blocker", "utf-8");
}

describe("world 同代刷新 · saveIndex 挂钩", () => {
  it("A 同代:saveIndex 后 manifest/skeleton/drill 在场且指纹与 idx.builtAt 同代", () => {
    const p = saveIndex(ws, index);
    expect(p).toBe(join(indexDir(ws), "index.json"));
    expect(existsSync(join(worldDir(ws), "manifest.json"))).toBe(true);
    const m = readWorldManifest(ws);
    expect(m).not.toBeNull();
    expect(m!.fp.builtAt).toBe(index.builtAt);
    const skeleton = readFileSync(worldSkeletonPath(ws), "utf-8");
    expect(skeleton.length).toBeGreaterThan(0);
    const corpus = readDrillCorpus(ws);
    expect(corpus).not.toBeNull();
    expect(corpus!.indexBuiltAt).toBe(index.builtAt);
  });

  it("B env 闸:GENIE_WORLD_AUTOREFRESH=0 → world 目录不写", () => {
    const root = freshRoot("csworld-refresh-gate-");
    process.env.GENIE_WORLD_AUTOREFRESH = "0";
    const p = saveIndex(root, index);
    expect(existsSync(p)).toBe(true);
    expect(existsSync(worldDir(root))).toBe(false);
  });

  it("C fail-open:world 路径被普通文件占位 → saveIndex 不抛、index.json 照常落盘", () => {
    const root = freshRoot("csworld-refresh-block-");
    blockWorldDir(root);
    let p = "";
    expect(() => { p = saveIndex(root, index); }).not.toThrow();
    expect(p).toBe(join(indexDir(root), "index.json"));
    expect(existsSync(p)).toBe(true);
  });

  it("D 直调 refreshWorldAfterSave 同障碍 → ok:false 带 error,不抛", () => {
    const root = freshRoot("csworld-refresh-direct-");
    blockWorldDir(root);
    let r: WorldRefreshResult | undefined;
    expect(() => { r = refreshWorldAfterSave(root, index); }).not.toThrow();
    expect(r!.ok).toBe(false);
    expect(typeof r!.error).toBe("string");
    expect(r!.error!.length).toBeGreaterThan(0);
  });
});
