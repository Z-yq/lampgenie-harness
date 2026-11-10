/**
 * 空节清理(2026-10-19 用户实报「清空标题」):USER.md 曾积累 69 个空「## 用户明确要求」标题,
 * 每次都进 system 提示词的 user_preferences 块。normalizeMarkdown 写盘路径要丢掉
 * 「标题后紧跟标题/EOF」的空节,保留有内容的标题。
 */
import { describe, it, expect } from "vitest";
import { dropEmptySections } from "../src/wiring";

describe("dropEmptySections", () => {
  it("空标题(后接标题或 EOF)整节丢弃;有内容的标题保留", () => {
    const lines = [
      "## 用户明确要求",
      "- 叫我小飞",
      "",
      "## 用户明确要求",
      "",
      "## 用户明确要求",
      "",
      "## 观察推断",
      "- 熟悉的领域:TypeScript",
      "",
      "## 空节",
    ];
    const out = dropEmptySections(lines).join("\n");
    expect(out).toContain("## 用户明确要求\n- 叫我小飞");
    expect(out).toContain("## 观察推断\n- 熟悉的领域:TypeScript");
    expect(out.match(/## 用户明确要求/g)).toHaveLength(1); // 两个空节被清
    expect(out).not.toContain("## 空节");
  });

  it("真实 USER.md 形态:69 个空标题折叠为 1 个", () => {
    const lines = ["## 用户明确要求", "- 叫我小飞", ...Array.from({ length: 69 }, () => ["", "## 用户明确要求"]).flat()];
    const out = dropEmptySections(lines).join("\n");
    expect(out.match(/## 用户明确要求/g)).toHaveLength(1);
    expect(out).toContain("- 叫我小飞");
  });
});
