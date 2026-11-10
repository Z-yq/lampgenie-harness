#!/usr/bin/env node
/**
 * Team Relay 生产 CLI( R1「team={provider, groupPath}」落地):
 * 按 providers.yaml 把 Git 平台开发组织绑成 team——此前 main.ts 只能 custom 裸 git。
 * 部署点起一个 relay=建一个 team(权威数据在 Git 团队仓;relay 只是实时面缓存)。
 * 读取:
 *   providers.yaml(providersPath 显式 > RELAY_PROVIDERS_PATH > RELAY_WORKDIR/providers.yaml):
 *     { "team": { "provider": "gitlab|codeup|custom", "groupPath": "my-org",
 *                 "baseUrl": "http://192.168.8.60", "projectPath": "...", "platform": "force" },
 *       "gitName": "genie-relay", "gitEmail": "relay@lampgenie.local" }
 * 环境:RELAY_TEAM_REPO_URL / TEAM_REPO_URL(团队仓地址,platform:force 时;平台模式由 projectPath 拼)/
 *   RELAY_PROVIDERS_PATH / RELAY_WORKDIR / RELAY_PORT / RELAY_PROVIDER_TOKEN / RELAY_BOOTSTRAP=1。
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { TeamRelay } from "@lampgenie/runtime/team/team-relay";
import {
  loadTeamBinding, providerFromBinding, bootstrapTeamRepo,
} from "@lampgenie/runtime/git/provider-factory";

const port = Number(process.env.RELAY_PORT ?? 7870);
const workdir = process.env.RELAY_WORKDIR ?? join(homedir(), ".lampgenie-harness", "relay");
const providersPath =
  process.env.RELAY_PROVIDERS_PATH ??
  (process.env.RELAY_WORKDIR ? join(process.env.RELAY_WORKDIR, "providers.yaml") : join(workdir, "providers.yaml"));

const binding = loadTeamBinding(providersPath);
const provider = providerFromBinding(binding);

const teamRepoUrl =
  process.env.RELAY_TEAM_REPO_URL ??
  process.env.TEAM_REPO_URL ??
  (binding?.team?.groupPath ? `${binding.team.groupPath}/genie-team-context` : "");
if (!teamRepoUrl) {
  console.error("缺少团队仓地址:RELAY_TEAM_REPO_URL/TEAM_REPO_URL,或 providers.yaml 的 team.groupPath(拼 <group>/genie-team-context)");
  process.exit(1);
}

// 团队仓引导:空仓(还没有 roster/)时写初始 projects.yaml 并提交推送。
if (process.env.RELAY_BOOTSTRAP === "1") {
  const made = await bootstrapTeamRepo(provider, teamRepoUrl, join(workdir, ".bootstrap"), {
    mainBranch: process.env.RELAY_MAIN_BRANCH,
  });
  if (made) console.log(`[relay] bootstrap:已引导团队仓 ${teamRepoUrl}(写入 roster/projects.yaml)`);
}

const http = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, teamRepoUrl, provider: provider.kind, ...relay.snapshot() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const relay = new TeamRelay({
  server: http, teamRepoUrl, workdir, providerOpts: provider,
  ...(process.env.RELAY_MAIN_BRANCH ? { mainBranch: process.env.RELAY_MAIN_BRANCH } : {}),
});
http.listen(port, () => {
  console.log(`[relay] listening :${port} teamRepo=${teamRepoUrl} provider=${provider.kind} workdir=${workdir}`);
});
void relay.start();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void relay.close().finally(() => process.exit(0));
  });
}
