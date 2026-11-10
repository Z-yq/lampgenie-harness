/**
 * 子代理读工具与主 agent 对齐(2026-10-19 深挖「explore 跑满时间盒零产出」):
 * ①grep 的 path 允许是文件(旧实现只 readdir,传文件静默「零命中」——实测 155 次调用 68 次空结果);
 * ②read_file 支持 offset/limit 分窗(旧实现只能读前 120KB,1.1MB panel.ts 永远读不全,同参重读 9 次);
 * ③read_file 登记「已读清单」(loop 每步注入「别整读」提醒的数据源)。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmLoopReadOnlyTools } from "../src/llm-loop-backend";
import { clearReadFiles, buildReadFilesReminder } from "@lampgenie/runtime/agent/read-file-state";

const dir = mkdtempSync(join(tmpdir(), "sub-tools-"));
const file = join(dir, "big.ts");
const lines = Array.from({ length: 300 }, (_, i) => `line${i + 1} 内容` + (i === 149 ? " NEEDLE" : ""));
mkdirSync(dir, { recursive: true });
writeFileSync(file, lines.join("\n"), "utf-8");

function tool(name: string, ref?: { value: string }) {
  const t = llmLoopReadOnlyTools([dir], new Map(), ref).find((x) => x.name === name);
  if (!t) throw new Error("tool not found: " + name);
  return t;
}

beforeEach(() => clearReadFiles("t-sess"));

describe("子代理 grep(文件/目录路径)", () => {
  it("path=文件 → 命中(旧实现静默零命中)", async () => {
    const r = String(await tool("grep").execute({ path: file, pattern: "NEEDLE" }));
    expect(r).toContain("big.ts:150");
    expect(r).not.toContain("零命中");
  });
  it("path=目录 → 递归命中", async () => {
    const r = String(await tool("grep").execute({ path: dir, pattern: "NEEDLE" }));
    expect(r).toContain("big.ts:150");
  });
  it("path 不存在 → 显式错误(不再伪装成零命中)", async () => {
    const r = String(await tool("grep").execute({ path: join(dir, "nope.ts"), pattern: "x" }));
    expect(r).toContain("路径不存在");
  });
});

describe("子代理 read_file(分窗与已读登记)", () => {
  it("offset/limit 分窗读:只返回 200-209 行并标注总行数", async () => {
    const r = String(await tool("read_file").execute({ path: file, offset: 200, limit: 10 }));
    expect(r).toContain("line200");
    expect(r).toContain("line209");
    expect(r).not.toContain("line199 内容");
    expect(r).toContain("共 300 行");
    expect(r).toContain("本次显示 200-209");
  });
  it("读取登记进已读清单 → loop 提醒可见(与主 agent 同语义)", async () => {
    const ref = { value: "t-sess" };
    await tool("read_file", ref).execute({ path: file, offset: 1, limit: 5 });
    const reminder = buildReadFilesReminder("t-sess");
    expect(reminder).toBeTruthy();
    expect(reminder!).toContain("big.ts");
  });
});
