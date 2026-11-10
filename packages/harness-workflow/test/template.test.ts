import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { WorkflowEngine } from "../src/engine";
import { renderTemplate, TEMPLATES } from "../src/templates";

const ROOT = "/mnt/e/workship/genie/lampgenie-harness";

describe("D7 模板", () => {
  it("unit-tests 模板对本仓 packages/core 真跑(vitest)", async () => {
    const j = new MemoryJournal();
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-tpl", executor: null as never,
      dispatch: async (instr) => `[分析] ${instr.slice(0, 40)}`,
    });
    // 模板跑全仓包太久——改造:只跑 core(注入 pkgFilter)
    const script = renderTemplate("unit-tests").replace(
      'const pkgs = packages.map(p => p.split("/")[1]).filter(p => p);',
      'const pkgs = packages.map(p => p.split("/")[1]).filter(p => p === "core");',
    );
    const r = await e.run(script, 300_000);
    expect(r.ok).toBe(true);
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    const coreItem = r.items.find((i) => i.pkg === "core");
    expect(coreItem).toBeTruthy();
    expect(coreItem!.ok).toBe(true);
    expect(String(coreItem!.tail)).toContain("passed");
  }, 300_000);

  it("三模板都在且渲染含 args", () => {
    expect(Object.keys(TEMPLATES)).toEqual(["unit-tests", "functional-test", "algo-eval"]);
    expect(renderTemplate("algo-eval", { cases: [{ id: "c1", input: "i", expect: "e" }] })).toContain('"cases"');
    expect(() => renderTemplate("不存在")).toThrow(/未知模板/);
  });
});
