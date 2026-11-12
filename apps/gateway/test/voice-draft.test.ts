import { describe, it, expect, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { buildVoiceDraftPrompt, createVoiceDrafter, VOICE_DRAFT_TIMEOUT_MS } from "../src/voice-draft.js";
import { parseAudioDataUrl } from "../src/annotate-voice.js";
import { parseClientMessage, ServerMessage } from "@lampgenie/protocol";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

/** 聊天窗语音任务书契约回归。
 * 锁四件事:①撰写提示词(项目语境/已有草稿并入/纪律行);②撰写器请求形态
 * (input_audio base64+format、Bearer、超时口径)与返回体抽取;③协议双向可解析;
 * ④真实 WS 全链:未配置=指路报错;配置了 coding.models.voice + mock fetch=任务书回填。
 * 面板 UI 面在 panel.ts 模板字符串内,同文件锁结构性锚点(按钮/锁/回填/角色卡)。 */

const HERE = dirname(fileURLToPath(import.meta.url));
import { PANEL_SRC } from "./panel-source.js";

/** 手工构造最小 webm dataURL(仅形态校验,服务端不碰音频字节)。 */
function webmDataUrl(bytes = "opus-bytes"): string {
  return "data:audio/webm;codecs=opus;base64," + Buffer.from(bytes).toString("base64");
}

describe("撰写提示词", () => {
  it("带项目语境与已有草稿;草稿用显式包裹标记", () => {
    const p = buildVoiceDraftPrompt({ projectName: "lampgenie-harness", draftText: "修一下登录" });
    expect(p).toContain("lampgenie-harness");
    expect(p).toContain("【已有文字开始】");
    expect(p).toContain("修一下登录");
    expect(p).toContain("待确认");
  });
  it("无项目/无草稿:不硬造语境", () => {
    const p = buildVoiceDraftPrompt({});
    expect(p).not.toContain("【已有文字开始】");
    expect(p).not.toContain("任务所属项目");
    expect(p).toContain("目标");
    expect(p).toContain("验收标准");
  });
});

describe("createVoiceDrafter", () => {
  const OK_OPTS = { baseUrl: "https://maas.example/v1", model: "qwen3.8-omni-flash", apiKey: "k-1" };
  const audio = parseAudioDataUrl(webmDataUrl());

  it("请求形态:input_audio(base64+format)+Bearer;返回 choices 文本", async () => {
    let seen: { url: string; body: Record<string, unknown>; auth: string | undefined } | null = null;
    const drafter = createVoiceDrafter({ ...OK_OPTS, fetchImpl: (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)), auth: init?.headers?.authorization };
      return new Response(JSON.stringify({ choices: [{ message: { content: "一、目标\n做完它" } }] }), { status: 200 });
    }) as typeof fetch });
    const text = await drafter(audio, { projectName: "demo" });
    expect(text).toBe("一、目标\n做完它");
    expect(seen!.url).toBe("https://maas.example/v1/chat/completions");
    expect(seen!.auth).toBe("Bearer k-1");
    const msg = (seen!.body.messages as { content: { type: string }[] }[])[0];
    expect(seen!.body.model).toBe("qwen3.8-omni-flash");
    expect(msg.content.some((c) => c.type === "input_audio")).toBe(true);
    const ia = msg.content.find((c) => c.type === "input_audio") as { input_audio: { data: string; format: string } };
    expect(ia.input_audio.format).toBe("webm");
 // DashScope qwen-omni 系要 Data URI 形态(裸 base64 经验证 400 URL not valid)
    expect(ia.input_audio.data.startsWith("data:;base64,")).toBe(true);
  });
  it("返回体对象/分段数组形态可抽取;```markdown 围栏剥掉", async () => {
    const drafter = createVoiceDrafter({ ...OK_OPTS, fetchImpl: (async () =>
      new Response(JSON.stringify({ content: { text: "```markdown\n# 任务书\n```" } }), { status: 200 })) as typeof fetch });
    expect(await drafter(audio, {})).toBe("# 任务书");
  });
  it("HTTP 错/空内容/非 JSON:抛可读错", async () => {
    const boom = createVoiceDrafter({ ...OK_OPTS, fetchImpl: (async () => new Response("upstream down", { status: 500 })) as typeof fetch });
    await expect(boom(audio, {})).rejects.toThrow(/HTTP 500/);
    const empty = createVoiceDrafter({ ...OK_OPTS, fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })) as typeof fetch });
    await expect(empty(audio, {})).rejects.toThrow(/返回为空/);
    const junk = createVoiceDrafter({ ...OK_OPTS, fetchImpl: (async () => new Response("<html>nope</html>", { status: 200 })) as typeof fetch });
    await expect(junk(audio, {})).rejects.toThrow(/JSON/);
  });
  it("缺凭证/缺端点/缺模型:构造期即报错", () => {
    expect(() => createVoiceDrafter({ ...OK_OPTS, apiKey: "" })).toThrow(/API Key/);
    expect(() => createVoiceDrafter({ ...OK_OPTS, baseUrl: "" })).toThrow(/端点/);
    expect(() => createVoiceDrafter({ ...OK_OPTS, model: "" })).toThrow(/模型/);
    expect(VOICE_DRAFT_TIMEOUT_MS).toBe(120_000);
  });
});

describe("协议双向", () => {
  it("voice.draft / voice.draft.result 进客户端/服务端消息联合", () => {
    const draft = { v: 1, type: "voice.draft", sessionId: "s1", audioUrl: webmDataUrl(), draftText: "草稿" };
    expect(parseClientMessage(JSON.stringify(draft))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...draft, audioUrl: "data:image/png;base64,AAAA" }))).toBeNull(); // 非 audio dataURL 拒
    const parsed = ServerMessage.parse({ v: 1, type: "voice.draft.result", sessionId: "s1", ok: true, text: "任务书" });
    expect(parsed.ok).toBe(true);
  });
});

describe("面板锚点(panel.ts 源码面)", () => {
  it("🎤按钮/录音态/撰写锁/回填链都在场", () => {
    expect(PANEL_SRC).toContain('id="voiceBtn"');
    expect(PANEL_SRC).toContain('type: "voice.draft"');
    expect(PANEL_SRC).toContain('voiceDraftBySid.set(lockKey, true)');
    expect(PANEL_SRC).toContain('el.readOnly = locked');
    expect(PANEL_SRC).toContain("任务书撰写中,请稍候…(完成后自动填入,期间本会话不能输入)");
    expect(PANEL_SRC).toContain("voiceStashApply(); // 语音任务书:切回会话时把暂存的撰写结果填入输入框");
    // 撰写锁守卫在 submit() 顶部(Enter/发送/命令全走这里)
    expect(PANEL_SRC).toMatch(/function submit\(overrideText, projectOverride\) \{\n[^\n]*\n[^\n]*voiceLocked\(currentSid\)/);
    // 录音上限与大小上限(与截图标注录音同口径)
    expect(PANEL_SRC).toContain("const VOICE_REC_MAX_MS = 120 * 1000;");
    expect(PANEL_SRC).toContain("const VOICE_MAX_BYTES = 8 * 1024 * 1024;");
  });
  it("撰写锁的可达性判据/兜底闹钟/跨会话草稿归位都在场(2026-11-10 体验修复)", () => {
    const finish = PANEL_SRC.slice(PANEL_SRC.indexOf("reader.onload = function () {"), PANEL_SRC.indexOf("reader.onload = function () {") + 3000);
    expect(finish).toContain("跨会话草稿归位");
    expect(finish).toContain('localStorage.getItem("zh:draft:" + (R.sid || "__new__"))'); // 停止时人在别会话:取录音所属会话自己的草稿
    expect(finish).toContain("deliverable"); // 发送前判可达(closing 态不发不锁)
    expect(finish).toContain("voiceDraftTimer = setTimeout"); // 180s 兜底闹钟(回执丢失解锁,防永久锁死)
    expect(finish).toContain("任务书撰写无回执(连接中断或超时),已解锁;可重新录音");
    // 回执到达摘闹钟
    const result = PANEL_SRC.slice(PANEL_SRC.indexOf("function voiceDraftResult(m) {"), PANEL_SRC.indexOf("function voiceDraftResult(m) {") + 400);
    expect(result).toContain("clearTimeout(voiceDraftTimer)");
  });
  it("「各角色模型」含语音任务书卡(未配置=功能不可用口径)", () => {
    expect(PANEL_SRC).toContain('id="role-voice"');
    expect(PANEL_SRC).toContain("(未配置=语音任务书不可用)");
    expect(PANEL_SRC).toContain('{ id: "role-voice", key: "voice"');
    expect(PANEL_SRC).toContain('["coding.models.voice"');
  });
  it("语音任务书下拉只列 omni(不分大小写):无 omni 提示项 + 非 omni 当前值保底项", () => {
    // renderRoleSelects 里 key=voice 的 omni 过滤特例(共用函数只对 voice 生效)
    expect(PANEL_SRC).toContain('const omniOnly = def.key === "voice";');
    expect(PANEL_SRC).toContain('entries.filter((e) => /omni/i.test(String(e.name || "")))');
    expect(PANEL_SRC).toContain("(目录中无 omni 模型)");
    expect(PANEL_SRC).toContain("(当前值,非 omni,请更换)");
    // 过滤必须只在 voice 分支:全量目录(entries)不能整体被 omni 过滤
    expect(PANEL_SRC).not.toContain("const entries = modelCatalogEntries().filter(");
    // 其余五个角色照旧存在且不参与 omniOnly 判定
    for (const k of ["main", "subagent", "compact", "digest", "review"]) {
      expect(PANEL_SRC).toContain('key: "' + k + '"');
    }
    expect(PANEL_SRC).toContain("const pool = omniOnly ?");
  });
});

describe("真实 WS 全链(voice.draft)", () => {
  const WS_ROOT = mkdtempSync(join(tmpdir(), "voice-draft-"));
  const PORT = 7975;
  const OLD_ROOT = process.env.GENIE_REPO_ROOT;
  const apps: GatewayApp[] = [];

  beforeEach(() => {
    process.env.GENIE_REPO_ROOT = WS_ROOT;
    process.env.GENIE_TEST_VOICE_KEY = "sk-test-voice";
    mkdirSync(join(WS_ROOT, "demo"), { recursive: true });
  });
  afterAll(async () => {
    if (OLD_ROOT === undefined) delete process.env.GENIE_REPO_ROOT;
    else process.env.GENIE_REPO_ROOT = OLD_ROOT;
    delete process.env.GENIE_TEST_VOICE_KEY;
    for (const a of apps) { try { await a.close(); } catch { /* 已停 */ } }
    try { rmSync(WS_ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  });

  async function connect(port = PORT): Promise<{ ws: WebSocket; wait: (pred: (m: Record<string, unknown>) => boolean, label: string, timeout?: number) => Promise<Record<string, unknown>>; inbox: Record<string, unknown>[] }> {
    const ws = new WebSocket("ws://127.0.0.1:" + port);
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    const wait = async (pred: (m: Record<string, unknown>) => boolean, label: string, timeout = 15000): Promise<Record<string, unknown>> => {
      const start = Date.now();
      for (;;) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        if (Date.now() - start > timeout) throw new Error("等待超时: " + label + " · inbox=" + JSON.stringify(inbox).slice(0, 900));
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    return { ws, wait, inbox };
  }

  it("未配置 coding.models.voice:ok=false + 指路模型设置", async () => {
    apps.push(createGatewayApp({ port: PORT, executor: new EchoChildBackend(), journalDir: join(WS_ROOT, ".genie", "journals") }));
    const { ws, wait } = await connect();
    ws.send(JSON.stringify({ v: 1, type: "voice.draft", sessionId: "v-s1", audioUrl: webmDataUrl() }));
    const result = await wait((m) => m.type === "voice.draft.result", "voice.draft.result(not-configured)");
    expect(result.ok).toBe(false);
    expect(String(result.message)).toContain("模型设置");
    expect(String(result.message)).toContain("语音任务书模型");
    ws.close();
  }, 40000);

  it("配置角色模型 + mock fetch:任务书文本回传;journal 落 voice.draft 审计", async () => {
    const calls: { url: string; auth: string | undefined; model?: string }[] = [];
    apps.push(createGatewayApp({
      port: PORT + 1,
      executor: new EchoChildBackend(),
      journalDir: join(WS_ROOT, ".genie", "journals"),
      voiceDraftFetch: (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        calls.push({ url: String(url), auth: init?.headers?.authorization, model: (JSON.parse(String(init?.body)) as { model?: string }).model });
        return new Response(JSON.stringify({ choices: [{ message: { content: "一、目标\n按口述修好登录" } }] }), { status: 200 });
      }) as typeof fetch,
      config: {
        providers: [{ id: "maas", name: "MAAS", baseUrl: "https://maas.example/v1", apiKeyEnv: "GENIE_TEST_VOICE_KEY", models: ["qwen3.8-omni-flash"] }],
        coding: { models: { voice: { model: "qwen3.8-omni-flash" } } },
      },
    }));
    const { ws, wait } = await connect(PORT + 1); // 本用例的 app 建在 PORT+1(第一个 app 占着 PORT)
    ws.send(JSON.stringify({ v: 1, type: "voice.draft", sessionId: "v-s2", audioUrl: webmDataUrl("hello-audio"), draftText: "登录页有 bug" }));
    const result = await wait((m) => m.type === "voice.draft.result" && m.sessionId === "v-s2", "voice.draft.result(ok)");
    expect(result.ok, JSON.stringify(result).slice(0, 500)).toBe(true);
    expect(result.text).toBe("一、目标\n按口述修好登录");
    expect(calls.length).toBe(1);
    expect(calls[0].auth).toBe("Bearer sk-test-voice");
    expect(calls[0].model).toBe("qwen3.8-omni-flash");
    // 审计:journal custom 条目(分片布局,递归扫)
    const journalDir = join(WS_ROOT, ".genie", "journals");
    const found = fs.readdirSync(journalDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .some((e) => readFileSync(join(e.parentPath ?? journalDir, e.name), "utf8").includes('"type":"voice.draft"'));
    expect(found).toBe(true);
    ws.close();
  }, 40000);

  it("非 omni 模型(配置被手工写成 qwen3.7-flash):ok=false + 指路 omni,上游零调用", async () => {
    const calls: string[] = [];
    apps.push(createGatewayApp({
      port: PORT + 2,
      executor: new EchoChildBackend(),
      journalDir: join(WS_ROOT, ".genie", "journals"),
      voiceDraftFetch: (async (url: unknown) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ choices: [{ message: { content: "不该到这里" } }] }), { status: 200 });
      }) as typeof fetch,
      config: {
        providers: [{ id: "maas", name: "MAAS", baseUrl: "https://maas.example/v1", apiKeyEnv: "GENIE_TEST_VOICE_KEY", models: ["qwen3.7-flash", "qwen3.8-omni-flash"] }],
        coding: { models: { voice: { model: "qwen3.7-flash" } } },
      },
    }));
    const { ws, wait } = await connect(PORT + 2);
    ws.send(JSON.stringify({ v: 1, type: "voice.draft", sessionId: "v-s3", audioUrl: webmDataUrl() }));
    const result = await wait((m) => m.type === "voice.draft.result" && m.sessionId === "v-s3", "voice.draft.result(non-omni)");
    expect(result.ok, JSON.stringify(result).slice(0, 500)).toBe(false);
    expect(String(result.message)).toContain("omni");
    expect(String(result.message)).toContain("语音任务书模型");
    expect(calls.length).toBe(0); // 非 omni 不许发上游
    ws.close();
  }, 40000);
});
