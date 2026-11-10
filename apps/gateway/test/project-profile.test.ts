/**
 * 单测:项目档案管线(模块聚类/import 边/进度状态机/演进记录/新模块检测/mermaid)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectProfileIndex, moduleOf, extractRelImports, planToInstruction } from "../src/project-profile.js";

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "gwprof-"));
  const w = (p: string, c: string) => {
    mkdirSync(join(root, dirname2(p)), { recursive: true });
    writeFileSync(join(root, p), c, "utf-8");
  };
  const dirname2 = (p: string) => p.split("/").slice(0, -1).join("/") || ".";
  w("packages/core/src/a.ts", "export const a = 1;\nexport const b = 2;\n");
  w("packages/core/src/b.ts", 'import { a } from "./a";\nexport const b = a + 1;\n');
  w("packages/ui/src/c.ts", 'import { b } from "@x/core";\nimport { readFileSync } from "node:fs";\nexport const c = 1;\n');
  w("apps/web/src/main.ts", 'import { c } from "../../../packages/ui/src/c";\nconsole.log(c);\n');
  w("tools/build.ts", 'export {};\n');
  w("README.md", "# x\n");
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(root, "node_modules", "junk", "x.ts"), "export {};");
  return root;
}

describe("模块聚类与 import 提取(纯函数)", () => {
  it("moduleOf:packages/apps/src/顶层目录/根文件", () => {
    expect(moduleOf("packages/core/src/a.ts")).toBe("core");
    expect(moduleOf("apps/web/src/main.ts")).toBe("web");
    expect(moduleOf("src/util/x.ts")).toBe("util");
    expect(moduleOf("docs/guide.md")).toBe("docs");
    expect(moduleOf("build.ts")).toBe("(根)");
  });
  it("extractRelImports:TS 相对 import/require/py from-import;裸包不进", () => {
    const ts = extractRelImports("a/b.ts", 'import { x } from "./x";\nconst y = require("../lib/z");\nimport "node:fs";\nimport { p } from "pkga";');
    expect(ts).toEqual(["./x", "../lib/z"]);
    const py = extractRelImports("m/n.py", "from .sib import x\nfrom ..pkg.y import z\nimport os\n");
    expect(py).toEqual(["sib", ".pkg.y"]);
  });
});

describe("ProjectProfileIndex(管线端到端)", () => {
  it("build:进度推进→done;模块/边/mermaid/统计齐;持久化;跳过 node_modules", async () => {
    const root = seedProject();
    const dir = mkdtempSync(join(tmpdir(), "gwprof-store-"));
    try {
      const roots = new Map([["p1", root]]);
      const idx = new ProjectProfileIndex(dir, (pid) => roots.get(pid));
      const events: { progress: number; state: string }[] = [];
      idx.onProgress((p) => events.push({ progress: p.progress, state: p.state }));
      const p = await idx.build("p1", root);
      expect(p.state).toBe("done");
      expect(p.progress).toBe(100);
      // 模块:core/ui/web/build(node_modules 不入)
      const names = p.modules.map((m) => m.name).sort();
      expect(names).toEqual(["build", "core", "ui", "web"]);
      const core = p.modules.find((m) => m.name === "core")!;
      expect(core.files).toBe(2);
      expect(core.lines).toBeGreaterThanOrEqual(3);
      // 边:web→ui(相对 import 解析命中),ui 无边到 core(裸包名不算)
      expect(p.edges).toContainEqual({ from: "web", to: "ui" });
      expect(p.edges.some((e) => e.to === "core")).toBe(false);
      // mermaid 含模块节点与 class
      expect(p.mermaid).toContain("flowchart LR");
      expect(p.mermaid).toContain("core");
      // 进度事件单调,终态 done
      expect(events.at(-1)!.state).toBe("done");
      expect(events.some((e) => e.progress < 100)).toBe(true);
      // 持久化可重载
      const idx2 = new ProjectProfileIndex(dir, (pid) => roots.get(pid));
      const again = idx2.get("p1");
      expect(again?.state).toBe("done");
      expect(again?.modules.length).toBe(4);
      // getOrStart:done 档案直接返回(不重启)
      const r = idx2.getOrStart("p1");
      expect((r as { modules?: unknown[] }).modules).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recordChange:文件→模块映射 + recentChanges 持久化 + 新模块检测(重建)", async () => {
    const root = seedProject();
    const dir = mkdtempSync(join(tmpdir(), "gwprof-store2-"));
    try {
      const idx = new ProjectProfileIndex(dir, () => root);
      await idx.build("p1", root);
      idx.recordChange("p1", { taskId: "t9", title: "改核心", files: [{ path: join(root, "packages/core/src/a.ts") }, { path: join(root, "apps/web/src/main.ts") }], add: 10, del: 2 });
      const p1 = idx.get("p1")!;
      expect(p1.recentChanges[0].title).toBe("改核心");
      expect(p1.recentChanges[0].modules.sort()).toEqual(["core", "web"]);
      // 持久化
      const raw = JSON.parse(readFileSync(join(dir, "p1.json"), "utf-8")) as { recentChanges: { title: string }[] };
      expect(raw.recentChanges[0].title).toBe("改核心");
      // 新增模块:重建时出现新目录 → 🆕
      mkdirSync(join(root, "packages", "newmod", "src"), { recursive: true });
      writeFileSync(join(root, "packages", "newmod", "src", "n.ts"), "export const n = 1;\n");
      const p2 = await new Promise<ReturnType<typeof idx.get>>((resolve) => {
        idx.onProgress((x) => { if (x.state === "done" && x.modules.some((m) => m.name === "newmod")) resolve(idx.get("p1")); });
        void idx.rebuild("p1");
      });
      expect(p2!.newModules).toContain("newmod");
      expect(p2!.modules.find((m) => m.name === "newmod")!.addedAt).toBeGreaterThan(0);
      expect(p2!.recentChanges[0].title).toContain("新增模块");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getOrStart:无档案→启动;running 去重;坏项目→error", async () => {
    const root = seedProject();
    const dir = mkdtempSync(join(tmpdir(), "gwprof-store3-"));
    try {
      const idx = new ProjectProfileIndex(dir, (pid) => (pid === "p1" ? root : undefined));
      const r = idx.getOrStart("p1");
      expect(r).toEqual({ started: true });
      // running 期间重复 getOrStart → 返回当前 running 档案
      await new Promise((r2) => setTimeout(r2, 5));
      const r2 = idx.getOrStart("p1") as { state?: string };
      expect(r2.state === "running" || r2.state === "done").toBe(true);
      // 等完成
      for (let i = 0; i < 100 && idx.get("p1")?.state !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
      expect(idx.get("p1")?.state).toBe("done");
      const bad = idx.getOrStart("ghost") as { error?: string };
      expect(bad.error).toContain("项目不存在");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("规划态+git 历史+LLM 导读(全量开发)", () => {
  it("planToInstruction:三类规划→结构化任务书", () => {
    const instr = planToInstruction([
      { id: "a", kind: "add-module", name: "payments", note: "支付域:下单/退款", createdAt: 1 },
      { id: "b", kind: "remove-module", name: "legacy-api", reason: "已被 v2 取代", createdAt: 2 },
      { id: "c", kind: "add-dep", from: "web", to: "payments", note: "下单走支付域", createdAt: 3 },
    ]);
    expect(instr).toContain("新增模块");
    expect(instr).toContain("**payments**:支付域:下单/退款");
    expect(instr).toContain("移除模块");
    expect(instr).toContain("legacy-api");
    expect(instr).toContain("web → payments");
    expect(instr).toContain("规划即契约");
    expect(planToInstruction([])).toBe("");
  });
  it("planUpsert 校验:重名/不存在/自依赖拒绝;图合并规划(pnew/pdel/虚线边)", async () => {
    const { ProjectProfileIndex, mkdtempSync: _m } = { ProjectProfileIndex: (await import("../src/project-profile.js")).ProjectProfileIndex };
    const root = seedProject();
    const dir = mkdtempSync(join(tmpdir(), "gwprof-plan-"));
    try {
      const idx = new ProjectProfileIndex(dir, () => root);
      await idx.build("p1", root);
      // 新增模块 ok
      const r1 = idx.planUpsert("p1", { id: "x1", kind: "add-module", name: "payments", note: "支付", createdAt: 1 }) as { length: number };
      expect(r1.length).toBe(1);
      // 重名拒绝
      expect("error" in Object(idx.planUpsert("p1", { id: "x2", kind: "add-module", name: "core", note: "", createdAt: 2 }))).toBe(true);
      // 移除不存在拒绝
      expect("error" in Object(idx.planUpsert("p1", { id: "x3", kind: "remove-module", name: "ghost", reason: "", createdAt: 3 }))).toBe(true);
      // 自依赖拒绝
      expect("error" in Object(idx.planUpsert("p1", { id: "x4", kind: "add-dep", from: "core", to: "core", note: "", createdAt: 4 }))).toBe(true);
      // 合法:移除 build + 新依赖
      idx.planUpsert("p1", { id: "x5", kind: "remove-module", name: "build", reason: "废弃", createdAt: 5 });
      idx.planUpsert("p1", { id: "x6", kind: "add-dep", from: "web", to: "payments", note: "", createdAt: 6 });
      const p = idx.get("p1")!;
      expect(p.mermaid).toContain("payments");
      expect(p.mermaid).toContain("pnew");
      expect(p.mermaid).toContain("pdel");
      expect(p.mermaid).toContain("-.->");
      // planRemove/planClear
      idx.planRemove("p1", "x1");
      expect(idx.get("p1")!.plan.length).toBe(2);
      idx.planClear("p1");
      expect(idx.get("p1")!.plan).toEqual([]);
      // 清空后图回到无规划形态
      expect(/:::pnew/.test(idx.get("p1")!.mermaid)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("parseGitLog:numstat 文件→模块;30 天计数", async () => {
    const { parseGitLog } = await import("../src/project-profile.js");
    const now = Math.floor(Date.now() / 1000);
    const old = Math.floor((Date.now() - 40 * 86400_000) / 1000);
    const sep = "\u001f";
    const out = [
      "abc12345" + sep + "张三" + sep + String(now) + sep + "feat: 新增支付",
      "12\t0\tpackages/core/src/a.ts",
      "0\t3\tapps/web/src/main.ts",
      "",
      "def67890" + sep + "李四" + sep + String(old) + sep + "chore: 旧改动",
      "5\t5\tpackages/core/src/b.ts",
    ].join("\n");
    const h = parseGitLog(out, "/tmp/x");
    const core = h.find((x) => x.module === "core")!;
    expect(core.commits[0].subject).toContain("支付");
    expect(core.commits).toHaveLength(2); // 新旧都进最近提交
    expect(core.commits30d).toBe(1); // 只有 30 天内那条计数
    const web = h.find((x) => x.module === "web")!;
    expect(web.commits).toHaveLength(1);
  });
  it("enrichDescriptions:mock LLM 一次调用回写 desc+descHasAi,失败降级", async () => {
    const { ProjectProfileIndex } = await import("../src/project-profile.js");
    const root = seedProject();
    const dir = mkdtempSync(join(tmpdir(), "gwprof-ai-"));
    let calls = 0;
    const okLlm = { chat: async () => { calls++; return { content: '{"core":"核心域模型与工具","web":"前端入口"}' }; } };
    try {
      const idx = new ProjectProfileIndex(dir, () => root, okLlm);
      await idx.build("p1", root);
      // enrich 是 done 后 fire-and-forget:轮询等回写
      for (let i = 0; i < 50; i++) {
        const c = idx.get("p1")!.modules.find((m) => m.name === "core");
        if (c && c.descHasAi) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const core = idx.get("p1")!.modules.find((m) => m.name === "core")!;
      expect(core.descHasAi).toBe(true);
      expect(core.desc).toContain("核心域模型");
      expect(core.desc).toContain("文件"); // 统计后缀保留
      expect(calls).toBe(1); // 一次批量调用
      // 失败降级:LLM 抛错→desc 保持
      const badLlm = { chat: async () => { throw new Error("down"); } };
      const idx2 = new ProjectProfileIndex(dir, () => root, badLlm);
      await idx2.build("p1", root);
      await new Promise((r) => setTimeout(r, 100));
      const core2 = idx2.get("p1")!.modules.find((m) => m.name === "core")!;
      expect(typeof core2.desc).toBe("string"); // 未崩,描述在
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
