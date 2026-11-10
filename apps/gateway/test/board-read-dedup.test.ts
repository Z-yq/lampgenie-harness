/**
 * 03 board_read 同参去重(token 成本优化第一轮)+ 未决 2B 的 rev 自增守护。
 *
 * 缺陷背景:实测 93 个 session 里同目标重读 1,437 轮、其中 1,418 次逐字节相同(最狠一块
 * 2,160 字符的板读 155 次),而 microcompact 的 NEVER_COMPACT_TOOLS 把 board_read 排除在
 * 裁剪外——重复读是纯 token 浪费。判据只用 BoardDoc.rev(三处写路径 upsert/evidence/prune
 * 均自增),同 key 同 rev 才回一行短提示。
 *
 * negative(cache key 不得只用 sessionId):不同 taskId / all 翻转都必须各返回全量。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { saveBoard, loadBoard } from "../src/board-store.js";
import { boardReadTool, boardUpsertTool } from "../src/agent-wiring.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-dedup-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一个能撑过 200 字符渲染的板(3 节点 + summary),用于区分「全文」与「短提示」。 */
function nodes(tag = "") {
  // label 保持不变、只动 summary:upsert 的「节点 id 撞车」门把「同 id 改 label」判为撞车拒收
  // (那是给人看的改名,要走新 id + before),这里要的是「板内容确实变了」。
  return ["n1", "n2", "n3"].map((id) => ({
    id, kind: "module" as const, label: `节点${id}`, summary: `这是节点 ${id} 的实现细节描述,用于撑起渲染文本长度${tag}`,
    change: "add" as const,
  }));
}

/** 直接播种(跳过两道门:这里要的是读侧口径,不是落板门)。 */
function seed(root: string, tid = "t1", tag = ""): void {
  const s = saveBoard(root, {
    version: 1, taskId: tid, sessionId: "s1", title: `板${tid}${tag}`, status: "draft", rev: 0,
    nodes: nodes(tag), edges: [], planned_files: [], updatedAt: 0,
  }, { skipGates: true });
  expect(s.ok).toBe(true);
}

describe("① 首次调用返回全量", () => {
  it("含板名与全部节点", async () => {
    const r = tmp();
    seed(r);
    const txt = String(await boardReadTool(new MemoryJournal(), "s1", r, { boardId: "t1" }).execute({}));
    expect(txt).toContain("白板「板t1」");
    for (const id of ["n1", "n2", "n3"]) expect(txt).toContain(`节点${id}`);
  });
});

describe("② 同参重读:短提示→带标记短提示→第 4 次=逃逸全文(2026-10-30 修死代码)", () => {
  it("第 2 次短提示;第 3 次(n=2)带激活标记;第 4 次(n=3)给全文+换路指路;之后回短提示", async () => {
    const r = tmp();
    seed(r);
    const tool = boardReadTool(new MemoryJournal(), "s1", r, { boardId: "t1" });
    const first = String(await tool.execute({}));
    expect(first).toContain("节点n1");
    const second = String(await tool.execute({}));
    expect(second).toContain("board 未变更");
    expect(second.length).toBeLessThan(200);
    expect(second).not.toContain("节点n1"); // 全文没再回传(否则去重等于没做)
    expect(second).not.toContain("activate-tool"); // 第 2 次(n=1)还不带标记
    const third = String(await tool.execute({})); // n=2:存根+写意图出口
    expect(third).toContain("board 未变更");
    expect(third).toContain("[[activate-tool:board_upsert]]");
    expect(third).not.toContain("节点n1");
    // 逃逸(旧实现 stubStreak 在 execute 内重建,计数永远 1,此分支是死代码——
    // 38 步 board_read 死循环实锤;修后计数挂实例作用域,n=3 触发)
    const fourth = String(await tool.execute({}));
    expect(fourth).toContain("已连续 3 次重读");
    expect(fourth).toContain("节点n1");
    expect(fourth).toContain("[[activate-tool:board_upsert]]");
    // 逃逸后计数清零:第 5 次回到短提示(不是每次都全量)
    expect(String(await tool.execute({}))).toContain("board 未变更");
  });
});

describe("③b 写板回执内联状态(P1-1,2026-10-30):免掉模型板后回读确认", () => {
  it("回执含 rev / 节点数 / 新增数 / P0 覆盖,并明说无需 board_read", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const up = boardUpsertTool(j, "s1", "t1", r, r);
    const out = String(await up.execute({ title: "板t1", nodes: nodes(""), edges: [] }));
    expect(out).toContain("[板状态]");
    expect(out).toContain("rev 1"); // 首写 rev=1
    expect(out).toContain("共 3 节点");
    expect(out).toContain("本次新增 3 个");
    expect(out).toContain("无需 board_read 确认");
  });

  it("negative P0 节点缺 accept → 落板门直接拒收(比回执更严,回执点名只覆盖存量板)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const up = boardUpsertTool(j, "s1", "t1", r, r);
    const p0NoAccept = { id: "p0x", kind: "module" as const, label: "缺验收的P0", summary: "故意不带 accept 的 P0 节点", phase: "P0" as const, change: "add" as const };
    const out = String(await up.execute({ title: "板t1", nodes: [p0NoAccept], edges: [] }));
    expect(out).toContain("缺 accept");
    expect(out).not.toContain("设计白板已更新"); // 拒收:没写盘
  });

  it("存量板已有 P0 缺 accept(历史板/人工直写)→ 本次写板回执点名它", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    // 绕过落板门播种(=人改板/旧板的真实形态;回执点名就是为这种场景兜底)
    const s = saveBoard(r, {
      version: 1, taskId: "t1", sessionId: "s1", title: "板t1", status: "draft", rev: 0,
      nodes: [
        { id: "p0x", kind: "module", label: "存量缺验收P0", summary: "人工写进板、没有 accept 的 P0", phase: "P0", change: "add" },
        { id: "old1", kind: "module", label: "旧节点", summary: "撑起渲染长度的旧节点描述文本", change: "add" },
      ] as never, edges: [], planned_files: [], updatedAt: 0,
    }, { skipGates: true });
    expect(s.ok).toBe(true);
    const up = boardUpsertTool(j, "s1", "t1", r, r);
    const p0Ok = {
      id: "p0y", kind: "module" as const, label: "带验收的P0", summary: "带 accept 的 P0 节点", phase: "P0" as const, change: "add" as const,
      accept: [{ cmd: "pnpm vitest run test/x.test.ts", expect: "全绿", type: "command" as const }],
    };
    const out = String(await up.execute({ title: "板t1", nodes: [p0Ok], edges: [] }));
    expect(out).toContain("设计白板已更新");
    expect(out).toMatch(/P0 2 个\/带 accept 1 个/);
    expect(out).toContain("缺 accept:p0x");
  });
});

describe("③ 改板(upsert)后 rev 变 → 重新返回全量", () => {
  it("rev 自增使去重失效,新内容可见", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    seed(r);
    const read = boardReadTool(j, "s1", r, { boardId: "t1" });
    expect(String(await read.execute({}))).toContain("节点n1");
    expect(String(await read.execute({}))).toContain("board 未变更");
    const up = boardUpsertTool(j, "s1", "t1", r, r);
    const out = String(await up.execute({ title: "板t1", nodes: nodes("-改"), edges: [] }));
    expect(out).toContain("设计白板已更新");
    const third = String(await read.execute({}));
    expect(third).toContain("撑起渲染文本长度-改");
    expect(third).not.toContain("board 未变更");
  });
});

describe("④ negative:不同 taskId / all 翻转必须各返回全量(cache key 不得只用 sessionId)", () => {
  it("换 taskId 读另一块板:返回该板全文,不命中上一块板的缓存", async () => {
    const r = tmp();
    seed(r, "t1");
    seed(r, "t2", "-B");
    const tool = boardReadTool(new MemoryJournal(), "s1", r, {});
    const a = String(await tool.execute({ taskId: "t1" }));
    expect(a).toContain("板t1");
    const b = String(await tool.execute({ taskId: "t2" }));
    expect(b).toContain("板t2-B"); // 不是「board 未变更」
    expect(b).not.toContain("board 未变更");
  });

  it("all=true 与单板不共用 key:各自都返回全量", async () => {
    const r = tmp();
    seed(r, "t1");
    seed(r, "t2", "-B");
    const tool = boardReadTool(new MemoryJournal(), "s1", r, { boardId: "t1" });
    const single = String(await tool.execute({}));
    expect(single).toContain("板t1");
    const all = String(await tool.execute({ all: true }));
    expect(all).not.toContain("board 未变更");
    expect(all).toContain("**板 t1:**");
    expect(all).toContain("**板 t2:**");
    // all 连读两次才走短提示;单板 key 不受影响(仍应按自己的 rev 判定)
    expect(String(await tool.execute({ all: true }))).toContain("board 未变更");
  });

  it("all 口径下任一板改板 → 指纹变化 → 重新全量", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    seed(r, "t1");
    seed(r, "t2", "-B");
    const tool = boardReadTool(j, "s1", r, {});
    expect(String(await tool.execute({ all: true }))).toContain("板t2-B");
    expect(String(await tool.execute({ all: true }))).toContain("board 未变更");
    await boardUpsertTool(j, "s1", "t2", r, r).execute({ title: "板t2-C", nodes: nodes("-C"), edges: [] });
    const again = String(await tool.execute({ all: true }));
    expect(again).not.toContain("board 未变更");
    expect(again).toContain("板t2-C");
    expect(again).toContain("撑起渲染文本长度-C");
  });
});

describe("⑤ 压缩后缓存失效(auto-compact 把上次全文挤出上下文,2026-11 修静默丢板内容)", () => {
  it("compact.done(带 summary)之后同参再读 → 重新返回全文,不是短提示", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    seed(r);
    const tool = boardReadTool(j, "s1", r, { boardId: "t1" });
    expect(String(await tool.execute({}))).toContain("节点n1"); // ①全量
    expect(String(await tool.execute({}))).toContain("board 未变更"); // 缓存命中
    // ②auto-compact 边界(真压缩恒带非空 summary)
    j.append({ kind: "compact.done", sessionId: "s1", payload: { summary: "x" } });
    // ③正文已被挤出上下文,再读必须拿到全文
    const after = String(await tool.execute({}));
    expect(after).not.toContain("board 未变更");
    expect(after).toContain("节点n1");
    expect(after).toContain("撑起渲染文本长度"); // 节点内容(不是短提示)
    // 失效后基线刷新:紧接着再读恢复短提示(不会每次都全量)
    expect(String(await tool.execute({}))).toContain("board 未变更");
  });

  it("无摘要的 compact.done(旧 microcompact 占位)不算真压缩 → 缓存仍命中", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    seed(r);
    const tool = boardReadTool(j, "s1", r, { boardId: "t1" });
    expect(String(await tool.execute({}))).toContain("节点n1");
    j.append({ kind: "compact.done", sessionId: "s1", payload: { summary: "  " } });
    expect(String(await tool.execute({}))).toContain("board 未变更");
  });
});

describe("未决 2B 守护:board 三条写路径(upsert/evidence/prune)都使 rev 自增", () => {
  it("upsert → evidence → prune 每步 rev 递增(去重判据 rev 单判据的成立前提)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    seed(r, "t1");
    const revOf = (): number => loadBoard(r, "s1", "t1")!.rev;
    const r0 = revOf();

    const up = boardUpsertTool(j, "s1", "t1", r, r);
    await up.execute({
      title: "板t1",
      nodes: [
        { id: "p1", kind: "tool" as const, label: "落目标", summary: "P0 节点", change: "add" as const, phase: "P0", accept: [{ cmd: "true", expect: "ok" }] },
        { id: "z1", kind: "module" as const, label: "零痕迹", summary: "待清", change: "add" as const },
      ],
      edges: [],
    });
    const r1 = revOf();
    expect(r1).toBeGreaterThan(r0);

    const ev = String(await up.execute({ action: "evidence", nodeId: "p1", evidence: [{ cmd: "true", ok: true, output: "ok" }] }));
    expect(ev).toContain("已回填");
    const r2 = revOf();
    expect(r2).toBeGreaterThan(r1);

    const pr = String(await up.execute({ action: "prune", nodeIds: ["z1"], dryRun: false, confirm: true }));
    expect(pr).toContain("已清理 1 个");
    const r3 = revOf();
    expect(r3).toBeGreaterThan(r2);
  });
});
