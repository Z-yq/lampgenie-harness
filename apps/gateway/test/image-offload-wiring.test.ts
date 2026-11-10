/**
 * 图片 offload 在 gateway 的**生产装配**接通回归(2026-11 验收)。
 * 背景:runtime 侧 loop 已实现 `imageOffload` 分支(首调报图片预算/尺寸错误 → data URL 落盘
 * `<root>/.genie/image-offload/<sessionId>/` + 占位行 → 立即重试一次),但 gateway 构造 AgentLoop
 * 时没传 = 生产行为等于改前。本文件锁三件事:
 *  a. 三处构造点(主 loop / 子代理两处 / super agent)都传了 imageOffload(源码静态断言,
 *     抽取不到定义块直接报错,不静默通过);
 *  b. 装配层取值口径 `imageOffloadOf(root)` 是纯函数,缺省根 = repoRoot()(与 .genie 其它落盘根一致);
 *  c. **行为级**:真走 wireAgentLoop 主 agent 路径,假 provider 首调抛图片错误 → offload 后次调成功,
 *     文件真落盘 + journal 有 image.offloaded —— 证明装配层确实把选项传进了 loop,而不是看起来传了。
 * 隔离:repoRoot() 优先读 GENIE_REPO_ROOT,故测试内把它指到临时目录,offload 产物落临时根,
 * 不污染真仓 .genie。块首备份、块末恢复。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import type { Message } from "@lampgenie/runtime/agent/loop";
import { EchoChildBackend } from "@lampgenie/executors";
import { wireAgentLoop, imageOffloadOf } from "../src/agent-wiring.js";
import { repoRoot } from "../src/repo-root.js";
import { TaskSupervisor } from "../src/task-manager.js";

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
/** 与 runtime 侧同文案:命中 isImageBudgetError。 */
const IMG_BUDGET_ERR = () => new Error("400 IMAGE_OFFLOAD_REQUIRED: request contains image data that must be offloaded");

describe("imageOffload 装配口径(纯函数)", () => {
  it("显式根原样透传;缺省根 = repoRoot()", () => {
    expect(imageOffloadOf("/tmp/x")).toEqual({ root: "/tmp/x" });
    expect(imageOffloadOf()).toEqual({ root: repoRoot() });
  });
});

describe("三处构造点静态断言(源码级)", () => {
  it("agent-wiring:主 loop 与子代理 backend 构造都传 imageOffloadOf(repoRoot())", () => {
    const text = src("../src/agent-wiring.ts");
    const hits = text.split("imageOffload: imageOffloadOf(repoRoot()),").length - 1;
    // 2 = 主 AgentLoop 选项 + LlmLoopBackend 选项;少一处即漏接(子代理不再 offload)
    expect(hits, "agent-wiring 里 imageOffload 装配点应为 2 处(主 loop + 子代理 backend)").toBe(2);
    expect(text).toContain("export function imageOffloadOf");
  });

  it("llm-loop-backend:首跑与串台重派两个 new AgentLoop 都传同一份 imageOffload", () => {
    const text = src("../src/llm-loop-backend.ts");
    const bare = text.split("\n").filter((l) => /^\s*imageOffload,$/.test(l)).length;
    expect(bare, "两处 new AgentLoop 都应有 imageOffload,（首跑 + 重派）").toBe(2);
    // 缺省根解析:workdir > roots[0] > cwd
    expect(text).toContain("const imageOffload = this.opts.imageOffload ?? { root: this.opts.workdir ?? roots[0] ?? process.cwd() };");
  });

  it("super-agent:SuperAgentDeps 透传到 loop 选项", () => {
    const text = src("../src/super-agent.ts");
    expect(text).toContain("imageOffload?: { root: string };");
    expect(text).toContain("...(deps.imageOffload ? { imageOffload: deps.imageOffload } : {}),");
  });

  it("app.ts:superDeps 由装配根注入 imageOffloadOf(repoRoot())", () => {
    expect(src("../src/app.ts")).toContain("imageOffload: imageOffloadOf(repoRoot()),");
  });
});

describe("行为级:主 agent 路径(真走 wireAgentLoop)offload 生效", () => {
  let root = "";
  const savedEnv = process.env["GENIE_REPO_ROOT"];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gw-img-offload-"));
    process.env["GENIE_REPO_ROOT"] = root;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env["GENIE_REPO_ROOT"];
    else process.env["GENIE_REPO_ROOT"] = savedEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it("首调抛图片预算错误 → offload 后次调成功;文件落 <root>/.genie/image-offload/<sessionId>/;journal 有 image.offloaded", async () => {
    const tm = new TaskSupervisor({});
    const journal = new MemoryJournal();
    const calls: Message[][] = [];
    let first = true;
    const llm = {
      async chat(messages: Message[]) {
        calls.push(JSON.parse(JSON.stringify(messages)) as Message[]);
        if (first) { first = false; throw IMG_BUDGET_ERR(); }
        return { content: "看到了" };
      },
    };
    wireAgentLoop(
      tm as never, journal as never, llm as never, new EchoChildBackend() as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      {} as never);
    // 附件图片:内容不必是真 PNG(尺寸解析失败=放行,与 readImageSize 口径一致)
    const imgPath = join(root, "pic.png");
    writeFileSync(imgPath, Buffer.from("QUJD", "base64"));
    const sid = "gw-img-offload-s1";
    tm.submit("user", sid, "看这张图", { attachments: [{ name: "pic.png", path: imgPath, mime: "image/png" }] });

    const deadline = Date.now() + 20_000;
    for (;;) {
      const t = tm.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      if (Date.now() > deadline) throw new Error("任务未收口(20s)");
      await new Promise((r) => setTimeout(r, 50));
    }

    // ① 两次调用:首调被图片错误打回,次调成功
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]!.flatMap((m) => (m as { images?: string[] }).images ?? []), "第二次请求不应再带 data URL").toEqual([]);
    expect(String(calls[1]![calls[1]!.length - 1]!.content)).toContain("[image offloaded");

    // ② journal:image.offloaded 一条,文件真落盘在 repoRoot 口径的 .genie 下
    const ev = journal.readAll()
      .filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === "image.offloaded")
      .map((e) => e.payload as { count: number; files: string[]; reason: string });
    expect(ev, "装配层没传 imageOffload 时这里恒为 0").toHaveLength(1);
    expect(ev[0]!.count).toBe(1);
    expect(ev[0]!.reason).toBe("provider-image-budget");
    const file = ev[0]!.files[0]!;
    expect(existsSync(file)).toBe(true);
    expect(file.startsWith(join(root, ".genie", "image-offload", sid))).toBe(true);
    expect(readFileSync(file).length).toBe(3);

    // ③ 任务正常完成(不是靠抛错收场)
    const t = tm.list().find((x) => x.sessionId === sid)!;
    expect(t.state).toBe("done");
  }, 30_000);

  it("negative:非图片错误不触发 offload(装配在场也不误伤,1 次调用即失败)", async () => {
    const tm = new TaskSupervisor({});
    const journal = new MemoryJournal();
    let calls = 0;
    const llm = {
      async chat() { calls += 1; throw new Error("400 invalid_request_error: tool_calls must be followed"); },
    };
    wireAgentLoop(
      tm as never, journal as never, llm as never, new EchoChildBackend() as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      {} as never);
    const sid = "gw-img-offload-neg";
    // 附件目录必须存在(构造注入阶段会 stat);用临时根下的子目录
    mkdirSync(join(root, "att"), { recursive: true });
    const imgPath = join(root, "att", "x.png");
    writeFileSync(imgPath, Buffer.from("QUJD", "base64"));
    tm.submit("user", sid, "看图", { attachments: [{ name: "x.png", path: imgPath, mime: "image/png" }] });

    const deadline = Date.now() + 20_000;
    for (;;) {
      const t = tm.list().find((x) => x.sessionId === sid);
      if (t && (t.state === "done" || t.state === "failed")) break;
      if (Date.now() > deadline) throw new Error("任务未收口(20s)");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls, "非图片错误不得触发 offload 重试").toBe(1);
    const n = journal.readAll().filter((e) => (e.payload as { what?: string }).what === "image.offloaded").length;
    expect(n).toBe(0);
  }, 30_000);
});
