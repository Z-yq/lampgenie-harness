import { afterAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalSessionService } from "../src/service.js";
import { createTerminalTool } from "../src/tool.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const services: TerminalSessionService[] = [];

function makeTool(owner = "tool-owner", fenceRoot = root, fenceCommand?: (cmd: string) => string | null) {
  const service = new TerminalSessionService({ closeGraceMs: 400 });
  services.push(service);
  return {
    service,
    tool: createTerminalTool({ service, owner, root: fenceRoot, ...(fenceCommand ? { fenceCommand } : {}) }),
  };
}

afterAll(async () => {
  await Promise.allSettled(services.map((service) => service.dispose()));
});

const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe("terminal tool", () => {
  it("open/send/read/close 全链路 + 增量 cursor", async () => {
    const { tool } = makeTool();
    const opened = parse(
      await tool.execute({ action: "open", cwd: "packages", name: "t1" }),
    );
    expect(opened.ok).toBe(true);
    expect(opened.name).toBe("t1");
    expect(String(opened.cwd)).toBe(join(root, "packages"));
    const sessionId = String(opened.sessionId);

    const sent = parse(await tool.execute({ action: "send", sessionId, command: "pwd; echo tool-ok" }));
    expect(sent.ok).toBe(true);
    expect(sent.waitReason).toBe("completed");
    expect(String(sent.output)).toContain("tool-ok");
    expect(String(sent.output)).toContain(join(root, "packages"));
    expect(typeof sent.cursor).toBe("number");

    const read = parse(await tool.execute({ action: "read", sessionId, cursor: sent.cursor }));
    expect(read.ok).toBe(true);
    expect(read.output).toBe("(无新输出)");
    expect(read.cursor).toBe(sent.cursor);

    const listed = parse(await tool.execute({ action: "list" }));
    expect(listed.count).toBe(1);
    expect((listed.sessions as Record<string, unknown>[])[0]!.sessionId).toBe(sessionId);

    const closed = parse(await tool.execute({ action: "close", sessionId }));
    expect(closed.closed).toBe(true);
  }, 20_000);

  it("cwd 围栏:相对上跳/根外绝对路径拒绝", async () => {
    const { tool } = makeTool("o", join(root, "packages"));
    const up = parse(await tool.execute({ action: "open", cwd: "../../.." }));
    expect(up.ok).toBe(false);
    expect(up.code).toBe("INVALID_CWD");
    const abs = parse(await tool.execute({ action: "open", cwd: "/tmp" }));
    expect(abs.ok).toBe(false);
    expect(abs.code).toBe("INVALID_CWD");
    // 根内绝对路径可用
    const inside = parse(await tool.execute({ action: "open", cwd: join(root, "packages", "core") }));
    expect(inside.ok).toBe(true);
    await tool.execute({ action: "close", sessionId: inside.sessionId });
  }, 20_000);

  it("注入 fenceCommand:返回拒因时 ok:false 且命令未下发", async () => {
    const calls: string[] = [];
    const { tool } = makeTool("fence-owner", root, (cmd) => {
      calls.push(cmd);
      return cmd.includes("FENCED-LEAK") ? "命令含项目外绝对路径:/etc/hostname" : null;
    });
    const opened = parse(await tool.execute({ action: "open" }));
    expect(opened.ok).toBe(true);
    const sessionId = String(opened.sessionId);

    const blocked = parse(await tool.execute({ action: "send", sessionId, command: "echo FENCED-LEAK" }));
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("INVALID_INPUT");
    expect(String(blocked.error)).toContain("/etc/hostname");
    expect(calls).toContain("echo FENCED-LEAK"); // 钩子确实在 send 路径被调用

    // 未下发证据:下一条命令的增量输出里不应出现被拒命令的打印(命令没进 shell)
    const after = parse(await tool.execute({ action: "send", sessionId, command: "echo after-ok" }));
    expect(after.ok).toBe(true);
    expect(String(after.output)).toContain("after-ok");
    expect(String(after.output)).not.toContain("FENCED-LEAK");
    await tool.execute({ action: "close", sessionId });
  }, 20_000);

  it("未注入 fenceCommand:send 行为逐字不变", async () => {
    const { tool } = makeTool();
    const opened = parse(await tool.execute({ action: "open" }));
    const sent = parse(await tool.execute({ action: "send", sessionId: opened.sessionId, command: "echo plain-ok" }));
    expect(sent.ok).toBe(true);
    expect(String(sent.output)).toContain("plain-ok");
    await tool.execute({ action: "close", sessionId: opened.sessionId });
  }, 20_000);

  it("commands 批量:一次往返按序跑多条,遇错即停(缺省)", async () => {
    const { tool } = makeTool();
    const opened = parse(await tool.execute({ action: "open" }));
    const r = parse(await tool.execute({
      action: "send",
      sessionId: opened.sessionId,
      commands: ["echo A", "echo B", "false", "echo C"],
    }));
    expect(r.ok).toBe(false);
    expect(r.total).toBe(4);
    expect(r.executed).toBe(3); // 第 3 条 false 失败后停
    expect(r.failedAt).toBe(2);
    const runs = r.runs as Array<{ command: string; ok: boolean; output: string }>;
    expect(runs.map((x) => x.command)).toEqual(["echo A", "echo B", "false"]);
    expect(runs[0]!.output).toContain("A");
    expect(runs[1]!.output).toContain("B");
    await tool.execute({ action: "close", sessionId: opened.sessionId });
  }, 30_000);

  it("commands 批量 negative:stopOnError:false 时失败也继续跑完", async () => {
    const { tool } = makeTool();
    const opened = parse(await tool.execute({ action: "open" }));
    const r = parse(await tool.execute({
      action: "send",
      sessionId: opened.sessionId,
      commands: ["echo A", "false", "echo C"],
      stopOnError: false,
    }));
    expect(r.ok).toBe(false);
    expect(r.executed).toBe(3); // 全部跑完
    const runs = r.runs as Array<{ command: string; ok: boolean }>;
    expect(runs.map((x) => x.ok)).toEqual([true, false, true]);
    await tool.execute({ action: "close", sessionId: opened.sessionId });
  }, 30_000);

  it("isReadOnly 动态:read/list 只读,open/send/close 需权限闸", () => {
    const { tool } = makeTool();
    expect(tool.isReadOnly({ action: "read" })).toBe(true);
    expect(tool.isReadOnly({ action: "list" })).toBe(true);
    expect(tool.isReadOnly({ action: "open" })).toBe(false);
    expect(tool.isReadOnly({ action: "send" })).toBe(false);
    expect(tool.isReadOnly({ action: "close" })).toBe(false);
    expect(tool.isConcurrencySafe()).toBe(false);
  });

  it("参数缺失/未知 action 返回结构化错误", async () => {
    const { tool } = makeTool();
    const noSession = parse(await tool.execute({ action: "send", command: "echo x" }));
    expect(noSession.ok).toBe(false);
    expect(noSession.code).toBe("INVALID_INPUT");
    const unknown = parse(await tool.execute({ action: "nope" }));
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe("INVALID_INPUT");
  });

  it("工具 owner 与 service owner 绑定:另一个 tool 看不到本会话", async () => {
    const { service, tool } = makeTool("owner-1");
    const opened = parse(await tool.execute({ action: "open" }));
    const other = createTerminalTool({ service, owner: "owner-2", root });
    const otherList = parse(await other.execute({ action: "list" }));
    expect(otherList.count).toBe(0);
    const stolen = parse(
      await other.execute({ action: "send", sessionId: opened.sessionId, command: "echo nope" }),
    );
    expect(stolen.ok).toBe(false);
    expect(stolen.code).toBe("FOREIGN_SESSION");
    await tool.execute({ action: "close", sessionId: opened.sessionId });
  }, 20_000);
});
