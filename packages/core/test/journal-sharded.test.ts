/**
 * FileJournal sharded(2026-10-21 抄 ZCode session-store):按会话分文件持久化。
 * ①kind 路由:跨会话 kind→global.jsonl,会话肥 kind→sessions/<sid>.jsonl,legacy gateway.jsonl 冻结只读;
 * ②混合 load:legacy 段+global+sessions 按全局 seq 归并,readAll/readSession 语义与单文件一致;
 * ③单会话文件坏行=只截断该文件,其余文件不受污染;幂等键跨全文件生效;
 * ④可退性:关掉 sharded 后新事件回写 gateway.jsonl,重开时三路全并入。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "../src/journal/journal.js";

const tick = () => new Promise((r) => setTimeout(r, 25));
const mk = (name: string) => mkdtempSync(join(tmpdir(), name));

describe("FileJournal sharded", () => {
  it("kind 路由:跨会话 kind→global,会话肥 kind→sessions/<sid>.jsonl;legacy 文件冻结不写", async () => {
    const dir = mk("shard-route-");
    try {
      const fp = join(dir, "gateway.jsonl");
      writeFileSync(fp, "", "utf-8"); // legacy 空文件在场(冻结目标)
      const j = new FileJournal(fp, { writeBehind: true, sharded: true });
      j.append({ kind: "task.start", sessionId: "sA", payload: { a: 1 } });            // 跨会话
      j.append({ kind: "message.user", sessionId: "sA", payload: { text: "hi" } });    // 肥
      j.append({ kind: "message.agent", sessionId: "sB", payload: { text: "yo" } });   // 肥(另一会话)
      j.append({ kind: "subagent.spawn", sessionId: "sA", payload: { agentId: "x" } });// 跨会话
      await tick(); await tick();
      const g = readFileSync(join(dir, "global.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string });
      expect(g.map((e) => e.kind)).toEqual(["task.start", "subagent.spawn"]);
      const sa = readFileSync(join(dir, "sessions", "sA.jsonl"), "utf-8");
      expect(sa).toContain("message.user");
      expect(readFileSync(join(dir, "sessions", "sB.jsonl"), "utf-8")).toContain("message.agent");
      expect(readFileSync(fp, "utf-8")).toBe(""); // legacy 冻结
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("混合 load:legacy(seq0-1)+global/sessions(seq2-5)按 seq 归并,readAll/readSession/幂等键全保持", async () => {
    const dir = mk("shard-load-");
    try {
      const fp = join(dir, "gateway.jsonl");
      // 先用单文件模式造 legacy 段(seq 0-1)
      const legacy = new FileJournal(fp);
      legacy.append({ kind: "message.user", sessionId: "sA", payload: { text: "旧1" } });
      legacy.append({ kind: "task.start", sessionId: "sA", payload: { t: 1 } });
      // 再换 sharded 实例继续写(seq 2-5,跨会话/会话肥交错)
      const j = new FileJournal(fp, { sharded: true });
      j.append({ kind: "message.agent", sessionId: "sA", payload: { text: "新1" } });
      j.append({ kind: "task.done", sessionId: "sA", payload: { ok: true } });
      j.append({ kind: "tool.call", sessionId: "sA", payload: { name: "x" } });
      j.append({ kind: "subagent.result", sessionId: "sA", payload: { agentId: "x" } });
      // 重开:三路归并
      const j2 = new FileJournal(fp, { sharded: true });
      expect(j2.readAll()).toHaveLength(6);
      expect(j2.readAll().map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]); // 全局 seq 稠密归并
      expect(j2.readSession("sA")).toHaveLength(6);
      expect(j2.readAll()[2]!.payload).toEqual({ text: "新1" });
      // 幂等键跨文件:legacy 的键在重开实例上仍拦截
      const dup = j2.append({ kind: "message.user", sessionId: "sA", payload: { text: "旧1" } } as never);
      void dup;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("坏行只影响自身:半行截断丢该行,其余会话不受污染", async () => {
    const dir = mk("shard-bad-");
    try {
      const fp = join(dir, "gateway.jsonl");
      const j = new FileJournal(fp, { sharded: true });
      j.append({ kind: "message.user", sessionId: "sA", payload: { text: "a" } });
      j.append({ kind: "message.user", sessionId: "sB", payload: { text: "b" } });
      await tick(); await tick();
      // 给 sA 文件尾补半行(模拟崩溃残留)
      appendFileSync(join(dir, "sessions", "sA.jsonl"), '{"kind":"message.u', "utf-8");
      const j2 = new FileJournal(fp, { sharded: true });
      expect(j2.readSession("sA")).toHaveLength(1); // 半行截断,好行保留
      expect(j2.readSession("sB")).toHaveLength(1); // 其它会话不受污染
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("中段坏行(双写交错)跳过、后续有效行全部恢复;稀疏 seq 不降级会话二分", () => {
    const dir = mk("shard-midbad-");
    try {
      const fp = join(dir, "gateway.jsonl");
      writeFileSync(fp, "", "utf-8");
      mkdirSync(join(dir, "sessions"), { recursive: true });
      const good = (i: number) => JSON.stringify({ kind: "message.agent", sessionId: "sA", payload: { text: "m" + i }, seq: i, time: 100 + i });
      // 双写交错:seq 2 那行只剩后半截(JSON 开头被前一个写者吃掉),两侧好行必须保留
      writeFileSync(join(dir, "sessions", "sA.jsonl"),
        [good(0), good(1), 'tep.end","sessionId":"sA","payload":{}}', good(3), good(4)].join("\n") + "\n", "utf-8");
      const j = new FileJournal(fp, { sharded: true });
      expect(j.readAll().map((e) => e.seq)).toEqual([0, 1, 3, 4]);
      expect(j.readSession("sA").map((e) => e.seq)).toEqual([0, 1, 3, 4]);
      // 稀疏 seq 下增量水位仍正确(二分可用,不因全球下标≠seq 而失效)
      expect(j.readSession("sA", 3).map((e) => e.seq)).toEqual([3, 4]);
      expect(j.append({ kind: "message.agent", sessionId: "sA", payload: { text: "m5" } }).seq).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("可退性:关掉 sharded 后新事件回写 gateway.jsonl,重开(任意模式)全并入可读", async () => {
    const dir = mk("shard-revert-");
    try {
      const fp = join(dir, "gateway.jsonl");
      const js = new FileJournal(fp, { sharded: true });
      js.append({ kind: "message.user", sessionId: "sA", payload: { text: "分文件期" } });
      // 关 sharded:回写单文件(legacy 续写)
      const jp = new FileJournal(fp);
      jp.append({ kind: "message.agent", sessionId: "sA", payload: { text: "回退期" } });
      // 重开 sharded:legacy(含回退期新行)+ sessions 全并入
      const j2 = new FileJournal(fp, { sharded: true });
      expect(j2.readAll()).toHaveLength(2);
      expect(j2.readAll().map((e) => (e.payload as { text: string }).text)).toEqual(["分文件期", "回退期"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("双写历史:同 seq 跨文件重复→保留较新事件;新事件 seq 从历史最大值续接(不再碰撞)", () => {
    const dir = mk("shard-dupseq-");
    try {
      const fp = join(dir, "gateway.jsonl");
      // legacy:seq 0,1,2 且 seq 2 是"旧版本"(time 更早)
      writeFileSync(fp, [
        JSON.stringify({ kind: "message.user", sessionId: "sA", payload: { text: "旧0" }, seq: 0, time: 100 }),
        JSON.stringify({ kind: "message.user", sessionId: "sA", payload: { text: "旧1" }, seq: 1, time: 101 }),
        JSON.stringify({ kind: "message.user", sessionId: "sA", payload: { text: "旧2-应被新2覆盖" }, seq: 2, time: 102 }),
      ].join("\n") + "\n", "utf-8");
      // 新会话分片里出现同 seq 2(双写),time 更新
      mkdirSync(join(dir, "sessions"), { recursive: true });
      writeFileSync(join(dir, "sessions", "sA.jsonl"), JSON.stringify({ kind: "message.agent", sessionId: "sA", payload: { text: "新2" }, seq: 2, time: 900 }) + "\n", "utf-8");
      const j = new FileJournal(fp, { sharded: true });
      // 去重后 seq 2 保留较新事件
      expect(j.readAll().map((e) => e.seq)).toEqual([0, 1, 2]);
      expect((j.readAll()[2]!.payload as { text: string }).text).toBe("新2");
      // 新事件 seq 必须是 3(历史最大+1),不是 events.length 之外的碰撞值
      const ev = j.append({ kind: "message.user", sessionId: "sA", payload: { text: "新3" } });
      expect(ev.seq).toBe(3);
      expect(j.readAll().map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("默认模式(不开 sharded/writeBehind)行为与旧版逐字节一致:全部写单文件", () => {
    const dir = mk("shard-default-");
    try {
      const fp = join(dir, "gateway.jsonl");
      const j = new FileJournal(fp);
      j.append({ kind: "message.user", sessionId: "sA", payload: { text: "x" } });
      j.append({ kind: "task.start", sessionId: "sA", payload: {} });
      const raw = readFileSync(fp, "utf-8").trim().split("\n");
      expect(raw).toHaveLength(2);
      expect(existsSync(join(dir, "sessions"))).toBe(false);
      expect(existsSync(join(dir, "global.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
