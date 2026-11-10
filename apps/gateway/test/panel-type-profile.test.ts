/** 非 page 板型画布接入契约:
 * 板型画像资产/顶部类型头/节点卡角色+硬规则 chip+flow 分支/卡尺寸按板型放大。
 * 从真实面板 HTML 提取函数执行,不启浏览器。 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";
import BTP from "../src/assets/board-type-profile.js";

const NL = String.fromCharCode(10);

function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}
async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => {});
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally { await srv.close(); }
}

describe("非 page 板型画布画像", () => {
  it("资产/类型头/节点条/板型卡尺寸都在真实面板里", async () => {
    await withPanel(7897, async (html) => {
      expect(html).toContain('<script src="/assets/board-type-profile.js"></script>');
      expect(html).toContain("cvTypeHeadHtml(doc, cvFlowInfo)");
      expect(html).toContain("cvTypeNodeHtml(n, doc, cvFlowInfo)");
      expect(html).toContain("nodeW: tprof ? (cvCodeInfo ? 260 : 228)");
      expect(html).toContain("nodeH: tprof ? (cvCodeInfo ? (cvCodeFlowMode ? 176 : (typedHasFlow ? 162 : 150)) : (typedHasFlow ? 150 : 136))");
      expect(html).toContain(".cv-type-head{");
      expect(html).toContain(".cv-type-stage");
      expect(html).toContain(".cv-type-chip.t-role");
      expect(html).toContain(".cv-type-flow");
      const a = await fetch("http://127.0.0.1:7897/assets/board-type-profile.js");
      expect(a.status).toBe(200);
      expect(await a.text()).toContain("BoardTypeProfile");
    });
  }, 30_000);

  it("类型头:板型/规模/阶段覆盖/缺口;节点条:角色/证据/flow 分支", async () => {
    await withPanel(7898, (html) => {
      const src = [extractFn(html, "cvTypeProfileOf"), extractFn(html, "cvTypeHeadHtml"), extractFn(html, "cvTypeNodeHtml")].join(NL);
      const api = new Function("esc", "BoardTypeProfile", src + NL + "return { profile: cvTypeProfileOf, head: cvTypeHeadHtml, node: cvTypeNodeHtml };")(
        (s: unknown) => String(s), BTP) as {
        profile: (d: unknown) => unknown;
        head: (d: unknown, info: unknown) => string;
        node: (n: unknown, d: unknown, info: unknown) => string;
      };
      const doc = {
        boardType: "fault",
        scale: "M",
        nodes: [
          { id: "repro", kind: "function", label: "复现条件", summary: "版本/输入", group: "01 复现", change: "keep", flow: [] },
          { id: "root", kind: "function", label: "根因:全量重放阻塞事件循环", summary: "trace 证据", group: "04 根因", change: "keep", evidence: [{ at: "x", cmd: "grep", expect: "ok" }], flow: [{ type: "branch", cond: "x", then: [{ type: "step", text: "A" }], else: [{ type: "step", text: "B" }] }] },
        ],
        edges: [],
      };
      expect(api.profile({ boardType: "ui" })).toBeNull();
      const head = api.head(doc, null);
      expect(head).toContain("排障/修复");
      expect(head).toContain(">M<");
      expect(head).toContain("根因");
      expect(head).toContain("缺");
      const node = api.node(doc.nodes[1], doc, null);
      expect(node).toContain("根因");
      expect(node).toContain("证据");
      expect(node).toContain("分支");
      expect(node).toContain("if x");
      expect(api.node({ id: "x", label: "无板型", summary: "x", flow: [] }, { nodes: [] }, null)).toBe("");
    });
  }, 30_000);

  it("code flow 画像口径与面板布局判定对齐(无 start/end 也切代码流程画像)", () => {
    const btp = BTP as { profileOf: (d: unknown) => { short?: string; label?: string } | null };
    // ①decision → 代码流程画像(否则布局进了 flow、顶部画像还在现状层/变更层 → 误报缺段)
    const dec = btp.profileOf({ boardType: "code", nodes: [{ id: "a", kind: "module", flow: [] }, { id: "b", kind: "decision", flow: [] }] });
    expect(dec).not.toBeNull();
    expect(dec && dec.short).toBe("CODEFLOW");
    // ②步骤过半数带 flow 行 → 代码流程画像
    const flowy = btp.profileOf({ boardType: "code", nodes: [{ id: "a", kind: "function", flow: [{ type: "step", text: "x" }] }, { id: "b", kind: "function", flow: [] }] });
    expect(flowy && flowy.short).toBe("CODEFLOW");
    // ③变更契约板(无 flow/decision/start/end)画像不变
    const contract = btp.profileOf({ boardType: "code", nodes: [{ id: "a", kind: "module", flow: [] }, { id: "b", kind: "function", flow: [] }] });
    expect(contract && contract.short).not.toBe("CODEFLOW");
  });
});
