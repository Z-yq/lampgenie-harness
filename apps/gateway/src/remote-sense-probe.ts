/** 远端 code_sense/code_review 路由的真机探针(esbuild 独立 bundle,打包态可跑):
 *  node remote-sense-probe.mjs <distro> <posixRoot> [--review]
 *  依赖:GENIE_SENSE_E2E 环境变量显式开启(防误跑真通道)。 */
import { tryChannelJson } from "./remote-channel.js";
import { senseArgvFor, dispatchSenseArgs } from "./sense-tool.js";
import type { RemoteProject } from "./remote-project.js";

export async function run(opts?: { exit?: boolean }): Promise<void> {
  await main(opts);
}

async function main(opts?: { exit?: boolean }) {
  if (process.env.GENIE_SENSE_E2E !== "1") {
    console.error("设置 GENIE_SENSE_E2E=1 再跑(会真实调用远端工作区服务)");
    process.exit(2);
  }
  const [distro, root, mode] = process.argv.slice(2);
  if (!distro || !root) { console.error("用法: remote-sense-probe <distro> <posixRoot> [--review]"); process.exit(2); }
  const remote: RemoteProject = { kind: "wsl", distro, workspacePath: root, identity: `remote:wsl:${distro}:${root}` };
  const t0 = Date.now();
  if (mode === "--review") {
    const ch = await tryChannelJson(remote, "review", { timeout: 300_000 });
    const d = (ch && (ch as { data?: { stdout?: string } }).data?.stdout) ?? "";
    console.log("REVIEW", Date.now() - t0, "ms", String(d).slice(0, 300));
  } else {
    const d = dispatchSenseArgs({ action: "symbol", target: mode ?? "main" });
    const plan = senseArgvFor(d, root);
    const argv = (plan as { argv?: string[] }).argv ?? [];
    const ch = await tryChannelJson(remote, "sense", { argv });
    const out = (ch && (ch as { data?: { stdout?: string } }).data?.stdout) ?? JSON.stringify(ch);
    console.log("SYMBOL", Date.now() - t0, "ms", String(out).slice(0, 400));
  }
  if (opts?.exit !== false) process.exit(0);
}
if (process.argv[1] && /remote-sense-probe/.test(process.argv[1])) void main();
