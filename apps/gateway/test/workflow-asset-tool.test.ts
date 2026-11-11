/**
 * :run_workflow 接资产 / caps / 运行中 amend(生产工具面)。
 * - 读源码断言接线在(asset-store 实例、runningWorkflows set/delete、action 参数面);
 * - 纯路径单测(资产目录 / project→global 查找 / caps 提取);
 * - 端到端:真 runWorkflowTool + MemoryJournal + 假 executor + 临时资产目录,
 * 覆盖 save/list/load/caps/amend/未知资产/旧行为兼容。
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { WorkflowAssetStore, type WorkflowAsset } from "@lampgenie/workflow/asset-store";
import {
  runWorkflowTool,
  workflowAssetDirs,
  findWorkflowAsset,
  workflowCapsFromArgs,
} from "../src/agent-wiring.js";

const TRIVIAL = `report({ ok: true });`;
const HANG = `const r = await agent("worker").ask("慢任务"); report({ r });`;

type SpawnCb = (e: { type: "result"; result: { ok: boolean; finalText?: string; error?: { detail?: string } } }) => void;

/** 假 executor:spawn 只登记回调(由测试决定何时/以何结果完成),可制造「运行中」。 */
function makeExecutor() {
  const pending: SpawnCb[] = [];
  const calls: string[] = [];
  return {
    pending,
    calls,
    spawn(opts: { instructions: string }, cb: SpawnCb) {
      calls.push(opts.instructions);
      pending.push(cb);
      return Promise.resolve({});
    },
    flush(text = "done", ok = true) {
      const cb = pending.shift();
      if (!cb) throw new Error("没有待完成的 spawn");
      cb({ type: "result", result: { ok, finalText: text } });
    },
  };
}

const tempBases: string[] = [];
function makeDirs(): { project: string; global: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "wf-asset-tool-"));
  tempBases.push(base);
  return { project: join(base, "project"), global: join(base, "global"), base };
}

function makeTool(exec = makeExecutor(), dirs = makeDirs()) {
  const journal = new MemoryJournal();
  const tool = runWorkflowTool(journal, exec as never, "s-test", undefined, {
    project: dirs.project,
    global: dirs.global,
  });
  return { tool, exec, dirs, journal };
}

const call = async (tool: { execute: (a: unknown) => Promise<string> }, args: unknown) => tool.execute(args);
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

/** 等条件成立(轮询 5ms,超时抛错),用于「run 已在飞」的判定。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function asset(name: string, scope: "project" | "global", extra: Partial<WorkflowAsset> = {}): WorkflowAsset {
  return {
    name,
    script: TRIVIAL,
    paramsSchema: "{}",
    scope,
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  };
}

afterEach(() => {
  for (const base of tempBases.splice(0)) rmSync(base, { recursive: true, force: true });
});

describe("源码接线(读 agent-wiring.ts 断言)", () => {
  const src = readFileSync(new URL("../src/agent-wiring.ts", import.meta.url), "utf-8");

  it("生产工具面接了 WorkflowAssetStore + runningWorkflows set/delete", () => {
    expect(src).toContain("new WorkflowAssetStore(");
    expect(src).toContain("runningWorkflows.set(wfId, engine)");
    expect(src).toContain("runningWorkflows.delete(wfId)");
    expect(src).toContain("engine.currentCaps()");
    expect(src).toContain("engine.amend(workflowAmendPatch(");
  });

  it("asset 加载先 project 后 global,未知资产点名 action=save", () => {
    expect(src).toContain("findWorkflowAsset(p.assets, g.assets, assetName)");
    expect(src).toContain("先 action=save 保存");
  });

  it("新参数全部接线(action/asset/saveAs/scope/paramsSchema/maxConcurrency/subagentModel/wfId)", () => {
    const { tool } = makeTool();
    const props = tool.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(props.properties)).toEqual(
      expect.arrayContaining([
        "template",
        "args",
        "script",
        "action",
        "asset",
        "saveAs",
        "scope",
        "paramsSchema",
        "description",
        "maxConcurrency",
        "subagentModel",
        "wfId",
      ]),
    );
 // 旧参数原样在,且不是必填(旧调用零改动)
    expect(props.properties.template).toBeTruthy();
    expect(props.properties.script).toBeTruthy();
    expect((tool.parameters as { required?: string[] }).required).toBeUndefined();
  });
});

describe("纯路径", () => {
  it("workflowAssetDirs:project=<root>/.genie/workflows,global=<home>/.genie/workflows", () => {
    expect(workflowAssetDirs("/repo", "/home/u")).toEqual({
      project: join("/repo", ".genie", "workflows"),
      global: join("/home/u", ".genie", "workflows"),
    });
  });

  it("findWorkflowAsset:project 优先,global 兜底,都没有=undefined", () => {
    const p = asset("same", "project");
    const g = asset("same", "global");
    expect(findWorkflowAsset([p], [g], "same")).toBe(p);
    expect(findWorkflowAsset([], [g], "same")).toBe(g);
    expect(findWorkflowAsset([p], [g], "missing")).toBeUndefined();
    expect(findWorkflowAsset([], [], "missing")).toBeUndefined();
  });

  it("workflowCapsFromArgs:合法提取/越界报错/空串模型报错", () => {
    expect(workflowCapsFromArgs({ maxConcurrency: 6, subagentModel: " m1 " })).toEqual({
      caps: { maxConcurrency: 6, subagentModel: "m1" },
    });
    expect(workflowCapsFromArgs({}).caps).toEqual({});
    expect(workflowCapsFromArgs({ maxConcurrency: 0 }).error).toContain("1..32");
    expect(workflowCapsFromArgs({ maxConcurrency: 33 }).error).toContain("1..32");
    expect(workflowCapsFromArgs({ maxConcurrency: 2.5 }).error).toContain("1..32");
    expect(workflowCapsFromArgs({ subagentModel: "  " }).error).toContain("subagentModel");
  });
});

describe("action=save", () => {
  it("保存成功回 {ok,name,scope,path},文件真落盘且带 script/paramsSchema", async () => {
    const { tool } = makeTool();
    const out = parse(
      await call(tool, {
        action: "save",
        saveAs: "smoke",
        script: TRIVIAL,
        paramsSchema: `{"type":"object"}`,
        description: "冒烟",
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.name).toBe("smoke");
    expect(out.scope).toBe("project");
    expect(existsSync(String(out.path))).toBe(true);
    const saved = JSON.parse(readFileSync(String(out.path), "utf-8")) as WorkflowAsset;
    expect(saved.script).toBe(TRIVIAL);
    expect(saved.paramsSchema).toBe(`{"type":"object"}`);
    expect(saved.description).toBe("冒烟");
  });

  it("scope=global 落到 global 目录", async () => {
    const { tool, dirs } = makeTool();
    const out = parse(await call(tool, { action: "save", saveAs: "g1", script: TRIVIAL, scope: "global" }));
    expect(out.scope).toBe("global");
    expect(String(out.path).startsWith(join(dirs.global, "")) || String(out.path) === join(dirs.global, "g1.json")).toBe(true);
    expect(existsSync(join(dirs.global, "g1.json"))).toBe(true);
  });

  it("script 为空 → INVALID 文本", async () => {
    const { tool } = makeTool();
    const out = await call(tool, { action: "save", saveAs: "x", script: "   " });
    expect(out).toContain("INVALID");
    expect(out).toContain("script");
  });

  it("saveAs 非法 → INVALID 文本", async () => {
    const { tool } = makeTool();
    const out = await call(tool, { action: "save", saveAs: "../evil", script: TRIVIAL });
    expect(out).toContain("INVALID");
  });

  it("paramsSchema 非法 JSON → INVALID;非对象 schema → INVALID", async () => {
    const { tool } = makeTool();
    expect(await call(tool, { action: "save", saveAs: "x", script: TRIVIAL, paramsSchema: "{not json" })).toContain("INVALID");
    expect(await call(tool, { action: "save", saveAs: "x", script: TRIVIAL, paramsSchema: "[1,2]" })).toContain("INVALID");
  });
});

describe("action=list", () => {
  it("合并两目录,name/scope/updatedAt/description 齐全", async () => {
    const { tool } = makeTool();
    await call(tool, { action: "save", saveAs: "p1", script: TRIVIAL, description: "项目资产" });
    await call(tool, { action: "save", saveAs: "g1", script: TRIVIAL, scope: "global", description: "全局资产" });
    const out = parse(await call(tool, { action: "list" }));
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    const assets = out.assets as { name: string; scope: string; updatedAt: number; description?: string }[];
    expect(assets.map((a) => a.name).sort()).toEqual(["g1", "p1"]);
    for (const a of assets) {
      expect(typeof a.updatedAt).toBe("number");
      expect(a.scope === "project" || a.scope === "global").toBe(true);
    }
    expect(assets.find((a) => a.name === "p1")?.description).toBe("项目资产");
  });

  it("超出 50 条时截断到 50", async () => {
    const dirs = makeDirs();
    const store = new WorkflowAssetStore({ dir: dirs.project });
    for (let i = 0; i < 55; i++) {
      const saved = await store.save(asset(`a${String(i).padStart(2, "0")}`, "project", { updatedAt: i }));
      expect(saved.ok).toBe(true);
    }
    const { tool } = makeTool(makeExecutor(), dirs);
    const out = parse(await call(tool, { action: "list" }));
    expect(out.count).toBe(50);
    expect((out.assets as unknown[]).length).toBe(50);
  });
});

describe("action=run:asset / caps / 旧行为", () => {
  it("按 asset 名加载 script 并运行(project 优先)", async () => {
    const { tool, dirs } = makeTool();
    await call(tool, { action: "save", saveAs: "runme", script: TRIVIAL });
    const out = parse(await call(tool, { action: "run", asset: "runme" }));
    expect(out.ok).toBe(true);
    expect(existsSync(join(dirs.project, "runme.json"))).toBe(true);
  });

  it("global 资产可被 asset 兜底加载", async () => {
    const { tool } = makeTool();
    await call(tool, { action: "save", saveAs: "g-run", script: TRIVIAL, scope: "global" });
    const out = parse(await call(tool, { action: "run", asset: "g-run" }));
    expect(out.ok).toBe(true);
  });

  it("未知 asset → 错误点名 action=save(list 指引)", async () => {
    const { tool } = makeTool();
    const out = await call(tool, { action: "run", asset: "nope" });
    expect(out).toContain("资产不存在");
    expect(out).toContain("action=save");
  });

  it("maxConcurrency=6 → run 返回 caps.maxConcurrency=6", async () => {
    const { tool } = makeTool();
    const out = parse(await call(tool, { action: "run", script: TRIVIAL, maxConcurrency: 6 }));
    expect(out.ok).toBe(true);
    expect((out.caps as { maxConcurrency?: number }).maxConcurrency).toBe(6);
  });

  it("subagentModel 也进 caps", async () => {
    const { tool } = makeTool();
    const out = parse(await call(tool, { action: "run", script: TRIVIAL, subagentModel: "model-x" }));
    expect((out.caps as { subagentModel?: string }).subagentModel).toBe("model-x");
  });

  it("旧调用(无新参数)返回字段不变且不出现 caps 键", async () => {
    const { tool } = makeTool();
    const out = parse(await call(tool, { script: TRIVIAL }));
    expect(Object.keys(out)).toEqual(["ok", "partial", "items", "logs"]);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain("caps");
  });

  it("旧调用 template 分支仍走 renderTemplate(无效模板报错而非崩)", async () => {
    const { tool } = makeTool();
    const out = await call(tool, { template: "no-such-template", args: "{}" });
    expect(out).toContain("run_workflow 错误");
  });

  it("maxConcurrency 越界 → 工具层报错,不启动 run", async () => {
    const { tool, exec, journal } = makeTool();
    const out1 = await call(tool, { action: "run", script: TRIVIAL, maxConcurrency: 0 });
    const out2 = await call(tool, { action: "run", script: TRIVIAL, maxConcurrency: 99 });
    expect(out1).toContain("1..32");
    expect(out2).toContain("1..32");
    expect(exec.calls).toHaveLength(0);
    expect(journal.readAll().filter((e) => String(e.kind) === "workflow.run.start")).toHaveLength(0);
  });

  it("无 template/script/asset → 明确报错", async () => {
    const { tool } = makeTool();
    expect(await call(tool, {})).toContain("需要 template、script 或 asset");
  });

  it("未知 action → 报错", async () => {
    const { tool } = makeTool();
    expect(await call(tool, { action: "explode" })).toContain("未知 action");
  });
});

describe("action=amend(运行中)", () => {
  it("缺 wfId → 明确报错", async () => {
    const { tool } = makeTool();
    expect(await call(tool, { action: "amend", maxConcurrency: 6 })).toContain("wfId 必填");
  });

  it("wfId 未在跑 → 「无运行中的 workflow」", async () => {
    const { tool } = makeTool();
    expect(await call(tool, { action: "amend", wfId: "wf-not-running", maxConcurrency: 6 })).toContain("无运行中的 workflow");
  });

  it("运行中 amend → APPLIED 且 run 收尾仍成功,收尾后注册表清理", async () => {
    const { tool, exec } = makeTool();
    const runPromise = call(tool, { action: "run", script: HANG, wfId: "wf-live" });
    await waitFor(() => exec.pending.length > 0);

    const amend = parse(await call(tool, { action: "amend", wfId: "wf-live", maxConcurrency: 6 }));
    expect(amend.ok).toBe(true);
    expect(amend.code).toBe("APPLIED");
    expect((amend.caps as { maxConcurrency?: number }).maxConcurrency).toBe(6);

    exec.flush("子代理结果");
    const runOut = parse(await runPromise);
    expect(runOut.ok).toBe(true);
    expect((runOut.caps as { maxConcurrency?: number }).maxConcurrency).toBe(6);

 // finally 已删除:同一 wfId 再 amend 不再命中
    expect(await call(tool, { action: "amend", wfId: "wf-live", maxConcurrency: 8 })).toContain("无运行中的 workflow");
  });

  it("amend 未知字段 → INVALID_FIELD(engine 判定)", async () => {
    const { tool, exec } = makeTool();
    const runPromise = call(tool, { action: "run", script: HANG, wfId: "wf-invalid-field" });
    await waitFor(() => exec.pending.length > 0);
    const out = parse(await call(tool, { action: "amend", wfId: "wf-invalid-field", maxParallel: 8 }));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("INVALID_FIELD");
    exec.flush();
    await runPromise;
  });

  it("amend 越界值 → INVALID_VALUE(engine 判定,不半应用)", async () => {
    const { tool, exec } = makeTool();
    const runPromise = call(tool, { action: "run", script: HANG, wfId: "wf-invalid-value" });
    await waitFor(() => exec.pending.length > 0);
    const out = parse(await call(tool, { action: "amend", wfId: "wf-invalid-value", maxConcurrency: 99 }));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("INVALID_VALUE");
    exec.flush();
    const runOut = parse(await runPromise);
    expect(runOut.ok).toBe(true);
    expect("caps" in runOut).toBe(false); // 失败的 amend 不改 caps
  });

  it("运行中 amend subagentModel → APPLIED 并进 run 返回 caps", async () => {
    const { tool, exec } = makeTool();
    const runPromise = call(tool, { action: "run", script: HANG, wfId: "wf-model" });
    await waitFor(() => exec.pending.length > 0);
    const out = parse(await call(tool, { action: "amend", wfId: "wf-model", subagentModel: "model-z" }));
    expect(out.code).toBe("APPLIED");
    exec.flush();
    const runOut = parse(await runPromise);
    expect((runOut.caps as { subagentModel?: string }).subagentModel).toBe("model-z");
  });
});
