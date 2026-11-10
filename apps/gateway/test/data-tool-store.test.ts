import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dataToolDir,
  dataToolPath,
  doctorDataTools,
  listToolStore,
  pinDataTool,
  registerDataTool,
  reloadTools,
  reportTools,
  resolveDataTool,
  toolPinsPath,
  unregisterDataTool,
} from "../src/data-tool-store";

const NOW = 1_700_000_000_000;
const roots: string[] = [];

async function newRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "data-tool-store-"));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

/** 合法 data 工具声明(默认 handler=mcp);over 覆盖任意字段。 */
function makeSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "cache_probe",
    version: "1.0.0",
    owner: "xiaofei",
    description: "探测缓存命中率",
    parameters: { type: "object", properties: { key: { type: "string" } } },
    handler: { kind: "mcp", ref: "cache.probe" },
    permissions: { mode: "read" },
    ...over,
  };
}

async function readStoreFile(root: string, name: string): Promise<{ spec: any; versions: any[] }> {
  return JSON.parse(await readFile(dataToolPath(root, name), "utf8")) as { spec: any; versions: any[] };
}

describe("data-tool-store 落盘与热加载", () => {
  it("1) 人类注册后立即可见(无需重启)", async () => {
    const root = await newRoot();
    const result = registerDataTool(root, makeSpec(), { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("DATA_TOOL_REGISTERED");
    const stored = await readStoreFile(root, "cache_probe");
    expect(stored.spec.version).toBe("1.0.0");
    expect(stored.versions[0]?.version).toBe("1.0.0");

    const list = listToolStore(root);
    const entry = list.data.find((item) => item.name === "cache_probe");
    expect(entry?.version).toBe("1.0.0");
    expect(list.bad).toEqual([]);
  });

  it("2) native 同名且非 shadow 被拒,文件不落盘", async () => {
    const root = await newRoot();
    const result = registerDataTool(root, makeSpec({ name: "web_search" }), { nativeNames: ["web_search"], now: NOW });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("DATA_TOOL_NATIVE_IMMUTABLE");
    await expect(readFile(dataToolPath(root, "web_search"), "utf8")).rejects.toBeTruthy();
  });

  it("3) shadow 原生工具可注册,卸载后原生恢复", async () => {
    const root = await newRoot();
    const shadow = registerDataTool(root, makeSpec({ name: "web_search", shadowOf: "web_search" }), {
      nativeNames: ["web_search"],
      now: NOW,
    });
    expect(shadow.ok).toBe(true);
    const list = listToolStore(root, { nativeNames: ["web_search"] });
    expect(list.data.find((item) => item.name === "web_search")?.shadowOf).toBe("web_search");

    const removed = unregisterDataTool(root, "web_search");
    expect(removed.ok).toBe(true);
    expect(removed.restored).toBe("web_search");
    const after = listToolStore(root, { nativeNames: ["web_search"] });
    expect(after.data.find((item) => item.name === "web_search")).toBeUndefined();
    expect(after.native).toContain("web_search");
  });

  it("4) rsi 注册无审批 → #196 门拒(need-approval),文件不落盘", async () => {
    const root = await newRoot();
    const result = registerDataTool(root, makeSpec({ name: "rsi_probe", registeredBy: "rsi" }), { now: NOW });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("DATA_TOOL_NEEDS_APPROVAL");
    expect(result.codes).toContain("MOD_RSI_NEEDS_HUMAN");
    expect(result.gate?.decision).toBe("need-approval");
    await expect(readFile(dataToolPath(root, "rsi_probe"), "utf8")).rejects.toBeTruthy();
  });

  it("5) rsi 注册带人类审批 → 通过且无 MOD_ 码", async () => {
    const root = await newRoot();
    const result = registerDataTool(
      root,
      makeSpec({ name: "rsi_probe", registeredBy: "rsi" }),
      { approval: { ok: true, by: "xiaofei", kind: "human" }, now: NOW },
    );
    expect(result.ok).toBe(true);
    expect(result.gate?.decision).toBe("allow");
    expect(result.codes.filter((code) => code.startsWith("MOD_"))).toEqual([]);
    expect(result.spec?.approval?.ok).toBe(true);
    expect(result.spec?.approval?.approverKind).toBe("human");
  });

  it("6) 审批人不限 owner 本人,但 agent 审批被门拒", async () => {
    const root = await newRoot();
    const otherHuman = registerDataTool(
      root,
      makeSpec({ name: "rsi_probe_a", registeredBy: "rsi" }),
      { approval: { ok: true, by: "someone-else", kind: "human" }, now: NOW },
    );
    expect(otherHuman.ok).toBe(true);

    const agentApproval = registerDataTool(
      root,
      makeSpec({ name: "rsi_probe_b", registeredBy: "rsi" }),
      { approval: { ok: true, by: "agent-1", kind: "agent" }, now: NOW },
    );
    expect(agentApproval.ok).toBe(false);
    expect(agentApproval.codes).toContain("MOD_AGENT_APPROVAL_FORBIDDEN");
    await expect(readFile(dataToolPath(root, "rsi_probe_b"), "utf8")).rejects.toBeTruthy();
  });

  it("7) 钉扎 1.0.0 后升级 2.0.0,session 钉扎生效", async () => {
    const root = await newRoot();
    expect(registerDataTool(root, makeSpec(), { now: NOW }).ok).toBe(true);
    const pinned = pinDataTool(root, "s1", "cache_probe", "1.0.0");
    expect(pinned.ok).toBe(true);
    expect(registerDataTool(root, makeSpec({ version: "2.0.0" }), { now: NOW + 1 }).ok).toBe(true);

    const forS1 = resolveDataTool(root, "cache_probe", { sessionId: "s1" });
    expect(forS1.spec?.version).toBe("1.0.0");
    expect(forS1.codes).toContain("DATA_TOOL_PINNED");
    const forS2 = resolveDataTool(root, "cache_probe", { sessionId: "s2" });
    expect(forS2.spec?.version).toBe("2.0.0");
    expect(forS2.codes).not.toContain("DATA_TOOL_PINNED");

    const stored = await readStoreFile(root, "cache_probe");
    expect(stored.spec.version).toBe("2.0.0");
    expect(stored.versions.map((item) => item.version)).toEqual(["2.0.0", "1.0.0"]);
  });

  it("8) 同版本重复注册 → DUPLICATE", async () => {
    const root = await newRoot();
    expect(registerDataTool(root, makeSpec(), { now: NOW }).ok).toBe(true);
    const again = registerDataTool(root, makeSpec(), { now: NOW + 1 });
    expect(again.ok).toBe(false);
    expect(again.codes).toContain("DATA_TOOL_DUPLICATE");
  });

  it("9) 降级注册 → VERSION_STALE", async () => {
    const root = await newRoot();
    expect(registerDataTool(root, makeSpec({ version: "2.0.0" }), { now: NOW }).ok).toBe(true);
    const stale = registerDataTool(root, makeSpec({ version: "1.5.0" }), { now: NOW + 1 });
    expect(stale.ok).toBe(false);
    expect(stale.codes).toContain("DATA_TOOL_VERSION_STALE");
  });

  it("10) doctor 按 env 判降级,补全后恢复且不删文件", async () => {
    const root = await newRoot();
    const spec = makeSpec({ name: "env_probe", requires: [{ kind: "env", name: "NOPE" }] });
    expect(registerDataTool(root, spec, { now: NOW }).ok).toBe(true);

    const missing = doctorDataTools(root, { envVars: [] });
    expect(missing.ok).toBe(false);
    expect(missing.degraded).toContain("env_probe");
    expect(missing.missing).toContainEqual({ name: "env_probe", kind: "env", dep: "NOPE" });

    const healthy = doctorDataTools(root, { envVars: ["NOPE"] });
    expect(healthy.ok).toBe(true);
    expect(healthy.degraded).toEqual([]);
    expect(healthy.missing).toEqual([]);
    await expect(readFile(dataToolPath(root, "env_probe"), "utf8")).resolves.toBeTruthy();
  });

  it("11) 钉扎未知版本被拒;成功钉扎跨调用持久化", async () => {
    const root = await newRoot();
    expect(registerDataTool(root, makeSpec(), { now: NOW }).ok).toBe(true);

    const unknown = pinDataTool(root, "s1", "cache_probe", "9.9.9");
    expect(unknown.ok).toBe(false);
    expect(unknown.codes).toContain("DATA_TOOL_PIN_UNKNOWN");

    expect(pinDataTool(root, "s1", "cache_probe", "1.0.0").ok).toBe(true);
    const onDisk = JSON.parse(await readFile(toolPinsPath(root), "utf8")) as Record<string, Record<string, string>>;
    expect(onDisk.s1?.cache_probe).toBe("1.0.0");
    expect(listToolStore(root).pins.s1?.cache_probe).toBe("1.0.0");
  });

  it("12) reportTools 字段齐全且含已注册工具", async () => {
    const root = await newRoot();
    expect(registerDataTool(root, makeSpec(), { now: NOW }).ok).toBe(true);
    pinDataTool(root, "s1", "cache_probe", "1.0.0");
    const report = reportTools(root);
    expect(report.ok).toBe(true);
    expect(report.dir).toBe(dataToolDir(root));
    expect(report.files).toContain("cache_probe.json");
    expect(report.data.find((item) => item.name === "cache_probe")?.version).toBe("1.0.0");
    expect(report.degraded).toEqual({});
    expect(report.native).toEqual([]);
    expect(report.plugin).toEqual([]);
    expect(report.pins.s1?.cache_probe).toBe("1.0.0");
    expect(report.bad).toEqual([]);
  });

  it("13) 坏文件进 bad 且不影响其余工具", async () => {
    const root = await newRoot();
    expect(registerDataTool(root, makeSpec(), { now: NOW }).ok).toBe(true);
    await writeFile(join(dataToolDir(root), "broken.json"), "{ this is not json", "utf8");
    const firstPass = reloadTools(root);
    expect(firstPass.bad.length).toBe(1);
    expect(firstPass.bad[0]?.file).toBe("broken.json");
    expect(listToolStore(root).data.find((item) => item.name === "cache_probe")?.version).toBe("1.0.0");

    await writeFile(
      join(dataToolDir(root), "noversion.json"),
      JSON.stringify({ spec: { name: "noversion", owner: "xiaofei" } }),
      "utf8",
    );
    const secondPass = reloadTools(root);
    expect(secondPass.bad.length).toBe(2);
    expect(secondPass.bad.map((item) => item.file)).toContain("noversion.json");
  });

  it("14) 参数错误返回 DATA_TOOL_INVALID,不 throw", async () => {
    const root = await newRoot();
    for (const bad of [null, "字符串", 42, []]) {
      const result = registerDataTool(root, bad, { now: NOW });
      expect(result.ok).toBe(false);
      expect(result.codes).toContain("DATA_TOOL_INVALID");
    }
  });

  it("15) 目录不存在时热加载为空表", async () => {
    const root = await newRoot();
    const reloaded = reloadTools(root);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.registry.data).toEqual({});
    expect(reloaded.bad).toEqual([]);
    expect(reportTools(root).files).toEqual([]);
  });
});
