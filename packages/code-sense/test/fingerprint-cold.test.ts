/**
 * 指纹冷路径禁同步(2026-10-30 冻结收割 ×2 实锤):srcFingerprintCached 无缓存/无盘上指纹时返回
 * null,绝不同步全仓 stat——worker 是每任务新进程,首个 code_sense/indexStale 必走冷路径,9p
 * 停顿下同步扫全仓把事件循环冻 200s+(心跳停=worker 被判死)。
 *
 * 2026-11-08 修正(7700 审计):旧语义「指纹未知 → 暂不过期」让索引静默陈旧 8 天(异步指纹 2s
 * 预算在 9p 上永远走不完,缓存永不落盘)。现在冷路径三层:
 *  ① 内存缓存 → ② 盘上 fp.json(上次完整 walk 的结论)→ ③ null;
 *  null 时 indexStale 只信任「构建时间足够新」的索引,超龄(GENIE_SENSE_MAX_INDEX_AGE_MS,默认 1h)
 *  判过期并触发一次后台重建。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { srcFingerprintCached, indexStale, srcFingerprint, indexDir, type C2fIndex } from "../src/callgraph/c2f";

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-fpcold-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("指纹冷路径(2026-10-30 冻结治理 + 2026-11-08 有界盲窗)", () => {
  it("无缓存根:srcFingerprintCached 返回 null(不同步扫),同步版仍可用", () => {
    const r = tmp();
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    // 冷路径:该根从未指纹过(每测唯一 tmp 根)=null,且立即返回(无全仓同步 stat)
    expect(srcFingerprintCached(r)).toBeNull();
    // 同步版本照常(构建收口/测试断言路径专用)
    const sync = srcFingerprint(r);
    expect(sync.count).toBe(1);
    // 同步版顺手入了内存+盘上指纹:此后 cached 档返回具体值(新进程也能直接复用)
    const cached = srcFingerprintCached(r);
    expect(cached).not.toBeNull();
    expect(cached!.count).toBe(1);
  });

  it("indexStale 无指纹:新建索引可信;超龄索引判过期(不再永久「暂不过期」)", () => {
    const r = tmp();
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    // srcMtime 取未来值:即使异步指纹落地(maxMtime≈now)也不会误判过期
    const base = { root: r, nodes: [], edges: [], headSha: "", srcMtime: Date.now() + 10_000, srcCount: 1 };
    const fresh = { ...base, builtAt: Date.now() } as unknown as C2fIndex;
    expect(indexStale(r, fresh)).toBe(false); // 构建够新:无可判据时不制造重建 churn
    const aged = { ...base, srcMtime: 0, builtAt: Date.now() - 2 * 60 * 60 * 1000 } as unknown as C2fIndex;
    expect(indexStale(r, aged)).toBe(true); // 超龄(默认 1h)+ 源文件确实更新 → 过期
  });

  it("冷启动读盘上 fp.json:无需重扫即可判过期(9p 7.5s walk 不阻塞查询)", () => {
    const r = tmp();
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    const dir = indexDir(r);
    mkdirSync(dir, { recursive: true });
    const newer = Date.now() - 1_000;
    writeFileSync(join(dir, "fp.json"), JSON.stringify({ at: Date.now(), count: 1, maxMtime: newer }));
    const idx = {
      root: r, nodes: [], edges: [], headSha: "",
      srcMtime: newer - 60_000, srcCount: 1, builtAt: Date.now(),
    } as unknown as C2fIndex;
    // 指纹来自盘上记录(本进程没走过 walk):maxMtime 越过 srcMtime → 过期
    expect(indexStale(r, idx)).toBe(true);
  });

  it("指纹入缓存后判准确:轮询至异步 walk 完成(小目录毫秒级)", async () => {
    const r = tmp();
    writeFileSync(join(r, "a.ts"), "export const x = 1;\n");
    const idx = { root: r, nodes: [], edges: [], headSha: "", srcMtime: 0, srcCount: 1, builtAt: Date.now() } as unknown as C2fIndex;
    // 首次:无指纹、索引够新 → 暂信(不阻塞)
    expect(indexStale(r, idx)).toBe(false);
    let fp: { count: number; maxMtime: number; at?: number } | null = null;
    for (let i = 0; i < 40 && !fp; i++) {
      fp = srcFingerprintCached(r);
      if (!fp) await new Promise((res) => setTimeout(res, 100));
    }
    expect(fp).not.toBeNull();
    expect(indexStale(r, idx)).toBe(true); // 现在能看见真过期
  });
});