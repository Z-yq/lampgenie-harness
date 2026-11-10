/** 协议改造三面验收(step-1036 索引化 + session.status 增量化)的 selfhost 装配。
 * 形态照抄 _subdir.opts.cjs:_ui_selfhost.cjs 的 --opts 工厂,返回 createGatewayApp 附加选项。
 * 要点:①关 code_sense orient(慢盘 ts-morph 全量索引会阻塞 selfhost 事件循环数分钟)
 *      ②GENIE_REPO_ROOT 指临时 3 文件小仓(档案/索引全落 tmp,不碰真仓)
 *      ③executor 立即回 ok:false 终态(终态正文非空 → 核「task.detail.get 按需拉正文」面)
 *      ④不传 llm → 无 worker 进程,executor 走进程内 wireExecutor。 */
module.exports = function () {
  process.env.GENIE_SENSE_ORIENT = "off";
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const tinyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "protocol-verify-root-"));
  fs.writeFileSync(path.join(tinyRoot, "pnpm-workspace.yaml"), "packages: []\n");
  fs.mkdirSync(path.join(tinyRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(tinyRoot, "src", "demo.ts"), "export function demoMain(): number { return demoHelp(); }\nexport function demoHelp(): number { return 1; }\n");
  process.env.GENIE_REPO_ROOT = tinyRoot;
  // 终态正文刻意放一段可辨识文本:面板流尾/失败横幅要靠 task.detail.get 才拿得到它。
  const FINAL = "协议验收终态:本任务以失败收尾,正文由 task.detail.get 按需取回。";
  return {
    executor: { kind: "protocol-probe", async spawn(spec, onEvent) {
      setTimeout(() => { try { onEvent({ type: "result", result: { ok: false, error: { kind: "probe-failed", detail: FINAL } } }); } catch (e) { /* 宿主已收尾 */ } }, 300);
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    } },
  };
};