import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGoFile } from "../src/adapters/go";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";

// 行号断言的基准:fixture 按行数组构造,行号=索引+1(手写常量易腐)。
const GO_SRC = [
  "package svc",
  "",
  'import "fmt"',
  "",
  "// Server 处理请求。注释里的括号 { } 不得计入深度。",
  "type Server struct {",
  "\tName string // 字段行 { 同理",
  "}",
  "",
  "type Handler interface {",
  "\tHandle(req string) error",
  "}",
  "",
  "type Alias Server", // 命名类型(别名)也登记
  "",
  "func (s *Server) Handle(req string) error {",
  '\tmsg := "string with brace { and } inside"',
  "\traw := `backtick raw { } // not comment \"`",
  '\tif req == "" {',
  '\t\treturn fmt.Errorf("empty: }{")',
  "\t}",
  "\treturn s.transform(msg)",
  "}",
  "",
  "func (s *Server) transform(x string) string { return x + \"}\" }",
  "",
  "// Standalone 独立函数(递归自环不进边)。",
  "func Standalone(n int) (int, error) {",
  "\tif n > 0 {",
  "\t\treturn Standalone(n - 1)",
  "\t}",
  "\treturn n, nil",
  "}",
];

function goFixture(): { dir: string; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-go-"));
  writeFileSync(join(dir, "svc.go"), GO_SRC.join("\n") + "\n");
  return { dir, rel: "svc.go" };
}

describe("Go structural adapter(designs/16 §5 二期)", () => {
  it("包级 func/type/struct/interface/方法 提取+行号正确", async () => {
    const { dir, rel } = goFixture();
    const r = await parseGoFile(dir, rel);
    const byName = new Map(r.symbols.map((s) => [s.name, s]));
    // 符号集
    expect([...byName.keys()].sort()).toEqual(["Alias", "Handle", "Handler", "Server", "Standalone", "transform"].sort());
    // 行号(=GO_SRC 索引+1)
    expect(byName.get("Server")!.line).toBe(GO_SRC.indexOf("type Server struct {") + 1);
    expect(byName.get("Handler")!.line).toBe(GO_SRC.indexOf("type Handler interface {") + 1);
    const handle = byName.get("Handle")!;
    expect(handle.line).toBe(GO_SRC.indexOf("func (s *Server) Handle(req string) error {") + 1);
    expect(handle.kind).toBe("method");
    expect(handle.container).toBe("Server");
    expect(byName.get("transform")!.kind).toBe("method");
    expect(byName.get("Standalone")!.kind).toBe("function");
    expect(byName.get("Alias")!.kind).toBe("class");
    // 全部如实 structural 档
    expect(r.symbols.every((s) => s.file === rel)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("签名:参数名+类型、返回值;字符串/注释/原始串里的括号不破坏深度", async () => {
    const { dir, rel } = goFixture();
    const r = await parseGoFile(dir, rel);
    const byName = new Map(r.symbols.map((s) => [s.name, s]));
    const sig = byName.get("Handle")!.signature!;
    expect(sig.params.map((p) => p.name)).toEqual(["req"]);
    expect(sig.params[0]!.type).toBe("string");
    expect(sig.returnType).toBe("error");
    const st = byName.get("Standalone")!.signature!;
    expect(st.returnType).toBe("(int, error)");
    // 深度未被 "…}{…" / `…{ }…` / 注释破坏:transform 与 Standalone 行号仍在位(错位=深度被字符串括号顶飞)
    expect(byName.get("transform")!.line).toBe(GO_SRC.indexOf('func (s *Server) transform(x string) string { return x + "}" }') + 1);
    expect(byName.get("Standalone")!.line).toBe(GO_SRC.indexOf("func Standalone(n int) (int, error) {") + 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("调用边:接收者归属(transform)+跨函数;自环不进边;tier=structural", async () => {
    const { dir, rel } = goFixture();
    const r = await parseGoFile(dir, rel);
    const byId = new Map(r.symbols.map((s) => [s.id, s]));
    const e = r.edges.find((x) => x.toName === "transform")!;
    expect(e.tier).toBe("structural");
    expect(e.evidenceKind).toBe("ast");
    expect(byId.get(e.from)!.name).toBe("Handle");
    expect(byId.get(e.to)!.container).toBe("Server");
    // Standalone 递归:自环跳过(python 同口径)
    const selfEdge = r.edges.find((x) => x.toName === "Standalone" && x.from === x.to);
    expect(selfEdge).toBeUndefined();
    expect(r.edges.every((x) => x.from.includes("svc.go#"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("文件缺失进盲区;callgraph 集成(go 文件不再为孤儿)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go2-"));
    const miss = await parseGoFile(dir, "nope.go");
    expect(miss.symbols).toHaveLength(0);
    expect(miss.failures).toHaveLength(1);
    // 集成:buildCallGraphFromFiles 能看到 .go 符号(debug 剖面对 go 仓可用)
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "m.go"), GO_SRC.join("\n") + "\n");
    const g = await buildCallGraphFromFiles(dir, ["m.go"]);
    expect([...g.symbols.values()].some((s) => s.name === "Handle" && s.container === "Server")).toBe(true);
    expect([...g.outEdges.keys()].some((k) => k.includes("Server.Handle"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Go 跨文件候选(open-code-review 实证:368 文件只做同文件解析,65% 误标 trunk)", () => {
  it("同包跨文件裸调用经全图唯一名解析连边;多候选不猜;调用方不再误标 trunk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-xfile-"));
    try {
      writeFileSync(join(dir, "a.go"), [
        "package svc",
        "",
        "func ExportedHelper() int { return 42 }",
        "",
        "func RareName() int { return ExportedHelper() }",
      ].join("\n"));
      writeFileSync(join(dir, "b.go"), [
        "package svc",
        "",
        "func EntryPoint() int {",
        "\treturn RareName() + ExportedHelper()",
        "}",
        "",
        "func EntryTwo() int { return ExportedHelper() }",
      ].join("\n"));
      writeFileSync(join(dir, "c.go"), [
        "package svc",
        "",
        "func ExportedHelper() int { return 2 } // 同名第二定义:多候选必须不猜",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["a.go", "b.go", "c.go"]);
      const entry = [...g.symbols.values()].find((s) => s.name === "EntryPoint")!;
      // ExportedHelper 两处定义=多候选:EntryPoint 的调用不得解析(不猜)
      const edgesFromEntry = g.outEdges.get(entry.id) ?? [];
      expect(edgesFromEntry.find((e) => e.toName === "ExportedHelper" && e.to)).toBeUndefined();
      // RareName 全图唯一:跨文件解析连边
      const rare = edgesFromEntry.find((e) => e.toName === "RareName");
      expect(rare).toBeTruthy();
      expect(rare!.to).toContain("a.go#RareName");
      expect(rare!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// step-084 RC-A:接收者/包限定调用恢复跨文件候选(cobra/grpc-go/moby 全锚塌格的根因面)
describe("Go RC-A:包限定与类型证据跨文件候选(step-084)", () => {
  it("pkg.Func( 包限定调用发候选并经唯一名解析;无 import 证据的包名不猜", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-pkg-"));
    try {
      writeFileSync(join(dir, "thing.go"), [
        "package things",
        "",
        "func NewThing() *Thing { return &Thing{} }",
      ].join("\n"));
      writeFileSync(join(dir, "main.go"), [
        "package main",
        "",
        'import "example.com/things"',
        "",
        "func Setup() {",
        "\tt := things.NewThing()",
        "\t_ = t",
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["thing.go", "main.go"]);
      const setup = [...g.symbols.values()].find((s) => s.name === "Setup")!;
      const e = (g.outEdges.get(setup.id) ?? []).find((x) => x.toName === "NewThing");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("thing.go#NewThing");
      expect(e!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("接收者方法跨文件:s.Handle( 在 Handle 定义于其它文件时经 receiverType 解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-recv-"));
    try {
      writeFileSync(join(dir, "server.go"), [
        "package app",
        "",
        "type Server struct{}",
        "",
        "func (s *Server) Handle(req string) error { return nil }",
      ].join("\n"));
      writeFileSync(join(dir, "run.go"), [
        "package app",
        "",
        "func (s *Server) Run() error {",
        '\treturn s.Handle("x")',
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["server.go", "run.go"]);
      const run = [...g.symbols.values()].find((s) => s.name === "Run")!;
      const e = (g.outEdges.get(run.id) ?? []).find((x) => x.toName === "Handle");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("server.go#Server.Handle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("局部类型证据:&T{} 字面量/参数类型/链字段三通道;同名多 def 仍不猜", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-typ-"));
    try {
      writeFileSync(join(dir, "server.go"), [
        "package app",
        "",
        "type Server struct{}",
        "",
        "type Client struct {",
        "\tsrv *Server",
        "}",
        "",
        "func (s *Server) Stop() error { return nil }",
        "func (c *Client) Shutdown() error {",
        "\treturn c.srv.Stop()",
        "}",
      ].join("\n"));
      writeFileSync(join(dir, "main.go"), [
        "package app",
        "",
        "func Start(s *Server) error { return s.Stop() }",
        "",
        "func Main() error {",
        "\tlocal := &Server{}",
        "\treturn local.Stop()",
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["server.go", "main.go"]);
      const stopId = [...g.symbols.values()].find((s) => s.name === "Stop" && s.container === "Server")!.id;
      // 参数类型通道:Start(s *Server) → s.Stop(
      const start = [...g.symbols.values()].find((s) => s.name === "Start")!;
      expect((g.outEdges.get(start.id) ?? []).find((x) => x.to === stopId)).toBeTruthy();
      // &T{} 字面量通道:local := &Server{}
      const main = [...g.symbols.values()].find((s) => s.name === "Main")!;
      expect((g.outEdges.get(main.id) ?? []).find((x) => x.to === stopId)).toBeTruthy();
      // 链字段通道:c.srv.Stop( → srv 字段类型 Server
      const shutdown = [...g.symbols.values()].find((s) => s.name === "Shutdown")!;
      expect((g.outEdges.get(shutdown.id) ?? []).find((x) => x.to === stopId)).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无类型证据的接收者调用不猜(不产边不产候选);单行函数与去重不受影响", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-noe-"));
    try {
      writeFileSync(join(dir, "a.go"), [
        "package app",
        "",
        "type Server struct{}",
        "",
        "func (s *Server) Stop() error { return nil }",
      ].join("\n"));
      writeFileSync(join(dir, "b.go"), [
        "package app",
        "",
        "import \"testing\"",
        "",
        "func Run(x *testing.T) {",
        "\tx.Helper()",
        "}",
      ].join("\n"));
      const r = await parseGoFile(dir, "b.go");
      // x 的类型 testing.T 非 adapter 可证类型:无 ast 边、无跨文件候选(宁缺勿错)
      expect(r.edges.filter((e) => e.toName === "Helper")).toHaveLength(0);
      expect((r.crossFileCandidates ?? []).filter((c) => c.toName === "Helper")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// step-102:自仓 import 前缀白名单重落地(094 存档回迁)+interface/struct 注册区分
describe("Go 自仓 import 前缀白名单(step-102,094 存档复用)", () => {
  /** grpc-go 生成代码实形态:模块根包类型 ClientConn,生成 client 结构持 `cc *app.ClientConn`。 */
  function grpcShapeFixture(dir: string, modLine: string | null): void {
    if (modLine !== null) writeFileSync(join(dir, "go.mod"), modLine + "\n\ngo 1.22\n");
    writeFileSync(join(dir, "clientconn.go"), [
      "package app",
      "",
      "type ClientConn struct{}",
      "",
      "func (c *ClientConn) Invoke(ctx string) error { return nil }",
    ].join("\n"));
    writeFileSync(join(dir, "helloworld.pb.go"), [
      "package main",
      "",
      'import "example.com/app"',
      "",
      "type greeterClient struct {",
      "\tcc *app.ClientConn",
      "}",
      "",
      "func (c *greeterClient) SayHello(in string) error {",
      '\treturn c.cc.Invoke(in)',
      "}",
    ].join("\n"));
  }

  it("自仓包限定类型(cc *app.ClientConn)激活 receiverType 链:c.cc.Invoke( 解析到 ClientConn.Invoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-wl-"));
    try {
      grpcShapeFixture(dir, "module example.com/app");
      const g = await buildCallGraphFromFiles(dir, ["clientconn.go", "helloworld.pb.go"]);
      const say = [...g.symbols.values()].find((s) => s.name === "SayHello")!;
      const e = (g.outEdges.get(say.id) ?? []).find((x) => x.toName === "Invoke");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("clientconn.go#ClientConn.Invoke");
      expect(e!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("外部包限定(ext 不在 module 前缀下)照旧不猜:不产边不产 receiverType 候选", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-we-"));
    try {
      // module 前缀 example.com/app,而 import 的是 example.com/ext(外部)
      grpcShapeFixture(dir, "module example.com/app");
      const fs = await import("node:fs");
      let pb = fs.readFileSync(join(dir, "helloworld.pb.go"), "utf-8");
      pb = pb.replace('import "example.com/app"', 'import "example.com/ext"').replace(/\*app\.ClientConn/, "*ext.ClientConn");
      fs.writeFileSync(join(dir, "helloworld.pb.go"), pb);
      const g = await buildCallGraphFromFiles(dir, ["clientconn.go", "helloworld.pb.go"]);
      const say = [...g.symbols.values()].find((s) => s.name === "SayHello")!;
      expect((g.outEdges.get(say.id) ?? []).find((x) => x.toName === "Invoke")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无 go.mod=白名单关闭,行为与 step-084 一致(同形态不解析)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-wn-"));
    try {
      grpcShapeFixture(dir, null);
      const g = await buildCallGraphFromFiles(dir, ["clientconn.go", "helloworld.pb.go"]);
      const say = [...g.symbols.values()].find((s) => s.name === "SayHello")!;
      expect((g.outEdges.get(say.id) ?? []).find((x) => x.toName === "Invoke")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("参数类型白名单:func dial(cc *app.ClientConn) 的 cc.Invoke( 同链解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-wp-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
      writeFileSync(join(dir, "clientconn.go"), [
        "package app",
        "",
        "type ClientConn struct{}",
        "",
        "func (c *ClientConn) Invoke(ctx string) error { return nil }",
      ].join("\n"));
      writeFileSync(join(dir, "dial.go"), [
        "package main",
        "",
        'import "example.com/app"',
        "",
        "func Dial(cc *app.ClientConn) error {",
        '\treturn cc.Invoke("x")',
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["clientconn.go", "dial.go"]);
      const dial = [...g.symbols.values()].find((s) => s.name === "Dial")!;
      const e = (g.outEdges.get(dial.id) ?? []).find((x) => x.toName === "Invoke");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("clientconn.go#ClientConn.Invoke");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("多个自仓包同名类型撞名:receiverType 收窄后仍多候选=弃边(宁缺勿错保持)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-wc-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
      writeFileSync(join(dir, "a.go"), [
        "package a",
        "",
        "type ClientConn struct{}",
        "",
        "func (c *ClientConn) Invoke(ctx string) error { return nil }",
      ].join("\n"));
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub/b.go"), [
        "package b",
        "",
        "type ClientConn struct{}",
        "",
        "func (c *ClientConn) Invoke(ctx string) error { return nil }",
      ].join("\n"));
      writeFileSync(join(dir, "main.go"), [
        "package main",
        "",
        'import "example.com/app"',
        "",
        "type wrapper struct {",
        "\tcc *app.ClientConn",
        "}",
        "",
        "func (w *wrapper) Do(in string) error {",
        '\treturn w.cc.Invoke(in)',
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["a.go", "sub/b.go", "main.go"]);
      const doSym = [...g.symbols.values()].find((s) => s.name === "Do")!;
      expect((g.outEdges.get(doSym.id) ?? []).find((x) => x.toName === "Invoke")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// step-102:interface/struct 注册区分(094 精度门假边归因修复)
describe("Go interface/struct 注册区分(step-102)", () => {
  it("typeKind 注册:type X struct→struct / type X interface→interface / 别名不设(未知)", async () => {
    const { dir, rel } = goFixture();
    const r = await parseGoFile(dir, rel);
    const byName = new Map(r.symbols.map((s) => [s.name, s]));
    expect(byName.get("Server")!.typeKind).toBe("struct");
    expect(byName.get("Handler")!.typeKind).toBe("interface");
    expect(byName.get("Alias")!.typeKind).toBeUndefined();
    // kind 联合不动(全仓 kind==="class" 消费面零影响)
    expect(byName.get("Handler")!.kind).toBe("class");
    rmSync(dir, { recursive: true, force: true });
  });

  /** 094 假边实形态:仓内接口 balancer.Balancer 与实现体 gracefulswitch.Balancer 撞名,
   * autosharding 的 `child balancer.Balancer` 字段调用 UpdateClientConnState。 */
  function balancerCollisionFixture(dir: string): void {
    writeFileSync(join(dir, "go.mod"), "module google.golang.org/grpc\n\ngo 1.22\n");
    mkdirSync(join(dir, "balancer"), { recursive: true });
    writeFileSync(join(dir, "balancer", "balancer.go"), [
      "package balancer",
      "",
      "type Balancer interface {",
      "\tUpdateClientConnState(s string) error",
      "}",
    ].join("\n"));
    mkdirSync(join(dir, "balancer", "gracefulswitch"), { recursive: true });
    writeFileSync(join(dir, "balancer", "gracefulswitch", "balancer.go"), [
      "package gracefulswitch",
      "",
      "type Balancer struct{}",
      "",
      "func (b *Balancer) UpdateClientConnState(s string) error { return nil }",
    ].join("\n"));
    mkdirSync(join(dir, "balancer", "autosharding"), { recursive: true });
    writeFileSync(join(dir, "balancer", "autosharding", "autosharding.go"), [
      "package autosharding",
      "",
      'import "google.golang.org/grpc/balancer"',
      "",
      "type childWrapper struct {",
      "\tchild balancer.Balancer",
      "}",
      "",
      "func (w *childWrapper) Update(s string) error {",
      "\treturn w.child.UpdateClientConnState(s)",
      "}",
    ].join("\n"));
  }

  it("撞名闸:接口 receiverType 不窄化到实现体方法,如实弃边+进弃边台账", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-ic-"));
    try {
      balancerCollisionFixture(dir);
      const g = await buildCallGraphFromFiles(dir, [
        "balancer/balancer.go", "balancer/gracefulswitch/balancer.go", "balancer/autosharding/autosharding.go",
      ]);
      const upd = [...g.symbols.values()].find((s) => s.name === "Update")!;
      // 无边(094 假边不再发射:撞名时不再「唯一命中」gracefulswitch.Balancer)
      expect((g.outEdges.get(upd.id) ?? []).find((x) => x.toName === "UpdateClientConnState" && x.to)).toBeUndefined();
      // 弃边台账:099 dropped 机制承载,原因含撞名语义
      const dropped = g.droppedCandidates?.get("UpdateClientConnState");
      expect(dropped).toBeTruthy();
      expect(Object.keys(dropped!.reasons).some((r) => r.includes("撞名"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录钉扎:撞名但证据指向结构体包(gracefulswitch.Balancer)=放行解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-id-"));
    try {
      balancerCollisionFixture(dir);
      // 覆写 autosharding:字段类型改指实现体包(接口仍在他包同名存在)
      writeFileSync(join(dir, "balancer", "autosharding", "autosharding.go"), [
        "package autosharding",
        "",
        'import "google.golang.org/grpc/balancer/gracefulswitch"',
        "",
        "type childWrapper struct {",
        "\tchild *gracefulswitch.Balancer",
        "}",
        "",
        "func (w *childWrapper) Update(s string) error {",
        "\treturn w.child.UpdateClientConnState(s)",
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, [
        "balancer/balancer.go", "balancer/gracefulswitch/balancer.go", "balancer/autosharding/autosharding.go",
      ]);
      const upd = [...g.symbols.values()].find((s) => s.name === "Update")!;
      const e = (g.outEdges.get(upd.id) ?? []).find((x) => x.toName === "UpdateClientConnState");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("gracefulswitch/balancer.go#Balancer.UpdateClientConnState");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录钉扎:根包结构体(dir=\"\")与他包同名接口共存=放行(grpc.ClientConn 实形态)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-ir-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module google.golang.org/grpc\n\ngo 1.22\n");
      writeFileSync(join(dir, "clientconn.go"), [
        "package grpc",
        "",
        "type ClientConn struct{}",
        "",
        "func (c *ClientConn) Invoke(ctx string) error { return nil }",
      ].join("\n"));
      mkdirSync(join(dir, "balancer"), { recursive: true });
      writeFileSync(join(dir, "balancer", "balancer.go"), [
        "package balancer",
        "",
        "type ClientConn interface {",
        "\tUpdateState(s string) error",
        "}",
      ].join("\n"));
      writeFileSync(join(dir, "caller.go"), [
        "package main",
        "",
        'import "google.golang.org/grpc"',
        "",
        "func Do(cc *grpc.ClientConn) error {",
        '\treturn cc.Invoke("x")',
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["clientconn.go", "balancer/balancer.go", "caller.go"]);
      const doSym = [...g.symbols.values()].find((s) => s.name === "Do")!;
      const e = (g.outEdges.get(doSym.id) ?? []).find((x) => x.toName === "Invoke");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("clientconn.go#ClientConn.Invoke");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("名级污染回归:同文件裸名 *ClientConn(本包结构体)与 balancer.ClientConn(他包接口)并存,裸名证据目录=本包=放行", async () => {
    // grpc-go clientconn_test.go 实形态:package grpc 的测试同时用根包结构体与 balancer 接口
    const dir = mkdtempSync(join(tmpdir(), "gh-go-ipol-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module google.golang.org/grpc\n\ngo 1.22\n");
      writeFileSync(join(dir, "clientconn.go"), [
        "package grpc",
        "",
        "type ClientConn struct{}",
        "",
        "func (c *ClientConn) Connect() error { return nil }",
      ].join("\n"));
      mkdirSync(join(dir, "balancer"), { recursive: true });
      writeFileSync(join(dir, "balancer", "balancer.go"), [
        "package balancer",
        "",
        "type ClientConn interface {",
        "\tUpdateState(s string) error",
        "}",
      ].join("\n"));
      writeFileSync(join(dir, "clientconn_test.go"), [
        "package grpc",
        "",
        'import "google.golang.org/grpc/balancer"',
        "",
        "func useBal(cc balancer.ClientConn) error { return cc.UpdateState(\"x\") }",
        "",
        "func stayConnected(cc *ClientConn) {",
        "\t_ = cc.Connect()",
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["clientconn.go", "balancer/balancer.go", "clientconn_test.go"]);
      const sc = [...g.symbols.values()].find((s) => s.name === "stayConnected")!;
      const e = (g.outEdges.get(sc.id) ?? []).find((x) => x.toName === "Connect");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("clientconn.go#ClientConn.Connect");
      // 对照:同文件的接口参数调用(balancer.ClientConn)不连任何实现体(接口无方法符号=自然弃)
      const ub = [...g.symbols.values()].find((s) => s.name === "useBal")!;
      expect((g.outEdges.get(ub.id) ?? []).find((x) => x.toName === "UpdateState" && x.to)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// step-108:接口断言定向解析(grpc-go Invoke 生成代码接收者的诚实边界突破)
describe("Go 接口断言定向解析(step-108)", () => {
  /** grpc-go 生成代码实形态:根包接口+唯一断言实现;生成 client(子目录包)持接口字段。 */
  function grpcIfaceFixture(dir: string): void {
    writeFileSync(join(dir, "go.mod"), "module google.golang.org/grpc\n\ngo 1.22\n");
    writeFileSync(dir + "/clientconn.go", [
      "package grpc",
      "",
      "type ClientConnInterface interface {",
      "\tInvoke(ctx string) error",
      "}",
      "",
      "type ClientConn struct{}",
      "",
      "func (c *ClientConn) Invoke(ctx string) error { return nil }",
      "",
      "var _ ClientConnInterface = (*ClientConn)(nil)",
    ].join("\n"));
    mkdirSync(join(dir, "examples", "hello"), { recursive: true });
    writeFileSync(join(dir, "examples", "hello", "hello_grpc.pb.go"), [
      "// Code generated by protoc-gen-go-grpc. DO NOT EDIT.",
      "",
      "package hello",
      "",
      'import "google.golang.org/grpc"',
      "",
      "type greeterClient struct {",
      "\tcc grpc.ClientConnInterface",
      "}",
      "",
      "func (c *greeterClient) SayHello(in string) error {",
      "\treturn c.cc.Invoke(in)",
      "}",
    ].join("\n"));
  }
  const IFACE_FILES = ["clientconn.go", "examples/hello/hello_grpc.pb.go"];

  it("生成代码形态:接口字段 c.cc.Invoke 经唯一断言实现解析到 ClientConn.Invoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-ia-"));
    try {
      grpcIfaceFixture(dir);
      const g = await buildCallGraphFromFiles(dir, IFACE_FILES);
      const say = [...g.symbols.values()].find((s) => s.name === "SayHello")!;
      const e = (g.outEdges.get(say.id) ?? []).find((x) => x.toName === "Invoke");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("clientconn.go#ClientConn.Invoke");
      expect(e!.evidenceKind).toBe("index");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("生成代码闸门:手写文件同形态(接口参数 cc.Invoke)不解析——「唯一断言实现」在手写代码不蕴含典范实现(BufferPool 实证)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-iag-"));
    try {
      grpcIfaceFixture(dir);
      writeFileSync(join(dir, "caller.go"), [
        "package main",
        "",
        'import "google.golang.org/grpc"',
        "",
        "func Dial(cc grpc.ClientConnInterface) error {",
        '\treturn cc.Invoke("x")',
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, [...IFACE_FILES, "caller.go"]);
      // 手写 caller.go(无生成标记):不解析
      const dial = [...g.symbols.values()].find((s) => s.name === "Dial")!;
      expect((g.outEdges.get(dial.id) ?? []).find((x) => x.toName === "Invoke" && x.to)).toBeUndefined();
      // 对照:同仓生成文件照常解析
      const say = [...g.symbols.values()].find((s) => s.name === "SayHello")!;
      expect((g.outEdges.get(say.id) ?? []).find((x) => x.toName === "Invoke" && x.to)).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("多断言歧义不猜:同包两个断言实现=不解析(宁缺勿错保持)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-iamb-"));
    try {
      grpcIfaceFixture(dir);
      writeFileSync(join(dir, "extra.go"), [
        "package grpc",
        "",
        "type fakeConn struct{}",
        "",
        "func (f *fakeConn) Invoke(ctx string) error { return nil }",
        "",
        "var _ ClientConnInterface = (*fakeConn)(nil)",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, [...IFACE_FILES, "extra.go"]);
      const say = [...g.symbols.values()].find((s) => s.name === "SayHello")!;
      expect((g.outEdges.get(say.id) ?? []).find((x) => x.toName === "Invoke" && x.to)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无断言接口不改写:维持弃边(旧行为)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-iano-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module google.golang.org/grpc\n\ngo 1.22\n");
      writeFileSync(join(dir, "clientconn.go"), [
        "package grpc",
        "",
        "type ClientConnInterface interface {",
        "\tInvoke(ctx string) error",
        "}",
        "",
        "type ClientConn struct{}",
        "",
        "func (c *ClientConn) Invoke(ctx string) error { return nil }",
      ].join("\n")); // 无 var _ 断言
      mkdirSync(join(dir, "examples", "hello"), { recursive: true });
      writeFileSync(join(dir, "examples", "hello", "hello_grpc.pb.go"), [
        "// Code generated by protoc-gen-go-grpc. DO NOT EDIT.",
        "",
        "package hello",
        "",
        'import "google.golang.org/grpc"',
        "",
        "type greeterClient struct {",
        "\tcc grpc.ClientConnInterface",
        "}",
        "",
        "func (c *greeterClient) SayHello(in string) error {",
        "\treturn c.cc.Invoke(in)",
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, IFACE_FILES);
      const say = [...g.symbols.values()].find((s) => s.name === "SayHello")!;
      expect((g.outEdges.get(say.id) ?? []).find((x) => x.toName === "Invoke" && x.to)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("断言只在 _test.go=不算数(测试替身不得成为典范实现,cobra SliceValue 防护)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-iatest-"));
    try {
      grpcIfaceFixture(dir);
      // 移除生产断言,只在测试文件断言
      writeFileSync(join(dir, "clientconn.go"), [
        "package grpc",
        "",
        "type ClientConnInterface interface {",
        "\tInvoke(ctx string) error",
        "}",
        "",
        "type ClientConn struct{}",
        "",
        "func (c *ClientConn) Invoke(ctx string) error { return nil }",
      ].join("\n"));
      writeFileSync(join(dir, "clientconn_test.go"), [
        "package grpc",
        "",
        "var _ ClientConnInterface = (*ClientConn)(nil)",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, [...IFACE_FILES, "clientconn_test.go"]);
      const say = [...g.symbols.values()].find((s) => s.name === "SayHello")!;
      expect((g.outEdges.get(say.id) ?? []).find((x) => x.toName === "Invoke" && x.to)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("跨目录隔离:断言在他包目录,本包同名接口不改写", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-ix-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
      mkdirSync(join(dir, "pkg"), { recursive: true });
      writeFileSync(join(dir, "pkg", "conn.go"), [
        "package pkg",
        "",
        "type Conn interface {",
        "\tInvoke(ctx string) error",
        "}",
      ].join("\n")); // pkg.Conn:无断言
      mkdirSync(join(dir, "other"), { recursive: true });
      writeFileSync(join(dir, "other", "conn.go"), [
        "package other",
        "",
        "type Conn interface {",
        "\tInvoke(ctx string) error",
        "}",
        "",
        "type connImpl struct{}",
        "",
        "func (c *connImpl) Invoke(ctx string) error { return nil }",
        "",
        "var _ Conn = (*connImpl)(nil)", // other 包内的同名接口断言——不得污染 pkg
      ].join("\n"));
      writeFileSync(join(dir, "main.go"), [
        "package main",
        "",
        'import "example.com/app/pkg"',
        "",
        "func Do(c pkg.Conn) error {",
        '\treturn c.Invoke("x")',
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["pkg/conn.go", "other/conn.go", "main.go"]);
      const doSym = [...g.symbols.values()].find((s) => s.name === "Do")!;
      expect((g.outEdges.get(doSym.id) ?? []).find((x) => x.toName === "Invoke" && x.to)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("右值形态:var _ I = T{} 同认(codec.go 实形态;值接收者实现体)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-go-iform-"));
    try {
      writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
      writeFileSync(join(dir, "codec.go"), [
        "package app",
        "",
        "type baseCodec interface {",
        "\tMarshal(v string) error",
        "}",
        "",
        "type codecV0Bridge struct{}",
        "",
        "func (c codecV0Bridge) Marshal(v string) error { return nil }",
        "",
        "var _ baseCodec = codecV0Bridge{}",
      ].join("\n"));
      writeFileSync(join(dir, "use.go"), [
        "// Code generated by protoc-gen-go. DO NOT EDIT.",
        "",
        "package app",
        "",
        "func prepare(c baseCodec) error {",
        '\treturn c.Marshal("x")',
        "}",
      ].join("\n"));
      const g = await buildCallGraphFromFiles(dir, ["codec.go", "use.go"]);
      const prep = [...g.symbols.values()].find((s) => s.name === "prepare")!;
      const e = (g.outEdges.get(prep.id) ?? []).find((x) => x.toName === "Marshal");
      expect(e).toBeTruthy();
      expect(e!.to).toContain("codec.go#codecV0Bridge.Marshal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});



