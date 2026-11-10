import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJavaFile } from "../src/adapters/java";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";

const JAVA_SRC = [
  "package demo;",
  "",
  "import java.util.List;",
  "",
  "public class OrderService {",
  "    private final Repo repo; // 括号 { 出现在注释不破深度",
  "",
  "    public OrderService(Repo repo) {",
  "        this.repo = repo;",
  "    }",
  "",
  "    public Order place(OrderRequest req) throws Exception {",
  '        String tpl = "body { } } not depth";',
  "        char brace = '{';",
  "        /* 块注释 { 也不算",
  "           跨行 } 继续 */",
  "        if (req == null) {",
  '            throw new IllegalArgumentException("bad } char");',
  "        }",
  "        return this.save(tpl, req);",
  "    }",
  "",
  "    private Order save(String tpl, OrderRequest req) {",
  "        return new Order(req);",
  "    }",
  "}",
  "",
  "interface Repo {",
  "    Order find(String id); // 抽象方法(无体)也登记",
  "}",
];

function javaFixture(): { dir: string; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-java-"));
  writeFileSync(join(dir, "OrderService.java"), JAVA_SRC.join("\n") + "\n");
  return { dir, rel: "OrderService.java" };
}

// 行号断言基准:fixture 按行数组构造,行号=索引+1(元素含缩进,用 includes 匹配)。
const ln = (needle: string): number => JAVA_SRC.findIndex((l) => l.includes(needle)) + 1;

describe("Java structural adapter( §5 二期)", () => {
  it("class/interface/构造器/方法/抽象方法 提取+行号+容器正确", async () => {
    const { dir, rel } = javaFixture();
    const r = await parseJavaFile(dir, rel);
    const byId = new Map(r.symbols.map((s) => [s.id, s]));
    expect(r.symbols.map((s) => `${s.container ? s.container + "." : ""}${s.name}`).sort()).toEqual(
 // P1:类字段(repo)入索引为 variable 符号(带 dataType+container)
      ["OrderService", "OrderService.OrderService", "OrderService.place", "OrderService.save", "OrderService.repo", "Repo", "Repo.find"].sort(),
    );
    expect(byId.get("OrderService.java#OrderService")!.line).toBe(ln("public class OrderService {"));
    const place = byId.get("OrderService.java#OrderService.place")!;
    expect(place.line).toBe(ln("public Order place(OrderRequest req)"));
    expect(place.kind).toBe("method");
    expect(place.container).toBe("OrderService");
    // 构造器:同名同类
    const repoField = byId.get("OrderService.java#OrderService.repo")!;
    expect(repoField.kind).toBe("variable");
    expect(repoField.dataType).toBe("Repo");
    const ctor = byId.get("OrderService.java#OrderService.OrderService")!;
    expect(ctor.kind).toBe("method");
    expect(ctor.signature!.returnType).toBeUndefined();
    // 接口抽象方法(无体,; 收尾)
    const find = byId.get("OrderService.java#Repo.find")!;
    expect(find.line).toBe(ln("Order find(String id);"));
    expect(find.container).toBe("Repo");
    rmSync(dir, { recursive: true, force: true });
  });

  it("签名:Java Type name 顺序;字符串/字符/块注释里的括号不破坏深度", async () => {
    const { dir, rel } = javaFixture();
    const r = await parseJavaFile(dir, rel);
    const place = r.symbols.find((s) => s.name === "place")!;
    expect(place.signature!.params.map((p) => p.name)).toEqual(["req"]);
    expect(place.signature!.params[0]!.type).toBe("OrderRequest");
    expect(place.signature!.returnType).toBe("Order");
    const save = r.symbols.find((s) => s.name === "save")!;
    expect(save.signature!.params.map((p) => `${p.type} ${p.name}`)).toEqual(["String tpl", "OrderRequest req"]);
    // 深度未被 "…" / '…{…' / /* … */ 破坏:save 与 Repo.find 行号仍在位
    expect(save.line).toBe(ln("private Order save(String tpl, OrderRequest req) {"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("调用边:this. 同类归属+唯一名;tier=structural", async () => {
    const { dir, rel } = javaFixture();
    const r = await parseJavaFile(dir, rel);
    const byId = new Map(r.symbols.map((s) => [s.id, s]));
    const e = r.edges.find((x) => x.toName === "save")!;
    expect(e.tier).toBe("structural");
    expect(e.evidenceKind).toBe("ast");
    expect(byId.get(e.from)!.name).toBe("place");
    expect(byId.get(e.to)!.container).toBe("OrderService");
    // new Order(req) 的构造调用:Order 不是本文件方法名,不猜(无边)
    expect(r.edges.find((x) => x.toName === "Order")).toBeUndefined();
    expect(r.edges.every((x) => x.from.includes("OrderService.java#"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("文件缺失进盲区;callgraph 集成(java 文件不再为孤儿)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-java2-"));
    const miss = await parseJavaFile(dir, "nope.java");
    expect(miss.symbols).toHaveLength(0);
    expect(miss.failures).toHaveLength(1);
    writeFileSync(join(dir, "OrderService.java"), JAVA_SRC.join("\n") + "\n");
    const g = await buildCallGraphFromFiles(dir, ["OrderService.java"]);
    expect([...g.symbols.values()].some((s) => s.name === "place" && s.container === "OrderService")).toBe(true);
    expect([...g.outEdges.keys()].some((k) => k.includes("OrderService.place"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// RC-A:跨文件候选出口(此前 JavaParseResult 无 crossFileCandidates,全部锚 callers R=0)
describe("Java RC-A:字段/参数/局部类型证据跨文件候选", () => {
  it("字段类型字段走表:b.help( 跨文件解析到 B.help;this miss 发容器候选", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-java-xfile-"));
    try {
      writeFileSync(join(dir, "B.java"), [
        "package demo;",
        "",
        "public class B {",
        "    public int help() { return 1; }",
        "}",
      ].join("\n"));
      writeFileSync(join(dir, "A.java"), [
        "package demo;",
        "",
        "public class A {",
        "    private final B b;",
        "    public int go() {",
        "        return b.help();",
        "    }",
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["B.java", "A.java"]);
      const go = [...g.symbols.values()].find((s) => s.name === "go")!;
      const e = (g.outEdges.get(go.id) ?? []).find((x) => x.toName === "help");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("B.java#B.help");
      expect(e!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("参数/局部变量类型证据 + 同名多 def 不猜;静态 Cls.method( import 名单候选", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-java-typ-"));
    try {
      writeFileSync(join(dir, "Util.java"), [
        "package demo;",
        "",
        "public class Util {",
        "    public static int run(int x) { return x; }",
        "    public int run() { return 2; } // 同名第二 def:多候选必须不猜",
        "}",
      ].join("\n"));
      writeFileSync(join(dir, "Main.java"), [
        "package demo;",
        "",
        "import demo.Util;",
        "",
        "public class Main {",
        "    public int viaParam(Util u) {",
        "        return u.run(1);",
        "    }",
        "    public int viaLocal() {",
        "        Util u = new Util();",
        "        return u.run();",
        "    }",
        "    public int viaStatic() {",
        "        return Util.run(2);",
        "    }",
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["Util.java", "Main.java"]);
      // 同文件重载共享 engine 符号 id(file#Container.name 身份模型)→ symbols 收敛为 1,
      // 但 byName 候选池仍双份(pool.length=2)→ 同名双闸诚实弃边语义不破
      const runOverloads = [...g.symbols.values()].filter((s) => s.name === "run");
      expect(runOverloads.length).toBe(1);
      // viaParam/viaLocal:receiverType=Util → run 两 def(同名重载组)→ 双闸诚实弃边(toJson 同款)
      for (const callerName of ["viaParam", "viaLocal"]) {
        const c = [...g.symbols.values()].find((s) => s.name === callerName)!;
        expect((g.outEdges.get(c.id) ?? []).find((x) => x.toName === "run" && x.to)).toBeUndefined();
      }
 // viaStatic:Util.run(静态形态候选 receiverType=Util → 同样落重载组不猜(诚实)
      const viaStatic = [...g.symbols.values()].find((s) => s.name === "viaStatic")!;
      expect((g.outEdges.get(viaStatic.id) ?? []).find((x) => x.toName === "run" && x.to)).toBeUndefined();
 // new Util(走默认构造器(源码无 ctor 声明):裸名候选解析到类节点(实例化关联,
      // 唯一指涉;有显式 ctor 时类节点与 ctor 同名双形态=不猜)
      const viaLocal = [...g.symbols.values()].find((s) => s.name === "viaLocal")!;
      const ctorEdge = (g.outEdges.get(viaLocal.id) ?? []).find((x) => x.toName === "Util" && x.to);
      expect(ctorEdge).toBeTruthy();
      expect(ctorEdge!.to).toContain("Util.java#Util");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同包跨文件裸名候选唯一名解析;无证据接收者不猜;赋值语句不冒充声明", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-java-bare-"));
    try {
      writeFileSync(join(dir, "Repo.java"), [
        "package demo;",
        "",
        "public class Repo {",
        "    public Order find(String id) { return null; }",
        "}",
      ].join("\n"));
      writeFileSync(join(dir, "Svc.java"), [
        "package demo;",
        "",
        "public class Svc {",
        "    private Order cached = load(); // 赋值语句此前被误登记成假方法 load(,污染唯一名闸",
        "    public Order get() {",
        "        Order o = find(\"a\"); // 同包裸调用,无 import",
        "        cached.hashCode(); // cached 类型未在证据表:不猜",
        "        return o;",
        "    }",
        "}",
      ].join("\n"));
      const r = await parseJavaFile(dir, "Svc.java");
      // 假方法 load 不得因赋值语句登记(byName 污染源)
      expect(r.symbols.filter((s) => s.name === "load")).toHaveLength(0);
      // find 裸调用发候选(同文件无定义)
      expect((r.crossFileCandidates ?? []).some((c) => c.toName === "find")).toBe(true);
      const g = await buildCallGraphFromFiles(dir, ["Repo.java", "Svc.java"]);
      const get = [...g.symbols.values()].find((s) => s.name === "get")!;
      const e = (g.outEdges.get(get.id) ?? []).find((x) => x.toName === "find");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("Repo.java#Repo.find");
 // 无类型证据的 cached.hashCode(merge 后不得有解析边
      expect((g.outEdges.get(get.id) ?? []).find((x) => x.toName === "hashCode" && x.to)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
