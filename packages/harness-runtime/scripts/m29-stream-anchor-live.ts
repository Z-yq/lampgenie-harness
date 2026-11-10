/**
 * M29 真实运行验收(不 build、不重启):
 * 本地起一个假 OpenAI 兼容 HTTP 服务——第 1 次连接吐 2 个内容 delta 后直接断 socket(SSE 中途断流),
 * 第 2 次连接成功吐「第二段」。用**真 provider + 真 journal**跑一次 chat,断言:
 *  - 返回 content 只含第二段(不与半截拼接)
 *  - stream.attempt.discarded 恰好 1 条(attemptId/partialChars/anchor 留痕)
 *  - 两次 HTTP 尝试(attempts=2)
 * 运行:NODE_OPTIONS=--conditions=development npx tsx scripts/m29-stream-anchor-live.ts
 */
import { createServer } from "node:http";
import { MemoryJournal } from "@lampgenie/core";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider";
import { findSafeAnchor, markDiscard, STREAM_DISCARD_WHAT } from "../src/agent/stream-anchor";

let hits = 0;
const server = createServer((req, res) => {
  req.resume();
  hits += 1;
  if (hits === 1) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"第一段A"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"第一段B"}}]}\n\n');
    // HTTP 200 已发出、半截正文已吐 → 直接销毁 socket(真实断流形态)
    setTimeout(() => res.destroy(), 20);
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n');
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;

const journal = new MemoryJournal();
const sessionId = "live-m29";
journal.append({ kind: "message.user", sessionId, payload: { text: "说点什么" } });

const provider = createOpenAiCompatProvider({
  baseUrl: `http://127.0.0.1:${port}`,
  apiKey: "test-key",
  model: "fake-model",
  retry: 1, // 1 原始 + 1 重试
});

const discards: { attemptId: string; reason: string; partialChars: number }[] = [];
let res;
try {
  res = await provider.chat(
    [{ role: "user", content: "说点什么" }],
    [],
    undefined,
    () => {},
    {
      attemptId: "live:1:1:1",
      onAttemptDiscarded: (info) => {
        discards.push({ attemptId: info.attemptId, reason: info.reason, partialChars: info.partialChars });
        markDiscard(journal, sessionId, {
          attemptId: info.attemptId,
          turn: 1,
          step: 1,
          anchor: findSafeAnchor(journal.readSession(sessionId)),
          reason: info.reason,
          partialChars: info.partialChars,
        });
      },
    },
  );
} finally {
  server.close();
}

const discardedEvents = journal
  .readSession(sessionId)
  .filter((e) => e.kind === "custom" && (e.payload as { what?: string }).what === STREAM_DISCARD_WHAT);

const summary = {
  content: res?.content,
  attemptId: res?.attemptId,
  attempts: hits,
  discardCallback: discards,
  discardedEvents: discardedEvents.map((e) => e.payload),
};

const checks = {
  "content 只含第二段": res?.content === "第二段",
  "discarded 事件 1 条": discardedEvents.length === 1,
  "attempts=2": hits === 2,
  "成功 attemptId=base#1": res?.attemptId === "live:1:1:1#1",
  "partialChars>0": (discards[0]?.partialChars ?? 0) > 0,
};

console.log(JSON.stringify({ ...summary, checks }, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("M29 live: OK");
