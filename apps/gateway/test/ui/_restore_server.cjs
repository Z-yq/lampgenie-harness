/** step-072 白板恢复闭环实测:gateway 子进程(可被 runner 杀/重启,测「重启后恢复」场景)。
 * 形态学 _board_selfhost.cjs:tsx 加载 src,useExternalHttp + servePanel;executor=秒回桩(任务即 done)。
 * 差异:journalDir 固定(默认 /tmp/j-s072)——重启后 journal 仍在,验证「跨进程恢复」;
 * 板文件在 repoRoot()/.genie/boards(不随 journalDir),重启后靠盘上读取(boardMemIndex 清空)。 */
process.env.GENIE_CHECKPOINT = process.env.GENIE_CHECKPOINT || "off";
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");

const PORT = Number(process.env.SELF_PORT || 7799);
const JD = process.env.GENIE_JOURNAL_DIR || "/tmp/j-s072";

const backend = { kind: "sbd-e2e", async spawn(spec, onEvent) {
  onEvent({ type: "result", result: { ok: true, finalText: "回复:" + spec.instructions.slice(0, 8) } });
  return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
} };

const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: JD });
servePanel(PORT, (srv) => app.attachWs(srv));
console.log("[restore-server] pid=" + process.pid + " port=" + PORT + " journalDir=" + JD);
