import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importMeeting } from "../src/meeting/import";
import type { LlmProvider } from "../src/agent/loop";

const fakeLlm: LlmProvider = {
  async chat() {
    return { content: JSON.stringify({
      topics: ["Q4 发布计划"],
      decisions: ["10 月底冻结需求"],
      todos: [{ content: "补齐评测门禁", owner: "alice", deadline: "10-20" }],
      openQuestions: ["性能预算未定"],
    }) };
  },
};

describe("会议导入流水线", () => {
  it("纪要→抽取→task 草稿,幂等可重跑", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-meeting-"));
    const input = join(dir, "meeting.txt");
    writeFileSync(input, "会议讨论了 Q4 发布计划,决定 10 月底冻结需求。alice 负责补齐评测门禁,10-20 截止。性能预算未定。");
    const workDir = join(dir, "work");

    const r1 = await importMeeting(input, workDir, fakeLlm);
    expect(r1.extraction.todos).toHaveLength(1);
    const drafts = JSON.parse(readFileSync(r1.draftPath, "utf-8"));
    expect(drafts[0].instruction).toBe("补齐评测门禁");
    // 幂等:重跑不改产物(extract.json 已存在则复用)
    const r2 = await importMeeting(input, workDir, fakeLlm);
    expect(r2.draftPath).toBe(r1.draftPath);
    rmSync(dir, { recursive: true, force: true });
  });
});
