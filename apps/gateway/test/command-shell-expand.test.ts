/**
 * r4:自定义命令 body 的 !`cmd` shell 片段展开(ZCode custom-command-shell-expansion 语义)。
 * 语义锚点:bash -c 执行 / 3s 超时 / stdout 截 2000 / 失败替换为 (cmd 失败:原因截 120) /
 * 每 body 最多 3 处超出保留原文 / cwd 由调用方传入。
 * 覆盖:① echo 展开 ② 失败标注 ③ 超 3 处保留原文 ④ run 注桩不真 exec ⑤ stdout 截 2000
 *       ⑥ 主链路:commands.list 回包的 custom body 已展开(内置描述不受影响,协议不变)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  expandShellSnippets,
  runShellSnippet,
  SHELL_SNIPPET_MAX_PER_BODY,
  SHELL_SNIPPET_OUTPUT_LIMIT,
  type ShellSnippetRunner,
} from "../src/command-shell-expand.js";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";

let tmp = "";
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gwshell-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("expandShellSnippets(r4 !`cmd` 展开)", () => {
  it("① !`echo hi` → hi(默认执行器真跑 bash;多行输出去尾换行)", () => {
    expect(expandShellSnippets("pre !`echo hi` post", tmp)).toBe("pre hi post");
    expect(expandShellSnippets("!`printf 'a\\nb\\n'`", tmp)).toBe("a\nb");
    // 无片段原样(同一引用,零拷贝)
    const plain = "普通模板 $ARGUMENTS";
    expect(expandShellSnippets(plain, tmp)).toBe(plain);
  }, 15_000);

  it("② 失败替换为 (cmd 失败:原因):非零退出带 stderr 头;超时走 3s 语义", () => {
    const out = expandShellSnippets("!`exit 3`", tmp);
    expect(out).toMatch(/^\(exit 3 失败:exit 3/);
    const noisy = expandShellSnippets("!`echo boom-err 1>&2; exit 7`", tmp);
    expect(noisy).toContain("boom-err");
    // 3s 超时:真实 sleep 5 → killed → 「超时(> 3s)」(默认执行器,验证真 kill 路径)
    expect(expandShellSnippets("!`sleep 5`", tmp)).toBe("(sleep 5 失败:超时(> 3s))");
  }, 15_000);

  it("③ 每条 body 最多展开 3 处,超出保留原文", () => {
    const run: ShellSnippetRunner = (cmd) => ({ ok: true, stdout: "[" + cmd + "]" });
    const body = "a !`one` b !`two` c !`three` d !`four` e !`five`";
    expect(expandShellSnippets(body, tmp, run))
      .toBe("a [one] b [two] c [three] d !`four` e !`five`");
    expect(SHELL_SNIPPET_MAX_PER_BODY).toBe(3);
    // 空片段 !`` 也算一处但执行结果为空串(bash -c '' 零输出)
    expect(expandShellSnippets("!``", tmp, run)).toBe("[]");
  });

  it("④ run 注桩不真 exec:调用参数透传 (cmd, cwd),不碰 child_process", () => {
    const seen: Array<[string, string]> = [];
    const run: ShellSnippetRunner = (cmd, cwd) => { seen.push([cmd, cwd]); return { ok: false, reason: "stub" }; };
    const out = expandShellSnippets("!`anything` + !`more`", "/fake/cwd", run);
    expect(seen).toEqual([["anything", "/fake/cwd"], ["more", "/fake/cwd"]]);
    expect(out).toBe("(anything 失败:stub) + (more 失败:stub)");
  });

  it("⑤ stdout 超 2000 截断(默认执行器真产 3000 字)", () => {
    expect(SHELL_SNIPPET_OUTPUT_LIMIT).toBe(2000);
    const out = expandShellSnippets("!`printf 'x%.0s' $(seq 3000)`", tmp);
    expect(out).toHaveLength(2000);
    expect(out).toBe("x".repeat(2000));
  }, 15_000);

  it("⑤b 失败原因截 120 字(注桩超长 reason)", () => {
    const run: ShellSnippetRunner = () => ({ ok: false, reason: "E".repeat(500) });
    const out = expandShellSnippets("!`cmd`", tmp, run);
    expect(out).toBe("(cmd 失败:" + "E".repeat(120) + ")");
    expect(out).toHaveLength(2 + 3 + 3 + 120 + 1); // (cmd 失败:… ) 形态定长
  });

  it("runShellSnippet 异常兜底:命令不存在 → ok:false 带 exit 码", () => {
    const r = runShellSnippet("definitely-not-a-command-xyz", tmp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("主链路:commands.list 回包 custom body 已展开(list 时展开,协议不变)", () => {
  it("custom 段 body 的 !`cmd` 展开;内置段描述原样、无 body", async () => {
    const httpServer: Server = createServer();
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as { port: number }).port;
    const commands = {
      list: () => [
        { name: "hello", body: "say !`echo hi` now" },
        { name: "plain", body: "无片段原样" },
      ],
      upsert: () => ({}),
      remove: () => true,
    };
    const srv = startGatewayServer({ port, server: httpServer, taskManager: new TaskSupervisor(), journal: new MemoryJournal(), commands });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (r) => inbox.push(JSON.parse(r.toString()) as Record<string, unknown>));
    try {
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ v: 1, type: "commands.list" }));
      const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("commands.list.result 超时")), 10_000);
        const p = setInterval(() => {
          const i = inbox.findIndex((x) => x.type === "commands.list.result");
          if (i >= 0) { clearTimeout(t); clearInterval(p); resolve(inbox.splice(i, 1)[0]); }
        }, 25);
      });
      const cmds = msg.commands as Array<{ name: string; body?: string; description?: string; source?: string }>;
      // custom 段:片段已展开;无片段 body 原样
      expect(cmds.find((c) => c.name === "hello")?.body).toBe("say hi now");
      expect(cmds.find((c) => c.name === "plain")?.body).toBe("无片段原样");
      // 内置段:不带 body,描述原样不展开(rewind/fork/mode 目录条目在场=r3)
      const builtin = cmds.filter((c) => c.source === "builtin");
      expect(builtin.length).toBeGreaterThan(0);
      for (const b of builtin) expect(b.body).toBeUndefined();
      expect(builtin.map((c) => c.name)).toEqual(expect.arrayContaining(["rewind", "fork", "mode"]));
    } finally {
      ws.close();
      await srv.close();
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  }, 20_000);
});
