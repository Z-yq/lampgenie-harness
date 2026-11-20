/**
 * 测试(096 评测缺口):
 * ① RC-B4 链式构造调用 `X(...).method(` 的方法边发射(redash queries.py 形态锚定:
 *    `QuerySerializer(...).serialize()` → serialize 的调用方 + serialize_query 的 d2 上游);
 * ② 属性拷贝类型证据 `chat_handler = session.chat_handler` → `chat_handler.process_chat(`
 *    跨文件召回(agent_alpha process_chat R=0.5 漏报形态锚定);
 * ③ 猜错零假边:无对应类/方法的命名约定推断被 merge 双闸丢弃;
 * ④ 边界:多行实参链式构造不发射(单行形态才覆盖);self 属性构造器链不猜。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCallGraph } from "../src/callgraph/engine";
import { buildC2fIndex } from "../src/callgraph/c2f";
import { queryImpact } from "../src/callgraph/impact";
import { parsePythonFile } from "../src/adapters/python";

function mkWs(): string {
  return mkdtempSync(join(tmpdir(), "cs-chain-"));
}

/** 全图构建后,target 符号的调用方 id 集(跨文件解析完成的最终形态)。 */
async function callerIdsOf(dir: string, targetName: string): Promise<string[]> {
  const graph = await buildCallGraph(dir);
  const out: string[] = [];
  for (const [id, sym] of graph.symbols) {
    if (sym.name !== targetName && sym.id !== targetName) continue;
    for (const e of graph.inEdges.get(id) ?? []) out.push(e.from);
  }
  return [...new Set(out)];
}

describe(" RC-B4:Python 链式构造调用发射", () => {
  it("X(...).method( 单行形态:方法边发射(构造边既有路径外的新召回)", async () => {
    const dir = mkWs();
    mkdirSync(join(dir, "serializers"), { recursive: true });
    mkdirSync(join(dir, "handlers"), { recursive: true });
    // redash serializers/__init__.py 形态:QuerySerializer.serialize() 调 serialize_query
    writeFileSync(join(dir, "serializers", "__init__.py"), [
      "class QuerySerializer:",
      "    def __init__(self, object_or_list, **options):",
      "        self.object_or_list = object_or_list",
      "        self.options = options",
      "    def serialize(self):",
      "        return serialize_query(self.object_or_list, **self.options)",
      "",
      "def serialize_query(obj, **opts):",
      "    return {}",
      "",
    ].join("\n"));
    // redash handlers/queries.py 形态:链式构造+方法调用(096 评测漏报的 queries API 族)
    writeFileSync(join(dir, "handlers", "queries.py"), [
      "from serializers import QuerySerializer",
      "",
      "def get_query_list():",
      "    results = []",
      "    return QuerySerializer(results, with_user=False).serialize()",
      "",
      "def get_query_detail(q):",
      "    return QuerySerializer(q, with_visualizations=True).serialize()",
      "",
    ].join("\n"));
    // 锚 1:adapter 候选层——链式方法边带 receiverType=QuerySerializer 发射
    const r = await parsePythonFile(dir, join("handlers", "queries.py"));
    const cands = (r.crossFileCandidates ?? []).filter((x) => x.toName === "serialize");
    expect(cands.length).toBe(2); // 两个调用点各一条(first-wins 去重键含行内形态区别——逐方法一条×2 函数)
    expect(cands[0]!.receiverType).toBe("QuerySerializer");
    // 锚 2:merge 后 serialize 拿到 handlers 的两个调用方(修复前 0)
    const callers = await callerIdsOf(dir, "serialize");
    expect(callers.some((c) => c.includes("queries.py#get_query_list"))).toBe(true);
    expect(callers.some((c) => c.includes("queries.py#get_query_detail"))).toBe(true);
    // 锚 3:impact 面——serialize_query 的 d2 闭包补出 handlers 调用方(096 验收点)
    const index = await buildC2fIndex(dir);
    const impact = queryImpact(index, "serialize_query", { depth: 2 });
    const callersD2 = impact.definitions[0]!.callers.map((c) => `${c.name}@d${c.depth}`);
    expect(callersD2).toContain("QuerySerializer.serialize@d1");
    expect(callersD2).toContain("get_query_list@d2");
    expect(callersD2).toContain("get_query_detail@d2");
    rmSync(dir, { recursive: true, force: true });
  });

  it("边界:多行实参/非类小写调用/self 属性构造器均不发射", async () => {
    const dir = mkWs();
    writeFileSync(join(dir, "a.py"), [
      "class Foo:",
      "    def bar(self):",
      "        return 1",
      "",
      "def make(x):",
      "    return x",
      "",
      "def use():",
      "    a = Foo(",
      "        1,",
      "    ).bar()  # 多行实参:链式扫描不覆盖(诚实边界)",
      "    b = make(1).upper()  # 小写非类:不猜",
      "    return a",
      "",
      "def use2(self):",
      "    return self.Foo(1).bar()  # self 属性构造器链:类型未知不猜",
      "",
    ].join("\n"));
    const r = await parsePythonFile(dir, "a.py");
    // 多行构造 `Foo(` 的构造边(__init__ 候选)可有可无,但链式方法边 bar 不得由链式扫描发射
    const chainCands = (r.crossFileCandidates ?? []).filter((x) => x.toName === "bar");
    expect(chainCands.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Python 属性拷贝类型证据(process_chat 形态)", () => {
  it("chat_handler = session.chat_handler → chat_handler.process_chat( 跨文件解析", async () => {
    const dir = mkWs();
    mkdirSync(join(dir, "modules"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "modules", "chat_handler.py"), [
      "class ChatHandler:",
      "    def __init__(self):",
      "        pass",
      "    def process_chat(self, session_id, query):",
      "        yield query",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "modules", "service.py"), [
      "from modules.chat_handler import ChatHandler",
      "",
      "class AgentSession:",
      "    def __init__(self):",
      "        self.chat_handler = ChatHandler()",
      "",
    ].join("\n"));
    // agent_alpha 三个漏报测试文件的共同形态(096 评测 R=0.5 的另一半)
    writeFileSync(join(dir, "tests", "test_music_mode.py"), [
      "from modules.service import AgentSession",
      "",
      "def test_music():",
      "    session = AgentSession()",
      "    chat_handler = session.chat_handler",
      "    for chunk in chat_handler.process_chat(",
      "        's1', 'q'):",
      "        pass",
      "",
    ].join("\n"));
    const callers = await callerIdsOf(dir, "process_chat");
    expect(callers.some((c) => c.includes("test_music_mode.py#test_music"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("猜错零假边:命名约定推断无匹配类时被 merge 闸丢弃", async () => {
    const dir = mkWs();
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests", "test_x.py"), [
      "def real_target():",
      "    return 1",
      "",
      "def test_y(engine):",
      "    robot_arm = engine.robot_arm   # RobotArm 类不存在于仓内",
      "    robot_arm.real_target()        # 候选 receiverType=RobotArm 无匹配 → 丢弃",
      "",
    ].join("\n"));
    const callers = await callerIdsOf(dir, "real_target");
    // RobotArm 不存在 → 候选被双闸丢弃;real_target 不被假边污染
    expect(callers.some((c) => c.includes("test_y"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
