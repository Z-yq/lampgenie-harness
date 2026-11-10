/**
 * relay 鉴权(designs/05 §5.5):连接=出示设备私钥签名挑战;
 * relay 校验指纹在 roster.keys 内且未吊销。relay 不存私钥、不存口令。
 */
import { generateKeyPairSync, sign, verify, randomBytes } from "node:crypto";

/** 生成设备密钥对(identity.ts 的 PEM 落盘之外的无文件形态,e2e 用)。 */
export function newDeviceKey(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** 客户端:对挑战签名(私钥永不出本机)。 */
export function signChallenge(privateKeyPem: string, nonce: string): string {
  return sign(null, Buffer.from(nonce, "utf8"), privateKeyPem).toString("base64");
}

/** relay:发挑战。 */
export function newChallenge(): string {
  return randomBytes(24).toString("base64url");
}

/** relay:验签——公钥从 roster 条目取(指纹→公钥映射由 roster 镜像提供)。 */
export function verifyChallenge(
  publicKeyPem: string,
  nonce: string,
  sigB64: string,
): boolean {
  try {
    return verify(null, Buffer.from(nonce, "utf8"), publicKeyPem, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}
