/**
 * Source Registry 纯逻辑直测:kind 校验与保留名 / 实例 config 与 claim / 事件写面与 policy /
 * 重放(含 JSON 往返续 seq)/ 健康声明去重 / 失效 / 只读 scope / 上下文写面。全内存零 IO。
 *
 * 断言一律用稳定码(SOURCE_*),reason 只做 includes 的可选断言;不读实现私有字段。
 */
import { describe, expect, it } from "vitest";
import {
  SOURCE_CODES,
  createRegistry,
  createSourceContext,
  healthClaim,
  invalidateInstance,
  listEnabled,
  registerInstance,
  registerKind,
  replay,
  sourceScope,
  writeEvent,
} from "../src/agent/source-registry.ts";
import type { SourceEvent, SourceRegistry } from "../src/agent/source-registry.ts";

/** 夹具 kind:邮件源,from 为事件必填字段,mailbox.url 为 config 必填字段。 */
function makeKind(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "mail",
    identity: "mail-bot@example",
    title: "邮件源",
    schema: "mail.event@v1",
    fields: [
      { name: "from", type: "string", required: true },
      { name: "mailbox.url", type: "string", required: true, in: "config" },
    ],
    facts: { readPosition: "imap:INBOX", botIdentity: "mail-bot@example" },
    health: { key: "mail.health" },
    channel: { address: "mail://INBOX" },
    threadContext: { field: "threadId" },
    ...overrides,
  };
}

const MAIL_CONFIG: Record<string, unknown> = { "mailbox.url": "imap://INBOX" };

function makeRegistryWithMail(overrides: Record<string, unknown> = {}): SourceRegistry {
  const registry = createRegistry();
  const result = registerKind(registry, makeKind(overrides));
  if (!result.ok) throw new Error(`夹具 kind 注册失败: ${result.code}`);
  return registry;
}

function addInstance(
  registry: SourceRegistry,
  id: string,
  config: Record<string, unknown> = { ...MAIL_CONFIG },
  enabled?: boolean,
) {
  const input: { id: string; kind: string; config?: Record<string, unknown>; enabled?: boolean } = {
    id,
    kind: "mail",
    config,
  };
  if (enabled !== undefined) input.enabled = enabled;
  return registerInstance(registry, input);
}

function makeRegistryWithInstance(id = "i1"): SourceRegistry {
  const registry = makeRegistryWithMail();
  const result = addInstance(registry, id);
  if (!result.ok) throw new Error(`夹具实例注册失败: ${result.code}`);
  return registry;
}

function mailEvent(overrides: Record<string, unknown> = {}): SourceEvent {
  return { type: "mail.received", payload: { from: "alice@example", threadId: "th-1" }, ...overrides };
}

describe("码表与注册表骨架", () => {
  it("SOURCE_CODES 恰为 12 个稳定码且顺序固定", () => {
    expect([...SOURCE_CODES]).toEqual([
      "SOURCE_INVALID",
      "SOURCE_RESERVED_NAME",
      "SOURCE_DUPLICATE_KIND",
      "SOURCE_UNKNOWN_KIND",
      "SOURCE_CONFIG_INVALID",
      "SOURCE_CLAIM_CONFLICT",
      "SOURCE_ENABLED",
      "SOURCE_DISABLED",
      "SOURCE_WROTE",
      "SOURCE_REPLAYED",
      "SOURCE_HEALTH_CLAIMED",
      "SOURCE_HEALTH_CLAIM_DUPLICATE",
    ]);
  });

  it("createRegistry 返回空注册表且 nextSeq 从 1 起", () => {
    const registry = createRegistry();
    expect(registry.kinds).toEqual({});
    expect(registry.instances).toEqual({});
    expect(registry.claims).toEqual({});
    expect(registry.events).toEqual([]);
    expect(registry.nextSeq).toBe(1);
  });

  it("createRegistry 每次返回独立对象", () => {
    const first = createRegistry();
    const second = createRegistry();
    registerKind(first, makeKind());
    expect(second.kinds["mail"]).toBeUndefined();
    expect(Object.keys(first.kinds)).toHaveLength(1);
  });
});

describe("A) registerKind 校验与零变更", () => {
  it("入参非对象 → SOURCE_INVALID 且零变更", () => {
    for (const bad of ["mail", null, undefined, 42, ["mail"]]) {
      const registry = createRegistry();
      const result = registerKind(registry, bad);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("SOURCE_INVALID");
      expect(Object.keys(registry.kinds)).toHaveLength(0);
    }
  });

  it("kind/identity/title/schema 缺失或空白 → SOURCE_INVALID", () => {
    for (const key of ["kind", "identity", "title", "schema"]) {
      const missing = makeKind();
      delete missing[key];
      const registry = createRegistry();
      expect(registerKind(registry, missing).code).toBe("SOURCE_INVALID");
      expect(registerKind(registry, makeKind({ [key]: "   " })).code).toBe("SOURCE_INVALID");
      expect(Object.keys(registry.kinds)).toHaveLength(0);
    }
  });

  it("fields 非数组或含非对象项 → SOURCE_INVALID", () => {
    const registry = createRegistry();
    expect(registerKind(registry, makeKind({ fields: "from" })).code).toBe("SOURCE_INVALID");
    expect(registerKind(registry, makeKind({ fields: ["from"] })).code).toBe("SOURCE_INVALID");
    expect(Object.keys(registry.kinds)).toHaveLength(0);
  });

  it("字段缺 name / type 不在枚举 / in 非法 → SOURCE_INVALID", () => {
    const registry = createRegistry();
    const cases = [
      { type: "string" },
      { name: "from", type: "date" },
      { name: "from", type: "string", in: "payload" },
      { name: "", type: "string" },
    ];
    for (const field of cases) {
      expect(registerKind(registry, makeKind({ fields: [field] })).code).toBe("SOURCE_INVALID");
    }
    expect(Object.keys(registry.kinds)).toHaveLength(0);
  });

  it("facts 非普通对象或值非标量 → SOURCE_INVALID", () => {
    const registry = createRegistry();
    expect(registerKind(registry, makeKind({ facts: ["readPosition"] })).code).toBe("SOURCE_INVALID");
    expect(registerKind(registry, makeKind({ facts: { nested: { a: 1 } } })).code).toBe("SOURCE_INVALID");
    expect(Object.keys(registry.kinds)).toHaveLength(0);
  });

  it("health.key 缺失或空白 → SOURCE_INVALID", () => {
    const registry = createRegistry();
    expect(registerKind(registry, makeKind({ health: undefined })).code).toBe("SOURCE_INVALID");
    expect(registerKind(registry, makeKind({ health: {} })).code).toBe("SOURCE_INVALID");
    expect(registerKind(registry, makeKind({ health: { key: "  " } })).code).toBe("SOURCE_INVALID");
    expect(Object.keys(registry.kinds)).toHaveLength(0);
  });

  it("合法 kind → SOURCE_ENABLED 并返回规范化定义(in 缺省 event)", () => {
    const registry = createRegistry();
    const result = registerKind(registry, makeKind());
    expect(result.ok).toBe(true);
    expect(result.code).toBe("SOURCE_ENABLED");
    expect(result.kind?.kind).toBe("mail");
    expect(result.kind?.fields[0]?.in).toBe("event");
    expect(result.kind?.fields[1]?.in).toBe("config");
    expect(result.kind?.health.key).toBe("mail.health");
    expect(registry.kinds["mail"]?.title).toBe("邮件源");
  });

  it("多次非法输入后仍能注册合法 kind(零变更)", () => {
    const registry = createRegistry();
    for (const field of ["from", "to"]) {
      registerKind(registry, makeKind({ fields: [field] }));
    }
    registerKind(registry, "mail");
    expect(Object.keys(registry.kinds)).toHaveLength(0);
    expect(registerKind(registry, makeKind()).code).toBe("SOURCE_ENABLED");
    expect(Object.keys(registry.kinds)).toEqual(["mail"]);
  });
});

describe("B) 保留名", () => {
  it("kind 为 core → SOURCE_RESERVED_NAME", () => {
    const registry = createRegistry();
    expect(registerKind(registry, makeKind({ kind: "core" })).code).toBe("SOURCE_RESERVED_NAME");
    expect(Object.keys(registry.kinds)).toHaveLength(0);
  });

  it("kind 为 system → SOURCE_RESERVED_NAME", () => {
    const registry = createRegistry();
    const result = registerKind(registry, makeKind({ kind: "system" }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_RESERVED_NAME");
    expect(Object.keys(registry.kinds)).toHaveLength(0);
  });

  it("kind 以 reserved: 开头 → SOURCE_RESERVED_NAME", () => {
    const registry = createRegistry();
    expect(registerKind(registry, makeKind({ kind: "reserved:memory" })).code).toBe("SOURCE_RESERVED_NAME");
    expect(registry.kinds["reserved:memory"]).toBeUndefined();
  });
});

describe("C) 重复 kind", () => {
  it("重复注册 → SOURCE_DUPLICATE_KIND 且旧定义不被覆盖", () => {
    const registry = makeRegistryWithMail();
    const result = registerKind(registry, makeKind({ title: "另一个邮件源" }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_DUPLICATE_KIND");
    expect(registry.kinds["mail"]?.title).toBe("邮件源");
    expect(result.kind?.title).toBe("邮件源");
  });

  it("重复拒绝时 codes 含 SOURCE_DUPLICATE_KIND", () => {
    const registry = makeRegistryWithMail();
    const result = registerKind(registry, makeKind());
    expect(result.codes).toContain("SOURCE_DUPLICATE_KIND");
    expect(result.codes).toHaveLength(1);
  });

  it("重复拒绝后原 kind 仍可实例化", () => {
    const registry = makeRegistryWithMail();
    registerKind(registry, makeKind({ title: "覆盖尝试" }));
    expect(addInstance(registry, "i1").code).toBe("SOURCE_ENABLED");
    expect(registry.instances["i1"]?.kind).toBe("mail");
  });
});

describe("D) registerInstance", () => {
  it("未知 kind → SOURCE_UNKNOWN_KIND 但实例仍落库且 enabled:false", () => {
    const registry = makeRegistryWithMail();
    const result = registerInstance(registry, { id: "i2", kind: "slack", config: {} });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_UNKNOWN_KIND");
    expect(registry.instances["i2"]?.enabled).toBe(false);
    expect(registry.instances["i2"]?.kind).toBe("slack");
  });

  it("未知 kind 的实例不影响已注册实例", () => {
    const registry = makeRegistryWithInstance("i1");
    registerInstance(registry, { id: "i2", kind: "slack" });
    expect(writeEvent(registry, { instanceId: "i1", event: mailEvent() }).code).toBe("SOURCE_WROTE");
    expect(listEnabled(registry).map((instance) => instance.id)).toEqual(["i1"]);
  });

  it("config 缺必填字段 → SOURCE_CONFIG_INVALID 且 enabled:false", () => {
    const registry = makeRegistryWithMail();
    const result = addInstance(registry, "i2", {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_CONFIG_INVALID");
    expect(registry.instances["i2"]?.enabled).toBe(false);
  });

  it("config 字段类型不符 → SOURCE_CONFIG_INVALID", () => {
    const registry = makeRegistryWithMail();
    const result = addInstance(registry, "i2", { "mailbox.url": 42 });
    expect(result.code).toBe("SOURCE_CONFIG_INVALID");
    expect(registry.instances["i2"]?.enabled).toBe(false);
  });

  it("config 非普通对象 → SOURCE_CONFIG_INVALID", () => {
    const registry = makeRegistryWithMail();
    const result = registerInstance(registry, { id: "i2", kind: "mail", config: "imap://INBOX" as never });
    expect(result.code).toBe("SOURCE_CONFIG_INVALID");
    expect(registry.instances["i2"]?.enabled).toBe(false);
  });

  it("claim 冲突 → SOURCE_CLAIM_CONFLICT 且不写 claims", () => {
    const registry = makeRegistryWithMail();
    expect(addInstance(registry, "i1", { ...MAIL_CONFIG, claims: ["feed:inbox"] }).code).toBe("SOURCE_ENABLED");
    const result = addInstance(registry, "i2", { ...MAIL_CONFIG, claims: ["feed:inbox"] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_CLAIM_CONFLICT");
    expect(registry.claims["feed:inbox"]).toBe("i1");
    expect(registry.instances["i2"]?.enabled).toBe(false);
    expect(registry.instances["i2"]?.claims).toEqual([]);
  });

  it("成功注册 → SOURCE_ENABLED 并占用 claims", () => {
    const registry = makeRegistryWithMail();
    const result = addInstance(registry, "i1", { ...MAIL_CONFIG, claims: ["feed:inbox", "feed:sent"] });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("SOURCE_ENABLED");
    expect(registry.claims["feed:inbox"]).toBe("i1");
    expect(registry.claims["feed:sent"]).toBe("i1");
    expect(result.instance?.claims).toEqual(["feed:inbox", "feed:sent"]);
    expect(result.instance?.enabled).toBe(true);
  });

  it("显式 enabled:false → SOURCE_DISABLED 且不占 claims", () => {
    const registry = makeRegistryWithMail();
    const result = addInstance(registry, "i1", { ...MAIL_CONFIG, claims: ["feed:inbox"] }, false);
    expect(result.code).toBe("SOURCE_DISABLED");
    expect(registry.claims["feed:inbox"]).toBeUndefined();
    expect(registry.instances["i1"]?.enabled).toBe(false);
    expect(listEnabled(registry)).toEqual([]);
  });

  it("同 id 重复注册 = 覆盖(幂等,不报错)", () => {
    const registry = makeRegistryWithMail();
    expect(addInstance(registry, "i1", { "mailbox.url": "imap://INBOX" }).code).toBe("SOURCE_ENABLED");
    const second = addInstance(registry, "i1", { "mailbox.url": "imap://Archive" });
    expect(second.ok).toBe(true);
    expect(second.code).toBe("SOURCE_ENABLED");
    expect(Object.keys(registry.instances)).toHaveLength(1);
    expect(registry.instances["i1"]?.config["mailbox.url"]).toBe("imap://Archive");
  });
});

describe("E) writeEvent 唯一写面", () => {
  it("实例不存在 → SOURCE_INVALID 且零事件", () => {
    const registry = makeRegistryWithMail();
    const result = writeEvent(registry, { instanceId: "nope", event: mailEvent() });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_INVALID");
    expect(registry.events).toHaveLength(0);
  });

  it("实例未启用 → SOURCE_DISABLED 且零事件", () => {
    const registry = makeRegistryWithMail();
    addInstance(registry, "i1", MAIL_CONFIG, false);
    const result = writeEvent(registry, { instanceId: "i1", event: mailEvent() });
    expect(result.code).toBe("SOURCE_DISABLED");
    expect(registry.events).toHaveLength(0);
    expect(registry.nextSeq).toBe(1);
  });

  it("payload 缺必填字段 → SOURCE_INVALID 且零事件", () => {
    const registry = makeRegistryWithInstance();
    const result = writeEvent(registry, { instanceId: "i1", event: { type: "mail.received", payload: {} } });
    expect(result.code).toBe("SOURCE_INVALID");
    expect(registry.events).toHaveLength(0);
  });

  it("payload 字段类型不符 → SOURCE_INVALID", () => {
    const registry = makeRegistryWithInstance();
    const result = writeEvent(registry, {
      instanceId: "i1",
      event: { type: "mail.received", payload: { from: 7 } },
    });
    expect(result.code).toBe("SOURCE_INVALID");
    expect(registry.events).toHaveLength(0);
  });

  it("event.type 空串 → SOURCE_INVALID", () => {
    const registry = makeRegistryWithInstance();
    const result = writeEvent(registry, { instanceId: "i1", event: { type: "  ", payload: { from: "a@b" } } });
    expect(result.code).toBe("SOURCE_INVALID");
    expect(registry.events).toHaveLength(0);
  });

  it("成功写入 → SOURCE_WROTE,record 落库且 seq 从 1 连续递增", () => {
    const registry = makeRegistryWithInstance();
    const first = writeEvent(registry, { instanceId: "i1", event: mailEvent() });
    const second = writeEvent(registry, { instanceId: "i1", event: mailEvent({ type: "mail.flagged" }) });
    expect(first.code).toBe("SOURCE_WROTE");
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(registry.nextSeq).toBe(3);
    expect(registry.events).toHaveLength(2);
    expect(registry.events[0]?.instanceId).toBe("i1");
    expect(registry.events[0]?.kind).toBe("mail");
    expect(registry.events[0]?.schema).toBe("mail.event@v1");
    expect(registry.events[0]?.type).toBe("mail.received");
    expect(registry.events[0]?.payload["from"]).toBe("alice@example");
  });

  it("at 缺省 0,传入则生效", () => {
    const registry = makeRegistryWithInstance();
    const absent = writeEvent(registry, { instanceId: "i1", event: mailEvent() });
    const explicit = writeEvent(registry, { instanceId: "i1", event: mailEvent(), at: 1234 });
    expect(absent.record?.at).toBe(0);
    expect(explicit.record?.at).toBe(1234);
  });

  it("policy.deny 命中 event.type → SOURCE_INVALID(reason 含 policy)", () => {
    const registry = makeRegistryWithMail({ policy: { deny: ["mail.deleted"] } });
    addInstance(registry, "i1");
    const denied = writeEvent(registry, { instanceId: "i1", event: mailEvent({ type: "mail.deleted" }) });
    expect(denied.code).toBe("SOURCE_INVALID");
    expect(denied.reason).toContain("policy");
    expect(writeEvent(registry, { instanceId: "i1", event: mailEvent() }).code).toBe("SOURCE_WROTE");
  });

  it("policy.allow 非空且未命中 → SOURCE_INVALID;命中则放行", () => {
    const registry = makeRegistryWithMail({ policy: { allow: ["mail.received"] } });
    addInstance(registry, "i1");
    const missed = writeEvent(registry, { instanceId: "i1", event: mailEvent({ type: "mail.flagged" }) });
    expect(missed.code).toBe("SOURCE_INVALID");
    expect(missed.reason).toContain("policy");
    expect(writeEvent(registry, { instanceId: "i1", event: mailEvent() }).code).toBe("SOURCE_WROTE");
  });

  it("非法写入不推进 seq", () => {
    const registry = makeRegistryWithInstance();
    writeEvent(registry, { instanceId: "i1", event: { type: "mail.received", payload: {} } });
    expect(registry.nextSeq).toBe(1);
    expect(writeEvent(registry, { instanceId: "i1", event: mailEvent() }).seq).toBe(1);
  });
});

describe("F) replay", () => {
  it("fromSeq 缺省 0 → 返回全部事件", () => {
    const registry = makeRegistryWithInstance();
    writeEvent(registry, { instanceId: "i1", event: mailEvent() });
    writeEvent(registry, { instanceId: "i1", event: mailEvent({ type: "mail.flagged" }) });
    const result = replay(registry, {});
    expect(result.ok).toBe(true);
    expect(result.events.map((record) => record.seq)).toEqual([1, 2]);
  });

  it("fromSeq 只返回 seq 更大者", () => {
    const registry = makeRegistryWithInstance();
    writeEvent(registry, { instanceId: "i1", event: mailEvent() });
    writeEvent(registry, { instanceId: "i1", event: mailEvent({ type: "mail.flagged" }) });
    expect(replay(registry, { fromSeq: 1 }).events.map((record) => record.seq)).toEqual([2]);
    expect(replay(registry, { fromSeq: 2 }).events).toEqual([]);
  });

  it("给 instanceId 时只含该实例", () => {
    const registry = makeRegistryWithMail();
    addInstance(registry, "i1");
    addInstance(registry, "i2");
    writeEvent(registry, { instanceId: "i1", event: mailEvent() });
    writeEvent(registry, { instanceId: "i2", event: mailEvent({ type: "mail.flagged" }) });
    const result = replay(registry, { instanceId: "i2" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.instanceId).toBe("i2");
    expect(result.events[0]?.seq).toBe(2);
  });

  it("实例不存在 → ok:false SOURCE_INVALID 且 events 空", () => {
    const registry = makeRegistryWithInstance();
    writeEvent(registry, { instanceId: "i1", event: mailEvent() });
    const result = replay(registry, { instanceId: "ghost" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_INVALID");
    expect(result.events).toEqual([]);
  });

  it("重启可重放:JSON 往返后结果一致且 seq 续上", () => {
    const registry = makeRegistryWithInstance();
    writeEvent(registry, { instanceId: "i1", event: mailEvent() });
    writeEvent(registry, { instanceId: "i1", event: mailEvent({ type: "mail.flagged" }) });
    const revived = JSON.parse(JSON.stringify(registry)) as SourceRegistry;
    expect(replay(revived, {})).toEqual(replay(registry, {}));
    expect(replay(revived, { fromSeq: 1 }).events.map((record) => record.seq)).toEqual([2]);
    expect(writeEvent(revived, { instanceId: "i1", event: mailEvent() }).seq).toBe(3);
    expect(revived.events).toHaveLength(3);
  });

  it("ok 时码恒为 SOURCE_REPLAYED(含空结果)", () => {
    const registry = createRegistry();
    const result = replay(registry, {});
    expect(result.ok).toBe(true);
    expect(result.code).toBe("SOURCE_REPLAYED");
    expect(result.events).toEqual([]);
  });
});

describe("G) healthClaim", () => {
  it("未知实例 → SOURCE_INVALID", () => {
    const registry = makeRegistryWithMail();
    const result = healthClaim(registry, { instanceId: "ghost", key: "mail.health" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_INVALID");
    expect(registry.claims).toEqual({});
  });

  it("首次声明 → SOURCE_HEALTH_CLAIMED 并占位与追加史", () => {
    const registry = makeRegistryWithInstance();
    const result = healthClaim(registry, { instanceId: "i1", key: "mail.health" });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("SOURCE_HEALTH_CLAIMED");
    expect(result.claimId).toBeDefined();
    expect(registry.claims[result.claimId ?? ""]).toBe("i1");
    expect(registry.instances["i1"]?.health?.claimed).toContain(result.claimId);
  });

  it("同实例同 key 重复声明 → SOURCE_HEALTH_CLAIM_DUPLICATE", () => {
    const registry = makeRegistryWithInstance();
    healthClaim(registry, { instanceId: "i1", key: "mail.health" });
    const again = healthClaim(registry, { instanceId: "i1", key: "mail.health" });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("SOURCE_HEALTH_CLAIM_DUPLICATE");
    expect(registry.instances["i1"]?.health?.claimed).toHaveLength(1);
  });

  it("另一实例同 key → 也 SOURCE_HEALTH_CLAIM_DUPLICATE", () => {
    const registry = makeRegistryWithMail();
    addInstance(registry, "i1");
    addInstance(registry, "i2");
    healthClaim(registry, { instanceId: "i1", key: "mail.health" });
    const other = healthClaim(registry, { instanceId: "i2", key: "mail.health" });
    expect(other.ok).toBe(false);
    expect(other.code).toBe("SOURCE_HEALTH_CLAIM_DUPLICATE");
    expect(registry.instances["i2"]?.health).toBeUndefined();
  });

  it("key 空白 → SOURCE_INVALID", () => {
    const registry = makeRegistryWithInstance();
    expect(healthClaim(registry, { instanceId: "i1", key: "   " }).code).toBe("SOURCE_INVALID");
  });
});

describe("H) invalidateInstance", () => {
  it("未知 id → SOURCE_INVALID", () => {
    const registry = makeRegistryWithMail();
    const result = invalidateInstance(registry, "ghost");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SOURCE_INVALID");
  });

  it("成功 → SOURCE_DISABLED,之后写入被拒且 listEnabled 不含它", () => {
    const registry = makeRegistryWithInstance();
    const result = invalidateInstance(registry, "i1");
    expect(result.ok).toBe(true);
    expect(result.code).toBe("SOURCE_DISABLED");
    expect(registry.instances["i1"]?.enabled).toBe(false);
    expect(writeEvent(registry, { instanceId: "i1", event: mailEvent() }).code).toBe("SOURCE_DISABLED");
    expect(listEnabled(registry)).toEqual([]);
  });

  it("失效会归还 claim,别的实例随后可占用", () => {
    const registry = makeRegistryWithMail();
    addInstance(registry, "i1", { ...MAIL_CONFIG, claims: ["feed:inbox"] });
    expect(registry.claims["feed:inbox"]).toBe("i1");
    invalidateInstance(registry, "i1");
    expect(registry.claims["feed:inbox"]).toBeUndefined();
    expect(addInstance(registry, "i2", { ...MAIL_CONFIG, claims: ["feed:inbox"] }).code).toBe("SOURCE_ENABLED");
  });
});

describe("I) sourceScope 只读视图", () => {
  it("未注册 id → has:false、channel/thread undefined、facts {}", () => {
    const scope = sourceScope(makeRegistryWithMail());
    expect(scope.has("ghost")).toBe(false);
    expect(scope.enabled("ghost")).toBe(false);
    expect(scope.instance("ghost")).toBeUndefined();
    expect(scope.kind("ghost")).toBeUndefined();
    expect(scope.channel("ghost")).toBeUndefined();
    expect(scope.thread("ghost", mailEvent())).toBeUndefined();
    expect(scope.facts("ghost")).toEqual({});
    expect(scope.policy("ghost")).toBeUndefined();
    expect(scope.environment("ghost")).toBeUndefined();
  });

  it("channel 取 kind.channel.address", () => {
    const registry = makeRegistryWithInstance();
    expect(sourceScope(registry).channel("i1")).toBe("mail://INBOX");
  });

  it("thread 优先取 payload 的 threadContext.field", () => {
    const registry = makeRegistryWithMail({ find: () => "from-find" });
    addInstance(registry, "i1");
    const scope = sourceScope(registry);
    expect(scope.thread("i1", mailEvent())).toBe("th-1");
    expect(scope.thread("i1", mailEvent({ payload: { from: "alice@example" } }))).toBe("from-find");
  });

  it("无 threadContext 时回退 kind.find", () => {
    const registry = makeRegistryWithMail({
      threadContext: undefined,
      find: (event: SourceEvent) => {
        const value = event.payload?.["thread"];
        return typeof value === "string" ? value : undefined;
      },
    });
    addInstance(registry, "i1");
    const scope = sourceScope(registry);
    expect(scope.thread("i1", mailEvent({ payload: { from: "a@b", thread: "th-9" } }))).toBe("th-9");
    expect(scope.find("i1", mailEvent({ payload: { from: "a@b", thread: "th-9" } }))).toBe("th-9");
  });

  it("enabled 反映实例启用状态", () => {
    const registry = makeRegistryWithMail();
    addInstance(registry, "i1");
    addInstance(registry, "i2", MAIL_CONFIG, false);
    const scope = sourceScope(registry);
    expect(scope.has("i2")).toBe(true);
    expect(scope.enabled("i1")).toBe(true);
    expect(scope.enabled("i2")).toBe(false);
  });

  it("policy / environment 透传", () => {
    const registry = makeRegistryWithMail({
      policy: { allow: ["mail.received"], deny: ["mail.deleted"] },
      environment: { MAIL_HOST: "imap.example" },
    });
    addInstance(registry, "i1");
    const scope = sourceScope(registry);
    expect(scope.policy("i1")).toEqual({ allow: ["mail.received"], deny: ["mail.deleted"] });
    expect(scope.environment("i1")).toEqual({ MAIL_HOST: "imap.example" });
  });

  it("facts 透传且 instances() 返回全部实例", () => {
    const registry = makeRegistryWithMail();
    addInstance(registry, "i1");
    addInstance(registry, "i2", MAIL_CONFIG, false);
    const scope = sourceScope(registry);
    expect(scope.facts("i1")).toEqual({
      readPosition: "imap:INBOX",
      botIdentity: "mail-bot@example",
    });
    expect(scope.instances().map((instance) => instance.id)).toEqual(["i1", "i2"]);
  });
});

describe("J) createSourceContext", () => {
  it("write 与 writeEvent 同语义", () => {
    const registry = makeRegistryWithInstance();
    const context = createSourceContext(registry);
    const result = context.write({ instanceId: "i1", event: mailEvent() });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("SOURCE_WROTE");
    expect(result.seq).toBe(1);
    expect(registry.events).toHaveLength(1);
    expect(context.write({ instanceId: "i1", event: { type: "mail.received", payload: {} } }).code).toBe(
      "SOURCE_INVALID",
    );
  });

  it("scope() 与 sourceScope 等价", () => {
    const registry = makeRegistryWithInstance();
    const context = createSourceContext(registry);
    expect(context.scope().channel("i1")).toBe("mail://INBOX");
    expect(context.scope().thread("i1", mailEvent())).toBe("th-1");
    expect(context.scope().has("ghost")).toBe(false);
  });

  it("listEnabled() 等价", () => {
    const registry = makeRegistryWithMail();
    addInstance(registry, "i1");
    addInstance(registry, "i2", MAIL_CONFIG, false);
    const context = createSourceContext(registry);
    expect(context.listEnabled().map((instance) => instance.id)).toEqual(["i1"]);
  });

  it("replay 等价", () => {
    const registry = makeRegistryWithInstance();
    const context = createSourceContext(registry);
    context.write({ instanceId: "i1", event: mailEvent() });
    expect(context.replay({})).toEqual(replay(registry, {}));
    expect(context.replay({ instanceId: "ghost" }).code).toBe("SOURCE_INVALID");
  });

  it("healthClaim 等价", () => {
    const registry = makeRegistryWithInstance();
    const context = createSourceContext(registry);
    expect(context.healthClaim({ instanceId: "i1", key: "mail.health" }).code).toBe("SOURCE_HEALTH_CLAIMED");
    expect(context.healthClaim({ instanceId: "i1", key: "mail.health" }).code).toBe("SOURCE_HEALTH_CLAIM_DUPLICATE");
  });
});
