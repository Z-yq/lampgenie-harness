/**
 * 错误路径定向剪枝对 deriveMessages 的端到端契约:
 * - 声明(context.path.abandoned)之前的命中结果 → 折叠为占位(原因+原文头+寻址);
 * - 声明点位注入 [系统提醒] 教训;声明之后的新结果不受影响;
 * - 保护:edit/write 回执永不折;声明前最近 keepRecent 个结果豁免;
 * - 选择器:tools 精确 + keywords 任意命中(name/args/内容头);都给=AND;全空声明整条丢弃;
 * - 无声明 = 旧行为逐字不变;compact.done 边界照旧硬截断(边界后的声明作用于其后结果)。
 * 真 MemoryJournal,不 mock——断言用 append 返回的 seq。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { deriveMessages } from "../src/agent/loop";
import { collectPathAbandons, matchesDeclaration, renderAbandonedPlaceholder, PATH_ABANDONED_TYPE } from "../src/agent/path-prune";

const SID = "prune-1";
type J = InstanceType<typeof MemoryJournal>;

function user(j: J, text: string): number {
  return j.append({ kind: "message.user", sessionId: SID, payload: { text } }).seq;
}

function toolCall(j: J, id: string, name: string, args: string): number {
  return j.append({ kind: "tool.call", sessionId: SID, payload: { toolCallId: id, name, arguments: args, turn: 1, step: 1 } }).seq;
}

function toolResult(j: J, id: string, content: string): number {
  return j.append({ kind: "tool.result", sessionId: SID, payload: { toolCallId: id, content } }).seq;
}

function agentToolCalls(j: J, calls: Array<{ id: string; name: string; args: string }>, text = ""): number {
  return j.append({
    kind: "message.agent",
    sessionId: SID,
    payload: { text, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args, type: "function" })) },
  }).seq;
}

function abandon(
  j: J,
  over: { reason: string; lesson?: string; tools?: string[]; keywords?: string[]; keepRecent?: number },
): number {
  return j.append({
    kind: "custom",
    sessionId: SID,
    payload: { type: PATH_ABANDONED_TYPE, ...over },
  }).seq;
}

/** derive 后的 tool 消息按 toolCallId 索引。 */
function toolMessages(j: J): Map<string, string> {
  const m = new Map<string, string>();
  for (const msg of deriveMessages(j, SID)) {
    if (msg.role === "tool" && typeof (msg as { toolCallId?: string }).toolCallId === "string") {
      m.set((msg as { toolCallId: string }).toolCallId, String(msg.content));
    }
  }
  return m;
}

describe("A. 基本契约:命中折叠 + 教训注入 + 声明后新结果不受影响", () => {
  it("docker 路径的三条大输出折叠,正确路径的保留", () => {
    const j = new MemoryJournal();
    user(j, "用 docker 起数据库");
    agentToolCalls(j, [{ id: "t1", name: "run_cmd", args: '{"command":"docker-compose up -d"}' }]);
    toolCall(j, "t1", "run_cmd", '{"command":"docker-compose up -d"}');
    toolResult(j, "t1", "ERROR: docker-compose 报错 ".repeat(200)); // ~4.6K 字
    agentToolCalls(j, [{ id: "t2", name: "run_cmd", args: '{"command":"docker ps"}' }]);
    toolCall(j, "t2", "run_cmd", '{"command":"docker ps"}');
    toolResult(j, "t2", "CONTAINER ID ... ".repeat(150));
    agentToolCalls(j, [{ id: "t3", name: "run_cmd", args: '{"command":"docker-compose logs"}' }]);
    toolCall(j, "t3", "run_cmd", '{"command":"docker-compose logs"}');
    toolResult(j, "t3", "postgres logs ... ".repeat(120));
 // 正确路径:本机 postgres
    agentToolCalls(j, [{ id: "t4", name: "read_file", args: '{"path":"/etc/postgresql/postgresql.conf"}' }]);
    toolCall(j, "t4", "read_file", '{"path":"/etc/postgresql/postgresql.conf"}');
    toolResult(j, "t4", "listen_addresses = 'localhost' ...".repeat(50));
 // keepRecent=0:全部命中可折(默认 3 会豁免最近三条)
    abandon(j, { reason: "docker 方案在 WSL 下起不来", lesson: "改用本机 postgres", keywords: ["docker"], keepRecent: 0 });
 // 声明后新结果
    agentToolCalls(j, [{ id: "t5", name: "run_cmd", args: '{"command":"psql -c status"}' }]);
    toolCall(j, "t5", "run_cmd", '{"command":"psql -c status"}');
    const s5 = toolResult(j, "t5", "psql ok 声明后的新输出".repeat(10));

    const tools = toolMessages(j);
    expect(tools.get("t1")).toContain("路径已放弃");
    expect(tools.get("t1")).toContain("docker 方案在 WSL 下起不来");
    expect(tools.get("t1")).toContain("toolCallId=t1");
    expect(tools.get("t2")).toContain("路径已放弃");
    expect(tools.get("t3")).toContain("路径已放弃");
    expect(tools.get("t4")).not.toContain("路径已放弃"); // 正确路径不动
    expect(tools.get("t4")).toContain("listen_addresses");
    expect(tools.get("t5")).not.toContain("路径已放弃"); // 声明后的新结果
    expect(tools.get("t5")).toContain("声明后的新输出");
 // 折叠显著短于原文
    expect(tools.get("t1")!.length).toBeLessThan(600);
 // 教训提醒注入在声明点位
    const texts = deriveMessages(j, SID).map((m) => String(m.content));
    const reminder = texts.find((t) => t.includes("[路径已放弃] docker 方案"));
    expect(reminder).toBeTruthy();
    expect(reminder).toContain("教训:改用本机 postgres");
    expect(s5).toBeGreaterThan(0);
  });
});

describe("B. 保护:不可逆回执 + keepRecent 豁免", () => {
  it("edit_file 命中关键词也永不折;默认 keepRecent=3 豁免最近三个结果", () => {
    const j = new MemoryJournal();
    user(j, "迁移配置到 docker 卷");
    const ids = ["e1", "r1", "r2", "r3", "r4", "r5"];
 // e1 是 edit_file 回执(内容含 docker 关键词)
    agentToolCalls(j, [{ id: "e1", name: "edit_file", args: '{"path":"docker-compose.yml"}' }]);
    toolCall(j, "e1", "edit_file", '{"path":"docker-compose.yml"}');
    toolResult(j, "e1", "<edited docker-compose.yml lines=1-10> ".repeat(100));
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) {
      agentToolCalls(j, [{ id, name: "run_cmd", args: `{"command":"docker inspect ${id}"}` }]);
      toolCall(j, id, "run_cmd", `{"command":"docker inspect ${id}"}`);
      toolResult(j, id, `docker output ${id} `.repeat(80));
    }
    abandon(j, { reason: "docker 卷迁移方案错", keywords: ["docker"] }); // keepRecent 缺省 3
    const tools = toolMessages(j);
    expect(tools.get("e1")).not.toContain("路径已放弃"); // 不可逆保护
    expect(tools.get("e1")).toContain("<edited");
    expect(tools.get("r1")).toContain("路径已放弃"); // 早的折
    expect(tools.get("r2")).toContain("路径已放弃");
    expect(tools.get("r3")).not.toContain("路径已放弃"); // 最近 3 个豁免
    expect(tools.get("r4")).not.toContain("路径已放弃");
    expect(tools.get("r5")).not.toContain("路径已放弃");
  });
});

describe("C. 选择器语义", () => {
  it("tools 与 keywords 都给=AND;全空声明丢弃;匹配纯函数直测", () => {
    const j = new MemoryJournal();
    user(j, "x");
    agentToolCalls(j, [{ id: "a", name: "terminal", args: '{"command":"npm run build"}' }]);
    toolCall(j, "a", "terminal", '{"command":"npm run build"}');
    toolResult(j, "a", "build failed ".repeat(150));
    agentToolCalls(j, [{ id: "b", name: "run_cmd", args: '{"command":"npm run build"}' }]);
    toolCall(j, "b", "run_cmd", '{"command":"npm run build"}');
    toolResult(j, "b", "build failed ".repeat(150));
    abandon(j, { reason: "build 路径错", tools: ["terminal"], keywords: ["npm run build"], keepRecent: 0 });
    const tools = toolMessages(j);
    expect(tools.get("a")).toContain("路径已放弃"); // terminal + 关键词命中
    expect(tools.get("b")).not.toContain("路径已放弃"); // run_cmd 不在 tools
 // 全空声明:collect 丢弃
    abandon(j, { reason: "无选择器" });
    const decls = collectPathAbandons(j.readAll(), SID);
    expect(decls.length).toBe(1); // 只有带选择器那条
 // 纯函数:matchesDeclaration(AND 语义:工具名过了还要关键词命中)
    const d = decls[0]!;
    expect(matchesDeclaration(d, { name: "terminal", arguments: '{"command":"npm run build"}' }, "")).toBe(true);
    expect(matchesDeclaration(d, { name: "terminal", arguments: "x" }, "")).toBe(false); // 关键词未命中
    expect(matchesDeclaration(d, { name: "run_cmd", arguments: '{"command":"npm run build"}' }, "")).toBe(false); // 工具名未过
  });
});

describe("D. 无声明/坏声明 = 旧行为逐字不变", () => {
  it("无声明:全部原文;reason 空白的声明整条丢弃", () => {
    const j = new MemoryJournal();
    user(j, "t");
 // 孤儿 tool.result(无在前 assistant 认领)会被 derive 丢弃(既有 provider 兼容行为)——补上 assistant。
    agentToolCalls(j, [{ id: "t1", name: "run_cmd", args: '{"command":"ls"}' }]);
    toolCall(j, "t1", "run_cmd", '{"command":"ls"}');
    toolResult(j, "t1", "file_a file_b ".repeat(100));
    const before = toolMessages(j).get("t1");
    expect(before).toContain("file_a"); // 基线:原文在
    abandon(j, { reason: "   ", keywords: ["ls"] }); // 空白 reason → 丢弃
    const after = toolMessages(j).get("t1");
    expect(after).toBe(before);
    expect(collectPathAbandons(j.readAll(), SID).length).toBe(0);
  });
});

describe("E0. fromSeq 起始锚点(v1.1:失败区间起点显式钉死)", () => {
  it("锚点之前同关键词的命中结果不折;锚点起(含)照常折", () => {
    const j = new MemoryJournal();
    user(j, "先成功用过一次 docker,后来错误路径又用");
 // 早期成功路径(docker 同关键词,但不应被折)
    agentToolCalls(j, [{ id: "early", name: "run_cmd", args: '{"command":"docker pull alpine"}' }]);
    toolCall(j, "early", "run_cmd", '{"command":"docker pull alpine"}');
    const earlySeq = toolResult(j, "early", "docker 早期成功输出 ".repeat(80)).valueOf();
 // 中间无关
    agentToolCalls(j, [{ id: "mid", name: "read_file", args: '{"path":"README.md"}' }]);
    toolCall(j, "mid", "read_file", '{"path":"README.md"}');
    const midSeq = toolResult(j, "mid", "readme 内容 ".repeat(40)).valueOf();
 // 失败路径
    agentToolCalls(j, [{ id: "bad1", name: "run_cmd", args: '{"command":"docker-compose up"}' }]);
    toolCall(j, "bad1", "run_cmd", '{"command":"docker-compose up"}');
    const bad1Seq = toolResult(j, "bad1", "docker 失败输出 ".repeat(90)).valueOf();
    abandon(j, { reason: "docker 方案错", keywords: ["docker"], keepRecent: 0, fromSeq: bad1Seq });
    const tools = toolMessages(j);
    expect(tools.get("early")).not.toContain("路径已放弃"); // 锚点之前——同关键词也不折
    expect(tools.get("early")).toContain("早期成功输出");
    expect(tools.get("mid")).not.toContain("路径已放弃");
    expect(tools.get("bad1")).toContain("路径已放弃"); // 锚点起照常
    expect(earlySeq).toBeGreaterThan(0);
    expect(midSeq).toBeGreaterThan(earlySeq);
  });
});

describe("E. compact.done 边界与多声明", () => {
  it("压缩边界清掉边界前消息(占位与提醒随之消失);边界后的声明照常作用于其后结果", () => {
    const j = new MemoryJournal();
    user(j, "u1");
    toolCall(j, "t1", "run_cmd", '{"command":"grep foo"}');
    toolResult(j, "t1", "foo bar ".repeat(200));
    j.append({
      kind: "compact.done",
      sessionId: SID,
      payload: { summary: "此前已完成探索。", tail: [] },
    });
 // 边界后的错误路径
    agentToolCalls(j, [{ id: "t2", name: "run_cmd", args: '{"command":"grep baz"}' }]);
    toolCall(j, "t2", "run_cmd", '{"command":"grep baz"}');
    toolResult(j, "t2", "baz qux ".repeat(200));
    abandon(j, { reason: "grep baz 方向错", keywords: ["baz"], keepRecent: 0 });
    const msgs = deriveMessages(j, SID);
    const texts = msgs.map((m) => String(m.content));
    expect(texts.some((t) => t.includes("foo bar"))).toBe(false); // 边界前被硬截断
    const tools = new Map<string, string>();
    for (const m of msgs) if (m.role === "tool") tools.set((m as { toolCallId: string }).toolCallId, String(m.content));
    expect(tools.get("t2")).toContain("路径已放弃"); // 边界后声明照常生效
 // 占位渲染纯函数直测:多行形态
    const decl = collectPathAbandons(j.readAll(), SID)[0]!;
    const ph = renderAbandonedPlaceholder(decl, "t2", "baz qux ".repeat(50));
    expect(ph).toContain("原因:grep baz 方向错");
    expect(ph.split("\n").length).toBeGreaterThanOrEqual(3);
  });
});
