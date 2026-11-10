/**
 * 子进程夹具:抓一个「公网但本机不可达」的 IPv6 地址(经 hostname + 注入地址走真实 lookup)。
 *
 * 2026-10-28 事故复现口径:web_search 无 provider 时走 DuckDuckGo HTML 兜底,该域名
 * 解析到本机无路由的 IPv6;旧 pinnedLookup 同步回调让 https 在 TLS 未装配好时同步建连,
 * setServername 抛 TypeError → 半建成 socket 泄漏 → 其 'error'(ENETUNREACH)无人监听
 * → 进程级 uncaughtException(worker code=1,同 worker 的主 agent/子代理一起收尸)。
 *
 * 关键:必须用 hostname(而非 IP 字面量)才走自定义 lookup——IP 字面量 Node 直接跳过解析,
 * 覆盖不到该缺陷;地址经 resolvedAddresses 单测旁路注入,免 DNS 依赖。
 *
 * 用法:node --import tsx <本文件>
 * 输出:RESULT:ok … / RESULT:caught <code> …;退出码 0 = 错误被收敛。
 */
import { fetchPublicPage } from "../../src/web-tool.js";

/** Cloudflare IPv6 解析器地址:公网合法、本机(WSL)无 v6 路由。 */
const UNREACHABLE_V6 = "2606:4700:4700::1111";

async function main(): Promise<void> {
  try {
    const page = await fetchPublicPage("https://example.com/", {
      timeoutMs: 3000,
      resolvedAddresses: [{ address: UNREACHABLE_V6, family: 6 }],
    });
    console.log(`RESULT:ok ${page.status}`);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    const message = error instanceof Error ? error.message : String(error);
    console.log(`RESULT:caught ${code} ${message.slice(0, 160)}`);
  }
}

void main();
