/**
 * panel/protocol 拆分期间的源码聚合出口(大文件切分配套)。
 * 源码文本断言类测试此前读单个 panel.ts;拆分后内容按域搬进 panel/ 分片,
 * 这里按拼装序把「panel.ts + 全部分片」串成一个字符串,断言语义不变
 * (锚点在哪个分片都能命中;计数守恒——每段内容全仓只出现一次)。
 * 每个拆分子批只需把新分片路径追加进 PARTS;拆分终验后此文件随之收缩。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const PANEL_PARTS = [
  "../src/panel.ts",
  "../src/panel/page-css.ts",
  "../src/panel/page-shell.ts",
  "../src/panel/script-core.ts",
  "../src/panel/script-traj.ts",
  "../src/panel/script-icons-sidebar.ts",
  "../src/panel/script-markdown.ts",
  "../src/panel/script-tool-render.ts",
  "../src/panel/script-history.ts",
  "../src/panel/script-views.ts",
  "../src/panel/script-providers.ts",
  "../src/panel/script-ws-router.ts",
  "../src/panel/script-submit.ts",
  "../src/panel/script-admin.ts",
  "../src/panel/script-board-render.ts",
  "../src/panel/script-canvas.ts",
  "../src/panel/script-canvas-ops.ts",
  "../src/panel/script-dialogs.ts",
  "../src/panel/script-model-menu.ts",
  "../src/panel/script-commands.ts",
  "../src/panel/script-voice-cite.ts",
  "../src/panel/script-ide-1.ts",
  "../src/panel/script-ide-2.ts",
  "../src/panel/script-annotate.ts",
  "../src/panel/page-profile.ts",
];

const PROTOCOL_PARTS = [
  "../../../packages/protocol/src/index.ts",
  "../../../packages/protocol/src/messages/core.ts",
  "../../../packages/protocol/src/messages/task.ts",
  "../../../packages/protocol/src/messages/session.ts",
  "../../../packages/protocol/src/messages/surface.ts",
  "../../../packages/protocol/src/messages/ide-fs.ts",
  "../../../packages/protocol/src/messages/board.ts",
  "../../../packages/protocol/src/messages/annotate.ts",
  "../../../packages/protocol/src/messages/rsi.ts",
  "../../../packages/protocol/src/messages/server-events.ts",
];

export const PANEL_SRC = PANEL_PARTS.map((p) => readFileSync(join(HERE, p), "utf8")).join("\n");
export const PROTOCOL_SRC = PROTOCOL_PARTS.map((p) => readFileSync(join(HERE, p), "utf8")).join("\n");

/**
 * 纯 CSS 源:仅样式表分片正文,尾部补合成 </style>(与拆分前「CSS 区→</style>」锚点语义一致)。
 * 用途:CSS 契约断言(主题/令牌/清晰度)。不要用 PANEL_SRC 做 CSS 切片——主脚本 JS 里也有
 * ` :root{` 等同形字符串,聚合后 indexOf 会抢首命中。
 */
const cssRaw = readFileSync(join(HERE, "../src/panel/page-css.ts"), "utf8");
export const PANEL_CSS_SRC = cssRaw.slice(cssRaw.indexOf("`") + 1, cssRaw.lastIndexOf("`")) + "\n</style>";

const AGENT_WIRING_PARTS = [
  "../src/agent-wiring.ts",
  "../src/agent-wiring/permission.ts",
  "../src/agent-wiring/wiring-core.ts",
  "../src/agent-wiring/loop-support.ts",
  "../src/agent-wiring/tools.ts",
  "../src/agent-wiring/workflow-task.ts",
  "../src/agent-wiring/deadline-wire.ts",
  "../src/agent-wiring/run-with-agent.ts",
];
export const AGENT_WIRING_SRC = AGENT_WIRING_PARTS.map((p) => readFileSync(join(HERE, p), "utf8")).join("\n");

const SERVER_PARTS = [
  "../src/server.ts",
  "../src/server/state.ts",
  "../src/server/helpers.ts",
  "../src/server/lifecycle.ts",
  "../src/server/dispatch.ts",
  "../src/server/misc.ts",
  "../src/server/task.ts",
  "../src/server/admin.ts",
  "../src/server/session.ts",
  "../src/server/board.ts",
  "../src/server/ide-fs.ts",
];
export const SERVER_SRC = SERVER_PARTS.filter((p) => existsSync(join(HERE, p)))
  .map((p) => readFileSync(join(HERE, p), "utf8"))
  .join("\n");
