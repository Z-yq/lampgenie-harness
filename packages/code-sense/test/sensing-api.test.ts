/**
 * sensing/http-api + openapi + semantic 测试( P1):
 * ① 六框架形态正例(FastAPI 含 APIRouter 前缀+include_router+websocket+route methods/
 *    Flask Blueprint url_prefix/express Router+use 前缀/Next.js 文件约定/Spring/gin);
 * ② 反例:无框架文件零误报;
 * ③ OpenAPI:JSON 全量对账三态(both/specOnly/codeOnly)+YAML 受控子集(含锚点 partial 降级);
 * ④ 语义层:stub LLM 四路径(正常挂载/坏引用修复环/修复后仍坏拒收计数/未注入 off);
 * ⑤ codeSense mode=api 端到端(auto 关键词判定+路径片段过滤+预算字段)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractEndpointsFromFile, extractApiSurface, normalizePath,
  parseSpecJson, parseSpecYamlSubset, reconcileSpec,
  queryApiSurface, renderApiSurface, setSensingDeps, codeSense,
  type SenseLlm, type ApiSurfaceResult,
} from "@lampgenie/code-sense";
// 单一真相源的两侧入口:对账函数来自 openapi 面,bridge spec 面来自 crosslang-bridge
// (均走子路径导入,与 crosslang-bridge-a2a6.test.ts 同口径)
import { reconcileForRoot, specFingerprint } from "@lampgenie/code-sense/sensing/openapi";
import { querySpecBridgeEdges } from "@lampgenie/code-sense/sensing/crosslang-bridge";

let ws = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "cssense-api-"));
});
afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  setSensingDeps({});
});

const FASTAPI_FILE = `from fastapi import FastAPI, APIRouter

app = FastAPI()
router = APIRouter(prefix="/v1")
legacy = APIRouter()

@router.get("/users/{uid}")
async def get_user(uid: int):
    """读取单个用户"""
    return {}

@router.post("/users", tags=["users"])
def create_user():
    return {}

@app.websocket("/ws/{cid}")
async def ws_endpoint(cid: str):
    pass

@app.route("/legacy", methods=["GET", "POST"])
def legacy_route():
    pass

@legacy.get("/unmounted")
def unmounted():
    pass

app.include_router(router, prefix="/api")
`;

const FLASK_FILE = `from flask import Flask, Blueprint

app = Flask(__name__)
bp = Blueprint("admin", __name__, url_prefix="/admin")

@app.route("/")
def index():
    return "ok"

@bp.route("/dashboard", methods=["GET"])
def dashboard():
    """管理面板"""
    return "ok"

app.register_blueprint(bp)
`;

const EXPRESS_FILE = `import express from "express";
const app = express();
const router = express.Router();

// 用户列表
router.get("/users", listUsers);
router.post("/users", async (req, res) => { res.json({}); });
app.get("/health", (req, res) => res.send("ok"));
app.use("/api", router);

function listUsers(req, res) {}
`;

const SPRING_FILE = `package com.example;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/{id}")
  public ResponseEntity<Order> get(@PathVariable String id) { return null; }

  @PostMapping
  public ResponseEntity<Void> create(@RequestBody Order o) { return null; }
}
`;

const GO_GIN_FILE = `package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	r.GET("/users/:id", getUser)
	r.POST("/users", createUser)
}

func getUser(c *gin.Context) {}
func createUser(c *gin.Context) {}
`;

// fixture:chi(方法化/Group 前缀拼装/Handle/常量+字面量拼接)
// 形态取样 poly-grafana(api.go/folder.go)与 poly-owncast(generated.gen.go/router.go)
const GO_CHI_FILE = `package api

import "github.com/go-chi/chi"

const adminPrefix = "/api/admin"

func (hs *HTTPServer) registerRoutes() {
	r := hs.RouteRegister
	r.Get("/logout", hs.Logout)
	r.Get("/login/:name", quota(string(auth.QuotaTargetSrv)), hs.OAuthLogin)
	r.Post("/login", requestmeta.SetOwner(requestmeta.TeamAuth), routing.Wrap(hs.LoginPost))
	r.Get("/swagger-ui", func(w http.ResponseWriter, r *http.Request) { })
	apiRoute.Group("/folders", func(folderRoute routing.RouteRegister) {
		folderRoute.Get("/id/:id", authorize(eval), routing.Wrap(hs.GetFolderByID))
		folderUidRoute := folderRoute
		folderRoute.Group("/:uid", func(folderUidRoute routing.RouteRegister) {
			folderUidRoute.Get("/permissions", hs.GetFolderPermissions)
		})
	})
}

func registerAdmin(r chi.Router) {
	r.Get(adminPrefix+"/status", wrapper.StatusAdmin)
	r.Post(adminPrefix+"/disconnect", wrapper.Disconnect)
	r.Get(options.BaseURL+"/chat", wrapper.GetChatMessages)
	m := http.NewServeMux()
	m.Handle("/api/admin/plugins", pluginAdmin)
	m.Handle(pluginAdminPath+"/registry/", pluginAdmin)
}

// 客户端取值形态不是路由(单参且首参非 "/" 字面量):Query().Get("forceLogin") 应零误报
func notRoutes(c *ctx) {
	orgID := c.Req.URL.Query().Get("orgId")
	_ = orgID
}
`;

const PLAIN_FILE = `export function add(a: number, b: number): number { return a + b; }
`;

// fixture:starlette(常量折叠/调用实参/多行/WS/methods)——形态取样 poly-streamlit
const STARLETTE_FILE = `from starlette.routing import Route, WebSocketRoute

BASE_ROUTE_CORE: Final = "_stcore"
ROUTE_HEALTH: Final = f"{BASE_ROUTE_CORE}/health"
_ROUTE_AUTH_LOGIN: Final = "auth/login"

def create_health_routes(runtime, base_url):
    """Create health check route handlers."""
    async def _health_endpoint(request):
        return ok
    return [
        Route(
            _with_base(ROUTE_HEALTH, base_url),
            _health_endpoint,
            methods=["GET", "HEAD"],
        ),
        Route(
            _with_base(ROUTE_HEALTH, base_url),
            _health_options,
            methods=["OPTIONS"],
        ),
    ]

def create_auth_routes(base_url):
    async def login(request):
        return ok
    return [
        Route(make_url_path(base_url, _ROUTE_AUTH_LOGIN), login, methods=["GET"]),
        WebSocketRoute(make_url_path(base_url or "", "_stcore/stream"), create_ws_handler(runtime)),
    ]

def docstring_guard():
    """docstring 里的 doctest 不算路由: routes=[Route("/health", health)]"""
    return None
`;

// fixture:Tornado(元组族)——形态取样 poly-jupyterlab
const TORNADO_FILE = `import tornado.web

class MainHandler(tornado.web.RequestHandler):
    def get(self):
        self.write("ok")

def make_app():
    return web.Application([
        (r"/", MainHandler),
        (r"/api/health", HealthHandler),
    ])

class LabExtension:
    def initialize_handlers(self):
        handlers = []
        handlers.append(
            (
                r"/custom/(.*)(?<!\\.js)$",
                self.settings["static_handler_class"],
                {"path": "/static"},
            )
        )

def register(web_app):
    web_app.add_handlers(".*$", [
        (ujoin(base_url, r"/listings/(.*)"), FileFindHandler, {"path": "list"}),
    ])
`;

// fixture:Flask-RESTful(add_resource 与子类化 add_org_resource;多行/多 url)
// 形态取样 poly-redash
const FLASK_RESTFUL_FILE = `from flask_restful import Api, Resource

class AlertResource(Resource):
    def get(self, alert_id):
        return {}

api = ApiExt()

api.add_org_resource(AlertResource, "/api/alerts/<alert_id>", endpoint="alert")

api.add_org_resource(
    DashboardListResource,
    "/api/dashboards",
    endpoint="dashboards",
)

api.add_resource(WidgetResource, "/api/widgets/<int:wid>", "/api/widgets", endpoint="widget")
`;

describe("http-api 框架形态提取", () => {
  it("FastAPI:decorator 全形态(router 前缀+挂载前缀+ws+route methods+docHint)", () => {
    const eps = extractEndpointsFromFile("web.py", FASTAPI_FILE);
    const byPath = new Map(eps.map((e) => [`${e.method} ${e.path}`, e]));
    expect(byPath.get("GET /api/v1/users/{uid}")?.handler).toBe("get_user");
    expect(byPath.get("GET /api/v1/users/{uid}")?.docHint).toContain("读取单个用户");
    expect(byPath.get("POST /api/v1/users")?.handler).toBe("create_user");
    expect(byPath.get("WS /ws/{cid}")?.kind).toBe("ws");
    expect(byPath.get("GET /legacy")).toBeTruthy();
    expect(byPath.get("POST /legacy")).toBeTruthy();
    // 未挂载 router:prefixInferred 标注,路径只含本地已知部分
    const unm = byPath.get("GET /unmounted");
    expect(unm?.prefixInferred).toBe(true);
    expect(eps.every((e) => e.file === "web.py" && e.line > 0)).toBe(true);
  });

  it("Flask:Blueprint url_prefix + register_blueprint", () => {
    const eps = extractEndpointsFromFile("app.py", FLASK_FILE);
    const paths = eps.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain("GET /");
    expect(paths).toContain("GET /admin/dashboard");
    expect(eps.find((e) => e.path === "/admin/dashboard")?.docHint).toContain("管理面板");
  });

  it("express:Router + app.use 前缀;箭头函数标 inline", () => {
    const eps = extractEndpointsFromFile("server.ts", EXPRESS_FILE);
    const byPath = new Map(eps.map((e) => [`${e.method} ${e.path}`, e]));
    expect(byPath.get("GET /api/users")?.handler).toBe("listUsers");
    expect(byPath.get("GET /api/users")?.docHint).toContain("用户列表");
    expect(byPath.get("POST /api/users")?.handlerInline).toBe(true);
    expect(byPath.get("GET /health")).toBeTruthy();
  });

  it("Next.js 文件约定:pages/api 与 app/api/route", () => {
    const a = extractEndpointsFromFile("pages/api/users/[id].ts", `export function GET(req: Request) { return null; }\nexport function POST() {}\n`);
    expect(a.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /api/users/{id}", "POST /api/users/{id}"]);
    const b = extractEndpointsFromFile("app/api/health/route.ts", `export async function GET() {}\n`);
    expect(b.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /api/health"]);
  });

  it("Spring:类级 @RequestMapping 前缀 × 方法级 @*Mapping", () => {
    const eps = extractEndpointsFromFile("OrderController.java", SPRING_FILE);
    const paths = eps.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain("GET /api/orders/{id}");
    expect(paths).toContain("POST /api/orders");
    expect(eps[0]?.handler).toBe("get");
  });

  it("gin:r.GET 族", () => {
    const eps = extractEndpointsFromFile("main.go", GO_GIN_FILE);
    expect(eps.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /users/{id}".replace("{id}", ":id"), "POST /users"]);
    expect(eps[0]?.handler).toBe("getUser");
  });

  it("反例:无框架文件零误报", () => {
    expect(extractEndpointsFromFile("util.ts", PLAIN_FILE)).toEqual([]);
    expect(extractEndpointsFromFile("plain.py", `def helper():\n    return 1\n`)).toEqual([]);
  });
});

// ============================== 后端提取器族补齐(RC-M/RC-N 上游) ==============================

describe(" starlette 提取(常量折叠/调用实参/多行/WS/docstring 守卫)", () => {
  const byPath = (eps: ReturnType<typeof extractEndpointsFromFile>) =>
    new Map(eps.map((e) => [`${e.method} ${e.path}`, e]));

  it("const f-string 折叠 + 调用实参 prefixInferred + methods 展开 + WS", () => {
    const eps = extractEndpointsFromFile("routes.py", STARLETTE_FILE);
    const m = byPath(eps);
    // ROUTE_HEALTH = f"{BASE_ROUTE_CORE}/health" → /_stcore/health;_with_base() 运行时前缀 → pi
    expect(m.get("GET /_stcore/health")?.prefixInferred).toBe(true);
    expect(m.get("GET /_stcore/health")?.handler).toBe("_health_endpoint");
    expect(m.get("HEAD /_stcore/health")).toBeTruthy();
    expect(m.get("OPTIONS /_stcore/health")).toBeTruthy();
    // make_url_path(base_url, _ROUTE_AUTH_LOGIN) → /auth/login
    expect(m.get("GET /auth/login")?.handler).toBe("login");
    expect(m.get("GET /auth/login")?.prefixInferred).toBe(true);
    // WebSocketRoute → kind=ws
    const ws = eps.find((e) => e.kind === "ws");
    expect(ws?.path).toBe("/_stcore/stream");
    expect(ws?.method).toBe("WS");
    // 单行 docstring 内的 Route 示例不提取(docstring 守卫)
    expect(m.get("GET /health")).toBeUndefined();
    expect(eps.every((e) => e.framework === "starlette")).toBe(true);
  });

  it("纯字面量形态精确无 pi", () => {
    const eps = extractEndpointsFromFile("r.py", `from starlette.routing import Route\nRoute("/health", h, methods=["GET"])\n`);
    expect(eps.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /health"]);
    expect(eps[0]?.prefixInferred).toBeUndefined();
  });
});

describe(" Tornado 提取(web.Application 元组/handlers.append/add_handlers)", () => {
  it("三形态:Application 列表/append 元组 regex 清洗/add_handlers 调用实参", () => {
    const eps = extractEndpointsFromFile("app.py", TORNADO_FILE);
    const m = new Map(eps.map((e) => [e.path, e]));
    expect(m.get("/")?.handler).toBe("MainHandler");
    expect(m.get("/api/health")?.handler).toBe("HealthHandler");
    // regex 尾巴确定性清洗:(.*)→{*},剥 lookaround 与 $
    expect(m.get("/custom/{*}")).toBeTruthy();
    expect(eps.find((e) => e.path === "/custom/{*}")?.handler).toBeUndefined();
    // ujoin(base_url, r"/listings/(.*)") → /listings/{*} + pi
    const lst = m.get("/listings/{*}");
    expect(lst?.handler).toBe("FileFindHandler");
    expect(lst?.prefixInferred).toBe(true);
    expect(eps.every((e) => e.framework === "tornado" && e.method === "ANY")).toBe(true);
 // P0:元组行号必须是各自路由行(旧实现全部落在 web.Application 行)
    const rootEp = m.get("/");
    const healthEp = m.get("/api/health");
    expect(rootEp?.line).toBe(9);   // (r"/", MainHandler),
    expect(healthEp?.line).toBe(10); // (r"/api/health", HealthHandler),
  });
});

describe(" Flask-RESTful 提取(add_resource 与子类化 add_org_resource)", () => {
  it("多 url 多行调用;handler=资源类;ANY 如实", () => {
    const eps = extractEndpointsFromFile("api.py", FLASK_RESTFUL_FILE);
    const m = new Map(eps.map((e) => [e.path, e]));
    expect(m.get("/api/alerts/<alert_id>")?.handler).toBe("AlertResource");
    expect(m.get("/api/dashboards")?.handler).toBe("DashboardListResource");
    expect(m.get("/api/widgets/<int:wid>")?.handler).toBe("WidgetResource");
    expect(m.get("/api/widgets")?.handler).toBe("WidgetResource");
    expect(eps).toHaveLength(4);
    expect(eps.every((e) => e.framework === "flask-restful" && e.method === "ANY")).toBe(true);
  });
});

describe(" Go chi 提取(方法化/Group 前缀拼装/Handle/常量+字面量)", () => {
  it("中间件链 handler、Group 嵌套前缀、const 拼接精确、字段拼接 pi、Handle、客户端取值零误报", () => {
    const eps = extractEndpointsFromFile("api.go", GO_CHI_FILE);
    const m = new Map(eps.map((e) => [e.path, e]));
    expect(m.get("/logout")?.handler).toBe("Logout");
    expect(m.get("/login/:name")?.handler).toBe("OAuthLogin");
    expect(m.get("/login")?.handler).toBe("LoginPost"); // routing.Wrap 解包
    expect(m.get("/swagger-ui")?.handlerInline).toBe(true); // inline func
    // Group 前缀拼装(含嵌套)
    expect(m.get("/folders/id/:id")?.handler).toBe("GetFolderByID");
    expect(m.get("/folders/:uid/permissions")?.handler).toBe("GetFolderPermissions");
    // const 拼接=adminPrefix 值回填,精确无 pi
    expect(m.get("/api/admin/status")?.prefixInferred).toBeUndefined();
    expect(m.get("/api/admin/status")?.handler).toBe("StatusAdmin");
    expect(m.get("/api/admin/disconnect")?.method).toBe("POST");
    // 字段拼接=options.BaseURL 不可静态解析 → 字面量尾段 + pi
    expect(m.get("/chat")?.prefixInferred).toBe(true);
    expect(m.get("/chat")?.handler).toBe("GetChatMessages");
    // Handle 字面量
    expect(m.get("/api/admin/plugins")?.method).toBe("ANY");
    expect(m.get("/api/admin/plugins")?.handler).toBe("pluginAdmin");
    expect(m.get("/registry/")?.prefixInferred).toBe(true);
    // 客户端取值形态零误报
    expect([...m.keys()].filter((k) => k.includes("orgId"))).toEqual([]);
    expect(eps.every((e) => e.framework === "chi")).toBe(true);
  });

  it("gin 与 chi 天然不交:同一 Go 文件两族各取各的", () => {
    const both = `package main
import "github.com/gin-gonic/gin"
import "github.com/go-chi/chi"
func reg(g *gin.Engine, r chi.Router) {
	g.GET("/old", oldHandler)
	r.Get("/new", newHandler)
}
`;
    const eps = extractEndpointsFromFile("mix.go", both);
    const ginEp = eps.find((e) => e.framework === "gin");
    const chiEp = eps.find((e) => e.framework === "chi");
    expect(ginEp?.path).toBe("/old");
    expect(chiEp?.path).toBe("/new");
  });
});

describe("openapi 规范消费与对账", () => {
  it("JSON 全量:三态(both/specOnly/codeOnly)", () => {
    const spec = parseSpecJson("openapi.json", JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/api/users": { get: { summary: "用户列表" } },
        "/api/ghost": { post: { summary: "幽灵接口(代码无)" } },
      },
    }));
    expect(spec.parse).toBe("full");
    const code = extractEndpointsFromFile("s.ts", EXPRESS_FILE);
    const rc = reconcileSpec(spec, code);
    // normalize: code 的 /api/users(GET) 应与 spec 对上
    expect(rc.both.map((b) => `${b.method} ${b.path}`)).toContain("GET /api/users");
    expect(rc.specOnly.map((s) => `${s.method} ${s.path}`)).toContain("POST /api/ghost");
    expect(rc.codeOnly.some((c) => c.path === "/health")).toBe(true);
  });

  it("YAML 受控子集:正常解析 + 锚点形态 partial 降级", () => {
    const good = `openapi: 3.0.0
paths:
  /users:
    get:
      summary: 用户列表
      operationId: listUsers
    post:
      description: 创建用户
  /health:
    get:
      summary: "健康检查"
info:
  title: demo
`;
    const r = parseSpecYamlSubset("openapi.yaml", good);
    expect(r.parse).toBe("full");
    expect(r.operations.map((o) => `${o.method} ${o.path}`)).toEqual(["GET /users", "POST /users", "GET /health"]);
    expect(r.operations[0]?.summary).toBe("用户列表");

    const bad = `paths:
  /users:
    get:
      summary: 列表
  /bad:
    $ref: '#/components/ref'
`;
    const r2 = parseSpecYamlSubset("openapi.yaml", bad);
    expect(r2.operations.length).toBeGreaterThan(0);
    // $ref 行不含锚点字符所以不触发 partial;真正触发:多行块
    const withBlock = `paths:
  /users:
    get:
      description: |
        多行块描述
        第二行
      summary: 列表
`;
    const r3 = parseSpecYamlSubset("openapi.yaml", withBlock);
    expect(r3.parse).toBe("partial");
    expect(r3.notes.length).toBeGreaterThan(0);
  });

  it("normalizePath::id 与 {id} 同形", () => {
    expect(normalizePath("/users/:id")).toBe("/users/{}");
    expect(normalizePath("/users/{uid}")).toBe("/users/{}");
    expect(normalizePath("/a/b/")).toBe("/a/b");
  });
});

describe("queryApiSurface 仓级编排(真实文件系统)", () => {
  beforeAll(() => {
    mkdirSync(join(ws, "svc"), { recursive: true });
    writeFileSync(join(ws, "svc", "web.py"), FASTAPI_FILE);
    writeFileSync(join(ws, "svc", "plain.py"), PLAIN_FILE.replace("export function add(a: number, b: number): number { return a + b; }", "def add(a, b):\n    return a + b\n"));
    writeFileSync(join(ws, "openapi.json"), JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/api/v1/users/{uid}": { get: { summary: "读取单个用户(规范版)" } },
        "/api/v1/ghost": { delete: { summary: "幽灵" } },
      },
    }));
  });

  it("端到端:指纹预筛→提取→spec 对账;无索引=影响面显式降级;无语义注入=off", async () => {
    const r = await queryApiSurface(ws, { refresh: true });
    expect(r.endpoints.length).toBeGreaterThanOrEqual(6);
    expect(r.frameworks).toContain("fastapi");
    // spec 对账:GET /api/v1/users/{uid} 应 both
    expect(r.reconcile?.both.map((b) => `${b.method} ${b.path}`)).toContain("GET /api/v1/users/{uid}");
    expect(r.reconcile?.specOnly.map((s) => `${s.method} ${s.path}`)).toContain("DELETE /api/v1/ghost");
    // 无索引:影响面降级
    expect(r.indexJoin.status).toBe("degraded");
    expect(r.indexJoin.reason).toContain("索引未构建");
    // 未注入 LLM:语义层 off(不假报)
    expect(r.semanticLayer.status).toBe("off");
    expect(r.endpoints.every((e) => e.semantic === undefined)).toBe(true);
  });

  it("语义层四路径(stub LLM)", async () => {
    // 路径1:合法输出挂载
    const good: SenseLlm = {
      async generate() {
        return JSON.stringify({
          items: [
            { ref: "E1", summary: "按 id 读取单个用户信息", evidenceRef: "E1" },
            { ref: "E2", summary: "创建新用户", evidenceRef: "E2" },
          ],
        });
      },
    };
    setSensingDeps({ senseLlm: good });
    const r1 = await queryApiSurface(ws, { refresh: true, withSemantics: true });
    expect(r1.semanticLayer.status).toBe("ok");
    expect(r1.endpoints[0]?.semantic).toBeTruthy();

    // 路径2:坏引用→修复环纠正
    let calls = 0;
    const fixable: SenseLlm = {
      async generate() {
        calls++;
        if (calls === 1) return JSON.stringify({ items: [{ ref: "E1", summary: "x", evidenceRef: "E99" }] });
        return JSON.stringify({ items: [{ ref: "E1", summary: "按 id 读用户", evidenceRef: "E1" }] });
      },
    };
    setSensingDeps({ senseLlm: fixable });
    const r2 = await queryApiSurface(ws, { refresh: true, withSemantics: true });
    expect(calls).toBe(2);
    expect(r2.semanticLayer.status).toBe("ok");
    expect(r2.semanticLayer.repairs).toBeGreaterThanOrEqual(1);

    // 路径3:修复环后仍坏→拒收计数,不留占位
    const bad: SenseLlm = { async generate() { return JSON.stringify({ items: [{ ref: "FAKE", summary: "编造", evidenceRef: "FAKE" }] }); } };
    setSensingDeps({ senseLlm: bad });
    const r3 = await queryApiSurface(ws, { refresh: true, withSemantics: true });
    expect(r3.semanticLayer.dropped).toBeGreaterThan(0);
    expect(r3.endpoints.every((e) => !e.semantic || e.semantic !== "编造")).toBe(true);

    // 路径4:非法 JSON→修复环→仍坏→failed 但确定性清单完整
    const garbage: SenseLlm = { async generate() { return "这不是JSON"; } };
    setSensingDeps({ senseLlm: garbage });
    const r4: ApiSurfaceResult = await queryApiSurface(ws, { refresh: true, withSemantics: true });
    expect(r4.semanticLayer.status).toBe("failed");
    expect(r4.endpoints.length).toBeGreaterThanOrEqual(6); // 确定性层不受语义层失败影响
    setSensingDeps({});
  });
});

describe("codeSense mode=api 接入面", () => {
  it("auto 判定:「有哪些接口」→ api;路径片段过滤;证据行齐全", async () => {
    const r = await codeSense(ws, "这个服务有哪些接口", {});
    expect(r.mode).toBe("api");
    expect(r.autoDecision?.picked).toBe("api");
    expect(r.api).toBeTruthy();
    expect(r.api!.endpoints.length).toBeGreaterThanOrEqual(6);
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.evidence[0]?.line).toBeGreaterThan(0);

    const r2 = await codeSense(ws, "/v1/users 接口做什么", { mode: "api" });
    expect(r2.api!.endpoints.length).toBeGreaterThan(0);
    expect(r2.api!.endpoints.every((e) => e.path.includes("/v1/users"))).toBe(true);

    // 未注入语义层:显式降级条目在场
    expect(r.degraded?.some((d) => d.layer === "sensing-semantic")).toBe(true);
  });

  it("反例:无接口仓显式降级(不冒充空清单)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cssense-empty-"));
    mkdirSync(join(empty, "src"), { recursive: true });
    writeFileSync(join(empty, "src", "util.ts"), PLAIN_FILE);
    const r = await codeSense(empty, "有哪些接口", {});
    expect(r.api?.endpoints).toEqual([]);
    expect(r.degraded?.some((d) => d.layer === "sensing-api")).toBe(true);
    rmSync(empty, { recursive: true, force: true });
  });
});

// ============================ RC-M 余量四形态 ============================

describe(" starlette Mount(内联 routes=/变量 routes=/运行时变量前缀/app= 边界)", () => {
  it("Mount 内路由继承前缀:字面量精确/运行时变量 pi/嵌套复合/app= 零端点/变量列表绑定", () => {
    const text = `from starlette.routing import Mount, Route, WebSocketRoute

def health(req): pass
def deep(req): pass
def sub(req): pass
def ws(req): pass

sub_routes = [
    Route("/deep", deep),
]

routes = [
    Mount("/api", routes=[
        Route("/health", health, methods=["GET"]),
        Mount("/v2", routes=[Route("/inner", deep)]),
        WebSocketRoute("/ws", ws),
    ]),
    Mount(mount_path, routes=sub_routes),
    Mount("/static", app=static_assets_app),
]
`;
    const eps = extractEndpointsFromFile("app.py", text);
    const byPath = new Map(eps.map((e) => [`${e.method} ${e.path}`, e]));
    // 字面量 Mount 前缀精确
    expect(byPath.get("GET /api/health")?.prefixInferred).toBeUndefined();
    // 嵌套 Mount 前缀复合
    expect(byPath.get("ANY /api/v2/inner")).toBeDefined();
    // WS 端点在 Mount 内
    expect(byPath.get("WS /api/ws")?.kind).toBe("ws");
    // 变量 routes 列表绑定 + 运行时变量前缀 → 内层路径本地部分 + pi
    const deep = byPath.get("ANY /deep");
    expect(deep).toBeDefined();
    expect(deep?.prefixInferred).toBe(true);
    // app= 子应用形态零端点(static_assets_app 内路由不在本文件,不猜)
    expect(eps.some((e) => e.path.startsWith("/static"))).toBe(false);
    // 行号=Route 真实行
    const health2 = byPath.get("GET /api/health")!;
    expect(text.split("\n")[health2.line - 1]).toContain('Route("/health"');
  });
});

describe(" chi 跨行路由(grafana dashboardimport/ngalert 形态)", () => {
  it("多行方法化调用+toMacaronPath 包裹+深层 Wrap handler+单行形态不回退", () => {
    const text = `package api

import "github.com/go-chi/chi"

func (api *ImportDashboardAPI) RegisterAPIEndpoints(routeRegister routing.RouteRegister) {
	routeRegister.Group("/api/dashboards", func(route routing.RouteRegister) {
		route.Post(
			"/import",
			authorize(accesscontrol.EvalPermission(dashboards.ActionDashboardsCreate)),
			routing.Wrap(api.ImportDashboard),
		)
		route.Get(
			toMacaronPath("/api/prometheus/{DatasourceUID}/api/v1/alerts"),
			requestmeta.SetOwner(requestmeta.TeamAlerting),
			metrics.Instrument(
				http.MethodGet,
				"/api/prometheus/{DatasourceUID}/api/v1/alerts",
				api.Hooks.Wrap(srv.RouteGetAlertStatuses),
				m),
		)
		route.Delete("/single", routing.Wrap(api.DeleteDashboard))
	}, middleware.ReqSignedIn)
}
`;
    const eps = extractEndpointsFromFile("pkg/api/api.go", text).filter((e) => e.framework === "chi");
    const byPath = new Map(eps.map((e) => [`${e.method} ${e.path}`, e]));
    // 跨行 + Group 前缀拼装 + Wrap handler
    const imp = byPath.get("POST /api/dashboards/import");
    expect(imp).toBeDefined();
    expect(imp?.handler).toBe("ImportDashboard");
    // toMacaronPath 包裹(纯路径变换 callee)→ 精确不标 pi;深层 Wrap 解出真 handler
    const prom = byPath.get("GET /api/dashboards/api/prometheus/{DatasourceUID}/api/v1/alerts");
    expect(prom).toBeDefined();
    expect(prom?.prefixInferred).toBeUndefined();
    expect(prom?.handler).toBe("RouteGetAlertStatuses");
    // 单行形态不回退
    expect(byPath.get("DELETE /api/dashboards/single")?.handler).toBe("DeleteDashboard");
  });
});

describe(" Flask 调用包裹路径(一期,org_scoped_rule 形态)", () => {
  it("@routes.route(helper(\"/x\")) 取内层字面量+pi;纯字面量保持精确", () => {
    const text = `from flask import Blueprint

bp = Blueprint("auth", __name__)

@bp.route("/plain", methods=["GET"])
def plain():
    pass

@bp.route(org_scoped_rule("/login"), methods=["GET", "POST"])
def login():
    pass
`;
    const eps = extractEndpointsFromFile("views.py", text);
    const byPath = new Map(eps.map((e) => [`${e.method} ${e.path}`, e]));
    // 纯字面量路径精确提取(本文件定义未注册 blueprint 的 pi 标记是一期既有语义,非本步面)
    expect(byPath.get("GET /plain")).toBeDefined();
    const login = byPath.get("POST /login");
    expect(login).toBeDefined();
    expect(login?.prefixInferred).toBe(true); // 调用包裹路径:包装器语义静态未知,如实标注
    expect(login?.handler).toBe("login");
  });
});

describe(" 仓级:Tornado 变量绑定元组+import 常量+Handler 方法级绑定", () => {
  it("labapp 形态:import 常量路径+变量绑定元组+跨文件 Handler.get/post 方法级展开", async () => {
    const { dir, cleanup } = fixturePyRepo({
      "pkg/labapp.py": `from tornado import web
from .handlers.build_handler import BuildHandler, build_path
from .handlers.error_handler import ErrorHandler

class LabApp:
    def initialize_handlers(self):
        handlers = []
        build_handler = (
            build_path,
            BuildHandler,
            {"builder": None},
        )
        handlers.append(build_handler)
        handlers.append(
            (
                r"/custom/(.*)(?<!\\.js)$",
                ErrorHandler,
                {"messages": []},
            )
        )
        self.serverapp.web_app.add_handlers(".*$", handlers)
`,
      "pkg/handlers/build_handler.py": `from tornado import web

build_path = r"/lab/api/build"

class BuildHandler(web.RequestHandler):
    @web.authenticated
    def get(self):
        pass

    def post(self):
        pass

    def delete(self):
        pass
`,
      "pkg/handlers/error_handler.py": `from tornado import web

class ErrorHandler(web.RequestHandler):
    def get(self):
        pass
`,
    });
    try {
      const r = await extractApiSurface(dir, ["pkg/labapp.py", "pkg/handlers/build_handler.py", "pkg/handlers/error_handler.py"]);
      const tornado = r.endpoints.filter((e) => e.framework === "tornado");
      const keys = new Set(tornado.map((e) => `${e.method} ${e.path} -> ${e.handler ?? "-"}`));
      // import 常量路径解析 + 变量绑定元组 + 方法级展开(BuildHandler get/post/delete)
      expect(keys.has("GET /lab/api/build -> BuildHandler")).toBe(true);
      expect(keys.has("POST /lab/api/build -> BuildHandler")).toBe(true);
      expect(keys.has("DELETE /lab/api/build -> BuildHandler")).toBe(true);
      // 方法级展开后不再保留该 handler 的 ANY 形式
      expect(tornado.some((e) => e.handler === "BuildHandler" && e.method === "ANY")).toBe(false);
      // 同文件内联元组 + 跨文件同形态:ErrorHandler 仅 get
      expect(keys.has("GET /custom/{*} -> ErrorHandler")).toBe(true);
      expect(keys.has("ANY /custom/{*} -> ErrorHandler")).toBe(false);
      // 路径清洗语义保持(regex 尾巴)
      expect(tornado.some((e) => e.path.includes("(.*)"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("边界:import 解析不到/类无 HTTP 方法=保留 ANY 不猜", async () => {
    const { dir, cleanup } = fixturePyRepo({
      "app.py": `from tornado import web
from .missing import LostHandler

app = web.Application([
    (r"/lost", LostHandler),
    (r"/plain", PlainHandler),
])

class PlainHandler:
    pass
`,
    });
    try {
      const r = await extractApiSurface(dir, ["app.py"]);
      const tornado = r.endpoints.filter((e) => e.framework === "tornado");
      // import 目标不存在 → 类不可解析 → ANY 保留
      expect(tornado.some((e) => e.path === "/lost" && e.method === "ANY" && e.handler === "LostHandler")).toBe(true);
      // 同文件类无 HTTP 方法 → ANY 保留
      expect(tornado.some((e) => e.path === "/plain" && e.method === "ANY")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe(" 仓级:Flask blueprint 跨文件挂载(redash 形态)", () => {
  it("定义/使用/注册分居三文件:import 解析 recv + 注册表前缀合成 + 同文件升级", async () => {
    const { dir, cleanup } = fixturePyRepo({
      "app/base.py": `from flask import Blueprint

routes = Blueprint("redash", __name__, template_folder="templates")
`,
      "app/views.py": `from flask import redirect
from .base import routes

@routes.route("/login", methods=["GET", "POST"])
def login():
    pass

@routes.route(org_scoped_rule("/logout"))
def logout():
    pass
`,
      "app/__init__.py": `from flask import Flask
from .base import routes

def init_app(app):
    app.register_blueprint(routes)
`,
      "app/admin.py": `from flask import Blueprint
from .base import routes

admin_bp = Blueprint("admin", __name__, url_prefix="/admin")

@admin_bp.route("/users")
def users():
    pass
`,
      "app/setup.py": `from flask import Flask
from .admin import admin_bp

def setup(app):
    app.register_blueprint(admin_bp, url_prefix="/api")
`,
    });
    try {
      const files = ["app/base.py", "app/views.py", "app/__init__.py", "app/admin.py", "app/setup.py"];
      const r = await extractApiSurface(dir, files);
      const keys = new Map(r.endpoints.map((e) => [`${e.method} ${e.path}@${e.file}:${e.line}`, e]));
      // import 解析 recv(routes 在 views.py 未定义,一期守卫拒绝面)——跨文件注册无 url_prefix →
      // 路径=定义前缀+规则,pi 清除(挂载点已知)
      const login = [...keys.values()].find((e) => e.path === "/login" && e.method === "POST");
      expect(login).toBeDefined();
      expect(login?.handler).toBe("login");
      expect(login?.prefixInferred).toBeUndefined();
      // 调用包裹路径(org_scoped_rule)→ 字面量 + pi(包装器语义静态未知)
      const logout = [...keys.values()].find((e) => e.path === "/logout");
      expect(logout?.prefixInferred).toBe(true);
      // 定义 url_prefix × 注册 url_prefix 合成
      const users = [...keys.values()].find((e) => e.path === "/api/admin/users");
      expect(users).toBeDefined();
      expect(users?.handler).toBe("users");
      expect(users?.prefixInferred).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("注册不可解析(循环变量/工厂调用)=保留 pi 不猜(redash authentication 形态)", async () => {
    const { dir, cleanup } = fixturePyRepo({
      "auth/google.py": `from flask import Blueprint

def create_blueprint(app):
    blueprint = Blueprint("google_oauth", __name__)

    @blueprint.route("/oauth/google")
    def login():
        pass

    return blueprint
`,
      "auth/__init__.py": `from flask import Flask
from . import google

def init_app(app):
    for blueprint in [google.create_blueprint(app)]:
        app.register_blueprint(blueprint)
`,
    });
    try {
      const r = await extractApiSurface(dir, ["auth/google.py", "auth/__init__.py"]);
      const login = r.endpoints.find((e) => e.path === "/oauth/google");
      expect(login).toBeDefined();
      expect(login?.prefixInferred).toBe(true); // 循环变量注册不可静态归属 → 保持推断标记
    } finally {
      cleanup();
    }
  });
});

// ============================ 非产品路径过滤(P1-1 ============================

describe("queryApiSurface 非产品路径过滤(docs/examples 不是这个服务提供的接口)", () => {
 // py-fastapi 注意形态:docs_src/** 教程里的 @app.get 被算成产品端点
  const PRODUCT_APP = `from fastapi import FastAPI

app = FastAPI()

@app.get("/items")
def list_items():
    return []
`;

  const DOCS_TUTORIAL = `from fastapi import FastAPI

app = FastAPI()

@app.get("/tutorial/only")
def tutorial_only():
    return {}
`;

  const EXAMPLES_APP = `from fastapi import FastAPI

app = FastAPI()

@app.get("/example/only")
def example_only():
    return {}
`;

  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cssense-apifilter-"));
    mkdirSync(join(dir, "svc"), { recursive: true });
    mkdirSync(join(dir, "docs_src"), { recursive: true });
    mkdirSync(join(dir, "examples"), { recursive: true });
    writeFileSync(join(dir, "svc", "app.py"), PRODUCT_APP);
    writeFileSync(join(dir, "docs_src", "tutorial.py"), DOCS_TUTORIAL);
    writeFileSync(join(dir, "examples", "demo.py"), EXAMPLES_APP);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("docs_src/examples 端点被过滤 + pathFilter 呈报 + render 注记;all=true 重新出现", async () => {
    const r = await queryApiSurface(dir, { refresh: true });
    const paths = r.endpoints.map((e) => e.path);
    // ① 过滤生效:产品端点在场,docs/examples 端点不在
    expect(paths).toContain("/items");
    expect(paths).not.toContain("/tutorial/only");
    expect(paths).not.toContain("/example/only");
    expect(r.endpoints.every((e) => !e.file.startsWith("docs_src/") && !e.file.startsWith("examples/"))).toBe(true);
    // ② 诚实呈报:filtered>0 且 note 非空
    expect(r.pathFilter).toBeTruthy();
    expect(r.pathFilter!.filtered).toBeGreaterThan(0);
    expect(r.pathFilter!.note.length).toBeGreaterThan(0);
    expect(r.pathFilter!.note).toContain("--all");
    // 渲染面首行之后立即输出过滤注记
    const text = renderApiSurface(r);
    expect(text.split("\n")[1]).toContain("[路径过滤]");
    // ③ 逃生口:all=true 文件重新出现(过滤非静默丢弃,可审计回溯)
    const all = await queryApiSurface(dir, { refresh: true, all: true });
    const allPaths = all.endpoints.map((e) => e.path);
    expect(allPaths).toContain("/tutorial/only");
    expect(allPaths).toContain("/example/only");
    expect(all.pathFilter).toBeUndefined();
  });

  it("过滤后清零也不静默:只剩 docs/ 端点时 pathFilter 仍在、note 说明为何空", async () => {
    const only = mkdtempSync(join(tmpdir(), "cssense-apifilter-only-"));
    mkdirSync(join(only, "docs"), { recursive: true });
    writeFileSync(join(only, "docs", "tutorial.py"), DOCS_TUTORIAL);
    try {
      const r = await queryApiSurface(only, { refresh: true });
      expect(r.endpoints).toEqual([]);
      expect(r.pathFilter?.filtered).toBeGreaterThan(0);
      expect(r.pathFilter?.note).toContain("已过滤");
      expect(renderApiSurface(r)).toContain("[路径过滤]");
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  });
});

/** 多文件 py 仓夹具(子目录支持)。 */
function fixturePyRepo(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cssense-rcm-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// =================== OpenAPI 对账单一真相源 + spec 指纹缓存失效 ===================
// 背景:api 面(sensing/index.ts)与 bridge spec 面(crosslang-bridge.ts 的
// querySpecBridgeEdges)原各串一遍 findSpecFiles→parseSpecFile→reconcileSpec,且 api 面的
// 60s TTL 缓存键只含源码扩展名指纹(不含 openapi.*/swagger.*)→ 长驻进程内改 spec 不失效。
// 本组用例锁死:①两面同源一致 ②spec 变动使缓存失效 ③无 spec 的回归态。

const SPEC_SRC_APP = `from flask import Flask

app = Flask(__name__)

@app.route("/api/orders", methods=["POST"])
def create_order():
    return {}

@app.route("/api/extra")
def extra():
    return {}
`;

const SPEC_JSON_TWO_OPS = `{
  "openapi": "3.0.0",
  "paths": {
    "/api/orders": {
      "post": { "summary": "创建订单" }
    },
    "/api/ghost": {
      "get": { "summary": "规范声称存在、代码未实现" }
    }
  }
}
`;

/** spec 变更版:删掉 /api/ghost,加 /api/newer(summary 也换)→ 三计数应整体变化。 */
const SPEC_JSON_CHANGED = `{
  "openapi": "3.0.0",
  "paths": {
    "/api/orders": {
      "post": { "summary": "创建订单 v2" }
    },
    "/api/newer": {
      "get": { "summary": "新增规范条目" }
    }
  }
}
`;

describe("OpenAPI 对账单一真相源(reconcileForRoot)+ spec 指纹缓存键", () => {
  it("同源一致:api 面 reconcile 与 bridge spec 面三计数/归一化主键完全相等", async () => {
    const { dir, cleanup } = fixturePyRepo({ "app.py": SPEC_SRC_APP, "openapi.json": SPEC_JSON_TWO_OPS });
    try {
      const api = await queryApiSurface(dir, { refresh: true, withImpact: false });
      const bridge = await querySpecBridgeEdges(dir);
      expect(api.reconcile).toBeTruthy();
      // ① 三计数逐项相等(both/specOnly/codeOnly)
      expect(api.reconcile!.both.length).toBe(bridge.stats.both);
      expect(api.reconcile!.specOnly.length).toBe(bridge.stats.specOnly);
      expect(api.reconcile!.codeOnly.length).toBe(bridge.stats.codeOnly);
      expect(bridge.stats.both).toBe(1);      // POST /api/orders
      expect(bridge.stats.specOnly).toBe(1);  // GET /api/ghost
      expect(bridge.stats.codeOnly).toBe(1);  // GET /api/extra
      // ② spec 文件同一份(单一真相源的「排序首个」口径两面一致)
      expect(bridge.specFile).toBe("openapi.json");
      expect(api.reconcile!.spec.file).toBe(bridge.specFile);
      // ③ 清单内容也逐条对齐(不只计数巧合)
      expect(api.reconcile!.both.map((b) => `${b.method} ${b.path}`).sort())
        .toEqual(bridge.edges.map((e) => `${e.from.method} ${e.from.path}`).sort());
      expect(api.reconcile!.specOnly.map((s) => `${s.method} ${s.path}`).sort())
        .toEqual(bridge.specOnly.map((s) => `${s.method} ${s.path}`).sort());
      expect(api.reconcile!.codeOnly.map((c) => `${c.method} ${c.path}`).sort())
        .toEqual(bridge.codeOnly.map((c) => `${c.method} ${c.path}`).sort());
    } finally { cleanup(); }
  }, 60_000);

  it("缓存失效:同进程内改 spec 文件 → 第二次查询反映新对账(不命中 60s 旧缓存)", async () => {
    const { dir, cleanup } = fixturePyRepo({ "app.py": SPEC_SRC_APP, "openapi.json": SPEC_JSON_TWO_OPS });
    try {
      const first = await queryApiSurface(dir, { refresh: true, withImpact: false });
      expect(first.reconcile!.specOnly.map((s) => s.path)).toContain("/api/ghost");
      expect(first.reconcile!.specOnly.map((s) => s.path)).not.toContain("/api/newer");
      // 改写 spec(源码不动);utimes 显式推进 mtime,规避同毫秒写入在低精度 FS 上的等价
      const specAbs = join(dir, "openapi.json");
      writeFileSync(specAbs, SPEC_JSON_CHANGED);
      const bumped = new Date(Date.now() + 2000);
      utimesSync(specAbs, bumped, bumped);
      // 关键:不带 refresh(否则等于自证),走正常缓存路径
      const second = await queryApiSurface(dir, { withImpact: false });
      expect(second.reconcile).toBeTruthy();
      const secondSpecOnly = second.reconcile!.specOnly.map((s) => s.path);
      expect(secondSpecOnly).toContain("/api/newer");
      expect(secondSpecOnly).not.toContain("/api/ghost");
      expect(second.reconcile!.spec.file).toBe("openapi.json");
      // bridge 面同轮一致(单一真相源:两面都不该各自留旧值)
      const bridge = await querySpecBridgeEdges(dir);
      expect(bridge.stats.specOnly).toBe(second.reconcile!.specOnly.length);
      expect(bridge.stats.both).toBe(second.reconcile!.both.length);
      expect(bridge.stats.codeOnly).toBe(second.reconcile!.codeOnly.length);
    } finally { cleanup(); }
  }, 60_000);

  it("缓存失效(新增 spec 文件):深档发现窗口 ≤1s → 第二次查询出现对账", async () => {
    const { dir, cleanup } = fixturePyRepo({ "app.py": SPEC_SRC_APP });
    try {
      const before = await queryApiSurface(dir, { refresh: true, withImpact: false });
      expect(before.reconcile).toBeUndefined();
      // 新增一个 YAML spec(纯新增文件:源码扩展名指纹不变,只有 spec 清单发现能看见)。
      // 已知 spec 的「改/删」由廉价档当次 stat 捕获(零窗口,见上一个用例);
      // 「新增文件」只能靠深档全仓遍历看见,而深档按 1s 节流(取舍见 openapi.ts
      // SPEC_DISCOVERY_TTL_MS 注释:一次 findSpecFiles ≈0.8s,不能每轮查询都做)。
      // 因此这里显式等过 1s 节流窗——断言的是「≤1s 内必被发现」,不是「零延迟」。
      writeFileSync(join(dir, "openapi.yaml"), `openapi: 3.0.0
paths:
  /api/orders:
    post:
      summary: 创建订单
`);
      await new Promise((r) => setTimeout(r, 1_100));
      const after = await queryApiSurface(dir, { withImpact: false });
      expect(after.reconcile).toBeTruthy();
      expect(after.reconcile!.spec.file).toBe("openapi.yaml");
      expect(after.reconcile!.both.map((b) => `${b.method} ${b.path}`)).toContain("POST /api/orders");
      // bridge 面同步看见同一份 spec(单一真相源:两侧都不该有各自的新增盲区)
      const bridge = await querySpecBridgeEdges(dir);
      expect(bridge.specFile).toBe("openapi.yaml");
      expect(bridge.stats.both).toBe(after.reconcile!.both.length);
    } finally { cleanup(); }
  }, 60_000);

  it("回归:无 spec → reconcile undefined 且 bridge state=no-spec", async () => {
    const { dir, cleanup } = fixturePyRepo({ "app.py": SPEC_SRC_APP });
    try {
      const atRoot = await reconcileForRoot(dir, await extractApiSurface(dir, ["app.py"]).then((s) => s.endpoints));
      expect(atRoot.specFiles).toEqual([]);
      expect(atRoot.spec).toBeUndefined();
      expect(atRoot.reconcile).toBeUndefined();
      const api = await queryApiSurface(dir, { refresh: true, withImpact: false });
      expect(api.reconcile).toBeUndefined();
      expect(api.endpoints.length).toBeGreaterThan(0);
      const bridge = await querySpecBridgeEdges(dir);
      expect(bridge.state).toBe("no-spec");
      expect(bridge.specFile).toBeUndefined();
    } finally { cleanup(); }
  }, 60_000);

  it("specFingerprint:清单+mtime 变化即变键(新增文件与内容改写两种)", async () => {
    const { dir, cleanup } = fixturePyRepo({ "app.py": SPEC_SRC_APP });
    try {
      const empty = await specFingerprint(dir, true);
      expect(empty.specFiles).toEqual([]);
      expect(empty.key).toBe("none");
      const specAbs = join(dir, "openapi.json");
      writeFileSync(specAbs, SPEC_JSON_TWO_OPS);
      const withSpec = await specFingerprint(dir, true);
      expect(withSpec.specFiles).toEqual(["openapi.json"]);
      expect(withSpec.key).toContain("openapi.json@");
      // 内容改写 + mtime 推进 → 键必须变(否则缓存会返旧值)
      const bumped = new Date(Date.now() + 3000);
      utimesSync(specAbs, bumped, bumped);
      const changed = await specFingerprint(dir, true);
      expect(changed.key).not.toBe(withSpec.key);
    } finally { cleanup(); }
  }, 60_000);
});
