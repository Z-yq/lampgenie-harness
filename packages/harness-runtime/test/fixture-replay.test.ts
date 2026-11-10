/**
 * 测试夹具录制/回放(#110)纯逻辑:严格顺序匹配 / 顺序录制 / 关闭完整性 / 密钥扫描 /
 * 模式决议 / 指纹 / 磁盘快照归一化。全部固定数据,不碰文件、不读时钟。
 */
import { describe, expect, it } from "vitest";
import {
  FIXTURE_CODES,
  FIXTURE_REQUIRED_CODES,
  FIXTURE_VERSION,
  bodyHashOf,
  closeScope,
  createScope,
  credentialEnvValues,
  matchNext,
  modeOf,
  nextExpected,
  normalizeScope,
  recordEntry,
  scanForSecrets,
  summarizeScope,
} from "../src/agent/fixture-replay.ts";
import type { ExpectedRequest, FixtureScope } from "../src/agent/fixture-replay.ts";

const T0 = 1_700_000_000_000;

function req(id: string, url = `https://api.example.test/${id}`, method = "POST", bodyHash?: string): ExpectedRequest {
  return { id, method, url, ...(bodyHash !== undefined ? { bodyHash } : {}) };
}

function scopeOf(...expected: ExpectedRequest[]): FixtureScope {
  return createScope("demo", expected).scope;
}

describe("稳定码与契约版本", () => {
  it("九个必需码全在码表里", () => {
    expect(FIXTURE_REQUIRED_CODES).toHaveLength(9);
    for (const code of FIXTURE_REQUIRED_CODES) expect(FIXTURE_CODES).toContain(code);
  });

  it("契约版本是 1", () => {
    expect(FIXTURE_VERSION).toBe(1);
  });
});

describe("createScope", () => {
  it("合法输入 → FIXTURE_OPENED,cursor=0 且 open", () => {
    const created = createScope("demo", [req("a"), req("b")]);
    expect(created.code).toBe("FIXTURE_OPENED");
    expect(created.errors).toEqual([]);
    expect(created.scope.cursor).toBe(0);
    expect(created.scope.status).toBe("open");
    expect(created.scope.expected).toHaveLength(2);
  });

  it("深拷贝:改入参不影响 scope", () => {
    const expected = [req("a")];
    const created = createScope("demo", expected);
    expected[0]!.url = "https://mutated.test";
    expect(created.scope.expected[0]!.url).toBe("https://api.example.test/a");
  });

  it("name 空 → FIXTURE_INVALID", () => {
    const created = createScope("  ", [req("a")]);
    expect(created.code).toBe("FIXTURE_INVALID");
    expect(created.errors.join()).toContain("name");
  });

  it("expected 非数组 → FIXTURE_INVALID", () => {
    expect(createScope("demo", "nope").code).toBe("FIXTURE_INVALID");
  });

  it("expected 缺 method → FIXTURE_INVALID", () => {
    const created = createScope("demo", [{ id: "a", url: "https://x.test" }]);
    expect(created.code).toBe("FIXTURE_INVALID");
    expect(created.errors.join()).toContain("expected[0]");
  });

  it("expected id 重复 → FIXTURE_INVALID", () => {
    const created = createScope("demo", [req("dup"), req("dup")]);
    expect(created.code).toBe("FIXTURE_INVALID");
    expect(created.errors.join()).toContain("重复");
  });
});

describe("matchNext 严格顺序", () => {
  it("method 大小写归一 + url 相同 → MATCHED", () => {
    const scope = scopeOf(req("a", "https://x.test/a", "post"));
    const matched = matchNext(scope, { id: "a", method: "POST", url: "https://x.test/a" });
    expect(matched.code).toBe("FIXTURE_MATCHED");
    expect(matched.index).toBe(0);
    expect(matched.expected?.id).toBe("a");
  });

  it("url 不同 → MISMATCH,reason 指向 url", () => {
    const scope = scopeOf(req("a"));
    const matched = matchNext(scope, req("a", "https://api.example.test/other"));
    expect(matched.code).toBe("FIXTURE_MISMATCH");
    expect(matched.reason).toContain("url");
  });

  it("method 不同 → MISMATCH", () => {
    const scope = scopeOf(req("a", undefined, "POST"));
    expect(matchNext(scope, req("a", undefined, "GET")).code).toBe("FIXTURE_MISMATCH");
  });

  it("bodyHash 不同 → MISMATCH", () => {
    const scope = scopeOf(req("a", undefined, "POST", "fnv1a64:aaaa"));
    expect(matchNext(scope, req("a", undefined, "POST", "fnv1a64:bbbb")).code).toBe("FIXTURE_MISMATCH");
  });

  it("expected 声明了 bodyHash 而请求没带 → MISMATCH", () => {
    const scope = scopeOf(req("a", undefined, "POST", "fnv1a64:aaaa"));
    expect(matchNext(scope, req("a", undefined, "POST")).code).toBe("FIXTURE_MISMATCH");
  });

  it("expected 未声明 bodyHash → 忽略请求里的 bodyHash", () => {
    const scope = scopeOf(req("a"));
    expect(matchNext(scope, req("a", undefined, "POST", "fnv1a64:zzz")).code).toBe("FIXTURE_MATCHED");
  });

  it("第二条请求先到 → MISMATCH(不跳序到 index 1)", () => {
    const scope = scopeOf(req("a"), req("b"));
    const matched = matchNext(scope, req("b"));
    expect(matched.code).toBe("FIXTURE_MISMATCH");
    expect(matched.index).toBe(0);
    expect(matched.expected?.id).toBe("a");
  });

  it("expected 已消费完再发请求 → MISMATCH(expected-exhausted)", () => {
    const scope = scopeOf(req("a"));
    scope.cursor = 1;
    const matched = matchNext(scope, req("a"));
    expect(matched.code).toBe("FIXTURE_MISMATCH");
    expect(matched.reason).toBe("expected-exhausted");
  });

  it("closed scope 仍可匹配(关闭的夹具正是 CI 回放对象)", () => {
    const scope = scopeOf(req("a"));
    scope.status = "closed";
    expect(matchNext(scope, req("a")).code).toBe("FIXTURE_MATCHED");
  });

  it("请求缺 url → INVALID", () => {
    const scope = scopeOf(req("a"));
    const matched = matchNext(scope, { id: "a", method: "POST", url: "" });
    expect(matched.code).toBe("FIXTURE_INVALID");
  });

  it("纯函数:matchNext 不推进 cursor,返回的 expected 是拷贝", () => {
    const scope = scopeOf(req("a"));
    const matched = matchNext(scope, req("a"));
    expect(scope.cursor).toBe(0);
    (matched.expected as ExpectedRequest).url = "https://mutated.test";
    expect(scope.expected[0]!.url).toBe("https://api.example.test/a");
  });

  it("nextExpected 跟着 cursor 走", () => {
    const scope = scopeOf(req("a"), req("b"));
    expect(nextExpected(scope)?.id).toBe("a");
    scope.cursor = 1;
    expect(nextExpected(scope)?.id).toBe("b");
    scope.cursor = 2;
    expect(nextExpected(scope)).toBeUndefined();
  });
});

describe("recordEntry 顺序录制", () => {
  it("第一条按顺序录 → FIXTURE_RECORDED,cursor/entries 推进", () => {
    const scope = scopeOf(req("a"), req("b"));
    const result = recordEntry(scope, { request: req("a"), response: { ok: 1 }, at: T0 });
    expect(result.code).toBe("FIXTURE_RECORDED");
    expect(result.scope.cursor).toBe(1);
    expect(result.scope.entries).toHaveLength(1);
    expect(result.scope.entries[0]!.response).toEqual({ ok: 1 });
    expect(result.scope.entries[0]!.at).toBe(T0);
  });

  it("at 非法(非有限数)→ 记 0,不读时钟", () => {
    const scope = scopeOf(req("a"));
    const result = recordEntry(scope, { request: req("a"), response: "x", at: Number.NaN });
    expect(result.code).toBe("FIXTURE_RECORDED");
    expect(result.scope.entries[0]!.at).toBe(0);
  });

  it("乱序录制 → FIXTURE_MISMATCH,原 scope 不变", () => {
    const scope = scopeOf(req("a"), req("b"));
    const result = recordEntry(scope, { request: req("b"), response: "x", at: T0 });
    expect(result.code).toBe("FIXTURE_MISMATCH");
    expect(scope.entries).toHaveLength(0);
    expect(result.scope.entries).toHaveLength(0);
  });

  it("response 是 undefined → FIXTURE_INVALID(落盘会丢字段)", () => {
    const scope = scopeOf(req("a"));
    const result = recordEntry(scope, { request: req("a"), response: undefined });
    expect(result.code).toBe("FIXTURE_INVALID");
    expect(result.scope.cursor).toBe(0);
  });

  it("已关闭 scope 再录 → FIXTURE_CLOSED", () => {
    const scope = scopeOf(req("a"));
    scope.status = "closed";
    expect(recordEntry(scope, { request: req("a"), response: 1 }).code).toBe("FIXTURE_CLOSED");
  });

  it("纯函数:入参 scope 不被修改", () => {
    const scope = scopeOf(req("a"));
    recordEntry(scope, { request: req("a"), response: 1, at: T0 });
    expect(scope.cursor).toBe(0);
    expect(scope.entries).toHaveLength(0);
  });

  it("连录两条 → cursor=2,顺序固定", () => {
    const first = recordEntry(scopeOf(req("a"), req("b")), { request: req("a"), response: "A" });
    const second = recordEntry(first.scope, { request: req("b"), response: "B" });
    expect(second.code).toBe("FIXTURE_RECORDED");
    expect(second.scope.entries.map((e) => e.response)).toEqual(["A", "B"]);
    expect(second.scope.cursor).toBe(2);
  });
});

describe("closeScope 完整性", () => {
  it("少发一条 → FIXTURE_INCOMPLETE,missing 指出缺几条,状态仍是 open", () => {
    const scope = scopeOf(req("a"), req("b"));
    const result = closeScope(scope);
    expect(result.code).toBe("FIXTURE_INCOMPLETE");
    expect(result.used).toBe(0);
    expect(result.total).toBe(2);
    expect(result.missing).toBe(2);
    expect(result.scope.status).toBe("open");
  });

  it("used==total → FIXTURE_CLOSED", () => {
    const scope = scopeOf(req("a"));
    const recorded = recordEntry(scope, { request: req("a"), response: 1 }).scope;
    const result = closeScope(recorded);
    expect(result.code).toBe("FIXTURE_CLOSED");
    expect(result.scope.status).toBe("closed");
    expect(result.missing).toBe(0);
  });

  it("重复关闭 → FIXTURE_INCOMPLETE(already-closed)", () => {
    const scope = scopeOf(req("a"));
    const recorded = recordEntry(scope, { request: req("a"), response: 1 }).scope;
    const closed = closeScope(recorded).scope;
    const again = closeScope(closed);
    expect(again.code).toBe("FIXTURE_INCOMPLETE");
    expect(again.reason).toBe("already-closed");
  });
});

describe("scanForSecrets", () => {
  it("sk- token → SECRET_DETECTED,预览打码不回显全文", () => {
    const token = "sk-live-abcdef1234567890";
    const scan = scanForSecrets(`{"key":"${token}"}`);
    expect(scan.code).toBe("FIXTURE_SECRET_DETECTED");
    expect(scan.hits[0]!.kind).toBe("sk-token");
    expect(scan.hits[0]!.preview.startsWith("sk-l")).toBe(true);
    expect(scan.hits[0]!.preview).not.toContain("abcdef1234567890");
  });

  it("Bearer 头 → SECRET_DETECTED", () => {
    const scan = scanForSecrets("authorization: Bearer abc12345XYZ");
    expect(scan.code).toBe("FIXTURE_SECRET_DETECTED");
    expect(scan.hits.some((h) => h.kind === "bearer")).toBe(true);
  });

  it("长高熵串 → SECRET_DETECTED", () => {
    const scan = scanForSecrets("token=Ab3Kd9Pq2Rs7Tu4Vw8Xy5Za1Bc6De0Fg");
    expect(scan.code).toBe("FIXTURE_SECRET_DETECTED");
    expect(scan.hits.some((h) => h.kind === "high-entropy")).toBe(true);
  });

  it("credential-like env 值字面量 → SECRET_DETECTED", () => {
    const scan = scanForSecrets("body says super-secret-value-42", { envValues: ["super-secret-value-42"] });
    expect(scan.code).toBe("FIXTURE_SECRET_DETECTED");
    expect(scan.hits.some((h) => h.kind === "env-value")).toBe(true);
  });

  it("短 env 值(<8)不参与扫描", () => {
    expect(scanForSecrets("value=abc", { envValues: ["abc"] }).code).toBe("FIXTURE_CLEAN");
  });

  it("普通文本与 23 位指纹 → FIXTURE_CLEAN", () => {
    expect(scanForSecrets('{"ok":true,"items":[1,2,3],"hash":"fnv1a64:0123456789abcdef"}').code).toBe("FIXTURE_CLEAN");
  });

  it("text 不是字符串 → FIXTURE_INVALID", () => {
    expect(scanForSecrets(null).code).toBe("FIXTURE_INVALID");
  });

  it("命中条数有上限且按位置排序", () => {
    const text = Array.from({ length: 30 }, (_, i) => `sk-secret-${String(i).padStart(6, "0")}`).join(" ");
    const scan = scanForSecrets(text);
    expect(scan.hits.length).toBeLessThanOrEqual(20);
    const positions = scan.hits.map((h) => h.at);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("credentialEnvValues", () => {
  it("只挑 credential-like 名且值长度 ≥8", () => {
    const values = credentialEnvValues({
      OPENAI_API_KEY: "sk-abcdefghij",
      GITHUB_TOKEN: "ghp_abcdefghij",
      DB_PASSWORD: "supersecret",
      CI: "true",
      PATH: "/usr/local/bin:/usr/bin",
      SHORT_SECRET: "short",
    });
    expect(values).toContain("sk-abcdefghij");
    expect(values).toContain("ghp_abcdefghij");
    expect(values).toContain("supersecret");
    expect(values).not.toContain("true");
    expect(values).not.toContain("short");
    expect(values).toHaveLength(3);
  });

  it("env 缺失 → 空数组", () => {
    expect(credentialEnvValues(undefined)).toEqual([]);
  });
});

describe("modeOf 模式决议", () => {
  it("显式 passthrough 优先级最高", () => {
    const res = modeOf({ fixtureExists: true, passthrough: true, envMode: "ci" });
    expect(res.mode).toBe("passthrough");
    expect(res.code).toBe("FIXTURE_PASSTHROUGH");
  });

  it("夹具存在 → replay", () => {
    const res = modeOf({ fixtureExists: true, envMode: "ci" });
    expect(res.mode).toBe("replay");
    expect(res.code).toBe("FIXTURE_REPLAY_READY");
    expect(res.missing).toBe(false);
  });

  it("CI 缺夹具 → 仍是 replay 且 missing(不回退 record)", () => {
    const res = modeOf({ fixtureExists: false, envMode: "ci" });
    expect(res.mode).toBe("replay");
    expect(res.missing).toBe(true);
    expect(res.code).toBe("FIXTURE_REPLAY_MISSING");
  });

  it("envMode 为 true/1 的 CI 口径同样生效", () => {
    expect(modeOf({ fixtureExists: false, envMode: "true" }).missing).toBe(true);
    expect(modeOf({ fixtureExists: false, envMode: "1" }).missing).toBe(true);
  });

  it("本地缺夹具 → record", () => {
    const res = modeOf({ fixtureExists: false });
    expect(res.mode).toBe("record");
    expect(res.code).toBe("FIXTURE_RECORD_READY");
  });

  it("非 CI 的 envMode=false 仍是 record", () => {
    expect(modeOf({ fixtureExists: false, envMode: "false" }).mode).toBe("record");
  });
});

describe("bodyHashOf 指纹", () => {
  it("键序无关", () => {
    expect(bodyHashOf({ a: 1, b: [2, 3] })).toBe(bodyHashOf({ b: [2, 3], a: 1 }));
  });

  it("内容不同 → 指纹不同", () => {
    expect(bodyHashOf({ a: 1 })).not.toBe(bodyHashOf({ a: 2 }));
  });

  it("输出 fnv1a64: + 16 位十六进制", () => {
    expect(bodyHashOf({ x: "y" })).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("标量与 null 也能算", () => {
    expect(bodyHashOf(null)).toMatch(/^fnv1a64:/);
    expect(bodyHashOf("text")).toMatch(/^fnv1a64:/);
  });
});

describe("normalizeScope 磁盘快照归一化", () => {
  const good = {
    v: 1,
    name: "demo",
    expected: [req("a"), req("b")],
    entries: [{ request: req("a"), response: { ok: 1 }, at: T0 }],
    cursor: 1,
    status: "open",
  };

  it("合法快照 → MATCHED,entries/cursor 还原", () => {
    const res = normalizeScope(good);
    expect(res.code).toBe("FIXTURE_MATCHED");
    expect(res.scope?.entries).toHaveLength(1);
    expect(res.scope?.cursor).toBe(1);
  });

  it("entries 与 expected 顺序冲突 → INVALID", () => {
    const res = normalizeScope({ ...good, entries: [{ request: req("b"), response: 1, at: T0 }], cursor: 1 });
    expect(res.code).toBe("FIXTURE_INVALID");
    expect(res.errors.join()).toContain("不一致");
  });

  it("entries 超出 expected 长度 → INVALID", () => {
    const res = normalizeScope({ ...good, entries: [good.entries[0], { request: req("b"), response: 2, at: T0 }, { request: req("c"), response: 3, at: T0 }], cursor: 3 });
    expect(res.code).toBe("FIXTURE_INVALID");
    expect(res.errors.join()).toContain("超出");
  });

  it("cursor 越界 → 钳到上限(不越过 expected)", () => {
    const res = normalizeScope({ ...good, cursor: 99 });
    expect(res.code).toBe("FIXTURE_MATCHED");
    expect(res.scope?.cursor).toBe(2);
  });

  it("cursor 可小于 entries 数(回放从头开始),不被 entries 数顶高", () => {
    const res = normalizeScope({ ...good, cursor: 0 });
    expect(res.code).toBe("FIXTURE_MATCHED");
    expect(res.scope?.cursor).toBe(0);
  });

  it("v 不是 1 → INVALID", () => {
    expect(normalizeScope({ ...good, v: 2 }).code).toBe("FIXTURE_INVALID");
  });

  it("status=closed 保留,非法 status → INVALID", () => {
    expect(normalizeScope({ ...good, status: "closed" }).scope?.status).toBe("closed");
    expect(normalizeScope({ ...good, status: "paused" }).code).toBe("FIXTURE_INVALID");
  });

  it("非对象 → INVALID", () => {
    expect(normalizeScope(null).code).toBe("FIXTURE_INVALID");
  });
});

describe("summarizeScope", () => {
  it("未消费完 → remaining 与 complete=false", () => {
    const summary = summarizeScope(scopeOf(req("a"), req("b")));
    expect(summary).toMatchObject({ used: 0, total: 2, remaining: 2, status: "open", complete: false });
  });

  it("录制并关闭 → complete=true", () => {
    const recorded = recordEntry(scopeOf(req("a")), { request: req("a"), response: 1 }).scope;
    const closed = closeScope(recorded).scope;
    expect(summarizeScope(closed)).toMatchObject({ used: 1, total: 1, remaining: 0, status: "closed", complete: true });
  });
});
