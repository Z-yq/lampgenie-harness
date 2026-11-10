/**
 * Python 边形态深化两形态锚定。
 * ① 工厂赋值类型线索:`x/self.attr = [await] mod.fn(Class, …)`(类作裸实参传给非类调用)→
 *    标识符→类 类型线索,后续 var.method()/self.attr.method() 经既有 receiverType 管线挂边;
 * ② 构造调用边(A3):`Foo(` → `Foo.__init__` 实例化关联(同文件 ast;跨文件候选经
 *    Class.__init__ 候选集解析;类节点既有边不动)。
 * 边界锚定:点前缀静态方法引用不算类实参;歧义实参(≥2 已知类)不猜;类无 __init__ 不造边;
 * 边 schema 零新增字段(旧索引/旧产物向后兼容)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCallGraph } from "../src/callgraph/engine";
import { classify } from "../src/callgraph/c2f";
import { parsePythonFile } from "../src/adapters/python";
import type { FlowEdge } from "../src/callgraph/engine";

async function callerIdsOf(dir: string, targetName: string): Promise<Map<string, string[]>> {
  const graph = await buildCallGraph(dir);
  const out = new Map<string, string[]>();
  for (const [id, sym] of graph.symbols) {
    if (sym.name !== targetName) continue;
    out.set(sym.id, [...new Set((graph.inEdges.get(id) ?? []).map((e) => e.from))]);
  }
  return out;
}

const KNOWN_EDGE_KEYS = new Set(["from", "to", "toName", "file", "line", "tier", "evidenceKind", "receiverType", "moduleHint"]);

describe(" ①工厂赋值类型线索", () => {
  it("self.attr = await asyncio.to_thread(\\n Class,…) 多行形态 → self.attr.method( 挂边(agent_alpha 生产形态)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-fac1-"));
    writeFileSync(join(dir, "chat.py"), [
      "class ChatHandler:",
      "    async def process_chat(self, msg):",
      "        return msg",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "agent.py"), [
      "import asyncio",
      "from chat import ChatHandler",
      "",
      "",
      "class AgentSession:",
      "    async def _do_initialize(self):",
      "        self.chat_handler = await asyncio.to_thread(",
      "            ChatHandler,",
      "            nodes_dir='x',",
      "            cron_enabled=True,",
      "        )",
      "",
      "    async def stream(self):",
      "        async def _relay():",
      "            async for chunk in self.chat_handler.process_chat('m'):",
      "                yield chunk",
      "        await _relay()",
      "",
    ].join("\n"));
    // 候选层单证:工厂赋值给出的类型证据
    const r = await parsePythonFile(dir, join("agent.py"));
    const cand = r.crossFileCandidates?.find((x) => x.toName === "process_chat");
    expect(cand).toBeTruthy();
    expect(cand?.receiverType).toBe("ChatHandler");
    // 全图:跨文件边建立,调用方=嵌套 def(归属所在 def,双 scope 如实)
    const m = await callerIdsOf(dir, "process_chat");
    const entry = [...m.keys()].find((id) => id.includes("chat.py"));
    expect(entry).toBeDefined();
    const callers = m.get(entry!).join(",");
    expect(callers).toContain("_relay");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("裸名单行工厂赋值 handler = to_thread(ChatHandler, u) → handler.method( 挂边", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-fac2-"));
    writeFileSync(join(dir, "chat.py"), [
      "class ChatHandler:",
      "    def process_chat(self, msg):",
      "        return msg",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "worker.py"), [
      "from asyncio import to_thread",
      "from chat import ChatHandler",
      "",
      "",
      "async def handle_turn(text):",
      "    handler = await to_thread(ChatHandler, text)",
      "    return await handler.process_chat(text)",
      "",
    ].join("\n"));
    const m = await callerIdsOf(dir, "process_chat");
    const entry = [...m.entries()].find(([id]) => id.includes("chat.py"));
    expect(entry).toBeDefined();
    expect(entry![1].join(",")).toContain("handle_turn");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("精度守卫:点前缀静态方法引用(BaseHandler._x)不算类实参,后续 frames.x( 不挂边", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-fac3-"));
    writeFileSync(join(dir, "base.py"), [
      "class BaseHandler:",
      "    @staticmethod",
      "    def _apply(state, frames):",
      "        return frames",
      "",
      "    def collect(self):",
      "        return []",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "sess.py"), [
      "import asyncio",
      "from base import BaseHandler",
      "",
      "",
      "class Session:",
      "    async def loop(self, state, frames):",
      "        frames = await asyncio.to_thread(BaseHandler._apply, state, frames)",
      "        return frames.collect()",
      "",
    ].join("\n"));
    const r = await parsePythonFile(dir, join("sess.py"));
    const bad = r.crossFileCandidates?.find((x) => x.toName === "collect" && x.receiverType === "BaseHandler");
    expect(bad).toBeUndefined(); // 首实参是点前缀引用:无类型线索,宁缺勿错
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("歧义实参(≥2 已知类)不猜:x = make(Alpha, Beta) 后 x.run( 不解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-fac4-"));
    writeFileSync(join(dir, "a.py"), [
      "class Alpha:",
      "    def run(self):",
      "        return 'a'",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "b.py"), [
      "class Beta:",
      "    def run(self):",
      "        return 'b'",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "c.py"), [
      "from a import Alpha",
      "from b import Beta",
      "",
      "",
      "def drive():",
      "    x = make(Alpha, Beta)",
      "    return x.run()",
      "",
    ].join("\n"));
    const m = await callerIdsOf(dir, "run");
    for (const [id, callers] of m) {
      if (id.includes("a.py") || id.includes("b.py")) expect(callers).toHaveLength(0);
    }
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe(" ②构造调用边(A3)", () => {
  it("同文件 Foo(:直接 ast 边到 Foo.__init__,类节点既有边不动;__init__ 不再是 trunk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-ctor1-"));
    writeFileSync(join(dir, "dog.py"), [
      "class Dog:",
      "    def __init__(self, name):",
      "        self.name = name",
      "",
      "    def bark(self):",
      "        return self.name",
      "",
      "",
      "def make_dog():",
      "    d = Dog('rex')",
      "    return d.bark()",
      "",
    ].join("\n"));
    const r = await parsePythonFile(dir, "dog.py");
    const initEdge = r.edges.find((e) => e.toName === "__init__");
    expect(initEdge).toBeTruthy();
    expect(initEdge!.to).toBe("dog.py#Dog.__init__");
    expect(initEdge!.from).toContain("make_dog");
    expect(initEdge!.evidenceKind).toBe("ast");
 // entrypoints 纯度:classify 后 __init__ 有具名调用方,不再是 trunk( §2.2 症状)
    const graph = await buildCallGraph(dir);
    const { nodes } = classify(graph, dir);
    const initNode = nodes.find((n) => n.id === "dog.py#Dog.__init__");
    expect(initNode).toBeDefined();
    expect(initNode!.kind).not.toBe("trunk");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("跨文件 import 已知类 Foo(:候选经 Class.__init__ 候选集解析(evidenceKind=index)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-ctor2-"));
    writeFileSync(join(dir, "dog.py"), [
      "class Dog:",
      "    def __init__(self):",
      "        self.name = 'rex'",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "app.py"), [
      "from dog import Dog",
      "",
      "",
      "def boot():",
      "    return Dog()",
      "",
    ].join("\n"));
    const m = await callerIdsOf(dir, "__init__");
    const entry = [...m.entries()].find(([id]) => id.includes("dog.py#Dog.__init__"));
    expect(entry).toBeDefined();
    expect(entry![1].join(",")).toContain("boot");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("类无 __init__(继承 object)不造边;点前缀 mod.Foo( 经模块别名证据补候选", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-ctor3-"));
    writeFileSync(join(dir, "plain.py"), [
      "class Plain:",
      "    pass",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "use.py"), [
      "import plain",
      "",
      "",
      "def make():",
      "    return plain.Plain()",
      "",
    ].join("\n"));
    const r = await parsePythonFile(dir, "use.py");
    expect(r.edges.some((e) => e.toName === "__init__")).toBeFalsy();
    // 点前缀构造:__init__ 不存在(Plain 无定义体)不产候选,但类节点候选照旧(既有行为)
    const m = await callerIdsOf(dir, "Plain");
    const entry = [...m.entries()].find(([id]) => id.includes("plain.py"));
    expect(entry).toBeDefined();
    expect(entry![1].join(",")).toContain("make");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("混合形态(工厂赋值+构造调用同仓):两形态互不干扰,边 schema 零新增字段", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-ctor4-"));
    writeFileSync(join(dir, "chat.py"), [
      "class ChatHandler:",
      "    def __init__(self):",
      "        self.ready = True",
      "",
      "    def process_chat(self, msg):",
      "        return msg",
      "",
      "",
      "def make_direct():",
      "    return ChatHandler()",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "agent.py"), [
      "import asyncio",
      "from chat import ChatHandler",
      "",
      "",
      "class Sess:",
      "    async def init(self):",
      "        self.h = await asyncio.to_thread(",
      "            ChatHandler,",
      "        )",
      "",
      "    async def go(self):",
      "        return await self.h.process_chat('x')",
      "",
    ].join("\n"));
    const pc = await callerIdsOf(dir, "process_chat");
    const pcEntry = [...pc.entries()].find(([id]) => id.includes("chat.py"));
    expect(pcEntry).toBeDefined();
    expect(pcEntry![1].join(",")).toContain("Sess.go");
    const init = await callerIdsOf(dir, "__init__");
    const initEntry = [...init.entries()].find(([id]) => id.includes("chat.py#ChatHandler.__init__"));
    expect(initEntry).toBeDefined();
    expect(initEntry![1].join(",")) // 同文件 make_direct(直构)+ 跨文件 Sess.init(工厂形态不冒充构造,仅 make_direct)
      .toContain("make_direct");
    expect(initEntry![1].join(",")).not.toContain("Sess.init");
    // 边 schema 向后兼容:不出现未知字段(旧索引/旧消费端可读)
    const all: FlowEdge[] = [];
    for (const f of ["chat.py", "agent.py"]) {
      const r = await parsePythonFile(dir, f);
      all.push(...r.edges, ...(r.crossFileCandidates ?? []));
    }
    for (const e of all) {
      for (const k of Object.keys(e)) expect(KNOWN_EDGE_KEYS.has(k)).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
