/**
 * 单元面:presence 状态机(DoD D6)+yaml-lite+邀请码+签名挑战。
 */
import { describe, expect, it } from "vitest";
import { derivePresence, PRESENCE_AWAY_MS } from "../src/team/presence.js";
import { parseYamlLite, stringifyYamlLite, roundtripOk } from "../src/team/yaml-lite.js";
import { InviteStore } from "../src/team/invite-store.js";
import { newDeviceKey, signChallenge, verifyChallenge } from "../src/team/relay-auth.js";
import { fingerprintOf } from "../src/identity/identity.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = 1_700_000_000_000;
const facts = (over: Partial<Parameters<typeof derivePresence>[0]>) => ({
  lastInputAt: NOW, runningSessions: 0, pendingAsks: 0, dnd: false, ...over,
});

describe("presence 状态机( §2,DoD D6)", () => {
  it("基态=online(连接活着+近期有输入)", () => {
    expect(derivePresence(facts({}), NOW)).toBe("online");
  });

  it("dnd 手动置位优先于一切自动态(规则①)", () => {
    expect(derivePresence(facts({ dnd: true, runningSessions: 3, pendingAsks: 2 }), NOW)).toBe("dnd");
  });

  it("coding 优先于 reviewing(规则②:agent 在跑但人没在看审批)", () => {
    expect(derivePresence(facts({ runningSessions: 1, pendingAsks: 2 }), NOW)).toBe("coding");
  });

  it("reviewing=无 running 但有未决审批", () => {
    expect(derivePresence(facts({ pendingAsks: 1 }), NOW)).toBe("reviewing");
  });

  it("away=>15min 无输入(规则③只用事实计数,不用模型)", () => {
    expect(derivePresence(facts({ lastInputAt: NOW - PRESENCE_AWAY_MS - 1 }), NOW)).toBe("away");
    expect(derivePresence(facts({ lastInputAt: NOW - PRESENCE_AWAY_MS + 1000 }), NOW)).toBe("online");
  });

  it("offline 不在本函数职责(连接层判定)——断言签名不含 offline 分支的输入", () => {
    // offline 由 WS 断开判定;状态机对一切 facts 组合不产 offline。
    expect(derivePresence(facts({ lastInputAt: 0 }), NOW)).not.toBe("offline");
  });
});

describe("yaml-lite(roster 受控子集)", () => {
  it("成员文件 roundtrip:写出必能读回", () => {
    const member = {
      username: "alice", displayName: "Alice", fingerprint: "aaaa-bbbb",
      keys: ["aaaa-bbbb", "cccc-dddd"], role: "member", projects: [],
      invitedBy: "owner1", registeredAt: "2026-10-11T00:00:00Z", revoked: false,
    };
    expect(roundtripOk(member)).toBe(true);
    const parsed = parseYamlLite(stringifyYamlLite(member));
    expect(parsed.role).toBe("member");
    expect(parsed.keys).toEqual(["aaaa-bbbb", "cccc-dddd"]);
    expect(parsed.revoked).toBe(false);
  });

  it("projects 扁平键 roundtrip", () => {
    const projects = { "proj-x.type": "team", "proj-x.owner": "alice", "proj-y.type": "personal" };
    expect(roundtripOk(projects)).toBe(true);
  });

  it("越界形态显式报错(不静默错读)", () => {
    expect(() => parseYamlLite("a:\n  b: 1\n")).toThrow(/不受支持/);
    expect(() => parseYamlLite("  - 孤儿列表项\n")).toThrow();
  });
});

describe("邀请码存储", () => {
  const dir = mkdtempSync(join(tmpdir(), "invite-"));
  const file = join(dir, "invites.jsonl");

  it("过期/超次/不存在各返明确原因;兑换登记持久化", () => {
    const store = new InviteStore(file);
    store.issue("GOOD", "owner1", Date.now() + 60_000);
    store.issue("EXPIRED", "owner1", Date.now() - 1);
    expect(store.redeem("NOPE", "a").ok).toBe(false);
    expect(store.redeem("EXPIRED", "a")).toMatchObject({ ok: false, reason: "邀请码已过期" });
    expect(store.redeem("GOOD", "alice")).toMatchObject({ ok: true });
    expect(store.redeem("GOOD", "bob")).toMatchObject({ ok: false, reason: "邀请码已被兑换" });
    // 重载=持久化生效
    const store2 = new InviteStore(file);
    expect(store2.get("GOOD")?.redeemedBy).toBe("alice");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("relay 签名挑战( §5.5)", () => {
  it("私钥签名+公钥验签;错钥拒绝", () => {
    const a = newDeviceKey();
    const sig = signChallenge(a.privateKeyPem, "nonce-1");
    expect(verifyChallenge(a.publicKeyPem, "nonce-1", sig)).toBe(true);
    const b = newDeviceKey();
    expect(verifyChallenge(b.publicKeyPem, "nonce-1", sig)).toBe(false);
    expect(verifyChallenge(a.publicKeyPem, "nonce-2", sig)).toBe(false);
    expect(verifyChallenge("not a pem", "nonce-1", sig)).toBe(false);
  });

  it("指纹=公钥 sha256 短码(信任锚自证)", () => {
    const a = newDeviceKey();
    expect(fingerprintOf(a.publicKeyPem)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
  });
});
