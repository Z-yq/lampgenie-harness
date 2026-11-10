/**
 * 全景修复线 fixture 单测:
 * ① RC-A2① isTestPath 全族(Go/Java/spec 形态)+ 入口降权;
 * ② RC-A1 modulemap 目录拓扑聚类(fast path 不变 + cobra/redash/agent_alpha 三形);
 * ③ RC-A2② JSX 使用证据 → 入口判定(dynamic 别名/命名 import/同文件/负例);
 * ④ RC-A3 profile 骨架去测试污染(entrypoints 过滤 + 框架指纹非测试锚偏好);
 * ⑤ RC-B6 impact 渲染过度声明收敛(措辞断言)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildC2fIndex, saveIndex, queryEntryPoints,
  type C2fIndex,
} from "../src/callgraph/c2f";
import { isTestPath } from "../src/path-filter";
import { renderImpact, type ImpactResult } from "../src/callgraph/impact";
import { deriveModules } from "../src/modulemap/index";
import { buildSkeleton, detectFrameworks } from "../src/project-profile";

// ---- ① RC-A2① isTestPath 全族 ----
describe(" RC-A2① isTestPath 语言族形态", () => {
  it("Go/Java/spec 形态全收;相近命名不误伤", () => {
    // 新增形态
    expect(isTestPath("command_test.go")).toBe(true); // Go(RC-096-B1 实测确认缺口)
    expect(isTestPath("pkg/foo/bar_test.go")).toBe(true);
    expect(isTestPath("TestCommand.java")).toBe(true); // Java Test 前缀
    expect(isTestPath("CommandTest.java")).toBe(true); // Java Test 后缀
    expect(isTestPath("CommandTests.java")).toBe(true);
    expect(isTestPath("src/foo.spec.ts")).toBe(true); // spec 中缀
    expect(isTestPath("src/foo.spec.tsx")).toBe(true);
    // 旧形态不回退
    expect(isTestPath("tests/test_big.py")).toBe(true);
    expect(isTestPath("__tests__/x.ts")).toBe(true);
    expect(isTestPath("test_x.py")).toBe(true);
    expect(isTestPath("x_test.py")).toBe(true);
    expect(isTestPath("x.test.ts")).toBe(true);
    // 负例:相近命名/生产文件不误伤
    expect(isTestPath("contest.java")).toBe(false); // 小写 test 不算
    expect(isTestPath("Testify.java")).toBe(false); // Test+小写后续不算
    expect(isTestPath("command.go")).toBe(false);
    expect(isTestPath("src/server.py")).toBe(false);
    expect(isTestPath("src/spec.ts")).toBe(false); // spec 作文件名主体不算
  });

  it("queryEntryPoints:Go 测试入口降到生产入口之后(旧索引查询侧即时生效,无需重建)", () => {
    // 直接构造索引对象(isTestPath 是查询侧判定——096 的 cobra 盘存索引无需重建即受益)
    const idx = {
      version: 1, root: "/x", gitHead: "", builtAt: 0, buildMs: 0,
      nodes: [
        { id: "command.go#Execute", name: "Execute", file: "command.go", line: 1, kind: "trunk", outCount: 2, inCount: 0 },
        { id: "command_test.go#TestBig", name: "TestBig", file: "command_test.go", line: 1, kind: "trunk", outCount: 9, inCount: 0 },
      ],
      edges: [], byFile: {}, byName: {},
    } as unknown as C2fIndex;
    const eps = queryEntryPoints(idx, 10);
    expect(eps[0]!.name).toBe("Execute"); // 生产在前(尽管下游更少)
    expect(eps[1]!.name).toBe("TestBig"); // 测试靠后不隐瞒
  });
});

// ---- ② RC-A1 modulemap 拓扑聚类 ----
describe(" RC-A1 modulemap 目录拓扑聚类", () => {
  it("fast path 不变:packages/apps 布局仍走旧口径", () => {
    const mods = deriveModules(["packages/core/src/a.ts", "apps/gateway/src/main.ts", "README.md"]);
    const names = mods.map((m) => m.name);
    expect(names).toContain("packages/core");
    expect(names).toContain("apps/gateway");
    expect(names).toContain("(root)");
  });

  it("go-cobra 形:目录即包,(root)+doc 双模块(旧版恒唯一 (root))", () => {
    const files = [
      ...Array.from({ length: 5 }, (_, i) => `cmd${i}.go`),
      "doc/man.go", "doc/md.go",
    ];
    const mods = deriveModules(files);
    const names = mods.map((m) => m.name);
    expect(names).toContain("(root)");
    expect(names).toContain("doc");
    expect(mods.length).toBe(2);
  });

  it("poly-redash 形:py 目录包/client 前两段/viz-lib src 子目录", () => {
    const files = [
      "client/app/components/a.jsx", "client/app/pages/b.js", "client/cypress/c.js",
      "viz-lib/src/editor/d.tsx", "viz-lib/src/e.ts",
      "redash/query_runner/pg.py", "redash/handlers/q.py", "redash/models/__init__.py", "redash/cli.py",
      "tests/test_q.py", "migrations/versions/001.py",
    ];
    const names = deriveModules(files).map((m) => m.name);
    expect(names).toContain("client/app");
    expect(names).toContain("client/cypress");
    expect(names).toContain("viz-lib/src/editor");
    expect(names).toContain("viz-lib/src");
    expect(names).toContain("redash/query_runner");
    expect(names).toContain("redash/handlers");
    expect(names).toContain("redash/models");
    expect(names).toContain("redash");
    expect(names).toContain("tests");
    expect(names).toContain("migrations/versions");
    expect(names).not.toContain("(root)"); // 无根级散文件时不出 (root)
  });

  it("agent_alpha 形:深层 py 按 2 层聚合到业务目录,frontend/src 子目录识别", () => {
    const files = [
      "modules/agent_modules_v2/chat_handler/a.py", "modules/agent_modules_v2/nodes/b.py",
      "frontend/src/components/c.tsx", "frontend/src/app/d.tsx",
      "voice_interaction/e.py", "scripts/f.py", "main.py",
    ];
    const names = deriveModules(files).map((m) => m.name);
    expect(names).toContain("modules/agent_modules_v2"); // 深层 py 包按 2 层聚合
    expect(names).not.toContain("modules/agent_modules_v2/chat_handler");
    expect(names).toContain("frontend/src/components");
    expect(names).toContain("frontend/src/app");
    expect(names).toContain("voice_interaction");
    expect(names).toContain("scripts");
    expect(names).toContain("(root)"); // main.py 落 (root)
  });

  it("排序=文件数降序;超 24 目录并入 (misc) 且如实登记", () => {
    const files: string[] = [];
    for (let i = 0; i < 26; i++) files.push(`dir${String(i).padStart(2, "0")}/x.py`);
    files.push("big/a.py", "big/b.py", "big/c.py");
    const mods = deriveModules(files);
    expect(mods[0]!.name).toBe("big"); // 文件数最多排首
    const misc = mods.find((m) => m.name === "(misc)");
    expect(misc).toBeTruthy();
    expect(misc!.responsibility).toContain("其余 3 个目录共 3 个源文件"); // 27 目录 - 24 保留 = 3
    expect(mods.length).toBe(25); // 24 + (misc)
  });

  it("入口启发式:__main__.py/main.go 优先;依赖不猜(dependsOn 为空)", () => {
    const mods = deriveModules(["svc/worker.py", "svc/__main__.py"]);
    expect(mods[0]!.entryFile).toBe("svc/__main__.py");
    expect(mods[0]!.dependsOn).toEqual([]);
  });
});

// ---- ③ RC-A2② JSX 使用证据 → 入口判定 ----
describe(" RC-A2② JSX 使用证据降权", () => {
  it("dynamic(() => import) 别名 + 别名路径(@/*):被用组件不再伪入口(agent_alpha RTCCard 实测确认形态)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-s098-jsxd-"));
    try {
      mkdirSync(join(dir, "components/Dynamic"), { recursive: true });
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }));
      writeFileSync(join(dir, "page.tsx"), [
        'import dynamic from "next/dynamic";',
        'const DynamicRTCCard = dynamic(() => import("@/components/Dynamic/RTCCard"));',
        "export default function Home(): any {",
        '  return <DynamicRTCCard className="x" />;',
        "}",
      ].join("\n"));
      writeFileSync(join(dir, "components/Dynamic/RTCCard.tsx"), [
        "export default function RTCCard(props: { className?: string }): any {",
        "  return <div className={props.className} />;",
        "}",
      ].join("\n"));
      const idx = await buildC2fIndex(dir);
      const rtc = idx.nodes.find((n) => n.name === "RTCCard");
      expect(rtc).toBeTruthy();
      expect(rtc!.kind).not.toBe("trunk"); // 修复前:恒 trunk(伪入口)
      const eps = queryEntryPoints(idx, 10).map((n) => n.name);
      expect(eps).not.toContain("RTCCard");
      expect(eps).toContain("Home"); // 真入口不受影响
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("命名 import JSX + 同文件 JSX 降权;未被引用的组件保持 trunk(零证据不猜)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-s098-jsxn-"));
    try {
      writeFileSync(join(dir, "Widget.tsx"), "export function Widget(): any { return <span />; }\n");
      writeFileSync(join(dir, "Unused.tsx"), "export function Unused(): any { return <i />; }\n");
      writeFileSync(join(dir, "page2.tsx"), [
        'import { Widget } from "./Widget";',
        "function Local(): any { return <b />; }",
        "export default function Page2(): any {",
        "  return (<div><Widget /><Local /></div>);",
        "}",
      ].join("\n"));
      const idx = await buildC2fIndex(dir);
      const kindOf = (name: string) => idx.nodes.find((n) => n.name === name)?.kind;
      expect(kindOf("Widget")).not.toBe("trunk"); // 命名 import 的 JSX 使用
      expect(kindOf("Local")).not.toBe("trunk"); // 同文件定义+同文件 JSX 使用
      expect(kindOf("Unused")).toBe("trunk"); // 零证据:保持入口判定(诚实)
      expect(kindOf("Page2")).toBe("trunk"); // 真入口
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("默认 import 本地名≠basename(CameraBlock 形态)+ index barrel 一跳(SceneViewer 形态)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-s098-jsxb-"));
    try {
      mkdirSync(join(dir, "components/Agent"), { recursive: true });
      mkdirSync(join(dir, "components/Scene"), { recursive: true });
      // Camera 形态:默认导入本地名 CameraBlock,文件 Camera.tsx(basename 配不上,本地名配)
      writeFileSync(join(dir, "components/Agent/Camera.tsx"), "export function CameraBlock(): any { return <video />; }\n");
      // Scene 形态:默认导入经 index barrel(export { SceneViewer } from "./SceneViewer")
      writeFileSync(join(dir, "components/Scene/index.ts"), 'export { SceneViewer } from "./SceneViewer";\n');
      writeFileSync(join(dir, "components/Scene/SceneViewer.tsx"), "export function SceneViewer(): any { return <canvas />; }\n");
      writeFileSync(join(dir, "host.tsx"), [
        'import CameraBlock from "./components/Agent/Camera";',
        'import SceneViewer from "./components/Scene";',
        "export default function Host(): any {",
        "  return (<section><CameraBlock /><SceneViewer /></section>);",
        "}",
      ].join("\n"));
      const idx = await buildC2fIndex(dir);
      const kindOf = (name: string) => idx.nodes.find((n) => n.name === name)?.kind;
      expect(kindOf("CameraBlock")).not.toBe("trunk"); // 默认 import 本地名归属
      expect(kindOf("SceneViewer")).not.toBe("trunk"); // index barrel 一跳归属
      expect(kindOf("Host")).toBe("trunk"); // 真入口
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// ---- ④ RC-A3 profile 骨架去测试污染 ----
describe(" RC-A3 profile 骨架去测试污染", () => {
  it("骨架 entrypoints 只含生产入口;框架指纹证据锚偏好非测试文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-s098-prof-"));
    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      writeFileSync(join(dir, "server.py"), [
        "def dispatch(msg):",
        "    return handle_a(msg) + handle_b(msg)",
        "",
        "def handle_a(m):",
        "    return 1",
        "",
        "def handle_b(m):",
        "    return 2",
        "",
      ].join("\n"));
      writeFileSync(join(dir, "tests", "test_big.py"), [
        "class TestHuge:",
        "    def test_many(self):",
        "        return t1() + t2() + t3() + t4()",
        "",
        "def t1(): return 1",
        "def t2(): return 1",
        "def t3(): return 1",
        "def t4(): return 1",
        "",
      ].join("\n"));
      writeFileSync(join(dir, "app.py"), "from flask import Flask\napp = Flask(__name__)\n");
      writeFileSync(join(dir, "tests", "test_flask.py"), "from flask import Flask\n\ndef test_app():\n    assert Flask\n");
      const idx = await buildC2fIndex(dir);
      saveIndex(dir, idx);
      const { skeleton } = await buildSkeleton(dir);
      const eps = skeleton.entrypoints ?? [];
      expect(eps.some((e) => e.includes("dispatch"))).toBe(true);
      expect(eps.every((e) => !e.includes("test_many") && !e.includes("test_"))).toBe(true); // 测试入口不进骨架
      // 框架指纹:app.py 与 tests/test_flask.py 都含 flask 字面量 → 证据锚必须落非测试文件
      const flask = skeleton.frameworks.find((f) => f.name === "Flask");
      expect(flask).toBeTruthy();
      expect(flask!.evidence.file).toBe("app.py");
      // detectFrameworks 独立验证一次(全测试命中时回退首个,如实)
      const fwOnlyTest = await detectFrameworks(dir);
      expect(fwOnlyTest.frameworks.find((f) => f.name === "Flask")!.evidence.file).toBe("app.py");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// ---- ⑤ RC-B6 impact 渲染措辞 ----
describe(" RC-B6 impact 渲染不过度声明", () => {
  it("trunk 标签与空调用方文案=「索引内无」口径,不直判无人调用/无波及", () => {
    const r: ImpactResult = {
      query: "f", depth: 2,
      definitions: [{
        symbol: { id: "a.ts#f", name: "f", file: "a.ts", line: 1, kind: "trunk", outCount: 0, inCount: 0 },
        callers: [], callees: [],
      }],
      files: [], tests: [], importChannel: true, truncated: false,
 // renderImpact 的弃边末节契约:dropped 恒在场(ledgerAvailable=false=旧索引形态)
      dropped: { ledgerAvailable: false, unresolvedEdges: 0, ledgerTruncated: false },
      summary: { directCallers: 0, directCallees: 0, transitiveCallers: 0, transitiveCallees: 0, fileCount: 0, testCount: 0 },
    };
    const text = renderImpact(r);
    expect(text).toContain("入口(trunk,索引内无调用方)");
    expect(text).toContain("上游调用方: 索引内无");
    expect(text).not.toContain("无人调用");
    expect(text).not.toContain("改动无上游波及"); // 旧过度声明措辞绝迹
  });
});
