import { describe, it, expect } from "vitest";
import { rewriteForSpeech, VoicePanel } from "../src/voice/panel";
import { InMemoryCredentialStore, resolveCredential } from "../src/voice/credentials";

describe("voice 骨架", () => {
  it("改写器:markdown/代码块→口语化→限长", () => {
    expect(rewriteForSpeech("**完成了** `x.ts`,```code block```")).toContain("代码已就绪");
    const long = rewriteForSpeech("很长的播报".repeat(20), 30);
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long).toContain("…");
  });
  it("面板状态机:silent 不出声;speaking 可打断", () => {
    const p = new VoicePanel();
    p.speak({ text: "x", level: "silent" });
    expect(p.state).toBe("idle"); // silent 不切
    p.speak({ text: "x", level: "brief" });
    expect(p.state).toBe("speaking");
    p.interrupt();
    expect(p.state).toBe("interrupted");
  });
  it("双轨凭证隔离:跨轨必报错", () => {
    const store = new InMemoryCredentialStore();
    store.set("persona", "persona.qwen", "sk-persona");
    store.set("coding", "coding.qwen", "sk-coding");
    expect(resolveCredential(store, "persona", "persona.qwen")).toBe("sk-persona");
    expect(() => resolveCredential(store, "coding", "persona.qwen")).toThrow(/轨道隔离/);
    expect(() => resolveCredential(store, "persona", "coding.qwen")).toThrow(/轨道隔离/);
  });
});
