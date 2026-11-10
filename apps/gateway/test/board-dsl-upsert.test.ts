/**
 * board_upsert 的 dsl 文本入参端到端测试(step:LLM 落板省字节)。
 * 覆盖 board-dsl.ts 解析 → agent-wiring 落板 → board-store.loadBoard 读回全链路:
 * 落板成功 / 解析错误不落盘 / dsl 优先于 nodes / dsl meta 生效 / 只给 nodes 的向后兼容。
 * 另含紧凑度回归:同一张板 dsl 文本字节数必须显著小于等价 nodes+edges JSON。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { loadBoard } from "../src/board-store.js";
import { boardUpsertTool } from "../src/agent-wiring.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-dsl-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 3 节点(含 1 decision 带 P0+accept)/ 2 lane / 2 边,dsl 自带 title/type/scale/kind。 */
const DSL = `%% board v1
title: 解析入口分派重构
type: code
scale: S
kind: design

lane 01 现状 : n1 n2
lane 02 目标 : n3

node n1 function keep "解析入口" | parseOffice 校验 ext/空包/上限后解 zip 分派
node n2 decision modify P0 "是否走新路由" | 现在只有一个 switch 按 ext 分派
  accept: pnpm vitest run test/office.test.ts => 12 passed
  targets: apps/gateway/src/office-ooxml.ts
  sym: parseOffice@apps/gateway/src/office-ooxml.ts:54
node n3 function add "改写分派" | 按 mime 走新路由
edge n1 -> n2 : 调用
edge n2 -> n3 : 是
`;

const dslOf = (body: string): string => `%% board v1\n${body}\n`;

describe("board_upsert dsl 入参", () => {
  it("① dsl 落板成功:3 节点/2 边/lane=group,title 两种写法都认", async () => {
    // (a) title 来自 dsl 自带 title: 行
    const r1 = tmp();
    const j1 = new MemoryJournal();
    const out1 = String(await boardUpsertTool(j1, "s1", "t1", r1, r1).execute({ dsl: DSL }));
    expect(out1).not.toContain("dsl 解析失败");
    expect(out1).toContain("更新");
    const d1 = loadBoard(r1, "s1", "t1");
    expect(d1).not.toBeNull();
    expect(d1!.title).toBe("解析入口分派重构");
    expect(d1!.nodes).toHaveLength(3);
    expect(d1!.edges).toHaveLength(2);
    const p0 = d1!.nodes.find((n) => n.phase === "P0");
    expect(p0?.id).toBe("n2");
    expect(p0?.kind).toBe("decision");
    expect(p0?.accept?.length).toBe(1);
    expect(p0?.accept?.[0]?.cmd).toContain("office.test.ts");
    expect(p0?.accept?.[0]?.expect).toBe("12 passed");
    expect(p0?.symbolRef?.name).toBe("parseOffice");
    const grp = (id: string): string | undefined => d1!.nodes.find((n) => n.id === id)?.group;
    expect(grp("n1")).toBe("01 现状");
    expect(grp("n2")).toBe("01 现状");
    expect(grp("n3")).toBe("02 目标");
    expect(d1!.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["n1>n2", "n2>n3"]);

    // (b) dsl 不带 title 行 → 用入参 title 补
    const r2 = tmp();
    const j2 = new MemoryJournal();
    const noTitle = dslOf(`node a1 function keep "只一个节点" | 摘要\n`);
    const out2 = String(await boardUpsertTool(j2, "s1", "t2", r2, r2).execute({ dsl: noTitle, title: "入参标题" }));
    expect(out2).not.toContain("dsl 解析失败");
    expect(out2).toContain("已更新");
    expect(loadBoard(r2, "s1", "t2")!.title).toBe("入参标题");
  });

  it("② dsl 解析错误 → 回执带行号且白板未创建", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const bad = dslOf(`node n1 function keep "好节点" | 摘要\nnode n2 function\n`);
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ dsl: bad, title: "坏板" }));
    expect(out).toContain("dsl 解析失败");
    expect(out).toContain("第 3 行");
    expect(loadBoard(r, "s1", "t1")).toBeNull();
    expect(j.readAll().filter((e) => e.kind === "board.update")).toHaveLength(0);
  });

  it("③ dsl 与 nodes 同时给 → dsl 优先(落 3 个不是 1 个)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({
      dsl: DSL,
      title: "混给板",
      nodes: [{ id: "solo", kind: "function", label: "被忽略的节点", summary: "不该落盘", change: "keep" }],
    }));
    expect(out).not.toContain("dsl 解析失败");
    expect(out).toContain("已更新");
    const d = loadBoard(r, "s1", "t1")!;
    expect(d.nodes).toHaveLength(3);
    expect(d.nodes.some((n) => n.id === "solo")).toBe(false);
  });

  it("④ dsl 的 meta 生效:type/scale/kind 不必再传参数", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ dsl: DSL }));
    expect(out).not.toContain("dsl 解析失败");
    expect(out).toContain("已更新");
    const d = loadBoard(r, "s1", "t1")!;
    expect(d.boardType).toBe("code");
    expect(d.scale).toBe("S");
    expect(d.docKind).toBe("design");
  });

  it("⑤ 向后兼容:只给 nodes/edges(无 dsl)照常落盘", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({
      title: "旧写法板",
      nodes: [
        { id: "n1", kind: "function", label: "入口", summary: "现有入口", change: "keep" },
        { id: "n2", kind: "function", label: "出口", summary: "现有出口", change: "keep" },
      ],
      edges: [{ from: "n1", to: "n2", kind: "call", label: "调用" }],
      boardType: "code",
      scale: "S",
    }));
    expect(out).not.toContain("dsl 解析失败");
    expect(out).toContain("已更新");
    const d = loadBoard(r, "s1", "t1")!;
    expect(d.nodes).toHaveLength(2);
    expect(d.edges).toHaveLength(1);
    expect(d.title).toBe("旧写法板");
  });

  it("⑥ 紧凑度:同一张板 dsl 文本字节数显著小于等价 nodes+edges JSON", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    await boardUpsertTool(j, "s1", "t1", r, r).execute({ dsl: DSL });
    const d = loadBoard(r, "s1", "t1")!;
    const jsonBytes = Buffer.byteLength(JSON.stringify({ nodes: d.nodes, edges: d.edges }));
    const dslBytes = Buffer.byteLength(DSL);
    expect(dslBytes).toBeLessThan(jsonBytes);
 // 经验证比值(报数用):dsl / json
    expect(dslBytes / jsonBytes).toBeLessThan(0.75);
  });

  it("⑦ dsl + nodes 同给:JSON 按节点 id 补 flow/evidence,dsl 字段不被覆盖,JSON 独有 id 不并入", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({
      dsl: DSL,
      title: "合并板",
      nodes: [
        // n2:dsl 里已存在 → 只能补 flow/evidence,label/kind 不许被改
        {
          id: "n2", kind: "note", label: "JSON 想改的 label", summary: "JSON 想改的 summary",
          flow: [{ type: "step", text: "读入请求" }, { type: "branch", cond: "mime 命中", then: [{ type: "step", text: "走新路由" }] }],
          evidence: [{ cmd: "pnpm vitest run test/office.test.ts", ok: true, at: 0 }],
        },
        // solo:JSON 独有 id → 不并入
        { id: "solo", kind: "function", label: "多余节点", summary: "不该落盘" },
        // n9:dsl 里没有的 id → 也不并入(不新增节点)
        { id: "n9", kind: "function", label: "另一个多余", summary: "不该落盘" },
      ],
    }));
    expect(out).not.toContain("dsl 解析失败");
    expect(out).toContain("已更新");
    expect(out).toContain("dsl+nodes 合并:补全 1 个节点");
    const d = loadBoard(r, "s1", "t1")!;
    // 节点数恒等于 dsl 节点数(3),JSON 独有 id 不并入
    expect(d.nodes).toHaveLength(3);
    expect(d.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    const n2 = d.nodes.find((n) => n.id === "n2")!;
    // dsl 为准:kind/label/summary 未被 JSON 改写
    expect(n2.kind).toBe("decision");
    expect(n2.label).toBe("是否走新路由");
    expect(n2.summary).toContain("只有一个 switch");
    // JSON 补进来的 flow/evidence 真的落到 saved doc
    expect(n2.flow).toHaveLength(2);
    expect(n2.flow[0]).toEqual({ type: "step", text: "读入请求" });
    expect(n2.flow[1]).toMatchObject({ type: "branch", cond: "mime 命中" });
    expect(n2.evidence?.[0]?.ok).toBe(true);
    // 未被 JSON 提到的节点:flow 走 zod default 空数组(不凭空长 flow)
    expect(d.nodes.find((n) => n.id === "n1")!.flow).toEqual([]);
    // edges 仍硬覆盖(dsl 的 2 条,不是 JSON 的)
    expect(d.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["n1>n2", "n2>n3"]);
  });

  it("⑧ dsl 自带 flow: 行 → saved doc 里 flow 存活(不靠 nodes JSON)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const body = dslOf([
      "node n1 function keep \"读入\" | 读请求体",
      "  flow: step 读请求体",
      "  flow: branch body 为空 ? 回 400 : 继续",
      "node n2 function keep \"解析\" | 逐块解析",
      "  flow: loop over blocks | body 校验块; 收集告警",
      "  accept: [command] pnpm vitest run test/x.test.ts => 3 passed | 原用例必须全绿",
      "edge n1 -> n2 : 调用",
    ].join("\n"));
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ dsl: body, title: "flow 板" }));
    expect(out).not.toContain("dsl 解析失败");
    expect(out).not.toContain("dsl+nodes 合并");
    const d = loadBoard(r, "s1", "t1")!;
    const n1 = d.nodes.find((n) => n.id === "n1")!;
    expect(n1.flow).toEqual([
      { type: "step", text: "读请求体" },
      { type: "branch", cond: "body 为空", then: [{ type: "step", text: "回 400" }], else: [{ type: "step", text: "继续" }] },
    ]);
    const n2 = d.nodes.find((n) => n.id === "n2")!;
    expect(n2.flow).toEqual([{ type: "loop", over: "blocks", body: [{ type: "step", text: "校验块" }, { type: "step", text: "收集告警" }] }]);
    expect(n2.accept?.[0]).toEqual({
      cmd: "pnpm vitest run test/x.test.ts", expect: "3 passed", type: "command", note: "原用例必须全绿",
    });
  });

  it("⑨ flow 不可表达 → 整板不落(E_FLOW_SYNTAX 带行号)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const bad = dslOf(`node n1 function keep "好节点" | 摘要\n  flow: branch 缺 then\n`);
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ dsl: bad, title: "坏 flow 板" }));
    expect(out).toContain("dsl 解析失败");
    expect(out).toContain("E_FLOW_SYNTAX");
    expect(loadBoard(r, "s1", "t1")).toBeNull();
  });
});