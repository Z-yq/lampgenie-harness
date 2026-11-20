/**
 * 增量链桥边同步测试( / §7):
 * ① 首建(express×ts 同族混语 fixture)→ index.bridge 在场(边带双端证据);
 * ② 零变更重建 → bridge 逐字节 carry(与 coverage carry 同口径,不重算);
 * ③ 前端文件新增 fetch 字面量 → 重建 → 桥边增量出现(重算通道);
 * ④ GENIE_SENSE_BRIDGE=off → 字段整体缺席(通道关闭)。
 * 注册表/索引产物落临时 HOME 与临时目录,不污染真实 ~/.codesense。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadIndex } from "@lampgenie/code-sense";
import { buildIndexWithReuse } from "../src/incremental.js";

let ws = "";
let fakeHome = "";

const SERVER_APP = `import express from "express";
const app = express();
export function createOrder(): void {}
export function hello(): void {}
export function showMetrics(): void {}
app.post("/api/orders", createOrder);
app.get("/api/hello", hello);
app.get("/internal/metrics", showMetrics);
`;

const WEB_MAIN = `export async function loadOrder() {
  return fetch("/api/orders", { method: "POST" });
}
export async function hello() {
  return fetch("/api/hello");
}
`;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "cshome106-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  ws = mkdtempSync(join(tmpdir(), "csincr106-"));
  mkdirSync(join(ws, "server"), { recursive: true });
  mkdirSync(join(ws, "web"), { recursive: true });
  writeFileSync(join(ws, "server", "app.ts"), SERVER_APP);
  writeFileSync(join(ws, "web", "main.ts"), WEB_MAIN);
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
}, 60_000);

describe("增量链桥边同步", () => {
  it("①首建:bridge 段在场,orders/hello 端点出边(同族仓自配对:server/app.ts 路由行字面量自命中,103 §3.4 登记形态)", { timeout: 120_000 }, async () => {
    const r = await buildIndexWithReuse(ws, { heapBudget: "off" });
    expect(r.mode).toBe("full");
    const b = r.index.bridge;
    expect(b).toBeTruthy();
    expect(b!.state).toBe("bridge-connected");
    // 前端真边:web/main.ts → orders/hello
    const fe = b!.edges.filter((e) => e.from.file === "web/main.ts");
    expect(fe.map((e) => e.to.path).sort()).toEqual(["/api/hello", "/api/orders"]);
    expect(fe[0]!.from.line).toBeGreaterThan(0);
    // 同族仓自配对:server/app.ts 的路由行字面量也配对 → metrics 端点首建即在 exact 集
    expect(b!.stats?.endpointsExactUnion).toBe(3);
    expect(b!.stats?.endpointsUnmatched).toBe(0);
    // 但 metrics 的前端来源边此刻不存在(③ 的增量锚点)
    expect(b!.edges.some((e) => e.from.file === "web/main.ts" && e.to.path === "/internal/metrics")).toBe(false);
  });

  it("②零变更重建:bridge 逐字节 carry(scanned=0,不重算)", { timeout: 120_000 }, async () => {
    const before = loadIndex(ws)!.bridge;
    const r = await buildIndexWithReuse(ws, { heapBudget: "off" });
    expect(r.mode).toBe("incremental");
    expect(r.scanned).toEqual([]);
    expect(JSON.stringify(r.index.bridge)).toBe(JSON.stringify(before));
  });

  it("③前端文件变更:新字面量配对出增量桥边(metrics 的前端来源边新增)", { timeout: 120_000 }, async () => {
    appendFileSync(join(ws, "web", "main.ts"), "export async function metrics() {\n  return fetch(\"/internal/metrics\");\n}\n");
    const r = await buildIndexWithReuse(ws, { heapBudget: "off" });
    expect(r.scanned).toEqual(["web/main.ts"]);
    const b = r.index.bridge!;
    const metrics = b.edges.filter((e) => e.to.path === "/internal/metrics" && e.from.file === "web/main.ts");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.to.handler).toBe("showMetrics");
    // exactUnion 不变(metrics 首建起即被自配对覆盖)——增量证据=前端来源边 0→1
    expect(b.stats?.endpointsExactUnion).toBe(3);
  });

  it("④GENIE_SENSE_BRIDGE=off:bridge 字段整体缺席", { timeout: 120_000 }, async () => {
    const prev = process.env.GENIE_SENSE_BRIDGE;
    process.env.GENIE_SENSE_BRIDGE = "off";
    const ws2 = mkdtempSync(join(tmpdir(), "csincr106off-"));
    try {
      mkdirSync(join(ws2, "server"), { recursive: true });
      writeFileSync(join(ws2, "server", "app.ts"), SERVER_APP);
      const r = await buildIndexWithReuse(ws2, { heapBudget: "off" });
      expect(r.index.bridge).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.GENIE_SENSE_BRIDGE;
      else process.env.GENIE_SENSE_BRIDGE = prev;
      rmSync(ws2, { recursive: true, force: true });
    }
  });
});
