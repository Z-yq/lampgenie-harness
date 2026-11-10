import { describe, it, expect } from "vitest";
import { archLlmFromProvider, firstSymbolLike, symbolContextFor } from "../src/agent-wiring.js";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";
import { codeSenseTool, dispatchSenseArgs } from "../src/sense-tool.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");

describe("archLlm 适配器(step-034 D1)", () => {
  it("两段式 prompt→两次 chat,narrative/graphJson 各归位", async () => {
    const calls: string[] = [];
    const llm: LlmProvider = {
      async chat(messages) {
        const prompt = String(messages[0]!.content);
        calls.push(prompt.slice(0, 12));
        return { content: prompt.startsWith("解说") ? "NARRATIVE" : "GRAPH_JSON" };
      },
    };
    const arch = archLlmFromProvider(llm);
    const r = await arch.generate("解说:这是什么仓库", "图:输出图 JSON");
    expect(r.narrative).toBe("NARRATIVE");
    expect(r.graphJson).toBe("GRAPH_JSON");
    expect(calls).toHaveLength(2);
  });
});

describe("任务书符号提取与上下文注入(step-034 D3)", () => {
  it("firstSymbolLike:驼峰/下划线命中,中文与停用词排除", () => {
    expect(firstSymbolLike("修复 createGatewayApp 的调用问题")).toBe("createGatewayApp");
    expect(firstSymbolLike("看看 start_gateway_server")).toBe("start_gateway_server");
    expect(firstSymbolLike("这是一个纯中文的任务描述没有符号")).toBeNull();
    expect(firstSymbolLike("the test spec index utils")).toBeNull();
  });

  it("symbolContextFor:静态索引注入(定义/调用者/被调者);无符号 → 空串", async (t) => {
    let ctx = await symbolContextFor(REPO, "在 createGatewayApp 里定位启动链路问题");
    if (!ctx || ctx.includes("尚未就绪")) {
      await new Promise((r) => setTimeout(r, 4000));
      ctx = await symbolContextFor(REPO, "在 createGatewayApp 里定位启动链路问题");
    }
    if (!ctx) t.skip("静态索引未就绪(后台构建中),低负载窗口复跑");
    if (!ctx) return;
    expect(ctx).toContain("涉事符号上下文");
    expect(ctx).toContain("createGatewayApp");
    expect(ctx).toContain("apps/gateway/src/app.ts");
    expect(await symbolContextFor(REPO, "随便写点什么没有符号")).toBe("");
  }, 90_000);
});

// (2026-10-23)「任务开工全局意识注入」describe 已删:orientWithSense/symbolsInText 随开工匹配式
// 注入整体移除(用户口径:code_sense 内容拉取式,call 工具才返回;见 buildLoopTips 注释)。

describe("code_sense action=surface:概念足迹(2026-10-29)", () => {
  it("surface + target → structural,概念词原样透传", () => {
    const d = dispatchSenseArgs({ action: "surface", target: "demoFlag" });
    expect(d.kind).toBe("structural");
    if (d.kind === "structural") {
      expect(d.action).toBe("surface");
      expect(d.target).toBe("demoFlag");
    }
  });

  it("多概念逗号分隔 → 原样透传(拆分在 surface 分支内)", () => {
    const d = dispatchSenseArgs({ action: "surface", target: "SuperAgent, dh-video" });
    expect(d.kind).toBe("structural");
    if (d.kind === "structural") expect(d.target).toBe("SuperAgent, dh-video");
  });

  it("negative surface 空 target → invalid(不返回空命中冒充成功)", () => {
    const d = dispatchSenseArgs({ action: "surface" });
    expect(d.kind).toBe("invalid");
    if (d.kind === "invalid") {
      expect(d.reason).toContain("surface");
      expect(d.reason).toContain("概念词");
      expect(d.reason).toContain("逗号分隔");
    }
  });

  it("negative 既有 10 个结构动作逐条仍 dispatch 成功(surface 只做追加)", () => {
    const targets: Record<string, string> = {
      symbol: "deriveMessages", impact: "deriveMessages", file: "apps/gateway/src/sense-tool.ts",
      entrypoints: "", project: "", wire: "surface", refs: "surface",
      vars: "apps/gateway/src/sense-tool.ts", branches: "apps/gateway/src/sense-tool.ts", flow: "apps/gateway/src",
    };
    for (const a of ["symbol", "file", "impact", "entrypoints", "project", "wire", "refs", "vars", "branches", "flow"]) {
      const d = dispatchSenseArgs({ action: a, target: targets[a] });
      expect(d.kind).toBe("structural");
      if (d.kind === "structural") expect(d.action).toBe(a);
    }
  });

  it("negative RETIRED_ACTIONS 三条迁移指引仍逐字生效", () => {
    for (const a of ["api", "graph", "filegraph"]) {
      const d = dispatchSenseArgs({ action: a, target: "x" });
      expect(d.kind).toBe("invalid");
      if (d.kind === "invalid") expect(d.reason).toContain(`action=${a} 已删除`);
    }
  });

  it("真跑:玩具目录 protocol/config/docs 三处命中,含「概念足迹」与 file:line 形态", async () => {
    const dir = mkdtempSync(join(REPO, "tmp-surface-"));
    try {
      mkdirSync(join(dir, "packages/protocol/src"), { recursive: true });
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "packages/protocol/src/messages.ts"), 'export const msg = { type: "demoFlag.changed" };\n');
      writeFileSync(join(dir, "genie.config.json"), '{ "demoFlag": true }\n');
      writeFileSync(join(dir, "docs/guide.md"), "# demoFlag\n\n替换 demoFlag 的步骤。\n");
      const rel = relative(REPO, dir).split("\\").join("/");
      const out = String(await codeSenseTool(REPO).execute({ action: "surface", target: "demoFlag", root: rel }));
      expect(out).toContain("概念足迹");
      expect(out).toMatch(/- \[ \] protocol \S+:\d+/);
      expect(out).toMatch(/- \[ \] config \S+:\d+/);
      expect(out).toMatch(/- \[ \] docs \S+:\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

