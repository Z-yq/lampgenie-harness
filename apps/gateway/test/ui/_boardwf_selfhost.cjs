/** boardwf.spec.cjs 自起跑法(step-121 工作流板):不碰产线 7700;临时端口 7817 实例+journal /tmp/j-s121。
 * 用法:cd apps/gateway && NODE_OPTIONS=--conditions=development SELF_PORT=7817 npx tsx test/ui/_boardwf_selfhost.cjs
 * 注意:NODE_OPTIONS 必须在命令行传——文件内的 process.env 赋值只影响子进程,对本进程已初始化的模块解析
 * 条件无效(实锤:不带 env 跑,protocol 新字段 docKind=workflow/wf 走 dist 旧 zod,新板全部 skipped、
 * 板清单空、spec 在选板处 30s 超时)。下方赋值仅作子进程兜底保留。 */
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : "") + "--conditions=development";
process.env.GENIE_CHECKPOINT = "off";
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { mkdtempSync, rmSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PORT = Number(process.env.SELF_PORT || 7817);
const JDIR = process.env.WF_JOURNAL_DIR || "/tmp/j-s121";

(async () => {
  mkdirSync(JDIR, { recursive: true });
  // 假 executor:wf-agent 节点派发即时回(确定性 e2e,不打真 LLM)
  const backend = { kind: "wfboard-e2e", async spawn(spec, onEvent) {
    onEvent({ type: "result", result: { ok: true, finalText: "代理回复:" + spec.instructions.slice(0, 12) } });
    return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
  } };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: JDIR });
  servePanel(PORT, (srv) => app.attachWs(srv));
  process.env.PANEL_BASE = "http://127.0.0.1:" + PORT;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(process.env.PANEL_BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
    if (Date.now() - t0 > 15000) throw new Error("self-host panel not ready on " + PORT);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("[self-host] panel on " + process.env.PANEL_BASE + " (journalDir=" + JDIR + ")");
  try {
    require("./boardwf.spec.cjs");
  } finally {
    try { rmSync(join(tmpdir(), "wfb-ui-"), { recursive: true, force: true }); } catch (e) { /* 尽力 */ }
  }
})().catch((e) => { console.error("SELFHOST CRASH", e); process.exit(1); });
