/**
 * sensing/crosslang-bridge 测试(step-103 / designs/27):
 * ① 端到端 fixture(flask 后端 + ts 前端):exact / exact-folded / first2 候选 /
 *    无配对端点 / 未用字面量 五形态;
 * ② 每条正式边双端证据行齐备(防幻觉红线);
 * ③ 无前端仓态(no-frontend)与无端点仓态(no-endpoints)诚实降级;
 * ④ matchBridgeEdges 纯函数:prefixInferred 降档 + 折叠标注不冒充原生。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  queryBridgeEdges, matchBridgeEdges, renderBridgeEdges,
  queryBridgeCandidates, matchBridgeCandidates, renderBridgeCandidates, bridgeCandidateSurfaceOf,
  type BridgeSurface,
} from "@lampgenie/code-sense/sensing/crosslang-bridge";
import type { ApiEndpoint } from "@lampgenie/code-sense/sensing/http-api";

let ws = "";

const FLASK_APP = `from flask import Flask

app = Flask(__name__)

@app.route("/api/orders", methods=["POST"])
def create_order():
    return {}

@app.route("/api/users/<int:uid>")
def get_user(uid):
    return {}

@app.route("/api/hello")
def hello():
    return {}

@app.route("/api/admin/panel")
def admin_panel():
    return {}

@app.route("/internal/metrics")
def metrics():
    return {}
`;

// 折叠通道口径(bridge.mjs 同):rg 只命中「引号后紧跟 /」的字面量——模板起首 ${} 的串
// (`${BASE}/hello`)不进字面量集;`/api${SUFFIX}` 形态才进折叠通道。
const FRONTEND_MAIN = `const SUFFIX = "/hello";

export async function loadOrder() {
  return fetch("/api/orders", { method: "POST" });
}

export async function loadUser(id: number) {
  return fetch(\`/api/users/\${id}\`);
}

export async function hello() {
  return fetch(\`/api\${SUFFIX}\`);
}

export async function ghost() {
  return fetch("/api/nonexistent");
}

export async function admin() {
  return fetch("/api/admin");
}
`;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "csbridge-"));
  mkdirSync(join(ws, "backend"), { recursive: true });
  mkdirSync(join(ws, "frontend"), { recursive: true });
  writeFileSync(join(ws, "backend", "app.py"), FLASK_APP);
  writeFileSync(join(ws, "frontend", "main.ts"), FRONTEND_MAIN);
});
afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe("crosslang-bridge 端到端(fixture: flask × ts)", () => {
  let r: BridgeSurface;
  beforeAll(async () => {
    r = await queryBridgeEdges(ws);
  }, 30_000);

  it("state=bridge-connected 且端点覆盖三对一缺一候选", () => {
    expect(r.state).toBe("bridge-connected");
    expect(r.stats.endpoints).toBe(5);
    // orders/users/hello 三端点有 exact;admin/panel 仅 first2 候选;internal/metrics 无配对
    expect(r.stats.endpointsExactUnion).toBe(3);
    expect(r.stats.endpointsFirst2Only).toBe(1);
    expect(r.stats.endpointsUnmatched).toBe(1);
    expect(r.unmatchedEndpoints.map((u) => u.path)).toContain("/internal/metrics");
  });

  it("exact 边:/api/orders 与模板通配 /api/users/${id}", () => {
    const orders = r.edges.find((e) => e.to.path === "/api/orders");
    expect(orders).toBeTruthy();
    expect(orders!.match).toBe("exact");
    expect(orders!.confidence).toBe("high");
    expect(orders!.from.file).toBe("frontend/main.ts");
    expect(orders!.from.literal).toBe("/api/orders");
    expect(orders!.to.file).toBe("backend/app.py");
    expect(orders!.to.handler).toBe("create_order");
    const users = r.edges.find((e) => e.to.path === "/api/users/<int:uid>");
    expect(users).toBeTruthy();
    expect(users!.from.literal).toBe("/api/users/${id}"); // 模板参数段归一为通配配对
  });

  it("exact-folded 边:const 折叠独立标注不冒充原生", () => {
    const folded = r.edges.find((e) => e.match === "exact-folded" && e.to.path === "/api/hello");
    expect(folded).toBeTruthy();
    expect(folded!.from.literal).toBe("/api/hello");
    expect(folded!.from.foldedFrom).toBe("/api${SUFFIX}");
    expect(folded!.note ?? "").toContain("折叠");
  });

  it("防幻觉红线:每条正式边双端 file:line 齐备", () => {
    expect(r.edges.length).toBeGreaterThanOrEqual(3);
    for (const e of r.edges) {
      expect(e.from.file.length).toBeGreaterThan(0);
      expect(e.from.line).toBeGreaterThan(0);
      expect(e.to.file.length).toBeGreaterThan(0);
      expect(e.to.line).toBeGreaterThan(0);
      expect(e.kind).toBe("bridge");
      expect(e.tier).toBe("structural");
      expect(e.evidence).toBe("grep");
    }
  });

  it("first2 部分配对只进 candidates 区,不混入正式边", () => {
    expect(r.edges.every((e) => e.match === "exact" || e.match === "exact-folded")).toBe(true);
    const cand = r.candidates.find((c) => c.from.literal === "/api/admin");
    expect(cand).toBeTruthy();
    expect(cand!.to.path).toBe("/api/admin/panel");
    expect(cand!.match).toBe("first2");
    expect(cand!.confidence).toBe("medium");
    expect(cand!.note ?? "").toContain("低置信");
  });

  it("未参与配对的前端字面量如实计数(/api/nonexistent 在其中)", () => {
    expect(r.unmatchedLiteralCount).toBeGreaterThanOrEqual(1);
    // /api/nonexistent 未配任何端点
    expect(r.edges.some((e) => e.from.literal === "/api/nonexistent")).toBe(false);
    expect(r.candidates.some((c) => c.from.literal === "/api/nonexistent")).toBe(false);
  });

  it("knownLimits 登记 C 档形态,永不产边", () => {
    expect(r.knownLimits.length).toBe(4);
    expect(r.knownLimits.join("\n")).toContain("运行时反射");
  });

  it("renderBridgeEdges 文本渲染冒烟", () => {
    const text = renderBridgeEdges(r);
    expect(text).toContain("跨语言桥边");
    expect(text).toContain("bridge-connected");
  });
});

describe("crosslang-bridge 诚实降级路径", () => {
  it("无端点仓态 → no-endpoints(前端字面量如实计数)", async () => {
    const only = mkdtempSync(join(tmpdir(), "csbridge-fe-"));
    mkdirSync(join(only, "web"), { recursive: true });
    writeFileSync(join(only, "web", "a.ts"), `fetch("/api/x");\nfetch("/api/y");\n`);
    const r = await queryBridgeEdges(only);
    expect(r.state).toBe("no-endpoints");
    expect(r.edges.length).toBe(0);
    expect(r.unmatchedLiteralCount).toBeGreaterThanOrEqual(2);
    rmSync(only, { recursive: true, force: true });
  }, 30_000);

  it("无前端仓态 → no-frontend(端点全数落 unmatched)", async () => {
    const only = mkdtempSync(join(tmpdir(), "csbridge-be-"));
    writeFileSync(join(only, "app.py"), FLASK_APP);
    const r = await queryBridgeEdges(only);
    expect(r.state).toBe("no-frontend");
    expect(r.edges.length).toBe(0);
    expect(r.stats.endpointsUnmatched).toBe(5);
    rmSync(only, { recursive: true, force: true });
  }, 30_000);
});

describe("matchBridgeEdges 纯函数:置信度规则", () => {
  it("prefixInferred 端点的 exact 边降一档(high→medium)+note", () => {
    const eps: ApiEndpoint[] = [
      { method: "GET", path: "/status", file: "b.go", line: 5, framework: "chi", kind: "http", prefixInferred: true },
    ];
    const r = matchBridgeEdges(eps, [{ raw: "/status", file: "web/a.ts", line: 9, folded: false }]);
    expect(r.edges.length).toBe(1);
    expect(r.edges[0]!.confidence).toBe("medium");
    expect(r.edges[0]!.note ?? "").toContain("prefixInferred");
  });

  it("无端点/无字面量零产出不报错", () => {
    expect(matchBridgeEdges([], []).edges.length).toBe(0);
    expect(matchBridgeEdges([], []).stats.endpoints).toBe(0);
  });

  it("可信度闸:纯通配互吸不出边(grafana 实锤形态),关闸仅对账可用", () => {
    const eps: ApiEndpoint[] = [
      { method: "GET", path: "/login/:name", file: "api.go", line: 86, framework: "chi", kind: "http" },
    ];
    const lits = [{ raw: "${k8sGroup}/v0alpha1", file: "web/a.ts", line: 3, folded: true, foldedFrom: "const apiVersion" }];
    // 开闸(生产默认):字面量首段未解析通配 × 端点两段均含通配,零实体∩实体 → 不出边
    expect(matchBridgeEdges(eps, lits).edges.length).toBe(0);
    // 关闸(bridge.mjs 旧语义,仅对账):纯通配配对出边——证明差异来自闸门而非其它
    expect(matchBridgeEdges(eps, lits, { credibilityGate: false }).edges.length).toBe(1);
    // 实体锚在场照常出边(防闸误杀真配对)
    const good = [{ raw: "/login/ldap", file: "web/b.ts", line: 4, folded: false }];
    expect(matchBridgeEdges(eps, good).edges.length).toBe(1);
  });
});

// ============================ 非产品路径过滤(P1-1,2026-10-20) ============================

describe("queryBridgeEdges 非产品路径过滤(mocks/docs 下的前端字面量不作证据)", () => {  // poly-grafana 实锤形态:public/test/mocks/** 的 fetch 字面量被当作前端证据
  // 专属后端:含一个只有 mocks/docs 才会去 fetch 的端点 /api/secret
  const FILTER_BACKEND = `from flask import Flask

app = Flask(__name__)

@app.route("/api/orders", methods=["POST"])
def create_order():
    return {}

@app.route("/api/secret")
def secret():
    return {}
`;
  const MOCK_FRONTEND = `export const handlers = [
  fetch("/api/secret"),
];
`;
  const DOC_FRONTEND = `fetch("/api/user/1");
`;

  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "csbridge-pathfilter-"));
    mkdirSync(join(dir, "backend"), { recursive: true });
    mkdirSync(join(dir, "web"), { recursive: true });
    mkdirSync(join(dir, "public", "test", "mocks"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "backend", "app.py"), FILTER_BACKEND);
    writeFileSync(join(dir, "web", "main.ts"), `export const load = () => fetch("/api/orders");\n`);
    writeFileSync(join(dir, "public", "test", "mocks", "handlers.ts"), MOCK_FRONTEND);
    writeFileSync(join(dir, "docs", "usage.ts"), DOC_FRONTEND);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("mocks/docs 前端字面量被丢弃 + pathFilter 呈报 + render 注记;all=true 重新出现", async () => {
    const r = await queryBridgeEdges(dir);
    // ① 过滤生效:产品路径的 /api/orders 有边,mocks/docs 里的字面量不作前端证据
    const orders = r.edges.find((e) => e.to.path === "/api/orders");
    expect(orders).toBeTruthy();
    expect(orders!.from.file).toBe("web/main.ts");
    expect(r.edges.some((e) => e.from.file.startsWith("public/test/mocks/"))).toBe(false);
    expect(r.edges.some((e) => e.from.file.startsWith("docs/"))).toBe(false);
    expect(r.candidates.some((c) => c.from.file.startsWith("public/test/mocks/"))).toBe(false);
    // /api/secret 失去前端证据 → 落未配对端点
    expect(r.unmatchedEndpoints.map((u) => u.path)).toContain("/api/secret");
    // ② 诚实呈报:filtered=被丢弃的字面量条数(mocks 1 + docs 1)
    expect(r.pathFilter).toBeTruthy();
    expect(r.pathFilter!.filtered).toBe(2);
    expect(r.pathFilter!.note).toContain("已过滤");
    expect(renderBridgeEdges(r)).toContain("[路径过滤]");
    // ③ 逃生口:all=true 时 mocks 字面量回归,能与 /api/secret 出边
    const all = await queryBridgeEdges(dir, { all: true });
    expect(all.edges.some((e) => e.to.path === "/api/secret" && e.from.file === "public/test/mocks/handlers.ts")).toBe(true);
    expect(all.pathFilter).toBeUndefined();
  });

  it("过滤后零边不静默:只有 mocks 前端时 pathFilter 仍在且 note 说明", async () => {
    const only = mkdtempSync(join(tmpdir(), "csbridge-pathfilter-only-"));
    mkdirSync(join(only, "backend"), { recursive: true });
    mkdirSync(join(only, "public", "test", "mocks"), { recursive: true });
    writeFileSync(join(only, "backend", "app.py"), FILTER_BACKEND);
    writeFileSync(join(only, "public", "test", "mocks", "handlers.ts"), MOCK_FRONTEND);
    try {
      const r = await queryBridgeEdges(only);
      expect(r.edges.length).toBe(0);
      expect(r.pathFilter?.filtered).toBeGreaterThan(0);
      expect(renderBridgeEdges(r)).toContain("[路径过滤]");
    } finally {
      rmSync(only, { recursive: true, force: true });
    }
  });
});

// ============================ LLM 消歧候选区(2026-10-25) ============================

describe("LLM 消歧候选区:与确定性边分离 + 双端证据链", () => {
  it("缺省输出不含 semanticCandidates(既有消费面逐字节兼容)", async () => {
    const r = await queryBridgeEdges(ws);
    expect(r.semanticCandidates).toBeUndefined();
    expect(r.semanticCandidateStats).toBeUndefined();
  });

  it("includeCandidates=true:候选带双端 file:line+method+handler+reason+evidence", async () => {
    const r = await queryBridgeEdges(ws, { includeCandidates: true });
    expect(r.semanticCandidates).toBeTruthy();
    expect(r.semanticCandidateStats).toBeTruthy();
    const cand = r.semanticCandidates!.find((c) => c.from.literal === "/api/admin");
    expect(cand).toBeTruthy();
    expect(cand!.to.path).toBe("/api/admin/panel");
    expect(cand!.to.handler).toBe("admin_panel");
    expect(cand!.kind).toBe("bridge-candidate");
    expect(cand!.tier).toBe("semantic");
    expect(cand!.match).toBe("first2");
    expect(cand!.confidence).toBe("medium");
    expect(cand!.reason).toContain("前 2 段");
    const ev = cand!.evidence.join("\n");
    expect(ev).toContain(`frontend/main.ts:${cand!.from.line}`);
    expect(ev).toContain(`backend/app.py:${cand!.to.line}`);
    expect(ev).toContain("admin_panel");
    expect(ev).toContain("tier=semantic");
    // 双端证据行齐备 = 防幻觉红线同样适用
    for (const c of r.semanticCandidates!) {
      expect(c.from.file.length).toBeGreaterThan(0);
      expect(c.from.line).toBeGreaterThan(0);
      expect(c.to.file.length).toBeGreaterThan(0);
      expect(c.to.line).toBeGreaterThan(0);
    }
    // 不与确定性边混:同一 (前端点, method, path) 不会同时出现在两区
    const edgeKeys = new Set(r.edges.map((e) => `${e.from.file}:${e.from.line}|${e.to.method}|${e.to.path}`));
    for (const c of r.semanticCandidates!) {
      expect(edgeKeys.has(`${c.from.file}:${c.from.line}|${c.to.method}|${c.to.path}`)).toBe(false);
    }
    expect(r.semanticCandidateStats!.endpointsExact).toBe(r.stats.endpointsExactUnion);
    expect(r.edges.every((e) => e.match === "exact" || e.match === "exact-folded")).toBe(true);
  });

  it("queryBridgeCandidates 独立入口 + 文本渲染 + bridgeCandidateSurfaceOf", async () => {
    const s = await queryBridgeCandidates(ws);
    expect(s.state).toBe("bridge-connected");
    expect(s.deterministicEdges).toBeGreaterThanOrEqual(3);
    expect(s.stats.endpointsExact).toBe(3);
    expect(s.stats.candidates).toBe(s.candidates.length);
    expect(s.candidates.every((c) => c.tier === "semantic")).toBe(true);
    const text = renderBridgeCandidates(s);
    expect(text).toContain("LLM 消歧候选区");
    expect(text).toContain("不在候选区");
    expect(text).toContain("admin_panel");
    // 同一表面上的视图函数与独立查询同构
    const surface = await queryBridgeEdges(ws, { includeCandidates: true });
    expect(bridgeCandidateSurfaceOf(surface).candidates.length).toBe(s.candidates.length);
  });

  it("纯函数:exact 端点整体排除;first2=medium;prefix1 需显式开启且=low", () => {
    const eps: ApiEndpoint[] = [
      { method: "GET", path: "/api/orders", file: "b.go", line: 5, framework: "chi", kind: "http", handler: "orders" },
      { method: "GET", path: "/api/admin/panel", file: "b.go", line: 9, framework: "chi", kind: "http", handler: "admin" },
      { method: "GET", path: "/api/health", file: "b.go", line: 13, framework: "chi", kind: "http", handler: "health" },
    ];
    const lits = [
      { raw: "/api/orders", file: "w.ts", line: 2, folded: false },
      { raw: "/api/admin", file: "w.ts", line: 3, folded: false },
      { raw: "/api", file: "w.ts", line: 4, folded: false },
    ];
    const r = matchBridgeCandidates(eps, lits);
    expect(r.deterministicEdges).toBe(1);
    expect(r.stats.endpointsExact).toBe(1);
    expect(r.stats.first2).toBe(1);
    expect(r.stats.prefix1).toBe(0);
    expect(r.candidates.map((c) => c.to.path)).toEqual(["/api/admin/panel"]);
    expect(r.candidates[0]!.tier).toBe("semantic");
    expect(r.candidates[0]!.confidence).toBe("medium");
    // 已有确定性边的端点整体排除
    expect(r.candidates.some((c) => c.to.path === "/api/orders")).toBe(false);
    // prefix1 是显式开关:开启后仅首段一致 → low
    const withPrefix = matchBridgeCandidates(eps, lits, { includePrefix1: true });
    const p1 = withPrefix.candidates.find((c) => c.to.path === "/api/health");
    expect(p1).toBeTruthy();
    expect(p1!.match).toBe("prefix1");
    expect(p1!.confidence).toBe("low");
    expect(p1!.reason).toContain("单段前缀");
    // 零候选口径
    expect(matchBridgeCandidates([], []).candidates).toHaveLength(0);
    expect(matchBridgeCandidates(eps, []).candidates).toHaveLength(0);
    expect(matchBridgeCandidates(eps, []).stats.unmatchedEndpoints).toBe(3);
    // prefixInferred 端点降一档
    const degraded = matchBridgeCandidates(
      [{ method: "GET", path: "/api/x/y", file: "b.go", line: 1, framework: "chi", kind: "http", prefixInferred: true }],
      [{ raw: "/api/x", file: "w.ts", line: 1, folded: false }],
    );
    expect(degraded.candidates[0]!.confidence).toBe("low");
    expect(degraded.candidates[0]!.evidence.join("\n")).toContain("prefixInferred");
  });
});
