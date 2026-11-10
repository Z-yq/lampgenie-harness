/** selfhost 装配(2026-11-05 task-resume spec):形态照抄 _protocol-verify.opts.cjs。
 *  要点:①关 code_sense orient(慢盘 ts-morph 全量索引阻塞 selfhost 事件循环数分钟)
 *       ②GENIE_REPO_ROOT 指临时小仓(档案/索引落 tmp,不碰真仓)
 *       ③EchoChildBackend 立即终态(验证续跑任务 queued→running→done 全链)。 */
module.exports = function () {
  process.env.GENIE_SENSE_ORIENT = "off";
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const tinyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-resume-root-"));
  fs.writeFileSync(path.join(tinyRoot, "pnpm-workspace.yaml"), "packages: []\n");
  fs.mkdirSync(path.join(tinyRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(tinyRoot, "src", "demo.ts"), "export function demoMain(): number { return 1; }\n");
  process.env.GENIE_REPO_ROOT = tinyRoot;
  const { EchoChildBackend } = require("@lampgenie/executors");
  return { executor: new EchoChildBackend() };
};
