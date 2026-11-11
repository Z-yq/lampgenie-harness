/**
 * 任务类别路由接线回归:factory.createModelRouter + app.ts 记忆学习链路由。
 * 两段:
 * A 源码断言(接线存在且既有路径未动)——文本断言,防「实现被静默回滚/接线被删」;
 * B 纯路径(ConfigSchema 造 Config + 假 env)——锁解析语义(base/table/task-class/freeOnly)、
 * provider 实例缓存与 fail-soft(构建失败回 undefined 且绝不抛)。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { ConfigSchema, type Config } from "@lampgenie/core";
import { createModelRouter } from "../src/factory.js";
import type { TaskModelKind } from "@lampgenie/runtime/agent/task-model-routing";

const factorySrc = readFileSync(new URL("../src/factory.ts", import.meta.url), "utf-8");
const appSrc = readFileSync(new URL("../src/app.ts", import.meta.url), "utf-8");

const KEY_ENV = "TMR_TEST_KEY";

/** 造 Config:主轨给死 baseUrl/model/apiKeyEnv,providers 目录留空(手填模型=unverified 直通)。 */
function makeConfig(routing?: Record<string, unknown>): Config {
  return ConfigSchema.parse({
    coding: {
      llm: {
        providerId: "p-base",
        model: "base-m",
        baseUrl: "https://base.test/v1",
        apiKeyEnv: KEY_ENV,
      },
      ...(routing ? { models: { routing } } : {}),
    },
  }) as Config;
}

afterEach(() => {
  delete process.env[KEY_ENV];
  delete process.env.GENIE_FREE_PROVIDERS;
});

describe("A 源码断言(接线在位)", () => {
  it("factory 导出 createModelRouter/providerFor 且用 Map 缓存", () => {
    expect(factorySrc).toContain("export function createModelRouter");
    expect(factorySrc).toContain("providerFor");
    expect(factorySrc).toContain("new Map");
  });

  it("app.ts 记忆学习链 = routing.memory > auxLlm > llm", () => {
    expect(appSrc).toContain('providerFor("memory")');
 // -b:router 只在配了 routing 表时创建,故调用点用可选链(无表=旧回退逐字不变)。
    expect(appSrc).toMatch(/const memoryLlm = modelRouter\??\.providerFor\("memory"\) \?\? opts\.auxLlm \?\? opts\.llm;/);
  });

  it("app.ts 仅在配了 routing 表时建 router,并把同一实例下传 server", () => {
    expect(appSrc).toMatch(/const modelRouter = routingTable \? createModelRouter\(opts\.config as unknown as Config, repoRoot\(\)\) : undefined;/);
    expect(appSrc).toContain("coding?.models?.routing");
    expect(appSrc).toMatch(/\.\.\.\(modelRouter \? \{ modelRouter \} : \{\}\),/);
  });

  it("server.ts 摘要/压缩两处优先 router,顺序在前且旧回退保留", () => {
    const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf-8");
 // 结构类型(不引 factory):kind 只放行 summary/compact。
    expect(serverSrc).toMatch(/modelRouter\?: \{\s*providerFor\(kind: "summary" \| "compact", taskClass\?: string\)/);
    expect(serverSrc).toContain('const smallLlm = opts.modelRouter?.providerFor("summary") ?? opts.models?.compact ?? opts.auxLlm;');
    expect(serverSrc).toContain('const compactLlm = opts.modelRouter?.providerFor("compact") ?? opts.models?.compact ?? opts.auxLlm ?? (opts.llm as');
  });

  it("既有角色构建路径未被改动(compact/review 仍在 roleFrom)", () => {
    expect(factorySrc).toContain('roleFrom("compact"');
    expect(factorySrc).toContain('roleFrom("review"');
  });
});

describe("B 解析路径(ConfigSchema 造 Config)", () => {
  it("无 routing 表 → 走 base", () => {
    process.env[KEY_ENV] = "k-base";
    const r = createModelRouter(makeConfig(), ".").resolve("memory");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("base");
      expect(r.route.model).toBe("base-m");
    }
  });

  it("表命中 → source=table 且带表项模型", () => {
    process.env[KEY_ENV] = "k-mem";
    const cfg = makeConfig({
      memory: { providerId: "p-mem", model: "mem-m", baseUrl: "https://mem.test/v1", apiKeyEnv: KEY_ENV },
    });
    const r = createModelRouter(cfg, ".").resolve("memory");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("table");
      expect(r.route.model).toBe("mem-m");
      expect(r.route.providerId).toBe("p-mem");
    }
  });

  it("taskClasses 门:命中=task-class,不命中=base", () => {
    process.env[KEY_ENV] = "k-mem";
    const cfg = makeConfig({
      memory: {
        providerId: "p-mem", model: "mem-m", baseUrl: "https://mem.test/v1", apiKeyEnv: KEY_ENV,
        taskClasses: ["coding"],
      },
    });
    const router = createModelRouter(cfg, ".");
    const hit = router.resolve("memory", "coding");
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.source).toBe("task-class");
    const miss = router.resolve("memory", "office");
    expect(miss.ok).toBe(true);
    if (miss.ok) {
      expect(miss.source).toBe("base");
      expect(miss.route.model).toBe("base-m");
    }
  });

  it("未知 kind → INVALID,不抛", () => {
    process.env[KEY_ENV] = "k-base";
    const r = createModelRouter(makeConfig(), ".").resolve("bogus" as TaskModelKind);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID");
  });

  it("providerFor 缓存同一实例,且与 main 不同实例", () => {
    process.env[KEY_ENV] = "k-mem";
    const cfg = makeConfig({
      memory: { providerId: "p-mem", model: "mem-m", baseUrl: "https://mem.test/v1", apiKeyEnv: KEY_ENV },
    });
    const router = createModelRouter(cfg, ".");
    const p1 = router.providerFor("memory");
    const p2 = router.providerFor("memory");
    expect(p1).toBeDefined();
    expect(p2).toBe(p1);
    const main = router.providerFor("main");
    expect(main).toBeDefined();
    expect(main).not.toBe(p1);
  });

  it("构建失败(凭证不可解析)→ undefined 且不抛,重复调用仍 undefined", () => {
    const cfg = makeConfig({
      memory: {
        providerId: "p-dead", model: "mem-m", baseUrl: "https://dead.test/v1",
        apiKeyEnv: "TMR_ABSENT_KEY_ENV",
      },
    });
    delete process.env.TMR_ABSENT_KEY_ENV;
    const router = createModelRouter(cfg, ".");
    expect(router.providerFor("memory")).toBeUndefined();
    expect(router.providerFor("memory")).toBeUndefined();
  });

  it("freeOnly:未声明免费=回 base;设 GENIE_FREE_PROVIDERS 后立即生效(每次现读)", () => {
    process.env[KEY_ENV] = "k-mem";
    delete process.env.GENIE_FREE_PROVIDERS;
    const cfg = makeConfig({
      memory: {
        providerId: "p-mem", model: "mem-m", baseUrl: "https://mem.test/v1", apiKeyEnv: KEY_ENV,
        freeOnly: true,
      },
    });
    const router = createModelRouter(cfg, ".");
    const before = router.resolve("memory");
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.source).toBe("base");

    process.env.GENIE_FREE_PROVIDERS = "p-mem";
    const after = router.resolve("memory");
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.source).toBe("table");
      expect(after.route.providerId).toBe("p-mem");
    }
  });

  it("config 运行时为 undefined(装配面断言传入)→ 不抛,resolve INVALID/providerFor undefined", () => {
    const router = createModelRouter(undefined as unknown as Config, ".");
    const r = router.resolve("memory");
    expect(r.ok).toBe(false);
    expect(router.providerFor("memory")).toBeUndefined();
  });
});
