/**
 * 轨迹泳道工具错误判定回归(txa10 / 迁移)。
 * 历史:recordOf 原在 status-widget.js 的 IIFE 里(需 document 才能整体加载)。 把泳道
 * 渲染核心迁进面板(panel.ts 的 trajLaneRecord),本文件随之把抽取点从 status-widget.js 改到 panel.ts;
 * 判定逻辑(优先 payload.error.origin、缺失回退 /^错误/ 文本)一字未改,仍是「新数据可读 + 旧 journal 可读」
 * 双轨的关键。做法:从 panel.ts 源文件里截取 TRAJ_LANE_ERR_LABEL..trajLaneHtml 之前这一段求值,
 * 验的是真身代码而非复制品;若将来这段挪走,本测试会立刻报「抽取失败」而不是静默通过。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/panel.ts", import.meta.url));

function loadRecordOf(): (e: { kind: string; payload: unknown }) => { err?: boolean; sub?: string } | null {
  const text = readFileSync(SRC, "utf8");
  const start = text.indexOf("const TRAJ_LANE_ERR_LABEL");
  const end = text.indexOf("/** 三泳道 HTML");
  if (start < 0 || end < 0 || end <= start) throw new Error("panel.ts 抽取失败:TRAJ_LANE_ERR_LABEL..trajLaneHtml 段找不到(函数被重命名或移动)");
  const segment = text.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${segment}\nreturn trajLaneRecord;`) as () => (e: { kind: string; payload: unknown }) => { err?: boolean; sub?: string } | null;
  return factory();
}

describe("轨迹泳道 tool.result 错误判定(txa10)", () => {
  const recordOf = loadRecordOf();

  it("新数据:payload.error.origin 存在 → err=true 且副标题带中文归因", () => {
    const r = recordOf({ kind: "tool.result", payload: { name: "bash", content: "ok", durationMs: 12, error: { origin: "timeout", message: "超时" } } });
    expect(r?.err).toBe(true);
    expect(r?.sub).toContain("超时");
  });

  it("新数据五类 origin 全部有中文标签", () => {
    const cases: [string, string][] = [
      ["unknown-tool", "未知工具"], ["timeout", "超时"], ["threw", "抛错"], ["aborted", "已取消"], ["denied", "被拒"],
    ];
    for (const [origin, label] of cases) {
      const r = recordOf({ kind: "tool.result", payload: { name: "t", content: "x", durationMs: 1, error: { origin, message: "m" } } });
      expect(r?.err, origin).toBe(true);
      expect(r?.sub, origin).toContain(label);
    }
  });

  it("旧 journal 回退:无 error 键但 content 以「错误:」开头 → err=true 且不带归因标签", () => {
    const r = recordOf({ kind: "tool.result", payload: { name: "bash", content: "错误:未知工具 x", durationMs: 5 } });
    expect(r?.err).toBe(true);
    expect(r?.sub).toBe("5ms");
  });

  it("成功结果:无 error 键且 content 正常 → err=false", () => {
    const r = recordOf({ kind: "tool.result", payload: { name: "bash", content: "done", durationMs: 7 } });
    expect(r?.err).toBe(false);
  });

  it("负面:正文中间出现「错误:」不算失败(只认前缀,避免正文误报)", () => {
    const r = recordOf({ kind: "tool.result", payload: { name: "bash", content: "stderr 里写着 错误:权限不足", durationMs: 3 } });
    expect(r?.err).toBe(false);
  });
});
