import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * step-169 静态契约:panel.ts 的任务列表消费面必须按「索引(TaskIndex)+ 正文按需拉」写。
 * panel.ts 是拼进 HTML 的字符串脚本(无 tsc 校验),这里靠源码断言守住协议形状,防回退。
 * cwd = apps/gateway(vitest 根),故用相对 src/panel.ts。
 */
const src = readFileSync("src/panel.ts", "utf8");

describe("panel 任务索引/正文契约(step-169)", () => {
  it("发出 task.detail.get 请求", () => {
    expect(src).toContain('type: "task.detail.get"');
  });

  it("具备正文缓存的三个登记表与取用函数", () => {
    expect(src).toContain("taskBodyIds");
    expect(src).toContain("taskDetailPending");
    expect(src).toContain("withTaskDetail");
  });

  it("不再直连 taskListPayload(Task 全文投影已从列表帧移除)", () => {
    expect(src).not.toContain("taskListPayload");
  });

  it("task.list 全量替换时保留已加载正文(Object.assign prev 打底)", () => {
    expect(src).toContain("Object.assign({}, tasks.get(");
  });

  it("task.changed 走索引合并 + 终态补拉正文", () => {
    expect(src).toContain("mergeTaskIndex(m.task)");
  });
});

/**
 * step-1036(session.status 增量化):面板侧水位登记 + 请求点收敛 + 切会话清水位。
 * 协议:请求可选 sinceSeq(=已收到末条 seq),回包 status.seq=服务端当前最大 seq。
 */
describe("panel session.status 增量消费契约(step-1036)", () => {
  it("有水位登记表 ssSeqBySid 且请求带 sinceSeq", () => {
    expect(src).toContain("ssSeqBySid");
    expect(src).toContain("sinceSeq");
    expect(src).toContain("function ssSendStatus(");
  });

  it("所有 session.status 请求点统一走 ssSendStatus(零裸发,防漏点)", () => {
    // 裸直发一处都不许留(留一处就是全量回拉)。
    expect(src).not.toContain('wsSafeSend(JSON.stringify({ v: 1, type: "session.status"');
    // 协议字面量只允许出现在 ssSendStatus 函数体里。
    const literalCount = src.split('type: "session.status"').length - 1;
    expect(literalCount).toBe(1);
    // 调用点 = 去掉函数定义那一处后剩 7 处:3s 轮询/子代理目录/打开会话/changed 回拉/
    // subagent.cancel 回包/subchat 4s 轮询/wf 视图 3s 轮询。
    const calls = src.split("ssSendStatus(").length - 1;
    const defs = src.split("function ssSendStatus(").length - 1;
    expect(calls - defs).toBe(7);
  });

  it("切会话/回草稿同清水位(不留旧水位→首帧必全量)", () => {
    expect(src.split("ssSeqBySid.delete(").length - 1).toBe(2); // openSession / draftModelAbort
    expect(src).toContain("ssSeqBySid.clear()"); // newDraft 回草稿态清全部
  });

  it("回包 seq 只记数字(旧网关无 seq 不写水位)", () => {
    expect(src).toContain('typeof ssSeq === "number"');
  });
});