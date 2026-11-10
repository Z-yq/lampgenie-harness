/**
 * 桥边进 c2f 索引 + impact 跨语言段测试(step-106 / designs/27 §7 落地):
 * ① buildC2fIndex 落盘 bridge 段(flask×ts 混语 fixture:3 条 exact 边,stats/state 齐备);
 * ② 落盘-读回往返(saveIndex/loadIndex)字段完整;
 * ③ impact 双向:后端 handler(create_order)→前端调用点(置信度+双端 file:line);
 *    前端符号(loadOrder)→后端端点(同文件最近前驱归属);
 * ④ 跨语言同名不绑:前端 hello() 不得吸收后端 flask hello 的桥边(同语言族收窄);
 * ⑤ 诚实降级:纯 ts 仓(no-endpoints 字段在场零边)/GENIE_SENSE_BRIDGE=off(字段缺席);
 * ⑥ 旧格式索引(无 bridge 字段)impact 渲染零新行——输出面零回退;
 * ⑦ 汇总行追加「跨语言桥边 N」(仅命中时)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildC2fIndex, saveIndex, loadIndex, queryImpact, renderImpact, type C2fIndex,
} from "@lampgenie/code-sense";

let ws = "";
let index: C2fIndex;

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

@app.route("/internal/metrics")
def metrics():
    return {}
`;

// 与 crosslang-bridge.test.ts 同族形态:exact(orders/users 模板通配)+折叠(hello)+无配对(metrics)
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
`;

beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), "csbidx-"));
  mkdirSync(join(ws, "backend"), { recursive: true });
  mkdirSync(join(ws, "frontend"), { recursive: true });
  writeFileSync(join(ws, "backend", "app.py"), FLASK_APP);
  writeFileSync(join(ws, "frontend", "main.ts"), FRONTEND_MAIN);
  index = await buildC2fIndex(ws);
}, 180_000);

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
}, 60_000);

describe("step-106:桥边进 c2f 索引", () => {
  it("①buildC2fIndex 落盘 bridge 段:3 条 exact 边+stats+state", () => {
    expect(index.bridge).toBeTruthy();
    expect(index.bridge!.state).toBe("bridge-connected");
    expect(index.bridge!.edges).toHaveLength(3);
    expect(index.bridge!.stats?.endpointsExactUnion).toBe(3);
    expect(index.bridge!.stats?.endpoints).toBe(4);
    // 每条边桥格式字段齐备(kind/bridge/confidence/tier/evidence+双端 file:line)
    for (const e of index.bridge!.edges) {
      expect(e.kind).toBe("bridge");
      expect(e.bridge).toBe("http-api");
      expect(e.tier).toBe("structural");
      expect(e.evidence).toBe("grep");
      expect(e.from.file.length).toBeGreaterThan(0);
      expect(e.from.line).toBeGreaterThan(0);
      expect(e.to.file.length).toBeGreaterThan(0);
      expect(e.to.line).toBeGreaterThan(0);
    }
  });

  it("②落盘-读回往返:bridge 段字段完整", () => {
    const p = saveIndex(ws, index);
    expect(p.length).toBeGreaterThan(0);
    const back = loadIndex(ws)!;
    expect(back.bridge).toBeTruthy();
    expect(back.bridge!.edges).toHaveLength(3);
    expect(back.bridge!.stats?.endpointsExactUnion).toBe(3);
  });

  it("③impact 后端 handler→前端调用点(置信度+双端证据行)", () => {
    const r = queryImpact(index, "create_order");
    expect(r.bridgeChannel).toBe(true);
    const d = r.definitions[0]!;
    expect(d.bridges).toBeTruthy();
    const be = d.bridges!.filter((h) => h.role === "backend-handler");
    expect(be).toHaveLength(1);
    expect(be[0]!.edge.to.method).toBe("POST");
    expect(be[0]!.edge.to.path).toBe("/api/orders");
    expect(be[0]!.edge.from.file).toBe("frontend/main.ts");
    expect(be[0]!.edge.from.line).toBe(4);
    expect(be[0]!.edge.confidence).toBe("high");
    expect(be[0]!.sameFile).toBe(true); // flask 路由与 handler 同文件
    const text = renderImpact(r);
    expect(text).toContain("跨语言桥边");
    expect(text).toContain("作为后端 handler");
    expect(text).toContain("frontend/main.ts:4");
    expect(text).toContain("POST /api/orders");
    expect(text).toContain("跨语言桥边 1"); // 汇总行追加
  });

  it("③impact 前端符号→后端端点(同文件最近前驱归属)", () => {
    const r = queryImpact(index, "loadOrder");
    const d = r.definitions[0]!;
    const fe = d.bridges!.filter((h) => h.role === "frontend-caller");
    expect(fe).toHaveLength(1);
    expect(fe[0]!.edge.from.literal).toBe("/api/orders");
    expect(fe[0]!.edge.to.handler).toBe("create_order");
    expect(fe[0]!.edge.to.file).toBe("backend/app.py");
    const text = renderImpact(r);
    expect(text).toContain("作为前端调用方");
    expect(text).toContain("归属=同文件最近前驱符号");
    expect(text).toContain("create_order @ backend/app.py");
  });

  it("④跨语言同名不绑:前端 hello() 只有 frontend-caller 命中,不吸收后端桥边", () => {
    const r = queryImpact(index, "hello");
    expect(r.definitions.length).toBe(2); // backend/app.py#hello + frontend/main.ts#hello
    const fe = r.definitions.find((d) => d.symbol.file === "frontend/main.ts")!;
    const be = r.definitions.find((d) => d.symbol.file === "backend/app.py")!;
    expect(fe.bridges ?? []).toHaveLength(1);
    expect(fe.bridges![0]!.role).toBe("frontend-caller"); // 折叠边归属到它
    expect(fe.bridges![0]!.edge.match).toBe("exact-folded");
    expect(be.bridges ?? []).toHaveLength(1);
    expect(be.bridges![0]!.role).toBe("backend-handler");
    expect(be.bridges![0]!.sameFile).toBe(true);
    // 渲染:折叠标注与置信度徽标
    const text = renderImpact(r);
    expect(text).toContain("exact·折叠");
  });

  it("⑤诚实降级:无端点仓 bridge.state=no-endpoints(字段在场零边)", async () => {
    const only = mkdtempSync(join(tmpdir(), "csbidx-fe-"));
    writeFileSync(join(only, "a.ts"), "export function f(): void { fetch(\"/api/x\"); }\n");
    const idx2 = await buildC2fIndex(only);
    expect(idx2.bridge).toBeTruthy();
    expect(idx2.bridge!.state).toBe("no-endpoints");
    expect(idx2.bridge!.edges).toHaveLength(0);
    const r = queryImpact(idx2, "f");
    expect(r.bridgeChannel).toBe(true);
    expect(r.definitions[0]!.bridges).toBeUndefined(); // 零命中零行
    expect(renderImpact(r)).not.toContain("跨语言桥边");
    rmSync(only, { recursive: true, force: true });
  }, 120_000);

  it("⑤GENIE_SENSE_BRIDGE=off:字段整体缺席", async () => {
    const prev = process.env.GENIE_SENSE_BRIDGE;
    process.env.GENIE_SENSE_BRIDGE = "off";
    try {
      const idx3 = await buildC2fIndex(ws);
      expect(idx3.bridge).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.GENIE_SENSE_BRIDGE;
      else process.env.GENIE_SENSE_BRIDGE = prev;
    }
  }, 120_000);

  it("⑥旧格式索引(无 bridge 段):impact 正常且渲染零新行(输出面零回退)", () => {
    const old: C2fIndex = JSON.parse(JSON.stringify(index));
    delete old.bridge;
    const r = queryImpact(old, "create_order");
    expect(r.bridgeChannel).toBe(false);
    expect(r.definitions[0]!.bridges).toBeUndefined();
    const text = renderImpact(r);
    expect(text).not.toContain("跨语言桥边");
    expect(text).toContain("汇总: 直接调用方"); // 既有面不动
  });
});
