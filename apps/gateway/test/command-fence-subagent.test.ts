/**
 * 子代理 run_cmd 命令围栏(planner 板节点 04):workspace 档下拦「命令文本里直接写工作目录外路径」,
 * ask/auto/readonly/plan 四档零回归(fenceRunCmd 唯一早退)。
 * 风格:纯函数直测(fenceRunCmd)+ 一条走 runOne 的集成断言(真 LlmLoopBackend + 假 LLM;
 * execFile 用 vi.mock 桩成「一调就抛」,证明被拒时根本没起进程)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend, fenceRunCmd } from "../src/llm-loop-backend.js";
import { setPermissionMode } from "../src/permission-mode.js";

/** execFile 桩:记录调用次数;真被调用就直接抛(围栏写在起进程之前,被拒时零调用)。 */
const execCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (..._args: unknown[]) => {
      execCalls.n++;
      throw new Error("execFile 不应被调用(命令围栏未生效)");
    },
  };
});

const mk = () => mkdtempSync(join(tmpdir(), "cfsub-"));

/** 走 runOne 的集成断言:真 backend + 脚本化 LLM 发一次 run_cmd,回收 tool.result 内容。 */
async function runCmdOnce(dir: string, command: string): Promise<string> {
  let step = 0;
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  const llm = {
    async chat() {
      step++;
      if (step === 1) return { content: "", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command }) }] };
      return { content: "done 围栏探针完成" };
    },
  } as never;
  const backend = new LlmLoopBackend({
    llm, roots: [dir], workdir: dir, role: "worker", stallTimeoutMs: 30_000,
    onLoopEvent: (e) => { events.push(e); },
  });
  let done = false;
  await backend.spawn({ taskId: "fence", instructions: "围栏探针", workdir: dir, permissions: "sandbox" }, (e) => {
    if (e.type === "result") done = true;
  });
  for (let t = 0; t < 200 && !done; t++) await new Promise((r) => setTimeout(r, 50));
  const tr = events.find((e) => e.kind === "tool.result" && e.payload.name === "run_cmd");
  return String(tr?.payload.content ?? "");
}

beforeEach(() => { setPermissionMode("ask"); execCalls.n = 0; });
afterEach(() => { setPermissionMode("ask"); });

describe("fenceRunCmd(子代理 run_cmd 命令围栏)", () => {
  it("workspace:工作目录外绝对路径/越界 .. 段 → 返回拒因", () => {
    const dir = mk();
    setPermissionMode("workspace");
    expect(fenceRunCmd("cat /etc/hostname", dir)).toContain("/etc/hostname");
    expect(fenceRunCmd("cd " + dir + " && cat ../outside.txt", dir)).toContain("..");
    // 保守误伤登记:按 workdir 解析,`cd sub && cat ../in.txt` 实际落在目录内也会被拒(纯文本启发式看不到 cd 上下文)
    expect(fenceRunCmd("cd sub && cat ../in.txt", dir)).toContain("..");
    setPermissionMode("ask");
  });

  it("workspace:目录内相对路径与目录内绝对路径放行(null)", () => {
    const dir = mk();
    setPermissionMode("workspace");
    expect(fenceRunCmd("npx vitest run test/a.test.ts", dir)).toBeNull();
    expect(fenceRunCmd("cd sub && cat in.txt", dir)).toBeNull();
    expect(fenceRunCmd("cat " + join(dir, "a.txt"), dir)).toBeNull();
    setPermissionMode("ask");
  });

  it("auto/ask/readonly/plan 四档:fenceRunCmd 一律 null(零回归)", () => {
    const dir = mk();
    for (const mode of ["auto", "ask", "readonly", "plan"]) {
      setPermissionMode(mode);
      expect(fenceRunCmd("cat /etc/hostname", dir)).toBeNull();
      expect(fenceRunCmd("cd / && ls", dir)).toBeNull();
    }
    setPermissionMode("ask");
  });
});

describe("run_cmd 集成(走 runOne,非纯函数)", () => {
  it("workspace:`cat /etc/hostname` 返回错误串(带拒因),execFile 零调用", async () => {
    const dir = mk();
    setPermissionMode("workspace");
    const content = await runCmdOnce(dir, "cat /etc/hostname");
    setPermissionMode("ask");
    expect(content.startsWith("错误:")).toBe(true);
    expect(content).toContain("/etc/hostname");
    expect(content).toContain("workspace");
    expect(execCalls.n).toBe(0);
  }, 30_000);

  it("auto:同一命令放行(走到执行路径,不再返回围栏拒因)", async () => {
    const dir = mk();
    setPermissionMode("auto");
    const content = await runCmdOnce(dir, "cat /etc/hostname");
    setPermissionMode("ask");
    // execFile 桩被调 1 次=命令真的走到了执行路径(桩自身抛错,故结果里是桩的报错而非围栏拒因)
    expect(execCalls.n).toBe(1);
    expect(content).toContain("execFile 不应被调用");
    expect(content).not.toContain("只允许操作工作目录内的文件");
    expect(existsSync(join(dir, "unreachable-sentinel"))).toBe(false);
  }, 30_000);
});
