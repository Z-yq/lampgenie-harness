/**
 * 网关装配层命令围栏(planner 板节点 03):`buildSubagentExtraTools` 在 workspace 档给 terminal 工具注入
 * fenceCommand,非 workspace 档不注入(零回归)。
 * 与纯函数测试(`command-fence.test.ts`)分层:那条证明「围栏函数本身对错」,本条证明「网关真的把它接上了」——
 * 缺了它就会出现「函数写对但没人调用」的假验收。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "@lampgenie/experience";
import { buildSubagentExtraTools } from "../src/agent-wiring.js";
import { setPermissionMode } from "../src/permission-mode.js";

let dir = "";

beforeEach(() => {
  setPermissionMode("ask");
  dir = mkdtempSync(join(tmpdir(), "wsgate-"));
});

afterEach(() => {
  setPermissionMode("ask");
  rmSync(dir, { recursive: true, force: true });
});

/** 取装配出来的 terminal 工具(生产路径:子代理面 execCtx,非 planning)。 */
function terminalTool() {
  const tools = buildSubagentExtraTools(dir, [], new ExperienceStore(dir), {
    journal: new MemoryJournal(),
    sessionId: "probe-session",
    owner: "probe-owner",
  });
  const t = tools.find((x) => x.name === "terminal") as unknown as { execute(a: unknown): Promise<string> } | undefined;
  if (!t) throw new Error("装配面没有 terminal 工具");
  return t;
}

describe("网关装配:workspace 档命令闸真被接上", () => {
  it("workspace:send 项目外绝对路径 → 下发前即被拒(不是 NO_SESSION 之类的下游错误)", async () => {
    setPermissionMode("workspace");
    // 用一个不存在的会话 id:若围栏生效,错误必须是围栏拒因而不是「终端会话不存在」
    const out = await terminalTool().execute({ action: "send", sessionId: "nope", command: "cat /etc/hostname" });
    expect(out).toContain("/etc/hostname");
    expect(out).toContain('"ok":false');
    expect(out).not.toContain("NO_SESSION");
  });

  it("非 workspace 档(ask/auto/readonly/plan):同一命令不被围栏拦(落到下游会话错误=未注入)", async () => {
    for (const mode of ["ask", "auto", "readonly", "plan"] as const) {
      setPermissionMode(mode);
      const out = await terminalTool().execute({ action: "send", sessionId: "nope", command: "cat /etc/hostname" });
      expect({ mode, out }).toEqual({ mode, out });
      expect(out, mode).not.toContain("项目外绝对路径"); // 零回归:四档都不得注入围栏
    }
  });
});
