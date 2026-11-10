/**
 * per-session 主模型(白板「per-session 主模型」)接线面:
 *  ① WS 端到端:session.model.set → store 落盘(.genie/session-models.json)+ journal 记
 *     {kind:"model.switch", source:"session"};session.model.get → modelOverride/null。
 * ② resolveSessionModelSwitch 预检:有凭证 → effective(Registry 语义,路由随模型拥有者);
 *     凭证不可解析 → routeError(可操作文案),绝不假装生效。
 * ③ createSessionModelFace 实例选择:缓存命中同实例 / override 变更重建 / 派生失败回退
 *     undefined(fail-soft)/ 无覆盖 resolve=undefined。
 * 覆盖层级说明:runWithAgent 内「派生 vs 共享」分支(agent-wiring.ts L2124-2135)为 3 行
 * 直通逻辑(override→derive→替换 llm),其装配根(repoRoot())非测试可控注入面,故本文件
 * 以 ③(face 实例选择)+ ①(装配链 set→store→journal)覆盖,不直接驱动 runWithAgent。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { ConfigSchema } from "@lampgenie/core";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import {
  createSessionModelStore,
  createSessionModelFace,
  resolveSessionModelSwitch,
  sessionModelsPath,
} from "../src/session-model.js";

function tmpRoot(secrets: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gh-session-llm-"));
  mkdirSync(join(root, ".genie"), { recursive: true });
  writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify(secrets), "utf-8");
  return root;
}

/** 极简 config fixture:双 Provider(阿里云 chat / 智谱 anthropic),与 model-switch.test.ts 同款。
 * models 参数用于 m1 用例(role 显式配置);models 带 contextWindow 便于 m3 断言。 */
const cfg = (llm: Record<string, unknown> = {}, roles: Record<string, unknown> = {}, ctx: { main?: number; bigmodel?: number } = {}) => ConfigSchema.parse({
  providers: [
    {
      id: "main", name: "主端点", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY",
      models: [
        { name: "glm-5.3", ...(ctx.main ? { contextWindow: ctx.main } : {}) },
        { name: "deepseek-v4.1-flash-1017", contextWindow: 131072 },
      ],
    },
    {
      id: "bigmodel-plan", name: "智谱套餐", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", apiType: "anthropic",
      models: [
        { name: "GLM-5.3", contextWindow: ctx.bigmodel ?? 200000 },
        { name: "GLM-5.3-Flash", contextWindow: 65536 },
      ],
    },
  ],
  coding: {
    llm: {
      providerId: "main", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", model: "deepseek-v4.1-flash-1017", ...llm,
    },
    models: roles,
  },
});

// 凭证解析 env 兜底会读 process.env:保存/恢复 + 显式清键,保证凭证路径完全由 fixture 决定。
const OLD_ENV = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in OLD_ENV)) delete process.env[k];
  for (const [k, v] of Object.entries(OLD_ENV)) process.env[k] = v;
});

function waitMsg(w: WebSocket, type: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("timeout:" + type)), timeoutMs);
    const on = (raw: unknown) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === type) {
        clearTimeout(to);
        w.off("message", on);
        res(m);
      }
    };
    w.on("message", on);
  });
}

describe("session.model.set/get WS 端到端(装配:store 落盘 + journal 审计)", () => {
  beforeEach(() => {
    delete process.env.BIGMODEL_CODING_PLAN_API_KEY;
    delete process.env.GENIE_LLM_API_KEY;
  });

  it("set → session.model.result 回包 + .genie/session-models.json 落盘该 sid + journal 记 model.switch source=session", async () => {
    const root = tmpRoot();
    const store = createSessionModelStore(root);
    const app: GatewayApp = createGatewayApp({
      port: 0, journalDir: undefined, llm: undefined, useExternalHttp: true, sessionModels: store,
    });
    const server: Server = createServer();
    try {
      await new Promise<void>((r) => server.listen(0, r));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      app.attachWs(server);
      const w = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((r, rej) => { w.on("open", r); w.on("error", rej); });

      // 先 get:无覆盖 → modelOverride=null(服务端确认语义,区别于「未初始化」)
      w.send(JSON.stringify({ v: 1, type: "session.model.get", sessionId: "sm-s1" }));
      const g0 = await waitMsg(w, "session.model.result");
      expect(g0.modelOverride).toBeNull();

      w.send(JSON.stringify({ v: 1, type: "session.model.set", sessionId: "sm-s1", model: "GLM-5.3", providerId: "bigmodel-plan" }));
      const r = await waitMsg(w, "session.model.result");
      expect(r.sessionId).toBe("sm-s1");
      expect(r.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });

      // store 落盘:.genie/session-models.json 出现该 sid(持久化闭环,换实例读回同值)
      const file = sessionModelsPath(root);
      expect(existsSync(file), "覆盖表必须落盘").toBe(true);
      // 2026-10-22:落盘条目新增 revision(CAS 版本,写入即 +1;重启后仍可判「你手上那版过期了」)
      // m5/m2 补齐:新增 updatedAt(prune 排序用,按最旧清理),故断言里剥掉它
      const onDisk = JSON.parse(readFileSync(file, "utf-8")) as Record<string, { model?: string; providerId?: string; revision?: number; updatedAt?: number }>;
      expect(onDisk["sm-s1"]).toMatchObject({ model: "GLM-5.3", providerId: "bigmodel-plan", revision: 1 });
      expect(typeof onDisk["sm-s1"]!.updatedAt, "条目带写入时刻(prune 排序)").toBe("number");
      expect(createSessionModelStore(root).get("sm-s1")).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });

      // journal 审计:model.switch 落该 sid,payload.source="session"(与 cfg.set 全局热切的来源可区分)
      const ev = app.journal.readAll().find((e) => e.kind === "model.switch" && e.sessionId === "sm-s1");
      expect(ev, "journal 应记 model.switch").toBeTruthy();
      expect((ev?.payload as { source?: string }).source).toBe("session");
      expect((ev?.payload as { model?: string }).model).toBe("GLM-5.3");
      expect((ev?.payload as { providerId?: string }).providerId).toBe("bigmodel-plan");

      // get 回读:命中刚写的覆盖
      w.send(JSON.stringify({ v: 1, type: "session.model.get", sessionId: "sm-s1" }));
      const g1 = await waitMsg(w, "session.model.result");
      expect(g1.modelOverride).toEqual({ model: "GLM-5.3", providerId: "bigmodel-plan" });
      w.close();
    } finally {
      await app.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("resolveSessionModelSwitch 预检(set 回包只读,不热切全局)", () => {
  beforeEach(() => {
    delete process.env.BIGMODEL_CODING_PLAN_API_KEY;
    delete process.env.GENIE_LLM_API_KEY;
  });

  it("覆盖到智谱模型 + 凭证可解析 → effective 路由随模型拥有者(anthropic/专属密钥),无 routeError", () => {
    const root = tmpRoot({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret" });
    const r = resolveSessionModelSwitch(cfg(), { model: "GLM-5.3", providerId: "bigmodel-plan" }, root, {} as NodeJS.ProcessEnv);
    expect(r.routeError).toBeUndefined();
    expect(r.effective).toMatchObject({
      model: "GLM-5.3", providerId: "bigmodel-plan",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiType: "anthropic", credentialSource: "secrets", unverified: false,
    });
  });

  it("凭证完全缺失 → routeError 点名缺失的 env 键,effective.credentialSource=none(不假装已生效)", () => {
    const root = tmpRoot(); // 无任何 secrets
    const r = resolveSessionModelSwitch(cfg(), { model: "GLM-5.3", providerId: "bigmodel-plan" }, root, {} as NodeJS.ProcessEnv);
    expect(r.routeError).toContain("BIGMODEL_CODING_PLAN_API_KEY");
    expect(r.effective?.credentialSource).toBe("none");
    expect(r.effective?.model).toBe("GLM-5.3"); // 选择已记录,但运行时不会切(routeError 拦截)
  });
});

describe("createSessionModelFace 实例选择(派生 provider 生命周期)", () => {
  beforeEach(() => {
    delete process.env.BIGMODEL_CODING_PLAN_API_KEY;
    delete process.env.GENIE_LLM_API_KEY;
  });

  it("无覆盖 → resolve=undefined;有覆盖 → resolve 出 override 且同 override 重复 derive 命中缓存(同一实例)", () => {
    const root = tmpRoot({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret" });
    const store = createSessionModelStore(root);
    const face = createSessionModelFace(cfg(), root, store);
    expect(face.resolve("no-such-sid")).toBeUndefined(); // 无覆盖:调用方走共享 llm

    const ov = { model: "GLM-5.3", providerId: "bigmodel-plan" } as const;
    store.set("s1", { ...ov });
    expect(face.resolve("s1")).toEqual({ ...ov });

    const p1 = face.derive("s1", { ...ov });
    expect(p1, "凭证可解析时必须建出独立实例").toBeTruthy();
    const p2 = face.derive("s1", { ...ov }); // 同 override:缓存命中,不重建
    expect(p2).toBe(p1);
    // 不同 sid 各自独立实例(会话间不共享派生 provider)
    const other = face.derive("s2", { ...ov });
    expect(other).toBeTruthy();
    expect(other).not.toBe(p1);
  });

  it("override 值变更(providerId::model 对变了)→ 重建新实例;旧实例引用不被就地改", () => {
    const root = tmpRoot({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "aliyun-secret" });
    const store = createSessionModelStore(root);
    const face = createSessionModelFace(cfg(), root, store);
    const p1 = face.derive("s1", { model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(p1).toBeTruthy();
    const p2 = face.derive("s1", { model: "glm-5.3", providerId: "main" }); // 换模型+换 provider
    expect(p2).toBeTruthy();
    expect(p2).not.toBe(p1);
    // 切回原 override → 键与当前缓存不同,同样重建(单条缓存语义:每次变更一个新实例,
    // 运行中任务持旧引用继续跑完,新任务拿新实例——「不就地改旧实例」才是要锁的红线)
    const p3 = face.derive("s1", { model: "GLM-5.3", providerId: "bigmodel-plan" });
    expect(p3).toBeTruthy();
    expect(p3).not.toBe(p2);
  });

  it("派生失败(凭证不可解析)→ warn + undefined(调用方回退共享 llm,不抛)", () => {
    const root = tmpRoot(); // secrets 为空:buildLlmFromConfig 必抛
    const store = createSessionModelStore(root);
    const face = createSessionModelFace(cfg(), root, store);
    let warned = "";
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned += a.map(String).join(" "); };
    try {
      const p = face.derive("s1", { model: "GLM-5.3", providerId: "bigmodel-plan" });
      expect(p).toBeUndefined(); // fail-soft:不抛、不给半成品
      expect(warned).toContain("s1"); // warn 带会话 id,现场可定位
    } finally {
      console.warn = origWarn;
    }
  });
});

/** m1 角色轨(m1)/ m3 contextWindow 随会话模型变 */
const modelNameOf = (p: unknown): string | undefined => (p as { modelName?: string } | undefined)?.modelName;

describe("m1 角色轨跟随会话覆盖 / m3 contextWindow 重算", () => {
  beforeEach(() => {
    delete process.env.BIGMODEL_CODING_PLAN_API_KEY;
    delete process.env.GENIE_LLM_API_KEY;
  });

  it("⑦ 角色均未显式配置 → subagent/compact/review 全部取会话覆盖模型", () => {
    const root = tmpRoot({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "aliyun-secret" });
    const store = createSessionModelStore(root);
    const face = createSessionModelFace(cfg(), root, store);
    const ov = { model: "GLM-5.3", providerId: "bigmodel-plan" } as const;
    store.set("s1", { ...ov });
    const roles = face.deriveRoleModels("s1", { ...ov });
    expect(roles, "角色轨必须派生成功").toBeTruthy();
    expect(modelNameOf(roles!.subagent)).toBe("GLM-5.3");
    expect(modelNameOf(roles!.compact)).toBe("GLM-5.3");
    expect(modelNameOf(roles!.review)).toBe("GLM-5.3");
    // compact 未显式配置=旧语义 undefined;会话覆盖下必须显式建出(否则压缩仍走全局)
    expect(roles!.compact).toBeTruthy();
    // 端点也随会话走(anthropic 端点,不是全局 aliyun)
    expect((roles!.subagent as unknown as { describe: () => { baseUrl: string } }).describe().baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    face.dispose();
  });

  it("⑧ 角色有显式 model → 不被会话覆盖(显式优先);同 Provider 的显式角色只换 model", () => {
    const root = tmpRoot({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "aliyun-secret" });
    const store = createSessionModelStore(root);
    // review 显式指定 main 端点的 glm-5.3(与全局同 Provider);subagent 未显式配置
    const face = createSessionModelFace(
      cfg({}, { review: { model: "glm-5.3", providerId: "main" } }),
      root,
      store,
    );
    const ov = { model: "GLM-5.3", providerId: "bigmodel-plan" } as const;
    store.set("s1", { ...ov });
    const roles = face.deriveRoleModels("s1", { ...ov })!;
    // review:显式 providerId=main ≠ 会话 providerId=bigmodel-plan → 保留显式配置(端点/模型都不动)
    expect(modelNameOf(roles.review)).toBe("glm-5.3");
    expect((roles.review as unknown as { describe: () => { baseUrl: string } }).describe().baseUrl).toBe("https://aliyun.example/compatible-mode");
    // subagent:未显式配置 → 跟随会话
    expect(modelNameOf(roles.subagent)).toBe("GLM-5.3");
    // 显式同 Provider 的角色:model 换成会话模型(端点仍是用户显式选的那个)
    const sameProv = createSessionModelFace(cfg({}, { subagent: { model: "glm-5.3", providerId: "bigmodel-plan" } }), root, store);
    const r2 = sameProv.deriveRoleModels("s1", { ...ov })!;
    expect(modelNameOf(r2.subagent)).toBe("GLM-5.3");
    face.dispose();
    sameProv.dispose();
  });

  it("⑨ contextWindow 随会话模型重算(providerId 精确匹配);无 meta → undefined 供调用方回退注入值", () => {
    const root = tmpRoot({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "aliyun-secret" });
    const store = createSessionModelStore(root);
    const face = createSessionModelFace(cfg({}, {}, { main: 32768, bigmodel: 200000 }), root, store);
    expect(face.contextWindowFor({ model: "GLM-5.3", providerId: "bigmodel-plan" })).toBe(200000);
    expect(face.contextWindowFor({ model: "glm-5.3", providerId: "main" })).toBe(32768);
    // 同一模型名在两个 Provider 目录都有:按会话选中的 Provider 取(200000 vs 32768)
    expect(face.contextWindowFor({ model: "GLM-5.3" })).toBe(200000);
    // 未验证模型(不在任何目录)→ undefined(调用方回退启动时注入的定值)
    expect(face.contextWindowFor({ model: "no-such-model", providerId: "main" })).toBeUndefined();
    face.dispose();
  });
});
