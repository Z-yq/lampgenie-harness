/**
 * 远程连接向导命令生成(ZCode 远程连接向导对齐):
 * 产出可复制执行的真实命令——node-agent 单文件 bundle 从 gateway /downloads/node-agent.mjs 分发。
 * 纯函数(测试可锚定):输入主机参数 → SSH/Docker 两种引导命令文本。
 */

export interface WizardInput {
  kind: "ssh" | "docker";
  host: string;
  user: string;
  port: number;
  /** gateway 对外地址(ws://ip:port)。 */
  gatewayUrl: string;
  nodeId: string;
}

/** 网卡地址形状(pickLanAddress 注入面;测试可造假网卡)。 */
export interface IfaceAddr {
  name: string;
  address: string;
  internal: boolean;
  family: string;
}

/**
 * gateway 对外地址推导(旧 hardcode 127.0.0.1——远程机拿到 curl 地址在本机外不可达)。
 * 规则:私网段(10/172.16-31/192.168)优先,取首个非 internal IPv4;env GENIE_PUBLIC_HOST 一票覆盖;
 * 全无命中回退 127.0.0.1(单机形态如实,note 会标明)。
 */
export function pickLanAddress(ifaces: IfaceAddr[], envHost?: string): string {
  if (envHost && envHost.trim()) return envHost.trim();
  const priv = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  const v4 = ifaces.filter((i) => !i.internal && i.family === "IPv4" && !i.address.startsWith("127."));
  const lan = v4.find((i) => priv.test(i.address));
  return (lan ?? v4[0])?.address ?? "127.0.0.1";
}

export function genBootstrapCommand(input: WizardInput): { command: string; note: string } {
  const base = input.gatewayUrl.replace(/\/$/, "");
  const fetch = "curl -fsSL " + base.replace(/^ws/, "http") + "/downloads/node-agent.mjs -o genie-node-agent.mjs";
  const env = "GENIE_GATEWAY_URL=" + base + " GENIE_NODE_ID=" + input.nodeId;
  if (input.kind === "ssh") {
    const command =
      "ssh -p " + input.port + " " + input.user + "@" + input.host + " '" +
      "node -v >/dev/null 2>&1 || { echo 需要先安装 Node.js(>=20); exit 1; }; " +
      fetch + " && nohup env " + env + " node genie-node-agent.mjs > genie-node.log 2>&1 & " +
      "echo node-agent 已后台启动,日志 ~/genie-node.log'";
    return { command, note: "在本地终端执行;远程机需 Node.js≥20 与到 gateway 的网络可达。" };
  }
  const command =
    "docker run -d --name genie-node --restart unless-stopped " +
    "-e GENIE_GATEWAY_URL=" + base + " -e GENIE_NODE_ID=" + input.nodeId + " " +
    "node:20-alpine sh -c '" + fetch.replace(/'/g, "") + " && node genie-node-agent.mjs'";
  return { command, note: "Docker 形态:容器内拉取并常驻;适合无法直装 Node 的主机。" };
}
