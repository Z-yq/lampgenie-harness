/** fixD 主链路双实例之一:共享临时项目目录的 gateway 实例(端口/用户名/项目目录全由 env 注入)。
 * 由 _issue_mainlink.cjs spawn;打印 READY 行后常驻,被父进程 kill。 */
process.env.GENIE_CHECKPOINT = "off";
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PORT = Number(process.env.SELF_PORT);
const PROJ = process.env.ISSUE_PROJ_DIR;

(async () => {
  const jd = mkdtempSync(join(tmpdir(), "mljd-"));
  const backend = { kind: "sbd-e2e", async spawn(spec, onEvent) {
    onEvent({ type: "result", result: { ok: true, finalText: "echo-完成:" + spec.instructions.slice(0, 12) } });
    return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
  } };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
  const added = app.projects.add(PROJ);
  if (!added.ok) { console.error("INST-FAIL " + added.reason); process.exit(1); }
  app.projects.activate(added.project.id);
  servePanel(PORT, (srv) => app.attachWs(srv));
  console.log("READY port=" + PORT + " user=" + process.env.GENIE_P2P_USER + " project=" + added.project.id);
  setInterval(() => {}, 10000);
})().catch((e) => { console.error("INST CRASH", e); process.exit(1); });
