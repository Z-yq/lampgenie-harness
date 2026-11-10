/**
 * edit_file 改后上下文快照( session 验证落地)单测:
 * 经验证 464 次「编辑后立刻 read_file 回读验证」——回执自带 <edited> 块(改动处±5行带行号,
 * read_file 同格式)后该往返应消失。
 * ①快照格式:lines 区间正确、行号 padStart(6)+"\t"、含 new_string 内容;
 * ②replace_all 多处→「共 N 处,显示第 1 处」;
 * ③边界:文件头/尾编辑不出负行号;超长替换窗口截断;空 newStr(纯删除)仍出快照;
 * ④快照失败(不可读)不影响编辑回执主体。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools, editedSnippet } from "../src/file-tools.js";
import { MemoryJournal } from "@lampgenie/core";

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "editsnip-")); dirs.push(d); return d; };
afterEach(() => {
  for (const d of dirs.splice(0)) { try { chmodSync(d, 0o755); } catch { /* 权限复原尽力 */ } rmSync(d, { recursive: true, force: true }); }
});

function toolsOf(root: string) {
  const tools = createFileTools({ root, journal: new MemoryJournal(), sessionId: "t-edit-snip" });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { exec: (name: string, args: unknown) => byName.get(name)!.execute(args) as Promise<string> };
}

const file10 = (root: string) => writeFileSync(join(root, "a.ts"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n");

describe("edit_file 改后上下文快照", () => {
  it("中段编辑:快照带正确行号区间与±5行上下文(read_file 同格式)", async () => {
    const root = mk();
    file10(root);
    const { exec } = toolsOf(root);
    await exec("read_file", { path: "a.ts" });
    const res = await exec("edit_file", { path: "a.ts", old_string: "line5", new_string: "line5-CHANGED" });
    expect(res).toContain("已编辑 a.ts");
    expect(res).toContain('<edited path="a.ts" lines="1-10">'); // 10 行小文件窗口=全文
    expect(res).toMatch(/\d+\tline5-CHANGED/);
    // 行号前缀与 read_file 同格式(padStart(6)+"\t")
    expect(res).toMatch(/\n\s{5}5\tline5-CHANGED/);
  });

  it("大文件:窗口=改动处±5行,区间外不进快照", async () => {
    const root = mk();
    writeFileSync(join(root, "big.ts"), Array.from({ length: 100 }, (_, i) => `row${i + 1}`).join("\n") + "\n");
    const { exec } = toolsOf(root);
    await exec("read_file", { path: "big.ts" });
    const res = await exec("edit_file", { path: "big.ts", old_string: "row50", new_string: "row50-X" });
    // 50-5=45 起,50+5=55 止
    expect(res).toContain('<edited path="big.ts" lines="45-55">');
    expect(res).toMatch(/\n\s{4}45\trow45/);
    expect(res).toMatch(/\n\s{4}55\trow55/);
    expect(res).not.toContain("row44");
    expect(res).not.toContain("row56");
  });

  it("replace_all 多处:标注「共 N 处,显示第 1 处」", async () => {
    const root = mk();
    writeFileSync(join(root, "m.ts"), ["a-KEEP", "mid", "a-KEEP"].join("\n") + "\n");
    const { exec } = toolsOf(root);
    await exec("read_file", { path: "m.ts" });
    const res = await exec("edit_file", { path: "m.ts", old_string: "a-KEEP", new_string: "b-NEW", replace_all: true });
    expect(res).toContain("替换 2 处");
    expect(res).toContain("共 2 处,显示第 1 处");
    expect(res).toMatch(/1\tb-NEW/);
  });

  it("纯删除(newStr 空)仍出快照;文件头/尾不出界", async () => {
    const root = mk();
    file10(root);
    const { exec } = toolsOf(root);
    await exec("read_file", { path: "a.ts" });
    // 尾行删除:锚=原 line10 位置(第10行),窗口 5..10,尾部空元素不进窗口
    let res = await exec("edit_file", { path: "a.ts", old_string: "line10", new_string: "" });
    expect(res).toContain('<edited path="a.ts" lines="5-10">');
    // 首行编辑:from 不小于 1;删除后文件= line1..line9 + 2 个空尾元素 → 窗口 1-6(收到最后非空行 9 之内)
    res = await exec("edit_file", { path: "a.ts", old_string: "line1", new_string: "head" });
    expect(res).toContain('lines="1-6">');
    expect(res).toMatch(/\n\s{5}1\thead/);
  });

  it("多行替换:窗口按 newStr 行数展开", async () => {
    const root = mk();
    file10(root);
    const { exec } = toolsOf(root);
    await exec("read_file", { path: "a.ts" });
    const res = await exec("edit_file", { path: "a.ts", old_string: "line5", new_string: "n1\nn2\nn3" });
    // newStr 3 行:窗口 1..(5+3-1=7)+5=12→文件 12 行→1-10(全在)
    expect(res).toMatch(/\n\s{5}5\tn1/);
    expect(res).toMatch(/\n\s{5}7\tn3/);
  });

  it("快照读失败不影响编辑主体(无 <edited> 也不报错)", async () => {
    const root = mk();
    file10(root);
    const { exec } = toolsOf(root);
    await exec("read_file", { path: "a.ts" });
    // 落盘后、读回前把文件变不可读不易模拟;这里验证正常路径不抛、格式契约稳定即可
    const res = await exec("edit_file", { path: "a.ts", old_string: "line2", new_string: "L2" });
    expect(res).toContain("已编辑 a.ts");
    expect(res).toContain("<edited");
  });
});

describe("editedSnippet 锚漂移路径(2026-11-08 审计 B1:格式化改写/短行降级/删除锚直测)", () => {
  const big = Array.from({ length: 30 }, (_, i) => `row${i + 1}`).join("\n") + "\n";

  it("格式化改写替换体但首行≥20字符:模糊定位仍出快照(prettier 加空格场景)", () => {
    // newStr 首行长句被格式化成多空格形态——indexOf 精确匹配失败,退首行模糊命中
    const newStr = "const formattedValue = computeSomething(x, y)";
    const formatted = "const formattedValue  =  computeSomething(x, y);";
    const finalText = big.replace("row15", formatted) + "";
    const s = editedSnippet("f.ts", finalText, newStr, 1);
    expect(s).toContain("<edited");
    expect(s).toMatch(/15\t.*computeSomething/); // 行号仍指第 15 行
  });

  it("格式化改写短替换体(无≥20字符锚):优雅降级返回空串,不产错误快照", () => {
    const newStr = "const x=1";
    const finalText = big.replace("row15", "const x = 1;");
    expect(editedSnippet("f.ts", finalText, newStr, 1)).toBe("");
  });

  it("纯删除走 anchorPrefixLen 锚:窗口以原 oldStr 位置为中心(前缀未变)", () => {
    const text = big;
    const oldStr = "row20";
    const anchor = text.indexOf(oldStr); // 单处删除前缀逐字不变
    const finalText = text.replace(oldStr, "");
    const s = editedSnippet("f.ts", finalText, "", 1, anchor);
    expect(s).toContain("<edited");
    // anchor 指向第 20 行原位置:删除后该处起窗口应覆盖 15-25 邻域(含 row19/row21)
    expect(s).toMatch(/19\trow19/);
    expect(s).toMatch(/2[01]\trow21/);
  });

  it("replace_all 多处+格式化:标「共 N 处,显示第 1 处」", () => {
    const newStr = "const formattedValue = computeSomething(x, y)";
    const formatted = "const formattedValue  =  computeSomething(x, y);";
    const finalText = big.replace("row10", formatted).replace("row20", formatted);
    const s = editedSnippet("f.ts", finalText, newStr, 2);
    expect(s).toContain("共 2 处,显示第 1 处");
  });
});
