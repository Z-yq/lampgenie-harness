/**
 * 无限画布数据新鲜度契约测试 —— 锁住「切会话/看板推送/新任务帧」三条道的取数行为:
 * ①切会话必须重取白板目录(board 按 sid 分片,不能吃「曾激活过」的旧快照);
 * ②board.changed 在板卡不在视口时不白丢(记脏标),滚回视口补拉一次;
 * ③兜底通道 dashboard.changed 尊重 board.doc 落地水位(刚落过就不重复读盘+整板重画);
 * ④board.doc 内容未变(rev + 结构签名一致)时跳过整板 DOM 重建;
 * ⑤服务端广播的任务帧(队列泵/其它客户端/子代理)也触发会话维度面板刷新(1s 节流+尾沿);
 * ⑥懒激活入口吃掉脏标(viewLive=false 时的脏标由这里兑现)。
 * 与 panel-board-live.test.ts 同构:servePanel 取真实面板 HTML + extractBetween 切分支体 + 纯字面断言。
 * 零反斜杠纪律:全部 includes 字面断言,换行用 String.fromCharCode(10)。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** 从面板 HTML 里切出 [from, to) 之间的源码片段(起止都用字面量定位)。 */
function extractBetween(html: string, from: string, to: string): string {
  const i = html.indexOf(from);
  expect(i, "未找到起点:" + from).toBeGreaterThan(0);
  const j = html.indexOf(to, i + from.length);
  expect(j, "未找到终点:" + to).toBeGreaterThan(i);
  return html.slice(i, j);
}

const NL = String.fromCharCode(10);
void NL;

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

describe("无限画布数据新鲜度(切会话/看板推送/新任务)", () => {
  it("①切会话重取白板:board 单列放行激活门 + 清脏标(不再被「曾激活过」挡掉)", async () => {
    await withPanel(7990, (html) => {
      const body = extractBetween(html, "function onSessionChange(", "function scopeBarRender(");
 // board 单列例外:即使该 sid|board 键已激活过也重取
      expect(body).toContain('view === "board"');
      expect(body).toContain("bdViewDirty = false");
      expect(body).toContain('cvActivated.has(key) && view !== "board"');
 // 旧口径(一律跳过)必须消失——否则切回旧会话会显示上次离开时的快照
      expect(body).not.toContain("if (cvActivated.has(key)) continue;");
    });
  }, 30_000);

  it("②board.changed 非在场记脏标:视口外不白丢、也不额外取数", async () => {
    await withPanel(7991, (html) => {
      const body = extractBetween(html, 'if (m.type === "board.changed")', 'if (m.type === "sense.result")');
 // 在场分支:即时刷新(既有行为不破)
      expect(body).toContain('viewLive("board")');
 // 不在场分支:只记脏标 + 时间戳,不直接发请求
      expect(body).toContain("bdViewDirty = true");
      expect(body).toContain("bdViewDirtyAt = Date.now()");
    });
  }, 30_000);

  it("③兜底水位:dashboard.changed 的 pull 受 board.doc 落地水位约束(节流链不破)", async () => {
    await withPanel(7992, (html) => {
      const body = extractBetween(html, 'if (m.type === "dashboard.changed")', 'if (m.type === "board.archive.result")');
 // 刚落过 board.doc 就跳过本拍兜底(<1500ms)
      expect(body).toContain("Date.now() - bdDocAt < 1500");
 // 兜底本体仍是既有取数通道(单板优先,否则清单+最近板)
      expect(body).toContain("boardGet(boardTaskId)");
      expect(body).toContain("boardRefresh()");
 // 既有节流窗/尾沿补拉不被替换
      expect(body).toContain("bdDashPullAt");
    });
  }, 30_000);

  it("④board.doc 内容未变不整板重画(rev + 结构签名双一致才跳过)", async () => {
    await withPanel(7993, (html) => {
      const body = extractBetween(html, 'if (m.type === "board.doc")', 'if (m.type === "board.conflict")');
 // 覆盖前先留旧 rev/签名基线
      expect(body).toContain("const prevDocRev");
      expect(body).toContain("cvStructSig(boardDoc)");
 // 判定一致性后再决定是否重画
      expect(body).toContain("const sameDoc");
      expect(body).toContain("if (!sameDoc) renderBoard();");
 // 任何回执都刷新落地水位(在途/编辑态丢弃路径也要刷)
      expect(body).toContain("bdDocAt = Date.now()");
    });
  }, 30_000);

  it("⑤任务帧触发会话维度面板刷新(1s 节流 + 尾沿补拉)", async () => {
    await withPanel(7994, (html) => {
      const body = extractBetween(html, 'if (m.type === "task.submitted" || m.type === "task.changed")', 'if (m.type === "session.history.result"');
      expect(body).toContain("panelRefreshSoon(currentSid)");
 // 节流器本体:首次起算 + 窗口内挂尾沿
      expect(html).toContain("function panelRefreshSoon(");
      expect(html).toContain("let panelRefreshAt = 0");
      expect(html).toContain("panelRefreshTimer = setTimeout(run, 1001 - gap)");
    });
  }, 30_000);

  it("⑥懒激活脏标补拉:滚回视口时兑现 board.changed 的脏标", async () => {
    await withPanel(7995, (html) => {
      const body = extractBetween(html, "function canvasActivateCard(", "function canvasAfterResize(");
      expect(body).toContain('const dirty = view === "board" && bdViewDirty');
      expect(body).toContain("if (cvActivated.has(key) && !dirty) return;");
      expect(body).toContain("loadViewData(view, currentSid)");
 // 激活入口只取数、绝不改视图身份(身份由 onFocus 定,旧的 switchViewActivate 会抢身份)
      expect(body).not.toContain("switchViewActivate(");
    });
  }, 30_000);
});
