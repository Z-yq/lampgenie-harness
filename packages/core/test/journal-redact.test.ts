/**
 * 凭证脱敏(journal 脱敏 P1-B)。
 * 为什么这样测:脱敏是本仓唯一的「明文出厂闸门」——漏一个形态,会话导出/轨迹文件就把
 * 用户的 key 带出去;多改一点(把 arguments 变成对象、动 idempotencyKey)就会打断
 * trace-query 的 string 截断契约与 journal 重放去重。三条不变量必须钉死:
 * ①各凭证形态都命中;②幂等(导出/重放会重复过一遍,不能层层打标);
 * ③`arguments` 脱敏后**仍是 string**,`idempotencyKey` 原值不变,普通入参不误报。
 */
import { describe, expect, it, afterEach } from "vitest";
import { redactEventPayload, redactText } from "../src/journal/redact.js";

const PLAIN_ARGS = JSON.stringify({ path: "src/a.ts", limit: 20 });

describe("redactText:凭证形态命中", () => {
  it("sk- 系(OpenAI/Anthropic 风格)", () => {
    const out = redactText("Authorization: sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).toContain("<redacted:sk>");
  });

  it("Bearer <token> 保留可读前缀,只替换密文段", () => {
    const out = redactText('curl -H "Authorization: Bearer abcdefgh12345678ijklmnop"');
    expect(out).toContain("Bearer <redacted:bearer>");
    expect(out).not.toContain("abcdefgh12345678");
  });

  it("apiKey= 赋值形态保留键名", () => {
    const out = redactText("apiKey=abcd1234efgh5678ijkl");
    expect(out).toBe("apiKey=<redacted:assign>");
  });

  it("ghp_ 系 GitHub PAT", () => {
    const out = redactText("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 粘贴");
    expect(out).not.toContain("ghp_abcdefghijklmnop");
    expect(out).toContain("<redacted:github>");
  });

  it("AKIA AWS Access Key ID", () => {
    const out = redactText("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("<redacted:aws>");
  });

  it("普通文本不误伤", () => {
    expect(redactText(PLAIN_ARGS)).toBe(PLAIN_ARGS);
    expect(redactText("sk-short")).toBe("sk-short"); // < 16 位不命中
  });
});

describe("redactText:幂等", () => {
  it("同一输入两次输出相等(占位符不命中任何规则)", () => {
    const inputs = [
      "Authorization: sk-abcdefghijklmnopqrstuvwxyz012345",
      "Bearer abcdefgh12345678ijklmnop",
      "password=supersecret123",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ];
    for (const s of inputs) {
      const once = redactText(s);
      const twice = redactText(once);
      expect(twice, s).toBe(once);
    }
  });
});

describe("redactEventPayload", () => {
  afterEach(() => { delete process.env.GENIE_JOURNAL_REDACT; });

  it("arguments 命中 → 值替换 + argumentsRedacted,且**类型仍是 string**", () => {
    const r = redactEventPayload({
      toolCallId: "c1",
      name: "bash",
      arguments: '{"cmd":"curl -H \\"Authorization: Bearer abcdefgh12345678ijkl\\""}',
    });
    expect(r.redacted).toBe(true);
    const p = r.payload as Record<string, unknown>;
    expect(typeof p.arguments).toBe("string"); // trace-query 的 TRUNCATABLE_KEYS 只做 string 截断
    expect(String(p.arguments)).toContain("<redacted:bearer>");
    expect(p.argumentsRedacted).toBe(true);
  });

  it("普通 arguments 原样且 redacted===false(不无谓造对象)", () => {
    const src = { toolCallId: "c1", name: "read_file", arguments: PLAIN_ARGS };
    const r = redactEventPayload(src);
    expect(r.redacted).toBe(false);
    expect(r.payload).toBe(src);
  });

  it("idempotencyKey 原值不变(重放去重依据)", () => {
    const r = redactEventPayload({ idempotencyKey: "sk-abcdefghijklmnopqrstuvwxyz012345", text: "hi" });
    const p = r.payload as Record<string, unknown>;
    expect(p.idempotencyKey).toBe("sk-abcdefghijklmnopqrstuvwxyz012345");
  });

  it("content 命中 → contentRedacted;二次处理不再打标(幂等)", () => {
    const first = redactEventPayload({ name: "bash", content: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(first.redacted).toBe(true);
    const second = redactEventPayload(first.payload);
    expect(second.redacted).toBe(false); // 已脱敏文本不再命中
    expect(second.payload).toEqual(first.payload);
  });

  it("GENIE_JOURNAL_REDACT=0 → 全关,原样返回", () => {
    process.env.GENIE_JOURNAL_REDACT = "0";
    const src = { arguments: "Authorization: sk-abcdefghijklmnopqrstuvwxyz012345" };
    const r = redactEventPayload(src);
    expect(r.redacted).toBe(false);
    expect(r.payload).toBe(src);
  });
});
