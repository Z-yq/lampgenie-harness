import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOOL_UP_CANARY_PROMOTED,
  TOOL_UP_INVALID,
  TOOL_UP_KEEP_WINDOW_ACTIVE,
  TOOL_UP_NOT_FOUND,
  TOOL_UP_RETIRED,
  TOOL_UP_ROLLED_BACK,
  TOOL_UP_SHADOW_STARTED,
  TOOL_UP_STAGE_ORDER,
  TOOL_UP_SWITCHED,
  buildExperimentRecord,
} from "@lampgenie/runtime/agent/tool-upgrade-protocol";
import { getExperiment, loadProjection, recordExperiment } from "../src/experiment-store";
import { getState } from "../src/rsi-breaker-store";
import {
  initUpgrade,
  listUpgrades,
  projectLedger,
  promoteCanary,
  reportUpgrades,
  resolveCall,
  retireVersion,
  rollbackVersion,
  startShadow,
  switchVersion,
  toolUpgradePaths,
} from "../src/tool-upgrade-store";

/** 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。 */
const tempDirs: string[] = [];

async function tmpRoot(tag = "genie-tu-store"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${tag}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 台账非空行数(直接数原文,不信投影)。 */
async function ledgerLines(root: string): Promise<string[]> {
  const { file } = toolUpgradePaths(root);
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim() !== "");
}

/** 起一个「已 init + shadow + canary」的现场,供 switch/rollback/retire 用。 */
function seedCanary(root: string, name = "svc", base = "1.0.0", next = "1.1.0", alias = "beta") {
  const init = initUpgrade(root, { name, version: base });
  const shadow = startShadow(root, { name, newVersion: next, alias });
  const canary = promoteCanary(root, { name, version: next, canary: { scope: "percent", percent: 50 } });
  return { init, shadow, canary };
}

describe("tool-upgrade-store 落盘与投影", () => {
  it("① init 落盘一行且投影出 current", async () => {
    const root = await tmpRoot();
    const res = initUpgrade(root, { name: "svc", version: "1.0.0", at: 1000 });
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual([]);
    expect(res.state?.current).toBe("1.0.0");

    const lines = await ledgerLines(root);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(line["type"]).toBe("init");
    expect(line["name"]).toBe("svc");
    expect(line["version"]).toBe("1.0.0");
    // at 单位约定:行上的 at 是 ISO 字符串(毫秒只在协议面)。
    expect(line["at"]).toBe(new Date(1000).toISOString());

    const projection = projectLedger(root);
    expect(projection.badLines).toBe(0);
    expect(projection.totalLines).toBe(1);
    expect(projection.states.get("svc")?.current).toBe("1.0.0");
  });

  it("② shadow 后 aliasMap 与版本 stage 正确", async () => {
    const root = await tmpRoot();
    initUpgrade(root, { name: "svc", version: "1.0.0" });
    const res = startShadow(root, { name: "svc", newVersion: "1.1.0", alias: "beta" });
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual([TOOL_UP_SHADOW_STARTED]);
    expect(res.state?.current).toBe("1.0.0");
    expect(res.state?.aliasMap["beta"]).toBe("1.1.0");
    const shadowed = res.state?.versions.find((item) => item.version === "1.1.0");
    expect(shadowed?.stage).toBe("shadow");
    expect(shadowed?.alias).toBe("beta");
    expect(await ledgerLines(root)).toHaveLength(2);
  });

  it("③ canary 落盘并带灰度配置", async () => {
    const root = await tmpRoot();
    initUpgrade(root, { name: "svc", version: "1.0.0" });
    startShadow(root, { name: "svc", newVersion: "1.1.0", alias: "beta" });
    const res = promoteCanary(root, { name: "svc", version: "1.1.0", canary: { scope: "percent", percent: 50 } });
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual([TOOL_UP_CANARY_PROMOTED]);
    const promoted = res.state?.versions.find((item) => item.version === "1.1.0");
    expect(promoted?.stage).toBe("canary");
    expect(promoted?.canary?.percent).toBe(50);

    const lines = await ledgerLines(root);
    expect(lines).toHaveLength(3);
    const line = JSON.parse(lines[2] ?? "{}") as { type: string; payload: { canary: { scope: string; percent: number } } };
    expect(line.type).toBe("canary");
    expect(line.payload.canary.percent).toBe(50);
  });

  it("④ switch 落盘,旧版降级为 demotedFrom + keepWindows", async () => {
    const root = await tmpRoot();
    seedCanary(root);
    const res = switchVersion(root, { name: "svc", version: "1.1.0" });
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual([TOOL_UP_SWITCHED]);
    expect(res.state?.current).toBe("1.1.0");
    const demoted = res.state?.versions.find((item) => item.version === "1.0.0");
    expect(demoted?.demotedFrom).toBe("svc");
    expect(demoted?.keepWindows).toBe(2);
    expect(res.state?.aliasMap["1.0.0"]).toBe("1.0.0");
    expect(await ledgerLines(root)).toHaveLength(4);
  });

  it("⑤ switch 带 experimentRoot 时真写 #192 台账,experimentId 与行一致", async () => {
    const root = await tmpRoot();
    const expRoot = await tmpRoot("genie-tu-exp");
    seedCanary(root);
    const res = switchVersion(root, { name: "svc", version: "1.1.0", experimentRoot: expRoot });
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);

    const lines = await ledgerLines(root);
    const line = JSON.parse(lines[lines.length - 1] ?? "{}") as { type: string; payload: { experimentId?: string } };
    expect(line.type).toBe("switch");
    expect(typeof line.payload.experimentId).toBe("string");

    const projection = loadProjection(expRoot);
    expect(projection.experiments).toHaveLength(1);
    expect(projection.experiments[0]?.id).toBe(line.payload.experimentId);
    expect(getExperiment(expRoot, line.payload.experimentId as string)).toBeDefined();
    expect(reportUpgrades(root).warnings).toEqual([]);
  });

  it("⑥ 实验台账写失败不阻塞升级,warning 与 payload.experimentError 都留痕", async () => {
    const root = await tmpRoot();
    const expRoot = await tmpRoot("genie-tu-expdup");
    seedCanary(root);
    // 先占位同一条实验(id 由 name/from/to 决定),第二次写入必被 EXP_DUPLICATE 拒。
    const seedRecord = buildExperimentRecord({ name: "svc", from: "1.0.0", to: "1.1.0" });
    expect(recordExperiment(expRoot, seedRecord).ok).toBe(true);

    const res = switchVersion(root, { name: "svc", version: "1.1.0", experimentRoot: expRoot });
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual([TOOL_UP_SWITCHED]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.name).toBe("svc");
    expect(typeof res.warnings[0]?.code).toBe("string");

    const lines = await ledgerLines(root);
    const line = JSON.parse(lines[lines.length - 1] ?? "{}") as { payload: { experimentError?: string } };
    expect(typeof line.payload.experimentError).toBe("string");
    const report = reportUpgrades(root);
    expect(report.warnings).toEqual([{ name: "svc", code: res.warnings[0]?.code }]);
    // 实验台账仍是 1 条(未写入第二条)。
    expect(loadProjection(expRoot).experiments).toHaveLength(1);
  });

  it("⑦ rollback 带 breakerRoot 会真的熔断", async () => {
    const root = await tmpRoot();
    const breakerRoot = await tmpRoot("genie-tu-breaker");
    seedCanary(root);
    switchVersion(root, { name: "svc", version: "1.1.0" });
    const res = await rollbackVersion(root, { name: "svc", toVersion: "1.0.0", breakerRoot });
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual([TOOL_UP_ROLLED_BACK]);
    expect(res.warnings).toEqual([]);
    expect(res.state?.current).toBe("1.0.0");
    const breakerState = await getState(breakerRoot);
    expect(breakerState.paused).toBe(true);
  });

  it("⑧ rollback 不带 breakerRoot 时不碰熔断台账", async () => {
    const root = await tmpRoot();
    const breakerRoot = await tmpRoot("genie-tu-breaker-off");
    seedCanary(root);
    switchVersion(root, { name: "svc", version: "1.1.0" });
    const res = await rollbackVersion(root, { name: "svc", toVersion: "1.0.0" });
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);
    expect(res.state?.current).toBe("1.0.0");
    expect((await getState(breakerRoot)).paused).toBe(false);
    await expect(readFile(join(breakerRoot, ".genie", "rsi", "breaker.jsonl"), "utf8")).rejects.toThrow();
  });

  it("⑨ 保留窗口没走完就 retire 被拒且不落盘", async () => {
    const root = await tmpRoot();
    seedCanary(root);
    switchVersion(root, { name: "svc", version: "1.1.0" });
    const before = (await ledgerLines(root)).length;
    const res = retireVersion(root, { name: "svc", version: "1.0.0" });
    expect(res.ok).toBe(false);
    expect(res.codes).toEqual([TOOL_UP_KEEP_WINDOW_ACTIVE]);
    expect(res.state).toBeUndefined();
    expect((await ledgerLines(root)).length).toBe(before);
  });

  it("⑩ resolve 按 percent=50 确定性分流", async () => {
    const root = await tmpRoot();
    seedCanary(root, "svc", "1.0.0", "1.1.0", "beta");
    const first = resolveCall(root, { name: "svc", sessionId: "session-42" });
    const again = resolveCall(root, { name: "svc", sessionId: "session-42" });
    expect(first.ok).toBe(true);
    expect(again.version).toBe(first.version);
    expect(again.source).toBe(first.source);

    const seen = new Set<string>();
    for (let i = 0; i < 200 && seen.size < 2; i += 1) {
      const hit = resolveCall(root, { name: "svc", sessionId: `session-${i}` });
      expect(hit.ok).toBe(true);
      seen.add(hit.version);
    }
    expect(seen.has("1.0.0")).toBe(true);
    expect(seen.has("1.1.0")).toBe(true);

    // 别名调用直接命中影子/灰度版。
    expect(resolveCall(root, { name: "svc", alias: "beta" }).version).toBe("1.1.0");
  });

  it("⑪ list 按 name 过滤", async () => {
    const root = await tmpRoot();
    initUpgrade(root, { name: "alpha", version: "1.0.0" });
    initUpgrade(root, { name: "beta", version: "2.0.0" });
    const all = listUpgrades(root);
    expect(all.ok).toBe(true);
    expect(all.upgrades.map((item) => item.name).sort()).toEqual(["alpha", "beta"]);
    const only = listUpgrades(root, "beta");
    expect(only.upgrades).toHaveLength(1);
    expect(only.upgrades[0]?.current).toBe("2.0.0");
    expect(only.upgrades[0]?.stage).toBe("switch");
    expect(only.badLines).toBe(0);
  });

  it("⑫ report 形状含 path/badLines/warnings", async () => {
    const root = await tmpRoot();
    seedCanary(root);
    switchVersion(root, { name: "svc", version: "1.1.0" });
    const report = reportUpgrades(root);
    expect(report.ok).toBe(true);
    expect(report.names).toEqual(["svc"]);
    expect(report.perName["svc"]?.current).toBe("1.1.0");
    expect(report.perName["svc"]?.aliasMap["beta"]).toBe("1.1.0");
    expect(report.perName["svc"]?.versions.map((item) => item.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(report.badLines).toBe(0);
    expect(report.totalLines).toBe(4);
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(report.path.endsWith(join(".genie", "rsi", "tool-upgrades.jsonl"))).toBe(true);
  });

  it("⑬ 坏行容错:非法 JSON 只计 badLines,投影仍可用", async () => {
    const root = await tmpRoot();
    initUpgrade(root, { name: "svc", version: "1.0.0" });
    const { dir, file } = toolUpgradePaths(root);
    await mkdir(dir, { recursive: true });
    await writeFile(file, "{not json at all\n", { encoding: "utf8", flag: "a" });

    const projection = projectLedger(root);
    expect(projection.badLines).toBe(1);
    expect(projection.totalLines).toBe(2);
    expect(projection.states.get("svc")?.current).toBe("1.0.0");
    expect(listUpgrades(root).badLines).toBe(1);
    expect(reportUpgrades(root).badLines).toBe(1);
    // 坏行之后还能继续写。
    expect(startShadow(root, { name: "svc", newVersion: "1.1.0", alias: "beta" }).ok).toBe(true);
  });

  it("⑭ 未知工具 / 未知别名 → TOOL_UP_NOT_FOUND", async () => {
    const root = await tmpRoot();
    const resolved = resolveCall(root, { name: "nope" });
    expect(resolved.ok).toBe(false);
    expect(resolved.codes).toEqual([TOOL_UP_NOT_FOUND]);
    expect(resolved.version).toBe("");

    const shadowed = startShadow(root, { name: "nope", newVersion: "1.1.0", alias: "beta" });
    expect(shadowed.ok).toBe(false);
    expect(shadowed.codes).toEqual([TOOL_UP_NOT_FOUND]);

    initUpgrade(root, { name: "svc", version: "1.0.0" });
    expect(resolveCall(root, { name: "svc", alias: "ghost" }).codes).toEqual([TOOL_UP_NOT_FOUND]);
  });

  it("⑮ 重复 init / 重复别名 / 段位乱序按协议码拒绝", async () => {
    const root = await tmpRoot();
    expect(initUpgrade(root, { name: "svc", version: "1.0.0" }).ok).toBe(true);
    const dupInit = initUpgrade(root, { name: "svc", version: "9.9.9" });
    expect(dupInit.ok).toBe(false);
    expect(dupInit.codes).toEqual([TOOL_UP_INVALID]);

    expect(startShadow(root, { name: "svc", newVersion: "1.1.0", alias: "beta" }).ok).toBe(true);
    expect(startShadow(root, { name: "svc", newVersion: "1.2.0", alias: "beta" }).codes).toEqual([TOOL_UP_INVALID]);
    // 已在 shadow 的版本不再允许重开影子 → 段位乱序。
    expect(startShadow(root, { name: "svc", newVersion: "1.1.0", alias: "beta2" }).codes).toEqual([TOOL_UP_INVALID]);

    // 还在 shadow 就想 switch:协议允许 shadow→switch,所以先验证 switch 前的 canary 缺失分支
    expect(promoteCanary(root, { name: "svc", version: "1.1.0", canary: { scope: "session", sessions: ["s1"] } }).ok).toBe(
      true);
    expect(promoteCanary(root, { name: "svc", version: "1.1.0", canary: { scope: "session" } }).codes).toEqual([
      TOOL_UP_STAGE_ORDER,
    ]);

    // retire 在线版 → 段位乱序。
    expect(retireVersion(root, { name: "svc", version: "1.0.0" }).codes).toEqual([TOOL_UP_STAGE_ORDER]);
    // 未降级过的非在线版本可以直接 retire。
    const retired = retireVersion(root, { name: "svc", version: "1.1.0" });
    expect(retired.ok).toBe(true);
    expect(retired.codes).toEqual([TOOL_UP_RETIRED]);
    expect(retired.state?.versions.find((item) => item.version === "1.1.0")?.stage).toBe("retire");
  });

  it("⑯ root 非法 → TypeError(与 experiment-store 同口径)", async () => {
    expect(() => initUpgrade("", { name: "svc", version: "1.0.0" })).toThrow(TypeError);
    expect(() => listUpgrades(undefined as unknown as string)).toThrow(TypeError);
    await expect(rollbackVersion("  ", { name: "svc", toVersion: "1.0.0" })).rejects.toThrow(TypeError);
  });
});
