/**
 * sensing/crosslang-bridge A2-A6 测试(step-107 / designs/27 §4):
 * 每形态独立 fixture:配对成立(双端证据行)/ 无配对诚实清单 / 动态与歧义形态不产边(防幻觉)。
 * A1(crosslang-bridge.test.ts)不动。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  queryWsChannelEdges, renderWsChannelEdges,
  querySpecBridgeEdges, renderSpecBridgeEdges, specPathLines,
  queryIpcChannelEdges, renderIpcChannelEdges, parseEnumTables,
  queryPyCapiEdges, renderPyCapiEdges, parsePyMethodDefTables,
  queryGrpcProtoEdges, renderGrpcProtoEdges, parseProtoFile,
} from "@lampgenie/code-sense/sensing/crosslang-bridge";

const roots: string[] = [];
function mkws(): string {
  const w = mkdtempSync(join(tmpdir(), "csb107-"));
  roots.push(w);
  return w;
}
afterAll(() => {
  for (const w of roots) rmSync(w, { recursive: true, force: true });
});

// ============================ A2 ws-channel ============================

const A2_BACKEND = `from starlette.routing import WebSocketRoute

async def ws_feed():
    pass

async def ws_idle():
    pass

routes = [
    WebSocketRoute("/ws/feed", ws_feed),
    WebSocketRoute("/ws/idle", ws_idle),
]
`;

const A2_FRONTEND = `export function connect() {
  const ws = new WebSocket("wss://example.com/ws/feed");
  return ws;
}

export function connectDynamic(url: URL) {
  return new WebSocket(url.toString());
}
`;

const A2_CONSTS = `// 路径常量(未见 WebSocket 调用语境)
export const FEED_PATH = "ws/feed";
`;

describe("A2 ws-channel(starlette × ts)", () => {
  let ws = "";
  beforeAll(() => { ws = mkws();
    mkdirSync(join(ws, "server"), { recursive: true });
    mkdirSync(join(ws, "web"), { recursive: true });
    writeFileSync(join(ws, "server", "routes.py"), A2_BACKEND);
    writeFileSync(join(ws, "web", "conn.ts"), A2_FRONTEND);
    writeFileSync(join(ws, "web", "consts.ts"), A2_CONSTS);
  });

  it("ws-scheme 字面量配对出 high 边,双端证据行齐备", async () => {
    const r = await queryWsChannelEdges(ws);
    expect(r.state).toBe("ws-connected");
    const e = r.edges.find((x) => x.from.via === "ws-scheme" && x.to.path === "/ws/feed");
    expect(e).toBeTruthy();
    expect(e!.confidence).toBe("high");
    expect(e!.from.file).toBe("web/conn.ts");
    expect(e!.from.line).toBeGreaterThan(0);
    expect(e!.to.file).toBe("server/routes.py");
    expect(e!.to.line).toBeGreaterThan(0);
    expect(e!.kind).toBe("bridge");
    expect(e!.bridge).toBe("ws-channel");
  }, 30_000);

  it("路径字面量通道出 medium 边(常量文件,未见调用语境)", async () => {
    const r = await queryWsChannelEdges(ws);
    const e = r.edges.find((x) => x.from.via === "path-literal");
    expect(e).toBeTruthy();
    expect(e!.confidence).toBe("medium");
    expect(e!.from.file).toBe("web/consts.ts");
    expect(e!.note ?? "").toContain("未见 WebSocket 调用语境");
  }, 30_000);

  it("变量拼装连接点登记不出边(owncast B3 形态),无配对端点落 unmatched", async () => {
    const r = await queryWsChannelEdges(ws);
    const dyn = r.connectionPoints.find((p) => p.resolution === "unresolved");
    expect(dyn).toBeTruthy();
    expect(dyn!.argText).toContain("url.toString()");
    expect(r.edges.every((e) => e.to.path !== "/ws/idle")).toBe(true);
    expect(r.unmatchedEndpoints.map((u) => u.path)).toContain("/ws/idle");
  }, 30_000);

  it("无 ws 端点的仓态 → no-ws-endpoints(零前端扫描)", async () => {
    const only = mkws();
    writeFileSync(join(only, "a.ts"), `const ws = new WebSocket("wss://x.com/a/b");\n`);
    const r = await queryWsChannelEdges(only);
    expect(r.state).toBe("no-ws-endpoints");
    expect(r.edges.length).toBe(0);
    expect(r.stats.connectionPoints).toBe(0);
    rmSync(only, { recursive: true, force: true });
  }, 30_000);

  it("renderWsChannelEdges 冒烟", async () => {
    const r = await queryWsChannelEdges(ws);
    const text = renderWsChannelEdges(r);
    expect(text).toContain("ws-channel");
    expect(text).toContain("/ws/feed");
  }, 30_000);
});

// ============================ A3 spec-reconcile ============================

const A3_SPEC = `{
  "openapi": "3.0.0",
  "paths": {
    "/api/orders": {
      "post": { "summary": "创建订单", "operationId": "createOrder" }
    },
    "/api/ghost": {
      "get": { "summary": "规范声称存在、代码未实现" }
    }
  }
}
`;

const A3_BACKEND = `from flask import Flask

app = Flask(__name__)

@app.route("/api/orders", methods=["POST"])
def create_order():
    return {}

@app.route("/api/extra")
def extra():
    return {}
`;

describe("A3 spec-reconcile(openapi.json × flask)", () => {
  let ws = "";
  beforeAll(() => {
    ws = mkws();
    writeFileSync(join(ws, "openapi.json"), A3_SPEC);
    writeFileSync(join(ws, "app.py"), A3_BACKEND);
  });

  it("both → high 边,spec 行号补全(证据行双端齐备)", async () => {
    const r = await querySpecBridgeEdges(ws);
    expect(r.state).toBe("spec-connected");
    expect(r.edges.length).toBe(1);
    const e = r.edges[0]!;
    expect(e.from.path).toBe("/api/orders");
    expect(e.from.line).toBeGreaterThan(0); // spec 行号
    expect(e.to.handler).toBe("create_order");
    expect(e.to.line).toBeGreaterThan(0);
    expect(e.confidence).toBe("high");
  }, 30_000);

  it("specOnly(规范有代码无)与 codeOnly(代码有规范无)如实列清单不产边", async () => {
    const r = await querySpecBridgeEdges(ws);
    expect(r.specOnly.map((s) => s.path)).toContain("/api/ghost");
    expect(r.codeOnly.map((c) => c.path)).toContain("/api/extra");
    expect(r.edges.some((e) => e.from.path === "/api/ghost")).toBe(false);
  }, 30_000);

  it("无 spec 仓态 → no-spec", async () => {
    const only = mkws();
    writeFileSync(join(only, "app.py"), A3_BACKEND);
    const r = await querySpecBridgeEdges(only);
    expect(r.state).toBe("no-spec");
    rmSync(only, { recursive: true, force: true });
  }, 30_000);

  it("specPathLines 纯函数:JSON/YAML 双形态行号", () => {
    const jl = specPathLines(A3_SPEC, true, ["/api/orders", "/api/ghost", "/nope"]);
    expect(jl.get("/api/orders")).toBe(4);
    expect(jl.get("/api/ghost")).toBe(7);
    expect(jl.has("/nope")).toBe(false);
    const yaml = `openapi: 3.0.0\npaths:\n  /api/x:\n    get:\n      summary: t\n`;
    const yl = specPathLines(yaml, false, ["/api/x"]);
    expect(yl.get("/api/x")).toBe(3);
  });

  it("renderSpecBridgeEdges 冒烟", async () => {
    const r = await querySpecBridgeEdges(ws);
    const text = renderSpecBridgeEdges(r);
    expect(text).toContain("spec-reconcile");
    expect(text).toContain("/api/orders");
  }, 30_000);
});

// ============================ A4 ipc-channel ============================

const A4_ENUM = `export const enum IPC_MESSAGES {
  GET_DATA = 'GET_DATA',
  SAVE_DOC = 'SAVE_DOC',
}
`;

const A4_MAIN = `import { IPC_MESSAGES } from './common/ipc-messages';
declare const ipcMain: any;
declare function handleMessageSync(ch: string, fn: any): void;

ipcMain.handle(
  IPC_MESSAGES.GET_DATA,
  async (event: any) => ({}),
);
ipcMain.on("plain-channel", () => {});
handleMessageSync(IPC_MESSAGES.SAVE_DOC, () => {});
ipcMain.on(\`dyn-\${Date.now()}\`, () => {});
ipcMain.on(buildChannel(), () => {});
`;

const A4_RENDERER = `import { IPC_MESSAGES } from './common/ipc-messages';
declare const ipcRenderer: any;
declare function invokeSync(ch: string, ...args: any[]): any;

export function load() {
  return ipcRenderer.invoke(IPC_MESSAGES.GET_DATA);
}
export function save() {
  return invokeSync(IPC_MESSAGES.SAVE_DOC, 1);
}
export function plain() {
  ipcRenderer.send("plain-channel");
}
export function orphan() {
  ipcRenderer.invoke("orphan-channel");
}
export function listen() {
  ipcRenderer.on("main-push", () => {});
}
`;

describe("A4 ipc-channel(枚举 + 字面量 + wrapper)", () => {
  let ws = "";
  beforeAll(() => {
    ws = mkws();
    mkdirSync(join(ws, "common"), { recursive: true });
    writeFileSync(join(ws, "common", "ipc-messages.ts"), A4_ENUM);
    writeFileSync(join(ws, "main.ts"), A4_MAIN);
    writeFileSync(join(ws, "renderer.ts"), A4_RENDERER);
  });

  const OPTS = { extraWrappers: [{ name: "handleMessageSync", side: "main" as const }, { name: "invokeSync", side: "renderer" as const }] };

  it("枚举引用配对出 high 边(跨文件枚举表查表),双端证据行齐备", async () => {
    const r = await queryIpcChannelEdges(ws, OPTS);
    expect(r.state).toBe("ipc-connected");
    const e = r.edges.find((x) => x.channel === "GET_DATA");
    expect(e).toBeTruthy();
    expect(e!.confidence).toBe("high");
    expect(e!.note ?? "").toContain("枚举");
    expect(e!.from.file).toBe("renderer.ts");
    expect(e!.to.file).toBe("main.ts");
    expect(e!.from.line).toBeGreaterThan(0);
    expect(e!.to.line).toBeGreaterThan(0);
  }, 30_000);

  it("字面量通道配对 + wrapper 通道配对(extraWrappers 收编)", async () => {
    const r = await queryIpcChannelEdges(ws, OPTS);
    expect(r.edges.some((e) => e.channel === "plain-channel" && e.confidence === "high")).toBe(true);
    const save = r.edges.find((e) => e.channel === "SAVE_DOC");
    expect(save).toBeTruthy();
    expect(save!.to.call).toBe("handleMessageSync");
    expect(save!.from.call).toBe("invokeSync");
  }, 30_000);

  it("动态通道名登记不产边(C3);模板通道归一入单侧清单;孤儿通道入单侧清单;渲染侧监听不配主侧注册", async () => {
    const r = await queryIpcChannelEdges(ws, OPTS);
    // 纯动态(调用表达式)——unresolved 登记不出边
    expect(r.unresolved.some((s) => s.rawArg.includes("buildChannel()"))).toBe(true);
    expect(r.edges.some((e) => e.channel.includes("buildChannel"))).toBe(false);
    // 模板通道(静态前缀 ≥4):归一 dyn-* 入单侧清单,不配边
    expect(r.edges.some((e) => e.channel.includes("dyn-"))).toBe(false);
    expect(r.mainOnlyChannels).toContain("dyn-*");
    expect(r.rendererOnlyChannels).toContain("orphan-channel");
    // ipcRenderer.on("main-push") 是监听形态:不与主侧注册配对
    expect(r.edges.some((e) => e.channel === "main-push")).toBe(false);
  }, 30_000);

  it("parseEnumTables 纯函数:成员值+行号", () => {
    const t = parseEnumTables(A4_ENUM);
    const m = t.get("IPC_MESSAGES");
    expect(m?.get("GET_DATA")).toEqual({ value: "GET_DATA", line: 2 });
    expect(m?.get("SAVE_DOC")?.value).toBe("SAVE_DOC");
  });

  it("无 IPC 调用点仓态 → no-ipc-sites", async () => {
    const only = mkws();
    writeFileSync(join(only, "a.ts"), `export const x = 1;\n`);
    const r = await queryIpcChannelEdges(only);
    expect(r.state).toBe("no-ipc-sites");
    rmSync(only, { recursive: true, force: true });
  }, 30_000);

  it("renderIpcChannelEdges 冒烟", async () => {
    const r = await queryIpcChannelEdges(ws, OPTS);
    const text = renderIpcChannelEdges(r);
    expect(text).toContain("ipc-channel");
    expect(text).toContain("GET_DATA");
  }, 30_000);
});

// ============================ A5 abi-py-capi ============================

const A5_C = `#include <Python.h>

static PyObject *
mod_hello(PyObject *self, PyObject *args)
{
    Py_RETURN_NONE;
}

static PyObject *mod_world(PyObject *self) { Py_RETURN_NONE; }

static int mod_helper(int x) { return x + 1; }

static struct PyMethodDef mod_methods[] = {
    {"hello",
        (PyCFunction)mod_hello,
        METH_VARARGS, NULL},
    {"world", (PyCFunction)mod_world, METH_NOARGS, NULL},
    {"ghost", (PyCFunction)mod_ghost, METH_NOARGS, NULL},
    {NULL, NULL, 0, NULL}
};

static struct PyModuleDef moduledef = {
    .m_base = PyModuleDef_HEAD_INIT,
    .m_name = "mymod",
    .m_methods = mod_methods,
};

PyMODINIT_FUNC PyInit_mymod(void) {
    return PyModuleDef_Init(&moduledef);
}
`;

describe("A5 abi-py-capi(PyMethodDef × c_fn 定义)", () => {
  let ws = "";
  beforeAll(() => {
    ws = mkws();
    writeFileSync(join(ws, "mymod.c"), A5_C);
  });

  it("表项 ↔ 唯一 C 定义出 high 边(多行表项与单行表项同收),模块名绑定", async () => {
    const r = await queryPyCapiEdges(ws);
    expect(r.state).toBe("capi-connected");
    expect(r.edges.length).toBe(2);
    const hello = r.edges.find((e) => e.from.pyName === "hello");
    expect(hello).toBeTruthy();
    expect(hello!.from.module).toBe("mymod");
    expect(hello!.to.symbol).toBe("mod_hello");
    expect(hello!.to.line).toBe(4); // static PyObject * 换行形态,名字行
    const world = r.edges.find((e) => e.from.pyName === "world");
    expect(world).toBeTruthy();
    expect(world!.to.line).toBe(9); // 单行定义形态
  }, 30_000);

  it("定义未定位的表项入 unresolved 不产边(防幻觉)", async () => {
    const r = await queryPyCapiEdges(ws);
    expect(r.unresolved.map((u) => u.pyName)).toContain("ghost");
    expect(r.edges.some((e) => e.from.pyName === "ghost")).toBe(false);
    expect(r.ambiguous.length).toBe(0);
  }, 30_000);

  it("parsePyMethodDefTables 纯函数:表名/表项/哨兵排除", () => {
    const { entries, tableRanges } = parsePyMethodDefTables("mymod.c", A5_C);
    expect(tableRanges.length).toBe(1);
    expect(entries.length).toBe(3); // NULL 哨兵不收
    expect(entries[0]).toMatchObject({ pyName: "hello", cFn: "mod_hello", table: "mod_methods", module: "mymod" });
    expect(entries[1]).toMatchObject({ pyName: "world", cFn: "mod_world" });
  });

  it("无 PyMethodDef 仓态 → no-capi-tables", async () => {
    const only = mkws();
    writeFileSync(join(only, "plain.c"), `int main(void) { return 0; }\n`);
    const r = await queryPyCapiEdges(only);
    expect(r.state).toBe("no-capi-tables");
    rmSync(only, { recursive: true, force: true });
  }, 30_000);

  it("renderPyCapiEdges 冒烟", async () => {
    const r = await queryPyCapiEdges(ws);
    const text = renderPyCapiEdges(r);
    expect(text).toContain("abi-py-capi");
    expect(text).toContain("mymod.hello");
  }, 30_000);
});

// ============================ A6 rpc-proto ============================

const A6_PROTO = `syntax = "proto3";

package demo;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply) {}
  rpc Chat (stream HelloRequest) returns (stream HelloReply) {}
}

message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }
`;

const A6_STUB = `// Code generated by protoc-gen-go-grpc. DO NOT EDIT.
// source: proto/demo.proto

package demo

const (
	Greeter_SayHello_FullMethodName = "/demo.Greeter/SayHello"
	Greeter_Chat_FullMethodName = "/demo.Greeter/Chat"
)
`;

const A6_SERVER = `package main

type server struct{}

func (s *server) SayHello(ctx context.Context, in *pb.HelloRequest) (*pb.HelloReply, error) {
	return &pb.HelloReply{}, nil
}
`;

const A6_CLIENT = `package main

func call(c pb.GreeterClient) {
	r, err := c.SayHello(ctx, &pb.HelloRequest{})
	_ = r
	_ = err
}
`;

describe("A6 rpc-proto(proto ↔ 桩 ↔ 实现)", () => {
  let ws = "";
  beforeAll(() => {
    ws = mkws();
    mkdirSync(join(ws, "proto"), { recursive: true });
    mkdirSync(join(ws, "gen"), { recursive: true });
    mkdirSync(join(ws, "srv"), { recursive: true });
    writeFileSync(join(ws, "proto", "demo.proto"), A6_PROTO);
    writeFileSync(join(ws, "gen", "demo_grpc.pb.go"), A6_STUB);
    writeFileSync(join(ws, "srv", "server.go"), A6_SERVER);
    writeFileSync(join(ws, "srv", "client.go"), A6_CLIENT);
  });

  it("rpc → 生成桩(source 注释回链 + FullMethodName 常量行证据)", async () => {
    const r = await queryGrpcProtoEdges(ws);
    expect(r.state).toBe("grpc-connected");
    const stubEdges = r.edges.filter((e) => e.to.side === "stub");
    expect(stubEdges.length).toBe(2);
    const say = stubEdges.find((e) => e.from.rpc === "SayHello")!;
    expect(say.from.file).toBe("proto/demo.proto");
    expect(say.from.line).toBe(6);
    expect(say.to.file).toBe("gen/demo_grpc.pb.go");
    if (say.to.side === "stub") {
      expect(say.to.via).toBe("source-comment");
      expect(say.to.line).toBe(7); // FullMethodName 常量行
      expect(say.to.symbol).toBe("Greeter_SayHello_FullMethodName");
    }
  }, 30_000);

  it("rpc → hand-written 实现(方法名=rpc 名,非生成文件)", async () => {
    const r = await queryGrpcProtoEdges(ws);
    const impl = r.edges.find((e) => e.to.side === "impl" && e.from.rpc === "SayHello");
    expect(impl).toBeTruthy();
    expect(impl!.to.file).toBe("srv/server.go");
    expect(impl!.confidence).toBe("high");
    // Chat(流式签名,fixture 无实现)不出 impl 边
    expect(r.edges.some((e) => e.to.side === "impl" && e.from.rpc === "Chat")).toBe(false);
  }, 30_000);

  it("客户端调用点进 candidates 不混入正式边", async () => {
    const r = await queryGrpcProtoEdges(ws);
    expect(r.clientCalls.some((c) => c.rpc === "SayHello" && c.file === "srv/client.go")).toBe(true);
    expect(r.edges.every((e) => e.confidence === "high")).toBe(true);
  }, 30_000);

  it("parseProtoFile 纯函数:service/rpc/流式签名+行号", () => {
    const { services, rpcs } = parseProtoFile("demo.proto", A6_PROTO);
    expect(services).toEqual(["Greeter"]);
    expect(rpcs.length).toBe(2);
    expect(rpcs[1]).toMatchObject({ name: "Chat", reqType: "HelloRequest", respType: "HelloReply", line: 7 });
  });

  it("无 proto 仓态 → no-proto", async () => {
    const only = mkws();
    writeFileSync(join(only, "main.go"), `package main\nfunc main() {}\n`);
    const r = await queryGrpcProtoEdges(only);
    expect(r.state).toBe("no-proto");
    rmSync(only, { recursive: true, force: true });
  }, 30_000);

  it("renderGrpcProtoEdges 冒烟", async () => {
    const r = await queryGrpcProtoEdges(ws);
    const text = renderGrpcProtoEdges(r);
    expect(text).toContain("rpc-proto");
    expect(text).toContain("Greeter.SayHello");
  }, 30_000);

  it("rpc 名跨 service 重复:实现边降 medium 且双侧各出一条(归属歧义不裁决)", async () => {
    const w2 = mkws();
    mkdirSync(join(w2, "p"), { recursive: true });
    writeFileSync(join(w2, "p", "x.proto"), `syntax = "proto3";
service A { rpc Go (Req) returns (Resp) {} }
service B { rpc Go (Req) returns (Resp) {} }
message Req {}
message Resp {}
`);
    writeFileSync(join(w2, "x_grpc.pb.go"), `// Code generated by protoc-gen-go-grpc. DO NOT EDIT.
// source: p/x.proto
package x
const (
	A_Go_FullMethodName = "/A/Go"
	B_Go_FullMethodName = "/B/Go"
)
`);
    writeFileSync(join(w2, "impl.go"), `package main

func (s *server) Go(ctx context.Context, in *pb.Req) (*pb.Resp, error) { return nil, nil }
`);
    const r = await queryGrpcProtoEdges(w2);
    const impl = r.edges.filter((e) => e.to.side === "impl");
    expect(impl.length).toBe(2); // A.Go 与 B.Go 各一条
    expect(impl.every((e) => e.confidence === "medium")).toBe(true);
    expect(impl[0]!.note ?? "").toContain("归属歧义");
    // 桩边有 service 限定常量,仍 high
    const stubs = r.edges.filter((e) => e.to.side === "stub");
    expect(stubs.every((e) => e.confidence === "high")).toBe(true);
    rmSync(w2, { recursive: true, force: true });
  }, 30_000);
});
