import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 新建任务(草稿态)聊天窗全量重置(2026-11-09 用户实报「新建任务时聊天窗的按钮/显示数据要重置」)。
 *  面板 UI 全在 panel.ts 模板字符串内,这里读源码文本断言契约(同 annotate-panel-anchors 风格)。
 *  锁四件事:
 *  ① 重置清单抽成公共函数 resetSessionDomainUI,openSession 与 newDraft 共用(防两处漂移);
 *  ② 清单逐项在场:事件流/状态投影/水位/流式/子代理流+未读/置顶条/白板上下文 + 派生渲染刷新;
 *  ③ newDraft 额外清输入区会话域件(问答条/附件条/指令 chip),并仍走 restoreDraft(草稿语义不变);
 *  ④ 草稿态只移除 zh:sid,不写任何新存储键;公共重置函数本身不碰 localStorage/sessionStorage。 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../src/panel.ts"), "utf8");

/** 取一个函数体(从 `function name(` 到下一个顶格 `}` 行)。 */
function bodyOf(name: string): string {
  const at = PANEL_SRC.indexOf("function " + name + "(");
  expect(at, "未找到函数 " + name).toBeGreaterThan(-1);
  const end = PANEL_SRC.indexOf("\n}", at);
  expect(end).toBeGreaterThan(at);
  return PANEL_SRC.slice(at, end);
}

describe("会话域 UI 重置清单(公共函数)", () => {
  const body = bodyOf("resetSessionDomainUI");

  it("事件流/状态投影/增量水位", () => {
    expect(body).toContain("histEvents = sid ? null : [];");
    expect(body).toContain("sessionStatus = null;");
    expect(body).toContain("if (sid) ssSeqBySid.delete(sid); else ssSeqBySid.clear();");
    expect(body).toContain("histLastSeq = -1; histSession = null;");
    expect(body).toContain("histHasMore = false; histNextBeforeSeq = undefined; histPageLoading = false;");
  });

  it("流式尾块 / 子代理流式草稿 / 子消息未读", () => {
    expect(body).toContain("stStream = null; subStreams.clear(); subMsgReset();");
  });

  it("置顶状态条与白板会话上下文", () => {
    expect(body).toContain('$("chatStatusbar").innerHTML = "";');
    expect(body).toContain('boardDoc = null; boardTaskId = ""; boardSelNode = null; boardItems = [];');
    expect(body).toContain("boardOverlayB64 = null; sessionOverlayB64 = null;");
    expect(body).toContain("wbAbortStroke();");
  });

  it("派生渲染刷新到位(徽标/上下文档/目标/语音锁态)", () => {
    expect(body).toContain("renderStatusbar();");
    expect(body).toContain("renderSubDir();");
    expect(body).toContain("ctxPillRender();");
    expect(body).toContain("renderVoiceState();");
    expect(body).toContain('const gp = $("goalPill");');
    expect(body).toContain('if (!currentSid) lastGoalState = null;');
  });

  it("公共函数不碰存储(草稿/偏好键语义保持现状)", () => {
    expect(body).not.toContain("localStorage");
    expect(body).not.toContain("sessionStorage");
  });
});

describe("两处入口共用同一清单(防漂移)", () => {
  it("openSession 调公共重置,且不再各自维护一套内联清单", () => {
    const body = bodyOf("openSession");
    expect(body).toContain("resetSessionDomainUI(sid);");
    // 已收进公共函数,入口处不再重复(重复=下次改一处漏一处)
    expect(body).not.toContain("boardDoc = null");
    expect(body).not.toContain("subMsgReset()");
    expect(body).not.toContain("subStreams.clear()");
    expect(body).not.toContain('$("chatStatusbar").innerHTML = ""');
  });

  it("newDraft 调同一公共重置 + 输入区会话域件归零", () => {
    const body = bodyOf("newDraft");
    expect(body).toContain('resetSessionDomainUI("");');
    expect(body).toContain("askRenderBar();");
    expect(body).toContain("pendingAtts = []; attRender();");
    expect(body).toContain("inChip = null; cmdChipUpdate();");
    // 派生渲染:发送钮/输入框/语音锁态在重置后刷新
    expect(body).toContain("renderSendBtn();");
    expect(body).toContain("restoreDraft();"); // 草稿文本仍按 zh:draft:* 恢复
    expect(body).toContain('onSessionChange("");');
  });

  it("草稿态存储语义不变:只移除 zh:sid,不写任何新键", () => {
    const body = bodyOf("newDraft");
    expect(body).toContain('sessionStorage.removeItem("zh:sid")');
    expect(body).toContain('localStorage.removeItem("zh:sid")');
    // 不得在草稿态清/写别的存储键(草稿、权限、思考力度、折叠态等偏好必须留着)
    const storageCalls = body.match(/(localStorage|sessionStorage)\.[a-zA-Z]+\(/g) || [];
    expect(storageCalls.sort()).toEqual(['localStorage.removeItem(', 'sessionStorage.removeItem(']);
    expect(body).not.toContain("localStorage.clear");
    expect(body).not.toContain("sessionStorage.clear");
  });
});
