/**
 * diagram-renderer(自有图渲染器)单测:
 * 解析子集与仓内生成器输出一一对应;布局确定性;SVG 结构契约;
 * 不可解析/超子集输入抛错(调用方降级 <pre> 契约)。
 */
import { describe, it, expect } from "vitest";
import OwnDiagram from "../src/assets/diagram-renderer.js";

describe("parse:flowchart 子集", () => {
  it("code2flow 风格(LR + subgraph + classDef + linkStyle + 边计数标签)", () => {
    const src = [
      "flowchart LR",
      '  subgraph g0["gateway"]',
      '  n0["▶ ◆ main<br/>main.ts:12"]',
      '  n1["boot<br/>app.ts:57"]',
      "  end",
      '  n2["store"]:::fLeaf',
      "  n0 -->|×3| n1",
      "  n1 -.->|bridge| n2",
      "  classDef fTrunk fill:#1a2b1a,stroke:#4f7f4f",
      "  class n0 fTrunk",
      "  style n2 stroke:#ffd27f,stroke-width:2px",
      "  linkStyle 1 stroke:#a98553",
    ].join("\n");
    const doc = OwnDiagram._parse(src);
    expect(doc.kind).toBe("flow");
    expect(doc.direction).toBe("LR");
    expect(doc.order).toEqual(["n0", "n1", "n2"]);
    expect(doc.edges).toEqual([
      { from: "n0", to: "n1", label: "×3", dashed: false, line: 0 },
      { from: "n1", to: "n2", label: "bridge", dashed: true, line: 1 },
    ]);
    expect(doc.subgraphs[0].title).toBe("gateway");
    expect(doc.subgraphs[0].order).toEqual(["n0", "n1"]);
    expect(doc.classDefs.fTrunk.fill).toBe("#1a2b1a");
    expect(doc.nodes.n0.cls).toEqual(["fTrunk"]);
    expect(doc.nodeStyles.n2.stroke).toBe("#ffd27f");
    expect(doc.linkStyles[1].stroke).toBe("#a98553");
  });

  it("节点四形:rect/胶囊/菱形/双圆 + 链式边 + init 头与注释", () => {
    const src = [
      '%%{init: {"flowchart": {"nodeSpacing": 26}}}%%',
      "flowchart TD",
      "  %% 说明注释",
      '  s(["开始"]) --> c{"条件?"}',
      '  c -->|是| m((合并))',
      '  c -->|否| act["动作"]',
      "  act --> c",
    ].join("\n");
    const doc = OwnDiagram._parse(src);
    expect(doc.nodes.s.shape).toBe("stadium");
    expect(doc.nodes.c.shape).toBe("diamond");
    expect(doc.nodes.m.shape).toBe("circle");
    expect(doc.edges.length).toBe(4);
    expect(doc.edges[3].from).toBe("act");
    expect(doc.edges[3].to).toBe("c");
  });

  it("未声明标签的隐式节点 + 无向线 ---|包含|", () => {
    const doc = OwnDiagram._parse(["flowchart TD", "  a ---|包含| b"].join("\n"));
    expect(doc.edges[0]).toMatchObject({ from: "a", to: "b", label: "包含", dashed: false });
    expect(doc.nodes.a.label).toBe("a");
  });

  it("超子集/坏输入抛错(降级契约)", () => {
    expect(() => OwnDiagram._parse("pie title x")).toThrow(/unsupported/);
    expect(() => OwnDiagram._parse("flowchart TD\n  这不是合法token!!")).toThrow(/unparsable/);
    expect(() => OwnDiagram._parse("")).toThrow();
  });
});

describe("parse:sequenceDiagram 与 stateDiagram-v2", () => {
  it("participant/箭头/自环/Note", () => {
    const src = [
      "sequenceDiagram",
      "  participant U as 用户",
      "  participant T as 任务",
      "  U->>T: 提交愿望",
      "  T-->>U: 完成回执",
      "  Note over T: 静态序≠运行序(异步边界 3 处)",
      "  T->>T: 自检",
    ].join("\n");
    const doc = OwnDiagram._parse(src);
    expect(doc.kind).toBe("sequence");
    expect(doc.participants.map((p) => p.name)).toEqual(["用户", "任务"]);
    expect(doc.messages[1].dashed).toBe(true);
    expect(doc.notes[0].over).toEqual(["T"]);
    expect(doc.messages[2].from).toBe("T");
  });

  it("stateDiagram-v2:转移 + 触发器 + [*] 起止", () => {
    const doc = OwnDiagram._parse([
      "stateDiagram-v2",
      "  [*] --> queued",
      "  queued --> running : 调度",
      "  running --> [*]",
    ].join("\n"));
    expect(doc.kind).toBe("flow");
    expect(doc.nodes.start.shape).toBe("stadium");
    expect(doc.edges[0].from).toBe("start");
    expect(doc.edges[1].label).toBe("调度");
    expect(doc.edges[2].to).toBe("end");
  });
});

describe("render:SVG 结构契约", () => {
  it("flow:节点分组 g.node#id(下钻兼容)/箭头 marker/classDef 落到属性/尺寸为正", () => {
    const src = [
      "flowchart LR",
      '  a["入口"] -->|×2| b["下游"]',
      "  b --> c",
      "  classDef ctr fill:#2a1c0e,stroke:#ffd27f",
      "  class a ctr",
    ].join("\n");
    const svg = OwnDiagram._renderSvg(src);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('class="dg-svg dg-flow dg-lr"');
    expect(svg).toContain('<g class="node" id="a">');
    expect(svg).toContain('<g class="node" id="b">');
    expect(svg).toContain('marker-end="url(#dg-arrow)"');
    expect(svg).toContain('fill="#2a1c0e"'); // classDef 应用于 a
    expect(svg).toContain("|×2|".replace("|", "").replace("|", "").slice(0, 0) + "×2"); // 边标签文本
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(Number(m[1])).toBeGreaterThan(0);
    expect(Number(m[2])).toBeGreaterThan(0);
  });

  it("TD 分层:后继节点 y 大于前驱;LR 后继 x 大于前驱", () => {
    const td = OwnDiagram._renderSvg("flowchart TD\n  a --> b");
    const yA = Number(td.match(/<g class="node" id="a">.*?<rect[^>]*?y="([\d.]+)"/s)[1]);
    const yB = Number(td.match(/<g class="node" id="b">.*?<rect[^>]*?y="([\d.]+)"/s)[1]);
    expect(yB).toBeGreaterThan(yA);
    const lr = OwnDiagram._renderSvg("flowchart LR\n  a --> b");
    const xA = Number(lr.match(/<g class="node" id="a">.*?<rect[^>]*?x="([\d.]+)"/s)[1]);
    const xB = Number(lr.match(/<g class="node" id="b">.*?<rect[^>]*?x="([\d.]+)"/s)[1]);
    expect(xB).toBeGreaterThan(xA);
  });

  it("虚线边带 dasharray;subgraph 框在场;主题切换改配色", () => {
    const src = "flowchart LR\n  a -.-> b\n  subgraph g[\"组\"]\n  b\n  end";
    const dark = OwnDiagram._renderSvg(src);
    expect(dark).toContain('stroke-dasharray="5 4"');
    expect(dark).toContain('fill="#140d06"'); // dark subBg
    expect(dark).toContain(">组</text>");
    return OwnDiagram.configure({ theme: "light" }).then(() => {
      const light = OwnDiagram._renderSvg(src);
      expect(light).toContain('fill="#f3ead9"'); // light subBg
      return OwnDiagram.configure({ theme: "dark" });
    });
  });

  it("sequence:参与者头 g.node + 生命线 + 虚线消息 + Note 框", () => {
    const svg = OwnDiagram._renderSvg([
      "sequenceDiagram",
      "  participant A as 服务",
      "  participant B as 客户端",
      "  B->>A: 请求",
      "  A-->>B: 响应",
      "  Note over A: 一次往返",
    ].join("\n"));
    expect(svg).toContain('class="dg-svg dg-sequence"');
    expect(svg).toContain('<g class="node" id="A">');
    expect(svg).toContain('stroke-dasharray="5 4"'); // A-->>B 虚线
    expect(svg).toContain("一次往返");
  });

  it("CFG 风格:init 头 + 注释 + 全形混排可渲染(真实生成器样本)", () => {
    const src = [
      '%%{init: {"flowchart": {"nodeSpacing": 26, "rankSpacing": 36, "curve": "basis"}}}%%',
      "%% my_func — src/x.py:1-40 · 语句 12 · 决策 3 · 复杂度 4",
      "flowchart TD",
      '  s(["my_func"])',
      '  n1["p = load()"]',
      '  d1{"p 为真?"}',
      '  n2["report[p] += 1"]',
      '  m((合并))',
      '  s --> n1 --> d1',
      "  d1 -->|是| n2",
      "  d1 -->|否| m",
      "  n2 --> m",
    ].join("\n");
    const svg = OwnDiagram._renderSvg(src);
    expect(svg).toContain('<g class="node" id="s">');
    expect(svg).toContain('<g class="node" id="d1">');
    expect(svg).toContain("polygon"); // 菱形
    expect(svg).toContain('rx="'); // 胶囊
    expect(svg).toContain("是");
  });
});

describe("run:占位管线语义", () => {
  it("渲染 data-src 源并清除 lazy 标记;失败抛错", () => {
    const { JSDOM } = (() => { try { return { JSDOM: null }; } catch { return { JSDOM: null }; } })();
    // 无 DOM 环境:手工构造最小元素壳
    const attrs = {};
    const el = {
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: (k) => { delete attrs[k]; },
      textContent: "",
      innerHTML: "",
      classList: { add: (c) => { attrs["class:" + c] = true; } },
    };
    el.setAttribute("data-src", "flowchart TD\n  a --> b");
    el.setAttribute("data-mermaid-lazy", "1");
    return OwnDiagram.run({ nodes: [el] }).then(() => {
      expect(el.innerHTML).toContain("<svg");
      expect(el.getAttribute("data-mermaid-lazy")).toBeNull();
      expect(attrs["class:dg-done"]).toBe(true);
      const bad = { getAttribute: () => "pie 坏语法", textContent: "", innerHTML: "", setAttribute() {}, removeAttribute() {}, classList: { add() {} } };
      return OwnDiagram.run({ nodes: [bad] }).then(() => { throw new Error("should reject"); }, (e) => {
        expect(String(e)).toMatch(/unsupported|unparsable/);
      });
    });
  });
});
