/**
 * llm-trace 保留策略(P1-A:pruneLlmTrace)。
 * 为什么这样测:.genie/llm-trace 此前无界增长(每次 chat 一份全量 request.messages 文件,
 * O(steps²) 近重复)。清理器是旁路,它的两条硬性质必须钉死,否则要么磁盘失控、要么把
 * 「最新轨迹」删掉导致排障时看不到现场:
 * ①每 session 只留最近 N=200 份,**删的是 epochMs 最小的**(文件名末段毫秒);
 * ②目录不存在/不可读时不抛(resolve 即可)——清理失败绝不影响主链。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_KEEP_PER_SESSION, pruneLlmTrace } from "../src/llm-trace-retention.js";

/** 造 n 个轨迹文件(epochMs 从 base 递增,模拟写盘时间序)。 */
function seed(dir: string, session: string, n: number, base = 1_700_000_000_000): number[] {
  const d = join(dir, session);
  mkdirSync(d, { recursive: true });
  const epochs: number[] = [];
  for (let i = 0; i < n; i++) {
    const epoch = base + i * 1000;
    epochs.push(epoch);
    const name = `call-${String(i + 1).padStart(4, "0")}-t1s0-${epoch}.json`;
    writeFileSync(join(d, name), JSON.stringify({ i }), "utf-8");
  }
  return epochs;
}

const epochOfName = (name: string): number => Number(/-(\d+)\.json$/.exec(name)?.[1] ?? 0);

describe("pruneLlmTrace(P1-A 保留策略)", () => {
  it("250 份 → 只留默认 200 份,且留下的是 epochMs 最大的 200 份", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-prune-"));
    try {
      const epochs = seed(root, "web-a", 250);
      const r = await pruneLlmTrace(root);
      expect(r.removed).toBe(50);
      const left = readdirSync(join(root, "web-a")).map(epochOfName).sort((a, b) => a - b);
      expect(left.length).toBe(DEFAULT_KEEP_PER_SESSION);
      expect(DEFAULT_KEEP_PER_SESSION).toBe(200);
      // 留下的 = 最大的 200 个 epoch(即 epochs[50..249])
      expect(left[0]).toBe(epochs[50]);
      expect(left[left.length - 1]).toBe(epochs[249]);
      // 被删的确实是最老的一批
      expect(left).not.toContain(epochs[0]);
      expect(left).not.toContain(epochs[49]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("多个 session 各自独立计数(不串删另一会话的 200 份)", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-prune-multi-"));
    try {
      seed(root, "web-a", 30);
      seed(root, "web-b", 210);
      const r = await pruneLlmTrace(root);
      expect(r.removed).toBe(10);
      expect(readdirSync(join(root, "web-a")).length).toBe(30);
      expect(readdirSync(join(root, "web-b")).length).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("负面:目录不存在 → resolve 不抛,返回 {removed:0}", async () => {
    const missing = join(tmpdir(), "trace-prune-not-exist-" + Date.now());
    await expect(pruneLlmTrace(missing)).resolves.toEqual({ removed: 0, kept: 0 });
  });
});
