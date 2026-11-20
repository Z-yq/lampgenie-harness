/**
 * editHint 异步契约:Promise hint 被 await 拼入回执;同步 hint 不变;throw/reject fail-soft。
 * 注:edit_file 有「编辑前必须先 read_file」保鲜守卫,每个用例先 read 再 edit。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools } from "../src/file-tools.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "file-tools-hint-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "hello world\n", "utf8");
  const journal = { append: () => {}, readAll: () => [] };
  return { root, journal };
}

function tools(root: string, journal: unknown, editHint?: (rel: string) => unknown) {
  const ts = createFileTools({ root, journal: journal as never, sessionId: "s-hint", ...(editHint ? { editHint: editHint as never } : {}) });
  const edit = ts.find((x) => x.name === "edit_file");
  const read = ts.find((x) => x.name === "read_file");
  if (!edit || !read) throw new Error("edit_file/read_file 未注册");
  return { edit, read };
}

async function editWithRead(root: string, journal: unknown, editHint?: (rel: string) => unknown): Promise<string> {
  const { edit, read } = tools(root, journal, editHint);
  await read.execute({ path: "src/a.ts" });
  return String(await edit.execute({ path: "src/a.ts", old_string: "hello", new_string: "hi" }));
}

describe("edit_file editHint 异步契约", () => {
  it("Promise hint 被 await 拼入回执", async () => {
    const { root, journal } = fixture();
    const out = await editWithRead(root, journal, async () => "HINT-ASYNC");
    expect(out).toContain("已编辑");
    expect(out).toContain("HINT-ASYNC");
  });

  it("同步 hint 行为不变", async () => {
    const { root, journal } = fixture();
    const out = await editWithRead(root, journal, () => "HINT-SYNC");
    expect(out).toContain("HINT-SYNC");
  });

  it("hint reject → 编辑照常成功(fail-soft)", async () => {
    const { root, journal } = fixture();
    const out = await editWithRead(root, journal, async () => { throw new Error("boom"); });
    expect(out).toContain("已编辑");
    expect(out).not.toContain("boom");
  });

  it("无 hint → 回执无附加", async () => {
    const { root, journal } = fixture();
    const out = await editWithRead(root, journal);
    expect(out).toContain("已编辑");
  });
});
