/**
 * 基因提示回放验证:leave-one-out 防循环泄漏 + 精确率读出。
 * 钉住:①回放链自己的 (类,模块) 基因被剔除(唯一证据源=循环,不许假装命中);
 * ②drift 链不参与(注入臂不针对演进);③wouldShow=0 → matchRate=null(诚实,不除零);
 * ④命中=提示类别覆盖实际缺陷类。
 */
import { describe, expect, it } from "vitest";
import { replayGeneHints, replayGeneHintsPrecise, type ReplayChainInput } from "../src/gene-replay.js";
import type { ReworkChainLine } from "../src/rework-chain.js";
import type { DefectGene } from "@lampgenie/runtime/agent/direction-atlas";

const NOW = Date.now();

function chain(over: Partial<ReworkChainLine>): ReworkChainLine {
  return {
    v: 1, at: NOW, projectId: "p",
    buildSession: "ws-a", buildTitle: "开发导出模块",
    fixSession: "ws-b", fixTitle: "修复导出模块的空值崩溃",
    logicalKey: "src/export", path: "src/export.ts",
    evidenceLevel: "strong", classification: "rework", defectClass: "boundary",
    attribution: { verdict: "preventable", readByA: 0, fixFaceTotal: 2, fixAddedTest: false },
    ...over,
  } as ReworkChainLine;
}

function gene(defectClass: string, module: string, count = 1): DefectGene {
  return { id: `gene-${defectClass}-${module}`, defectClass, module, count, lastAt: "2026-11-15T00:00:00.000Z" };
}

describe("replayGeneHints(leave-one-out 回放)", () => {
  it("循环剔除:链自己的 (类,模块) 基因唯一来源是本链 → 剔除后不命中;其它模块基因可命中", () => {
    const inputs: ReplayChainInput[] = [
      {
        chain: chain({ buildSession: "ws-a", defectClass: "boundary", logicalKey: "src/export" }),
        buildText: "开发 src/export.ts 的导出功能,并顺带调整 src/panel.ts",
      },
    ];
 // 基因池:export/boundary(本链唯一贡献,须剔除)+ panel/contract(独立来源,可用)
    const genes = [gene("boundary", "src/export.ts"), gene("contract", "src/panel.ts")];
    const r = replayGeneHints(inputs, genes);
    expect(r.chains).toBe(1);
    expect(r.wouldShow).toBe(1); // panel 基因仍命中(任务文本提到 panel.ts)
    expect(r.classMatch).toBe(0); // 提示类别 contract ≠ 实际 boundary → 不算命中(诚实)
    expect(r.matchRate).toBe(0);
  });

  it("命中:其它会话贡献的同模块 boundary 基因(非本链唯一来源)不被误剔", () => {
    const inputs: ReplayChainInput[] = [
      {
        chain: chain({ buildSession: "ws-a2", defectClass: "boundary", logicalKey: "src/export" }),
        buildText: "开发 src/export.ts 的导出功能",
      },
    ];
 // 池里 export/boundary 来自**其它链**(count=3,多源)——回放剔除只针对「本链是唯一证据」,
 // v1 口径:同 (类,模块) 一律剔除(保守)。因此本例 wouldShow=0、matchRate=null(诚实)。
    const genes = [gene("boundary", "src/export.ts", 3)];
    const r = replayGeneHints(inputs, genes);
    expect(r.wouldShow).toBe(0);
    expect(r.matchRate).toBeNull();
  });

  it("跨模块命中:链的模块基因被剔,但任务文本还提到另一个有基因的模块且类别一致", () => {
    const inputs: ReplayChainInput[] = [
      {
        chain: chain({ defectClass: "contract", logicalKey: "src/deal" }),
        buildText: "开发 src/deal.ts 契约模块,复用 src/panel.ts 的公共逻辑",
      },
    ];
    const genes = [gene("contract", "src/deal.ts"), gene("contract", "src/panel.ts", 2)];
    const r = replayGeneHints(inputs, genes);
    expect(r.wouldShow).toBe(1); // panel/contract 命中(独立来源)
    expect(r.classMatch).toBe(1); // 提示类别 contract == 实际 contract ✓
    expect(r.matchRate).toBe(1);
    expect(r.preventable.matchRate).toBe(1);
  });

  it("unmeasurable:uncategorized 链不进精确率分母;同键他链贡献不被误剔(precise)", () => {
    const uncatted = chain({ defectClass: "uncategorized" });
    const panelChain = chain({ buildSession: "ws-m", fixSession: "ws-fm", defectClass: "contract", logicalKey: "src/panel", path: "src/panel.ts" });
    const inputs: ReplayChainInput[] = [
      { chain: uncatted, buildText: "修 src/export.ts" },
      { chain: panelChain, buildText: "开发 src/panel.ts 面板" },
    ];
 // 快照模式:同键基因被保守剔除 → panel 链 wouldShow=0
    const snap = replayGeneHints(inputs, [gene("contract", "src/panel.ts", 2)]);
    expect(snap.unmeasurable).toBe(1);
    expect(snap.wouldShow).toBe(0);
 // 精确模式:池来自链本身,同键的**其它链**(不同 fix 事件)仍贡献 → wouldShow=1 且命中
    const otherContributor = chain({ buildSession: "ws-m2", fixSession: "ws-fm2", defectClass: "contract", logicalKey: "src/panel", path: "src/panel.ts" });
    const precise = replayGeneHintsPrecise(inputs, [uncatted, panelChain, otherContributor]);
    expect(precise.unmeasurable).toBe(1);
    expect(precise.wouldShow).toBe(1);
    expect(precise.classMatch).toBe(1);
    expect(precise.matchRate).toBe(1); // uncategorized 已出分母
  });

  it("drift 链不参与;missingBuildText 计数;preventable 子集单列", () => {
    const inputs: ReplayChainInput[] = [
      { chain: chain({ classification: "drift" }), buildText: "按新需求调整" },
      { chain: chain({ buildSession: "ws-gone", verdict: undefined }), buildText: undefined },
      {
        chain: chain({ buildSession: "ws-p", attribution: { verdict: "unknown", readByA: 2, fixFaceTotal: 2, fixAddedTest: false } } as Partial<ReworkChainLine>),
        buildText: "修 src/panel.ts 与 src/other.ts",
      },
    ];
    const genes = [gene("boundary", "src/panel.ts", 2)];
    const r = replayGeneHints(inputs, genes);
    expect(r.chains).toBe(2); // drift 排除
    expect(r.missingBuildText).toBe(1);
    expect(r.wouldShow).toBe(1); // 只有 ws-p 命中 panel
    expect(r.preventable.chains).toBe(1); // 只有第一条 preventable(其 buildText 缺?不——drift 排除后 preventable=第一条(ws-gone))
    expect(r.preventable.wouldShow).toBe(0);
    expect(r.preventable.matchRate).toBeNull();
  });
});
