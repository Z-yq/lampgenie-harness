/**
 * module-brief-store(IO 层)单测:全部用 /tmp 临时 workspace 夹具,不碰仓内 .genie。
 *
 * 夹具:root=/tmp/module-brief-store-XXXX(临时目录),内含 packages/a、packages/b、packages/noentry、apps/app 与 .genie/arch-policy.json
 * - packages/a:CONTRACT.md + README.md + src/index.ts(各种 export 形态)+ 1 个工作区 dep + 1 个外部 dep
 * - packages/b:只有 README.md;policy root 为其子目录(packages/b/src)且无 owner
 * - packages/noentry:无契约、无 index.ts、不在 policy 内
 * - apps/app:无契约、无 index.ts、dep 指向无契约的 noentry
 *
 * 覆盖:定位三态(相对/绝对/包名)、越界拒绝、包名不存在、managed+owner 缺失、UNMANAGED、
 * CONTRACT.md 优先 / 只有 README / 两契约都缺、deps 过滤与 dep 契约缺失码、entries 名字+行号(不含实现)、
 * 无 index 的 missing 文本、arch-policy 缺失、chars 一致性、CLI 参数错/--help/--json/--out/exit 码。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectBrief, collectBriefDetailed, collectBriefResult, runModuleBriefCli } from "../src/module-brief-store.ts";

const INDEX_LINES = [
  "// a 包公开入口(仅占位,不含业务实现)",
  "",
  "export function alpha(): number {",
  "  return 1;",
  "}",
  "",
  "export async function beta(): Promise<void> {}",
  "export class Gamma {}",
  "export const DELTA = 4;",
  "export let eps = 5;",
  "export type Zeta = string;",
  "export interface Eta { x: number }",
  'export { theta, iota as kappa } from "./impl";',
  'export * from "./impl";',
  "",
];

const POLICY = {
  version: 1,
  layers: [
    { name: "app", mayImport: ["app", "pkg"] },
    { name: "pkg", mayImport: ["pkg"] },
  ],
  modules: [
    { id: "a", root: "packages/a", layer: "pkg", managed: true, owner: "team-a" },
    { id: "b", root: "packages/b/src", layer: "pkg", managed: true },
    { id: "app", root: "apps/app", layer: "app", managed: true, owner: "team-app" },
  ],
};

const roots: string[] = [];

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function json(root: string, rel: string, value: unknown): void {
  writeFile(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

let ws = "";
let plainWs = "";

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "module-brief-store-"));
  roots.push(ws);
  json(ws, ".genie/arch-policy.json", POLICY);

  // packages/a:双契约 + 全形态入口 + 工作区 dep + 外部 dep
  json(ws, "packages/a/package.json", {
    name: "@lampgenie/a",
    description: "A 包描述",
    dependencies: { "@lampgenie/b": "workspace:^", lodash: "^4.17.21" },
    devDependencies: { vitest: "^3.0.0" },
  });
  writeFile(ws, "packages/a/CONTRACT.md", "# A 契约\n\nA 的契约段落:只做单元级纯逻辑。\n");
  writeFile(ws, "packages/a/README.md", "# A readme\n\nreadme 段落(不应被摘要)。\n");
  writeFile(ws, "packages/a/src/index.ts", INDEX_LINES.join("\n"));

  // packages/b:只有 README;policy root 落在其子目录且缺 owner
  json(ws, "packages/b/package.json", {
    name: "@lampgenie/b",
    description: "B 包描述",
    dependencies: { "left-pad": "^1.3.0" },
  });
  writeFile(ws, "packages/b/README.md", "# B readme\n\nB 的 readme 段落。\n");

  // packages/noentry:无契约、无 index.ts、不在 policy
  json(ws, "packages/noentry/package.json", { name: "@lampgenie/noentry", description: "无入口包" });
  mkdirSync(join(ws, "packages/noentry/src"), { recursive: true });
  writeFile(ws, "packages/noentry/src/other.ts", "export const other = 1;\n");

  // apps/app:无契约、无 index.ts,dep 指向无契约的 noentry
  json(ws, "apps/app/package.json", {
    name: "@lampgenie/app",
    description: "app 描述",
    dependencies: { "@lampgenie/a": "workspace:*", "@lampgenie/noentry": "workspace:^", zod: "^3.0.0" },
  });

  // 无 arch-policy 的 root
  plainWs = mkdtempSync(join(tmpdir(), "module-brief-no-policy-"));
  roots.push(plainWs);
  json(plainWs, "packages/x/package.json", { name: "@lampgenie/x", description: "x 包" });
  writeFile(plainWs, "packages/x/README.md", "# X\n\nx 段落。\n");
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("定位三态", () => {
  it("按相对路径定位到 packages/a", async () => {
    const { brief, codes } = await collectBriefResult(ws, { module: "packages/a" });
    expect(brief.identity.name).toBe("a");
    expect(brief.identity.path).toBe("packages/a");
    expect(brief.identity.packageName).toBe("@lampgenie/a");
    expect(brief.identity.description).toBe("A 包描述");
    expect(brief.identity.managed).toBe(true);
    expect(brief.identity.layer).toBe("pkg");
    expect(brief.identity.owner).toBe("team-a");
    expect(codes).toContain("BRIEF_BUILT");
    expect(brief.chars).toBe(brief.rendered.length);
  });

  it("按绝对路径定位到同一个模块", async () => {
    const { brief } = await collectBriefResult(ws, { module: join(ws, "packages", "a") });
    expect(brief.identity.path).toBe("packages/a");
    expect(brief.identity.owner).toBe("team-a");
  });

  it("按包名定位到 packages/b", async () => {
    const { brief } = await collectBriefResult(ws, { module: "@lampgenie/b" });
    expect(brief.identity.name).toBe("b");
    expect(brief.identity.path).toBe("packages/b");
    expect(brief.identity.packageName).toBe("@lampgenie/b");
  });

  it("root 外的绝对路径被拒绝且不抛", async () => {
    const result = await collectBriefDetailed(ws, { module: "/etc" });
    expect(result.status).toBe("outside-root");
    expect(result.codes).toContain("BRIEF_INVALID");
    expect(result.brief.missing.join("|")).toContain("模块路径不在 root 内:/etc");
    expect(result.brief.chars).toBe(result.brief.rendered.length);
  });

  it("相对路径越界同样被拒绝", async () => {
    const result = await collectBriefDetailed(ws, { module: "../outside-module" });
    expect(result.status).toBe("outside-root");
    expect(result.codes).toContain("BRIEF_INVALID");
    expect(result.brief.missing.join("|")).toContain("模块路径不在 root 内:../outside-module");
  });

  it("包名不存在 → BRIEF_INVALID + 无法解析包名", async () => {
    const result = await collectBriefDetailed(ws, { module: "@lampgenie/ghost" });
    expect(result.status).toBe("unresolved");
    expect(result.codes).toContain("BRIEF_INVALID");
    expect(result.brief.missing.join("|")).toContain("无法解析包名:@lampgenie/ghost");
  });
});

describe("arch-policy 匹配", () => {
  it("policy root 在模块目录之下且唯一时命中,缺 owner 报 BRIEF_OWNER_MISSING", async () => {
    const { brief, codes } = await collectBriefResult(ws, { module: "packages/b" });
    expect(brief.identity.managed).toBe(true);
    expect(brief.identity.layer).toBe("pkg");
    expect(brief.identity.owner).toBeUndefined();
    expect(codes).toContain("BRIEF_OWNER_MISSING");
    expect(brief.missing.join("|")).toContain("owner 缺失");
  });

  it("policy 无匹配模块 → managed=false + BRIEF_UNMANAGED", async () => {
    const { brief, codes } = await collectBriefResult(ws, { module: "packages/noentry" });
    expect(brief.identity.managed).toBe(false);
    expect(brief.identity.layer).toBeUndefined();
    expect(codes).toContain("BRIEF_UNMANAGED");
  });

  it("arch-policy 不存在时不抛,managed=false 且 missing 明说缺失", async () => {
    const { brief, codes } = await collectBriefResult(plainWs, { module: "packages/x" });
    expect(brief.identity.managed).toBe(false);
    expect(codes).toContain("BRIEF_UNMANAGED");
    expect(brief.missing.join("|")).toContain("arch-policy 缺失");
    expect(brief.chars).toBe(brief.rendered.length);
  });

  it("允许边按 layers.mayImport 展开(from=模块名,to=允许层名)", async () => {
    const { brief } = await collectBriefResult(ws, { module: "apps/app" });
    expect(brief.allowedEdges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["app->app", "app->pkg"]);
  });
});

describe("契约采集", () => {
  it("CONTRACT.md 优先于 README.md", async () => {
    const { brief } = await collectBriefResult(ws, { module: "packages/a" });
    expect(brief.contract.present).toBe(true);
    expect(brief.contract.path).toBe("packages/a/CONTRACT.md");
    expect(brief.contract.summary).toContain("A 的契约段落");
    expect(brief.contract.summary).not.toContain("readme 段落");
  });

  it("只有 README 时用 README 作契约", async () => {
    const { brief, codes } = await collectBriefResult(ws, { module: "packages/b" });
    expect(brief.contract.present).toBe(true);
    expect(brief.contract.path).toBe("packages/b/README.md");
    expect(codes).not.toContain("BRIEF_CONTRACT_MISSING");
  });

  it("两契约都缺 → BRIEF_CONTRACT_MISSING", async () => {
    const { brief, codes } = await collectBriefResult(ws, { module: "apps/app" });
    expect(brief.contract.present).toBe(false);
    expect(codes).toContain("BRIEF_CONTRACT_MISSING");
  });
});

describe("依赖采集", () => {
  it("只保留一层工作区依赖并明说过滤数量", async () => {
    const { brief } = await collectBriefResult(ws, { module: "packages/a" });
    expect(brief.deps.map((dep) => dep.name)).toEqual(["@lampgenie/b"]);
    const b = brief.deps[0];
    expect(b?.path).toBe("packages/b");
    expect(b?.contractPresent).toBe(true);
    expect(b?.layer).toBe("pkg");
    expect(b?.allowedEdge).toBe(true);
    expect(brief.missing.join("|")).toContain("已过滤 1 个外部依赖");
    expect(brief.missing.join("|")).not.toContain("vitest");
  });

  it("dep 缺契约 → BRIEF_DEP_CONTRACT_MISSING(码只出一次)", async () => {
    const { brief, codes } = await collectBriefResult(ws, { module: "apps/app" });
    const names = brief.deps.map((dep) => dep.name);
    expect(names).toEqual(["@lampgenie/a", "@lampgenie/noentry"]);
    expect(brief.deps[1]?.contractPresent).toBe(false);
    expect(codes.filter((code) => code === "BRIEF_DEP_CONTRACT_MISSING")).toHaveLength(1);
    expect(brief.missing.join("|")).toContain("依赖契约缺失: @lampgenie/noentry");
    expect(brief.missing.join("|")).toContain("已过滤 1 个外部依赖");
  });
});

describe("入口采集", () => {
  it("解析 export 名字与行号,kind 按类型映射,不复制实现", async () => {
    const { brief } = await collectBriefResult(ws, { module: "packages/a" });
    const byName = new Map(brief.entries.map((entry) => [entry.symbol, entry]));
    const expectLine = (symbol: string, line: number, kind: string): void => {
      const entry = byName.get(symbol);
      expect(entry, `缺少入口 ${symbol}`).toBeDefined();
      expect(entry?.line).toBe(line);
      expect(entry?.kind).toBe(kind);
      expect(entry?.file).toBe("packages/a/src/index.ts");
    };
    expectLine("alpha", 3, "function");
    expectLine("beta", 7, "function");
    expectLine("Gamma", 8, "class");
    expectLine("DELTA", 9, "const");
    expectLine("eps", 10, "const");
    expectLine("Zeta", 11, "export");
    expectLine("Eta", 12, "export");
    expectLine("theta", 13, "export");
    expectLine("kappa", 13, "export");
    expect(byName.get("* from ./impl")?.line).toBe(14);
    expect(byName.get("* from ./impl")?.kind).toBe("export");
    expect(brief.entries).toHaveLength(10);
    expect(brief.rendered).toContain("alpha — packages/a/src/index.ts:3");
    expect(brief.rendered).not.toContain("return 1");
  });

  it("无 src/index.ts 与 index.ts → entries 空 + missing 文本", async () => {
    const { brief } = await collectBriefResult(ws, { module: "packages/noentry" });
    expect(brief.entries).toEqual([]);
    expect(brief.missing.join("|")).toContain("入口文件缺失(src/index.ts|index.ts)");
    expect(brief.chars).toBe(brief.rendered.length);
    expect(brief.rendered.split("\n").slice(-1)[0]).toContain("入口文件缺失");
  });
});

describe("CLI 逻辑", () => {
  it("--help exit 0 且打印用法", async () => {
    const result = await runModuleBriefCli(["--help"], ws);
    expect(result.code).toBe(0);
    expect(result.output).toContain("--module");
    expect(result.output).toContain("退出码");
  });

  it("参数错 exit 1(未知参数 / 缺 --module / 取值非法)", async () => {
    const unknown = await runModuleBriefCli(["--module", "packages/a", "--bogus"], ws);
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain("未知参数:--bogus");
    const missing = await runModuleBriefCli([], ws);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("缺少 --module");
    const badNumber = await runModuleBriefCli(["--module", "packages/a", "--max-chars", "abc"], ws);
    expect(badNumber.code).toBe(1);
    expect(badNumber.output).toContain("参数取值非法:--max-chars abc");
  });

  it("默认输出 rendered,exit 0", async () => {
    const result = await runModuleBriefCli(["--module", "packages/a", "--root", "."], ws);
    expect(result.code).toBe(0);
    expect(result.output).toContain("# 模块简报:a");
    expect(result.output).toContain("## ③ 直接依赖");
    expect(result.output).not.toContain('"codes"');
  });

  it("--json 输出结构化字段,exit 0", async () => {
    const result = await runModuleBriefCli(["--module", "@lampgenie/b", "--json"], ws);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.output) as {
      identity: { name: string };
      codes: string[];
      missing: string[];
      chars: number;
      entries: unknown[];
      allowedEdges: unknown[];
    };
    expect(payload.identity.name).toBe("b");
    expect(payload.codes).toContain("BRIEF_BUILT");
    expect(payload.codes).toContain("BRIEF_OWNER_MISSING");
    expect(payload.missing.join("|")).toContain("owner 缺失");
    expect(payload.chars).toBeGreaterThan(0);
    expect(Array.isArray(payload.entries)).toBe(true);
    expect(Array.isArray(payload.allowedEdges)).toBe(true);
  });

  it("--out 只在显式给出时写盘", async () => {
    const target = join(ws, "..", `module-brief-out-${process.pid}.txt`);
    try {
      const result = await runModuleBriefCli(["--module", "packages/b", "--out", target], ws);
      expect(result.code).toBe(0);
      expect(readFileSync(target, "utf8")).toContain("# 模块简报:b");
    } finally {
      rmSync(target, { force: true });
    }
    const noOut = await runModuleBriefCli(["--module", "packages/b"], ws);
    expect(noOut.code).toBe(0);
    expect(noOut.output).toContain("# 模块简报:b");
  });

  it("定位失败 exit 2(越界 / 包名不存在)", async () => {
    const outside = await runModuleBriefCli(["--module", "/etc"], ws);
    expect(outside.code).toBe(2);
    const ghost = await runModuleBriefCli(["--module", "@lampgenie/ghost"], ws);
    expect(ghost.code).toBe(2);
  });

  it("--max-entries 生效且仍保持 chars 一致", async () => {
    const { brief, codes } = await collectBriefResult(ws, { module: "packages/a", maxEntries: 3 });
    expect(brief.entries).toHaveLength(3);
    expect(codes).toContain("BRIEF_TRUNCATED");
    expect(brief.chars).toBe(brief.rendered.length);
  });
});
