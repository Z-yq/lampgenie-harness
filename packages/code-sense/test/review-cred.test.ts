import { describe, it, expect } from "vitest";
import { deterministicFindings, credentialHit, type ReviewTarget } from "../src/review/index";

/** 断言 fixture 全部用运行时拼接构造(源码不落任何「看起来像真凭证」的字面量,
 * 防本仓自己的 review 把测试文件报成凭证入库——review-policy.test.ts 同一纪律)。 */
function onew(): string {
  return "-";
}

/** 每形态正例:尾部由 [A-Za-z0-9] 伪随机拼成,不含任何真实 key 前缀内容。 */
const TAIL = "abcdefgh1234567890KLMNOPQ";
const POSITIVE: { name: string; text: string; expectForm: string }[] = [
  // 实测 MISS 的三个样例(2026-10-20 缺陷现场)
  { name: "sk-proj-*(实测 MISS 样例)", text: "sk" + onew() + "proj" + onew() + TAIL, expectForm: "sk-" },
  { name: "sk-live-*(实测 MISS 样例)", text: "sk" + onew() + "live" + onew() + TAIL, expectForm: "sk-" },
  { name: "sk-ant-api03-*(Anthropic)", text: "sk" + onew() + "ant" + onew() + "api03" + onew() + TAIL, expectForm: "sk-" },
  // 原已覆盖形态(旧 sk- 无连字符),回归保护
  { name: "sk-无连字符(旧 OpenAI)", text: "sk" + onew() + "abcdefghijklmnop1234", expectForm: "sk-" },
  { name: "ak-(dashscope)", text: "ak" + onew() + TAIL, expectForm: "ak-" },
  { name: "AKID(腾讯云)", text: "AKID" + "Zx" + TAIL, expectForm: "AKID" },
  { name: "xoxb-(slack bot)", text: "xoxb" + onew() + "1234567890" + onew() + "abcdefABCDEF", expectForm: "xox" },
  { name: "xoxp-(slack user)", text: "xoxp" + onew() + "9876543210" + onew() + "abcdefABCDEF", expectForm: "xox" },
  { name: "AIza(google)", text: "AIza" + "Sy" + "0123456789abcdefghijABCDEFGHIJ012 3".replace(" ", "_").padEnd(35, "x").slice(0, 35), expectForm: "AIza" },
  { name: "PEM 私钥", text: "-----BEGIN RSA PRIVATE KEY-----", expectForm: "PEM" },
  { name: "JWT", text: "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0In0" + "." + "sig", expectForm: "JWT" },
  { name: "ghp_", text: "ghp" + "_" + "abcdefghij0123456789ABCDEFGHIJ", expectForm: "ghp_" },
];

/** 反例:长 base62/hash/uuid 等真实误报风险样品,必须一个都不命中。 */
const NEGATIVE: { name: string; text: string }[] = [
  { name: "40 位 git SHA", text: "3f786850e387550fdab836ed7e6dc881de23001b" },
  { name: "64 位 sha256", text: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" },
  { name: "uuid v4", text: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
  { name: "普通 sk-learn 词串", text: "sk" + onew() + "learn" + onew() + "tutorial" + onew() + "slides" + onew() + "2024" },
  { name: "sk-开头但尾段不足 16", text: "sk" + onew() + "short" },
  { name: "ak-开头但尾段不足 20", text: "ak" + onew() + "abc123" },
  { name: "AKID 后接短词", text: "AKID12345" },
  { name: "xox 前缀但非 token 形态", text: "xox" + onew() + "abc" },
  { name: "AIza 后不足 35 位", text: "AIza" + "short" },
  { name: "base62 长串(无前缀)", text: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" },
  { name: "包名 sk-image", text: "import sk" + onew() + "image" + onew() + "toolkit" },
];

function target(diffText: string): ReviewTarget {
  return {
    kind: "uncommitted",
    files: [{ path: "config.ts", status: "added", diffText: `+const x = "${diffText}";` }],
    totalLines: 3,
    truncated: false,
  };
}

describe("凭证形态检测(A:CRED_PATTERNS 正反例)", () => {
  for (const c of POSITIVE) {
    it(`正例命中:${c.name}`, () => {
      const form = credentialHit(c.text);
      expect(form, `应命中但未命中: ${c.name}`).not.toBeNull();
      expect(form!).toContain(c.expectForm);
      // 端到端:deterministicFindings 必须报 blocker
      const det = deterministicFindings(target(c.text));
      const cred = det.find((d) => d.title.includes("凭证"));
      expect(cred, `应报凭证 blocker: ${c.name}`).toBeDefined();
      expect(cred!.severity).toBe("blocker");
    });
  }

  for (const c of NEGATIVE) {
    it(`反例不命中:${c.name}`, () => {
      expect(credentialHit(c.text), `误报: ${c.name} = ${c.text}`).toBeNull();
      const det = deterministicFindings(target(c.text));
      expect(det.find((d) => d.title.includes("凭证"))).toBeUndefined();
    });
  }

  it("detail 带命中的形态名(可区分哪种凭证)", () => {
    const det = deterministicFindings(target("sk" + onew() + "proj" + onew() + TAIL));
    expect(det[0]!.detail).toContain("sk-");
  });
});
