/**
 * 面板产物版本戳(2026-10-22,IDE 空白根治)。
 *
 * 为什么需要:桌面窗口/浏览器 tab 打开后**永不重载**——gateway 重建并重启后,
 * 老页面仍在跑旧 JS(WebSocket 会自动重连到新进程、页面脚本却不会更新),
 * 表现为「点了没反应 / 编辑区空白 / 标签卡在读取中」。所以 hello 帧带上本戳,
 * 页面发现自己与服务器戳不符时自愈重载(panel.ts 的 panelBuildCheck)。
 *
 * 取值:进程入口(打包态=dist/gateway.mjs)的 mtime——每次 pnpm build 都会刷新,
 * 无需手工维护版本号,也不会漏改。取不到时回 "dev"(dev 态两边同为 dev,不触发重载)。
 */
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

function computeBuild(): string {
  const candidates = [process.argv[1], fileURLToPath(import.meta.url)];
  for (const p of candidates) {
    if (!p) continue;
    try {
      const st = statSync(p);
      return String(Math.floor(st.mtimeMs));
    } catch {
      /* 试下一个候选 */
    }
  }
  return "dev";
}

export const PANEL_BUILD = computeBuild();
