/**
 * per-session 主模型覆盖(白板「per-session 主模型」)单元面 + WS 端到端。
 *  ① resolveSessionModel 三态合并语义(覆盖合并/无覆盖原样/providerId 优先);
 *  ② resolveSessionModelRef 的 Registry 语义:跨端点切换不继承旧 baseUrl/apiKeyEnv;
 *  ③ store round-trip + revision + CAS + 串行临界区;
 *  ④ createSessionModelApi:**先校验后落盘**(非法选择不写盘且回 error)、合法选择生效、
 *     model:null 清除覆盖回跟随全局、expectedRevision 不符被拒;
 *  ⑤ fork 继承父覆盖(copy + WS session.fork 端到端);
 *  ⑥ WS 端到端:set 广播(multi-tab 同步)+ revision 递增。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { ConfigSchema } from "@lampgenie/core";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
import {
  resolveSessionModel,
  resolveSessionModelRef,
  loadSessionModels,
  saveSessionModels,
  sessionModelsPath,
  createSessionModelStore,
  createSessionModelApi,
  createSessionModelFace,
  SESSION_MODEL_PRUNE_LIMIT,
} from "../src/session-model.js";

function tmpRoot(secrets: Record<string, string> | null = null): string {
  const root = mkdtempSync(join(tmpdir(), "gh-session-model-"));
  if (secrets) {
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify(secrets), "utf-8");
  }
  return root;
}

/** 双 Provider fixture(阿里云 chat / 智谱 anthropic),与 session-llm-wiring.test.ts 同款。 */
const cfg = (llm: Record<string, unknown> = {}) => ConfigSchema.parse({
  providers: [
    {
      id: "main", name: "主端点", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", models: ["glm-5.3", "deepseek-v4.1-flash-1017"],
    },
    {
      id: "bigmodel-plan", name: "智谱套餐", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", apiType: "anthropic",
      models: [{ name: "GLM-5.3" }, { name: "GLM-5.3-Flash" }],
    },
  ],
  coding: {
    llm: {
      providerId: "main", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", model: "deepseek-v4.1-flash-1017", ...llm,
    },
  },
});

const SECRETS = { GENIE_LLM_API_KEY: "aliyun-secret", BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret" };
const cleanEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out = { ...env };
  delete out.GENIE_LLM_API_KEY;
  delete out.BIGMODEL_CODING_PLAN_API_KEY;
  return out;
};

describe("resolveSessionModel 三态", () => {
  it("① 有覆盖 → model 必覆盖,其余字段原样保留(纯合并不改原对象)", () => {
    const globalRef = { model: "deepseek-v4.1", providerId: "main", baseUrl: "https://x.example", apiKeyEnv: "GENIE_LLM_API_KEY", timeoutMs: 30_000 };
    const merged = resolveSessionModel(globalRef, { model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(merged).toEqual({
      model: "GLM-5.3", providerId: "bigmodel-plan", baseUrl: "https://x.example", apiKeyEnv: "GENIE_LLM_API_KEY", timeoutMs: 30_000,
    });
    // 原全局引用不可被就地改动(设置页/其它会话读的是同一对象)
    expect(globalRef.model).toBe("deepseek-v4.1");
    expect(globalRef.providerId).toBe("main");
  });

  it("② 无覆盖 → 原样返回(同一引用,零拷贝零变化)", () => {
    const globalRef = { model: "deepseek-v4.1", baseUrl: "u" };
    expect(resolveSessionModel(globalRef, undefined)).toBe(globalRef);
    expect(resolveSessionModel(globalRef)).toBe(globalRef);
  });

  it("③ providerId 优先级:带值才覆盖,缺省沿用全局路由", () => {
    const globalRef = { model: "a", providerId: "main", baseUrl: "u" };
    expect(resolveSessionModel(globalRef, { model: "b" })).toEqual({ model: "b", providerId: "main", baseUrl: "u" });
    expect(resolveSessionModel(globalRef, { model: "b", providerId: "p2" })).toEqual({ model: "b", providerId: "p2", baseUrl: "u" });
  });
});

describe("resolveSessionModelRef(Registry:选择即 (model, providerId) 对,路由随模型拥有者)", () => {
  it("跨端点切换(providerId 变)→ 不留旧 baseUrl/apiKeyEnv/apiType", () => {
    const c = cfg();
    const ref = resolveSessionModelRef(c, { model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(ref).toMatchObject({
      model: "GLM-5.3",
      providerId: "bigmodel-plan",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY",
    });
  });

  it("只换模型不换 Provider → 路由沿用全局(模型在拥有者目录时自愈到拥有者)", () => {
    const c = cfg();
    const ref = resolveSessionModelRef(c, { model: "glm-5.3" });
    // glm-5.3 只在 main 目录里 → provider 仍 main,端点不变
    expect(ref).toMatchObject({ model: "glm-5.3", providerId: "main", baseUrl: "https://aliyun.example/compatible-mode", apiKeyEnv: "GENIE_LLM_API_KEY" });
  });

  it("全局 baseUrl 是用户自定义(不在任何 Provider 端点)→ 切换时同样不继承旧端点/旧凭证键", () => {
    const c = cfg({ baseUrl: "https://proxy.example/v1", providerId: "main" });
    const ref = resolveSessionModelRef(c, { model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(ref.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(ref.apiKeyEnv).toBe("BIGMODEL_CODING_PLAN_API_KEY");
  });
});

describe("store round-trip(tmpdir)", () => {
  it("set → 落盘 .genie/session-models.json → 新 store 读回同值;set(null) 删除条目", () => {
    const root = tmpRoot();
    const store = createSessionModelStore(root);
    expect(store.set("s1", { model: "GLM-5.3", providerId: "bigmodel-plan" })).toMatchObject({ ok: true, revision: 1 });
    store.set("s2", { model: "deepseek-v4.1" });

    const file = sessionModelsPath(root);
    expect(existsSync(file), "覆盖表必须落盘").toBe(true);
    const reloaded = createSessionModelStore(root);
    expect(reloaded.get("s1")).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(reloaded.get("s2")).toEqual({ model: "deepseek-v4.1" });
    expect(reloaded.get("s3")).toBeUndefined();
    expect(reloaded.all()).toEqual({
      s1: { model: "GLM-5.3", providerId: "bigmodel-plan" },
      s2: { model: "deepseek-v4.1" },
    });
    expect(reloaded.revision("s1")).toBe(1);

    reloaded.set("s1", null); // 清除覆盖
    expect(createSessionModelStore(root).get("s1")).toBeUndefined();
    expect(createSessionModelStore(root).get("s2")).toEqual({ model: "deepseek-v4.1" });
  });

  it("坏 JSON / 形状不合法条目 → 按无覆盖处理(不抛)", () => {
    const root = tmpRoot();
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(sessionModelsPath(root), "{ not json", "utf-8");
    expect(loadSessionModels(root)).toEqual({});
    writeFileSync(sessionModelsPath(root), JSON.stringify({
      ok: { model: "m" },
      badNoModel: { providerId: "p" },
      badEmptyModel: { model: "" },
      badProviderId: { model: "m", providerId: 5 },
      notObject: "x",
    }), "utf-8");
    const loaded = loadSessionModels(root);
    expect(loaded).toEqual({ ok: { model: "m" }, badProviderId: { model: "m" } });
  });

  it("原子写:保存后目录里不留 *.tmp-* 残骸", () => {
    const root = tmpRoot();
    saveSessionModels(root, { s1: { model: "m" } });
    saveSessionModels(root, { s1: { model: "m2" } });
    const dir = join(root, ".genie");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers, `tmp 残骸: ${leftovers.join(",")}`).toEqual([]);
    expect(loadSessionModels(root)).toEqual({ s1: { model: "m2" } });
  });

  it("写失败 fail-soft:root 本身是文件 → warn 不抛,load 返回 {}", () => {
    const notADir = join(tmpRoot(), "occupied");
    writeFileSync(notADir, "x", "utf-8");
    expect(() => saveSessionModels(notADir, { s1: { model: "m" } })).not.toThrow();
    expect(loadSessionModels(notADir)).toEqual({});
  });

  it("revision:CAS 不符 → ok:false 且不落盘;变更订阅(派生缓存失效口)被触发", () => {
    const root = tmpRoot();
    const store = createSessionModelStore(root);
    const hits: string[] = [];
    const off = store.onChange((sid) => hits.push(sid));
    expect(store.set("s1", { model: "m1" })).toMatchObject({ ok: true, revision: 1 });
    expect(store.set("s1", { model: "m2" }, { expectedRevision: 0 })).toMatchObject({ ok: false, code: "revision-mismatch", revision: 1 });
    expect(store.get("s1")).toEqual({ model: "m1" }); // 过期写入被拒,值不变
    expect(loadSessionModels(root)).toEqual({ s1: { model: "m1" } });
    expect(hits).toEqual(["s1"]); // 只有成功写入通知订阅方
    off();
    store.set("s1", { model: "m3" });
    expect(hits).toEqual(["s1"]);
  });

  it("串行临界区:两个并发变更不交错(会话模型配置变更的临界区语义)", async () => {
    const store = createSessionModelStore(tmpRoot());
    const seq: string[] = [];
    await Promise.all([
      store.serialize(async () => {
        seq.push("a-start");
        await new Promise((r) => setTimeout(r, 25));
        seq.push("a-end");
      }),
      store.serialize(async () => {
        seq.push("b-start");
        seq.push("b-end");
      }),
    ]);
    expect(seq).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});

describe("createSessionModelApi:先校验后落盘", () => {
  it("① 非法选择(凭证不可解析)→ ok:false + routeError,且**不写盘**、revision 不变", async () => {
    const root = tmpRoot(); // 无 secrets:路由预检必失败
    const store = createSessionModelStore(root);
    const api = createSessionModelApi({ store, config: cfg(), root, env: cleanEnv({}) as NodeJS.ProcessEnv });
    const r = await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("route-error");
    expect(r.routeError).toContain("BIGMODEL_CODING_PLAN_API_KEY");
    expect(r.modelOverride).toBeNull();
    expect(r.revision).toBe(0);
    expect(store.get("s1")).toBeUndefined();
    expect(existsSync(sessionModelsPath(root)), "校验失败不得落盘").toBe(false);
    expect(api.get("s1")).toEqual({ modelOverride: null, revision: 0 });
  });

  it("② 合法选择生效:落盘 + revision=1 + effective 指向新端点;derive 出的 provider 用覆盖模型", async () => {
    const root = tmpRoot(SECRETS);
    const store = createSessionModelStore(root);
    const api = createSessionModelApi({ store, config: cfg(), root, env: cleanEnv({}) as NodeJS.ProcessEnv });
    const r = await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(r.ok).toBe(true);
    expect(r.revision).toBe(1);
    expect(r.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(r.effective).toMatchObject({
      model: "GLM-5.3", providerId: "bigmodel-plan",
      baseUrl: "https://open.bigmodel.cn/api/anthropic", apiType: "anthropic",
    });
    expect(r.routeError).toBeUndefined();
    expect(loadSessionModels(root)).toEqual({ s1: { model: "GLM-5.3", providerId: "bigmodel-plan" } });

    const face = createSessionModelFace(cfg(), root, store);
    const derived = face.derive("s1", face.resolve("s1")!);
    expect((derived as unknown as { modelName: string }).modelName).toBe("GLM-5.3");
    face.dispose();
  });

  it("③ model:null 清除覆盖 → 回到跟随全局(条目删除,revision 继续递增)", async () => {
    const root = tmpRoot(SECRETS);
    const store = createSessionModelStore(root);
    const api = createSessionModelApi({ store, config: cfg(), root, env: cleanEnv({}) as NodeJS.ProcessEnv });
    await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan" });
    const cleared = await api.set({ sessionId: "s1", model: null });
    expect(cleared.ok).toBe(true);
    expect(cleared.modelOverride).toBeNull();
    expect(cleared.revision).toBe(2);
    expect(store.get("s1")).toBeUndefined();
    expect(loadSessionModels(root)).toEqual({});
    expect(api.get("s1")).toEqual({ modelOverride: null, revision: 2 });
  });

  it("⑤ 并发两次 set 串行不交错;expectedRevision 不符被拒(不落盘)", async () => {
    const root = tmpRoot(SECRETS);
    const store = createSessionModelStore(root);
    const api = createSessionModelApi({ store, config: cfg(), root, env: cleanEnv({}) as NodeJS.ProcessEnv });
    const [r1, r2] = await Promise.all([
      api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan" }),
      api.set({ sessionId: "s1", model: "glm-5.3", providerId: "main" }),
    ]);
    // 提交顺序即执行顺序:revision 1 → 2(不出现两条都写 revision=1 的交错)
    expect([r1.revision, r2.revision]).toEqual([1, 2]);
    expect(store.get("s1")).toEqual({ model: "glm-5.3", providerId: "main" });
    expect(loadSessionModels(root)).toEqual({ s1: { model: "glm-5.3", providerId: "main" } });

    // CAS:拿旧 revision 再写 → 拒绝且不落盘
    const stale = await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan", expectedRevision: 1 });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("revision-mismatch");
    expect(stale.revision).toBe(2);
    expect(store.get("s1")).toEqual({ model: "glm-5.3", providerId: "main" });

    // 拿当前 revision 写 → 接受
    const fresh = await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan", expectedRevision: 2 });
    expect(fresh.ok).toBe(true);
    expect(fresh.revision).toBe(3);
  });

  it("④ fork 复制父会话覆盖(无覆盖=null,不产生条目)", async () => {
    const root = tmpRoot();
    const store = createSessionModelStore(root);
    const api = createSessionModelApi({ store, root });
    expect(await api.copy("parent", "fork-1")).toBeNull();
    expect(store.get("fork-1")).toBeUndefined();

    store.set("parent", { model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(await api.copy("parent", "fork-2")).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(store.get("fork-2")).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(store.get("parent")).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" }); // 父覆盖不被改
  });
});

// ---------------------------------------------------------------- WS 端到端

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Record<string, unknown>[] = [];
    (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
    ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitMatch(ws: WebSocket, pred: (m: Record<string, unknown>) => boolean, ms = 8000): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待消息超时")), ms);
    const poll = setInterval(() => {
      const hit = inbox.find(pred);
      if (hit) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(hit);
      }
    }, 20);
  });
}

describe("WS:session.model.set 广播 / 非法不落盘 / fork 继承覆盖", () => {
  const OLD_ROOT = process.env.GENIE_REPO_ROOT;
  let root = "";
  let app: GatewayApp | null = null;
  let server: Server | null = null;
  let store: ReturnType<typeof createSessionModelStore> | null = null;

  beforeAll(async () => {
    await acquireEnvLock("session-model.test.ts");
  });
  afterAll(() => {
    releaseEnvLock("session-model.test.ts");
  });

  beforeEach(async () => {
    for (const k of ["GENIE_LLM_API_KEY", "BIGMODEL_CODING_PLAN_API_KEY"]) delete process.env[k];
    root = tmpRoot(); // 先无 secrets:非法选择用例需要「凭证不可解析」的真实条件(下面②再补)
    // root 必须在装配前钉到 GENIE_REPO_ROOT:session 门面的 root=repoRoot()(凭证预检读该目录 secrets)
    process.env.GENIE_REPO_ROOT = root;
    store = createSessionModelStore(root);
    app = createGatewayApp({
      port: 0, useExternalHttp: true, sessionModels: store,
      config: cfg() as unknown as Record<string, unknown>,
      journalDir: undefined,
    });
    server = createServer();
    await new Promise<void>((r) => server!.listen(0, r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    app.attachWs(server);
    (server as unknown as { __port: number }).__port = port;
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    await new Promise<void>((r) => server?.close(() => r()) ?? r());
    server = null;
    store = null;
    if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = OLD_ROOT;
  });

  it("合法 set → 两个连接都收到 session.model.result(ok/revision/effective);非法 set 不落盘", async () => {
    process.env.GENIE_REPO_ROOT = root; // session 门面的 root=repoRoot()(凭证预检读该目录 secrets)
    const port = (server as unknown as { __port: number }).__port;
    const a = await connect(port);
    const b = await connect(port);

    // ① 非法选择:凭证已被删除 → route-error,不写盘
    const bad = await (async () => {
      a.send(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "ws-s1", model: "GLM-5.3", providerId: "bigmodel-plan" }));
      return waitMatch(a, (m) => m.type === "session.model.result" && m.sessionId === "ws-s1");
    })();
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("route-error");
    expect(String(bad.routeError)).toContain("BIGMODEL_CODING_PLAN_API_KEY");
    expect(existsSync(sessionModelsPath(root)), "非法选择不得落盘").toBe(false);

    // ② 补上凭证后合法:广播到另一个连接(多标签同步),revision=1
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify(SECRETS), "utf-8");
    const aBad = (a as unknown as { __inbox: Record<string, unknown>[] }).__inbox.length;
    a.send(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "ws-s1", model: "GLM-5.3", providerId: "bigmodel-plan" }));
    const gotB = await waitMatch(b, (m) => m.type === "session.model.result" && m.sessionId === "ws-s1" && m.ok === true);
    expect(gotB.revision).toBe(1);
    expect(gotB.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect((gotB.effective as { baseUrl?: string }).baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    await waitMatch(a, (m) => m.type === "session.model.result" && m.ok === true);
    expect((a as unknown as { __inbox: unknown[] }).__inbox.length).toBeGreaterThan(aBad);
    expect(loadSessionModels(root)).toEqual({ "ws-s1": { model: "GLM-5.3", providerId: "bigmodel-plan" } });

    // ③ model:null 清除
    a.send(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "ws-s1", model: null }));
    const cleared = await waitMatch(b, (m) => m.type === "session.model.result" && m.sessionId === "ws-s1" && m.revision === 2);
    expect(cleared.modelOverride).toBeNull();
    expect(loadSessionModels(root)).toEqual({});
    a.close();
    b.close();
  }, 30000);

  it("n-m7:set 带 effort → 落盘条目含 effort;effort:null 清除该字段(回全局)", async () => {
    process.env.GENIE_REPO_ROOT = root;
    const port = (server as unknown as { __port: number }).__port;
    const ws = await connect(port);
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify(SECRETS), "utf-8");

    ws.send(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "ws-eff", model: "GLM-5.3", providerId: "bigmodel-plan", effort: "medium" }));
    const set = await waitMatch(ws, (m) => m.type === "session.model.result" && m.sessionId === "ws-eff" && m.ok === true);
    expect(set.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan", effort: "medium" });
    expect(loadSessionModels(root)["ws-eff"]).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan", effort: "medium" });

    // effort:null = 清除该字段(模型覆盖仍在)
    ws.send(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "ws-eff", model: "GLM-5.3", providerId: "bigmodel-plan", effort: null, expectedRevision: 1 }));
    const cleared = await waitMatch(ws, (m) => m.type === "session.model.result" && m.sessionId === "ws-eff" && m.revision === 2);
    expect(cleared.ok).toBe(true);
    expect(cleared.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(loadSessionModels(root)["ws-eff"]?.effort).toBeUndefined();
    ws.close();
  }, 30000);

  it("n-m5:task.deleteSession 清该会话覆盖(其它会话不受影响)", async () => {
    process.env.GENIE_REPO_ROOT = root;
    const port = (server as unknown as { __port: number }).__port;
    const ws = await connect(port);
    store!.set("sess-gone", { model: "GLM-5.3", providerId: "bigmodel-plan" });
    store!.set("sess-keep", { model: "glm-5.3", providerId: "main" });
    // 造一条该会话的任务(deleteSession 无任务时会早退,不会走到清覆盖分支)
    const task = app!.taskManager.submit("user", "sess-gone", "将被删除");

    ws.send(JSON.stringify({ v: 1, type: "task.deleteSession", sessionId: "sess-gone" }));
    await waitMatch(ws, (m) => m.type === "git.ok" && m.op === "task-delete-session");
    expect(task.id).toBeTruthy();
    expect(store!.get("sess-gone"), "会话删除后覆盖必须清掉").toBeUndefined();
    expect(store!.get("sess-keep"), "别的会话覆盖不受影响").toEqual({ model: "glm-5.3", providerId: "main" });
    expect(loadSessionModels(root)["sess-gone"]).toBeUndefined();
    ws.close();
  }, 30000);

  it("session.fork 继承父会话模型覆盖:fork 会话 session.model.get 读回同一覆盖", async () => {
    process.env.GENIE_REPO_ROOT = root;
    const port = (server as unknown as { __port: number }).__port;
    const ws = await connect(port);
    store!.set("ws-parent", { model: "GLM-5.3", providerId: "bigmodel-plan" });
    app!.journal.append({ kind: "message.user", sessionId: "ws-parent", payload: { text: "分叉源" } });

    ws.send(JSON.stringify({ v: 1, type: "session.fork", sessionId: "ws-parent" }));
    const fork = await waitMatch(ws, (m) => m.type === "session.fork.result");
    expect(fork.ok).toBe(true);
    expect(fork.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    const forkId = String(fork.sessionId);
    expect(store!.get(forkId)).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });

    ws.send(JSON.stringify({ v: 1, type: "session.model.get", sessionId: forkId }));
    const got = await waitMatch(ws, (m) => m.type === "session.model.result" && m.sessionId === forkId);
    expect(got.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(got.revision).toBe(1);
    ws.close();
  }, 20000);
});

// ---------------------------------------------------------------- m2/m5/m7/m8/m10 补齐面

describe("m2 多进程写不丢(两个独立 store 实例交替写,模拟 worker 子进程与主进程)", () => {
  it("① A/B 两实例交替 set 不同 sid → 盘上两条都在(后写者不吞前写者)", () => {
    const root = tmpRoot();
    const main = createSessionModelStore(root); // 主进程
    const worker = createSessionModelStore(root); // worker 子进程(独立实例,独立缓存)
    main.set("s-main", { model: "glm-5.3", providerId: "main" });
    // worker 的缓存是空的,但写前读盘合并 → 主进程那条不会被整表覆盖吞掉
    worker.set("s-worker", { model: "GLM-5.3", providerId: "bigmodel-plan" });
    main.set("s-main-2", { model: "deepseek-v4.1" }); // 主进程继续写(它的缓存已过期)
    const onDisk = loadSessionModels(root);
    expect(Object.keys(onDisk).sort()).toEqual(["s-main", "s-main-2", "s-worker"]);
    expect(onDisk["s-worker"]).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });

    // 读路径也要能看见别进程写的:main 未 invalidate,靠 mtime 比对自动重载
    expect(worker.get("s-main")).toEqual({ model: "glm-5.3", providerId: "main" });
    expect(main.get("s-worker")).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
  });

  it("② 交替写同一 sid:后写者 revision 建立在盘上版本之上(不出现 revision 倒退/覆盖丢失)", () => {
    const root = tmpRoot();
    const a = createSessionModelStore(root);
    const b = createSessionModelStore(root);
    expect(a.set("s1", { model: "m1" })).toMatchObject({ ok: true, revision: 1 });
    // b 缓存为空 → 若不做读盘合并会算出 revision=1 覆盖 a 的写入(丢更新)
    expect(b.set("s1", { model: "m2" })).toMatchObject({ ok: true, revision: 2 });
    expect(a.set("s1", { model: "m3" })).toMatchObject({ ok: true, revision: 3 });
    expect(loadSessionModels(root)).toEqual({ s1: { model: "m3" } });
    expect(createSessionModelStore(root).revision("s1")).toBe(3);
  });

  it("③ invalidate() 接入读取路径:盘被外部改写后,读前 mtime 变化即重载", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-session-model-ext-"));
    const store = createSessionModelStore(root);
    store.set("s1", { model: "local" });
    expect(store.get("s1")).toEqual({ model: "local" });
    // 外部(另一个进程/测试)直接改盘:内容+额外条目
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(sessionModelsPath(root), JSON.stringify({ s1: { model: "external", revision: 7 }, s2: { model: "new", revision: 1 } }), "utf-8");
    expect(store.get("s1"), "读取路径必须按 mtime 重载").toEqual({ model: "external" });
    expect(store.get("s2")).toEqual({ model: "new" });
    expect(store.revision("s1")).toBe(7);
    // 显式 invalidate 仍然可用(强制下次读盘)
    store.invalidate();
    expect(store.all()).toEqual({ s1: { model: "external" }, s2: { model: "new" } });
  });

  it("④ m8:copy 与并发 set 交错不丢(串行临界区 + 写前读盘合并)", async () => {
    const root = tmpRoot();
    const a = createSessionModelStore(root);
    const b = createSessionModelStore(root);
    // effort 一并带过:m7 覆盖面在 fork 复制时不能只搬 model/providerId(否则子会话档位回全局)
    a.set("parent", { model: "GLM-5.3", providerId: "bigmodel-plan", effort: "xhigh" });
    const [copied] = await Promise.all([
      a.copy("parent", "fork-1"),
      b.set("other", { model: "glm-5.3", providerId: "main" }),
    ]);
    expect(copied).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan", effort: "xhigh" });
    const onDisk = loadSessionModels(root);
    // 三条都在:父、fork 副本、并发 set 的条目(旧实现 copy 绕过 serialize/读盘 → 三者互相覆盖)
    expect(onDisk.parent).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan", effort: "xhigh" });
    expect(onDisk["fork-1"]).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan", effort: "xhigh" });
    expect(onDisk.other).toEqual({ model: "glm-5.3", providerId: "main" });
  });
});

describe("m7 会话级 effort / m10 悬空 providerId / m5 clear+prune", () => {
  it("⑦ effort override 生效与清除:落盘含 effort,derive 出的 provider describe 读到会话档位", async () => {
    const root = tmpRoot(SECRETS);
    const store = createSessionModelStore(root);
    const api = createSessionModelApi({ store, config: cfg(), root, env: cleanEnv({}) as NodeJS.ProcessEnv });
    const set = await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan", effort: "medium" });
    expect(set.ok).toBe(true);
    expect(set.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan", effort: "medium" });
    expect(loadSessionModels(root).s1).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan", effort: "medium" });

    const face = createSessionModelFace(cfg(), root, store);
    const provider = face.derive("s1", face.resolve("s1")!) as unknown as { describe: () => { reasoningEffort?: string } };
    expect(provider.describe().reasoningEffort, "会话 effort 必须落到派生 provider").toBe("medium");
    face.dispose();

    // 清除 effort(传 null)但保留模型覆盖 → 回全局 implementationEffort(缺省 high)
    const cleared = await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan", effort: null, expectedRevision: 1 });
    expect(cleared.ok).toBe(true);
    expect(cleared.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(loadSessionModels(root).s1?.effort).toBeUndefined();
    const face2 = createSessionModelFace(cfg(), root, store);
    const p2 = face2.derive("s1", face2.resolve("s1")!) as unknown as { describe: () => { reasoningEffort?: string } };
    expect(p2.describe().reasoningEffort).toBe("high"); // = 全局 implementationEffort 缺省
    face2.dispose();
  });

  it("⑧ effort 非法值 → ok:false + code=invalid-effort,且不落盘", async () => {
    const root = tmpRoot(SECRETS);
    const store = createSessionModelStore(root);
    const api = createSessionModelApi({ store, config: cfg(), root, env: cleanEnv({}) as NodeJS.ProcessEnv });
    const bad = await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan", effort: "ultra" });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("invalid-effort");
    expect(String(bad.message)).toContain("ultra");
    expect(store.get("s1")).toBeUndefined();
    expect(existsSync(sessionModelsPath(root))).toBe(false);
    // ""=显式关也是合法值(请求不带 reasoning_effort)
    const off = await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan", effort: "" });
    expect(off.ok).toBe(true);
    expect(off.modelOverride?.effort).toBe("");
  });

  it("⑨ model.switch 审计带 oldModel/oldProviderId(切换前值)", async () => {
    const root = tmpRoot(SECRETS);
    const store = createSessionModelStore(root);
    const events: { sessionId: string; payload: Record<string, unknown> }[] = [];
    const api = createSessionModelApi({
      store, config: cfg(), root, env: cleanEnv({}) as NodeJS.ProcessEnv,
      journal: { append: (e) => events.push({ sessionId: e.sessionId, payload: e.payload }) },
    });
    await api.set({ sessionId: "s1", model: "glm-5.3", providerId: "main" });
    await api.set({ sessionId: "s1", model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(events).toHaveLength(2);
    // 首次切:无旧值 → null
    expect(events[0]!.payload).toMatchObject({ oldModel: null, oldProviderId: null, model: "glm-5.3", source: "session" });
    // 二次切:旧值来自上一次写入
    expect(events[1]!.payload).toMatchObject({
      oldModel: "glm-5.3", oldProviderId: "main", model: "GLM-5.3", providerId: "bigmodel-plan", revision: 2,
    });
  });

  it("⑩ 悬空 providerId(Provider 已删除)→ 被清理、保留 model,并记 warning", async () => {
    const root = tmpRoot(SECRETS);
    const store = createSessionModelStore(root);
    // 先写一条指向 main 的覆盖,再用「main 已不存在」的 config 写入新选择
    store.set("s1", { model: "glm-5.3", providerId: "main" });
    const shrunk = cfg(); // 从 providers 里剔除 main,只剩 bigmodel-plan
    shrunk.providers = shrunk.providers.filter((p) => p.id !== "main");
    const api = createSessionModelApi({ store, config: shrunk, root, env: cleanEnv({}) as NodeJS.ProcessEnv });
    const r = await api.set({ sessionId: "s1", model: "glm-5.3", providerId: "main" });
    expect(r.ok, "悬空 providerId 清理后应仍可写入(不是硬失败)").toBe(true);
    expect(r.modelOverride).toEqual({ model: "glm-5.3" }); // providerId 被清、model 保留
    expect(String(r.warning)).toContain("main");
    expect(loadSessionModels(root).s1).toEqual({ model: "glm-5.3" });
  });

  it("⑪ clear(sid) 生效 + all()/读取路径 prune 上限(超出按最旧清理)", () => {
    const root = tmpRoot(SECRETS);
    const store = createSessionModelStore(root);
    store.set("s1", { model: "m1" });
    store.set("s2", { model: "m2" });
    expect(store.clear("s1")).toBe(true); // 原本有覆盖
    expect(store.clear("s1")).toBe(false); // 再清=无覆盖
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toEqual({ model: "m2" });
    expect(loadSessionModels(root)).toEqual({ s2: { model: "m2" } });

    // prune:造 LIMIT+5 条(每条 updatedAt 递增 → 最旧的 5 条被清)
    const many: Record<string, { model: string; revision: number; updatedAt: number }> = {};
    for (let i = 0; i < SESSION_MODEL_PRUNE_LIMIT + 5; i++) {
      many[`p${String(i).padStart(4, "0")}`] = { model: `m${i}`, revision: 1, updatedAt: 1_000_000 + i };
    }
    saveSessionModels(root, many);
    const reloaded = createSessionModelStore(root);
    const all = reloaded.all(); // 读取路径触发 prune
    expect(Object.keys(all)).toHaveLength(SESSION_MODEL_PRUNE_LIMIT);
    expect(all.p0000, "最旧条目被清理").toBeUndefined();
    expect(all.p0004).toBeUndefined();
    expect(all.p0005, "边界:第 6 条保留").toEqual({ model: "m5" });
    expect(Object.keys(loadSessionModels(root))).toHaveLength(SESSION_MODEL_PRUNE_LIMIT); // 清理已落盘
  });
});
