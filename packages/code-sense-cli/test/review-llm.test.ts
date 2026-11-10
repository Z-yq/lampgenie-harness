/**
 * review-llm 凭证链单测:resolveReviewLlm 四档(flag/env/config/ask-file/none)、
 * 部分凭证 fail-visible(LlmConfigError)、ask-file 中继的 ReviewLlm 契约形
 * (协议面=llm-config.makeAskFileLlm,该面单测在 llm-config.test.ts,此处只锚 chat 契约与清理)。
 * 全部注入 env/configFile,不打真网络、不读真实 ~/.codesense。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReviewLlm, makeAskFileReviewLlm } from "../src/review-llm.js";
import { LlmConfigError } from "../src/llm-config.js";

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gh-reviewllm-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ENV3 = { GENIE_LLM_BASE_URL: "http://env.example", GENIE_LLM_MODEL: "env-model", GENIE_LLM_API_KEY: "sk-env" } as NodeJS.ProcessEnv;

describe("resolveReviewLlm:凭证链 flag > env > config > ask-file", () => {
  it("flag 档:三件套齐 → source=flag(压过 env)", () => {
    const r = resolveReviewLlm({
      flags: { baseURL: "http://flag.example", model: "flag-model", apiKey: "sk-flag" },
      env: ENV3,
      configFile: null,
    });
    expect(r?.source).toBe("flag");
  });

  it("env 档:无 flag 时 env 三件套 → source=env", () => {
    const r = resolveReviewLlm({ env: ENV3, configFile: null });
    expect(r?.source).toBe("env");
  });

  it("config 档:配置文件三件套 → source=config", () => {
    const r = resolveReviewLlm({ env: {}, configFile: { llm: { baseURL: "http://cfg.example", model: "cfg-model", apiKey: "sk-cfg" } } });
    expect(r?.source).toBe("config");
  });

  it("ask-file 档:配置只含 askFile.dir → source=ask-file 且 llm 在场", () => {
    const r = resolveReviewLlm({ env: {}, configFile: { llm: { askFile: { dir: "/tmp/ask" } } } });
    expect(r?.source).toBe("ask-file");
    expect(typeof r?.llm.chat).toBe("function");
  });

  it("无任何形态 → null(调用方 fail-visible exit 2)", () => {
    expect(resolveReviewLlm({ env: {}, configFile: null })).toBeNull();
  });

  it("部分凭证 fail-visible:env 缺 key / flag 缺件 / config 缺件 → LlmConfigError", () => {
    expect(() => resolveReviewLlm({ env: { GENIE_LLM_BASE_URL: "http://x", GENIE_LLM_MODEL: "m" }, configFile: null })).toThrow(LlmConfigError);
    expect(() => resolveReviewLlm({ flags: { baseURL: "http://x" }, env: {}, configFile: null })).toThrow(LlmConfigError);
    expect(() => resolveReviewLlm({ env: {}, configFile: { llm: { baseURL: "http://x", model: "m" } } })).toThrow(LlmConfigError);
  });
});

describe("makeAskFileReviewLlm:ReviewLlm 契约形(复用 llm-config ask-file 协议)", () => {
  it("chat:写 ask → 宿主答 answer → 返回 {content} 并清理两文件", async () => {
    const { dir, cleanup } = tmp();
    try {
      const llm = makeAskFileReviewLlm(dir, { timeoutMs: 5000, pollMs: 20, idFactory: () => "rv1" });
      const p = llm.chat("评审 prompt 文本");
      for (let i = 0; i < 100 && !existsSync(join(dir, "ask-rv1.json")); i++) await new Promise((r) => setTimeout(r, 10));
      const ask = JSON.parse(readFileSync(join(dir, "ask-rv1.json"), "utf-8")) as { id: string; prompt: string };
      expect(ask.id).toBe("rv1");
      expect(ask.prompt).toContain("评审 prompt 文本");
      writeFileSync(join(dir, "answer-rv1.json"), JSON.stringify({ answer: '{"findings":[],"summary":"ok"}' }));
      const r = await p;
      expect(r.content).toBe('{"findings":[],"summary":"ok"}');
      expect(existsSync(join(dir, "ask-rv1.json"))).toBe(false);
      expect(existsSync(join(dir, "answer-rv1.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("超时=撤题+抛错(不留 ask 文件)", async () => {
    const { dir, cleanup } = tmp();
    try {
      const llm = makeAskFileReviewLlm(dir, { timeoutMs: 200, pollMs: 20, idFactory: () => "rv2" });
      await expect(llm.chat("x")).rejects.toThrow(/超时/);
      expect(existsSync(join(dir, "ask-rv2.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
