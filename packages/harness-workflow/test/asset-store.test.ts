/**
 * 资产存储测试:全部落在 /tmp 下的临时目录,不触碰仓内文件。
 * 覆盖:CRUD 往返 / 同名校验与覆盖 / 原子写 / 目录自建 / 坏文件跳过 / stats / 默认目录在 /tmp 内。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowAssetStore, type WorkflowAsset } from "../src/asset-store";

let dir: string;
let store: WorkflowAssetStore;

const mkAsset = (over: Partial<WorkflowAsset> = {}): WorkflowAsset => ({
  name: "review",
  script: "report({ ok: true });",
  paramsSchema: '{"type":"object","properties":{"target":{"type":"string"}}}',
  scope: "project",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "genie-wf-assets-"));
  store = new WorkflowAssetStore({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("资产 CRUD", () => {
  it("save + get 往返:内容完整,时间字段由存储接管", async () => {
    const saved = await store.save(mkAsset({ description: "代码评审流" }));
    expect(saved.ok).toBe(true);
    expect(saved.code).toBe("OK");
    expect(saved.asset?.createdAt).toBeGreaterThan(0);
    expect(saved.asset?.updatedAt).toBe(saved.asset?.createdAt);

    const got = await store.get("review");
    expect(got.ok).toBe(true);
    expect(got.asset?.name).toBe("review");
    expect(got.asset?.script).toContain("report(");
    expect(got.asset?.paramsSchema).toContain('"target"');
    expect(got.asset?.scope).toBe("project");
    expect(got.asset?.description).toBe("代码评审流");
  });

  it("同 name 覆盖:保 createdAt,推进 updatedAt,内容替换", async () => {
    const first = await store.save(mkAsset({ script: "report({ v: 1 });" }));
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.save(mkAsset({ script: "report({ v: 2 });", scope: "global" }));
    expect(second.ok).toBe(true);
    expect(second.asset?.createdAt).toBe(first.asset?.createdAt); // 诞生时间不重置
    expect(second.asset?.updatedAt).toBeGreaterThanOrEqual(first.asset?.updatedAt ?? 0);
    const got = await store.get("review");
    expect(got.asset?.script).toBe("report({ v: 2 });");
    expect(got.asset?.scope).toBe("global");
 // 覆盖后目录里仍只有一个文件
    expect(await readdir(dir)).toEqual(["review.json"]);
  });

  it("list 按 name 排序", async () => {
    await store.save(mkAsset({ name: "zeta" }));
    await store.save(mkAsset({ name: "alpha" }));
    await store.save(mkAsset({ name: "mid.2" }));
    const listed = await store.list();
    expect(listed.ok).toBe(true);
    expect(listed.warnings).toEqual([]);
    expect(listed.assets.map((a) => a.name)).toEqual(["alpha", "mid.2", "zeta"]);
  });

  it("remove:存在→OK,再 get→NOT_FOUND,再 remove→NOT_FOUND", async () => {
    await store.save(mkAsset());
    const removed = await store.remove("review");
    expect(removed).toEqual({ ok: true, code: "OK" });
    expect((await store.get("review")).code).toBe("NOT_FOUND");
    expect((await store.remove("review")).code).toBe("NOT_FOUND");
  });

  it("get 不存在 → NOT_FOUND;get 非法 name → INVALID", async () => {
    expect((await store.get("nope")).code).toBe("NOT_FOUND");
    expect((await store.get("bad name")).code).toBe("INVALID");
    expect((await store.get("a/b")).code).toBe("INVALID");
  });

  it("目录不存在时 list 返回空仓(不报错、不建目录)", async () => {
    const listed = await store.list();
    expect(listed).toEqual({ ok: true, code: "OK", assets: [], warnings: [] });
  });
});

describe("入参校验", () => {
  it("非法 name(空格 / 斜杠 / 越界 / 超长 / . / ..)→ INVALID 且不落盘", async () => {
    for (const name of ["bad name", "../evil", "a/b", "x".repeat(65), ".", "..", ""]) {
      const r = await store.save(mkAsset({ name }));
      expect(r.ok, `name=${JSON.stringify(name)}`).toBe(false);
      expect(r.code).toBe("INVALID");
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("name 允许字母数字与 . _ - 组合", async () => {
    for (const name of ["a", "A1", "team.review-2_a", "x".repeat(64)]) {
      const r = await store.save(mkAsset({ name, scope: "global" }));
      expect(r.code, `name=${name}`).toBe("OK");
    }
  });

  it("script 空 / 纯空白 → INVALID", async () => {
    expect((await store.save(mkAsset({ script: "" }))).code).toBe("INVALID");
    expect((await store.save(mkAsset({ script: "   \n\t" }))).code).toBe("INVALID");
  });

  it("paramsSchema 非 JSON / 非字符串 → INVALID", async () => {
    expect((await store.save(mkAsset({ paramsSchema: "{ nope" }))).code).toBe("INVALID");
    expect((await store.save(mkAsset({ paramsSchema: undefined as never }))).code).toBe("INVALID");
 // 合法 JSON 的非对象形态按「合法 JSON」放行(语义由消费方解释)
    expect((await store.save(mkAsset({ paramsSchema: '"just-a-string"' }))).code).toBe("OK");
  });

  it("scope 非法 → INVALID", async () => {
    expect((await store.save(mkAsset({ scope: "team" as never }))).code).toBe("INVALID");
  });
});

describe("IO 边界", () => {
  it("目录不存在自动创建(含嵌套路径)", async () => {
    const nested = new WorkflowAssetStore({ dir: join(dir, "a", "b") });
    const r = await nested.save(mkAsset({ name: "deep" }));
    expect(r.code).toBe("OK");
    const got = await nested.get("deep");
    expect(got.asset?.name).toBe("deep");
  });

  it("原子写:成功后不留 tmp 残留,文件是可解析的完整 JSON", async () => {
    await store.save(mkAsset());
    const files = await readdir(dir);
    expect(files).toEqual(["review.json"]);
    expect(files.some((f) => f.startsWith(".tmp-"))).toBe(false);
    const raw = await readFile(join(dir, "review.json"), "utf-8");
    const parsed = JSON.parse(raw) as WorkflowAsset;
    expect(parsed.name).toBe("review");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("坏文件在 list 中跳过并计入 warnings;get 判 INVALID", async () => {
    await store.save(mkAsset({ name: "good" }));
    await writeFile(join(dir, "broken.json"), "{ this is not json", "utf-8");
    const listed = await store.list();
    expect(listed.ok).toBe(true);
    expect(listed.assets.map((a) => a.name)).toEqual(["good"]);
    expect(listed.warnings.some((w) => w.includes("broken.json"))).toBe(true);
    expect((await store.get("broken")).code).toBe("INVALID");
  });

  it("结构不完整的 JSON 文件也算坏文件(跳过,不抛)", async () => {
    await writeFile(join(dir, "half.json"), JSON.stringify({ name: "half", script: "" }), "utf-8");
    const listed = await store.list();
    expect(listed.assets).toEqual([]);
    expect(listed.warnings).toHaveLength(1);
  });

  it("stats 汇总数量 / 作用域分布 / 内容体量 / 最近更新时间", async () => {
    await store.save(mkAsset({ name: "p1", scope: "project" }));
    await store.save(mkAsset({ name: "p2", scope: "project" }));
    await store.save(mkAsset({ name: "g1", scope: "global" }));
    const s = await store.stats();
    expect(s.ok).toBe(true);
    expect(s.code).toBe("OK");
    expect(s.count).toBe(3);
    expect(s.byScope).toEqual({ project: 2, global: 1 });
    expect(s.totalBytes).toBeGreaterThan(0);
    expect(s.names).toEqual(["g1", "p1", "p2"]);
    expect(s.latestUpdatedAt).toBeGreaterThan(0);
    expect(s.warnings).toEqual([]);
  });

  it("未注入 dir 时默认目录位于系统临时目录下(不向 /tmp 之外写)", () => {
    const def = new WorkflowAssetStore();
    expect(def.dir.startsWith(tmpdir())).toBe(true);
    expect(def.dir).toContain("genie-workflow-assets");
  });
});
