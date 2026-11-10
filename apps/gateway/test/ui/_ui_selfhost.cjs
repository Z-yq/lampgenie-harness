/** UI spec 通用自启跑法(2026-10-14 子代理过程卡/渲染修复轮):不碰产线 7700,自起临时端口实例后原地运行 spec。
 * 形态学 _board_selfhost.cjs;spec 若需定制装配(executor/llm),放 --opts 模块导出 createGatewayApp 选项。
 * 用法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs [--opts ./xx.opts.cjs] test/ui/<spec>.cjs
 * (SELF_PORT 可改端口,默认 7716;spec 末尾 process.exit 收尾为既有约定,临时目录随进程尽力清) */
process.env.GENIE_CHECKPOINT = "off";
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const args = process.argv.slice(2);
const optsIdx = args.indexOf("--opts");
const optsModule = optsIdx >= 0 ? require(resolve(args[optsIdx + 1])) : null;
if (optsIdx >= 0) args.splice(optsIdx, 2);
if (!args.length) { console.error("用法: npx tsx test/ui/_ui_selfhost.cjs [--opts <module>] <spec.cjs>"); process.exit(2); }

const PORT = Number(process.env.SELF_PORT || 7716);

(async () => {
  // 动态 import(ESM)而非 require:app.ts 依赖链里有顶层 await(sense-index-manager),
  // tsx 对 .cjs 入口的同步 require 会按 CJS 转译并拒绝 TLA(2026-10-26 tsx 4.23 复现)。
  const { createGatewayApp } = await import("../../src/app.ts");
  const { servePanel } = await import("../../src/panel.ts");
  const jd = mkdtempSync(join(tmpdir(), "uiself-"));
  const extra = typeof optsModule === "function" ? optsModule() : (optsModule || {});
  const app = createGatewayApp({ useExternalHttp: true, journalDir: jd, ...(extra && typeof extra === "object" ? extra : {}) });
  globalThis.__selfhostApp = app; // spec 可用 journal 注入/读取事件(A 轮「喂转录」DOM 检查)
if (app && app.journal && !app.journal.appendMany) app.journal.appendMany = (list) => { for (const e of list) app.journal.append(e); }; // dashboard.spec 批量注入适配
  servePanel(PORT, (srv) => app.attachWs(srv), {
    // IDE 图片预览取数(与 main.ts 同款注入):/ide/asset 按项目根沙箱取图
    ideProjectRoot: (pid) => { try { return app.projects.resolveWorkdir(pid || app.projects.activeId()) || undefined; } catch (e) { return undefined; } },
  });
  process.env.PANEL_BASE = "http://127.0.0.1:" + PORT;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(process.env.PANEL_BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
    if (Date.now() - t0 > 20000) throw new Error("self-host panel not ready on " + PORT);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("[ui-selfhost] panel on " + process.env.PANEL_BASE + " (journalDir=" + jd + ")");
  try {
    require(resolve(args[0])); // 进程内运行:spec 末尾 process.exit 收尾(含 finally 关浏览器)
  } finally {
    try { rmSync(jd, { recursive: true, force: true }); } catch (e) { /* 临时目录尽力清 */ }
  }
})().catch((e) => { console.error("SELFHOST CRASH", e); process.exit(1); });
