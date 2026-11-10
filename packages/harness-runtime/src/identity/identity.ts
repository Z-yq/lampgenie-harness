/**
 * 身份层:设备 ed25519 密钥对 + 指纹 + 邀请码流。
 * 密钥本地生成,私钥 600 权限,指纹=公钥短码。
 */
import { generateKeyPairSync, createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Identity {
  /** 公钥指纹(8 段 base32 短码,人可读可比对)。 */
  fingerprint: string;
  publicKeyPem: string;
  privateKeyPath: string;
}

/** 公钥 → 指纹:sha256 前 16 字节 hex,每 4 字符分组。 */
export function fingerprintOf(publicKeyPem: string): string {
  const digest = createHash("sha256").update(publicKeyPem).digest("hex");
  return digest.slice(0, 32).replace(/(.{4})(?=.)/g, "$1-");
}

/** 加载或生成身份(幂等)。 */
export function loadOrCreateIdentity(dir: string): Identity {
  const privPath = `${dir}/identity.pem`;
  const pubPath = `${dir}/identity.pub`;
  mkdirSync(dir, { recursive: true });

  if (existsSync(privPath) && existsSync(pubPath)) {
    const publicKeyPem = readFileSync(pubPath, "utf-8");
    return { fingerprint: fingerprintOf(publicKeyPem), publicKeyPem, privateKeyPath: privPath };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(privPath, privPem, { mode: 0o600 });
  writeFileSync(pubPath, pubPem);
  return { fingerprint: fingerprintOf(pubPem), publicKeyPem: pubPem, privateKeyPath: privPath };
}

/** 一次性邀请码(7 天有效)。 */
export function createInviteCode(): { code: string; expiresAt: number } {
  const code = createHash("sha256")
    .update(randomBytes16())
    .digest("base64url")
    .slice(0, 24);
  return { code, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 };
}

function randomBytes16(): string {
  return createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex");
}
