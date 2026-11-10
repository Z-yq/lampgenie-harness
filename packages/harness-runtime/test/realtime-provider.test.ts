import { describe, it, expect } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createRealtimeProvider, realtimeUrl } from "../src/agent/realtime-provider.js";

/** mock DashScope api-ws 服务端(beta 方言):session.updated 回执 + item created 回执 + response.done。 */
function mockRealtimeServer(handlers: {
  onSession?: (s: Record<string, unknown>) => void;
  items: Record<string, unknown>[];
  output: Record<string, unknown>[];
}) {
  const wss = new WebSocketServer({ port: 0 });
  let gotUrl = "";
  let gotAuth = "";
  wss.on("connection", (ws: WebSocket, req) => {
    gotUrl = req.url ?? "";
    gotAuth = String(req.headers.authorization ?? "");
    ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (e.type === "session.update") {
        handlers.onSession?.(e.session as Record<string, unknown>);
        ws.send(JSON.stringify({ type: "session.created" }));
        ws.send(JSON.stringify({ type: "session.updated", session: e.session }));
      } else if (e.type === "conversation.item.create") {
        handlers.items.push(e.item as Record<string, unknown>);
        ws.send(JSON.stringify({ type: "conversation.item.created", item: e.item }));
      } else if (e.type === "response.create") {
        ws.send(JSON.stringify({ type: "response.created", response: { id: "resp-1", status: "in_progress" } }));
        ws.send(JSON.stringify({ type: "response.text.delta", response_id: "resp-1", delta: "部分" }));
        ws.send(JSON.stringify({ type: "response.done", response: { id: "resp-1", status: "completed", output: handlers.output } }));
      }
    });
  });
  return { wss, url: () => `ws://127.0.0.1:${(wss.address() as { port: number }).port}/api-ws/v1/realtime`, got: () => ({ gotUrl, gotAuth }) };
}

describe("createRealtimeProvider(api-ws beta 方言)", () => {
  it("https 端点推导 wss api-ws URL(mock 连接验证鉴权与 session 形态)", async () => {
    // 纯函数断言:URL 推导规则
    expect(realtimeUrl("https://llm-x.cn-beijing.maas.aliyuncs.com/compatible-mode", "m1")).toBe(
      "wss://llm-x.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=m1");
    expect(realtimeUrl("wss://h/api-ws/v1/realtime", "m2")).toBe("wss://h/api-ws/v1/realtime?model=m2");
    const items: Record<string, unknown>[] = [];
    let session: Record<string, unknown> | undefined;
    const srv = mockRealtimeServer({ onSession: (s) => (session = s), items, output: [{ type: "message", content: [{ type: "text", text: "你好" }] }] });
    const p = createRealtimeProvider({ baseUrl: srv.url(), model: "qwen-audio-3.1-realtime-plus", apiKey: "k1", timeoutMs: 5000 });
    const r = await p.chat([{ role: "system", content: "SYS" }, { role: "user", content: "hi" }], []);
    expect(r.content).toBe("你好");
    expect(r.toolCalls).toBeUndefined();
    expect(srv.got().gotUrl).toContain("/api-ws/v1/realtime?model=qwen-audio-3.1-realtime-plus");
    expect(srv.got().gotAuth).toBe("Bearer k1");
    expect(session).toMatchObject({ modalities: ["text"], turn_detection: null, instructions: "SYS" });
    expect(items).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    srv.wss.close();
  });

  it("工具定义进 session.tools;function_call 输出映射 toolCalls;历史回放含 function_call/output", async () => {
    const items: Record<string, unknown>[] = [];
    let session: Record<string, unknown> | undefined;
    const srv = mockRealtimeServer({ onSession: (s) => (session = s), items, output: [{ type: "function_call", call_id: "call_x", name: "get_time", arguments: "{}" }] });
    const r2 = await (async () => {
      const provider = createRealtimeProvider({ baseUrl: srv.url(), model: "m", apiKey: "k", timeoutMs: 5000 });
      return provider.chat(
        [
          { role: "user", content: "几点了" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_time", arguments: "{}" }] },
          { role: "tool", toolCallId: "c1", content: "12:00" },
        ],
        [{ name: "get_time", description: "time", parameters: { type: "object", properties: {} } }],
      );
    })();
    expect(r2.toolCalls).toEqual([{ id: "call_x", name: "get_time", arguments: "{}" }]);
    // 回放序列:user → function_call → function_call_output(system 无)
    expect(items.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output"]);
    expect((session as { tools?: unknown[] }).tools).toHaveLength(1);
    srv.wss.close();
  });

  it("服务端 error 事件 → reject;response.status != completed → reject", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const e = JSON.parse(raw.toString());
        if (e.type === "session.update") ws.send(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad key" } }));
      });
    });
    const p = createRealtimeProvider({ baseUrl: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/x`, model: "m", apiKey: "k", timeoutMs: 4000 });
    await expect(p.chat([{ role: "user", content: "x" }], [])).rejects.toThrow(/bad key/);
    wss.close();
  });

  it("DashScope 扁平错误信封(无 type 的 {code,message})→ fail-fast reject,不干等超时", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const e = JSON.parse(raw.toString());
        if (e.type === "session.update") ws.send(JSON.stringify({ code: "InvalidParameter", message: "url error, please check url！", request_id: "r1" }));
      });
    });
    const t0 = Date.now();
    const p = createRealtimeProvider({ baseUrl: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/x`, model: "非realtime模型", apiKey: "k", timeoutMs: 10_000 });
    await expect(p.chat([{ role: "user", content: "x" }], [])).rejects.toThrow(/url error.*InvalidParameter/s);
    expect(Date.now() - t0).toBeLessThan(5000); // 立即失败而非挂满 10s
    wss.close();
  });

  it("update() 热切模型(经 mock 断言新 model 进握手 URL)", async () => {
    const srv = mockRealtimeServer({ items: [], output: [{ type: "message", content: [{ type: "text", text: "ok" }] }] });
    const p = createRealtimeProvider({ baseUrl: srv.url(), model: "a", apiKey: "k", timeoutMs: 5000 });
    (p as { update: (o: Partial<{ model: string }>) => void }).update({ model: "b" });
    const r = await p.chat([{ role: "user", content: "x" }], []);
    expect(r.content).toBe("ok");
    expect(srv.got().gotUrl).toContain("model=b");
    srv.wss.close();
  });
});

describe("createRealtimeProvider 流式旁路", () => {
  it("response.text.delta 经 onDelta 透出;聚合结果以 response.done 为准", async () => {
    const srv = mockRealtimeServer({ items: [], output: [{ type: "message", content: [{ type: "text", text: "部分完成" }] }] });
    const p = createRealtimeProvider({ baseUrl: srv.url(), model: "m", apiKey: "k", timeoutMs: 5000 });
    const got: string[] = [];
    const r = await p.chat([{ role: "user", content: "hi" }], [], undefined, (d) => { if (d.text) got.push(d.text); });
    expect(r.content).toBe("部分完成");
    expect(got).toEqual(["部分"]);
    srv.wss.close();
  });
});

describe("createRealtimeProvider text+audio 直出(2026-10-21 realtime-plus 形态)", () => {
  /** mock 百炼 audio-out 服务端:capture session/response.create;发 transcript+audio delta+done(文字面空)。 */
  function mockAudioRealtimeServer() {
    const wss = new WebSocketServer({ port: 0 });
    const got = { session: {} as Record<string, unknown>, responseCreate: [] as Record<string, unknown>[], items: [] as Record<string, unknown>[] };
    const pcm = Buffer.from("pcm16data24k");
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw) => {
        const e = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (e.type === "session.update") {
          got.session = e.session as Record<string, unknown>;
          ws.send(JSON.stringify({ type: "session.updated", session: e.session }));
        } else if (e.type === "conversation.item.create") {
          got.items.push(e.item as Record<string, unknown>);
          ws.send(JSON.stringify({ type: "conversation.item.created", item: e.item }));
        } else if (e.type === "response.create") {
          got.responseCreate.push(e as Record<string, unknown>);
          // 百炼 pre-rename 口径:audio_transcript.delta(文字面)+ audio.delta(b64 pcm 分片)
          ws.send(JSON.stringify({ type: "response.audio_transcript.delta", delta: "你" }));
          ws.send(JSON.stringify({ type: "response.audio_transcript.delta", delta: "好" }));
          ws.send(JSON.stringify({ type: "response.audio.delta", delta: pcm.subarray(0, 4).toString("base64") }));
          ws.send(JSON.stringify({ type: "response.audio.delta", delta: pcm.subarray(4).toString("base64") }));
          ws.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [{ type: "message", content: [{ type: "audio" }] }] } }));
        }
      });
    });
    return { wss, got, url: () => `ws://127.0.0.1:${(wss.address() as { port: number }).port}/api-ws/v1/realtime`, pcm };
  }

  it("audioOut:session modalities text+audio+音色+音频格式;语音直入 input_audio 项;回复聚合 text+audio(WAV)", async () => {
    const srv = mockAudioRealtimeServer();
    const p = createRealtimeProvider({ baseUrl: srv.url(), model: "qwen-audio-3.1-realtime-plus", apiKey: "k", timeoutMs: 5000, audioOut: true, voice: "longanlingxin" });
    const got: string[] = [];
    const r = await p.chat(
      [{ role: "user", content: "(语音输入)", audio: { data: "cGNtMTZpbnB1dA==", format: "pcm16" } }],
      [],
      undefined,
      (d) => { if (d.text) got.push(d.text); },
    );
    // session:text+audio + voice + 百炼字符串音频格式(输入 pcm16 在场声明,输出 pcm)
    expect(srv.got.session).toMatchObject({ modalities: ["text", "audio"], voice: "longanlingxin", input_audio_format: "pcm16", output_audio_format: "pcm", turn_detection: null });
 // response.create 不带 modalities(继承 session;参考实现同款)
    expect(srv.got.responseCreate[0]!.response).toBeUndefined();
    // 语音直入:input_audio 内容件(voice.speak 转写会话同款形态),占位文本不掺和
    expect(srv.got.items).toEqual([{ type: "message", role: "user", content: [{ type: "input_audio", audio: "cGNtMTZpbnB1dA==" }] }]);
    // 文字面:done 输出无 text → 口述转写兜底;流式透出转写增量
    expect(r.content).toBe("你好");
    expect(got).toEqual(["你", "好"]);
    // 音频:delta 聚合 + WAV 容器(浏览器可直接播)
    expect(r.audio?.mime).toBe("audio/wav");
    const wav = Buffer.from(r.audio!.base64, "base64");
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(44)).toEqual(srv.pcm);
    srv.wss.close();
  });

  it("纯文本路径(无 audioOut/无音频入)字节级维持现状:session 无音频格式字段,response.create 显式 modalities text", async () => {
    const items: Record<string, unknown>[] = [];
    let session: Record<string, unknown> | undefined;
    let responseCreate: Record<string, unknown> | undefined;
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw) => {
        const e = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (e.type === "session.update") {
          session = e.session as Record<string, unknown>;
          ws.send(JSON.stringify({ type: "session.updated", session: e.session }));
        } else if (e.type === "conversation.item.create") {
          items.push(e.item as Record<string, unknown>);
          ws.send(JSON.stringify({ type: "conversation.item.created", item: e.item }));
        } else if (e.type === "response.create") {
          responseCreate = e;
          ws.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [{ type: "message", content: [{ type: "text", text: "ok" }] }] } }));
        }
      });
    });
    const p = createRealtimeProvider({ baseUrl: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/api-ws/v1/realtime`, model: "m", apiKey: "k", timeoutMs: 5000 });
    const r = await p.chat([{ role: "user", content: "hi" }], []);
    expect(r.content).toBe("ok");
    expect(r.audio).toBeUndefined();
    expect(session).toMatchObject({ modalities: ["text"], turn_detection: null });
    expect(Object.keys(session ?? {})).not.toContain("input_audio_format");
    expect(Object.keys(session ?? {})).not.toContain("output_audio_format");
    expect((responseCreate as { response?: { modalities?: string[] } }).response?.modalities).toEqual(["text"]);
    expect(items).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    wss.close();
  });
});
