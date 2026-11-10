/**
 * 真实 LLM 端到端任务(2026-10-30 token 轮):装配骨架照抄 phase-tracking.test.ts
 * (createGatewayApp + buildExecutorFromConfig + GENIE_PERMISSION_RULES),但 llm 换真实模型
 * (buildLlmFromConfig;凭证由 resolveTrackApiKey 从 env/.genie/secrets.json 读,测试内不写 key)。
 *
 * 产出=数字不是断言:缓存命中率/上下文规模/工具面翻转/注入位置/机制事件计数,全部 console 打印
 * 并落一份 JSON 摘要到 os.tmpdir()(不污染仓库文档树)。任务成功或失败都出数(失败本身是数据)。
 */
import { it, afterEach } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig, buildLlmFromConfig } from "../src/factory.js";
import { loadConfig } from "@lampgenie/core";
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  delete process.env.GENIE_PERMISSION_RULES;
  // 清理真跑创建的临时产物(唯一文件名,不会误删别人的文件)
  for (const f of CREATED_FILES) { try { rmSync(f, { force: true }); } catch { /* 清理尽力而为 */ } }
});

const root = process.cwd().includes("apps/gateway") ? join(process.cwd(), "..", "..") : process.cwd();

/** 唯一化的工作文件名(2026-10-30 修「验收环境未隔离」)。
 *  旧版固定写 src/calc.ts + verify.mjs 到仓库根:第一次跑留下文件后,**后续每一次**都会
 *  被 glob 直接命中(实测第二轮 write_file=0、mtime 仍是上一轮的),等于永远不再验证
 *  「创建文件」这条核心能力。现在文件名带时间戳,并断言 write_file ≥1。
 *  任务结束由 afterEach 清理,仓库不残留。 */
const STAMP = Date.now();
const TASK_TEXT = `在项目根创建 src/calc-${STAMP}.ts,导出 add(a,b) 与 sub(a,b) 两个函数(TypeScript 写法即可,不必编译);
再创建 verify-${STAMP}.mjs,用 node 内置 assert 验证 add(2,3)===5 且 sub(5,3)===2(用动态 import 读 .ts 会失败,所以 verify-${STAMP}.mjs 里直接内联同样的实现并断言);
最后用 node 运行 verify-${STAMP}.mjs 确认通过,把实际输出贴出来。`;
const CREATED_FILES = [join(root, "src", `calc-${STAMP}.ts`), join(root, `verify-${STAMP}.mjs`)];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TraceFile {
  file: string; seq: number; ts?: number; turn?: number; step?: number;
  model?: string; durationMs?: number; toolNames?: string[]; tools?: { name: string }[];
  request?: { messageCount?: number; messages?: { role: string; content: unknown }[] };
  response?: { usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number }; content?: string; toolCalls?: { name: string }[] };
  error?: string;
}

function readTrace(dir: string): TraceFile[] {
  if (!existsSync(dir)) return [];
  const out: TraceFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf-8")) as TraceFile;
      const m = /call-(\d+)-/.exec(f);
      out.push({ ...j, file: f, seq: Number(m?.[1] ?? 0) });
    } catch { /* 半截文件跳过(落盘 fire-and-forget) */ }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function contentText(c: unknown): string {
  return typeof c === "string" ? c : JSON.stringify(c ?? "");
}

function p50(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? 0;
}

const MARKERS = ["[系统提示更新]", "[系统提醒]", "<system-reminder>"];

/** 真实模型调用有成本(实测单次 ~130s、17 万 input token):默认跳过,只有显式开门才跑。
 *  开门:`GENIE_E2E_REAL=1 npx vitest run test/e2e-real-task.test.ts`
 *  日常 `npx vitest run` 不会烧钱(2026-10-30 用户口径:验收要用真实任务,但不能让全量测试付费)。 */
const REAL_E2E = process.env.GENIE_E2E_REAL === "1";

it.skipIf(!REAL_E2E)("真实 LLM 端到端:src/calc.ts + verify.mjs + 跑通,量缓存/步数/机制事件", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([
    "terminal", "write_file", "read_file", "edit_file", "list_dir", "glob", "grep",
    "task_phase", "todo_write", "board_upsert", "board_read",
  ].map((permission) => ({ permission, pattern: "*", action: "allow" })));

  const cfg = loadConfig({ repoRoot: root });
  let llm: ReturnType<typeof buildLlmFromConfig>;
  try {
    llm = buildLlmFromConfig(cfg.config, root);
  } catch (e) {
    console.log("[e2e-real] SKIP: buildLlmFromConfig 抛错(凭证/端点不可解析):", String(e));
    return;
  }
  if (!llm) { console.log("[e2e-real] SKIP: buildLlmFromConfig 返回 undefined(未配置 coding 轨模型)"); return; }

  const sid = `e2e-real-${Date.now()}`;
  const journalDir = join(tmpdir(), sid + "-journal");
  console.log("[e2e-real] sid=", sid, "model=", (cfg.config as { coding?: { llm?: { model?: string } } }).coding?.llm?.model);

  const app = createGatewayApp({
    port: 0,
    llm,
    journalDir,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);

  const t0 = Date.now();
  app.taskManager.submit("user", sid, TASK_TEXT);
  const DEADLINE = t0 + 12 * 60_000;
  let state = "(未登记)";
  let taskId = "";
  let timedOut = false;
  while (Date.now() < DEADLINE) {
    const t = app.taskManager.list().find((x) => x.sessionId === sid);
    if (t) {
      taskId = t.id;
      state = t.state;
      if (t.state === "done" || t.state === "failed") break;
    }
    await sleep(1500);
  }
  if (state !== "done" && state !== "failed") timedOut = true;
  const elapsedMs = Date.now() - t0;
  await sleep(6000); // llm-trace 是 fire-and-forget 异步落盘,给尾批时间

  // ---- 机制事件计数(journal;FileJournal sharded 与 .genie/journals/sessions/<sid>.jsonl 同源) ----
  const jcast = app as unknown as { journal?: { readSession(id: string): { kind?: string; payload?: Record<string, unknown>; time?: number }[] } };
  const evs = jcast.journal?.readSession(sid) ?? [];
  const toolCalls = evs.filter((e) => e.kind === "tool.call");
  const countOf = (name: string) => toolCalls.filter((e) => (e.payload as { name?: string } | undefined)?.name === name).length;
  const agentTexts = evs.filter((e) => e.kind === "message.agent")
    .map((e) => String((e.payload as { content?: unknown } | undefined)?.content ?? ""))
    .filter((s) => s.trim().length > 0);

  // ---- llm-trace 指标 ----
  const traceDir = join(root, ".genie", "llm-trace", sid);
  const calls = readTrace(traceDir);
  const usageOf = (c: TraceFile) => c.response?.usage ?? {};
  const inputSum = calls.reduce((s, c) => s + (usageOf(c).inputTokens ?? 0), 0);
  const cachedSum = calls.reduce((s, c) => s + (usageOf(c).cachedTokens ?? 0), 0);
  const outputSum = calls.reduce((s, c) => s + (usageOf(c).outputTokens ?? 0), 0);
  const inputs = calls.map((c) => usageOf(c).inputTokens ?? 0);
  const turns = new Set(calls.map((c) => c.turn)).size;
  const steps = new Set(calls.map((c) => `${c.turn}:${c.step}`)).size;

  // P0-2:同一 turn 内、step 非 0 的相邻两次调用,tools 名称数组变化=翻转
  const namesOf = (c: TraceFile) => (c.tools ?? []).map((x) => x.name).join(",");
  const flips: { turn?: number; from?: string; to?: string; added: string[]; removed: string[] }[] = [];
  for (let i = 1; i < calls.length; i++) {
    const a = calls[i - 1]!; const b = calls[i]!;
    if (a.turn !== b.turn) continue;
    if (!a.step || !b.step) continue;
    const an = (a.tools ?? []).map((x) => x.name); const bn = (b.tools ?? []).map((x) => x.name);
    if (an.join(",") === bn.join(",")) continue;
    flips.push({
      turn: b.turn, from: `t${a.turn}s${a.step}`, to: `t${b.turn}s${b.step}`,
      added: bn.filter((n) => !an.includes(n)), removed: an.filter((n) => !bn.includes(n)),
    });
  }

  // 注入位置:每个请求里 ephemeral 块所在 index
  const injections: { call: string; len: number; hits: { marker: string; index: number }[] }[] = [];
  for (const c of calls) {
    const msgs = c.request?.messages ?? [];
    const hits: { marker: string; index: number }[] = [];
    msgs.forEach((m, idx) => {
      const txt = contentText(m.content);
      for (const mk of MARKERS) if (txt.includes(mk)) hits.push({ marker: mk, index: idx });
    });
    if (hits.length) injections.push({ call: `t${c.turn}s${c.step}`, len: msgs.length, hits });
  }
  const indexOne = injections.flatMap((x) => x.hits).filter((h) => h.index === 1);
  const farFromTail = injections.filter((x) => Math.max(...x.hits.map((h) => h.index)) < x.len - 4);

  const lastAgent = agentTexts.slice(-3).map((s) => s.slice(0, 400));

  const summary = {
    sid, taskId, state, timedOut, elapsedMs,
    model: calls.at(-1)?.model ?? (cfg.config as { coding?: { llm?: { model?: string } } }).coding?.llm?.model,
    llmCalls: calls.length, turns, steps, traceDir,
    tokens: { inputSum, cachedSum, outputSum, cacheHitRate: inputSum ? +(cachedSum / inputSum).toFixed(4) : null, uncached: inputSum - cachedSum },
    inputScale: { p50: p50(inputs), max: Math.max(0, ...inputs), first: inputs[0] ?? 0 },
    toolFlips: { count: flips.length, detail: flips.slice(0, 10) },
    injections: { callsWithBlocks: injections.length, indexOneHits: indexOne, farFromTailCount: farFromTail.length, sample: injections.slice(0, 8) },
    journal: { toolCalls: toolCalls.length, board_read: countOf("board_read"), board_upsert: countOf("board_upsert"), task_phase: countOf("task_phase"), terminal: countOf("terminal"), write_file: countOf("write_file") },
    lastAgent,
  };
  const outPath = join(tmpdir(), sid + "-summary.json");
  try { writeFileSync(outPath, JSON.stringify(summary, null, 1), "utf-8"); } catch { /* 摘要旁路 */ }

  console.log("\n===== E2E-REAL-SUMMARY (json: " + outPath + ") =====");
  console.log(JSON.stringify(summary, null, 1));
  console.log("===== END E2E-REAL-SUMMARY =====\n");
}, 15 * 60_000);