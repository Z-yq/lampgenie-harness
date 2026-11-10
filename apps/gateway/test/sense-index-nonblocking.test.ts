/**
 * 索引查询不阻塞派发(2026-10-20 实锤回归 + 2026-11-03 首查等待新契约):
 * 旧 `codeIndexQuery` 在无索引时 `await ensureIndex`——大工作区(/mnt/e/workship/genie)
 * 冷构建 7+ 分钟且 OOM 崩溃,10 路子代理派遣全部堵在这里,解封后同时首调 LLM 造成
 * 建连洪峰(8/10 fetch failed)。
 * 2026-11-03 首查体验:未索引子仓的首查改为**轮询等待**(500ms 间隔让出事件循环,构建在
 * detached worker 进程——网关主循环零阻塞;上限 GENIE_SENSE_INDEX_WAIT_MS,默认 30s):
 *  - 等待开启(默认):首查在上限内等到构建落地 → 直接返回真实结果,不再回「稍后再试」死路;
 *  - 等待关闭(GENIE_SENSE_INDEX_WAIT_MS=0):立即回「尚未就绪」,构建后台继续(洪峰回归保护)。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex } from "@lampgenie/code-sense";
import { codeIndexQuery, ensureIndex, getIndexBestEffort } from "../src/sense-index-manager.js";

const tmps: string[] = [];
function mkroot(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `gh-idx-nonblock-${tag}-`));
  tmps.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "export function probeFn(){ return 1 }\n", "utf-8");
  return d;
}
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
}, 60_000);

describe("codeIndexQuery 冷索引", () => {
  it("等待关闭(WAIT_MS=0):立即返回「尚未就绪」(<1500ms),同时后台构建被触发并最终可查", async () => {
    const prev = process.env.GENIE_SENSE_INDEX_WAIT_MS;
    process.env.GENIE_SENSE_INDEX_WAIT_MS = "0";
    try {
      const root = mkroot("nowait");
      expect(getIndexBestEffort(root).index).toBeNull();

      const t0 = Date.now();
      const out = await codeIndexQuery(root, "symbol", "probeFn");
      const elapsed = Date.now() - t0;
      expect(out).toContain("尚未就绪");
      expect(elapsed).toBeLessThan(1500);

      // 后台构建仍在推进:等它落地后同一查询命中符号。
      const idx = await ensureIndex(root).catch(() => null);
      expect(idx).toBeTruthy();
      expect(loadIndex(root)).toBeTruthy();
      const hit = await codeIndexQuery(root, "symbol", "probeFn");
      expect(hit).toContain("probeFn");
    } finally {
      if (prev === undefined) delete process.env.GENIE_SENSE_INDEX_WAIT_MS;
      else process.env.GENIE_SENSE_INDEX_WAIT_MS = prev;
    }
  }, 60_000);

  it("首查等待(默认开启):上限内等到真实结果而非「稍后再试」;等待让出事件循环", async () => {
    const prev = process.env.GENIE_SENSE_INDEX_WAIT_MS;
    process.env.GENIE_SENSE_INDEX_WAIT_MS = "90_000";
    try {
      const root = mkroot("wait");
      expect(getIndexBestEffort(root).index).toBeNull();
      // 等待期间事件循环必须活着(轮询让出,不是同步阻塞):构建进行中 setInterval 仍准时触发。
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 250);
      const t0 = Date.now();
      const out = await codeIndexQuery(root, "symbol", "probeFn");
      const elapsed = Date.now() - t0;
      clearInterval(timer);
      // 核心断言:不再是「稍后再试」死路,直接拿到真实结果。
      expect(out).toContain("probeFn");
      expect(out).not.toContain("尚未就绪");
      expect(elapsed).toBeLessThan(90_000);
      expect(ticks).toBeGreaterThan(3); // 事件循环未被构建卡死
    } finally {
      if (prev === undefined) delete process.env.GENIE_SENSE_INDEX_WAIT_MS;
      else process.env.GENIE_SENSE_INDEX_WAIT_MS = prev;
    }
  }, 150_000);
});
