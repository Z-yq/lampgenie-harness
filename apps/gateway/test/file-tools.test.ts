/**
 * 主 agent 文件工具六件套单测(对标补齐:read/write/edit/glob/grep/list_dir):
 * ①读写编辑正确路径与行号窗口;②路径围栏(绝对路径/.. 上跳/盘符逃逸全拒);
 * ③readonly/plan 模式写类拒绝(permission.gate 在案)+读类可用;
 * ④编辑保鲜(未读过拒写/外部改动拒写/连续编辑免重读);
 * ⑤edit_file 精确语义(唯一命中/多命中报数/replace_all/old==new 拒/零命中给近似行提示);
 * ⑥glob/grep 模式语义;⑦权限链对拍(permission-passing 同形态:deny/allow/ask 审批/file.write 类别别名)。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools, fencePath, globToRegExp } from "../src/file-tools.js";
import { setPermissionMode } from "../src/permission-mode.js";
import { buildMainLoopPermission } from "../src/agent-wiring.js";
import { AgentLoop, type AgentLoopOptions, type Tool } from "@lampgenie/runtime/agent/loop";
import { MemoryJournal, type PermissionRule } from "@lampgenie/core";

// env 互斥:threads pool 共享 process.env,动 GENIE_PERMISSION_RULES 等进程级开关的
// 测试文件必须串行,否则并行文件互相拆 env=间歇假红。
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
beforeAll(async () => { await acquireEnvLock("file-tools"); }, 240_000); // 等锁可能长(hook 默认 10s 会假红)
afterAll(() => { releaseEnvLock("file-tools"); });

type PermOption = NonNullable<AgentLoopOptions["permission"]>;

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "filetools-")); dirs.push(d); return d; };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  setPermissionMode("ask");
  delete process.env.GENIE_PERMISSION_RULES;
});

function toolsOf(root: string) {
  const journal = new MemoryJournal();
  const tools = createFileTools({ root, journal, sessionId: "t1" });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { journal, tools, byName, exec: (name: string, args: unknown) => byName.get(name)!.execute(args) as Promise<string> };
}

const gateEvents = (j: MemoryJournal) => j.readAll().filter((e) => e.kind === "permission.gate").map((e) => e.payload as { tool: string; effect: string; by: string });

describe("路径围栏 fencePath(2026-11-01 异步化:同步 existsSync/realpathSync 是冻结地雷)", () => {
  it("绝对路径/.. 上跳/盘符/空串全拒;根内相对路径放行", async () => {
    const root = mk();
    await expect(fencePath(root, "/etc/hosts")).resolves.toBeNull();
    await expect(fencePath(root, "../outside.txt")).resolves.toBeNull();
    await expect(fencePath(root, "a/../../outside.txt")).resolves.toBeNull();
    await expect(fencePath(root, "C:/windows/system32")).resolves.toBeNull();
    await expect(fencePath(root, "\\windows")).resolves.toBeNull();
    await expect(fencePath(root, "")).resolves.toBeNull();
    await expect(fencePath(root, undefined)).resolves.toBeNull();
    await expect(fencePath(root, "src/a.ts")).resolves.toBe(join(root, "src", "a.ts"));
    await expect(fencePath(root, "./src/a.ts")).resolves.toBe(join(root, "src", "a.ts"));
  });
  it("真实路径复核走 fs/promises(围栏语义不因异步化漂移:根外符号链接近似物拒收)", async () => {
    const root = mk();
    // auto 模式直通路径(围栏放开)与复核路径都各验一次:模式是模块态,这里只验非 auto 分支的
    // 基础行为——根内存在文件放行(auto 下不触盘;非 auto 下走 async 复核同样放行)
    await expect(fencePath(root, "a.txt")).resolves.toBe(join(root, "a.txt"));
  });
});

describe("read_file", () => {
  it("带行号读取;offset/limit 分窗;超窗给续读提示", async () => {
    const root = mk();
    writeFileSync(join(root, "a.txt"), Array.from({ length: 30 }, (_, i) => "line" + (i + 1)).join("\n"), "utf-8");
    const { exec } = toolsOf(root);
    const full = await exec("read_file", { path: "a.txt" });
    expect(full).toContain("     1\tline1");
    expect(full).toContain("    30\tline30");
    const win = await exec("read_file", { path: "a.txt", offset: 5, limit: 3 });
    expect(win).toContain("     5\tline5");
    expect(win).toContain("     7\tline7");
    expect(win).not.toContain("line8");
    expect(win).toContain("继续读用 offset=8");
  });

  it("围栏拒绝与文件缺失;二进制拒读", async () => {
    const root = mk();
    const { exec } = toolsOf(root);
    expect(await exec("read_file", { path: "../escape.txt" })).toContain("越出项目根");
    expect(await exec("read_file", { path: "/etc/hosts" })).toContain("越出项目根");
    expect(await exec("read_file", { path: "nope.txt" })).toContain("文件不存在");
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    expect(await exec("read_file", { path: "blob.bin" })).toContain("二进制");
  });

  it("超长行截断不产生孤立代理(2026-10-29 DeepSeek 400 实测确认回归:第 2000 字符切在代理对中间)", async () => {
    const root = mk();
    // 1999 个 BMP 字符 + 🎙(U+1F399=D83C DF99)截在第 2000 个 code unit(高位)上
    const longLine = "中".repeat(1999) + "🎙" + "尾部";
    writeFileSync(join(root, "long.md"), longLine + "\nsecond line\n", "utf-8");
    const { exec } = toolsOf(root);
    const out = await exec("read_file", { path: "long.md" });
    expect(out).toContain("字符已截断"); // :标记改「…(+N 字符已截断)」(计入 2000 额度)
    expect(hasLoneSurrogate(out)).toBe(false);
  });
});

describe("write_file 编辑保鲜", () => {
  it("新建文件+自动建父目录;覆写外部已有文件需先读;外部改动后拒写", async () => {
    const root = mk();
    const { exec } = toolsOf(root);
    const r1 = await exec("write_file", { path: "notes/sub/a.md", content: "hello" });
    expect(r1).toContain("已创建");
    expect(readFileSync(join(root, "notes", "sub", "a.md"), "utf-8")).toBe("hello");
    // 刚创建过的文件连续写放行(readState 已由写侧登记)
    expect(await exec("write_file", { path: "notes/sub/a.md", content: "hello2" })).toContain("已覆写");
    // 外部已有文件未读过 → 拒
    writeFileSync(join(root, "pre.md"), "pre-existing", "utf-8");
    const r2 = await exec("write_file", { path: "pre.md", content: "blind" });
    expect(r2).toContain("未读过");
    expect(readFileSync(join(root, "pre.md"), "utf-8")).toBe("pre-existing");
    // 读后写 → 放行
    await exec("read_file", { path: "pre.md" });
    const r3 = await exec("write_file", { path: "pre.md", content: "fresh" });
    expect(r3).toContain("已覆写");
    // 读后被外部改动(mtime 推移)→ 拒
    await exec("read_file", { path: "pre.md" });
    const future = new Date(Date.now() + 65_000);
    utimesSync(join(root, "pre.md"), future, future);
    const r4 = await exec("write_file", { path: "pre.md", content: "stale" });
    expect(r4).toContain("被外部修改过");
    expect(readFileSync(join(root, "pre.md"), "utf-8")).toBe("fresh");
  });

  it("readonly/plan 模式拒绝写(read 类可用),permission.gate 落账;auto/ask 不受影响", async () => {
    const root = mk();
    writeFileSync(join(root, "r.txt"), "readable", "utf-8");
    const { exec, journal } = toolsOf(root);
    setPermissionMode("readonly");
    const denied = await exec("write_file", { path: "w.txt", content: "x" });
    expect(denied).toContain("只读");
    expect(existsSync(join(root, "w.txt"))).toBe(false);
    expect(gateEvents(journal)).toContainEqual(expect.objectContaining({ tool: "write_file", effect: "denied", by: "mode-readonly" }));
    expect(await exec("read_file", { path: "r.txt" })).toContain("readable"); // 读类可用
    expect(await exec("list_dir", { path: "." })).toContain("r.txt");
    setPermissionMode("plan");
    expect(await exec("write_file", { path: "w.txt", content: "x" })).toContain("规划");
    setPermissionMode("auto");
    expect(await exec("write_file", { path: "w.txt", content: "x" })).toContain("已创建");
  });
});

describe("edit_file 精确替换", () => {
  const setup = async () => {
    const root = mk();
    const t = toolsOf(root);
    await t.exec("write_file", { path: "code.ts", content: "const a = 1;\nconst b = 2;\nconst a = 3;\n" });
    return { root, ...t };
  };

  it("唯一命中替换;多命中报数;replace_all 全替;old==new 拒;零命中给近似行提示", async () => {
    const { root, exec, journal } = await setup();
    const r1 = await exec("edit_file", { path: "code.ts", old_string: "const b = 2;", new_string: "const b = 20;" });
    expect(r1).toContain("已编辑 code.ts");
    expect(r1).toContain("替换 1 处");
    expect(readFileSync(join(root, "code.ts"), "utf-8")).toContain("const b = 20;");

    const multi = await exec("edit_file", { path: "code.ts", old_string: "const a", new_string: "const z" });
    expect(multi).toContain("命中 2 处");
    expect(multi).toContain("replace_all");

    const all = await exec("edit_file", { path: "code.ts", old_string: "const a", new_string: "const z", replace_all: true });
    expect(all).toContain("替换 2 处");
    const text = readFileSync(join(root, "code.ts"), "utf-8");
    expect(text).toContain("const z = 1;");
    expect(text).toContain("const z = 3;");
    expect(text).not.toContain("const a");

    expect(await exec("edit_file", { path: "code.ts", old_string: "same", new_string: "same" })).toContain("空操作");
    const miss = await exec("edit_file", { path: "code.ts", old_string: "const z = 1; ", new_string: "x" });
    expect(miss).toContain("未找到");
    expect(gateEvents(journal)).toEqual([]); // 无模式介入:纯编辑不产生 gate 事件
  });

  it("编辑前必须先读;连续编辑免重读", async () => {
    const root = mk();
    writeFileSync(join(root, "f.txt"), "alpha beta", "utf-8");
    const { exec } = toolsOf(root);
    const noRead = await exec("edit_file", { path: "f.txt", old_string: "alpha", new_string: "ALPHA" });
    expect(noRead).toContain("先 read_file");
    await exec("read_file", { path: "f.txt" });
    expect(await exec("edit_file", { path: "f.txt", old_string: "alpha", new_string: "ALPHA" })).toContain("已编辑");
    // 刚编辑过:readState 已刷新为写后 mtime,连续编辑放行
    expect(await exec("edit_file", { path: "f.txt", old_string: "beta", new_string: "BETA" })).toContain("已编辑");
    expect(readFileSync(join(root, "f.txt"), "utf-8")).toBe("ALPHA BETA");
  });

  it("readonly 模式拒绝编辑", async () => {
    const root = mk();
    const { exec } = toolsOf(root);
    await exec("write_file", { path: "f.txt", content: "x" });
    setPermissionMode("readonly");
    expect(await exec("edit_file", { path: "f.txt", old_string: "x", new_string: "y" })).toContain("只读");
  });
});

describe("glob", () => {
  it("** 跨目录;单 * 不跨目录但裸名匹配任意层级;跳过依赖/隐藏目录;按 mtime 新→旧排序", async () => {
    const root = mk();
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, ".hidden"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "a.ts"), "1");
    writeFileSync(join(root, "src", "b.ts"), "2");
    writeFileSync(join(root, "src", "deep", "c.ts"), "3");
    writeFileSync(join(root, "node_modules", "x.ts"), "4");
    writeFileSync(join(root, ".hidden", "y.ts"), "5");
    writeFileSync(join(root, "README.md"), "6");
    writeFileSync(join(root, "docs", "note.md"), "7");
    const { exec } = toolsOf(root);
    const ts = await exec("glob", { pattern: "**/*.ts" });
    expect(ts).toContain("a.ts");
    expect(ts).toContain("src/b.ts");
    expect(ts).toContain("src/deep/c.ts");
    expect(ts).not.toContain("node_modules");
    expect(ts).not.toContain(".hidden");
    const bare = await exec("glob", { pattern: "*.md" });
    expect(bare).toContain("README.md");
    expect(bare).toContain("docs/note.md"); // 无 / 的模式同时匹配任意层级文件名
    const scoped = await exec("glob", { pattern: "src/**/*.ts" });
    expect(scoped).toContain("src/deep/c.ts");
    expect(scoped).not.toContain("a.ts");
    // mtime 排序:后写的排前
    const older = await exec("glob", { pattern: "**/*.ts" });
    const firstLine = older.split("\n")[0]!;
    writeFileSync(join(root, "src", "newest.ts"), "9");
    utimesSync(join(root, "src", "newest.ts"), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const again = await exec("glob", { pattern: "**/*.ts" });
    expect(again.split("\n")[0]).toBe("src/newest.ts");
    expect(firstLine).not.toBe("src/newest.ts");
  });

  it("globToRegExp 形态锚定", () => {
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("x/y/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("*.{json,md}").test("a.json")).toBe(true);
    expect(globToRegExp("*.{json,md}").test("a.md")).toBe(true);
    expect(globToRegExp("*.{json,md}").test("a.txt")).toBe(false);
    expect(globToRegExp("a?c.ts").test("abc.ts")).toBe(true);
    expect(globToRegExp("a?c.ts").test("abbc.ts")).toBe(false);
  });

  it("巨根零命中:walk 达上限时显式说明截断(不误导成「不存在」);小根零命中仍是裸零命中", async () => {
    // 巨根:4000 文件把 walk 配额耗尽,pattern 零命中 → 返回带「配额截断/收窄指引」的显式提示
    const big = mk();
    for (let i = 0; i < 4000; i++) writeFileSync(join(big, "f" + String(i).padStart(4, "0") + ".ts"), "x");
    const bigTools = toolsOf(big);
    const capped = await bigTools.exec("glob", { pattern: "nomatch-*.xyz" });
    expect(capped).toContain("零命中");
    expect(capped).toContain("4000");
    expect(capped).toContain("截断");
    expect(capped).toContain("收窄");
    // 小根零命中:未达上限 → 保持裸「(零命中)」;命中路径行为由同 describe 首用例覆盖
    const small = mk();
    writeFileSync(join(small, "a.ts"), "1");
    const smallTools = toolsOf(small);
    const plain = await smallTools.exec("glob", { pattern: "zzz-*.md" });
    expect(plain).toBe("(零命中)");
  }, 60_000);
});

describe("grep", () => {
  const setup = async () => {
    const root = mk();
    writeFileSync(join(root, "a.ts"), "const alpha = 1;\nconst beta = 2;\nconst ALPHA_CASE = 3;\n", "utf-8");
    writeFileSync(join(root, "b.md"), "# alpha doc\n", "utf-8");
    writeFileSync(join(root, "c.txt"), "nothing here\n", "utf-8");
    const t = toolsOf(root);
    return { root, ...t };
  };

  it("content 缺省带行号;files_with_matches;count;-i;glob 过滤;head_limit", async () => {
    const { exec } = await setup();
    const content = await exec("grep", { pattern: "alpha" });
    expect(content).toContain("a.ts:1: const alpha = 1;");
    expect(content).toContain("b.md:1: # alpha doc");
    expect(content).not.toContain("ALPHA_CASE"); // 大小写敏感缺省
    const insensitive = await exec("grep", { pattern: "alpha", "-i": true });
    expect(insensitive).toContain("ALPHA_CASE");
    const files = await exec("grep", { pattern: "alpha", output_mode: "files_with_matches" });
    expect(files).toContain("a.ts");
    expect(files).toContain("b.md");
    expect(files).not.toContain("c.txt");
    const count = await exec("grep", { pattern: "const", output_mode: "count", glob: "*.ts" });
    expect(count).toContain("a.ts: 3");
    expect(count).not.toContain("b.md");
    const limited = await exec("grep", { pattern: "const", head_limit: 2 });
    expect(limited.split("\n").filter((l) => l.includes(":")).length).toBe(2);
    expect(await exec("grep", { pattern: "zzz-nowhere" })).toContain("(零命中)");
    expect(await exec("grep", { pattern: "alpha", path: "../outside" })).toContain("越出项目根");
  });

  it("grep 零命中按 pattern 形态给定向引导(2026-10-29 token 轮 P2)", async () => {
    const root = mk();
    writeFileSync(join(root, "a.ts"), "const alpha = 1;\n", "utf-8");
    const { exec } = toolsOf(root);

    // ① 标识符形态零命中 → 指向 code_sense 并点名该标识符
    const ident = await exec("grep", { pattern: "deriveMessages" });
    expect(ident).toContain("(零命中)");
    expect(ident).toContain("code_sense");
    expect(ident).toContain("deriveMessages");
    expect(ident).toContain("影响面");

    // ② 中文短语零命中 → 主路径是「确认概念命名/收窄 path」,不是直接推符号查询
    const cjk = await exec("grep", { pattern: "聊天窗模型切换的预设" });
    expect(cjk).toContain("(零命中)");
    expect(cjk).toContain("中文短语");
    expect(cjk).toContain("list_dir"); // 先确认概念叫法
    // negative 不得照搬标识符分支的主引导(「「xxx」像代码标识符」)
    expect(cjk).not.toContain("像代码标识符");

    // ③ 其它形态 → 两种路都提
    const other = await exec("grep", { pattern: "a.*b.*c-no-such" });
    expect(other).toContain("(零命中)");
    expect(other).toContain("code_sense");

    // negative 命中路径零增加(引导只在零命中时出现,不给成功调用加噪声)
    const hit = await exec("grep", { pattern: "alpha" });
    expect(hit).toContain("a.ts:1:");
    expect(hit).not.toContain("code_sense");
  });

  it("content 行截断(200 字符)切在 emoji 代理对中间不产生孤立代理(2026-10-29 DeepSeek 400 实测确认回归)", async () => {
    const root = mk();
    // 复刻事故:AGENTS.md:152 行 603 code units,trim 后第 200 个 code unit 恰是 🎙 高位 D83C
    const line = "x".repeat(193) + "框呼吸);小按钮 🎙 删除(避免两个语"; // 199 BMP + 🎙 = 第 200 是高位
    writeFileSync(join(root, "ag.md"), line + "\n", "utf-8");
    const { exec } = toolsOf(root);
    const out = await exec("grep", { pattern: "小按钮" });
    expect(out).toContain("ag.md:1:");
    expect(hasLoneSurrogate(out)).toBe(false);
    // 事故形态对照:清洗前该行末尾是孤立 D83C,序列化后上游报 unexpected end of hex escape
  });
});

/** 扫孤立 UTF-16 代理码元(与 provider 层 sanitizeLoneSurrogates 同判定)。 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const n = s.charCodeAt(i + 1); if (!(n >= 0xdc00 && n <= 0xdfff)) return true; }
    else if (c >= 0xdc00 && c <= 0xdfff) { const p = s.charCodeAt(i - 1); if (!(p >= 0xd800 && p <= 0xdbff)) return true; }
  }
  return false;
}

describe("权限链对拍(permission-passing 同形态:主 loop 闸门 × 文件写类)", () => {
 /** 单工具一 turn:llm 首步发该工具调用,次步;返回 journal 与工具结果文本。 */
  async function runOneTool(name: string, args: unknown, perm: PermOption, root: string) {
    const journal = new MemoryJournal();
    const tools: Tool[] = createFileTools({ root, journal, sessionId: "s1" });
    let i = 0;
    const llm = {
      async chat() {
        i++;
        if (i === 1) return { content: "", toolCalls: [{ id: "c1", name, arguments: JSON.stringify(args) }] };
        return { content: "done" };
      },
    };
    await new AgentLoop({ journal, sessionId: "s1", system: "s", llm, tools, permission: perm }).runTurn("做");
    const call = journal.readAll().find((e) => e.kind === "tool.call" && (e.payload as { name?: string }).name === name);
    const result = journal.readAll().find((e) => e.kind === "tool.result" && (e.payload as { toolCallId?: string }).toolCallId === "c1");
    return { journal, called: !!call, content: String((result?.payload as { content?: string })?.content ?? "") };
  }

  it("file.write 类别 deny 规则:write_file 被拒(by=rule),文件不落盘", async () => {
    setPermissionMode("ask");
    const root = mk();
    const rules: PermissionRule[] = [{ permission: "file.write", pattern: "*", action: "deny" }];
    const perm = buildMainLoopPermission(rules, undefined, { sessionId: "s1", journal: new MemoryJournal() });
    const r = await runOneTool("write_file", { path: "x.txt", content: "hi" }, perm, root);
    expect(r.called).toBe(false); // 拒绝路径:tool.call 不落(loop 在闸门后才记调用),结果与 gate 事件在案
    expect(r.content).toContain("被权限规则拒绝");
    expect(existsSync(join(root, "x.txt"))).toBe(false);
    expect(gateEvents(r.journal)).toContainEqual(expect.objectContaining({ tool: "write_file", effect: "denied", by: "rule" }));
  });

  it("file.write 类别 allow 规则:write_file 与 edit_file 双双直通(类别别名一票覆盖)", async () => {
    setPermissionMode("ask");
    const root = mk();
    const rules: PermissionRule[] = [{ permission: "file.write", pattern: "*", action: "allow" }];
    const perm = buildMainLoopPermission(rules, undefined, { sessionId: "s1", journal: new MemoryJournal() });
    const w = await runOneTool("write_file", { path: "x.txt", content: "v1" }, perm, root);
    expect(w.content).toContain("已创建");
    expect(readFileSync(join(root, "x.txt"), "utf-8")).toBe("v1");
    // 同 turn 序列里的编辑:再跑一 turn,先读后编
    const journal2 = new MemoryJournal();
    const tools: Tool[] = createFileTools({ root, journal: journal2, sessionId: "s1" });
    let i = 0;
    const llm = {
      async chat() {
        i++;
        if (i === 1) return { content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ path: "x.txt" }) }, { id: "e1", name: "edit_file", arguments: JSON.stringify({ path: "x.txt", old_string: "v1", new_string: "v2" }) }] };
        return { content: "done" };
      },
    };
    await new AgentLoop({ journal: journal2, sessionId: "s1", system: "s", llm, tools, permission: perm }).runTurn("做");
    expect(readFileSync(join(root, "x.txt"), "utf-8")).toBe("v2");
    const editResult = journal2.readAll().find((e) => e.kind === "tool.result" && (e.payload as { toolCallId?: string }).toolCallId === "e1");
    expect(String((editResult?.payload as { content?: string }).content)).toContain("替换 1 处");
  });

  it("mode=ask+broker:write_file 走审批链(批准→执行;拒绝→拦截)", async () => {
    setPermissionMode("ask");
    const root = mk();
    const asked: string[] = [];
    const broker = {
      ask: async (input: { tool: string }) => {
        asked.push(input.tool);
        return { decision: "allow-once" as const, by: "panel" };
      },
    };
    const perm = buildMainLoopPermission([], broker, { sessionId: "s1", journal: new MemoryJournal() });
    const r = await runOneTool("write_file", { path: "y.txt", content: "ok" }, perm, root);
    expect(asked).toEqual(["write_file"]);
    expect(r.content).toContain("已创建");
    expect(gateEvents(r.journal)).toContainEqual(expect.objectContaining({ tool: "write_file", effect: "allowed", by: "ask-approved" }));

    const rejBroker = { ask: async () => ({ decision: "reject" as const, by: "panel" }) };
    const perm2 = buildMainLoopPermission([], rejBroker, { sessionId: "s1", journal: new MemoryJournal() });
    const r2 = await runOneTool("write_file", { path: "z.txt", content: "no" }, perm2, root);
    expect(r2.content).toContain("被权限审批拒绝");
    expect(existsSync(join(root, "z.txt"))).toBe(false);
  });

  it("readonly 模式压过 allow 规则(模式优先):工具层拒绝+mode-readonly gate 在案", async () => {
    setPermissionMode("readonly");
    const root = mk();
    const rules: PermissionRule[] = [{ permission: "file.write", pattern: "*", action: "allow" }];
    const perm = buildMainLoopPermission(rules, undefined, { sessionId: "s1", journal: new MemoryJournal() });
    const r = await runOneTool("write_file", { path: "w.txt", content: "x" }, perm, root);
    expect(r.content).toContain("只读");
    expect(existsSync(join(root, "w.txt"))).toBe(false);
    expect(gateEvents(r.journal)).toContainEqual(expect.objectContaining({ tool: "write_file", effect: "denied", by: "mode-readonly" }));
  });

  it("isReadOnly 读类工具闸门豁免:mode=ask 无规则无 broker 直通(写类同场景仍 fail-closed)", async () => {
    setPermissionMode("ask");
    const root = mk();
    writeFileSync(join(root, "r.txt"), "content", "utf-8");
    const rules: PermissionRule[] = []; // 规则面为空:缺省 ask 且无人应答
    const perm = buildMainLoopPermission(rules, undefined, { sessionId: "s1", journal: new MemoryJournal() });
    const reads = await runOneTool("read_file", { path: "r.txt" }, perm, root);
    expect(reads.content).toContain("content"); // 读类豁免直通
    const writes = await runOneTool("write_file", { path: "w.txt", content: "x" }, perm, root);
    expect(writes.content).toContain("被权限规则拒绝"); // 写类照常 fail-closed
    expect(existsSync(join(root, "w.txt"))).toBe(false);
  });

  it("tool.call/tool.result 配对在案(loop 统一记,journal 断言)", async () => {
    setPermissionMode("auto");
    const root = mk();
    const rules: PermissionRule[] = [{ permission: "file.write", pattern: "*", action: "allow" }];
    const perm = buildMainLoopPermission(rules, undefined, { sessionId: "s1", journal: new MemoryJournal() });
    const r = await runOneTool("write_file", { path: "p.txt", content: "pair" }, perm, root);
    const kinds = r.journal.readAll().filter((e) => e.kind === "tool.call" || e.kind === "tool.result").map((e) => e.kind);
    expect(kinds).toEqual(["tool.call", "tool.result"]); // 逐调用配对,无遗漏
  });
});

describe("editHint(B 首次改动基因提示,2026-11-14)", () => {
  const editOnce = async (root: string, hint: (rel: string) => string | undefined) => {
    const journal = new MemoryJournal();
    const tools = createFileTools({ root, journal, sessionId: "t-gene", editHint: hint });
    const byName = new Map(tools.map((t) => [t.name, t]));
    writeFileSync(join(root, "panel.ts"), "const a = 1;\n");
    await byName.get("read_file")!.execute({ path: "panel.ts" });
    const out = String(await byName.get("edit_file")!.execute({ path: "panel.ts", old_string: "const a = 1;", new_string: "const a = 2;" }));
    return { out, journal };
  };

  it("命中时把提示追加到 edit_file 回执尾部", async () => {
    const root = mk();
    let calls = 0;
    const { out } = await editOnce(root, (rel) => { calls++; return rel === "panel.ts" ? "<system-reminder>基因提示</system-reminder>" : undefined; });
    expect(out).toContain("已编辑");
    expect(out).toContain("基因提示");
    expect(calls).toBe(1);
  });

  it("未命中不追加;hook 抛错也不影响编辑成功", async () => {
    const root = mk();
    const miss = await editOnce(root, () => undefined);
    expect(miss.out).not.toContain("基因提示");
    const root2 = mk();
    const thrown = await editOnce(root2, () => { throw new Error("boom"); });
    expect(thrown.out).toContain("已编辑");
    expect(thrown.out).not.toContain("boom");
  });
});

describe("上下文卫生尾注(2026-10-20:大输出提醒主 agent 拆子任务派子代理)", () => {
  it("grep 输出超 6KB 附尾注;小输出不附", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-hyg-"));
    try {
      // 80 行 × 每行 ~140B 命中 = ~11KB 输出
      const line = "needle " + "y".repeat(130);
      writeFileSync(join(dir, "big.log"), Array.from({ length: 80 }, () => line).join("\n"), "utf-8");
      writeFileSync(join(dir, "small.log"), "needle only one\n", "utf-8");
      const journal = { append: () => {} } as never;
      const tools = createFileTools({ root: dir, journal, sessionId: "s-hyg" });
      const grep = tools.find((t) => t.name === "grep")!;
      const big = String(await grep.execute({ pattern: "needle", path: "big.log", head_limit: 80 }));
      expect(big).toContain("[上下文卫生]");
      expect(big).toContain("spawn_subagent");
      const small = String(await grep.execute({ pattern: "needle", path: "small.log" }));
      expect(small).not.toContain("[上下文卫生]");
      expect(small).toContain("small.log:1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
