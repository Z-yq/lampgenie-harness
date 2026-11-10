/**
 * llm-config 单测(step-089 P2 / designs/26 §3):
 * 解析链四档(flag>env>config>none)、部分凭证 fail-visible、maskKey 脱敏、
 * config 文件写入权限 600 与 merge/unset、ask-file 中继协议(应答/超时/坏答案)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfigFile, writeConfigFile, setConfigKey, unsetConfigKey, maskKey,
  resolveLlmConfig, requireSenseLlm, makeAskFileLlm, LlmConfigError,
} from "../src/llm-config.js";

function tmpdir2(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gh-llmcfg-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("凭证解析链(flag > env > config > none)", () => {
  it("flag 三件套齐=直接用;部分缺=抛", () => {
    const r = resolveLlmConfig({ flags: { baseURL: "http://a", model: "m", apiKey: "k" } });
    expect(r).toEqual({ kind: "direct", cfg: { baseURL: "http://a", model: "m", apiKey: "k" }, source: "flag" });
    expect(() => resolveLlmConfig({ flags: { baseURL: "http://a" } })).toThrow(LlmConfigError);
  });

  it("env 全缺=null;部分缺=抛(与 reviewLlmFromEnv 同语义);齐=direct(env)", () => {
    expect(resolveLlmConfig({ env: {} })).toBeNull();
    expect(() => resolveLlmConfig({ env: { GENIE_LLM_BASE_URL: "http://a", GENIE_LLM_MODEL: "m" } })).toThrow(LlmConfigError);
    const r = resolveLlmConfig({ env: { GENIE_LLM_BASE_URL: "http://a", GENIE_LLM_MODEL: "m", GENIE_LLM_API_KEY: "k" } });
    expect(r?.kind).toBe("direct");
    expect(r?.source).toBe("env");
  });

  it("config 文件齐=direct(config);缺一=抛(带补救指引);只有 askFile=中继档", () => {
    const full = { llm: { baseURL: "http://a", model: "m", apiKey: "k" } };
    expect(resolveLlmConfig({ env: {}, configFile: full })).toEqual({ kind: "direct", cfg: full.llm, source: "config" });
    expect(() => resolveLlmConfig({ env: {}, configFile: { llm: { baseURL: "http://a" } } })).toThrow(/llm\.model/);
    const relay = resolveLlmConfig({ env: {}, configFile: { llm: { askFile: { dir: "/tmp/ask" } } } });
    expect(relay).toEqual({ kind: "ask-file", dir: "/tmp/ask" });
    expect(resolveLlmConfig({ env: {}, configFile: null })).toBeNull();
  });

  it("优先级:env 压过 config,flag 压过 env", () => {
    const env = { GENIE_LLM_BASE_URL: "http://env", GENIE_LLM_MODEL: "m-env", GENIE_LLM_API_KEY: "k-env" };
    const cfg = { llm: { baseURL: "http://cfg", model: "m-cfg", apiKey: "k-cfg" } };
    expect(resolveLlmConfig({ env, configFile: cfg })?.source).toBe("env");
    const flags = { baseURL: "http://flag", model: "m-flag", apiKey: "k-flag" };
    expect(resolveLlmConfig({ flags, env, configFile: cfg })?.source).toBe("flag");
  });

  it("requireSenseLlm:无凭证=抛(fail-visible);ask-file 档返回中继适配器", () => {
    expect(() => requireSenseLlm({ env: {}, configFile: null })).toThrow(LlmConfigError);
    const llm = requireSenseLlm({ env: {}, configFile: { llm: { askFile: { dir: "/tmp/x" } } } });
    expect(typeof llm.generate).toBe("function");
  });
});

describe("maskKey(凭证红线:任何输出只出脱敏形态)", () => {
  it("空/短/长 key 三形态", () => {
    expect(maskKey(undefined)).toBe("(未设置)");
    expect(maskKey("")).toBe("(未设置)");
    expect(maskKey("abc")).toBe("****");
    expect(maskKey("sk-abcdef123456")).toBe("****3456");
    expect(maskKey("sk-abcdef123456")).not.toContain("abcdef");
  });
});

describe("config 文件(权限 600 + merge/unset)", () => {
  it("set 写入权限 600,保留其它顶层键;get 形态经 readConfigFile", () => {
    const { dir, cleanup } = tmpdir2();
    try {
      const path = join(dir, "config.json");
      writeConfigFile({ custom: { keep: 1 } }, path);
      setConfigKey("llm.baseURL", "http://a", path);
      setConfigKey("llm.apiKey", "sk-secret-value-777", path);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
      const cfg = readConfigFile(path);
      expect(cfg?.custom).toEqual({ keep: 1 });
      expect(cfg?.llm?.baseURL).toBe("http://a");
      expect(cfg?.llm?.apiKey).toBe("sk-secret-value-777");
      // 文件内容不含脱敏痕迹(真实值落盘,输出层才脱敏)
      expect(readFileSync(path, "utf-8")).toContain("sk-secret-value-777");
    } finally {
      cleanup();
    }
  });

  it("unset 删除已设键;未设=如实 false;未知键=抛", () => {
    const { dir, cleanup } = tmpdir2();
    try {
      const path = join(dir, "config.json");
      setConfigKey("llm.model", "m", path);
      expect(unsetConfigKey("llm.model", path)).toBe(true);
      expect(unsetConfigKey("llm.model", path)).toBe(false);
      expect(() => unsetConfigKey("llm.bogus", path)).toThrow(LlmConfigError);
      expect(existsSync(path)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("坏 JSON 配置文件=读取抛 LlmConfigError(不静默吞)", () => {
    const { dir, cleanup } = tmpdir2();
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "{ not json");
      expect(() => readConfigFile(path)).toThrow(LlmConfigError);
    } finally {
      cleanup();
    }
  });
});

describe("ask-file 中继协议(宿主零配置形态)", () => {
  it("写 ask-<id>.json → 宿主写 answer → 读到答案并清理两文件", async () => {
    const { dir, cleanup } = tmpdir2();
    try {
      const llm = makeAskFileLlm(dir, { timeoutMs: 5000, pollMs: 20, idFactory: () => "test1" });
      const genPromise = llm.generate('任务\n\n输出 JSON(schema: {"items":[]})。只输出 JSON。');
      // 轮询等 ask 文件出现
      let askFile = "";
      for (let i = 0; i < 100; i++) {
        const found = readdirSync(dir).find((f) => f.startsWith("ask-"));
        if (found) { askFile = found; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(askFile).toBe("ask-test1.json");
      const ask = JSON.parse(readFileSync(join(dir, askFile), "utf-8")) as { id: string; prompt: string; schemaHint?: string; timeoutSec: number };
      expect(ask.id).toBe("test1");
      expect(ask.prompt).toContain("任务");
      expect(ask.schemaHint).toContain("items");
      expect(ask.timeoutSec).toBe(5);
      // 宿主应答
      writeFileSync(join(dir, "answer-test1.json"), JSON.stringify({ answer: '{"items":[]}' }));
      const answer = await genPromise;
      expect(answer).toBe('{"items":[]}');
      // 两文件都被清理(不留陈旧占位)
      expect(existsSync(join(dir, "ask-test1.json"))).toBe(false);
      expect(existsSync(join(dir, "answer-test1.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("超时=撤题+抛错(不留 ask 文件)", async () => {
    const { dir, cleanup } = tmpdir2();
    try {
      const llm = makeAskFileLlm(dir, { timeoutMs: 200, pollMs: 20, idFactory: () => "t2" });
      await expect(llm.generate("x")).rejects.toThrow(/超时/);
      expect(existsSync(join(dir, "ask-t2.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("坏应答(缺 answer 字段)=抛错并清理", async () => {
    const { dir, cleanup } = tmpdir2();
    try {
      const llm = makeAskFileLlm(dir, { timeoutMs: 3000, pollMs: 20, idFactory: () => "t3" });
      const genPromise = llm.generate("x");
      for (let i = 0; i < 100; i++) {
        if (readdirSync(dir).some((f) => f.startsWith("ask-"))) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      writeFileSync(join(dir, "answer-t3.json"), JSON.stringify({ wrong: 1 }));
      await expect(genPromise).rejects.toThrow(/answer/);
      expect(existsSync(join(dir, "answer-t3.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
