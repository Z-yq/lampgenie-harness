/** task-resume spec 的网关子进程:
 *  .mjs 形态=ESM import 链,绕开在途 sense-index-manager.ts top-level await 的
 * cjs transform 失败(并行任务 /167 在途改动,以其为准,不回滚);
 *  注入 interrupted/done/cancelled 三任务后 READY 行打印素材 id 给 spec 端。
 *  环境:SELF_PORT(默认 7757)/RESUME_RUN(运行标识)。 */
process.env.GENIE_CHECKPOINT = process.env.GENIE_CHECKPOINT || "off";
process.env.GENIE_SENSE_ORIENT = "off";
process.env.GENIE_JOURNAL_DIR = process.env.GENIE_JOURNAL_DIR || "/tmp/j-task-resume";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tinyRoot = mkdtempSync(join(tmpdir(), "task-resume-root-"));
writeFileSync(join(tinyRoot, "pnpm-workspace.yaml"), "packages: []\n");
mkdirSync(join(tinyRoot, "src"), { recursive: true });
writeFileSync(join(tinyRoot, "src", "demo.ts"), "export function demoMain(): number { return 1; }\n");
process.env.GENIE_REPO_ROOT = tinyRoot;

const PORT = Number(process.env.SELF_PORT || 7757);
const RUN = process.env.RESUME_RUN || "r0";
const { createGatewayApp } = await import("../../src/app.ts");
const { servePanel } = await import("../../src/panel.ts");
const { EchoChildBackend } = await import("@lampgenie/executors");

const app = createGatewayApp({ useExternalHttp: true, executor: new EchoChildBackend() });
const SID = "sid-int-" + RUN;
const now = Date.now();
const mk = (id, state, over = {}) => app.taskManager.inject({
  id, sessionId: SID, instruction: over.instruction || ("任务书-" + id), state,
  createdAt: now - 120_000, updatedAt: now - 60_000, ...over,
});
const INT_ID = mk("int-" + RUN, "interrupted", { instruction: "被打断的任务-" + RUN, result: "网关重启中断(原任务书 int-" + RUN + ";可续跑)" }).id;
const DONE_ID = mk("done-" + RUN, "done", { result: "ok" }).id;
const CANCEL_ID = mk("cancel-" + RUN, "cancelled", { result: "用户手动取消" }).id;

servePanel(PORT, (srv) => app.attachWs(srv));
// spec 端从 stdout 读 READY 行拿素材 id
process.stdout.write("READY " + JSON.stringify({ sid: SID, int: INT_ID, done: DONE_ID, cancel: CANCEL_ID }) + "\n");
