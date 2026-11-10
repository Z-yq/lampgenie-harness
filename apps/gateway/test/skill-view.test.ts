/**
 * n7 skill_view 全文形态(ZCode core/tool/handlers/skill.ts):
 * ① 返回体含 `<skill_content name="…">` 包裹;
 * ② `${GENIE_SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 展开为技能目录绝对路径;
 * ③ 超 100000 字节截断且带标注、不出现 U+FFFD(UTF-8 边界)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillViewTool, SKILL_VIEW_MAX_BYTES } from "../src/agent-wiring.js";
import { ExperienceStore } from "@lampgenie/experience";

let dir: string | null = null;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

/** 直接落一份 SKILL.md(绕开写路径长度校验,模拟外部手写长技能)。 */
function writeRawSkill(root: string, category: string, name: string, text: string): string {
  const d = join(root, category, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), text, "utf-8");
  return d;
}

describe("skill_view 全文形态(n7)", () => {
  it("返回体含 <skill_content name=…> 包裹,并给出技能目录(Base directory)", async () => {
    dir = mkdtempSync(join(tmpdir(), "gh-skillview-"));
    const root = join(dir, "experiences");
    const store = new ExperienceStore(root);
    await store.write({ category: "coding", name: "echo-quirk", description: "echo 执行器任务书要写清楚动词", created_by: "agent" }, "任务书必须包含明确动作词。");
    const out = String(await skillViewTool(store).execute({ category: "coding", name: "echo-quirk" }));
    expect(out).toContain('<skill_content name="coding/echo-quirk">');
    expect(out.trimEnd().endsWith("</skill_content>")).toBe(true);
    expect(out).toContain("任务书必须包含明确动作词。");
    expect(out).toContain("Base directory for this skill: " + join(root, "coding", "echo-quirk"));
    expect(store.usage("coding", "echo-quirk").view_count).toBe(1);
  });

  it("${GENIE_SKILL_DIR} 与 ${CLAUDE_SKILL_DIR} 都替换成技能目录绝对路径", async () => {
    dir = mkdtempSync(join(tmpdir(), "gh-skillview-"));
    const root = join(dir, "experiences");
    const store = new ExperienceStore(root);
    await store.write(
      { category: "tooling", name: "script-skill", description: "带脚本路径的技能", created_by: "agent" },
      "跑 ${GENIE_SKILL_DIR}/scripts/run.sh 或 ${CLAUDE_SKILL_DIR}/scripts/run.sh;相对路径相对本目录。",
    );
    const out = String(await skillViewTool(store).execute({ category: "tooling", name: "script-skill" }));
    const expectDir = join(root, "tooling", "script-skill");
    expect(out).toContain(`${expectDir}/scripts/run.sh`);
    expect(out).not.toContain("${GENIE_SKILL_DIR}");
    expect(out).not.toContain("${CLAUDE_SKILL_DIR}");
  });

  it("超 100000 字节截断:带截断标注、不出现 U+FFFD、字节数不超上限太多", async () => {
    dir = mkdtempSync(join(tmpdir(), "gh-skillview-"));
    const root = join(dir, "experiences");
    // 3 字节/字的正文,让 100000 字节边界必然切在多字节字符中间(旧实现会吐 U+FFFD)
    const body = "技".repeat(50_000); // 150000 字节
    writeRawSkill(root, "ops", "huge", `---\nname: huge\ndescription: 巨大技能\n---\n\n${body}`);
    const store = new ExperienceStore(root);
    const out = String(await skillViewTool(store).execute({ category: "ops", name: "huge" }));
    expect(out).toContain(`…(截断:全文 ${Buffer.byteLength(body, "utf8")} 字节,已读 ${SKILL_VIEW_MAX_BYTES})`);
    expect(out).not.toContain("\uFFFD");
    expect(out).toContain('<skill_content name="ops/huge">');
    expect(out.trimEnd().endsWith("</skill_content>")).toBe(true);
    // 正文部分按字节切(100000 字节 ≈ 33333 个 3 字节字符)
    const cutChars = (out.match(/技/g) ?? []).length;
    expect(cutChars).toBeGreaterThan(33_000);
    expect(cutChars).toBeLessThanOrEqual(100_000 / 3);
    // 落盘原文件未被改动(只读)
    expect(readFileSync(join(root, "ops", "huge", "SKILL.md"), "utf-8")).toContain(body.slice(0, 100));
  });

  it("builtin / teamai 分支同样包裹(各自 define 的 name 不同)", async () => {
    dir = mkdtempSync(join(tmpdir(), "gh-skillview-"));
    const store = new ExperienceStore(join(dir, "experiences"));
    const builtinOut = String(await skillViewTool(store).execute({ category: "builtin", name: "tdd" }));
    expect(builtinOut).toContain('<skill_content name="builtin/tdd">');
    expect(builtinOut.trimEnd().endsWith("</skill_content>")).toBe(true);
    // 内置技能不在磁盘上 → 不编造 Base directory
    expect(builtinOut).not.toContain("Base directory for this skill:");

    const g = globalThis as { __teamView?: { teamaiDigest(): Record<string, unknown> | null } };
    const prev = g.__teamView;
    g.__teamView = {
      teamaiDigest: () => ({
        rules: [{ name: "no-force-push", body: "禁止 force push;需要时先开分支。" }],
        skills: [{ ns: "deploy", name: "rollback", body: "回滚用 ${GENIE_SKILL_DIR}/rollback.sh(团队技能)" }],
      }),
    };
    try {
      const ruleOut = String(await skillViewTool(store).execute({ category: "teamai", name: "no-force-push" }));
      expect(ruleOut).toContain('<skill_content name="teamai/rules/no-force-push">');
      expect(ruleOut).toContain("禁止 force push");
      const skillOut = String(await skillViewTool(store).execute({ category: "teamai", name: "rollback" }));
      expect(skillOut).toContain('<skill_content name="teamai/skills/rollback">');
      expect(skillOut).toContain("团队技能");
    } finally {
      g.__teamView = prev;
    }
  });
});
