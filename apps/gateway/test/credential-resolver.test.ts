import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_ORIGINS,
  ORIGIN_ALLOWED_ENV,
  cleanEnvForOrigin,
  credentialAuditLine,
  maskCredential,
  resolveCredential,
} from "../src/credential-resolver.js";

/** 夹具全部是 fake- 前缀假值,任何真实密钥都不得出现在测试里。 */
const FAKE_ENV_VALUE = "fake-env-value-123456";
const FAKE_SECRET_VALUE = "fake-secret-value-abcdef";
const FAKE_OPENAI = "fake-openai-key-9f8e7d6c";

const BASELINE: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/tester",
  USER: "tester",
  TMPDIR: "/tmp",
  TEMP: "/tmp",
  TMP: "/tmp",
  LANG: "zh_CN.UTF-8",
  LC_ALL: "zh_CN.UTF-8",
  LC_CTYPE: "zh_CN.UTF-8",
  SHELL: "/bin/bash",
  TERM: "xterm-256color",
  SYSTEMROOT: "C:\\Windows",
  WINDIR: "C:\\Windows",
  COMSPEC: "C:\\Windows\\system32\\cmd.exe",
  PATHEXT: ".COM;.EXE",
  APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
};

function mixedEnv(): Record<string, string> {
  return {
    ...BASELINE,
    OPENAI_API_KEY: FAKE_OPENAI,
    SECRET_TOKEN: FAKE_SECRET_VALUE,
    DB_PASSWORD: "fake-db-password-0001",
    GITHUB_TOKEN: "fake-github-token-0002",
    SSH_CREDENTIAL: "fake-ssh-credential-0003",
    AUTH_HEADER: "fake-auth-header-0004",
    SOME_RANDOM_VAR: "should-be-dropped",
  };
}

describe("CREDENTIAL_ORIGINS / ORIGIN_ALLOWED_ENV", () => {
  it("六个 origin 齐全且缺省清单为空(fail-closed)", () => {
    expect([...CREDENTIAL_ORIGINS]).toEqual(["llm", "mcp", "git", "npm", "task", "terminal"]);
    for (const origin of CREDENTIAL_ORIGINS) {
      expect(ORIGIN_ALLOWED_ENV[origin]).toEqual([]);
    }
  });
});

describe("cleanEnvForOrigin", () => {
  it("永远保留安全基线(跨平台全量)", () => {
    const out = cleanEnvForOrigin(mixedEnv(), "task");
    for (const name of Object.keys(BASELINE)) expect(out[name]).toBe(BASELINE[name]);
  });

  it("LC_ 前缀族保留", () => {
    const out = cleanEnvForOrigin({ LC_MESSAGES: "zh_CN", LC_NUMERIC: "C" }, "task");
    expect(out).toEqual({ LC_MESSAGES: "zh_CN", LC_NUMERIC: "C" });
  });

  it("默认删掉所有像凭证的变量", () => {
    const out = cleanEnvForOrigin(mixedEnv(), "task");
    for (const name of ["OPENAI_API_KEY", "SECRET_TOKEN", "DB_PASSWORD", "GITHUB_TOKEN", "SSH_CREDENTIAL", "AUTH_HEADER"]) {
      expect(out).not.toHaveProperty(name);
    }
  });

  it("非凭证普通变量照常保留(凭证面 fail-closed,不连坐工具链/代理)", () => {
    const out = cleanEnvForOrigin(mixedEnv(), "task");
    expect(out.SOME_RANDOM_VAR).toBe("should-be-dropped");
  });

  it("allowNames 只放行指定的那一个", () => {
    const out = cleanEnvForOrigin(mixedEnv(), "task", { allowNames: ["OPENAI_API_KEY"] });
    expect(out.OPENAI_API_KEY).toBe(FAKE_OPENAI);
    expect(out).not.toHaveProperty("SECRET_TOKEN");
    expect(out).not.toHaveProperty("DB_PASSWORD");
  });

  it("allowNamesByOrigin 按 origin 清单放行", () => {
    const out = cleanEnvForOrigin(mixedEnv(), "task", { allowNamesByOrigin: { task: ["GITHUB_TOKEN"] } });
    expect(out.GITHUB_TOKEN).toBe("fake-github-token-0002");
    expect(out).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("keepPrefixes 可豁免凭证类前缀(非凭证变量本就保留)", () => {
    const out = cleanEnvForOrigin(mixedEnv(), "task", { keepPrefixes: ["OPENAI_"] });
    expect(out.OPENAI_API_KEY).toBe(FAKE_OPENAI);
    expect(out).not.toHaveProperty("SECRET_TOKEN");
  });

  it("keepPrefixes 之外仍按名单删除;allowNames 优先于前缀", () => {
    const out = cleanEnvForOrigin(mixedEnv(), "task", { keepPrefixes: ["KEEP_ME_"], allowNames: ["DB_PASSWORD"] });
    expect(out.DB_PASSWORD).toBe("fake-db-password-0001");
    expect(out).not.toHaveProperty("OPENAI_API_KEY");
    expect(out).not.toHaveProperty("SECRET_TOKEN");
  });

  it("未知 origin 只留基线且不 throw", () => {
    const out = cleanEnvForOrigin(mixedEnv(), "bogus-origin");
    expect(out.PATH).toBe(BASELINE.PATH);
    expect(out).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("undefined 值 / 空入参安全跳过", () => {
    const out = cleanEnvForOrigin({ PATH: "/bin", BROKEN: undefined } as Record<string, string | undefined>, "task");
    expect(out).toEqual({ PATH: "/bin" });
    expect(cleanEnvForOrigin(null, "task")).toEqual({});
    expect(cleanEnvForOrigin(undefined, "task")).toEqual({});
  });

  it("不可变:不改入参,返回新对象", () => {
    const base = mixedEnv();
    const before = JSON.parse(JSON.stringify(base)) as Record<string, string>;
    const out = cleanEnvForOrigin(base, "task");
    expect(base).toEqual(before);
    expect(out).not.toBe(base);
  });

  it("确定性:同输入两次结果逐字相同", () => {
    const a = cleanEnvForOrigin(mixedEnv(), "task", { allowNames: ["OPENAI_API_KEY"] });
    const b = cleanEnvForOrigin(mixedEnv(), "task", { allowNames: ["OPENAI_API_KEY"] });
    expect(a).toEqual(b);
  });
});

describe("resolveCredential", () => {
  it("命中 env", () => {
    const r = resolveCredential("MY_KEY", "llm", { env: { MY_KEY: FAKE_ENV_VALUE } });
    expect(r).toEqual({ ok: true, envName: "MY_KEY", value: FAKE_ENV_VALUE, env: { MY_KEY: FAKE_ENV_VALUE } });
  });

  it("env 优先于 secrets", () => {
    const r = resolveCredential("MY_KEY", "llm", {
      env: { MY_KEY: FAKE_ENV_VALUE },
      secrets: { MY_KEY: FAKE_SECRET_VALUE },
    });
    expect(r.ok && r.value).toBe(FAKE_ENV_VALUE);
  });

  it("env 缺省时回退 secrets", () => {
    const r = resolveCredential("MY_KEY", "llm", { env: {}, secrets: { MY_KEY: FAKE_SECRET_VALUE } });
    expect(r.ok && r.value).toBe(FAKE_SECRET_VALUE);
  });

  it("空 ref → CREDENTIAL_DENIED", () => {
    expect(resolveCredential("", "llm", { env: { A: "1" } })).toEqual({ ok: false, code: "CREDENTIAL_DENIED" });
    expect(resolveCredential("   ", "llm", { env: { A: "1" } })).toEqual({ ok: false, code: "CREDENTIAL_DENIED" });
  });

  it("undefined / null ref → CREDENTIAL_DENIED", () => {
    expect(resolveCredential(undefined, "llm")).toEqual({ ok: false, code: "CREDENTIAL_DENIED" });
    expect(resolveCredential(null, "llm")).toEqual({ ok: false, code: "CREDENTIAL_DENIED" });
  });

  it("非法 ref 名(含 = 或空格)→ CREDENTIAL_DENIED", () => {
    expect(resolveCredential("A=B", "llm", { env: { "A=B": "x" } })).toEqual({ ok: false, code: "CREDENTIAL_DENIED" });
    expect(resolveCredential("A B", "llm", { env: { "A B": "x" } })).toEqual({ ok: false, code: "CREDENTIAL_DENIED" });
  });

  it("未知 origin → CREDENTIAL_DENIED", () => {
    expect(resolveCredential("A_KEY", "quantum", { env: { A_KEY: "x" } })).toEqual({ ok: false, code: "CREDENTIAL_DENIED" });
  });

  it("origin 白名单存在且 ref 不在其中 → CREDENTIAL_DENIED", () => {
    const r = resolveCredential("MY_KEY", "git", {
      env: { MY_KEY: FAKE_ENV_VALUE },
      allowNamesByOrigin: { git: ["GIT_TOKEN"] },
    });
    expect(r).toEqual({ ok: false, code: "CREDENTIAL_DENIED" });
  });

  it("origin 白名单命中 → ok", () => {
    const r = resolveCredential("GIT_TOKEN", "git", {
      env: { GIT_TOKEN: "fake-git-token-7777" },
      allowNamesByOrigin: { git: ["GIT_TOKEN"] },
    });
    expect(r.ok && r.env).toEqual({ GIT_TOKEN: "fake-git-token-7777" });
  });

  it("env 与 secrets 都没有 → CREDENTIAL_MISSING", () => {
    expect(resolveCredential("NOPE_KEY", "llm", { env: {}, secrets: {} })).toEqual({ ok: false, code: "CREDENTIAL_MISSING" });
  });

  it("空字符串值不当作命中 → CREDENTIAL_MISSING", () => {
    expect(resolveCredential("EMPTY_KEY", "llm", { env: { EMPTY_KEY: "" }, secrets: {} })).toEqual({
      ok: false,
      code: "CREDENTIAL_MISSING",
    });
  });

  it("成功时 env 片段只含单个变量,不夹带其它值", () => {
    const r = resolveCredential("MY_KEY", "npm", { env: { MY_KEY: FAKE_ENV_VALUE, OTHER_TOKEN: "fake-other" } });
    expect(Object.keys(r.ok ? r.env : {})).toEqual(["MY_KEY"]);
  });

  it("secrets 非字符串值按缺失处理", () => {
    expect(resolveCredential("NUM_KEY", "llm", { env: {}, secrets: { NUM_KEY: 42 } })).toEqual({
      ok: false,
      code: "CREDENTIAL_MISSING",
    });
  });
});

describe("maskCredential", () => {
  it("长值只显示末 4 位", () => {
    expect(maskCredential(FAKE_ENV_VALUE)).toBe(`***${FAKE_ENV_VALUE.slice(-4)}`);
    expect(maskCredential("12345678")).toBe("***5678");
  });

  it("长度 <8 显示 ***", () => {
    expect(maskCredential("1234567")).toBe("***");
    expect(maskCredential("")).toBe("***");
  });

  it("非字符串安全返回 ***", () => {
    expect(maskCredential(undefined)).toBe("***");
    expect(maskCredential(null)).toBe("***");
  });
});

describe("credentialAuditLine", () => {
  it("成功行含 ref/origin/code/envName/masked 且序列化无明文", () => {
    const r = resolveCredential("MY_KEY", "llm", { env: { MY_KEY: FAKE_ENV_VALUE } });
    const line = credentialAuditLine("MY_KEY", "llm", r);
    expect(line).toEqual({ ref: "MY_KEY", origin: "llm", code: "OK", envName: "MY_KEY", masked: `***${FAKE_ENV_VALUE.slice(-4)}` });
    expect(JSON.stringify(line)).not.toContain(FAKE_ENV_VALUE);
  });

  it("失败行只有 code,没有 masked/envName,也无明文", () => {
    const r = resolveCredential("MY_KEY", "nope", { env: { MY_KEY: FAKE_ENV_VALUE } });
    const line = credentialAuditLine("MY_KEY", "nope", r);
    expect(line).toEqual({ ref: "MY_KEY", origin: "nope", code: "CREDENTIAL_DENIED" });
    expect(line).not.toHaveProperty("masked");
    expect(JSON.stringify(line)).not.toContain(FAKE_ENV_VALUE);
  });

  it("result 为空/畸形也不 throw", () => {
    expect(credentialAuditLine(undefined, undefined as unknown as string, undefined)).toEqual({
      ref: "",
      origin: "",
      code: "CREDENTIAL_DENIED",
    });
  });
});
