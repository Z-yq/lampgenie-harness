import { describe, expect, it } from "vitest";
import { buildWorkerEnv, readGenieSecrets } from "../src/session-worker-host.js";

/** 夹具全部是 fake- 前缀假值。 */
const FAKE_TASK_KEY = "fake-task-key-5a4b3c2d";
const FAKE_OTHER_SECRET = "fake-other-secret-0a0b0c0d";
const OTHER_LAST4 = FAKE_OTHER_SECRET.slice(-4);

function baseEnv(): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/tester",
    USER: "tester",
    LANG: "zh_CN.UTF-8",
    OPENAI_API_KEY: "fake-openai-key-should-not-leak",
    GITHUB_TOKEN: "fake-github-token-should-not-leak",
    SOME_RANDOM_VAR: "should-be-dropped",
  };
}

describe("session-worker fork env 边界", () => {
  it("无 credentialRef:密钥删/PATH 留,无审计", () => {
    const built = buildWorkerEnv(undefined, { baseEnv: baseEnv(), readSecrets: () => ({}) });
    expect(built.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(built.env.HOME).toBe("/home/tester");
    expect(built.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(built.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(built.env.SOME_RANDOM_VAR).toBe("should-be-dropped"); // 非凭证普通变量照常继承
    expect(built.audit).toBeUndefined();
  });

  it("credentialRef 命中 secrets:只注入该一个变量,其它 secrets 不出现", () => {
    const built = buildWorkerEnv("TASK_KEY", {
      baseEnv: baseEnv(),
      readSecrets: () => ({ TASK_KEY: FAKE_TASK_KEY, OTHER_SECRET: FAKE_OTHER_SECRET }),
    });
    expect(built.env.TASK_KEY).toBe(FAKE_TASK_KEY);
    expect(built.env).not.toHaveProperty("OTHER_SECRET");
    expect(built.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(built.audit).toBeUndefined();
 // 除解析出的那一个变量外,其余 secrets 值不得整体进入子进程 env
    expect(JSON.stringify(built.env)).not.toContain(OTHER_LAST4);
  });

  it("credentialRef 命中 env(优先于 secrets):注入环境里的值", () => {
    const built = buildWorkerEnv("TASK_KEY", {
      baseEnv: { ...baseEnv(), TASK_KEY: FAKE_TASK_KEY },
      readSecrets: () => ({ TASK_KEY: FAKE_OTHER_SECRET }),
    });
    expect(built.env.TASK_KEY).toBe(FAKE_TASK_KEY);
    expect(JSON.stringify(built.env)).not.toContain(OTHER_LAST4);
  });

  it("credentialRef 缺失:不注入 + 审计 CREDENTIAL_MISSING(不含值)", () => {
    const built = buildWorkerEnv("TASK_KEY", { baseEnv: baseEnv(), readSecrets: () => ({ OTHER: FAKE_OTHER_SECRET }) });
    expect(built.env).not.toHaveProperty("TASK_KEY");
    expect(built.audit).toMatchObject({ what: "credential.resolve", ref: "TASK_KEY", origin: "task", code: "CREDENTIAL_MISSING" });
    expect(JSON.stringify(built.audit)).not.toContain(FAKE_OTHER_SECRET);
    expect(built.audit).not.toHaveProperty("masked");
  });

  it("非法 credentialRef:fail-closed DENIED,env 不注入", () => {
    const built = buildWorkerEnv("A=B", { baseEnv: baseEnv(), readSecrets: () => ({}) });
    expect(built.env).not.toHaveProperty("A=B");
    expect(built.audit?.code).toBe("CREDENTIAL_DENIED");
  });

  it("origin 白名单不匹配:DENIED(即使值存在)", () => {
    const built = buildWorkerEnv("TASK_KEY", {
      baseEnv: baseEnv(),
      readSecrets: () => ({ TASK_KEY: FAKE_TASK_KEY }),
      allowNamesByOrigin: { task: ["ONLY_THIS_KEY"] },
    });
    expect(built.env).not.toHaveProperty("TASK_KEY");
    expect(built.audit?.code).toBe("CREDENTIAL_DENIED");
    expect(JSON.stringify(built.env)).not.toContain(FAKE_TASK_KEY);
  });

  it("GENIE_CREDENTIAL_BOUNDARY=off 回退旧行为:整份 env 原样继承、不注入、不审计", () => {
    const base = baseEnv();
    const built = buildWorkerEnv("TASK_KEY", {
      baseEnv: base,
      readSecrets: () => ({ TASK_KEY: FAKE_TASK_KEY }),
      boundaryOff: true,
    });
    expect(built.env).toEqual(base);
    expect(built.env).toHaveProperty("OPENAI_API_KEY");
    expect(built.env).not.toHaveProperty("TASK_KEY");
    expect(built.audit).toBeUndefined();
    expect(built.env).not.toBe(base); // 仍是副本,不把 process.env 本体交出去
  });

  it("不改入参 baseEnv", () => {
    const base = baseEnv();
    const snapshot = JSON.parse(JSON.stringify(base)) as Record<string, string>;
    buildWorkerEnv("TASK_KEY", { baseEnv: base, readSecrets: () => ({ TASK_KEY: FAKE_TASK_KEY }) });
    expect(base).toEqual(snapshot);
  });

  it("readGenieSecrets:目录缺失/坏 JSON 都返回空表(不抛)", () => {
    expect(readGenieSecrets("/definitely/not/a/repo")).toEqual({});
  });
});
