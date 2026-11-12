import { AGENT_WIRING_SRC , PROTOCOL_SRC } from "./panel-source.js";
/**
 * 接线测试:读源码确认 loop/agent-wiring/server 的插入点与契约,并测纯路径提取。
 * 不起网关、不碰工作区文件(源码只读)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { collectSnapshotPaths } from "../src/agent-wiring.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const gateway = path.resolve(here, "..");
const repo = path.resolve(gateway, "..", "..");
const read = (rel: string) => readFileSync(path.join(repo, rel), "utf8");

describe("loop 钩子(快照必须在工具执行前)", () => {
  const loop = read("packages/harness-runtime/src/agent/loop.ts");

  it("声明 onStepToolPlan 可选钩子(可异步)", () => {
    expect(loop).toContain("onStepToolPlan?: (p: { turn: number; step: number; calls: ToolCall[] })");
  });

  it("调用点位于拿到 calls 之后、工具批调度之前", () => {
    const callAt = loop.indexOf("await this.opts.onStepToolPlan?.({ turn, step, calls })");
    const planAt = loop.indexOf("planToolBatch(runnable");
    const execAt = loop.indexOf("this.execOne(c, ac.signal)");
    expect(callAt).toBeGreaterThan(-1);
    expect(planAt).toBeGreaterThan(callAt);
    expect(execAt).toBeGreaterThan(callAt);
  });

  it("回调异常被吞(不打断工具执行)", () => {
    expect(loop).toContain("try { await this.opts.onStepToolPlan?.({ turn, step, calls }); } catch");
  });
});

describe("agent-wiring 接线", () => {
  const wiring = AGENT_WIRING_SRC;

  it("注入 onStepToolPlan → TimeTravelStore.capture(tNsM)", () => {
    expect(wiring).toContain("onStepToolPlan: async (p) => {");
    expect(wiring).toContain("new TimeTravelStore({ root: repoRoot() })");
    expect(wiring).toContain("tt.capture(task.sessionId, `t${p.turn}s${p.step}`, taskRoot, paths)");
  });

  it("纯路径提取:只认文件类工具、支持 path/file_path/target_path、去重", () => {
    const paths = collectSnapshotPaths([
      { name: "write_file", arguments: JSON.stringify({ path: "src/a.ts" }) },
      { name: "edit_file", arguments: JSON.stringify({ file_path: "src/a.ts" }) },
      { name: "apply_patch", arguments: JSON.stringify({ target_path: "src/b.ts" }) },
      { name: "terminal", arguments: JSON.stringify({ command: "rm -rf /" }) },
      { name: "read_file", arguments: JSON.stringify({ path: "src/c.ts" }) },
      { name: "write_file", arguments: "not-json" },
    ]);
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(collectSnapshotPaths(undefined)).toEqual([]);
  });
});

describe("server 接入", () => {
  const server = read("apps/gateway/src/server.ts");

  it("checkpoint 带 step 走快照,无 step 保持旧 git sha 路径", () => {
    expect(server).toContain("const ttStep = String(");
    expect(server).toContain('const { TimeTravelStore } = await import("./time-travel-store.js")');
    expect(server).toContain("const svc = await import(\"./git-service.js\")");
 // 旧路径仍在同一分支内(ttStep 为空时才会走到)
  });

  it("rewind 先过 rewindGuard,成功落 custom checkpoint.restore {mode:time-travel}", () => {
    expect(server).toContain("rewindGuard({ activeSubagents, workflowRunning: false })");
    expect(server).toContain('mode: "time-travel"');
    expect(server).toContain("BACKGROUND_BUSY".replace("BACKGROUND_BUSY", guardCodeExpression()));
  });

  it("session.fork 支持 atSeq 截断复制,无 atSeq 保留旧全量分支", () => {
    expect(server).toContain("store.forkEvents(msg.sessionId, atSeq, forkId, SESSION_FORK_EXCLUDED_KINDS)");
    expect(server).toContain("if (Number.isFinite(atSeq)) {");
    expect(server).toContain("} else {\n        for (const e of srcEvents) {");
  });

  it("checkpoint.preview/rewind 的 store 构造带 journal(边界校验入口)", () => {
    const hits = server.split("new TimeTravelStore({ root: repoRoot(), journal })").length - 1;
    expect(hits).toBeGreaterThanOrEqual(2); // fork 路径 + checkpoint.preview/rewind 路径
    const at = server.indexOf('case "checkpoint.preview":');
    expect(at).toBeGreaterThan(-1);
    expect(server.slice(at, at + 2000)).toContain("new TimeTravelStore({ root: repoRoot(), journal })");
  });

  it("step/boundary/atSeq 从 raw payload 补回(zod 剥键,协议不改)", () => {
    expect(server).toContain("typeof extra.step === \"string\"");
    expect(server).toContain("typeof extra.atSeq === \"number\"");
  });

  it("mode/boundarySeq 同样从 raw payload 补回(协议包零改动)", () => {
    expect(server).toContain('extra.mode === "files" || extra.mode === "messages" || extra.mode === "both"');
    expect(server).toContain("rec.mode = extra.mode;");
    expect(server).toContain("rec.boundarySeq = Math.floor(extra.boundarySeq);");
  });
});

describe("时间旅行三模式(files/messages/both)源码断言", () => {
  const server = read("apps/gateway/src/server.ts");
  const at = server.indexOf('case "checkpoint.preview":');
  const block = server.slice(at, at + 8000);
  const pos = (needle: string) => block.indexOf(needle);

  it("mode 缺省/非法一律回落 files(旧行为)", () => {
    expect(block).toContain('requestedMode === "messages" || requestedMode === "both" ? requestedMode : "files"');
    expect(block).toContain('const ttMode: "files" | "messages" | "both" =');
  });

  it("messages 分支:只调 truncateMessages,不调 restore", () => {
    expect(block).toContain('if (ttMode === "messages") {');
    const start = pos('if (ttMode === "messages") {');
    const restoreAt = pos("const rr = await store.restore(sid, ttStep);");
    expect(restoreAt).toBeGreaterThan(start);
    const mBranch = block.slice(start, restoreAt);
    expect(mBranch).toContain("await store.truncateMessages(sid, boundarySeq)");
    expect(mBranch).not.toContain("store.restore(");
    expect(mBranch).toContain('type: "git.ok", op: "rewind"');
    expect(mBranch).toContain("已截断对话(边界 seq=");
  });

  it("both 分支:先 restore 再 truncateMessages,截断失败不撤销文件", () => {
    const both = pos('if (ttMode === "both") {');
    expect(both).toBeGreaterThan(pos("const rr = await store.restore(sid, ttStep);"));
    expect(block.slice(both, both + 900)).toContain("await store.truncateMessages(sid, boundarySeq)");
    expect(block.slice(both, both + 900)).toContain("对话未截断(");
 // 两种模式各调一次
    expect(block.split("store.truncateMessages(sid, boundarySeq)").length - 1).toBe(2);
  });

  it("boundary 解析失败回 INVALID_BOUNDARY,不发 git.ok", () => {
    expect(block).toContain('truncateCode = "INVALID_BOUNDARY";');
    expect(block).toContain('code: "INVALID_BOUNDARY",');
  });

  it("boundarySeq 优先取请求值,否则从 stepId 的 step.start 解析", () => {
    expect(block).toContain("const explicitSeq = Number((msg as unknown as { boundarySeq?: unknown }).boundarySeq);");
    expect(block).toContain("const b = boundaryOfStep(journal.readAll() as never, sid, { stepId: ttStep });");
    expect(pos("boundaryOfStep(journal.readAll()")).toBeLessThan(pos('if (msg.type === "checkpoint.preview")'));
  });

  it("rewindGuard 在 restore 与 truncate 之前(三种模式同一道闸)", () => {
    const guard = pos("const guard = rewindGuard({ activeSubagents, workflowRunning: false });");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(pos("const rr = await store.restore(sid, ttStep);"));
    expect(guard).toBeLessThan(pos('if (ttMode === "messages") {'));
    expect(guard).toBeLessThan(pos("await store.truncateMessages(sid, boundarySeq)"));
  });

  it("preview 回包带 mode 与 boundarySeq(解析不到则不带)", () => {
    expect(block).toContain("mode: ttMode,");
    expect(block).toContain("...(boundarySeq !== null ? { boundarySeq } : {}),");
  });

  it("checkpoint.restore 审计事件保留 mode:time-travel,并附 ttMode", () => {
    expect(block).toContain('mode: "time-travel", ttMode, stepId: ttStep');
  });
});

/** 守卫码在 server 里以 guard.code 变量出现(不在源码里硬写 BACKGROUND_BUSY)。 */
function guardCodeExpression(): string {
  return "code: guard.code";
}

describe("协议未被改动", () => {
  it("CheckpointPreview/SessionFork schema 仍只有 taskId/sessionId", () => {
    const protocol = PROTOCOL_SRC;
    expect(protocol).toMatch(/CheckpointPreview = Envelope\.extend\(\{ type: z\.literal\("checkpoint\.preview"\), taskId: z\.string\(\)\.min\(1\) \}\)/);
    expect(protocol).toMatch(/type: z\.literal\("session\.fork"\),\s*\n\s*sessionId: z\.string\(\)\.min\(1\),/);
  });
});
