/**
 * 子agent会话流与分身看板融合(n3)契约测试:
 *  ①CV_CARDS 无「分身 Agents」卡(能力已并入子agent会话流,两块看板数据 100% 重合);
 *  ②panel 侧无 subagents.list 取数,只留残留回包兼容分支(subMsgRender,旧客户端/在途请求不炸);
 *  ③旧卡名(subagents / agents)回退到 subchat:别名表 + 视图映射 + 入口别名;
 *  ④左栏条目承载原分身卡独有信息:模型标签 / 会话短码 / 失败原因(reap)渲染。
 * 零反斜杠纪律:全部 includes 字面断言。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

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
  const srv = servePanel(port, () => { /* 纯静态:不接 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("子agent会话流 · 分身看板融合(n3)", () => {
  it("①CV_CARDS 已删「分身 Agents」卡,保留子agent会话流卡", async () => {
    await withPanel(7956, (html) => {
      const i0 = html.indexOf("const CV_CARDS = [");
      expect(i0).toBeGreaterThan(0);
      const block = html.slice(i0, html.indexOf("\n];", i0));
      // 只取卡条目行(注释行里有「已删」说明,不能算卡)
      const cards = block.split(String.fromCharCode(10)).filter((l) => l.trim().startsWith("{ name:")).join(String.fromCharCode(10));
      expect(cards.length).toBeGreaterThan(200);
      // 卡清单里不存在独立分身卡(subagents / agents 卡名 + 「分身 Agents」标题)
      expect(cards).not.toContain('name: "subagents"');
      expect(cards).not.toContain('name: "agents"');
      expect(cards).not.toContain("分身 Agents");
      // 融合后的唯一卡在位
      expect(cards).toContain('{ name: "subchat", node: "view-subchat", title: "子agent会话流"');
      // 原分身卡的独立视图容器也不在了
      expect(html).not.toContain('id="view-subagents"');
      // 融合说明留在卡清单注释里(后人不再加回)
      expect(html).toContain("「分身 Agents」卡已删");
    });
  }, 30_000);

  it("②panel 侧无 subagents.list 取数,仅留残留回包兼容分支", async () => {
    await withPanel(7957, (html) => {
      // 唯一出现点:残留回包处理(旧客户端/在途请求)与注释
      const sends = html.split('type: "subagents.list"').length - 1;
      expect(sends).toBe(0); // 不再发取数请求
      expect(html).toContain('if (m.type === "subagents.list.result") { subMsgRender(); return; }');
      // 注释里明确「不再拉 subagents.list」(防回潮)
      expect(html).toContain("不再拉 subagents.list");
      // 数据源改双轨:journal(histEvents) + 注册表(sessionStatus.subagentList)
      const dir = extractFn(html, "subDirEntries");
      expect(dir).toContain("histEvents");
      expect(dir).toContain("sessionStatus.subagentList");
      expect(dir).toContain('e.kind === "subagent.spawn"');
      expect(dir).toContain('e.kind === "subagent.result"');
    });
  }, 30_000);

  it("③旧卡名两级别名回退到 subchat(布局存档/书签/键盘路径不白屏)", async () => {
    await withPanel(7958, (html) => {
      // 卡片别名表 + cvCardName 规范化
      expect(html).toContain('const CV_CARD_ALIAS = { subagents: "subchat", agents: "subchat" };');
      expect(extractFn(html, "cvCardName")).toContain("CV_CARD_ALIAS[card] || card");
      // 视图映射别名(旧卡名落到 view-subchat)
      expect(html).toContain('m.subagents = "subchat"; m.agents = "subchat";');
      // 入口别名(switchView 侧)
      expect(extractFn(html, "cvAliasView")).toContain('name === "subagents" || name === "agents" ? "subchat"');
      // 画布激活按别名规范化后再查视图
      expect(extractFn(html, "canvasActivateCard")).toContain("cvCardName(card)");
      // 行为:旧名一律回退到 subchat,新名与未知名原样透传
      const f = new Function('const CV_CARD_ALIAS = { subagents: "subchat", agents: "subchat" };' + String.fromCharCode(10) +
        extractFn(html, "cvCardName") + String.fromCharCode(10) + "return cvCardName;")() as (c: string) => string;
      expect(f("subagents")).toBe("subchat");
      expect(f("agents")).toBe("subchat");
      expect(f("subchat")).toBe("subchat");
      expect(f("board")).toBe("board");
    });
  }, 30_000);

  it("④左栏条目含 模型 / 会话短码 / reap 失败原因 渲染", async () => {
    await withPanel(7959, (html) => {
      const render = extractFn(html, "subMsgRender");
      // 元信息行:模型(注册表实际模型,缺席=主模型)
      expect(render).toContain('(en && en.model) || "主模型"');
      // 会话短码(原分身卡独有信息)
      expect(render).toContain("en.sessionId");
      expect(render).toContain("sidShort");
      // 失败原因 reap(与服务端 subagents.list 的 reap 字段同源)
      expect(render).toContain("en.reap");
      expect(render).toContain("en.stopReason");
      expect(render).toContain("sl-reap");
      // 目录条目必须真的带上这些字段(spawn/result/registry 三路摄取)
      const dir = extractFn(html, "subDirEntries");
      expect(dir).toContain("en.reap = String(p.reap.reason)");
      expect(dir).toContain("en.model = String(a.model ||");
      expect(dir).toContain("en.stopReason = String(a.stopReason)");
      expect(dir).toContain("sessionId: String(e.sessionId ||");
      // 终态文本折叠展示(≤200 字)
      expect(render).toContain("终态");
    });
  }, 30_000);
});
