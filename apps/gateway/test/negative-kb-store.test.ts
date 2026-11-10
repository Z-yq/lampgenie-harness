/**
 * 负面知识库持久层(RSI #215):记账幂等 / 召回 / 注入预算 / 翻案 / 过期 / 列表过滤 /
 * 放弃会话推断 / 报表计数 / 坏行容忍 / 行重建。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AbandonSession, RecordDeadEndInput } from "@lampgenie/runtime/agent/negative-knowledge";
import {
  expire,
  inject,
  listDeadEnds,
  loadDeadEnds,
  negativeKbPath,
  recordDeadEnd,
  reportNegative,
  retrieve,
  revive,
  suggest,
} from "../src/negative-kb-store";

const MODULE = "packages/harness-runtime/src/agent";
const tempDirs: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "negkb-store-"));
  tempDirs.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function input(plan: string, extra: Partial<RecordDeadEndInput> = {}): RecordDeadEndInput {
  return {
    plan,
    context: { module: MODULE },
    failureEvidence: [{ kind: "error", detail: `${plan} 抛 EACCES`, at: 1_700_000_000_000 }],
    scope: { keywords: ["eacces"], module: MODULE },
    ...extra,
  };
}

async function lineCount(root: string): Promise<number> {
  try {
    const text = await readFile(negativeKbPath(root), "utf8");
    return text.split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

describe("recordDeadEnd", () => {
  it("记一条死路:落盘一行 record 行并回记录", async () => {
    const root = await freshRoot();
    const result = recordDeadEnd(root, input("给 sense 索引加 inotify 增量化"));
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("NEGKB_RECORDED");
    expect(result.record?.status).toBe("active");
    expect(result.record?.confidence).toBeGreaterThan(0);
    expect(await lineCount(root)).toBe(1);
    const reloaded = loadDeadEnds(root).records.get(result.record!.id);
    expect(reloaded?.plan).toBe(result.record?.plan);
  });

  it("幂等:同 plan 同 scope 重复记账回 DUPLICATE 且不重复写行", async () => {
    const root = await freshRoot();
    const first = recordDeadEnd(root, input("给 sense 索引加 inotify 增量化"));
    const second = recordDeadEnd(root, input("给 sense 索引加 inotify 增量化"));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.codes).toContain("NEGKB_DUPLICATE");
    expect(second.record?.id).toBe(first.record?.id);
    expect(await lineCount(root)).toBe(1);
  });

  it("缺失败证据 → INVALID 且不写盘", async () => {
    const root = await freshRoot();
    const result = recordDeadEnd(root, { plan: "只有猜测没有证据" });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("NEGKB_INVALID");
    expect(await lineCount(root)).toBe(0);
  });
});

describe("retrieve / inject", () => {
  it("召回:关键词+module 命中并带 reasons 与替代", async () => {
    const root = await freshRoot();
    const recorded = recordDeadEnd(
      root,
      input("给 sense 索引加 inotify 增量化", { alternative: "改用全量重建 + 哈希短路" }),
    );
    const result = retrieve(root, { planText: "sense 索引 inotify 增量化", module: MODULE, keywords: ["inotify"] });
    expect(result.codes).toContain("NEGKB_MATCH");
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].record.id).toBe(recorded.record!.id);
    expect(result.hits[0].reasons.length).toBeGreaterThan(0);
    expect(result.hits[0].alternative).toBe("改用全量重建 + 哈希短路");
  });

  it("召回:无关查询返回空且码为 NO_MATCH(不抛异常)", async () => {
    const root = await freshRoot();
    recordDeadEnd(root, input("给 sense 索引加 inotify 增量化"));
    const result = retrieve(root, { planText: "完全无关的董事会 PPT 排版", module: "apps/unknown" });
    expect(result.hits).toEqual([]);
    expect(result.codes).toContain("NEGKB_NO_MATCH");
    expect(retrieve(await freshRoot(), { planText: "空账本" }).hits).toEqual([]);
  });

  it("注入:块格式为「此路不通|原因|替代」,maxChars 预算生效", async () => {
    const root = await freshRoot();
    recordDeadEnd(root, input("给 sense 索引加 inotify 增量化", { alternative: "改用全量重建" }));
    recordDeadEnd(root, input("用 tree-sitter 直接解析 tsx 做调用图", { scope: { keywords: ["tree-sitter"] } }));
    const wide = inject(root, { planText: "sense 索引 inotify", module: MODULE, keywords: ["inotify", "tree-sitter"] }, {
      maxChars: 10_000,
    });
    expect(wide.blocks.length).toBe(2);
    expect(wide.blocks[0]).toMatch(/^此路不通:.+\|原因:.+\|替代:/);
    expect(wide.blocks.some((block) => block.includes("|替代:改用全量重建"))).toBe(true);
    expect(wide.blocks.some((block) => block.includes("|替代:暂无"))).toBe(true);

    const tight = inject(root, { planText: "sense 索引 inotify", module: MODULE, keywords: ["inotify", "tree-sitter"] }, {
      maxChars: 1,
    });
    expect(tight.blocks.length).toBe(1);
  });
});

describe("revive / expire", () => {
  it("翻案:status 变 revived 且 corrections +1、expiresAt 清空", async () => {
    const root = await freshRoot();
    const recorded = recordDeadEnd(root, input("旧方案", { expiresAt: 2_000_000_000_000 }));
    const result = revive(root, recorded.record!.id, { by: "rsi", reason: "依赖升级了", newEvidence: "pnpm 装上了 inotify 包" });
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("NEGKB_REVIVED");
    expect(result.record?.status).toBe("revived");
    expect(result.record?.corrections.length).toBe(1);
    expect(result.record?.corrections[0].by).toBe("rsi");
    expect(result.record?.expiresAt).toBeUndefined();
    const listed = listDeadEnds(root).find((record) => record.id === recorded.record!.id);
    expect(listed?.status).toBe("revived");
    expect(listed?.corrections.length).toBe(1);
  });

  it("翻案:不存在的 id → NEGKB_NOT_FOUND 且不写盘", async () => {
    const root = await freshRoot();
    recordDeadEnd(root, input("旧方案"));
    const before = await lineCount(root);
    const result = revive(root, "deadbeefdeadbeef", { by: "rsi", reason: "手滑" });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("NEGKB_NOT_FOUND");
    expect(await lineCount(root)).toBe(before);
  });

  it("重复翻案 → ALREADY_REVIVED 且不再追加行", async () => {
    const root = await freshRoot();
    const recorded = recordDeadEnd(root, input("旧方案"));
    revive(root, recorded.record!.id, { by: "rsi", reason: "第一次" });
    const before = await lineCount(root);
    const again = revive(root, recorded.record!.id, { by: "rsi", reason: "第二次" });
    expect(again.ok).toBe(false);
    expect(again.codes).toContain("NEGKB_ALREADY_REVIVED");
    expect(await lineCount(root)).toBe(before);
    expect(listDeadEnds(root)[0].corrections.length).toBe(1);
  });

  it("过期:expiresAt 已过的条被 expire 标掉,之后召回不再返回", async () => {
    const root = await freshRoot();
    const deadline = Date.now() + 3_600_000;
    const recorded = recordDeadEnd(root, input("带期限的死路", { expiresAt: deadline }));
    expect(retrieve(root, { planText: "带期限的死路", module: MODULE }).hits.length).toBe(1);
    const result = expire(root, deadline + 1);
    expect(result.expired).toEqual([recorded.record!.id]);
    expect(result.parseErrors).toBe(0);
    expect(await lineCount(root)).toBe(2);
    expect(retrieve(root, { planText: "带期限的死路", module: MODULE }).hits).toEqual([]);
    expect(listDeadEnds(root)[0].status).toBe("expired");
    // 再扫一次:已 expired 的不重复列出、不追加行
    expect(expire(root, 3_000).expired).toEqual([]);
    expect(await lineCount(root)).toBe(2);
  });
});

describe("list / suggest / report", () => {
  it("list 按 status 过滤且 createdAt 升序", async () => {
    const root = await freshRoot();
    const a = recordDeadEnd(root, input("死路 A", { createdAt: 300 }));
    const b = recordDeadEnd(root, input("死路 B", { createdAt: 100 }));
    expire(root, 1_000); // 两条都没 expiresAt,不过期
    revive(root, b.record!.id, { by: "rsi", reason: "翻案" });
    expect(listDeadEnds(root, { status: "active" }).map((record) => record.id)).toEqual([a.record!.id]);
    expect(listDeadEnds(root, { status: "revived" }).map((record) => record.id)).toEqual([b.record!.id]);
    expect(listDeadEnds(root).map((record) => record.id)).toEqual([b.record!.id, a.record!.id]);
  });

  it("suggest:两个 session 放弃同方案 → 生成候选并落盘,再跑幂等", async () => {
    const root = await freshRoot();
    const sessions: AbandonSession[] = [
      { planText: "用 playwright 抓 inner 浏览器快照", module: MODULE, abandoned: true, reason: "超时", at: 1_000 },
      { planText: "用 playwright 抓 inner 浏览器快照", module: MODULE, abandoned: true, reason: "再次超时", at: 2_000 },
      { planText: "只放弃一次不算", module: MODULE, abandoned: true, at: 3_000 },
      { planText: "用 playwright 抓 inner 浏览器快照", module: MODULE, abandoned: false, at: 4_000 },
    ];
    const first = suggest(root, sessions);
    expect(first.codes).toContain("NEGKB_RECORDED");
    expect(first.candidates.length).toBe(1);
    expect(first.candidates[0].failureEvidence.length).toBe(2);
    expect(first.candidates[0].confidence).toBeCloseTo(0.7, 5);
    expect(await lineCount(root)).toBe(1);

    const again = suggest(root, sessions);
    expect(again.candidates).toEqual([]);
    expect(again.codes).toContain("NEGKB_DUPLICATE");
    expect(await lineCount(root)).toBe(1);
  });

  it("report 计数:total/active/revived/expired/hits/坏行/有替代", async () => {
    const root = await freshRoot();
    const live = recordDeadEnd(root, input("存活死路", { alternative: "换 B 方案" }));
    const toExpire = recordDeadEnd(root, input("将过期死路", { expiresAt: 1_000 }));
    const toRevive = recordDeadEnd(root, input("将翻案死路"));
    expire(root, 2_000);
    revive(root, toRevive.record!.id, { by: "rsi", reason: "环境变了" });

    const report = reportNegative(root);
    expect(report.total).toBe(3);
    expect(report.expired).toBe(1);
    expect(report.revived).toBe(1);
    expect(report.active).toBe(1);
    expect(report.hits).toBe(2); // live + toRevive(expired 的不算)
    expect(report.withAlternative).toBe(1);
    expect(report.parseErrors).toBe(0);
    expect(report.totalLines).toBe(5); // 3 record + 1 expire + 1 revive
    expect(listDeadEnds(root).find((record) => record.id === toExpire.record!.id)?.status).toBe("expired");
    expect(live.record!.id).not.toBe(toExpire.record!.id);
  });
});

describe("坏行与重建", () => {
  it("坏行跳过:非法 JSON / v 错 / type 未知 / 缺 record 只计 parseErrors,不 throw", async () => {
    const root = await freshRoot();
    const recorded = recordDeadEnd(root, input("好行"));
    const path = negativeKbPath(root);
    await appendFile(path, "这不是 JSON\n", "utf8");
    await appendFile(path, `${JSON.stringify({ v: 2, type: "record", at: 1, record: recorded.record })}\n`, "utf8");
    await appendFile(path, `${JSON.stringify({ v: 1, type: "weird", at: 1, id: "x" })}\n`, "utf8");
    await appendFile(path, `${JSON.stringify({ v: 1, type: "record", at: 1 })}\n`, "utf8");
    await appendFile(path, `${JSON.stringify({ v: 1, type: "revive", at: 1, id: "orphan-no-record", by: "rsi", reason: "孤儿" })}\n`, "utf8");

    const projection = loadDeadEnds(root);
    expect(projection.parseErrors).toBe(4);
    expect(projection.totalLines).toBe(6);
    expect(projection.records.size).toBe(1);
    expect(projection.records.get(recorded.record!.id)?.status).toBe("active");
    // 坏行也不影响后续写入的判重
    expect(recordDeadEnd(root, input("好行")).codes).toContain("NEGKB_DUPLICATE");
  });

  it("revive 行重建后 corrections 保留(每次 load 都从行序重放)", async () => {
    const root = await freshRoot();
    const recorded = recordDeadEnd(root, input("会被翻案的死路"));
    revive(root, recorded.record!.id, { by: "rsi", reason: "新证据到位", newEvidence: "包已安装" });

    const first = loadDeadEnds(root).records.get(recorded.record!.id);
    const second = loadDeadEnds(root).records.get(recorded.record!.id);
    expect(first?.status).toBe("revived");
    expect(first?.corrections.length).toBe(1);
    expect(first?.corrections[0].reason).toBe("新证据到位");
    expect(first?.corrections[0].newEvidence).toBe("包已安装");
    expect(second?.corrections).toEqual(first?.corrections);
    expect(await lineCount(root)).toBe(2);
  });
});
