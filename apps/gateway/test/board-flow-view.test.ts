/**
 * board.fromsense source=decision(控制流板)端到端:
 * 点一个符号 → 板上看到它的**条件/循环**真分支树(decision.ts 的 DecisionPoint[] → decisionsBoard)。
 *
 * 四条主线(与任务书验收一一对应):
 *  ① 真实源文件 + 函数名 → 节点 flow 非空且同时含 branch 与 loop(空壳/假树会红);
 *  ② 同内容重复请求 → 同一 taskId、rev 递增(fail-soft 覆盖前的「内容寻址」语义);
 *  ③ 换函数(等于换内容指纹)→ taskId 变化(旧图自然失效,不手工清理);
 *  ④ 无分支点 / 扫描失败 → 单节点「无分支点」板,不抛错;缺定位参数 → 明确错误文案。
 *
 * 落盘纪律:全程 GENIE_REPO_ROOT=临时目录(夹具源文件也在临时目录里),绝不写真实仓 .genie/boards。
 * 夹具源=仓内真实文件 packages/code-sense/src/sensing/decision.ts 的副本(真 if/while/for,不是手写小样)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { loadBoard, listBoards } from "../src/board-store.js";
import { repoRoot } from "../src/repo-root.js";
import type { BoardDoc, BoardFlowStep } from "@lampgenie/protocol";

// 先取真实仓根(临时根必须在 import 之后、装配之前钉进 env)
const REAL_ROOT = repoRoot();
const TMP_ROOT = mkdtempSync(join(tmpdir(), "gh-flow-view-"));
const OLD_ROOT = process.env.GENIE_REPO_ROOT;
process.env.GENIE_REPO_ROOT = TMP_ROOT;

const SID = "vitest-flow-view";

/** flow 树里的类型集合(递归;branch=条件,loop=循环)。 */
function flowTypes(steps: BoardFlowStep[], out = new Set<string>()): Set<string> {
  for (const s of steps) {
    out.add(s.type);
    for (const kid of [s.then, s.else, s.body]) if (kid && kid.length) flowTypes(kid, out);
  }
  return out;
}

describe("board.fromsense source=decision(控制流板:符号 → 条件/循环真分支树)", () => {
  let app: GatewayApp | null = null;
  let server: Server | null = null;
  let ws: WebSocket | null = null;
  let port = 0;
  const inbox: Record<string, unknown>[] = [];

  const send = (payload: Record<string, unknown>): void => {
    ws!.send(JSON.stringify({ v: 1, ...payload }));
  };
  /** 从 cursor 起等一条匹配帧(与 board.test.ts 同款轮询;drvfs 高载下放宽到 20s)。 */
  const waitFor = (
    pred: (m: Record<string, unknown>) => boolean, cursor: number, tag: string, ms = 20000,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("等消息超时 " + tag)), ms);
      const poll = setInterval(() => {
        const hit = inbox.slice(cursor).find(pred);
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
      }, 30);
    });

  /** 发一条 decision 请求,返回该板的 taskId + doc(回执先于广播,按 cursor 取本次的那一条)。 */
  const fromSenseDecision = async (
    params: Record<string, unknown>, tag: string,
  ): Promise<{ taskId: string; doc: BoardDoc }> => {
    const cursor = inbox.length;
    send({ type: "board.fromsense", sessionId: SID, source: "decision", ...params });
    const m = await waitFor((mm) => mm.type === "board.doc" || mm.type === "error", cursor, tag);
    expect(m.type, "意外错误回包: " + JSON.stringify(m).slice(0, 300)).toBe("board.doc");
    expect(m.sessionId).toBe(SID);
    expect(typeof m.taskId).toBe("string");
    return { taskId: m.taskId as string, doc: m.doc as BoardDoc };
  };

  beforeAll(async () => {
    // 夹具:真实文件副本(真 if/else/while/for)+ 一个无分支文件(④)
    mkdirSync(join(TMP_ROOT, "src"), { recursive: true });
    const realFile = join(REAL_ROOT, "packages/code-sense/src/sensing/decision.ts");
    expect(existsSync(realFile), "夹具源文件存在(仓内真实 decision.ts)").toBe(true);
    copyFileSync(realFile, join(TMP_ROOT, "src", "decision.ts"));
    writeFileSync(join(TMP_ROOT, "src", "flat.ts"), "export const FLAT = 1;\nexport function noBranch(x: number) {\n  return x + 1;\n}\n", "utf-8");

    app = createGatewayApp({ port: 0, useExternalHttp: true, journalDir: undefined });
    server = createServer();
    await new Promise<void>((r) => server!.listen(0, r));
    port = (server.address() as AddressInfo).port;
    app.attachWs(server);
    ws = new WebSocket("ws://127.0.0.1:" + port);
    ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws!.on("open", r));
  }, 60000);

  afterAll(async () => {
    try { ws?.close(); } catch { /* 已断 */ }
    await app?.close();
    app = null;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
    if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = OLD_ROOT;
    try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  });

  it("① 真实源文件+函数名 → 节点 flow 非空且同时含 branch 与 loop", async () => {
    const { taskId, doc } = await fromSenseDecision({ file: "src/decision.ts", fn: "normCond" }, "case1");
    // 单函数 → 一个 function 节点,flow 就是该函数的条件/循环树
    expect(doc.nodes).toHaveLength(1);
    const node = doc.nodes[0]!;
    expect(node.kind).toBe("function");
    expect(node.label).toBe("normCond");
    expect(node.flow.length).toBeGreaterThan(0);
    const types = flowTypes(node.flow);
    expect(types.has("branch"), "有 branch(if/else 树):" + [...types].join(",")).toBe(true);
    expect(types.has("loop"), "有 loop(while/for):" + [...types].join(",")).toBe(true);
    // summary 的分支/循环计数来自真实点(不是常量文案)
    expect(node.summary).toMatch(/控制流:if×\d+ \/ loop×\d+/);
    expect(doc.docKind).toBe("design");
    expect(doc.taskId).toBe(taskId);
    expect(taskId.startsWith("decision-")).toBe(true);
    // 落盘在临时根内(绝不在真实仓)
    expect(existsSync(join(TMP_ROOT, ".genie", "boards", SID, taskId + ".json"))).toBe(true);
    expect(loadBoard(TMP_ROOT, SID, taskId)?.nodes[0]?.flow.length).toBe(node.flow.length);
  }, 60000);

  it("② 同内容再请求 → 同一 taskId、rev 递增(评论/版面续接),板数不膨胀", async () => {
    const first = await fromSenseDecision({ file: "src/decision.ts", fn: "renderDecisionSkeleton" }, "case2-a");
    const second = await fromSenseDecision({ file: "src/decision.ts", fn: "renderDecisionSkeleton" }, "case2-b");
    expect(second.taskId).toBe(first.taskId); // 内容寻址:同内容=同板
    expect(second.doc.rev).toBe(first.doc.rev + 1); // rev 续接递增
    expect(second.doc.nodes.map((n) => n.id)).toEqual(first.doc.nodes.map((n) => n.id)); // 节点 id 稳定=评论可续
    const boards = listBoards(TMP_ROOT, SID).filter((i) => i.taskId.startsWith("decision-"));
    const same = boards.filter((i) => i.taskId === first.taskId);
    expect(same.length, "同一 taskId 只落一块板").toBe(1);
    // 同内容第三次:依然同一块板,rev 继续涨
    const third = await fromSenseDecision({ file: "src/decision.ts", fn: "renderDecisionSkeleton" }, "case2-c");
    expect(third.taskId).toBe(first.taskId);
    expect(third.doc.rev).toBe(first.doc.rev + 2);
  }, 60000);

  it("③ 换函数(=内容指纹变)→ taskId 变,旧板仍在(过期图不手工清理)", async () => {
    const a = await fromSenseDecision({ file: "src/decision.ts", fn: "normCond" }, "case3-a");
    const b = await fromSenseDecision({ file: "src/decision.ts", fn: "familyOf" }, "case3-b");
    expect(b.taskId).not.toBe(a.taskId);
    // 内容指纹也参与 key:同名函数但源文件不同(副本内容一致→同指纹,故用另一文件验证路径入 key)
    const c = await fromSenseDecision({ file: "src/flat.ts", fn: "noBranch" }, "case3-c");
    expect(c.taskId).not.toBe(b.taskId);
    // 旧板未被删(自动失效=不命中新 key,而非销毁证据)
    expect(loadBoard(TMP_ROOT, SID, a.taskId)).not.toBeNull();
    expect(loadBoard(TMP_ROOT, SID, b.taskId)).not.toBeNull();
  }, 60000);

  it("④ 无分支点 / 扫描失败 → 单节点「无分支点」板,不抛错", async () => {
    // 4a 真无分支的文件:scan 成功但 points=[]
    const flat = await fromSenseDecision({ file: "src/flat.ts", fn: "noBranch" }, "case4-flat");
    expect(flat.doc.nodes).toHaveLength(1);
    expect(flat.doc.nodes[0]!.summary).toContain("无分支点");
    expect(flat.doc.nodes[0]!.flow).toEqual([]);
    expect(flat.doc.edges).toEqual([]);
    // 4b 扫描失败(文件不存在)→ scanDecisionFile 返回 null,仍出单节点板(fail-soft,不打挂 fromsense)
    const missing = await fromSenseDecision({ file: "src/no-such-file.ts" }, "case4-missing");
    expect(missing.doc.nodes).toHaveLength(1);
    expect(missing.doc.nodes[0]!.summary).toContain("无分支点");
    expect(missing.doc.title).toContain("读不到"); // 原因写进标题,不静默
  }, 60000);

  it("⑤ 缺定位参数 → 明确错误文案(不静默返回空板)", async () => {
    const cursor = inbox.length;
    send({ type: "board.fromsense", sessionId: SID, source: "decision" });
    const m = await waitFor((mm) => mm.type === "error" || mm.type === "board.doc", cursor, "case5");
    expect(m.type).toBe("error");
    expect(m.code).toBe("board-fromsense-failed");
    expect(String(m.message)).toContain("定位参数");
  }, 30000);
});