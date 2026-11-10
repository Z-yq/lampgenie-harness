/**
 * 任务级验证账本(verify-on-stop。
 * A. 纯函数:computeVerifyLedger 的判据(成功验证/失败结果/watch/文档抑制/stale 原因);
 * B. 收尾钩子(agent-wiring 实际终态):warn 追加提示不拦任务;hard 补跑一轮仍 stale → failed + journal。
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
import {
  computeVerifyLedger,
  isVerificationCommand,
  isFailedToolResult,
  renderVerifyLedgerWarning,
  type VerifyLedgerEvent,
} from "../src/verification-ledger.js";

// ---- A. 纯函数 ----
let seq = 0;
const call = (name: string, args: unknown, id = `c${++seq}`): VerifyLedgerEvent => ({
  seq: ++seq,
  kind: "tool.call",
  time: 1000 + seq,
  payload: { toolCallId: id, name, arguments: JSON.stringify(args) },
});
const result = (id: string, content: string, extra: Record<string, unknown> = {}): VerifyLedgerEvent => ({
  seq: ++seq,
  kind: "tool.result",
  time: 1000 + seq,
  payload: { toolCallId: id, content, durationMs: 10, ...extra },
});
const write = (path: string, tool = "edit_file"): VerifyLedgerEvent => call(tool, { path, old_string: "a", new_string: "b" });

/** 生成 call+result 配对(同一 seq 递增顺序)。 */
function pair(name: string, args: unknown, content: string, extra: Record<string, unknown> = {}): VerifyLedgerEvent[] {
  const id = `p${++seq}`;
  return [call(name, args, id), result(id, content, extra)];
}

describe("computeVerifyLedger 判据", () => {
  it("验证命令成功后无写 → 不 stale", () => {
    const evs = [...pair("terminal", { command: "npx vitest run test/a.test.ts" }, "3 passed")];
    const l = computeVerifyLedger(evs);
    expect(l.stale).toBe(false);
    expect(l.reason).toBe("ok");
    expect(l.verificationCount).toBe(1);
    expect(l.lastVerification?.command).toContain("vitest");
    expect(l.lastVerification?.seq).toBeGreaterThan(0);
  });

  it("验证后又写代码 → stale 且列出文件", () => {
    const evs = [
      write("apps/gateway/src/a.ts"),
      ...pair("terminal", { command: "npx tsc --noEmit" }, "0 errors"),
      write("apps/gateway/src/b.ts"),
      write("apps/core/src/c.tsx", "write_file"),
    ];
    const l = computeVerifyLedger(evs);
    expect(l.stale).toBe(true);
    expect(l.reason).toBe("writes-after-verification");
    expect(l.writesAfter.map((w) => w.file)).toEqual(["apps/gateway/src/b.ts", "apps/core/src/c.tsx"]);
    expect(renderVerifyLedgerWarning(l)).toContain("最近一次验证之后又改了 2 个代码文件");
  });

  it("只有文档写 → 不 stale(文档抑制)", () => {
    const evs = [write("docs/a.md"), write("notes/b.txt", "write_file"), write("x/c.rst")];
    const l = computeVerifyLedger(evs);
    expect(l.stale).toBe(false);
    expect(l.codeWriteCount).toBe(0);
    expect(renderVerifyLedgerWarning(l)).toBe("");
  });

  it("无验证但有代码写 → stale(no-verification)", () => {
    const evs = [write("src/x.py")];
    const l = computeVerifyLedger(evs);
    expect(l.stale).toBe(true);
    expect(l.reason).toBe("no-verification");
    expect(l.lastVerification).toBeNull();
    expect(renderVerifyLedgerWarning(l)).toContain("没有任何验证命令记录");
  });

  it("失败/超时命令不算验证(result 以「错误」开头或带 error 字段)", () => {
    const evs = [
      ...pair("terminal", { command: "npx vitest run" }, "错误:命令失败(exit 1)"),
      ...pair("terminal", { command: "npx tsc --noEmit" }, "", { error: { origin: "timeout", message: "超时" } }),
      write("src/a.ts"),
    ];
    const l = computeVerifyLedger(evs);
    expect(l.verificationCount).toBe(0);
    expect(l.stale).toBe(true);
    expect(l.reason).toBe("no-verification");
  });

  it("--watch 不算验证;spawn_subagent 不算验证", () => {
    const evs = [
      ...pair("terminal", { command: "npx vitest --watch" }, "watching..."),
      ...pair("spawn_subagent", { instructions: "跑测试" }, "子代理说测试通过"),
      write("src/a.ts"),
    ];
    const l = computeVerifyLedger(evs);
    expect(l.verificationCount).toBe(0);
    expect(l.reason).toBe("no-verification");
  });

  it("无 tool.result 的 terminal 调用不算验证(没有结论)", () => {
    const evs = [call("terminal", { command: "npx vitest run" }), write("src/a.ts")];
    const l = computeVerifyLedger(evs);
    expect(l.verificationCount).toBe(0);
    expect(l.stale).toBe(true);
  });

  it("writesAfter ≤10 且只取末次验证之后的", () => {
    const evs: VerifyLedgerEvent[] = [...pair("terminal", { command: "npm test" }, "ok")];
    for (let i = 0; i < 15; i++) evs.push(write(`src/f${i}.ts`));
    const l = computeVerifyLedger(evs);
    expect(l.writesAfter.length).toBe(10);
    expect(l.writesAfter[l.writesAfter.length - 1]!.file).toBe("src/f14.ts");
    expect(l.codeWriteCount).toBe(15);
  });

  it("命令识别:词边界 + 大小写;排除 --watch", () => {
    expect(isVerificationCommand("pnpm test")).toBe(true);
    expect(isVerificationCommand("go test ./...")).toBe(true);
    expect(isVerificationCommand("npx playwright test")).toBe(true);
    expect(isVerificationCommand("npx TSC --noEmit")).toBe(true);
    expect(isVerificationCommand("npx vitest --watch")).toBe(false);
    expect(isVerificationCommand("echo testing")).toBe(false);
    expect(isVerificationCommand("")).toBe(false);
  });

  it("失败文案识别", () => {
    expect(isFailedToolResult("错误:boom")).toBe(true);
    expect(isFailedToolResult("[browser 失败] 打不开")).toBe(true);
    expect(isFailedToolResult("", { origin: "threw" })).toBe(true);
    expect(isFailedToolResult("3 passed")).toBe(false);
  });
});

// ---- B. 收尾钩子(agent-wiring) ----
beforeAll(async () => { await acquireEnvLock("verify-on-stop"); }, 240_000);
afterAll(() => { releaseEnvLock("verify-on-stop"); });

const gwApps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => {
  for (const a of gwApps.splice(0)) await a.close();
  delete process.env.GENIE_VERIFY_ON_STOP;
});

type App = ReturnType<typeof createGatewayApp>;

/** 无板任务的收尾入口(plan-gate 收尾警示不需要板;这里只验验证账本)。 */
const INSTRUCTION = "修一下这个逻辑";

interface Scenario {
  sid: string;
  /** 第 0 步在 journal 里落的事件(模拟本任务窗口内已发生的工具动作)。 */
  seed: (sid: string, append: Append) => void;
}
type Append = (e: { kind: string; sessionId: string; payload: Record<string, unknown> }) => void;

async function runScenario(s: Scenario): Promise<{ state: string; result: string; app: App }> {
  let appRef: App;
  let step = 0;
  const app = createGatewayApp({
    port: 0,
    llm: {
      async chat() {
        if (step++ === 0) {
          s.seed(s.sid, (e) => { appRef.journal.append(e as never); });
          return { content: "终稿" };
        }
        return { content: "终稿" };
      },
    } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  appRef = app;
  gwApps.push(app);
  app.taskManager.submit("user", s.sid, INSTRUCTION);
  for (let k = 0; k < 240; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === s.sid);
    if (t && (t.state === "done" || t.state === "failed")) return { state: t.state, result: String(t.result ?? ""), app };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未在时限内终态");
}

/** 本任务窗口内的三类事件:成功验证 / 代码写 / 文档写。 */
const seedVerifiedThenWrite = (sid: string, append: Append) => {
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "t1", name: "terminal", arguments: JSON.stringify({ command: "npx vitest run test/a.test.ts" }) } });
  append({ kind: "tool.result", sessionId: sid, payload: { toolCallId: "t1", content: "3 passed", durationMs: 5 } });
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "w1", name: "edit_file", arguments: JSON.stringify({ path: "apps/gateway/src/late.ts", old_string: "a", new_string: "b" }) } });
};
const seedDocOnly = (sid: string, append: Append) => {
  append({ kind: "tool.call", sessionId: sid, payload: { toolCallId: "w1", name: "write_file", arguments: JSON.stringify({ path: "docs/report.md", content: "x" }) } });
};

const customTypes = (app: App, sid: string): string[] =>
  app.journal.readAll()
    .filter((e) => e.kind === "custom" && e.sessionId === sid)
    .map((e) => String((e.payload as { type?: string }).type ?? ""));

describe("收尾钩子(agent-wiring)", () => {
  it("warn(缺省):验证后又改代码 → done 且回执带验证账本提示,journal 落 verify.ledger", async () => {
    const r = await runScenario({ sid: "vos-warn-1", seed: seedVerifiedThenWrite as Scenario["seed"] });
    expect(r.state).toBe("done");
    expect(r.result).toContain("[验证账本]");
    expect(r.result).toContain("apps/gateway/src/late.ts");
    const types = customTypes(r.app, "vos-warn-1");
    expect(types).toContain("verify.ledger");
  }, 120_000);

  it("warn:只有文档改动 → 不追加任何提示", async () => {
    const r = await runScenario({ sid: "vos-warn-2", seed: seedDocOnly });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("[验证账本]");
    expect(customTypes(r.app, "vos-warn-2")).toContain("verify.ledger");
  }, 120_000);

  it("hard:补跑一轮仍 stale → failed + verify.ledger.hard-fail,代码不回滚", async () => {
    process.env.GENIE_VERIFY_ON_STOP = "hard";
    const r = await runScenario({ sid: "vos-hard-1", seed: seedVerifiedThenWrite as Scenario["seed"] });
    expect(r.state).toBe("failed");
    expect(r.result).toContain("未通过验证账本");
    const types = customTypes(r.app, "vos-hard-1");
    expect(types).toContain("verify.ledger.retry");
    expect(types).toContain("verify.ledger.hard-fail");
    const hf = r.app.journal.readAll()
      .find((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "verify.ledger.hard-fail")!;
    expect(String((hf.payload as { reason?: string }).reason)).toContain("最近一次验证之后又改了");
  }, 120_000);

  it("off:关掉检查 → 不落 verify.ledger、不加提示", async () => {
    process.env.GENIE_VERIFY_ON_STOP = "off";
    const r = await runScenario({ sid: "vos-off-1", seed: seedVerifiedThenWrite as Scenario["seed"] });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("[验证账本]");
    expect(customTypes(r.app, "vos-off-1")).not.toContain("verify.ledger");
  }, 120_000);
});

// 防未使用告警(目录/文件工具在本文件不需要,只在 seed 里用 journal 形态)。
void mkdirSync; void writeFileSync; void rmSync; void join;
