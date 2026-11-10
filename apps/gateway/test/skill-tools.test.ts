import { describe, it, expect, afterEach } from "vitest";
import { skillViewTool, experienceFoldTool, FOLD_CATEGORY_WHITELIST } from "../src/agent-wiring.js";
import { ExperienceStore } from "@lampgenie/experience";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | null = null;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function freshStore(): ExperienceStore {
  dir = mkdtempSync(join(tmpdir(), "gh-skilltools-"));
  return new ExperienceStore(join(dir, "experiences"));
}

describe("skill_view 工具(step-028 D4)", () => {
  it("读全文+view 计数;未知名返回提示", async () => {
    const store = freshStore();
    await store.write({ category: "coding", name: "echo-quirk", description: "echo 执行器任务书要写清楚动词", created_by: "user" }, "echo-child 对模糊指令返回空;任务书必须包含明确动作词。");
    const tool = skillViewTool(store);
    const out = await tool.execute({ category: "coding", name: "echo-quirk" });
    expect(out).toContain("任务书必须包含明确动作词");
    expect(out).toContain("v1");
    expect(store.usage("coding", "echo-quirk").view_count).toBe(1);
    expect(store.usage("coding", "echo-quirk").use_count).toBe(0); // view 不混入 use
    const miss = await tool.execute({ category: "coding", name: "nope" });
    expect(miss).toContain("未找到经验");
  });

  it("板型技能(category=board):按 <type>/<stage> 读全文,不落经验库", async () => {
    const store = freshStore();
    const tool = skillViewTool(store);
    const collect = await tool.execute({ category: "board", name: "code/collect" });
    expect(collect).toContain('<skill_content name="board/code/collect">');
    expect(collect).toContain("code_sense");
    const draw = await tool.execute({ category: "board", name: "ui/draw" });
    expect(draw).toContain('<skill_content name="board/ui/draw">');
    expect(draw).toContain("跳转");
    const bad = await tool.execute({ category: "board", name: "nope/draw" });
    expect(bad).toContain("未找到板型技能");
  });

  it("停用门(2026-10-14 审计 C3):停用的内置/用户技能拒读全文,不更新 view 计数", async () => {
    const store = freshStore();
    const tool = skillViewTool(store, () => ["tdd"]);
    const deniedBuiltin = await tool.execute({ category: "builtin", name: "tdd" });
    expect(deniedBuiltin).toContain("已被用户停用");
    // 未传停用表=不过滤(旧行为保持,companion 等旁路调用方不受影响)
    const openTool = skillViewTool(store);
    // n7 形态:内置技能同样走 `<skill_content name="builtin/<name>">` 包裹(旧 `[内置技能]` 标记退场)
    expect(await openTool.execute({ category: "builtin", name: "tdd" })).toContain('<skill_content name="builtin/tdd">');
    // 用户技能 disabled 状态同样拒读
    await store.write({ category: "coding", name: "gone", description: "d", created_by: "user" }, "body-text");
    store.setStatus("coding", "gone", "disabled");
    const deniedUser = await tool.execute({ category: "coding", name: "gone" });
    expect(deniedUser).toContain("已停用");
    expect(store.usage("coding", "gone").view_count).toBe(0);
  });
});

describe("experience_fold 工具(step-028 D4)", () => {
  it("白名单外拒绝;合法写入 fold-in 同名 version+1;超 60 字 description 报错不落库", async () => {
    const store = freshStore();
    const tool = experienceFoldTool(store);

    const denied = await tool.execute({ category: "secret", name: "x", description: "d", body: "b" });
    expect(denied).toContain("不在白名单");

    const ok = await tool.execute({ category: "coding", name: "build-lock", description: "并发写经验库要过文件锁", created_by: "agent", body: "写路径整体挂锁,自旋等待。" } as never);
    expect(ok).toContain("v1");
    expect(store.read("coding", "build-lock")?.version).toBe(1);

    const ok2 = await tool.execute({ category: "coding", name: "build-lock", description: "并发写经验库要过文件锁(fold-in)", body: "写路径整体挂锁,自旋等待;超时 5s。" });
    expect(ok2).toContain("v2");
    expect(store.read("coding", "build-lock")?.version).toBe(2);

    const tooLong = await tool.execute({ category: "coding", name: "long", description: "字".repeat(61), body: "b" });
    expect(tooLong).toContain("experience_fold 错误");
    expect(store.read("coding", "long")).toBeNull();

    expect(FOLD_CATEGORY_WHITELIST).toContain("incidents"); // distill 兜底类目可在白名单内合并
  });
});
