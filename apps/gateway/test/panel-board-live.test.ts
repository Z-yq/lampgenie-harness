/**
 * 白板执行期可见化(n1/n2/A3)契约测试 —— 锁住「执行中的板能看出落在哪、验到哪」这条面:
 *  ①板头 P0 覆盖率 + 证据计数 + 未通过数(<100% 醒目色);
 *  ②节点卡/明细卡 accept 逐条(command/expect/三态徽标)+ evidence 输出摘要;
 *  ③无边板(零边设计板)按 node.group(缺则 kind 族)走泳道回退 + 声明顺序编号;
 *  ④节点卡清单默认展开(不再折叠);
 *  ⑤证据/验收状态进结构签名(cvStructSig)——否则 board.changed 回填证据后画面不刷新。
 * 页面函数从真实面板 HTML 提取(花括号配平,与 panel-canvas-fixes.test.ts 同构)后 new Function 执行,
 * 既断源码关键字也跑真实语义(MVP 行为)。零反斜杠纪律:全部 includes 字面断言。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** 从面板 HTML 里切出顶层函数源码(花括号配平)。 */
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

const NL = String.fromCharCode(10);

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 纯静态:不接 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("白板执行期可见化(n1/n2/A3)", () => {
  it("①板头:P0 覆盖率 + 证据数 + 未通过数,<100% 用醒目(short)色,100% 转 full", async () => {
    await withPanel(7951, (html) => {
      // 板头 meta 行必须挂上 P0 徽标段
      const meta = extractFn(html, "cvMetaHtml");
      expect(meta).toContain("bdP0Tags(doc)");
      const tags = extractFn(html, "bdP0Tags");
      // 覆盖率文案与百分比(格式化会折行,按片段断不按整行断)
      expect(tags).toContain(">P0 ");
      expect(tags).toContain('st.passed + "/" + st.total');
      expect(tags).toContain('pct + "%)');
      // 证据计数
      expect(tags).toContain("证据 ");
      expect(tags).toContain("st.evidence");
      // 未通过数(只在 >0 时出)
      expect(tags).toContain("未通过 ");
      expect(tags).toContain("st.failed > 0");
      // 醒目色:未满=short 赭红,满=full 全绿
      expect(tags).toContain('full ? " full" : " short"');
      expect(html).toContain(".bd-tag.bd-p0{");
      expect(html).toContain(".bd-tag.bd-p0.full{");
      // 覆盖率数据源:passed/total + 有 ok=true 证据的条数
      const st = extractFn(html, "bdP0Stats");
      expect(st).toContain('n.phase === "P0"');
      expect(st).toContain("evidence += st.pass");
      // 行为:2 个 P0 节点,1 个全通过 → passed/total=1/2,证据条数=1(另一条未验证)
      const src = extractFn(html, "bdAccState") + NL + extractFn(html, "bdAccStats") + NL + st;
      const f = new Function(src + NL + "return bdP0Stats;")( ) as (d: unknown) => { total: number; passed: number; evidence: number; failed: number };
      const doc = {
        nodes: [
          { id: "a", phase: "P0", accept: [{ cmd: "x" }], evidence: [{ cmd: "x", ok: true }] },
          { id: "b", phase: "P0", accept: [{ cmd: "y" }], evidence: [] },
          { id: "c", accept: [{ cmd: "z" }], evidence: [{ cmd: "z", ok: true }] },
        ],
      };
      expect(f(doc)).toEqual({ total: 2, passed: 1, evidence: 1, failed: 1 });
    });
  }, 30_000);

  it("②节点卡与明细卡:accept 逐条(command/expect/三态徽标)+ evidence 输出摘要", async () => {
    await withPanel(7952, (html) => {
      // 三态徽标文案与配色:通过/未通过/未验证
      const cn = extractFn(html, "bdAccStateCn");
      expect(cn).toContain('st === "pass" ? "通过"');
      expect(cn).toContain('st === "fail" ? "未通过"');
      expect(cn).toContain('"未验证"');
      const cls = extractFn(html, "bdAccStateCls");
      expect(cls).toContain("lk-linked");
      expect(cls).toContain("lk-broken");
      expect(cls).toContain("lk-moved");
      // 节点卡清单卡:cmd + expect + 三态徽标 + 证据摘要
      const card = extractFn(html, "bdAccCardHtml");
      expect(card).toContain("bd-acc-st");
      expect(card).toContain("bdAccStateCn(st)");
      expect(card).toContain("bd-acc-cmd");
      expect(card).toContain("bd-acc-exp");
      expect(card).toContain("期望:");
      expect(card).toContain("bd-ev");
      expect(card).toContain("证据 ");
      // 明细卡:同一套三态 + 证据输出(超 200 字折叠 details)
      const det = extractFn(html, "bdAccDetailHtml");
      expect(det).toContain("bdAccStateCn(st)");
      expect(det).toContain("bd-acc-cmd");
      expect(det).toContain("bd-acc-exp");
      expect(det).toContain("bd-ev-full");
      expect(det).toContain("200");
      // 两处都真的挂进渲染链(卡清单 + 明细)
      expect(extractFn(html, "renderBoard")).toContain("bdAccCardHtml(n)");
      expect(html).toContain("h += bdAccDetailHtml(n);");
      // 行为:三态判定(pass / fail / none)
      const st = extractFn(html, "bdAccState");
      const f = new Function(st + NL + "return bdAccState;")() as (n: unknown, cmd: string) => string;
      const n = { evidence: [{ cmd: "a", ok: true }, { cmd: "b", ok: false }] };
      expect(f(n, "a")).toBe("pass");
      expect(f(n, "b")).toBe("fail");
      expect(f(n, "c")).toBe("none");
      // 同一 cmd 既有 fail 又有 ok → 通过优先(与 board-accept 同口径)
      expect(f({ evidence: [{ cmd: "a", ok: false }, { cmd: "a", ok: true }] }, "a")).toBe("pass");
    });
  }, 30_000);

  it("③无边板回退:cvFlowEligible 假 → bdLaneEligible 走泳道,按 node.group(缺则 kind)分组 + 顺序编号", async () => {
    await withPanel(7953, (html) => {
      // 回退触发条件:有边/阶段卡走引擎;无边走泳道
      const elig = extractFn(html, "bdLaneEligible");
      expect(elig).toContain("return !cvFlowEligible(doc)");
      expect(elig).toContain('doc.docKind === "page"');
      // 渲染分流:renderBoardCanvas 里有独立分支
      const rc = extractFn(html, "renderBoardCanvas");
      expect(rc).toContain("} else if (bdLaneEligible(doc)) {");
      expect(rc).toContain("bdFallbackLanes(doc)");
      // 泳道产物与流动引擎同形(mode=flow,渲染层零改动复用)
      const fb = extractFn(html, "bdFallbackLanes");
      expect(fb).toContain('mode: "flow"');
      expect(fb).toContain("laneOf");
      expect(fb).toContain("bdLaneGroups(doc)");
      expect(fb).toContain("no.set(id,");
      // 分组依据:group 优先,缺则 kind 族
      const grp = extractFn(html, "bdLaneGroups");
      expect(grp).toContain('String(n.group || "").trim()');
      expect(grp).toContain('"kind:" + String(n.kind || "module")');
      // 编号按声明顺序 01..N
      expect(grp).toContain("g.no = (i + 1 < 10 ? \"0\" : \"\") + (i + 1)");
      // 行为:同 group 归一条泳道,缺 group 的按 kind 单独成道,顺序=声明顺序
      const f = new Function('const CV_KIND_NAME = { module: "模块", tool: "工具" };' + NL + grp + NL + "return bdLaneGroups;")() as
        (d: unknown) => { key: string; label: string; no: string; ids: string[] }[];
      const gs = f({ nodes: [
        { id: "a", kind: "module", group: "前端" },
        { id: "b", kind: "tool" },
        { id: "c", kind: "module", group: "前端" },
      ] });
      expect(gs.map((g) => g.no)).toEqual(["01", "02"]);
      expect(gs[0]!.ids).toEqual(["a", "c"]);
      expect(gs[0]!.label).toBe("前端");
      expect(gs[1]!.key).toBe("kind:tool");
      expect(gs[1]!.label).toBe("工具"); // kind 族回退用中文名
    });
  }, 30_000);

  it("④节点卡清单默认展开(不再折叠)", async () => {
    await withPanel(7954, (html) => {
      // details 带 open 属性 = 默认展开;标题点明含验收三态与证据摘要
      expect(html).toContain('<details class="board-nodes-box" id="boardNodesBox" open>');
      expect(html).toContain("含验收三态与证据摘要");
      // 不再有「去掉 open」的开关路径:全仓只有这一处 boardNodesBox
      const hits = html.split("boardNodesBox").length - 1;
      expect(hits).toBe(1);
      // 渲染链:卡清单按泳道分组渲染(无边板也分组),不是平铺一串
      const rb = extractFn(html, "renderBoard");
      expect(rb).toContain("bdLaneGroups(doc)");
      expect(rb).toContain('class="bd-grp"');
    });
  }, 30_000);

  it("⑤结构签名含 accept/evidence:P0 覆盖与三态指纹进 cvStructSig,board.changed 回填后必刷新", async () => {
    await withPanel(7955, (html) => {
      const sig = extractFn(html, "cvStructSig");
      // 节点维度:accept/evidence 指纹
      expect(sig).toContain("cvAccSig(n)");
      // 板维度:P0 覆盖(passed/total/evidence)进签名
      expect(sig).toContain("bdP0Stats(doc).passed");
      expect(sig).toContain("bdP0Stats(doc).total");
      expect(sig).toContain("bdP0Stats(doc).evidence");
      // 指纹函数:accept 条数 + cmd 摘要 + evidence 条数 + ok 数
      const acc = extractFn(html, "cvAccSig");
      expect(acc).toContain("n.accept");
      expect(acc).toContain("n.evidence");
      expect(acc).toContain("e.ok === true");
      // 行为:证据回填后签名必须变(否则增量补丁把「未验证」钉死在卡上)
      const f = new Function(acc + NL + "return cvAccSig;")() as (n: unknown) => string;
      const before = f({ accept: [{ cmd: "pnpm test" }], evidence: [] });
      const after = f({ accept: [{ cmd: "pnpm test" }], evidence: [{ cmd: "pnpm test", ok: true }] });
      expect(before).toBe("a1:pnpm test/e0:0");
      expect(after).toBe("a1:pnpm test/e1:1");
      expect(before).not.toBe(after);
      // 空验收/空证据 = "0"(不为无验收节点膨胀签名)
      expect(f({})).toBe("0");
      // 增量补丁也必须原位更新三态徽标(签名同构时的兜底)
      expect(extractFn(html, "cvPatchCanvas")).toContain("bdAccStats(n)");
    });
  }, 30_000);

  it("⑥白板画布卡一级操作条:卡头含 bdCardEdit/bdCardComment 按钮并绑到既有入口", async () => {
    await withPanel(7966, (html) => {
      // 按钮 HTML 单一出处(bdCardActionsHtml),id 与语义标签都在
      const acts = extractFn(html, "bdCardActionsHtml");
      expect(acts).toContain('id="bdCardEdit"');
      expect(acts).toContain('id="bdCardComment"');
      expect(acts).toContain("按板续作"); // 第三个=复用既有「按板续作」动作(不新造)
      expect(acts).toContain('data-act="board-edit"');
      expect(acts).toContain('data-act="board-comment"');
      // 注入器:落到 board 卡卡头(不放视图头/浮窗头这些次级位置)
      const inject = extractFn(html, "bdCanvasCardActions");
      expect(inject).toContain('.cv-card[data-name="board"]');
      expect(inject).toContain(".cv-card-head");
      expect(inject).toContain(".cv-card-tools");
      // onclick 绑定存在,且「编辑」走既有 boardEditToggle 单一入口(不另开一套编辑态)
      expect(inject).toContain('acts.querySelector("#bdCardEdit")');
      expect(inject).toContain("boardEditToggle()");
      expect(inject).toContain('acts.querySelector("#bdCardComment")');
      expect(inject).toContain("boardCommentToggle()");
      expect(inject).toContain('acts.querySelector("#bdCardContinue")');
      expect(inject).toContain("boardContinue()");
      // 与既有入口同源(不是复制一套实现):视图头/浮窗头仍是同一函数
      expect(html).toContain('$("boardEditBtn").onclick = () => boardEditToggle()');
      expect(html).toContain('$("bfEdit").onclick = () => boardEditToggle()');
      // 样式面:操作条与卡头同风格(vw-act 小号),离屏/LOD 折叠态不占位
      expect(html).toContain(".cv-card-acts{");
      expect(html).toContain("body.cv-lod .cv-card-acts{display:none}");
    });
  }, 30_000);

  it("⑦节点卡「评 N」徽标有 click 处理器(不必先选中节点直开评论框)", async () => {
    await withPanel(7967, (html) => {
      // 徽标 DOM 仍在节点卡/页面容器/线框卡三处(既有结构不变,只是多了入口语义)
      const rc = extractFn(html, "renderBoardCanvas");
      expect(rc).toContain("cv-cmts");
      expect(rc).toContain(">评 ");
      // 处理器:在节点绑定循环里对 .cv-cmts 逐个挂 onclick → bdOpenNodeComment(同节点)
      expect(rc).toContain('el.querySelectorAll(".cv-cmts")');
      expect(rc).toContain("bdOpenNodeComment(el.dataset.cv");
      // 徽标点击不得冒泡成「选中节点」以外的副作用(必须 stopPropagation)
      expect(rc).toContain("e.stopPropagation()");
      // 评论框复用既有协议与既有标记(#bdCmtInput/#bdCmtSend + board.comment),不另造协议
 // c1:协议字面量到单一发送出处 bdSendComment(append/update/delete 共用),浮层只调它
      const open = extractFn(html, "bdOpenNodeComment");
      expect(open).toContain("bdCmtInput");
      expect(open).toContain("bdCmtSend");
      expect(open).toContain('bdSendComment({ op: "append"');
      expect(open).toContain("nodeId: n.id");
      expect(extractFn(html, "bdSendComment")).toContain('type: "board.comment"');
    });
  }, 30_000);

  it("⑧评论模式状态 + 「进入评论模式后点节点直接开框」判定可执行且行为正确", async () => {
    await withPanel(7968, (html) => {
      // 状态声明 + 开关函数(切换走同一状态位)
      expect(html).toContain("let boardCommentMode = false;");
      const tog = extractFn(html, "boardCommentToggle");
      expect(tog).toContain("boardCommentMode = next");
      expect(tog).toContain("renderBoard()");
      // 判定抽成纯函数:可直接执行(不碰 DOM/全局态)
      const hit = extractFn(html, "bdCommentHit");
      const f = new Function(hit + NL + "return bdCommentHit;")() as
        (mode: boolean, ro: boolean, nodeId: string, inFile: boolean) => boolean;
      // 评论模式开 + 点到节点 → 开框
      expect(f(true, false, "n1", false)).toBe(true);
      // 评论模式关 → 点节点仍走原「选中看明细」行为(不劫持)
      expect(f(false, false, "n1", false)).toBe(false);
      // 只读画布(设计沉淀)不写评论
      expect(f(true, true, "n1", false)).toBe(false);
      // 点在代码档案链接上 = 跳转动作,不开框
      expect(f(true, false, "n1", true)).toBe(false);
      // 空 node id(点空白/点的不是节点)不开框
      expect(f(true, false, "", false)).toBe(false);
      // 评论模式位进结构签名:否则同签名下增量补丁不重建 DOM,新增节点的徽标点击处理器会缺
      const sig = extractFn(html, "cvStructSig");
      expect(sig).toContain("boardCommentMode");
      // 评论数进签名:徽标从隐藏→可见时必须全量重建(增量路径只改文案不改处理器)
      expect(sig).toContain("n.comments && n.comments.length");
    });
  }, 30_000);

  it("⑦明细卡「关系」段(n10):出边/入边逐条 + kind 中文名 + virtual→推导徽标 + 孤立节点明说", async () => {
    await withPanel(7971, (html) => {
      // 节点头计数 + 无连线提示(孤立节点是有用信息,不隐藏)
      expect(html).toContain("关系 · 出 ");
      expect(html).toContain(" / 入 ");
      expect(html).toContain("孤立节点(无连线)");
      expect(html).toContain("出边 ");
      expect(html).toContain("入边 ");
      // 边关系类型单独一张小表(不混用节点 kind 的 CV_KIND_NAME)
      expect(html).toContain("const BD_REL_KIND_NAME = { call:");
      expect(html).toContain('call: "调用"');
      expect(html).toContain('data: "数据流"');
      expect(html).toContain('verify: "验收"');
      expect(html).toContain('nav: "次序"');
      expect(html).toContain('contains: "包含"');
      // 挂进明细卡,且在验收证据之后、评论区之前
      const det = extractFn(html, "renderBoardDetail");
      const iAcc = det.indexOf("bdAccDetailHtml(n)");
      const iRel = det.indexOf("bdRelHtml(boardDoc, n.id)");
      const iCmt = det.indexOf("用户评论");
      expect(iAcc).toBeGreaterThan(0);
      expect(iRel).toBeGreaterThan(iAcc);
      expect(iCmt).toBeGreaterThan(iRel);
      // virtual 徽标分支
      const rel = extractFn(html, "bdRelHtml");
      expect(rel).toContain("e.virtual === true");
      expect(rel).toContain("自动推导待核实");
      expect(rel).toContain(">推导<");
      expect(rel).toContain("e.from === id");
      expect(rel).toContain("e.to === id");
      // 行为:出/入各一条 + 边标签 + 推导徽标只挂 virtual 边;目标名查不到时回退 id
      const kindTbl = "const BD_REL_KIND_NAME = { call: \"调用\", data: \"数据流\", verify: \"验收\", nav: \"次序\", contains: \"包含\" };";
      const src = extractFn(html, "esc") + NL + kindTbl + NL + extractFn(html, "bdRelKindCn") + NL + rel;
      const f = new Function(src + NL + "return { bdRelHtml: bdRelHtml, bdRelKindCn: bdRelKindCn };")( ) as {
        bdRelHtml: (d: unknown, id: string) => string;
        bdRelKindCn: (k: string) => string;
      };
      expect(f.bdRelKindCn("call")).toBe("调用");
      expect(f.bdRelKindCn("contains")).toBe("包含");
      const doc = {
        nodes: [{ id: "a", label: "入口模块" }, { id: "b", label: "落库模块" }],
        edges: [
          { from: "a", to: "b", kind: "call", label: "调用 createGatewayApp" },
          { from: "x", to: "a", kind: "data" },
          { from: "a", to: "ghost", kind: "verify", virtual: true },
        ],
      };
      const a = f.bdRelHtml(doc, "a");
      expect(a).toContain("关系 · 出 2 / 入 1");
      expect(a).toContain("落库模块");
      expect(a).toContain("调用");
      expect(a).toContain("调用 createGatewayApp");
      expect(a).toContain("数据流");
      expect(a).toContain("推导");
      // 只有 virtual 边带推导徽标:计数 1 次
      expect(a.split("自动推导待核实").length - 1).toBe(1);
      // 目标节点查不到 → 回退显示 id
      expect(a).toContain("ghost");
      // 孤立节点
      const lone = f.bdRelHtml({ nodes: [{ id: "z", label: "孤" }], edges: [] }, "z");
      expect(lone).toContain("关系 · 出 0 / 入 0");
      expect(lone).toContain("孤立节点(无连线)");
    });
  }, 30_000);

  it("⑧未处理评论 chip(n12):待读评论文案 + pendingComments 消费点 + cmt-pending 节点高亮", async () => {
    await withPanel(7972, (html) => {
      // 卡头 chip 文案与 title
      const chip = extractFn(html, "bdPendingChipHtml");
      expect(chip).toContain("待读评论 ");
      expect(chip).toContain("这些评论 agent 还没读到;下一轮任务会带上");
      expect(chip).toContain("bdCardPending");
      // 操作条里挂 chip
      expect(extractFn(html, "bdCardActionsHtml")).toContain("bdPendingChipHtml()");
      // 操作条幂等就地同步 chip(计数变化/清零都覆盖)
      expect(extractFn(html, "bdCanvasCardActions")).toContain('acts.querySelector("#bdCardPending")');
      // 数据来源:board.list.result 原样收编 items(不挑字段,否则 pendingComments/docKind 被吃)
      expect(html).toContain("boardItems = m.items || [];");
      expect(html).toContain("pendingComments");
      expect(html).toContain("docKind");
      // 状态与高亮
      expect(html).toContain("let boardListPending = {};");
      expect(html).toContain(".cv-node.cmt-pending{");
      expect(html).toContain('bdNodePending(doc.taskId, n.id) ? " cmt-pending" : ""');
      // review.inject 回执(agent 已读)= chip 就地清零
      expect(html).toContain('bdPendingRefresh("clear", m.taskId)');
      // 行为:chip 只在 pendingComments>0 时出;节点高亮按节点集合
      const stub = "function bdPendingOf(taskId) { return taskId === \"t1\" ? { count: 2, nodes: [\"n1\"] } : null; }";
      const src = stub + NL + chip + NL + extractFn(html, "bdNodePending");
      const f = new Function(src + NL + "return { chip: bdPendingChipHtml, node: bdNodePending };")( ) as {
        chip: (tid?: string) => string;
        node: (tid: string, nid: string) => boolean;
      };
      expect(f.chip("t0")).toBe("");
      expect(f.chip("t1")).toContain("待读评论 2");
      expect(f.node("t1", "n1")).toBe(true);
      expect(f.node("t1", "n2")).toBe(false);
      expect(f.node("t9", "n1")).toBe(false);
    });
  }, 30_000);

  it("⑨多板搜索/过滤(n14):bfListSearch 输入框 + docKind 类型过滤(缺省 design)", async () => {
    await withPanel(7973, (html) => {
      // 搜索框与下拉的 id / 选项文案
      expect(html).toContain('id="bfListSearch"');
      expect(html).toContain('id="bfListKind"');
      expect(html).toContain('["", "全部"]');
      expect(html).toContain('["design", "设计"]');
      expect(html).toContain('["page", "页面"]');
      expect(html).toContain('["workflow", "工作流"]');
      // 状态在模块级,重渲不清空
      expect(html).toContain('let bfListQuery = "";');
      expect(html).toContain('let bfListKind = "";');
      const list = extractFn(html, "renderBfList");
      expect(list).toContain("bfListFiltered(boardItems, bfListQuery, bfListKind)");
      expect(list).toContain("bfListQuery = si.value"); // oninput 即时重渲
      expect(list).toContain("bfListKind = ks.value");
      expect(list).not.toContain("bfListQuery = \"\""); // 重渲不得清空查询
      // 行为:title/taskId 子串(大小写不敏感)+ docKind 过滤(缺 docKind 按 design)
      const ms = extractFn(html, "bfListMatch") + NL + extractFn(html, "bfKindMatch") + NL + extractFn(html, "bfListFiltered");
      const f = new Function(ms + NL + "return { m: bfListMatch, k: bfKindMatch, fl: bfListFiltered };")( ) as {
        m: (it: unknown, q: string) => boolean;
        k: (it: unknown, kind: string) => boolean;
        fl: (items: unknown[], q: string, kind: string) => { taskId: string }[];
      };
      const items = [
        { taskId: "T-Alpha", title: "登录页设计" },
        { taskId: "t-beta", title: "网关模块", docKind: "design" },
        { taskId: "t-gamma", title: "个人中心", docKind: "page" },
        { taskId: "t-delta", title: "发布流水线", docKind: "workflow" },
      ];
      expect(f.m(items[0], "alpha")).toBe(true); // taskId 子串,大小写不敏感
      expect(f.m(items[0], "登录")).toBe(true);  // title 子串
      expect(f.m(items[0], "网关")).toBe(false);
      expect(f.m(items[0], "")).toBe(true);      // 空查询全过
      expect(f.k(items[0], "")).toBe(true);
      expect(f.k(items[0], "design")).toBe(true); // 缺 docKind → design
      expect(f.k(items[2], "design")).toBe(false);
      // 子串过滤大小写不敏感:"t-" 也命中 "T-Alpha"(服务端 taskId 大小写混用是现实情况)
      expect(f.fl(items, "t-", "").map((x) => x.taskId)).toEqual(["T-Alpha", "t-beta", "t-gamma", "t-delta"]);
      expect(f.fl(items, "", "page").map((x) => x.taskId)).toEqual(["t-gamma"]);
      expect(f.fl(items, "登", "design").map((x) => x.taskId)).toEqual(["T-Alpha"]);
      expect(f.fl(items, "无此板", "")).toEqual([]);
    });
  }, 30_000);

  it("⑩关系图例护栏(n13):五种关系色 + 「推导边(待核实)」文案必须在 HTML 串里", async () => {
    await withPanel(7974, (html) => {
      expect(html).toContain("lg-call");
      expect(html).toContain("lg-data");
      expect(html).toContain("lg-verify");
      expect(html).toContain("lg-nav");
      expect(html).toContain("lg-virtual");
      expect(html).toContain("推导边(待核实)");
      // 图例 CSS 也在(色块不靠外部资产)
      expect(html).toContain(".cv-legend .lg-virtual{");
      // 图例只在有边时出(relLegend 判定);code 板改出 C4 图例,关系图例不叠底
      const canvasFn = extractFn(html, "renderBoardCanvas");
      expect(canvasFn).toContain("relLegend && !cvCodeInfo");
      expect(canvasFn).toContain("推导边(待核实)");
    });
  }, 30_000);
});

/** 从面板 HTML 起止标记间切出源码片段(用于分支体断言:分支不是顶层函数,extractFn 抓不到)。 */
function extractBetween(html: string, from: string, to: string): string {
  const i = html.indexOf(from);
  expect(i, "未找到起点 " + from).toBeGreaterThan(0);
  const j = html.indexOf(to, i);
  expect(j, "未找到终点 " + to).toBeGreaterThan(i);
  return html.slice(i, j);
}

describe("看板数据不更新(n6 兜底重拉 / n7 手动压缩可见性)", () => {
  it("⑪dashboard.changed 分支:白板/追踪在场时走既有链路节流重拉(不新造取数通道)", async () => {
    await withPanel(7975, (html) => {
      // 分支体切片:从 dashboard.changed 到 board.archive.result(下一个分支)
      const branch = extractBetween(html, 'if (m.type === "dashboard.changed")', 'if (m.type === "board.archive.result")');
      // 白板在场:dashboard.changed 也要重拉板(此前只有 board.changed 一条道)
      expect(branch).toContain('viewLive("board")');
      expect(branch).toContain("boardGet(boardTaskId)");
      expect(branch).toContain("boardRefresh()");
      // 节流:水位 + 尾沿补拉定时器(防打板请求风暴)
      expect(branch).toContain("bdDashPullAt");
      expect(branch).toContain("bdDashPullTimer");
      expect(branch).toContain("Date.now() - bdDashPullAt > 1000");
      // 编辑态拦截语义照旧(草稿不被回灌)
      expect(branch).toContain("boardEditOn");
      expect(branch).toContain("bdLayoutTimer");
      expect(branch).toContain("bdLayoutInflight");
      // 追踪卡:既有 trackPull,800ms 尾沿防抖
      expect(branch).toContain('viewLive("track")');
      expect(branch).toContain("trackDashTimer");
      expect(branch).toContain("trackPull()");
      // 声明在位(模块级,branch 之外)
      expect(html).toContain("let bdDashPullAt = 0;");
      expect(html).toContain("let bdDashPullTimer = null;");
      expect(html).toContain("let trackDashTimer = null;");
      // 既有行为不破:看板视图与子代理增量拉取仍在
      expect(branch).toContain('viewLive("dash")');
      expect(branch).toContain("dashReloadTimer");
      expect(branch).toContain("subWsPullAt");
    });
  }, 30_000);

  it("⑫session.compact.result 分支:压缩成功重发 trace.stats(容量条可见)+ 清压缩中标记", async () => {
    await withPanel(7976, (html) => {
      const branch = extractBetween(html, 'if (m.type === "session.compact.result")', 'if (m.type === "team.status.result")');
      // 压缩成功:refreshHist + 重发 trace.stats(既有通道,不新造)
      expect(branch).toContain("refreshHist()");
      expect(branch).toContain('type: "trace.stats"');
      expect(branch).toContain("sessionId: currentSid");
      // 压缩中标记清除(成功/失败都清)
      expect(branch).toContain("compactSetPending(false)");
      // 原有话术不丢
      expect(branch).toContain("已压缩");
      expect(branch).toContain("未压缩:");
    });
  }, 30_000);

  it("⑮压缩边界行(板 n3):双文案/失败跳过横线/进行时行/status 帧分支", async () => {
    await withPanel(7985, (html) => {
      // session.compact.status 帧分支在位(终态清忙 + 刷新 + failed/skipped toast)
      const status = extractBetween(html, 'if (m.type === "session.compact.status")', 'if (m.type === "session.compact.result")');
      expect(status).toContain('m.phase === "started"');
      expect(status).toContain('m.phase === "completed"');
      expect(status).toContain("compactSetPending(false)");
      expect(status).toContain("refreshHist()");
      expect(status).toContain("上下文压缩失败:");
      expect(status).toContain("上下文已是最新,无需压缩");
      // 进行时行标记声明在位
      expect(html).toContain("let compactInflight = null;");
      expect(status).toContain("compactInflight");
      // renderHistory:双文案 + 失败/跳过横线 + 进行时行 + message.system 双显治理
      const rh = extractFn(html, "renderHistory");
      expect(rh).toContain('cpd.trigger || "") === "manual"');
      expect(rh).toContain("上下文已自动压缩");
      expect(rh).toContain("上下文已压缩");
      expect(rh).toContain("compact-failed");
      expect(rh).toContain("compact-skipped");
      expect(rh).toContain("compression-inflight");
      expect(rh).toContain("正在压缩上下文");
      expect(rh).toContain("compactInflight");
      expect(rh).toContain("cp-more");
      expect(rh).toContain("压缩指示:");
      expect(rh).toContain("startsWith(\"[上下文已压缩]\")");
      // 样式件在位(弱色变体)
      expect(html).toContain(".cp-divider.compact-failed");
      expect(html).toContain(".cp-divider.compact-skipped");
      expect(html).toContain(".cp-divider .cp-chip{");
    });
  }, 30_000);

  it("⑬builtinCompact:发送即提示「正在压缩上下文…」+ 置 pending(disabled/aria-busy/20s 超时)", async () => {
    await withPanel(7977, (html) => {
      const fn2 = extractFn(html, "builtinCompact");
      expect(fn2).toContain('type: "session.compact"');
      expect(fn2).toContain("compactSetPending(true)");
      expect(fn2).toContain("正在压缩上下文");
      // pending 实现:aria-busy + disabled + 20s 超时清除 + 复位走既有 renderSendBtn
      const set = extractFn(html, "compactSetPending");
      expect(set).toContain('setAttribute("aria-busy"');
      expect(set).toContain('setAttribute("disabled", "disabled")');
      expect(set).toContain("removeAttribute(\"disabled\")");
      expect(set).toContain("compactPendingTimer");
      expect(set).toContain("20000");
      expect(set).toContain("renderSendBtn()");
      // 状态声明在位
      expect(html).toContain("let compactPending = false;");
      expect(html).toContain("let compactPendingTimer = null;");
    });
  }, 30_000);
});

describe("白板评论编辑/删除(c1)", () => {
  it("⑭每条评论带「改」「删」按钮(bdCmtEdit/bdCmtDel),明细卡与画布浮层同结构同处理器", async () => {
    await withPanel(7984, (html) => {
      // 行结构单一出处:文本走 esc() 转义 + 两个按钮带 data-idx/data-node
      const row = extractFn(html, "bdCommentRowHtml");
      expect(row).toContain("bf-cmt-row");
      expect(row).toContain("esc(text)");
      expect(row).toContain("bdCmtEdit");
      expect(row).toContain("bdCmtDel");
      expect(row).toContain('data-idx="');
      expect(row).toContain('data-node="');
      expect(row).toContain("删除这条评论");
      // 明细卡评论区用行结构(index 入参)+ 绑定器;不再裸 map 出只读 div
      const det = extractFn(html, "renderBoardDetail");
      expect(det).toContain("bdCommentRowHtml");
      expect(det).toContain("bdBindCommentRows(box, n.id)");
      expect(det).toContain('bdSendComment({ op: "append"');
      // 画布就地浮层同样带改/删(复用同一行结构与同一绑定器)
      const open = extractFn(html, "bdOpenNodeComment");
      expect(open).toContain("bdCommentRowHtml");
      expect(open).toContain("bdBindCommentRows(wrap, n.id)");
      expect(open).toContain('bdSendComment({ op: "append"');
      // 样式件在位
      expect(html).toContain(".bf-cmt-acts{");
      expect(html).toContain(".bf-cmt-edit input{");
    });
  }, 30_000);

  it("⑮op=update/delete 发送路径可执行:统一 bdSendComment 出 board.comment(改带 text+index,删只带 index)", async () => {
    await withPanel(7985, (html) => {
      const fn2 = extractFn(html, "bdSendComment");
      // 单一发送出处:三种 op 都走同一条 board.comment 协议
      expect(fn2).toContain('type: "board.comment"');
      expect(fn2).toContain('op: op');
      expect(fn2).toContain('msg.index = Number(opt.index)');
      // 只有 append 登记「未处理评论」,改/删不新增待办
      expect(fn2).toContain('op === "append"');
      expect(fn2).toContain("bdPendingNoteNode");
      // 行为:拦截 wsSafeSend 后直接执行,断言三种 op 的帧形状
      const sent: string[] = [];
      const src = "function toast(){}" + NL
        + "function wsSafeSend(s){ sent.push(s); }" + NL
        + "function bdPendingNoteNode(){}" + NL
        + "const currentSid = \"s1\"; const boardTaskId = \"t1\";" + NL
        + fn2 + NL
        + "return bdSendComment;";
      const f = new Function("sent", src)(sent) as (o: unknown) => boolean;
      expect(f({ op: "update", nodeId: "n1", index: 2, text: "  改后  " })).toBe(true);
      expect(JSON.parse(sent[0]!)).toMatchObject({ type: "board.comment", sessionId: "s1", taskId: "t1", nodeId: "n1", op: "update", index: 2, text: "改后" });
      expect(f({ op: "delete", nodeId: "n1", index: 0 })).toBe(true);
      const del = JSON.parse(sent[1]!) as Record<string, unknown>;
      expect(del).toMatchObject({ op: "delete", index: 0 });
      expect(del.text).toBeUndefined(); // 删除不带正文
      expect(f({ op: "update", nodeId: "n1", index: 1, text: "   " })).toBe(false); // 空文本不发送
      expect(sent).toHaveLength(2);
      // 编辑态入口存在:保存走 op=update,取消只收编辑框
      const ed = extractFn(html, "bdOpenCommentEditor");
      expect(ed).toContain("bdCommentText(nodeId, i)");
      expect(ed).toContain('op: "update"');
      expect(ed).toContain("bdCmtEditSave");
    });
  }, 30_000);
});

/* ---- 白板「易读性」w1/w2/w3(60 节点板经验证适配 k=0.70 只能看到 2/60 节点、
 *      31/60 标题被 ellipsis、52/60 摘要被裁、泳道 21 条平均 2.8 节点)---- */
describe("白板易读性(w1 写者过滤 / w2 密度分层 / w3 摘要单行)", () => {
  it("①写者过滤:前缀分组 chip + 过滤后按子集重算布局 + 提示「只看 x · 共 n/N 节点」", async () => {
    await withPanel(7991, (html) => {
      // 模块级状态在位(过滤态必须跨重渲染保持)
      expect(html).toContain("let cvWriterOn = null;");
      expect(html).toContain("let cvWriterAll = [];");
      // 分组/过滤两个纯函数在位
      const chips = extractFn(html, "cvWriterChips");
      expect(chips).toContain("cvWriterOf");
      const filterDoc = extractFn(html, "cvWriterFilterDoc");
      expect(filterDoc).toContain("keep.has(e.from)");
      expect(filterDoc).toContain("keep.has(e.to)"); // 只留两端都可见的边
      // 渲染链:①filter 只影响渲染(DOM 不建被过滤节点) ②布局拿**子集**重算
      const rc = extractFn(html, "renderBoardCanvas");
      expect(rc).toContain("cvWriterFilterDoc(doc, cvWriterOn)");
 // A:宽板折行开关与过滤/密度分层同口径传入(布局仍按子集重算)
      expect(rc).toContain("BoardFlowLayout.layout(fdoc, {");
      expect(rc).toContain("autoWrap: cvCodeInfo ? false : cvFlowWrapWanted(doc, fdoc)");
      expect(rc).toContain("wrap: cvCodeInfo ? 3 : undefined");
 // UI 交互地图按层排序后再 map(源头仍是过滤后的 cvRenderDoc,不是全量 doc)
      expect(rc).toContain("const cardNodes = cvUiInfo ? cvRenderDoc.nodes.slice().sort");
      expect(rc).toContain("const cards = cardNodes.map(");
      expect(rc).toContain("cvWriterAll = cvWriterChips(");
      expect(rc).toContain('data-wpfx="');
      expect(rc).toContain('data-wall="1"');
      expect(rc).toContain("显示全部");
      expect(rc).toContain("只看 ");
      expect(rc).toContain("节点</span>"); // 「只看 a1/b1 · 共 12/60 节点」
      // chip 点击=切写者集合(多选),fold 点击=展开泳道;都走重渲染
      expect(rc).toContain("cvWriterOn = (!cur.size || cur.size === all.length) ? null : cur;");
      // 行为:前缀解析 + chip 分组计数(无前缀/ph-* 归「其他」)
      const src = extractFn(html, "cvWriterOf") + NL + extractFn(html, "cvWriterChips");
      const api = new Function(src + NL + "return { cvWriterOf: cvWriterOf, cvWriterChips: cvWriterChips };")() as {
        cvWriterOf: (id: string) => string; cvWriterChips: (ns: unknown[]) => { pfx: string; n: number }[];
      };
      expect(api.cvWriterOf("a1-card")).toBe("a1");
      expect(api.cvWriterOf("pqa6e-r3a1")).toBe("pqa6e"); // 5 字符 scope 也要认
      expect(api.cvWriterOf("plainnode")).toBe("");
      expect(api.cvWriterOf("ph-understand")).toBe(""); // 阶段卡不是写者
      expect(api.cvWriterOf("1x-notwriter")).toBe("");   // 首字符必须是字母
      const cs = api.cvWriterChips([{ id: "a1-a" }, { id: "a1-b" }, { id: "c1-a" }, { id: "plainnode" }, { id: "ph-close" }]);
      expect(cs.map((c) => c.pfx + ":" + c.n)).toEqual(["a1:2", "c1:1", ":2"]); // 计数降序,「其他」永远排最后
    });
  }, 30_000);

  it("②密度分层:CV_FOLD_THRESHOLD 常量 + cv-sum 默认单行(line-clamp:1)、hover 展开 6 行且抬 z-index", async () => {
    await withPanel(7992, (html) => {
      // 阈值常量与展开集合
      expect(html).toContain("const CV_FOLD_THRESHOLD = 20;");
      expect(html).toContain("let cvFoldOpen = new Set();");
      expect(html).toContain("let cvFoldMode = false;");
      // w3 摘要单行:默认 1 行、hover 6 行、卡片抬 z-index(否则展开被邻卡压住)
      expect(html).toContain("-webkit-line-clamp:1");
      expect(html).toContain("-webkit-line-clamp:6");
      expect(html).toContain(".cv-node:hover{z-index:");
      expect(html).toContain(".cv-node:hover .cv-sum{");
      // 全文 title 属性(悬停看完整摘要)
      expect(extractFn(html, "renderBoardCanvas")).toContain('<div class="cv-sum" title="');
      // 阈值只在「大板 + 未过滤」时生效(小板/已过滤板照画全卡)
      const rc = extractFn(html, "renderBoardCanvas");
      expect(rc).toContain("!cvWriterOn && fdoc.nodes.length > CV_FOLD_THRESHOLD");
      // 适配视野在分层模式下不吃跨板泳道框(否则 k 被压到 0.1 以下)
      expect(extractFn(html, "cvFitNow")).toContain("if (cvFoldMode) continue;");
    });
  }, 30_000);

  it("③.cv-fold 计数块:渲染源码里出块(+N)、点开按泳道展开并重渲染", async () => {
    await withPanel(7993, (html) => {
      expect(html).toContain(".cv-fold{");
      const rc = extractFn(html, "renderBoardCanvas");
      // 出块:每个有隐藏节点的泳道一个 +N 块,挂 data-fold 供展开
      expect(rc).toContain('class="cv-fold"');
      expect(rc).toContain('data-fold="');
      expect(rc).toContain('"<b>+" + f.n + "</b>');
      expect(rc).toContain("cvFoldHtml");
      // 隐藏节点不建卡、不画边:渲染集换成 keptNodes
      expect(rc).toContain("const keep = new Set(fl.mainNodes || [])");
      expect(rc).toContain("keptIds.has(e.from) && keptIds.has(e.to)");
      // 点开=加入展开集合并重渲染
      expect(rc).toContain("cvFoldOpen.add(k)");
      expect(rc).toContain("renderBoardCanvas(doc, opts)");
      // 展开态进结构签名(否则增量补丁让点击无效)
      expect(extractFn(html, "cvStructSig")).toContain("cvFoldOpen.size");
      // w4 空壳泳道降噪:lanes 里 boxless 的(成员全被收进 +N 的泳道)不画 .cv-lane 框——
 // 经验证 60 节点板 21 框 vs 7 卡(3:1),空壳虚线框互相重叠糊画面;数据不删(计数块要靠 key→label)
      const laneHtmlSrc = rc.slice(rc.indexOf("const laneHtml"), rc.indexOf("const cards"));
      expect(laneHtmlSrc).toContain("filter((lane) => !lane.boxless)");
      expect(laneHtmlSrc).toContain('class="cv-lane');
      // 布局引擎侧标记确实存在(否则过滤是空转)
      // 布局引擎侧标记确实存在(否则过滤是空转)
      expect(rc).not.toContain("cvFlowInfo.lanes.filter((lane) => !lane.boxless) || []");
      // 计数块数据源必须是全量 fl.lanes(丢框不能丢数据:key→label 靠它算 +N)
      expect(rc).toContain("const lanes = fl.lanes || [];");
      expect(rc).toContain("const hidden = lane.nodes.filter((id) => !keep.has(id));");
    });
  }, 30_000);

  it("④卡片头信息分层:头行只留 kind+标题,验收/变更徽标换到第二行(标题槽 ≥100px)", async () => {
    await withPanel(7994, (html) => {
 // 治字号(经验证 k=1 时 5/7 主干卡标题被 ellipsis 截断,标题槽只 71–73px):
      // 卡宽 208 定死,想在头行里挤出 100px 只能减少头行常驻件——.cv-head 允许换行,
      // .cv-title 给 min-width 撑住下限,验收徽标(.cv-acc)与变更徽标(.bd-tag)自然落到第二行。
 // 卡头条底也走白板令牌(--bcv-card-head-bg),其余逐字不变
      expect(html).toContain(".cv-node .cv-head{display:flex;align-items:center;gap:6px;padding:7px 10px 4px;font-size:12px;color:var(--cv-head-fg);background:var(--bcv-card-head-bg);font-weight:600;flex-wrap:wrap}");
      const titleCss = ".cv-node .cv-title{flex:1;min-width:";
      const ti = html.indexOf(titleCss);
      expect(ti).toBeGreaterThan(0);
      const minW = parseInt(html.slice(ti + titleCss.length), 10);
      expect(minW).toBeGreaterThanOrEqual(100); // 标题槽下限 ≥100px(实测 71–73px 的病灶)
      // 徽标仍不可压缩(换行后行内也要守纪律,不许挤标题)
      expect(html).toContain(".cv-node .cv-head .bd-tag{flex-shrink:0}");
      // 卡头 DOM 顺序不动:kind → title → (运行态) → 验收 → 变更;换行只靠 CSS,
      // .cv-acc 仍留在 .cv-head 内(boardread.spec 的 ④⑤ 按 head 定位验收徽标)
      const rc = extractFn(html, "renderBoardCanvas");
      const headIdx = rc.indexOf('class="cv-head"');
      const titleIdx = rc.indexOf("cv-title", headIdx);
      const accIdx = rc.indexOf("bdAccInline(n)", headIdx);
      const chgIdx = rc.indexOf("BD_CHANGE[n.change]", headIdx);
      expect(headIdx).toBeGreaterThan(0);
      expect(titleIdx).toBeGreaterThan(headIdx);
      expect(accIdx).toBeGreaterThan(titleIdx);
      expect(chgIdx).toBeGreaterThan(accIdx);
      // .cv-title 的 title 兜底属性不动(截断后仍可 hover 看全名,boardread ③ 断言非空)
      expect(rc).toContain('<span class="cv-title" title="');
    });
  }, 30_000);

  it("⑤适配 k 取换行后的真实世界尺寸(cvFitNow 用 DOM 实测,不回退旧 bounds)", async () => {
    await withPanel(7995, (html) => {
      const fit = extractFn(html, "cvFitNow");
 // 主干换行后位置变了:适配必须按 DOM 经验证(left/top/offsetWidth/offsetHeight),不能拿布局引擎的旧包围盒
      expect(fit).toContain('cvH.querySelectorAll(".cv-node,.cv-fold")');
      expect(fit).toContain("el.style.left");
      expect(fit).toContain("el.offsetWidth");
      expect(fit).not.toContain("cvFlowInfo.bounds");
 // 密度分层下泳道框跨全板(经验证单框 8000px 高)不算进适配,只按看得见的卡+计数块
      expect(fit).toContain("if (cvFoldMode) continue;");
      // 可读下限在位:自然 k 大于它时不许被钳到 0.7
      expect(html).toContain("const CV_FIT_READABLE_MIN = 0.7;");
      // 当前口径:自然 k 先算(naturalK),再夹 [可读下限(全览时放宽到 0.06), CV_MAX_ZOOM]
      expect(fit).toContain("const naturalK = Math.min(r.width / (maxX - minX + 40)");
      expect(fit).toContain("const fitMinK = forceAll ? 0.06 :");
      expect(fit).toContain('cvActiveDoc.boardType === "code"');
      expect(fit).toContain("Math.max(fitMinK, naturalK)");
    });
  }, 30_000);
});
