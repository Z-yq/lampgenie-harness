import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 折叠态被重渲染打回(用户用户反馈「点了折叠按钮,它自己会打开或关闭」)。
 * 面板 UI 全在 panel.ts 模板字符串内,这里直接读源码文本断言契约(同 annotate-panel-anchors 风格)。
 * 锁三件事:
 *  ① <details> 类折叠:总账 detOpen(按稳定 key 存用户意图)+ 重渲染后按 key 回填 open,
 *    不再靠「根序号 + 根内序号」回放,也不再从 DOM 现值(querySelectorAll("details[open]"))采集;
 *  ② 自研折叠(会话桶/白板泳道)按状态结构回填,状态不存 DOM;
 *  ③ 高频重渲染落点(工具卡/子代理目录/追踪卡)带显式 data-det-key,key 与内容变化无关。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../src/panel.ts"), "utf8");

describe("折叠态总账机制(<details> 类)", () => {
  it("总账 + 身份 key + 全局采集/回填在场", () => {
    expect(PANEL_SRC).toContain("const detOpen = new Map();");
    // key:显式 data-det-key 优先,缺省身份路径(祖先身份属性 + tag.class + 同型序号)
    expect(PANEL_SRC).toContain('function detKeyOf(d) { return d.getAttribute("data-det-key") || detPathOf(d); }');
    expect(PANEL_SRC).toContain("function detPathOf(d) {");
    expect(PANEL_SRC).toContain("const DET_ID_ATTRS = [");
    // 用户 toggle 采集(绑在节点上,一次)
    expect(PANEL_SRC).toContain("detOpen.set(detKeyOf(d), d.open);");
    expect(PANEL_SRC).toContain('d.addEventListener("toggle", detOnToggle);');
    // 新插入节点按 key 回填(重渲染后不会打回用户的开合)
    expect(PANEL_SRC).toContain("if (detOpen.has(k) && d.open !== !!detOpen.get(k)) d.open = !!detOpen.get(k);");
    expect(PANEL_SRC).toContain("function detBindIn(root) {");
    expect(PANEL_SRC).toContain("new MutationObserver(");
    expect(PANEL_SRC).toContain("detBindIn(n)");
  });

  it("两条重建路径都读总账,不回放序号", () => {
    // 增量 patch:删前采集 → 插后回填
    expect(PANEL_SRC).toContain("for (let i = 0; i < delN; i++) openIdxOf(body.children[p + i]);");
    expect(PANEL_SRC).toContain("for (const r of roots) detBindIn(r);");
    // 整列重建:采集 → innerHTML → 回填
    expect(PANEL_SRC).toContain("mfCaptureOpenAll(mfBody);");
    expect(PANEL_SRC).toContain("for (const r of mfRoots) detBindIn(r);");
    // 旧的序号回放口径已下架(它就是「parts 数量一变,折叠就错位/自己开合」的根因)
    expect(PANEL_SRC).not.toContain("applyOpenIdx");
    expect(PANEL_SRC).not.toContain("openByLocal");
  });

  it("高频重渲染落点带显式 data-det-key(与内容变化无关)", () => {
    // 工具调用卡 / 工具结果卡:key 取调用 id
    expect(PANEL_SRC).toContain('const detK = "tool-call:" + (String(c.id || "") || name + ":" + String(c.arguments || "").slice(0, 80));');
    expect(PANEL_SRC).toContain('const detK = "tool-res:" + (String(detKey || "") || (name || "") + ":" + String(argsRaw || "").slice(0, 80));');
    expect(PANEL_SRC.split("esc(detK)").length - 1).toBeGreaterThanOrEqual(2);
    // 子代理目录条目(3s 轮询整表重建)
    expect(PANEL_SRC).toContain('esc("subdir:" + en.agentId)');
    // 追踪卡阶段(跟踪视图定时重渲)
    expect(PANEL_SRC).toContain('esc("tkph:" + String(t.taskId || "") + ":" + k)');
    // 白板:语义流程 + 验收证据详情
    expect(PANEL_SRC).toContain('esc("flow:" + String(n.id || ""))');
    expect(PANEL_SRC).toContain('esc("bdev:" + String(n.id || "") + ":" + a.cmd)');
  });

  it("不再从 DOM 现值读折叠态(负面)", () => {
    expect(PANEL_SRC).not.toContain('querySelectorAll("details.sd-item[open]")');
    expect(PANEL_SRC).not.toContain("querySelectorAll('details[open]')");
  });
});

describe("自研折叠按状态结构回填", () => {
  it("会话桶折叠:bucketCollapsed(Set,localStorage 持久)驱动渲染", () => {
    expect(PANEL_SRC).toContain("const bucketCollapsed = new Set(");
    expect(PANEL_SRC).toContain("const collapsed = bucketCollapsed.has(b.key);");
    expect(PANEL_SRC).toContain('localStorage.setItem("zh:bucket-collapse"');
  });
  it("白板泳道/计数块折叠:cvFoldOpen(Set)驱动渲染", () => {
    expect(PANEL_SRC).toContain("cvFoldOpen");
    expect(PANEL_SRC).toContain("cvFoldOpen.has(lane.key)");
  });
});

/** 抽真实代码段 + 最小 DOM 桩真跑(本仓 vitest 是 node 环境,无 jsdom;桩只实现被调接口)。 */
type StubEl = {
  nodeType: number; tagName: string; className: string; attrs: Record<string, string>;
  children: StubEl[]; parentElement: StubEl | null; open: boolean;
  getAttribute(n: string): string | null; addEventListener(t: string, fn: (ev: unknown) => void): void;
  fire(t: string, ev: unknown): void; querySelectorAll(sel: string): StubEl[];
};
function mk(tag: string, attrs: Record<string, string> = {}, kids: StubEl[] = [], cls = ""): StubEl {
  const el: StubEl = {
    nodeType: 1, tagName: tag.toUpperCase(), className: cls, attrs: { ...attrs }, children: [], parentElement: null,
    open: Object.prototype.hasOwnProperty.call(attrs, "open"), getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
    addEventListener(t, fn) { ((this as unknown as { l?: Record<string, ((ev: unknown) => void)[]> }).l ||= {})[t] = [...(((this as unknown as { l?: Record<string, ((ev: unknown) => void)[]> }).l || {})[t] || []), fn]; },
    fire(t, ev) { for (const fn of (((this as unknown as { l?: Record<string, ((ev: unknown) => void)[]> }).l || {})[t] || [])) fn(ev); },
    querySelectorAll(sel) {
      const out: StubEl[] = [];
      const walk = (n: StubEl) => { for (const c of n.children) { if (sel === "details" ? c.tagName === "DETAILS" : false) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
  };
  for (const k of kids) { k.parentElement = el; el.children.push(k); }
  return el;
}

/** 从 panel.ts 抽「折叠态总账」段真实代码,在桩 DOM 上执行(证明契约真的按 key 回填)。 */
function loadMechanism(): { detOpen: Map<string, boolean>; detKeyOf: (d: StubEl) => string; detOnToggle: (ev: unknown) => void; detBindIn: (r: StubEl) => void } {
  const start = PANEL_SRC.indexOf("// ── 折叠态总账");
  expect(start).toBeGreaterThan(-1);
  const endMark = "detWatch();";
  const end = PANEL_SRC.indexOf(endMark, start);
  expect(end).toBeGreaterThan(start);
  const src = PANEL_SRC.slice(start, end + endMark.length);
  const factory = new Function("document", src + "; return { detOpen, detKeyOf, detOnToggle, detBindIn };");
  return factory({ body: null }); // MutationObserver 缺席/无 body = 不自动挂观察器,由用例显式调 detBindIn
}

describe("折叠态回填(抽真实代码 + 桩 DOM 真跑)", () => {
  it("用户展开 → 数据重渲染(同 key 无 open)→ 仍展开", () => {
    const { detOpen, detOnToggle, detBindIn } = loadMechanism();
    const host = mk("div", {}, []);
    // 首帧
    const first = mk("details", { "data-det-key": "tool-call:c1" }, [], "tool-card");
    host.children.push(first); first.parentElement = host;
    detBindIn(host);
    expect(first.open).toBe(false);
    // 用户点开(浏览器会派 toggle)
    first.open = true;
    first.fire("toggle", { currentTarget: first });
    expect(detOpen.get("tool-call:c1")).toBe(true);
    // 下一帧轮询回包:整列重建,新节点不带 open
    host.children = []; host.children.push(mk("details", { "data-det-key": "tool-call:c1" }, [], "tool-card"));
    host.children[0].parentElement = host;
    detBindIn(host);
    expect(host.children[0].open).toBe(true); // 不再「自己关上」
  });

  it("用户收起默认展开的卡 → 重渲染仍带 open 属性 → 仍收起", () => {
    const { detOnToggle, detBindIn } = loadMechanism();
    const host = mk("div", {}, []);
    const first = mk("details", { "data-det-key": "tool-call:c2", open: "open" }, [], "tool-card");
    host.children.push(first); first.parentElement = host;
    detBindIn(host);
    expect(first.open).toBe(true);
    first.open = false;
    first.fire("toggle", { currentTarget: first });
    host.children = []; host.children.push(mk("details", { "data-det-key": "tool-call:c2", open: "open" }, [], "tool-card"));
    host.children[0].parentElement = host;
    detBindIn(host);
    expect(host.children[0].open).toBe(false); // 渲染侧默认 open 不会把用户的收起打回
    void detOnToggle;
  });

  it("同父上方插入新卡(序号全变):按 key 恢复,不按序号", () => {
    const { detOnToggle, detBindIn } = loadMechanism();
    const host = mk("div", {}, []);
    for (const k of ["a", "b"]) { const d = mk("details", { "data-det-key": k }, [], "tool-card"); host.children.push(d); d.parentElement = host; }
    detBindIn(host);
    host.children[1].open = true;
    host.children[1].fire("toggle", { currentTarget: host.children[1] }); // 用户展开 b
    // 重渲染:上方新增一张卡(a 序号变 0→1, b 变 1→2)
    const rebuilt = ["x", "a", "b"].map((k) => mk("details", { "data-det-key": k }, [], "tool-card"));
    host.children = [];
    for (const d of rebuilt) { d.parentElement = host; host.children.push(d); }
    detBindIn(host);
    expect(host.children.map((d) => d.open)).toEqual([false, false, true]); // 只有 b 保持展开
    void detOnToggle;
  });

  it("无显式 key:按身份路径(祖先身份属性)区分同型兄弟", () => {
    const { detOnToggle, detBindIn, detKeyOf } = loadMechanism();
    const host = mk("div", {}, []);
    const cardA = mk("div", { "data-agent": "ag-1" }, [], "sub-card");
    const dA = mk("details", {}, [], "tr-more");
    cardA.children.push(dA); dA.parentElement = cardA;
    const cardB = mk("div", { "data-agent": "ag-2" }, [], "sub-card");
    const dB = mk("details", {}, [], "tr-more");
    cardB.children.push(dB); dB.parentElement = cardB;
    host.children.push(cardA, cardB);
    detBindIn(host);
    expect(detKeyOf(dA)).not.toBe(detKeyOf(dB)); // 同型 sibling 不撞 key
    expect(detKeyOf(dA)).toContain("data-agent=ag-1");
    dA.open = true;
    dA.fire("toggle", { currentTarget: dA });
    // 重渲染:整列新树,身份属性不变
    const host2 = mk("div", {}, []);
    const a2 = mk("div", { "data-agent": "ag-1" }, [], "sub-card");
    const dA2 = mk("details", {}, [], "tr-more"); a2.children.push(dA2); dA2.parentElement = a2;
    const b2 = mk("div", { "data-agent": "ag-2" }, [], "sub-card");
    const dB2 = mk("details", {}, [], "tr-more"); b2.children.push(dB2); dB2.parentElement = b2;
    host2.children.push(a2, b2);
    expect(detKeyOf(dA2)).toBe(detKeyOf(dA));
    detBindIn(host2);
    expect([dA2.open, dB2.open]).toEqual([true, false]);
    void detOnToggle;
  });

  it("首帧无记录:不强行改渲染侧默认(默认展开的留展开,默认收起的留收起)", () => {
    const { detBindIn } = loadMechanism();
    const host = mk("div", {}, [
      mk("details", { "data-det-key": "keep-open", open: "open" }),
      mk("details", { "data-det-key": "keep-closed" }),
    ]);
    detBindIn(host);
    expect([host.children[0].open, host.children[1].open]).toEqual([true, false]);
  });
});

