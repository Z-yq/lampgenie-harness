/**
 * explore 子命令 + 收敛项单测(2026-10-21 批次 C/E):
 * C:codesense explore "<问题>" 复用 code-sense explore 管线(normalizeQuery 变体+grep+
 * 低命中自举二轮),索引非前置;--json 给 agent。
 * E①:index --register = init 登记语义;E②:symbol --graph/file --graph 与
 * graph/filegraph 输出同源;E④:--repo 回查注册表(不在当前根展开集也能定向)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../src/cli.js";
import { buildC2fIndex, saveIndex } from "@lampgenie/code-sense";

let fakeHome = "";
let realHome = "";
let ws = "";
let otherRepo = ""; // 模拟「注册表里有、但不在当前根展开集里」的外部仓(E④)

function capture(): { io: CliIo; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { out: (s2) => (o.push(s2), undefined), err: (s2) => (e.push(s2), undefined) },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

beforeAll(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), "csexp-home-"));
  realHome = homedir();
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  ws = mkdtempSync(join(tmpdir(), "csexp-"));
  writeFileSync(join(ws, "voice.ts"), [
    "export function ttsVoice(msg: string): string { return \"tts:\" + msg; }",
    "export function chatAudio(msg: string): string { return ttsVoice(msg) + \":audio\"; }",
    "",
  ].join("\n"));
  saveIndex(ws, await buildC2fIndex(ws));

  otherRepo = mkdtempSync(join(tmpdir(), "csexp-other-"));
  mkdirSync(join(otherRepo, "src"), { recursive: true });
  writeFileSync(join(otherRepo, "src", "chat.ts"), [
    "export function process_chat(msg: string): string { return msg.trim(); }",
    "",
  ].join("\n"));
  saveIndex(otherRepo, await buildC2fIndex(otherRepo));
}, 180_000);

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(otherRepo, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  process.env.HOME = realHome;
  process.env.USERPROFILE = realHome;
}, 60_000);

describe("C:explore 子命令", () => {
  it("英文多词:命中文件/行+热区;--json 结构化", async () => {
    const t = capture();
    const code = await runCli(["explore", "tts voice audio chat", "--root", ws, "--no-color"], t.io);
    expect(code).toBe(0);
    expect(t.out()).toContain("explore");
    expect(t.out()).toContain("voice.ts");
    const j = capture();
    const code2 = await runCli(["explore", "tts voice audio chat", "--root", ws, "--json"], j.io);
    expect(code2).toBe(0);
    const json = JSON.parse(j.out());
    expect(json.query).toBe("explore");
    expect(json.matchCount).toBeGreaterThan(0);
    expect(json.matches.length).toBeGreaterThan(0);
    expect(json.matches[0].file).toBe("voice.ts");
  }, 120_000);

  it("中文问题:变体管线命中(cobra 形态)+ 零命中 exit 1 不装绿", async () => {
    writeFileSync(join(ws, "cmd.go"), [
      "package cmd",
      "",
      "import (",
      '  "github.com/spf13/cobra"',
      ")",
      "",
      "// validateFlag checks cobra flag rules",
      "func validateFlag(c *cobra.Command) bool {",
      "  return c.Flags() != nil",
      "}",
      "",
    ].join("\n"));
    const t = capture();
    const code = await runCli(["explore", "cobra 怎么校验 flag", "--root", ws, "--no-color"], t.io);
    expect(code).toBe(0);
    expect(t.out()).toContain("cmd.go");

    const none = capture();
    const noneCode = await runCli(["explore", "zzzznotexist", "--root", ws, "--no-color"], none.io);
    expect(noneCode).toBe(1);
    expect(none.out()).toContain("零命中");
  }, 120_000);

  it("缺问题=用法错(exit 2);--root 不存在=exit 2", async () => {
    const t = capture();
    expect(await runCli(["explore", "--root", ws], t.io)).toBe(2);
    expect(t.err()).toContain("用法");
    const bad = capture();
    expect(await runCli(["explore", "x", "--root", "/definitely/not/exist"], bad.io)).toBe(2);
  }, 60_000);
});

describe("E①:index --register = init 登记语义", () => {
  it("index --register 写注册表;index(无旗标)不新增登记", async () => {
    const regPath = join(fakeHome, ".codesense", "registry.json");
    const r1 = capture();
    expect(await runCli(["index", ws, "--register", "--quiet", "--json"], r1.io)).toBe(0);
    expect(JSON.parse(r1.out()).registered).toBe(true);
    expect(existsSync(regPath)).toBe(true);
    expect(JSON.parse(readFileSync(regPath, "utf-8")).roots.some((e: { root: string }) => e.root === ws)).toBe(true);

    // 未 --register 的 index 不新增登记(E④ 用的 otherRepo:只建索引不登记)
    const r2 = capture();
    expect(await runCli(["index", otherRepo, "--quiet", "--json"], r2.io)).toBe(0);
    expect(JSON.parse(r2.out()).registered).toBe(false);
    expect(JSON.parse(readFileSync(regPath, "utf-8")).roots.some((e: { root: string }) => e.root === otherRepo)).toBe(false);

    // index --register 登记幂等(收尾批 J:init 别名已删)
    const r3 = capture();
    expect(await runCli(["index", "--register", otherRepo, "--quiet", "--json"], r3.io)).toBe(0);
    expect(JSON.parse(r3.out()).registered).toBe(true);
    expect(JSON.parse(readFileSync(regPath, "utf-8")).roots.some((e: { root: string }) => e.root === otherRepo)).toBe(true);
  }, 300_000);
});

describe("E④:--repo 回查注册表(跨根路由)", () => {
  it("--repo <外部仓名> 从另一根命中该仓符号(实锤:agent_alpha/process_chat)", async () => {
    // 前置:otherRepo 已登记(上一 describe);当前根=ws(不含 otherRepo)
    const t = capture();
    const code = await runCli(["symbol", "process_chat", "--root", ws, "--repo", basenameOf(otherRepo), "--json", "--quiet", "--no-build"], t.io);
    expect(code).toBe(0);
    const j = JSON.parse(t.out());
    expect(j.hitCount).toBe(1);
    expect(j.hits[0].repo).toBe(basenameOf(otherRepo));
    expect(j.hits[0].symbol.file).toBe("src/chat.ts");
  }, 120_000);

  it("未知仓:可用清单含注册表全量", async () => {
    const t = capture();
    const code = await runCli(["symbol", "process_chat", "--root", ws, "--repo", "ghost-repo", "--quiet", "--no-build", "--no-color"], t.io);
    expect(code).toBe(1);
    expect(t.out()).toContain("未知仓: ghost-repo");
    expect(t.out()).toContain(basenameOf(otherRepo));
  }, 120_000);
});

function basenameOf(p: string): string {
  return p.split("/").pop()!;
}

describe("E②:symbol --graph / file --graph(收尾批 J:graph/filegraph 独立命令已删)", () => {
  it("symbol X --graph / file P --graph 输出 mermaid;旧命令 init/graph/filegraph=未知指令", async () => {
    const g1 = capture();
    expect(await runCli(["symbol", "ttsVoice", "--root", ws, "--graph", "--quiet", "--no-build", "--no-color"], g1.io)).toBe(0);
    expect(g1.out()).toContain("graph");

    const f1 = capture();
    expect(await runCli(["file", "voice.ts", "--root", ws, "--graph", "--quiet", "--no-build", "--no-color"], f1.io)).toBe(0);
    expect(f1.out()).toContain("graph");

    // 旧独立命令已删:三者均应报未知指令(exit 2)
    for (const old of ["init", "graph", "filegraph"]) {
      const oc = capture();
      expect(await runCli([old, "--quiet"], oc.io)).toBe(2);
      expect(oc.err()).toContain("未知指令");
    }
  }, 120_000);
});
