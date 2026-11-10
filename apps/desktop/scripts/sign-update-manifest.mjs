#!/usr/bin/env node
/**
 * 更新清单签名工具:用 Ed25519 私钥对 update.json 的规范化字段签名。
 * 用法:
 *   node scripts/sign-update-manifest.mjs --manifest path/to/update.json --key .smoke/keys/update-release-ed25519.pem
 *   node scripts/sign-update-manifest.mjs --manifest path/to/update.json --verify --pub .smoke/keys/update-release-ed25519.pub.pem
 * 签名前先经 parseUpdateManifest 规范化(与壳内验签使用同一份字段与顺序);私钥不入库。
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { sign } from "node:crypto";

const require = createRequire(import.meta.url);
const { parseUpdateManifest, canonicalManifestPayload, verifyManifestSignature } = require("../update-check.js");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const manifestPath = arg("manifest", "");
const keyPath = arg("key", "");
const pubPath = arg("pub", "");
const outPath = arg("out", manifestPath);
const verifyMode = args.includes("--verify");
if (!manifestPath) {
  console.error("用法: node scripts/sign-update-manifest.mjs --manifest <update.json> --key <private.pem> [--out <path>]");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
const parsed = parseUpdateManifest(raw);
if (!parsed.ok) {
  console.error("清单解析失败: " + parsed.error);
  process.exit(1);
}

if (verifyMode) {
  const pub = pubPath ? readFileSync(pubPath, "utf8") : undefined;
  const result = verifyManifestSignature(parsed.manifest, pub);
  console.log("verify=" + result.status + (result.error ? " error=" + result.error : ""));
  process.exit(result.status === "verified" ? 0 : 1);
}

if (!keyPath) {
  console.error("缺少 --key(Ed25519 PKCS8 PEM 私钥)");
  process.exit(2);
}
const privateKey = readFileSync(keyPath, "utf8");
const payload = Buffer.from(canonicalManifestPayload(parsed.manifest), "utf8");
const signature = sign(null, payload, privateKey).toString("base64");
const next = { ...raw, signature };
writeFileSync(outPath, JSON.stringify(next, null, 2));
const check = verifyManifestSignature({ ...parsed.manifest, signature });
console.log(`signed version=${parsed.manifest.version} bytes=${payload.length} signature=${signature.slice(0, 16)}… verify=${check.status}`);
if (check.status !== "verified") process.exit(1);