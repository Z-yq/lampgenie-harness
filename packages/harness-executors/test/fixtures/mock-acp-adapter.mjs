/**
 * Mock ACP adapter(step-117 协议级验证夹具):node mock-acp-adapter.mjs
 *
 * 以最小 ACP agent 侧实现顶替真实 adapter(claude-code-acp/codex-acp/kimi acp…),
 * 覆盖 initialize → session/new → session/prompt → session/update 通知流 +
 * session/request_permission 反向请求 + session/cancel 通知。
 *
 * env:
 *   MOCK_ACP_MODE = happy | permission | slow | crash | badversion | unknown-stop | no-text
 *   MOCK_ACP_TRACE = <file>  追加关键帧(prompt/cancel/permission decision),给「取消链/权限回传」留证据
 */
import { appendFileSync } from "node:fs";

const mode = process.env.MOCK_ACP_MODE || "happy";
const tracePath = process.env.MOCK_ACP_TRACE;
let sessionId = "sess-mock-1";
let promptId = null;
let permissionResolve = null;

const send = (obj) => { process.stdout.write(JSON.stringify(obj) + "\n"); };
const trace = (line) => {
  if (!tracePath) return;
  try { appendFileSync(tracePath, line + "\n", "utf-8"); } catch { /* 证据文件失败不影响协议 */ }
};
const sendUpdate = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const chunk = (text) => sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const finishPrompt = (stopReason) => {
  if (promptId === null) return;
  const id = promptId;
  promptId = null;
  send({ jsonrpc: "2.0", id, result: { stopReason } });
};

function startPrompt(id, params) {
  promptId = id;
  trace("prompt:" + String(params?.prompt?.[0]?.text ?? "").slice(0, 60));
  switch (mode) {
    case "badversion":
    case "no-text":
      finishPrompt("end_turn");
      break;
    case "permission":
      chunk("before-permission");
      send({
        jsonrpc: "2.0",
        id: "perm-1",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "tc-1",
            title: "写入文件",
            kind: "edit",
            rawInput: { path: "/tmp/mock.txt" },
          },
          options: [
            { optionId: "opt-allow", name: "Allow once", kind: "allow_once" },
            { optionId: "opt-reject", name: "Reject once", kind: "reject_once" },
          ],
        },
      });
      permissionResolve = (result) => {
        trace("permission-result:" + JSON.stringify(result));
        chunk("decision=" + JSON.stringify(result));
        finishPrompt("end_turn");
      };
      break;
    case "slow":
      // 等 session/cancel(取消链验证)
      break;
    case "crash":
      chunk("partial-before-crash");
      setTimeout(() => {
        process.stderr.write("mock-acp: deliberate crash\n");
        process.exit(3);
      }, 30);
      break;
    case "unknown-stop":
      chunk("future-stop");
      finishPrompt("future_thing");
      break;
    case "happy":
    default:
      sendUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想一下" } });
      sendUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "读取 README", kind: "read", status: "in_progress" });
      chunk("第一段");
      setTimeout(() => {
        chunk("第二段");
        sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", title: "读取 README", kind: "read", status: "completed" });
        finishPrompt("end_turn");
      }, 40);
      break;
  }
}

function handle(msg) {
  const id = msg.id;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: mode === "badversion" ? 9 : 1,
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        agentInfo: { name: "mock-acp-adapter", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId } });
    return;
  }
  if (msg.method === "session/prompt") {
    startPrompt(id, msg.params ?? {});
    return;
  }
  if (msg.method === "session/cancel") {
    trace("cancel:" + String(msg.params?.sessionId ?? ""));
    chunk("cancel-ack");
    setTimeout(() => finishPrompt("cancelled"), 20);
    return;
  }
  // 反向请求的响应(权限):id=perm-1,无 method
  if ((id === "perm-1" || id === "perm-reject") && msg.result !== undefined && permissionResolve) {
    const resolve = permissionResolve;
    permissionResolve = null;
    resolve(msg.result);
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "mock: unknown method " + String(msg.method) } });
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunkText) => {
  buffer += chunkText;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => { process.exit(0); });
