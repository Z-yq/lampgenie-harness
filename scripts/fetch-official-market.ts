/**
 * 拉取 ZCode 官方插件市场快照(marketplace.json + 全部插件 zip,sha256 校验)
 * 落点 apps/gateway/src/assets/official-market/(随 gateway build 进 dist/assets)。
 * 刷新:重跑本脚本。网络需代理时传 --proxy socks5://127.0.0.1:1080。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const MARKET_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json";
const ROOT = join(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, "apps", "gateway", "src", "assets", "official-market");

const proxyArg = process.argv.find((a) => a.startsWith("--proxy="));
const proxy = proxyArg ? proxyArg.split("=")[1] : undefined;
// 超大包(多为 ui 组件包,单包 15-45MB)默认不随快照分发;传 --big 才拉。
const includeBig = process.argv.includes("--big");
const BIG_ZIP_BYTES = 2 * 1024 * 1024;

function fetchUrl(url: string, out: string): void {
  const args = ["-sS", "--fail", "--connect-timeout", "20", "--max-time", "300", "-o", out];
  if (proxy) args.push("--socks5-hostname", proxy.replace(/^\w+:\/\//, ""));
  args.push(url);
  execFileSync("curl", args, { stdio: ["ignore", "ignore", "inherit"] });
}

interface MarketPlugin {
  name: string;
  source?: { url?: string; sha256?: string };
  version?: string;
  unlisted?: boolean;
}

mkdirSync(join(OUT_DIR, "zips"), { recursive: true });
fetchUrl(MARKET_URL, join(OUT_DIR, "marketplace.json"));
const manifest = JSON.parse(readFileSync(join(OUT_DIR, "marketplace.json"), "utf8")) as {
  plugins: MarketPlugin[];
};
const plugins = manifest.plugins.filter((p) => p?.name && p.source?.url?.endsWith(".zip"));
console.log(`清单 ${manifest.plugins.length} 条,zip 源 ${plugins.length} 个`);

// ── 图标拉取(市场卡片 logo;CDN assets/<name>/icon.png,失败容错)──
mkdirSync(join(OUT_DIR, "icons"), { recursive: true });
let iconOk = 0;
for (const p of manifest.plugins) {
  if (!p?.name) continue;
  const iconPath = join(OUT_DIR, "icons", `${p.name}.png`);
  if (existsSync(iconPath)) { iconOk++; continue; }
  try {
    fetchUrl(p.icon || `https://cdn-zcode.z.ai/zcode/official-plugin/assets/${p.name}/icon.png`, iconPath);
    iconOk++;
  } catch {
    // 无图标条目容错:面板回退首字母徽标
  }
}
console.log(`图标:${iconOk}/${manifest.plugins.length}`);

let ok = 0;
let skipped = 0;
const failures: string[] = [];
for (const p of plugins) {
  const url = p.source!.url!;
  const sha = p.source!.sha256;
  const rel = `zips/${p.name}-${p.version ?? "0"}.zip`;
  const out = join(OUT_DIR, rel);
  if (!existsSync(out)) {
    try {
      fetchUrl(url, out);
    } catch {
      failures.push(`${p.name}: 下载失败`);
      continue;
    }
  }
  const size = readFileSync(out).length;
  if (size > BIG_ZIP_BYTES && !includeBig) {
    rmSync(out);
    console.log(`  - ${p.name} ${p.version ?? ""} 跳过(${(size / 1024 / 1024).toFixed(1)}MB,--big 才拉)`);
    skipped++;
    continue;
  }
  if (sha) {
    const actual = createHash("sha256").update(readFileSync(out)).digest("hex");
    if (actual !== sha) {
      rmSync(out);
      failures.push(`${p.name}: sha256 不匹配(期望 ${sha.slice(0, 8)}..)`);
      continue;
    }
  }
  ok++;
  console.log(`  ✓ ${p.name} ${p.version ?? ""} (${(readFileSync(out).length / 1024).toFixed(0)}KB)`);
}
writeFileSync(join(OUT_DIR, "FETCH-STATUS.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), ok, skipped, failures, total: plugins.length }, null, 2) + "\n");
console.log(`完成:${ok}/${plugins.length}(跳过 ${skipped} 个超大包)${failures.length ? ";失败:" + failures.join(";") : ""}`);
process.exit(failures.length && ok === 0 ? 1 : 0);
