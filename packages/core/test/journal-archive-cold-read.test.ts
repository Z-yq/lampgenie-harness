/**
 * 归档冷读开关:归档目录只作显式读的兜底,boot 期内部回读不得碰它。
 * 经验证背景:归档 70 文件/422MB 后,某次 boot 期内部 readSession 把 29 个 archive 文件逐个 parse,
 * 进程 6 分钟仍在装配——归档收益被 boot 期冷读抵消。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "../src/journal/journal.js";

const mk = (name: string) => mkdtempSync(join(tmpdir(), name));
const tick = () => new Promise((r) => setTimeout(r, 25));

interface Seeded {
  journalDir: string;
  archiveDir: string;
  sid: string;
  archivedPath: string;
}

/** 造「会话已归档」现场:sid 有一条跨会话事件留 global(使新实例索引里仍有该 sid),
 *  两条会话域事件写进 sessions/<sid>.jsonl 后 rename 到 sessions-archive/。 */
function seedArchived(root: string, sid = "sArch"): Seeded {
  const journalDir = join(root, "journals");
  mkdirSync(journalDir, { recursive: true });
  const fp = join(journalDir, "gateway.jsonl");
  const j = new FileJournal(fp, { writeBehind: true, sharded: true });
  j.append({ kind: "task.start", sessionId: sid, payload: { t: 1 } });          // 跨会话 → global.jsonl
  j.append({ kind: "message.user", sessionId: sid, payload: { text: "a1" } });  // 会话域 → sessions/<sid>.jsonl
  j.append({ kind: "message.agent", sessionId: sid, payload: { text: "a2" } });
  j.flush();
  const archiveDir = join(journalDir, "sessions-archive");
  mkdirSync(archiveDir, { recursive: true });
  const archivedPath = join(archiveDir, `${sid}.jsonl`);
  renameSync(join(journalDir, "sessions", `${sid}.jsonl`), archivedPath);
  return { journalDir, archiveDir, sid, archivedPath };
}

/** 打桩 private parseFile,记录所有被解析的文件路径(ESM 具名导入无法 spy readdir,
 *  用 parseFile 路径表证明「有没有去碰归档文件」)。 */
function spyParse(j: FileJournal): { paths: string[] } {
  const rec = { paths: [] as string[] };
  const inst = j as unknown as { parseFile: (p: string) => unknown };
  const orig = inst.parseFile;
  inst.parseFile = function (this: unknown, p: string) {
    rec.paths.push(p);
    return orig.call(this, p);
  };
  return rec;
}

const archivedHits = (paths: string[], archiveDir: string) => paths.filter((p) => p.startsWith(archiveDir));

describe("FileJournal 归档冷读开关", () => {
  it("archiveDir 已配置但未 enable:已归档 sid 读不到会话域事件,且从不 parse 归档文件", () => {
    const root = mk("arch-off-");
    try {
      const { journalDir, archiveDir, sid } = seedArchived(root);
      const j = new FileJournal(join(journalDir, "gateway.jsonl"), {
        writeBehind: true, sharded: true, archiveDir,
      });
      const rec = spyParse(j);
      // 新实例索引里只有 global 那句 task.start;归档里的两条消息不可见。
      const got = j.readSession(sid);
      expect(got.map((e) => e.kind)).toEqual(["task.start"]);
      expect(archivedHits(rec.paths, archiveDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enable 后同一 sid 返回归档事件(按 seq 升序,与常驻副本去重)", async () => {
    const root = mk("arch-on-");
    try {
      const { journalDir, archiveDir, sid } = seedArchived(root);
      const j = new FileJournal(join(journalDir, "gateway.jsonl"), {
        writeBehind: true, sharded: true, archiveDir,
      });
      const rec = spyParse(j);
      j.enableArchiveReads();
      const got = j.readSession(sid);
      expect(got.map((e) => e.kind)).toEqual(["task.start", "message.user", "message.agent"]);
      expect(got.map((e) => e.seq)).toEqual([...got.map((e) => e.seq)].sort((a, b) => a - b));
      expect(got.filter((e) => e.kind === "message.user").map((e) => e.payload)).toEqual([{ text: "a1" }]);
      // 幂等:重复读不再重复追加
      expect(j.readSession(sid)).toHaveLength(3);
      expect(archivedHits(rec.paths, archiveDir).length).toBeGreaterThan(0);
      await tick();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("load/loadChunked 永不扫 archive 目录(即使归档里有坏文件)", async () => {
    const root = mk("arch-load-");
    try {
      const { journalDir, archiveDir, sid } = seedArchived(root);
      // 归档目录里的坏文件:被扫到就会报坏行/被 parse——用它当「是否扫过」的哨兵。
      writeFileSync(join(archiveDir, "zz-bad.jsonl"), "{ not json\n", "utf-8");
      const fp = join(journalDir, "gateway.jsonl");

      const sync = new FileJournal(fp, { writeBehind: true, sharded: true, deferLoad: true, archiveDir });
      const recSync = spyParse(sync);
      sync.load();
      expect(sync.readSession(sid).map((e) => e.kind)).toEqual(["task.start"]);
      expect(archivedHits(recSync.paths, archiveDir)).toEqual([]);

      const chunked = new FileJournal(fp, { writeBehind: true, sharded: true, deferLoad: true, archiveDir });
      const recChunked = spyParse(chunked);
      await chunked.loadChunked();
      expect(chunked.readSession(sid).map((e) => e.kind)).toEqual(["task.start"]);
      expect(archivedHits(recChunked.paths, archiveDir)).toEqual([]);
      // 读路径也只落 sessions/<sid>.jsonl(不存在就空),没有任何路径指向 sessions-archive
      expect(recSync.paths.every((p) => !p.includes("sessions-archive"))).toBe(true);
      expect(recChunked.paths.every((p) => !p.includes("sessions-archive"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("未配置 archiveDir:enable 与否都是逐字旧行为(不读归档,不报错)", () => {
    const root = mk("arch-none-");
    try {
      const { journalDir, sid } = seedArchived(root);
      const j = new FileJournal(join(journalDir, "gateway.jsonl"), { writeBehind: true, sharded: true });
      j.enableArchiveReads(); // 无 archiveDir 时是 no-op
      expect(j.readSession(sid).map((e) => e.kind)).toEqual(["task.start"]);
      const j2 = new FileJournal(join(journalDir, "gateway.jsonl"), { writeBehind: true, sharded: true });
      expect(j2.readSession(sid).map((e) => e.kind)).toEqual(["task.start"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
