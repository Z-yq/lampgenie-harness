/**
 * paths.js 纯函数单测(node:test,脱离 electron)。
 * 跑法:cd apps/desktop && node --test test/
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  resolveDataRoot,
  findRepoRoot,
  resolveGatewayDir,
  listPortCandidates,
  resourceChecklist,
  ensureDataRoot,
  hasAnyCredential,
  llmRouteState,
} = require("../paths");

function tmp(prefix = "genie-desktop-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("ensureDataRoot:新用户只有最小配置,无 coding/audio 密钥", () => {
  const root = tmp();
  try {
    ensureDataRoot(root);
    const cfg = JSON.parse(readFileSync(join(root, "genie.config.json"), "utf8"));
    assert.deepEqual(Object.keys(cfg).sort(), ["gateway", "journal"]);
    assert.equal(cfg.providers, undefined);
    assert.equal(cfg.coding, undefined);
    assert.equal(cfg.audio, undefined);
    assert.equal(existsSync(join(root, ".genie", "secrets.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llmRouteState:空数据根 → 未就绪(未配置模型)", () => {
  const root = tmp();
  try {
    ensureDataRoot(root);
    const s = llmRouteState(root, {});
    assert.equal(s.ready, false);
    assert.match(s.reason, /未配置模型/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llmRouteState:有模型但缺凭证 → 未就绪(不重启,重启也没用)", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(
      join(root, "genie.config.json"),
      JSON.stringify({
        coding: { llm: { model: "m1", providerId: "p1", apiKeyEnv: "SOME_KEY" } },
        providers: [{ id: "p1", baseUrl: "https://x.test/v1" }],
      }),
    );
    const s = llmRouteState(root, {});
    assert.equal(s.ready, false);
    assert.match(s.reason, /缺少凭证/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llmRouteState:凭证在 secrets.json → 就绪(端点经 providers 继承)", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(
      join(root, "genie.config.json"),
      JSON.stringify({
        coding: { llm: { model: "m1", providerId: "p1", apiKeyEnv: "SOME_KEY" } },
        providers: [{ id: "p1", baseUrl: "https://x.test/v1" }],
      }),
    );
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify({ SOME_KEY: "sk-x" }));
    const s = llmRouteState(root, {});
    assert.equal(s.ready, true);
    assert.match(s.reason, /m1 @ https:\/\/x\.test\/v1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llmRouteState:凭证来自进程 env 也算就绪", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(
      join(root, "genie.config.json"),
      JSON.stringify({ coding: { llm: { model: "m2", baseUrl: "https://y.test", apiKeyEnv: "ENV_KEY" } } }),
    );
    assert.equal(llmRouteState(root, {}).ready, false);
    assert.equal(llmRouteState(root, { ENV_KEY: "sk-y" }).ready, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llmRouteState:model 空但有 providerId → 未就绪", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(
      join(root, "genie.config.json"),
      JSON.stringify({ coding: { llm: { providerId: "p1" } }, providers: [{ id: "p1", baseUrl: "https://x.test" }] }),
    );
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify({ GENIE_LLM_API_KEY: "sk" }));
    const s = llmRouteState(root, {});
    assert.equal(s.ready, false);
    assert.match(s.reason, /未配置模型/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("llmRouteState:audio.chat 显式配置优先于 coding.llm", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, ".genie"), { recursive: true });
    writeFileSync(
      join(root, "genie.config.json"),
      JSON.stringify({
        coding: { llm: { model: "coding-model", baseUrl: "https://c.test", apiKeyEnv: "GENIE_LLM_API_KEY" } },
        audio: { chat: { model: "audio-model", baseUrl: "https://a.test" } },
      }),
    );
    writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify({ GENIE_AUDIO_API_KEY: "sk-a" }));
    const s = llmRouteState(root, {});
    assert.equal(s.ready, true);
    assert.match(s.reason, /audio-model @ https:\/\/a\.test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDataRoot:GENIE_DESKTOP_DATA_ROOT 最优先", () => {
  const got = resolveDataRoot({
    env: {
      GENIE_DESKTOP_DATA_ROOT: "/tmp/explicit",
      PORTABLE_EXECUTABLE_DIR: "/tmp/portable",
      APPDATA: "/tmp/appdata",
    },
    platform: "win32",
  });
  assert.equal(got, "/tmp/explicit");
});

test("resolveDataRoot:便携态 PORTABLE_EXECUTABLE_DIR > <便携目录>/user-data", () => {
  const got = resolveDataRoot({
    env: { PORTABLE_EXECUTABLE_DIR: join("/tmp", "portable") },
    platform: "win32",
  });
  assert.equal(got, join("/tmp", "portable", "user-data"));
});

test("resolveDataRoot:便携态可见 portableDir 参数(env 无 PORTABLE_EXECUTABLE_DIR)", () => {
  const got = resolveDataRoot({
    env: {},
    platform: "win32",
    portableDir: join("/tmp", "pen"),
  });
  assert.equal(got, join("/tmp", "pen", "user-data"));
});

test("resolveDataRoot:Windows = %APPDATA%/LampGenie", () => {
  const got = resolveDataRoot({
    env: { APPDATA: join("/tmp", "roaming") },
    platform: "win32",
  });
  assert.equal(got, join("/tmp", "roaming", "LampGenie"));
});

test("resolveDataRoot:非 Windows = homedir/.lampgenie-harness", () => {
  const got = resolveDataRoot({ env: {}, platform: "linux" });
  assert.ok(got.endsWith(join(".lampgenie-harness")));
  assert.notEqual(got, join("/tmp", "roaming", "LampGenie"));
});

test("listPortCandidates:默认 7701..7720 闭区间共 20 个(7700 留给 WSL/服务器网关)", () => {
  const ports = listPortCandidates();
  assert.equal(ports.length, 20);
  assert.equal(ports[0], 7701);
  assert.equal(ports[19], 7720);
  assert.deepEqual(listPortCandidates(1, 3), [1, 2, 3]);
});

test("resourceChecklist:空目录时必需项全部 missing", () => {
  const dir = tmp();
  try {
    const list = resourceChecklist(dir);
    const required = list.filter((i) => i.required);
    assert.deepEqual(
      required.map((i) => i.name),
      ["gateway.mjs", "assets", "session-worker.mjs", "sense-index-worker.mjs", "tree-sitter.wasm", "echo-child.mjs"],
    );
    assert.ok(required.every((i) => i.missing === true));
    // 可选 5 项
    assert.equal(list.length, 11);
    assert.equal(list.filter((i) => !i.required).length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resourceChecklist:只补必需项后 required 无缺失、可选仍缺", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "gateway.mjs"), "");
    writeFileSync(join(dir, "session-worker.mjs"), "");
    writeFileSync(join(dir, "sense-index-worker.mjs"), "");
    writeFileSync(join(dir, "tree-sitter.wasm"), "");
    writeFileSync(join(dir, "echo-child.mjs"), "");
    mkdirSync(join(dir, "assets"), { recursive: true });
    const list = resourceChecklist(dir);
    assert.deepEqual(list.filter((i) => i.required && i.missing), []);
    assert.deepEqual(
      list.filter((i) => !i.required && i.missing).map((i) => i.name),
      [
        "downloads/node-agent.mjs",
        "node_modules/ts-morph",
        "node_modules/playwright-core",
        "node_modules/tree-sitter-wasms",
        "node_modules/web-tree-sitter",
      ],
    );
    assert.equal(list.find((i) => i.name === "gateway.mjs").path, join(dir, "gateway.mjs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDataRoot:建骨架 + 写最小配置,且不含凭证", () => {
  const root = tmp();
  try {
    const res = ensureDataRoot(root);
    assert.equal(res.configCreated, true);
    for (const sub of [
      "journals",
      "experiences",
      "uploads",
      "memory",
      "plans",
      "agent-outputs",
      "llm-trace",
      "secrets",
      "browser-shots",
    ]) {
      const p = join(root, ".genie", sub);
      assert.equal(statSync(p).isDirectory(), true, `缺目录 ${p}`);
    }
    assert.equal(statSync(join(root, "logs")).isDirectory(), true);
    const cfg = JSON.parse(readFileSync(join(root, "genie.config.json"), "utf8"));
    assert.deepEqual(cfg, { gateway: { port: 7700, panel: true }, journal: { dir: ".genie/journals" } });
    assert.equal(/secret|key|token|password/i.test(JSON.stringify(cfg)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureDataRoot:幂等且不覆盖已有 genie.config.json", () => {
  const root = tmp();
  try {
    ensureDataRoot(root);
    const userCfg = { gateway: { port: 7900, panel: false }, custom: "keep-me" };
    writeFileSync(join(root, "genie.config.json"), JSON.stringify(userCfg));
    const second = ensureDataRoot(root);
    assert.equal(second.configCreated, false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "genie.config.json"), "utf8")), userCfg);
    // 再跑一次不抛(目录已存在)
    assert.doesNotThrow(() => ensureDataRoot(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hasAnyCredential:无文件/空对象 → false,非空 → true,坏 JSON → false", () => {
  const root = tmp();
  try {
    ensureDataRoot(root);
    assert.equal(hasAnyCredential(root), false);

    const secrets = join(root, ".genie", "secrets.json");
    writeFileSync(secrets, "{}");
    assert.equal(hasAnyCredential(root), false);

    writeFileSync(secrets, JSON.stringify({ openai: { apiKey: "sk-x" } }));
    assert.equal(hasAnyCredential(root), true);

    writeFileSync(secrets, "{not json");
    assert.equal(hasAnyCredential(root), false);

    assert.equal(hasAnyCredential(""), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findRepoRoot / resolveGatewayDir:向上探测仓根(仅在真实仓内跑)", () => {
  const root = findRepoRoot(__dirname);
  assert.ok(root, "应在仓内找到 pnpm-workspace.yaml");
  // 断言「找到的是真的仓根」而不是目录名:检出目录可被改名(CI/发行包解压),按名字断言会假红。
  assert.ok(existsSync(join(root, "pnpm-workspace.yaml")), `仓根缺少 pnpm-workspace.yaml: ${root}`);
  const devGateway = resolveGatewayDir({ env: {}, isPackaged: false });
  assert.equal(devGateway, join(root, "apps", "gateway", "dist"));
  const packaged = resolveGatewayDir({ env: {}, isPackaged: true, resourcesPath: join("/tmp", "resources") });
  assert.equal(packaged, join("/tmp", "resources", "gateway"));
});

test("findRepoRoot:找不到返回 null,且最多探 8 层", () => {
  assert.equal(findRepoRoot(join("/tmp", "definitely", "no", "workspace")), null);
});