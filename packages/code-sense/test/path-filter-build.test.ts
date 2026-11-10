/**
 * path-filter 构建产物判定测试(step-142,2026-10-21):
 * ① 正例:_next/static 编译产物、bundle 哈希名、根级 out/ 判为构建产物;
 * ② 负例(不误伤):static/ 与 web/ 下的手写源码、internal/cache 源码目录、短名 main.js;
 * ③ 面级确认:state 面不再从 chunks 产物里提状态机;
 * ④ bridge 滤网一致性:test/ 下的前端字面量不作前端证据,注记与正式边同源。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isBuildArtifactPath, isNonProductPath, evidenceRank } from "@lampgenie/code-sense";
import { queryStateMachines } from "@lampgenie/code-sense/sensing/index";
import {
  queryBridgeEdges, renderBridgeEdges,
  queryWsChannelEdges, renderWsChannelEdges,
  queryIpcChannelEdges, renderIpcChannelEdges,
} from "@lampgenie/code-sense/sensing/crosslang-bridge";

describe("isBuildArtifactPath:构建产物路径判定", () => {
  it("Next 编译产物(_next/static/media|chunks)与 bundle 哈希名判为构建产物", () => {
    expect(isBuildArtifactPath("static/web/_next/static/media/airplay.svg.201ld829s92qg.js")).toBe(true);
    expect(isBuildArtifactPath("static/web/_next/static/chunks/02if5pgqr6o9c.js")).toBe(true);
    expect(isNonProductPath("static/web/_next/static/chunks/02if5pgqr6o9c.js")).toBe(true);
    // 哈希名兜底:没有强构建段,只有文件名可判
    expect(isBuildArtifactPath("static/web/build/app.9f8a7b6c5d.js")).toBe(true);
    expect(isBuildArtifactPath("assets/styles.b3c4d5e6f7.css")).toBe(true);
    // 混大小写的驼峰名不是哈希:poly-grafana/scripts/cli/reportI18nStats.mjs 是手写统计脚本
    // (i 标志会把「1 + 8nStats」当哈希段——基线全仓扫描实锤)
    expect(isBuildArtifactPath("scripts/cli/reportI18nStats.mjs")).toBe(false);
  });

  it("根级 out/ 判构建产物;非根级 out 段不整段剔除", () => {
    expect(isBuildArtifactPath("out/index.html")).toBe(true);
    expect(isNonProductPath("out/index.html")).toBe(true);
    // 只认首段:internal/out 这类源码目录不算(基线 out/ 零命中,取最窄口径)
    expect(isBuildArtifactPath("src/internal/out/publisher.go")).toBe(false);
  });

  it("强构建段直接命中(.next/_next/.nuxt/.output/.vite/__pycache__ 等)", () => {
    for (const p of [
      "packages/web/.next/server/page.js",
      "_next/static/chunks/a.js",
      "app/.nuxt/entry.js",
      "build/.output/server/index.mjs",
      "packages/site/.svelte-kit/output/server.js",
      "node_modules/.vite/deps/x.js",
      "pkg/__pycache__/mod.cpython-312.pyc",
      "svc/.pytest_cache/v/cache/nodeids",
      "android/.gradle/8.0/executionHistory.bin",
      "infra/.terraform/modules/modules.json",
      "scripts/.webpack/config.js",
    ]) {
      expect(isBuildArtifactPath(p), p).toBe(true);
    }
  });

  it("不误伤:static/ 与 web/ 下的手写源码、cache 源码段、短名文件", () => {
    // static 手写源码(poly-grafana Go embed 服务端 + poly-owncast 手写前端逻辑)
    expect(isNonProductPath("static/offline-v2.ts")).toBe(false);
    expect(isNonProductPath("pkg/api/static/static.go")).toBe(false);
    // web/ 是 owncast 手写前端源码;public/ 是静态资源入口
    expect(isNonProductPath("web/services/chat-service.ts")).toBe(false);
    expect(isNonProductPath("public/index.ts")).toBe(false);
    // 裸 cache/tmp 段是源码目录(go-grpc-go/internal/cache 等实锤),不整段剔除
    expect(isNonProductPath("internal/cache/x.go")).toBe(false);
    // 本仓自身路径不被新规则吃掉
    expect(isNonProductPath("apps/gateway/src/server.ts")).toBe(false);
    // 短名不是 bundle 哈希(index.js/v2.js/main.ts/client.js)
    expect(isNonProductPath("web/main.js")).toBe(false);
    expect(isBuildArtifactPath("index.js")).toBe(false);
    expect(isBuildArtifactPath("v2.js")).toBe(false);
    expect(isBuildArtifactPath("main.ts")).toBe(false);
    expect(isBuildArtifactPath("client.js")).toBe(false);
  });

  it("evidenceRank:构建产物与测试同档降权(rank=1),产品源码 rank=0", () => {
    expect(evidenceRank("static/web/_next/static/chunks/02if5pgqr6o9c.js")).toBe(1);
    expect(evidenceRank("web/services/chat-service.ts")).toBe(0);
  });
});

// ============================ state 面:chunks 产物不出状态机 ============================

describe("queryStateMachines:构建产物里的 switch 不被算成状态机", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-pathfilter-build-state-"));
    // 产物形态:minified switch(含 switch 痕迹但无状态集/无机器语义)
    mkdirSync(join(dir, "static", "web", "_next", "static", "chunks"), { recursive: true });
    writeFileSync(join(dir, "static", "web", "_next", "static", "chunks", "x.js"),
      `function f(a){switch(a){case 1:return"fulfilled";case 2:return"rejected";default:return"pending"}}\n`
        + `function g(a,b){switch(b.state){case"idle":b.state="loading";break;case"loading":b.state="ready";break;}}\n`);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "machine.ts"), `import { createMachine } from "xstate";

export const ordersMachine = createMachine({
  id: "orders",
  initial: "idle",
  states: {
    idle: {
      on: { SUBMIT: "submitted" },
    },
    submitted: {
      on: { APPROVE: "done", REJECT: { target: "failed" } },
    },
    done: {},
    failed: {},
  },
});
`);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("只提取到产品源文件那台机,chunks 路径 0 条", async () => {
    const r = await queryStateMachines(dir, { all: true });
    const fromChunks = r.machines.filter((m) => m.file.includes("_next/static/chunks"));
    expect(fromChunks.length).toBe(0);
    // 产品文件的 xstate 机在 --all 视角下仍可见
    expect(r.machines.some((m) => m.file === "src/machine.ts")).toBe(true);
    // 默认(不过滤逃生口关闭)口径:产物不进统计
    const def = await queryStateMachines(dir);
    expect(def.machines.filter((m) => m.file.includes("_next/static/chunks")).length).toBe(0);
    expect(def.machines.length).toBeGreaterThan(0);
    expect(def.machines.every((m) => !m.file.includes("_next"))).toBe(true);
  });
});

// ============================ bridge 面:test/ 前端证据与注记同源 ============================

describe("queryBridgeEdges:test/ 下的前端字面量不作前端证据(滤网与注记同源)", () => {
  const BACKEND = `from flask import Flask

app = Flask(__name__)

@app.route("/api/orders", methods=["POST"])
def create_order():
    return {}

@app.route("/api/secret")
def secret():
    return {}
`;
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-pathfilter-build-bridge-"));
    mkdirSync(join(dir, "backend"), { recursive: true });
    mkdirSync(join(dir, "test", "automated", "api", "lib"), { recursive: true });
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "backend", "app.py"), BACKEND);
    writeFileSync(join(dir, "test", "automated", "api", "lib", "openapi.smoke.js"),
      `export const smoke = () => fetch("/api/secret");\n`);
    writeFileSync(join(dir, "web", "main.ts"), `export const load = () => fetch("/api/orders");\n`);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("test/ 字面量被过滤 + pathFilter 呈报 + render 注记;all=true 回归并出边", async () => {
    const r = await queryBridgeEdges(dir);
    // 产品路径前端有边
    const orders = r.edges.find((e) => e.to.path === "/api/orders");
    expect(orders).toBeTruthy();
    expect(orders!.from.file).toBe("web/main.ts");
    // test/ 下的前端 fixture 不作证据(正式边与候选边都没有)
    expect(r.edges.some((e) => e.from.file.startsWith("test/"))).toBe(false);
    expect(r.candidates.some((c) => c.from.file.startsWith("test/"))).toBe(false);
    // /api/secret 失去前端证据 → 落未配对端点
    expect(r.unmatchedEndpoints.map((u) => u.path)).toContain("/api/secret");
    // 诚实呈报:filtered ≥ 1,note 说明,render 输出 [路径过滤]
    expect(r.pathFilter).toBeTruthy();
    expect(r.pathFilter!.filtered).toBeGreaterThanOrEqual(1);
    expect(r.pathFilter!.note).toContain("已过滤");
    expect(renderBridgeEdges(r)).toContain("[路径过滤]");
    // 逃生口:all=true 时 test/ 证据回归并能与 /api/secret 出边
    const all = await queryBridgeEdges(dir, { all: true });
    expect(all.edges.some((e) => e.to.path === "/api/secret" && e.from.file.startsWith("test/"))).toBe(true);
    expect(all.pathFilter).toBeUndefined();
  });
});

// ============================ ws/ipc 通道面同一滤网(D2 加分项) ============================

describe("ws/ipc 通道面:前端证据行走同一 path-filter(test/ 调用点不作证据)", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-pathfilter-build-ws-"));
    mkdirSync(join(dir, "server"), { recursive: true });
    mkdirSync(join(dir, "web"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "server", "routes.py"),
      `from starlette.routing import WebSocketRoute\n\nasync def ws_feed():\n    pass\n\nroutes = [WebSocketRoute("/ws/feed", ws_feed)]\n`);
    // 产品源码里的连接点是真证据
    writeFileSync(join(dir, "web", "conn.ts"),
      `export const c = () => new WebSocket("wss://example.com/ws/feed");\n`);
    // 测试夹具里的连接点不是「这个前端真的在连」
    writeFileSync(join(dir, "test", "conn.spec.ts"),
      `export const c = () => new WebSocket("wss://example.com/ws/feed");\n`);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("test/ 连接点被过滤并呈报;all=true 回归", async () => {
    const r = await queryWsChannelEdges(dir);
    expect(r.edges.some((e) => e.from.file.startsWith("test/"))).toBe(false);
    expect(r.connectionPoints.some((p) => p.file.startsWith("test/"))).toBe(false);
    expect(r.pathFilter).toBeTruthy();
    expect(r.pathFilter!.filtered).toBeGreaterThanOrEqual(1);
    expect(renderWsChannelEdges(r)).toContain("[路径过滤]");
    // 产品源码证据不受影响
    expect(r.edges.some((e) => e.from.file === "web/conn.ts")).toBe(true);
    const all = await queryWsChannelEdges(dir, { all: true });
    expect(all.connectionPoints.some((p) => p.file.startsWith("test/"))).toBe(true);
    expect(all.pathFilter).toBeUndefined();
  });

  it("ipc 配置面:test/ 调用点被过滤并呈报", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "cs-pathfilter-build-ipc-"));
    mkdirSync(join(d2, "src"), { recursive: true });
    mkdirSync(join(d2, "test"), { recursive: true });
    writeFileSync(join(d2, "src", "main.ts"),
      `import { ipcMain } from "electron";\nipcMain.handle("app:ping", () => 1);\n`);
    writeFileSync(join(d2, "src", "preload.ts"),
      `import { ipcRenderer } from "electron";\nexport const ping = () => ipcRenderer.invoke("app:ping");\n`);
    writeFileSync(join(d2, "test", "ipc.spec.ts"),
      `import { ipcRenderer } from "electron";\nexport const t = () => ipcRenderer.invoke("app:test-only");\n`);
    try {
      const r = await queryIpcChannelEdges(d2);
      expect(r.edges.some((e) => e.from.file.startsWith("test/") || e.to.file.startsWith("test/"))).toBe(false);
      expect(r.pathFilter).toBeTruthy();
      expect(r.pathFilter!.filtered).toBeGreaterThanOrEqual(1);
      expect(renderIpcChannelEdges(r)).toContain("[路径过滤]");
      expect(r.edges.some((e) => e.channel === "app:ping")).toBe(true);
      const all = await queryIpcChannelEdges(d2, { all: true });
      expect(all.pathFilter).toBeUndefined();
      expect(all.stats.sites).toBeGreaterThan(r.stats.sites);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
});
