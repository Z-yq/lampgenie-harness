/**
 * board-ofk 单测:BoardDoc → OFK DSL 序列化 + 清洗有效性(核心失败模式 = W101 整行被丢)。
 *
 * 关键设计:清洗用例不只断言字符串形态,而是把序列化结果**真喂给 flowkit 编译**,
 * 断言 diagnostics 里没有 W101/W102——字符串断言会漏「看上去替换了但解析器仍丢行」的情况。
 */
import { describe, it, expect } from "vitest";
import type { BoardDoc } from "@lampgenie/protocol";
import { serializeBoard, shapeFor, flowOutline } from "../src/board-ofk.js";
import {
  createAgentDocument,
  createFileCapabilities,
  compileWorkspace,
  findAgentOp,
  runAgentOp,
} from "@openflowkit/openflowkit-mcp/dist/generated/openflowkit-agent.js";

type NodeIn = BoardDoc["nodes"][number];

function mkNode(id: string, label: string, extra: Partial<NodeIn> = {}): NodeIn {
  return {
    id,
    kind: "function",
    label,
    summary: "s",
    change: "keep",
    done: false,
    comments: [],
    flow: [],
    ...extra,
  } as NodeIn;
}

function mkDoc(nodes: NodeIn[], edges: Array<{ from: string; to: string; label?: string }> = [], patch: Partial<BoardDoc> = {}): BoardDoc {
  return {
    version: 1,
    taskId: "t1",
    sessionId: "s1",
    title: "测试板",
    status: "draft",
    rev: 0,
    nodes,
    edges: edges.map((e) => ({ kind: "call", ...e })),
    planned_files: [],
    ...patch,
  } as unknown as BoardDoc;
}

/** 序列化结果真编译一遍,拿 flowkit 诊断。 */
async function compileDiags(ofkText: string): Promise<Array<{ code: string; severity: string; message: string; line: number }>> {
  const doc = createAgentDocument("board");
  const pageId = doc.pages[0].id as string;
  const capabilities = { ...(await createFileCapabilities({})), compileWorkspace };
  const r = await runAgentOp(findAgentOp("create_diagram"), { dsl: ofkText }, { document: doc, pageId, capabilities });
  return (r.output.diagnostics ?? []).map((d: any) => ({
    code: String(d.code),
    severity: String(d.severity),
    message: String(d.message),
    line: Number(d.line ?? 0),
  }));
}

describe("serializeBoard 头部", () => {
  it("前三行固定为 %% ofk 1 / flowchart / direction,code 板 right,其它 down", () => {
    const base = [mkNode("a", "A")];
    const codeDoc = serializeBoard(mkDoc(base, [], { boardType: "code" }));
    expect(codeDoc.ofk.split("\n").slice(0, 3)).toEqual(["%% ofk 1", "flowchart", "direction: right"]);

    const other = serializeBoard(mkDoc(base, [], { boardType: "design" }));
    expect(other.ofk.split("\n")[2]).toBe("direction: down");

    const none = serializeBoard(mkDoc(base));
    expect(none.ofk.split("\n")[2]).toBe("direction: down");
  });

  it("节点行形如 <id> [<shape>, label: \"...\", desc: \"...\"]", () => {
    const { ofk } = serializeBoard(mkDoc([mkNode("n1", "读配置", { summary: "打开配置文件" })]));
    expect(ofk).toContain('n1 [rect, label: "读配置", desc: "打开配置文件"]');
  });

  it("summary 超预算截断并记 warning(带显式 …);无 summary 不写 desc", () => {
    const long = "长".repeat(200);
    const r1 = serializeBoard(mkDoc([mkNode("n1", "L", { summary: long })]));
    // 2026-11 改动:summary 只取首句 + 按 DESC_LABEL_BUDGET(72)截断,末字为显式省略号 `…`。
    expect(r1.ofk).toContain(`desc: "${"长".repeat(71)}…"`);
    expect(r1.warnings.some((w) => w.includes("截断"))).toBe(true);

    const r2 = serializeBoard(mkDoc([mkNode("n1", "L", { summary: "" })]));
    expect(r2.ofk).not.toContain("desc:");
  });
});

describe("清洗(核心:编译后无 W101/W102 丢行)", () => {
  const dirty: NodeIn[] = [
    mkNode("n1", "有 {花括} 号", { summary: "描述里也有 [方括号] | 竖线 : 冒号" }),
    mkNode("n2", "换行\n第二行"),
    mkNode("n3", '带 "引号" 与 \\反斜杠'),
    mkNode("n4", "纯 [方], 竖|线, 冒:号"),
  ];

  it("脏标签序列化后编译,diagnostics 无 W101/W102", async () => {
    const { ofk, warnings } = serializeBoard(mkDoc(dirty, [{ from: "n1", to: "n2", label: "真 {分支}" }]));
    const diags = await compileDiags(ofk);
    const dropped = diags.filter((d) => d.code === "W101" || d.code === "W102");
    expect(dropped, `序列化输出:\n${ofk}\n诊断:${JSON.stringify(diags)}`).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("{} [] | : 换行 双引号 反斜杠 各自记一条 warning(节点名 + 字符名)", () => {
    const { ofk, warnings } = serializeBoard(mkDoc([mkNode("n3", "含 {} 与 [] 与 | 与 : 与\n换行")]));
    expect(ofk).toContain("（"); // { → （
    expect(ofk).toContain("）"); // } → ）
    expect(ofk).toContain("("); // [ → (
    expect(ofk).toContain("；"); // : → ；
    expect(warnings).toContain("node n3: label 含 {} 已替换");
    expect(warnings).toContain("node n3: label 含 [] 已替换");
    expect(warnings).toContain("node n3: label 含 | 已替换");
    expect(warnings).toContain("node n3: label 含 : 已替换");
    expect(warnings).toContain("node n3: label 含 换行 已替换");
    // 换行压平成空格:节点行内部不出现裸换行
    for (const line of ofk.split("\n")) {
      if (line.includes("node-n3") || line.includes('label: "含')) expect(line).not.toContain("\r");
    }
  });

  it("双引号转义、反斜杠双写", () => {
    const { ofk, warnings } = serializeBoard(mkDoc([mkNode("q", 'a"b\\c')]));
    expect(ofk).toContain('label: "a\\"b\\\\c"');
    expect(warnings.some((w) => w.includes("双引号") && w.startsWith("node q: label"))).toBe(true);
    expect(warnings.some((w) => w.includes("反斜杠") && w.startsWith("node q: label"))).toBe(true);
  });

  it("未清洗的原始脏文本确实会被 flowkit 丢行(反向验证清洗必要性)", async () => {
    const raw = '%% ofk 1\nflowchart\ndirection: right\n\na [rect, label: "第一行\n第二行"]\nb [rect, label: "b"]\na -> b\n';
    const diags = await compileDiags(raw);
    expect(diags.some((d) => d.code === "W101" || d.code === "W102")).toBe(true);
  });
});

describe("group 泳道", () => {
  it("有 group 的节点包进 group 块,无 group 节点在块外", () => {
    const doc = mkDoc([
      mkNode("loose1", "散节点"),
      mkNode("g1", "采集A", { group: "01 采集" }),
      mkNode("g2", "采集B", { group: "01 采集" }),
      mkNode("h1", "处理A", { group: "02 处理" }),
      mkNode("loose2", "散节点2"),
    ]);
    const { ofk } = serializeBoard(doc);
    const lines = ofk.split("\n");
    const idx = lines.findIndex((l) => l.includes('group "01 采集" {'));
    expect(idx).toBeGreaterThan(-1);
    expect(lines[idx + 1]).toContain('label: "采集A"');
    expect(lines[idx + 2]).toContain('label: "采集B"');
    expect(lines[idx + 3].trim()).toBe("}");
    expect(ofk).toContain('group "02 处理" {');
    // 无 group 节点出现在任何 group 块之外
    let depth = 0;
    const outside: string[] = [];
    for (const l of lines) {
      if (/\bgroup\s+".*"\s*\{/.test(l)) depth++;
      else if (depth > 0 && l.trim() === "}") depth--;
      else if (depth === 0 && l.includes("label:")) outside.push(l);
    }
    expect(outside.join("\n")).toContain('label: "散节点"');
    expect(outside.join("\n")).toContain('label: "散节点2"');
    expect(outside.join("\n")).not.toContain("采集A");
  });

  it("序列化产物里 %% 只允许出现在版本行(否则 flowkit 把它当节点名)", () => {
    // 2026-11-03 活面板实测:旧实现写 "  %% 未分泳道" 当注释,grammar 里 %% 不是注释,
    // 结果画布上多出一个名为「%% 未分泳道」的幽灵空框。回归:除首行外不得再出现 %%。
    const { ofk } = serializeBoard(mkDoc([mkNode("a", "散1"), mkNode("b", "散2", { group: "01 采集" })]));
    const lines = ofk.split("\n");
    expect(lines[0]).toBe("%% ofk 1");
    expect(lines.slice(1).filter((l) => l.includes("%%"))).toEqual([]);
  });

  it("group 名含危险字符也被清洗并记 warning", () => {
    const { ofk, warnings } = serializeBoard(mkDoc([mkNode("g1", "A", { group: "01: 采集{核心}" })]));
    expect(ofk).toContain('group "01； 采集（核心）" {');
    expect(warnings.some((w) => w.startsWith("group 01: 采集{核心}"))).toBe(true);
  });
});

describe("shape 映射", () => {
  it("decision→diamond, start/end→ellipse, note→note, io→parallelogram, 其余→rect", () => {
    expect(shapeFor("decision")).toBe("diamond");
    expect(shapeFor("start")).toBe("ellipse");
    expect(shapeFor("end")).toBe("ellipse");
    expect(shapeFor("note")).toBe("note");
    expect(shapeFor("io")).toBe("parallelogram");
    for (const k of ["function", "section", "nav", "wf-script", "wf-test"]) {
      expect(shapeFor(k)).toBe("rect");
    }
  });

  it("序列化里每类 kind 落到对应 shape 且全部可编译", async () => {
    const kinds: Array<[string, string]> = [
      ["decision", "diamond"],
      ["start", "ellipse"],
      ["end", "ellipse"],
      ["note", "note"],
      ["io", "parallelogram"],
      ["function", "rect"],
    ];
    const nodes = kinds.map(([k], i) => mkNode(`k${i}`, `节点${i}`, { kind: k as NodeIn["kind"] }));
    const { ofk } = serializeBoard(mkDoc(nodes));
    kinds.forEach(([, shape], i) => expect(ofk).toContain(`k${i} [${shape}, `));
    expect(ofk.split("\n").filter((l) => l.includes("label:"))).toHaveLength(kinds.length);
    expect(await compileDiags(ofk)).toEqual([]);
  });
});

describe("边过滤", () => {
  it("from 指向不存在节点 → 该边不出现,警告非空", () => {
    const { ofk, warnings } = serializeBoard(
      mkDoc([mkNode("a", "A"), mkNode("b", "B")], [
        { from: "a", to: "b" },
        { from: "ghost", to: "b" },
        { from: "a", to: "ghost2" },
      ]),
    );
    expect(ofk).toContain("a -> b");
    expect(ofk).not.toContain("ghost -> b");
    expect(ofk).not.toContain("a -> ghost2");
    expect(warnings.filter((w) => w.includes("不在节点集")).length).toBe(2);
  });

  it("有 label 的边输出 ` : label`,label 内危险字符也清洗", async () => {
    const { ofk } = serializeBoard(mkDoc([mkNode("a", "A"), mkNode("b", "B")], [{ from: "a", to: "b", label: "真:{a|b}" }]));
    expect(ofk).toContain("a -> b : 真；（a/b）");
    const diags = await compileDiags(ofk);
    expect(diags.filter((d) => d.code === "W101")).toEqual([]);
  });

  it("无 label 边按 kind 兜底关系词(2026-11 改动:不再是裸边)", () => {
    const { ofk, warnings } = serializeBoard(mkDoc([mkNode("a", "A"), mkNode("b", "B")], [{ from: "a", to: "b" }]));
    expect(ofk).toContain("\na -> b : 调用\n");
    expect(warnings.some((w) => w.includes("已用 kind=call 兜底"))).toBe(true);
  });
});

describe("节点上限", () => {
  it(">60 节点截断并记 warning;被截掉节点的边一并丢弃", () => {
    const nodes = Array.from({ length: 65 }, (_, i) => mkNode(`n${i}`, `节点${i}`));
    const edges = [{ from: "n62", to: "n0" }];
    const { ofk, warnings } = serializeBoard(mkDoc(nodes, edges));
    expect(warnings.some((w) => w.includes("超上限 60"))).toBe(true);
    expect(ofk).toContain('label: "节点59"');
    expect(ofk).not.toContain('label: "节点60"');
    expect(warnings.some((w) => w.includes("不在节点集"))).toBe(true);
  });
});

describe("shape 扩展表(kind → 16 词 shape 词表)", () => {
  const OFK_SHAPES = new Set([
    "rect", "rounded", "circle", "ellipse", "diamond", "cylinder", "hexagon", "cloud", "doc",
    "note", "parallelogram", "person", "queue", "component", "browser", "mobile",
  ]);

  it("module/component/http→component, llm→rounded, tool/loop→hexagon, aggregate/wf-parallel→queue", () => {
    expect(shapeFor("module")).toBe("component");
    expect(shapeFor("component")).toBe("component");
    expect(shapeFor("http")).toBe("component");
    expect(shapeFor("llm")).toBe("rounded");
    expect(shapeFor("tool")).toBe("hexagon");
    expect(shapeFor("loop")).toBe("hexagon");
    expect(shapeFor("aggregate")).toBe("queue");
    expect(shapeFor("wf-parallel")).toBe("queue");
  });

  it("retrieval→cylinder, agent/wf-agent→person, page→browser, template→doc, wf-notify→note", () => {
    expect(shapeFor("retrieval")).toBe("cylinder");
    expect(shapeFor("agent")).toBe("person");
    expect(shapeFor("wf-agent")).toBe("person");
    expect(shapeFor("page")).toBe("browser");
    expect(shapeFor("template")).toBe("doc");
    expect(shapeFor("wf-notify")).toBe("note");
  });

  it("section/nav/wf-script/wf-test/function/未知 kind 一律 rect", () => {
    for (const k of ["section", "nav", "wf-script", "wf-test", "function", "nonsense-kind"]) {
      expect(shapeFor(k)).toBe("rect");
    }
  });

  it("既有 5 种映射逐字保留", () => {
    expect(shapeFor("decision")).toBe("diamond");
    expect(shapeFor("wf-condition")).toBe("diamond");
    expect(shapeFor("classifier")).toBe("diamond");
    expect(shapeFor("start")).toBe("ellipse");
    expect(shapeFor("end")).toBe("ellipse");
    expect(shapeFor("note")).toBe("note");
    expect(shapeFor("io")).toBe("parallelogram");
  });

  it("所有返回值都落在 OFK 16 个 shape 词内(否则 flowkit 报 W131 未知属性)", () => {
    const kinds = [
      "decision", "wf-condition", "classifier", "start", "end", "note", "io",
      "module", "component", "http", "function", "llm", "tool", "loop", "aggregate",
      "retrieval", "agent", "wf-agent", "page", "template", "wf-notify", "wf-parallel",
      "section", "nav", "wf-script", "wf-test", "classify-unknown", "",
    ];
    for (const k of kinds) {
      const s = shapeFor(k);
      expect(OFK_SHAPES.has(s), `shapeFor(${JSON.stringify(k)}) = ${s} 不在 16 词表内`).toBe(true);
    }
  });
});

describe("change 上色", () => {
  it("add→green, modify→orange, delete→red, keep 不写 color 属性", () => {
    const doc = mkDoc([
      mkNode("a", "新增", { change: "add" }),
      mkNode("m", "改动", { change: "modify" }),
      mkNode("d", "删除", { change: "delete" }),
      mkNode("k", "保持", { change: "keep" }),
    ]);
    const { ofk } = serializeBoard(doc);
    const lineOf = (id: string) => ofk.split("\n").find((l) => l.trim().startsWith(`${id} [`)) ?? "";
    expect(lineOf("a")).toContain("color: green");
    expect(lineOf("m")).toContain("color: orange");
    expect(lineOf("d")).toContain("color: red");
    expect(lineOf("k")).not.toContain("color:");
  });
});

describe("flowOutline(flow → 一行副标题)", () => {
  it("branch 段:分支: <cond>; 是→…; 否→…(各取前 2 条 text,超出加「 等」)", () => {
    const flow = [
      {
        type: "branch" as const,
        cond: "hit.cached",
        then: [
          { type: "step" as const, text: "读缓存" },
          { type: "step" as const, text: "返回结果" },
          { type: "step" as const, text: "记命中" },
        ],
        else: [{ type: "step" as const, text: "回源" }],
      },
    ];
    expect(flowOutline(flow)).toBe("分支: hit.cached; 是→读缓存、返回结果 等; 否→回源");
    expect(flowOutline(flow)).toContain("是→");
  });

  it("branch 的 else 为空时省略「否→」段", () => {
    const flow = [{ type: "branch" as const, cond: "ok", then: [{ type: "step" as const, text: "落库" }], else: [] }];
    const out = flowOutline(flow);
    expect(out).toBe("分支: ok; 是→落库");
    expect(out).not.toContain("否→");
  });

  it("loop 段:循环 <over>: <body 前 2 条>", () => {
    const flow = [
      { type: "loop" as const, over: "files", body: [
        { type: "step" as const, text: "读文件" },
        { type: "step" as const, text: "清洗" },
        { type: "step" as const, text: "落库" },
      ] },
    ];
    expect(flowOutline(flow)).toBe("循环 files: 读文件、清洗 等");
    expect(flowOutline(flow)).toContain("循环");
  });

  it("多段用全角 ｜ 连接(不用 ASCII |,OFK 会替换)", () => {
    const flow = [
      { type: "branch" as const, cond: "c1", then: [{ type: "step" as const, text: "A" }], else: [] },
      { type: "loop" as const, over: "xs", body: [{ type: "step" as const, text: "B" }] },
    ];
    const out = flowOutline(flow);
    expect(out).toBe("分支: c1; 是→A ｜ 循环 xs: B");
    expect(out).not.toContain("|");
  });

  it("无 flow / 全是 step / 只有空 then-else 的 branch → 空串或不出分支内容", () => {
    expect(flowOutline(undefined)).toBe("");
    expect(flowOutline([])).toBe("");
    expect(flowOutline([{ type: "step", text: "a" }, { type: "step", text: "b" }])).toBe("");
  });

  it("flow 概述拼到 desc 末尾(summary ｜ outline),拼完再 clip", () => {
    const { ofk, warnings } = serializeBoard(
      mkDoc([
        mkNode("f1", "带流程", {
          summary: "打开缓存",
          flow: [{ type: "branch" as const, cond: "c", then: [{ type: "step" as const, text: "A" }], else: [] }],
        }),
      ]),
    );
    // desc 走 sanitize:ASCII `:` → `；`,并记一条 warning(既有行为,未改)
    expect(ofk).toContain('desc: "打开缓存 ｜ 分支； c; 是→A"');
    expect(warnings).toContain("node f1: summary 含 : 已替换");

    // 拼完超 120 字才截断(顺序:先拼、再 clip、再 sanitize)
    const long = "长".repeat(110);
    const r = serializeBoard(
      mkDoc([
        mkNode("f2", "超长", {
          summary: long,
          flow: [{ type: "loop" as const, over: "list", body: [{ type: "step" as const, text: "体".repeat(30) }] }],
        }),
      ]),
    );
    expect(r.warnings.some((w) => w.includes("截断"))).toBe(true);
  });
});

describe("结构化锚(symbolRef / targets 进 desc —— SVG 默认视图才看得见节点↔代码)", () => {
  it("symbolRef → ⟨符号名 @ 文件基名:行号⟩", () => {
    const { ofk } = serializeBoard(
      mkDoc([
        mkNode("n1", "提交任务", {
          summary: "把任务入队",
          symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 },
        } as Partial<NodeIn>),
      ]),
    );
    expect(ofk).toContain("⟨TaskSupervisor.submit @ task-manager.ts:60⟩");
    // 锚段接在 summary 之后,用 ` · ` 分隔
    expect(ofk).toContain('desc: "把任务入队 · ⟨TaskSupervisor.submit @ task-manager.ts:60⟩"');
  });

  it("targets → ⟨文件基名, 文件基名⟩(取路径基名,最多 2 个 +N)", () => {
    const { ofk } = serializeBoard(
      mkDoc([
        mkNode("n1", "面板", {
          summary: "面板实现",
          targets: ["apps/gateway/src/panel.ts", "apps/gateway/src/app.ts"],
        } as Partial<NodeIn>),
      ]),
    );
    expect(ofk).toContain("panel.ts");
    expect(ofk).toContain("app.ts");
    expect(ofk).toContain("⟨panel.ts, app.ts⟩");

    const r3 = serializeBoard(
      mkDoc([
        mkNode("n2", "三目标", {
          summary: "x",
          targets: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
        } as Partial<NodeIn>),
      ]),
    );
    expect(r3.ofk).toContain("⟨a.ts, b.ts +2⟩");
  });

  it("targets 值形如 path#symbol 时只出路径基名(不带 #fnName)", () => {
    const { ofk } = serializeBoard(
      mkDoc([mkNode("n1", "落点", { summary: "改函数", targets: ["apps/gateway/src/x.ts#fnName"] } as Partial<NodeIn>)]),
    );
    expect(ofk).toContain("⟨x.ts⟩");
    expect(ofk).not.toContain("#fnName");
  });

  it("无 targets/symbolRef → desc 与加锚前逐字一致(旧板零影响)", () => {
    const { ofk } = serializeBoard(mkDoc([mkNode("n1", "读配置", { summary: "打开配置文件" })]));
    expect(ofk).toContain('n1 [rect, label: "读配置", desc: "打开配置文件"]');

    const r = serializeBoard(mkDoc([mkNode("n2", "L", { summary: "" })]));
    expect(r.ofk).not.toContain("desc:");
  });

  it("锚段完整保留:summary 接近 120 字时从 summary 侧 clip,desc 总长 ≤ 120+锚", () => {
    const anchor = "⟨TaskSupervisor.submit @ task-manager.ts:60⟩";
    const { ofk, warnings } = serializeBoard(
      mkDoc([
        mkNode("n1", "超长", {
          summary: "长".repeat(200),
          symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 },
        } as Partial<NodeIn>),
      ]),
    );
    const line = ofk.split("\n").find((l) => l.trim().startsWith("n1 [")) ?? "";
    const desc = /desc: "([^"]*)"/.exec(line)?.[1] ?? "";
    expect(desc.endsWith(anchor)).toBe(true);
    expect(desc.length).toBeLessThanOrEqual(120 + anchor.length + 3);
    expect(warnings.some((w) => w.includes("截断"))).toBe(true);
  });

  it("锚段带 ⟨⟩ 的节点可被 flowkit 编译(无 W101/W102 丢行)", async () => {
    const { ofk } = serializeBoard(
      mkDoc([
        mkNode("n1", "提交", {
          summary: "s",
          symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 },
          targets: ["apps/gateway/src/panel.ts#PanelView"],
        } as Partial<NodeIn>),
      ]),
    );
    const diags = await compileDiags(ofk);
    expect(diags.filter((d) => d.code === "W101" || d.code === "W102")).toEqual([]);
  });
});

describe("边线型(kind / virtual → 箭头)", () => {
  it("contains→`--`(无箭头实线), verify/nav→`-->`(虚线), call/data→`->`", () => {
    const nodes = [mkNode("a", "A"), mkNode("b", "B", { group: "g" })];
    const { ofk } = serializeBoard(
      mkDoc(nodes, [
        { from: "a", to: "b", kind: "contains" } as never,
        { from: "a", to: "b", kind: "verify" } as never,
        { from: "a", to: "b", kind: "nav" } as never,
        { from: "a", to: "b", kind: "call" } as never,
        { from: "a", to: "b", kind: "data" } as never,
        { from: "a", to: "b", kind: "weird-unknown" } as never,
      ]),
    );
    const edgeLines = ofk.split("\n").map((l) => l.trim());
    // 2026-11 改动:线型断言仍按「箭头」判,但无 label 的边会带 kind 兜底关系词。
    expect(edgeLines).toContain("a -- b : 包含");
    expect(edgeLines).toContain("a --> b : 验证");
    expect(edgeLines).toContain("a --> b : 跳转");
    expect(edgeLines).toContain("a -> b : 调用");
    expect(edgeLines).toContain("a -> b : 数据");
    // kind 不在兜底表(weird-unknown)→ 保持裸边,不编造关系词
    expect(edgeLines).toContain("a -> b");
    // 线型计数(去 label 后):contains 1 条 `--`,verify+nav 2 条 `-->`,call/data/未知 3 条 `->`
    expect(edgeLines.filter((l) => l === "a -- b : 包含")).toHaveLength(1);
    expect(edgeLines.filter((l) => l.startsWith("a --> b"))).toHaveLength(2);
    expect(edgeLines.filter((l) => l.startsWith("a -> b"))).toHaveLength(3);
  });

  it("virtual:true 的 call 边升级成 `-->`,contains 不升级", () => {
    const { ofk } = serializeBoard(
      mkDoc([mkNode("a", "A"), mkNode("b", "B")], [
        { from: "a", to: "b", kind: "call", virtual: true } as never,
        { from: "a", to: "b", kind: "contains", virtual: true } as never,
      ]),
    );
    const lines = ofk.split("\n");
    // 2026-11 改动:virtual 边同样走 kind 兜底关系词
    expect(lines).toContain("a --> b : 调用");
    expect(lines).toContain("a -- b : 包含");
    expect(lines).not.toContain("a -> b");
  });

  it("label 逻辑不变:虚线边也写 ` : label`", () => {
    const { ofk } = serializeBoard(
      mkDoc([mkNode("a", "A"), mkNode("b", "B")], [{ from: "a", to: "b", kind: "verify", label: "验收产物" } as never]),
    );
    expect(ofk).toContain("a --> b : 验收产物");
  });
});

describe("全特性整板真喂 flowkit 编译(无 W101/W102/W106/W131)", () => {
  it("16 词 shape 全量 + 三色 + --> + -- + branch flow 的板,诊断里无丢行/未知属性", async () => {
    const kinds: Array<[string, string]> = [
      ["decision", "decision"],
      ["start", "start"],
      ["end", "end"],
      ["note", "note"],
      ["io", "io"],
      ["module", "module"],
      ["component", "component"],
      ["llm", "llm"],
      ["tool", "tool"],
      ["loop", "loop"],
      ["aggregate", "aggregate"],
      ["retrieval", "retrieval"],
      ["agent", "agent"],
      ["page", "page"],
      ["template", "template"],
      ["wf-notify", "wf-notify"],
      ["wf-parallel", "wf-parallel"],
      ["function", "function"],
    ];
    const changes = ["add", "modify", "delete", "keep"] as const;
    const nodes = kinds.map(([key], i) =>
      mkNode(`s${i}`, `形状${key}`, {
        kind: key as NodeIn["kind"],
        change: changes[i % changes.length],
        summary: `摘要${i}`,
        flow:
          i % 3 === 0
            ? [
                {
                  type: "branch" as const,
                  cond: `cond${i}`,
                  then: [
                    { type: "step" as const, text: "走真分支" },
                    { type: "step" as const, text: "再一步" },
                    { type: "step" as const, text: "第三步" },
                  ],
                  else: [{ type: "step" as const, text: "走假分支" }],
                },
                { type: "loop" as const, over: `items${i}`, body: [{ type: "step" as const, text: "循环体" }] },
              ]
            : [],
      }),
    );
    const edges = [
      { from: "s0", to: "s1", kind: "call", label: "主流程" },
      { from: "s1", to: "s2", kind: "verify", label: "验收" },
      { from: "s2", to: "s3", kind: "contains" },
      { from: "s3", to: "s4", kind: "nav", virtual: true as true },
      { from: "s4", to: "s5", kind: "call", virtual: true as true },
    ];
    const { ofk } = serializeBoard(mkDoc(nodes, edges as never));
    const diags = await compileDiags(ofk);
    const bad = diags.filter((d) => ["W101", "W102", "W106", "W131"].includes(d.code));
    expect(bad, `序列化输出:\n${ofk}\n诊断:${JSON.stringify(diags)}`).toEqual([]);
    // 三色都在,且 keep 节点无 color:
    expect(ofk).toContain("color: green");
    expect(ofk).toContain("color: orange");
    expect(ofk).toContain("color: red");
    // 三种线型都在:
    expect(ofk).toContain("s0 -> s1 : 主流程");
    expect(ofk).toContain("s1 --> s2 : 验收");
    expect(ofk).toContain("s2 -- s3");
    expect(ofk).toContain("s4 --> s5");
  });
});