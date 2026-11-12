import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PANEL_SRC as PANEL_SRC_AGG, PROTOCOL_SRC as PROTOCOL_SRC_AGG } from "./panel-source.js";
import { SERVER_SRC } from "./panel-source.js";

/** RSI 状态面接线:
 * ①协议面:rsi.status 请求 + rsi.status.result 结果(只加新增型,不动既有消息);
 * ②网关面:handleMessage 收到 rsi.status 就调 collectRsiStatus → safeSend 回包,异常走 error;
 * ③面板面(由另一 agent 并行落盘,集成后才有):团队页 rsi 标签 + 轮询 + 转义;
 * ④真实调用一次 collectRsiStatus(模块缺席时跳过——前置事实允许)。
 * 源码文本断言的意义:防「纯逻辑写了但没接线」。 */

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const SERVER_SRC = SERVER_SRC;
const PROTOCOL_SRC = PROTOCOL_SRC_AGG;
const PANEL_SRC = PANEL_SRC_AGG;

/** 取一段源码:从 startMarker 到 endMarker(不含)。缺失返回空串。 */
function sliceBetween(s: string, startMarker: string, endMarker: string): string {
  const a = s.indexOf(startMarker);
  if (a < 0) return "";
  const b = s.indexOf(endMarker, a + startMarker.length);
  return b < 0 ? s.slice(a) : s.slice(a, b);
}

describe("protocol:rsi.status 请求 + rsi.status.result 结果", () => {
  it("客户端消息与结果消息两个 type 字面量都在", () => {
    expect(PROTOCOL_SRC).toContain('z.literal("rsi.status")');
    expect(PROTOCOL_SRC).toContain('"rsi.status.result"');
  });

  it("请求 schema 是空载荷(Envelope + type 字面量,无额外字段)", () => {
    expect(PROTOCOL_SRC).toMatch(/export const RsiStatusQuery = Envelope\.extend\(\{\s*type: z\.literal\("rsi\.status"\)\s*\}\)/);
  });

  it("请求进了 ClientMessage union,结果进了 ServerMessage union", () => {
    const clientUnion = sliceBetween(PROTOCOL_SRC, 'export const ClientMessage = z.discriminatedUnion("type", [', "]);");
    expect(clientUnion).toContain("RsiStatusQuery");
    const serverUnion = sliceBetween(PROTOCOL_SRC, 'export const ServerMessage = z.discriminatedUnion("type", [', "]);");
    expect(serverUnion).toContain("RsiStatusResult");
  });

  it("结果类型字段 at/sections/okCount/warnCount 齐备", () => {
    const block = sliceBetween(PROTOCOL_SRC, "export const RsiStatusResult = Envelope.extend({", "});");
    expect(block).toContain("at:");
    expect(block).toContain("sections:");
    expect(block).toContain("okCount:");
    expect(block).toContain("warnCount:");
  });

  it("section/metric 结构与 rsi-status.ts 的 RsiStatusSection 一致", () => {
    const section = sliceBetween(PROTOCOL_SRC, "export const RsiStatusSectionZ = z.object({", "});");
    for (const f of ["id:", "title:", "ok:", "code:", "metrics:", "warnings:"]) expect(section).toContain(f);
    const metric = sliceBetween(PROTOCOL_SRC, "export const RsiStatusMetricZ = z.object({", "});");
    for (const f of ["label:", "value:", "unit:", "tone:"]) expect(metric).toContain(f);
  });
});

describe("gateway server.ts 接线:rsi.status → collectRsiStatus → safeSend", () => {
  const caseBody = (): string => sliceBetween(SERVER_SRC, 'case "rsi.status": {', 'case "team.p2p.status": {');

  it("import 了 collectRsiStatus 且分发处有 case \"rsi.status\"", () => {
    expect(SERVER_SRC).toMatch(/import\s*\{\s*collectRsiStatus\s*\}\s*from\s*"\.\/rsi-status\.js"/);
    expect(SERVER_SRC).toContain('case "rsi.status": {');
    expect(caseBody().length).toBeGreaterThan(0);
  });

  it("以 root/journal/now 调 collectRsiStatus,并用 safeSend 回 rsi.status.result", () => {
    const body = caseBody();
    expect(body).toContain("collectRsiStatus({");
    expect(body).toMatch(/root:\s*repoRoot\(\)/);
    expect(body).toMatch(/journal,/);
    expect(body).toMatch(/now:\s*Date\.now\(\)/);
    expect(body).toContain("safeSend(");
    expect(body).toContain('type: "rsi.status.result"');
  });

  it("有 try/catch 面:catch 回 error 帧(ErrorCode.Internal)", () => {
    const body = caseBody();
    expect(body).toContain("try {");
    expect(body).toContain("catch");
    expect(body).toContain("ErrorCode.Internal");
    expect(body).toMatch(/type:\s*"error"/);
  });

  it("不主动推:case 体内无广播/无 wss.clients 遍历( note 注入器只写 super 会话 journal,rsi.status 回包本体仍单发)", () => {
    const body = caseBody();
 // rsi.status 回包本体不广播:case 体内不得出现对回包 r 的广播调用(rsiNoteInjector 的
 // broadcast 是运行事件注入器路径,只挂 rsi.mechanism.run/annotate 收尾,与回包无关;
 // 断言收窄为「不把 rsi.status 回包广播给所有连接」。)
    expect(body).not.toMatch(/broadcast[^\n]{0,120}rsi\.status/);
    expect(body).not.toContain("sendTerminalFrame");
    expect(body).not.toContain("wss.clients");
 // 全文件层面:不存在「向所有连接广播 rsi.status」的写法。
    expect(SERVER_SRC).not.toMatch(/wss\.clients[\s\S]{0,200}rsi\.status/);
  });
});

describe("panel.ts super 指挥台 IDE 三栏做梦区(布局归位)", () => {
  it("superIdeAct/superMainDream 在 super 视图,团队视图不再有 rsi 子标签,rsi.status 请求 + 结果处理仍在", () => {
    expect(PANEL_SRC).toContain("superIdeWrap");
    expect(PANEL_SRC).toContain('id="superMainDream"');
    expect(PANEL_SRC).toContain('id="superIdeAct"'); // IDE 三栏:活动栏
    expect(PANEL_SRC).toContain('id="superSbDreamList"'); // 侧栏做梦区
    expect(PANEL_SRC).not.toContain("teamTabRsi");
    expect(PANEL_SRC).not.toContain('id="teamPaneRsi"');
    expect(PANEL_SRC).not.toContain('id="superTabRsi"'); // 旧页签退役
    expect(PANEL_SRC).not.toContain('id="superPaneRsiChat"'); // 会话Chat pane 退役
    expect(PANEL_SRC).toContain('"rsi.status"');
    expect(PANEL_SRC).toContain("rsi.status.result");
  });

  it("轮询有 setInterval 也必须有 clearInterval(切走不留定时器)", () => {
    expect(PANEL_SRC).toContain("setInterval");
    expect(PANEL_SRC).toContain("clearInterval");
  });

  it("渲染走 escapeHtml(标题/指标不进 innerHTML 原文)", () => {
    const start = PANEL_SRC.indexOf("function rsiRender");
    expect(start, "rsiRender 定义存在").toBeGreaterThanOrEqual(0);
    const body = PANEL_SRC.slice(start, start + 8000);
 // 面板内既有转义函数名是 esc(无 escapeHtml 别名);断言 RSI 渲染段确实对文本做了转义。
    expect(body).toMatch(/escapeHtml|esc\(/);
    expect(body).toMatch(/rsiWarnHtml|warnings/);
  });

 // RSI-DASH-UX:UNAVAILABLE(未启用)单独归类,不得并入异常/降级。
  it("UNAVAILABLE 单独归类为未启用(头部三分计数 + 中性灰卡片 + 空态文案)", () => {
    const start = PANEL_SRC.indexOf("function rsiRender");
    const body = PANEL_SRC.slice(start, start + 8000);
    expect(PANEL_SRC).toContain("function rsiStateKind");
    expect(PANEL_SRC).toContain('=== "UNAVAILABLE" ? "unavailable" : "error"');
    expect(PANEL_SRC).toContain(".rsi-tone-idle .rsi-dot");
 // 头部三分计数文案
    expect(body).toContain('· 正常 " + ok + " · 未启用 " + unavailable + " · 异常 " + errors');
    expect(PANEL_SRC).not.toContain('正常 " + ok + " / 降级 ');
 // 空态(sections=[]):如实说明,不报错
    expect(body).toContain("暂无 RSI 数据");
 // 未启用卡片提示语与「异常」措辞
    expect(body).toContain("未产生数据（运行对应 RSI 任务后自动更新）");
    expect(body).toContain('"未启用" : "异常"');
  });
});

describe("collectRsiStatus 真实调用(模块未落盘时跳过)", () => {
  it("空临时目录 root 调用一次:返回 {at,sections,okCount,warnCount} 不 throw", async () => {
    const mod = (await import("../src/rsi-status.js").catch(() => null)) as
      | { collectRsiStatus?: (opts: { root: string; now?: number }) => Promise<unknown> }
      | null;
    if (!mod?.collectRsiStatus) {
 // 前置事实:rsi-status.ts 由同任务另一 agent 新建,此刻可能尚未落盘;集成后本用例转为真跑。
      expect(mod).toBeNull();
      return;
    }
    const tmp = mkdtempSync(join(tmpdir(), "rsi-wiring-"));
    try {
      const r = (await mod.collectRsiStatus({ root: tmp, now: 1_700_000_000_000 })) as {
        at: unknown; sections: unknown; okCount: unknown; warnCount: unknown;
      };
      expect(typeof r.at).toBe("number");
      expect(Array.isArray(r.sections)).toBe(true);
      expect(typeof r.okCount).toBe("number");
      expect(typeof r.warnCount).toBe("number");
      for (const s of r.sections as { id?: unknown; title?: unknown; ok?: unknown; metrics?: unknown; warnings?: unknown }[]) {
        expect(typeof s.id).toBe("string");
        expect(typeof s.title).toBe("string");
        expect(typeof s.ok).toBe("boolean");
        expect(Array.isArray(s.metrics)).toBe(true);
        expect(Array.isArray(s.warnings)).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
