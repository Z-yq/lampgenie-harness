/** board.spec.cjs 自启跑法(浮窗升级轮):不碰生产环境 7700,自起临时端口实例后原地运行 board.spec.cjs。
 * 形态学 apps/gateway/test/ui/sidebar.spec.cjs 的自启:npx tsx 加载 src,createGatewayApp(useExternalHttp)+servePanel;
 * 板 fixture 由 board.spec.cjs 自己造自己清(.genie/boards/ui-board-test,repoRoot 解析与实例一致)。
 * 用法:cd apps/gateway && npx tsx test/ui/_board_selfhost.cjs   (SELF_PORT 可改端口,默认 7714) */
process.env.GENIE_CHECKPOINT = "off";
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PORT = Number(process.env.SELF_PORT || 7714);

(async () => {
  const jd = mkdtempSync(join(tmpdir(), "bself-"));
  const backend = { kind: "sbd-e2e", async spawn(spec, onEvent) {
    onEvent({ type: "result", result: { ok: true, finalText: "回复:" + spec.instructions.slice(0, 8) } });
    return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
  } };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
  servePanel(PORT, (srv) => app.attachWs(srv));
  process.env.PANEL_BASE = "http://127.0.0.1:" + PORT;
  // 等面板 HTTP 就绪再放行 spec(goto 失败会被 spec 的 catch 判成 CRASH)
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(process.env.PANEL_BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
    if (Date.now() - t0 > 15000) throw new Error("self-host panel not ready on " + PORT);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("[self-host] panel on " + process.env.PANEL_BASE + " (journalDir=" + jd + ")");
  try {
    require(process.env.SELF_SPEC || "./board.spec.cjs"); // 进程内运行:spec 末尾 process.exit 收尾(含 finally 清板/关浏览器);SELF_SPEC 可换 boardpersist 等
  } finally {
    try { rmSync(jd, { recursive: true, force: true }); } catch (e) { /* 临时目录尽力清 */ }
  }
})().catch((e) => { console.error("SELFHOST CRASH", e); process.exit(1); });
