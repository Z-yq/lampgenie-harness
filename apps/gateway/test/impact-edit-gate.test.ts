/**
 * 高影响模块编辑硬门:advisory→可拒绝的门。
 * 钉住:命中 riskLevel=high 且无 radiation/impact 查询 → 拒;仅有 file 查询不算覆盖;
 * radiation/impact 的符号词边界命中 → 放行;非源码/低风险/新文件 fail-soft;同模块 3 次逃生。
 */
import { describe, expect, it } from "vitest";
import { createHighImpactEditGate } from "../src/sense-edit-guard";
import { createSenseQueryLedger } from "../src/sense-query-ledger";

const ATLAS = {
  derived: {
    moduleActivity: [
      { path: "apps/gateway/src/panel.ts", editSessions: 4, sampleSessions: [], firstSeen: "x", lastSeen: "y", context: { upstream: 98, downstream: 10, isEntrypoint: false, riskLevel: "high" } },
      { path: "apps/gateway/src/safe.ts", editSessions: 1, sampleSessions: [], firstSeen: "x", lastSeen: "y", context: { upstream: 2, downstream: 1, isEntrypoint: false, riskLevel: "low" } },
    ],
  },
};

const PANEL_CONTENT = "export function renderPanel() { return 1; }\n";

function makeGate(overrides: { content?: string | null } = {}) {
  const ledger = createSenseQueryLedger();
  const denials: number[] = [];
  let escapes = 0;
  const gate = createHighImpactEditGate({
    getAtlasJson: () => ATLAS,
    ledger,
    readFileContent: async () => (overrides.content === undefined ? PANEL_CONTENT : overrides.content),
    onDeny: (info) => denials.push(info.denials),
    onEscape: () => { escapes += 1; },
  });
  return { gate, ledger, denials, escapes: () => escapes };
}

describe("impact edit gate(高影响模块写前硬门)", () => {
  it("无 radiation/impact 查询 → 拒;文案指路 radiation 且带上游数", async () => {
    const { gate, denials } = makeGate();
    const out = await gate("apps/gateway/src/panel.ts");
    expect(out).toBeTruthy();
    expect(out).toContain("impact-gate");
    expect(out).toContain("98 个上游调用方");
    expect(out).toContain("code_sense action=radiation");
    expect(denials).toEqual([1]);
  });

  it("radiation 符号词边界命中文件内容 → 放行", async () => {
    const { gate, ledger } = makeGate();
    ledger.record("radiation", "renderPanel");
    expect(await gate("apps/gateway/src/panel.ts")).toBeUndefined();
  });

  it("impact 查询同样算覆盖;仅 file 查询不算", async () => {
    const { gate, ledger } = makeGate();
    ledger.record("file", "apps/gateway/src/panel.ts");
    expect(await gate("apps/gateway/src/panel.ts")).toContain("impact-gate"); // file 面不算
    ledger.record("impact", "renderPanel");
    expect(await gate("apps/gateway/src/panel.ts")).toBeUndefined();
  });

  it("低风险模块/非源码文件 fail-soft 放行", async () => {
    const { gate } = makeGate();
    expect(await gate("apps/gateway/src/safe.ts")).toBeUndefined();
    expect(await gate("docs/readme.md")).toBeUndefined();
  });

  it("新文件(读不到内容)→ 放行", async () => {
    const { gate } = makeGate({ content: null });
    expect(await gate("apps/gateway/src/panel.ts")).toBeUndefined();
  });

  it("逃生:同模块第 3 次尝试放行并记 escape", async () => {
    const { gate, denials, escapes } = makeGate();
    expect(await gate("apps/gateway/src/panel.ts")).toBeTruthy();
    expect(await gate("apps/gateway/src/panel.ts")).toBeTruthy();
    expect(await gate("apps/gateway/src/panel.ts")).toBeUndefined(); // 第 3 次放行
    expect(denials).toEqual([1, 2]);
    expect(escapes()).toBe(1);
  });
});
