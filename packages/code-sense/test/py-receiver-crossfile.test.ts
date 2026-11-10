/**
 * A1:Python 接收者形态跨文件方法调用(obj.method)召回修复。
 * 旧形态:RECEIVER 形态整体不发射 + 跨文件候选「全图唯一名」闸对必然同名的方法名静默弃边
 * (三仓评测 R=0/20 注意)。修复后:
 * - self.attr.method(`self.attr = SomeClass(...)` 赋值类型 → Class.method 候选集;
 * - local.method(`svc = ChatService(...)` 函数局部赋值类型(同函数作用域);
 * - 模块别名 mod.func(`import a.b as z` → 文件路径提示收窄;
 * - self.x() 兄弟失败:带 receiverType=所在类(跨文件同类方法/继承形态);
 * - 无类型证据不猜(宁缺勿错);歧义(多类同名方法且无 hint)不解析。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCallGraph } from "../src/callgraph/engine";
import { parsePythonFile } from "../src/adapters/python";

/** 全图构建后查某符号的 caller id 集(跨文件解析完成的最终形态)。 */
async function callerIdsOf(dir: string, targetName: string): Promise<Map<string, string[]>> {
  const graph = await buildCallGraph(dir);
  const out = new Map<string, string[]>();
  for (const [id, sym] of graph.symbols) {
    if (sym.name !== targetName && sym.id !== targetName) continue;
    const callers = (graph.inEdges.get(id) ?? []).map((e) => e.from);
    out.set(sym.id, [...new Set(callers)]);
  }
  return out;
}

describe(" A1:Python 接收者形态跨文件召回", () => {
  it("self.attr.method(:__init__ 赋值类型 → Class.method 候选集解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-recv1-"));
    mkdirSync(join(dir, "core"), { recursive: true });
    mkdirSync(join(dir, "svc"), { recursive: true });
    writeFileSync(join(dir, "core", "registry.py"), [
      "class ComponentRegistry:",
      "    def get_component(self, name):",
      "        return name",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "svc", "runner.py"), [
      "from core.registry import ComponentRegistry",
      "class Runner:",
      "    def __init__(self):",
      "        self.component_registry = ComponentRegistry()",
      "    def do_work(self):",
      "        c = self.component_registry.get_component('x')",
      "        return c",
      "",
    ].join("\n"));
    const m = await callerIdsOf(dir, "get_component");
    const edge = [...m.entries()].find(([, callers]) => callers.length > 0);
    expect(edge).toBeDefined();                     // 跨文件 caller 在(修复前 0)
    expect(edge![0]).toContain("registry.py");      // 目标=ComponentRegistry.get_component
    expect(edge![1][0]).toContain("Runner.do_work"); // 调用方=宿主方法(归属到 def,非 <module>)
    // 候选层单证:receiverType 证据在发射
    const r = await parsePythonFile(dir, join("svc", "runner.py"));
    const cand = r.crossFileCandidates?.find((x) => x.toName === "get_component");
    expect(cand?.receiverType).toBe("ComponentRegistry");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("local.method(:函数局部赋值类型(同函数作用域)→ 跨文件解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-recv2-"));
    writeFileSync(join(dir, "chat.py"), [
      "class ChatHandler:",
      "    def process_chat(self, msg):",
      "        return msg",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "agent.py"), [
      "from chat import ChatHandler",
      "def handle_turn(text):",
      "    svc = ChatHandler()",
      "    return svc.process_chat(text)",
      "",
    ].join("\n"));
    const m = await callerIdsOf(dir, "process_chat");
    const edge = [...m.entries()].find(([, callers]) => callers.length > 0);
    expect(edge).toBeDefined();
    expect(edge![1][0]).toContain("handle_turn");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("模块别名 mod.func(:import a.b as z → 文件路径提示收窄到唯一符号", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-recv3-"));
    mkdirSync(join(dir, "services"), { recursive: true });
    writeFileSync(join(dir, "services", "life_script_models.py"), [
      "def generate_object_id():",
      "    return 'id'",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "object_manager.py"), [
      "import services.life_script_models as lsm",
      "def create_object():",
      "    return lsm.generate_object_id()",
      "",
    ].join("\n"));
    const m = await callerIdsOf(dir, "generate_object_id");
    const edge = [...m.entries()].find(([, callers]) => callers.length > 0);
    expect(edge).toBeDefined();
    expect(edge![1][0]).toContain("create_object");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("DI 形态:self.attr = param(参数 hint)/ self.attr = param or Class()(agent_alpha 主流形态)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-recv6-"));
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, "core", "component_registry.py"), [
      "class ComponentRegistry:",
      "    def get_component(self, name):",
      "        return name",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "core", "node_executor.py"), [
      "from .component_registry import ComponentRegistry",
      "class NodeExecutor:",
      "    def __init__(self, component_registry: Optional[ComponentRegistry] = None):",
      "        self.component_registry = component_registry or ComponentRegistry()",
      "    def _get_builtin_action_configs(self):",
      "        component = self.component_registry.get_component('builtin')",
      "        return component",
      "",
    ].join("\n"));
    const m = await callerIdsOf(dir, "get_component");
    const edge = [...m.entries()].find(([, callers]) => callers.length > 0);
    expect(edge).toBeDefined();
    expect(edge![1][0]).toContain("NodeExecutor._get_builtin_action_configs");
    // 别名形态单独锚定:self.attr = param(纯参数赋值,类型来自 hint)
    const dir2 = mkdtempSync(join(tmpdir(), "gh-py-recv7-"));
    writeFileSync(join(dir2, "reg.py"), [
      "class Registry:",
      "    def lookup(self, key):",
      "        return key",
      "",
    ].join("\n"));
    writeFileSync(join(dir2, "svc.py"), [
      "from reg import Registry",
      "class Svc:",
      "    def __init__(self, registry: Registry):",
      "        self.reg = registry",
      "    def work(self):",
      "        return self.reg.lookup('k')",
      "",
    ].join("\n"));
    const m2 = await callerIdsOf(dir2, "lookup");
    const edge2 = [...m2.entries()].find(([, callers]) => callers.length > 0);
    expect(edge2).toBeDefined();
    expect(edge2![1][0]).toContain("Svc.work");
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }, 60_000);

  it("歧义不解析:两个类同名方法、无 hint → 保持无跨文件边(宁缺勿错,不虚报)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-recv4-"));
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
 // 调用方拿不到类型证据(参数透传形态):x = make; x.run(无赋值构造
    writeFileSync(join(dir, "c.py"), [
      "def drive(x):",
      "    return x.run()",
      "",
    ].join("\n"));
    const m = await callerIdsOf(dir, "run");
    for (const [, callers] of m) expect(callers).toHaveLength(0); // 两定义都无 caller(不猜)
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("self.x() 兄弟失败带 receiverType(跨文件同类方法);同文件兄弟边不回退", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-recv5-"));
    writeFileSync(join(dir, "base.py"), [
      "class Worker:",
      "    def shared_setup(self):",
      "        return 1",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "sub.py"), [
      "class Worker:" + "  # 同名类(另一文件,模拟 mixin/复制形态)",
      "    def go(self):",
      "        return self.shared_setup()",
      "",
    ].join("\n"));
    const r = await parsePythonFile(dir, "sub.py");
    const selfMiss = r.edges.find((e) => e.toName === "shared_setup");
    expect(selfMiss).toBeDefined();
    expect(selfMiss?.to).toBe("");                    // 同文件无兄弟
    expect(selfMiss?.receiverType).toBe("Worker");    // 带 receiverType 证据给 merge 层
    const m = await callerIdsOf(dir, "shared_setup");
    const hit = [...m.values()].some((callers) => callers.length > 0);
    expect(hit).toBe(true);                           // merge 按 Class.method 候选集解析成功
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
