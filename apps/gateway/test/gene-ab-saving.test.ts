/**
 * 基因灰度 A/B 节省采集器测试(P0 saving 采集器):
 * - 纯函数:双臂 token 均值差 × 处理臂会话数 = 节省;样本不足/无效应如实返回 codes;
 * - 会话分类:shown 优先于 held(与 nightly A/B note 同口径),无 token 的会话不计;
 * - recorder:从 session-stats 合并读、同日幂等、cost.jsonl 落 mechanismId=geneAb 的 saving 行。
 */
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { geneAbSavingsFromSessions, recordGeneAbSavings } from "../src/rsi-second-half";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-gene-ab-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function session(id: string, inputTokens: number, arm: "shown" | "held" | "both"): Record<string, unknown> {
  return {
    sessionId: id,
    inputTokens,
    ...(arm === "shown" || arm === "both" ? { geneBriefShown: true } : {}),
    ...(arm === "held" || arm === "both" ? { geneBriefHeld: true } : {}),
  };
}

describe("geneAbSavingsFromSessions(纯函数)", () => {
  it("3 vs 3、held 均值高 20k → 节省 60k;method 带两臂均值", () => {
    const result = geneAbSavingsFromSessions([
      session("s1", 100_000, "shown"),
      session("s2", 100_000, "shown"),
      session("s3", 100_000, "shown"),
      session("h1", 120_000, "held"),
      session("h2", 120_000, "held"),
      session("h3", 120_000, "held"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.saving).toBe(60_000);
    expect(result.shown).toEqual({ count: 3, tokens: 300_000 });
    expect(result.held).toEqual({ count: 3, tokens: 360_000 });
    expect(result.method).toContain("heldAvg 120000");
    expect(result.method).toContain("shownAvg 100000");
    expect(result.evidence).toContain("geneAB:shown=3 held=3");
    expect(result.evidence).toContain("shown:s1");
    expect(result.evidence).toContain("held:h1");
  });

  it("任一愣臂不足 3 → GENE_AB_INSUFFICIENT,不产生数字", () => {
    const result = geneAbSavingsFromSessions([
      session("s1", 100_000, "shown"),
      session("s2", 100_000, "shown"),
      session("h1", 120_000, "held"),
      session("h2", 120_000, "held"),
      session("h3", 120_000, "held"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.saving).toBe(0);
    expect(result.codes).toContain("GENE_AB_INSUFFICIENT");
  });

  it("处理臂不省(shown ≥ held)→ GENE_AB_NO_EFFECT", () => {
    const result = geneAbSavingsFromSessions([
      session("s1", 130_000, "shown"),
      session("s2", 130_000, "shown"),
      session("s3", 130_000, "shown"),
      session("h1", 120_000, "held"),
      session("h2", 120_000, "held"),
      session("h3", 120_000, "held"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("GENE_AB_NO_EFFECT");
  });

  it("shown 优先:双标记会话算处理臂;无 token 会话不计", () => {
    const result = geneAbSavingsFromSessions([
      session("s1", 100_000, "both"),
      session("s2", 100_000, "shown"),
      session("s3", 0, "shown"), // 无 token → 不计
      session("s4", 100_000, "shown"),
      session("h1", 120_000, "held"),
      session("h2", 120_000, "held"),
      session("h3", 120_000, "held"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.shown.count).toBe(3); // s1+s2+s4
    expect(result.saving).toBe(60_000);
  });
});

describe("recordGeneAbSavings(从 session-stats 合并 + 幂等)", () => {
  async function writeStats(root: string, file: string, sessions: unknown[]): Promise<void> {
    const dir = join(root, ".genie", "rsi", "nightly", "lampgenie-harness");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), JSON.stringify({ generatedAt: "2026-11-20T00:00:00.000Z", sessions }, null, 2));
  }

  it("落 saving 行(mechanismId=geneAb);同日二次调用幂等", async () => {
    const root = await tmpRoot();
    await writeStats(root, "2026-11-19.session-stats.json", [
      session("s1", 100_000, "shown"),
      session("s2", 100_000, "shown"),
      session("h1", 120_000, "held"),
    ]);
    await writeStats(root, "2026-11-20.session-stats.json", [
      session("s3", 100_000, "shown"),
      session("h2", 120_000, "held"),
      session("h3", 120_000, "held"),
    ]);
    const first = recordGeneAbSavings(root, { now: Date.parse("2026-11-20T12:00:00Z") });
    expect(first.entries).toBe(1);
    expect(first.tokensSaved).toBe(60_000); // 3 shown @100k vs 3 held @120k
    const text = await readFile(join(root, ".genie", "rsi", "cost.jsonl"), "utf8");
    const row = JSON.parse(text.split("\n").filter(Boolean)[0]!);
    expect(row.type).toBe("saving");
    expect(row.mechanismId).toBe("geneAb");
    expect(row.tokensSaved).toBe(60_000);
 // 幂等:同数据再跑 → 不追加
    const second = recordGeneAbSavings(root, { now: Date.parse("2026-11-20T13:00:00Z") });
    expect(second.entries).toBe(0);
    expect(second.codes).toContain("SECOND_HALF_GENE_AB_DUPLICATE");
    const lines = (await readFile(join(root, ".genie", "rsi", "cost.jsonl"), "utf8")).split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it("样本不足 → 零入账,method 如实", async () => {
    const root = await tmpRoot();
    await writeStats(root, "2026-11-20.session-stats.json", [
      session("s1", 100_000, "shown"),
      session("h1", 120_000, "held"),
    ]);
    const out = recordGeneAbSavings(root, { now: Date.parse("2026-11-20T12:00:00Z") });
    expect(out.entries).toBe(0);
    expect(out.method).toContain("insufficient");
    expect(out.codes).toContain("GENE_AB_INSUFFICIENT");
    await expect(readFile(join(root, ".genie", "rsi", "cost.jsonl"), "utf8")).rejects.toBeTruthy();
  });
});