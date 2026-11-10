/**
 * M128 工具渐进披露与目录预算:bridge 固定(tool_view/tool_search/tool_call)、
 * 目录 full→names→summary→bare→none 降级、tool_search 加权排序+分页、
 * tool_call 只桥接只读延迟工具(按底层 schema 校验必参)、装配失败回退原列表。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  attachToolView,
  buildToolCatalog,
  scoreToolMatch,
  CORE_NEVER_DEFER,
  BRIDGE_TOOL_NAMES,
  TOOL_CATALOG_MAX_CHARS,
  TOOL_DEFER_MIN_CHARS,
} from "../src/tool-view.js";
import type { Tool } from "@lampgenie/runtime/agent/loop";

/** 体量足够触发 defer 的长描述(> TOOL_DEFER_MIN_CHARS)。 */
const LONG = "大工具描述".repeat(640); // 3200 字符,无中文句号 → firstSentence 截 200

type Extra = {
  required?: string[];
  /** true/缺省=只读;false=显式非只读;"absent"=不声明 isReadOnly */
  readOnly?: boolean | "absent";
  run?: (args: unknown) => string;
};

function mk(name: string, description: string, extra: Extra = {}): Tool {
  const readOnly = extra.readOnly ?? true;
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {},
      ...(extra.required ? { required: extra.required } : {}),
    },
    isConcurrencySafe: () => true,
    ...(readOnly === "absent" ? {} : { isReadOnly: () => readOnly }),
    async execute(args: unknown) {
      return extra.run ? extra.run(args) : "ok";
    },
  };
}

const byName = (ts: Tool[]) => new Map(ts.map((t) => [t.name, t]));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defer 判定与核心/bridge 不延迟", () => {
  it("大体量非核心工具打 deferred;bridge 与核心工具(含 ask_user)豁免;defer=false 全不延迟", () => {
    const out = attachToolView([mk("big_tool", LONG), mk("ask_user", LONG), mk("small", "小工具")], {
      defer: true,
      deferMinChars: TOOL_DEFER_MIN_CHARS,
    });
    const by = byName(out);
    expect(by.get("big_tool")!.deferred).toBe(true);
    expect(by.get("small")!.deferred).toBeUndefined();
    // 核心工具即使体量超阈值也不延迟(ask_user 是本轮补进 CORE_NEVER_DEFER 的)
    expect(CORE_NEVER_DEFER.has("ask_user")).toBe(true);
    expect(by.get("ask_user")!.deferred).toBeUndefined();
    // bridge 三件套常驻
    for (const n of ["tool_view", "tool_search", "tool_call"]) {
      expect(BRIDGE_TOOL_NAMES.has(n), `${n} 应在 bridge 集`).toBe(true);
      expect(by.get(n), `${n} 应被装配`).toBeTruthy();
      expect(by.get(n)!.deferred, `${n} 不应延迟`).toBeUndefined();
    }

    const off = attachToolView([mk("big_tool", LONG)], { defer: false });
    expect(byName(off).get("big_tool")!.deferred).toBeUndefined();
    expect(byName(off).has("tool_search")).toBe(true);
  });
});

describe("tool_search 加权排序与分页", () => {
  it("name 命中(3 分)排在仅 description 命中(1 分)之前;同分按 name 字典序;limit 截断", async () => {
    const tools = [
      mk("viz_tool", `支持 graph 可视化。${LONG}`), // 仅 description 命中 → 1
      mk("graph_reader", `读取用。${LONG}`), // name 命中 → 3
      mk("graph_viz", `graph 相关。${LONG}`), // name+description → 4
    ];
    const out = attachToolView(tools, { defer: true, deferMinChars: TOOL_DEFER_MIN_CHARS });
    const search = byName(out).get("tool_search")!;
    const text = String(await search.execute({ query: "Graph", limit: 2 }));
    expect(text.indexOf("graph_viz")).toBeGreaterThan(-1);
    expect(text.indexOf("graph_viz")).toBeLessThan(text.indexOf("graph_reader"));
    expect(text).not.toContain("viz_tool"); // limit=2 分页截掉第 3 名
    expect(text).toContain("还有 1 个未显示");

    // 同分按 name 字典序:alpha_scan 与 beta_scan 都 name 命中(report)…用两个同分项验序
    const tie = attachToolView(
      [mk("zeta_scan", `扫描。${LONG}`), mk("alpha_scan", `扫描。${LONG}`)],
      { defer: true, deferMinChars: TOOL_DEFER_MIN_CHARS },
    );
    const tieText = String(await byName(tie).get("tool_search")!.execute({ query: "scan" }));
    expect(tieText.indexOf("alpha_scan")).toBeLessThan(tieText.indexOf("zeta_scan"));

    // 打分纯函数口径
    expect(scoreToolMatch("graph", "graph_viz", "无关")).toBe(3);
    expect(scoreToolMatch("graph", "viz_tool", "支持 graph")).toBe(1);
  });

  it("negative 零命中:返回「无匹配」并给目录总数", async () => {
    const out = attachToolView(
      [mk("alpha", LONG), mk("beta", LONG)],
      { defer: true, deferMinChars: TOOL_DEFER_MIN_CHARS },
    );
    const text = String(await byName(out).get("tool_search")!.execute({ query: "zzz-nothing" }));
    expect(text).toContain("无匹配");
    expect(text).toContain("共 2 个");
  });
});

describe("tool_call 桥接只读延迟工具", () => {
  it("negative 未知/非延迟/非只读一律明确拒绝(非只读给「需直接调用」文案)", async () => {
    const out = attachToolView(
      [
        mk("ro_deferred", `只读大工具。${LONG}`, { required: ["path"], run: (a) => `got:${(a as { path: string }).path}` }),
        mk("rw_deferred", `写类大工具。${LONG}`, { readOnly: false }),
        mk("undeclared_deferred", `没声明只读的大工具。${LONG}`, { readOnly: "absent" }),
        mk("small_tool", "小工具"),
      ],
      { defer: true, deferMinChars: TOOL_DEFER_MIN_CHARS },
    );
    const call = byName(out).get("tool_call")!;

    expect(String(await call.execute({ name: "no_such_tool", arguments: {} }))).toContain("未知工具");
    expect(String(await call.execute({ name: "small_tool", arguments: {} }))).toContain("不是延迟加载工具");

    const rw = String(await call.execute({ name: "rw_deferred", arguments: {} }));
    expect(rw).toContain("需直接调用");
    expect(rw).toContain("只桥接只读工具");
    expect(rw).toContain("避免绕过审批");

    // isReadOnly 未声明 ≠ 只读(必须显式 === true)
    expect(String(await call.execute({ name: "undeclared_deferred", arguments: {} }))).toContain("需直接调用");
  });

  it("缺参报字段名;参数齐备则转发到底层 execute 并原样返回结果", async () => {
    const out = attachToolView(
      [
        mk("ro_deferred", `只读大工具。${LONG}`, {
          required: ["path", "offset"],
          run: (a) => `forwarded:${JSON.stringify(a)}`,
        }),
      ],
      { defer: true, deferMinChars: TOOL_DEFER_MIN_CHARS },
    );
    const call = byName(out).get("tool_call")!;

    const missing = String(await call.execute({ name: "ro_deferred", arguments: { path: "/tmp/a" } }));
    expect(missing).toContain("缺少必填参数");
    expect(missing).toContain("offset");
    expect(missing).toContain("缺少必填参数:offset("); // 缺的字段名点名,已给的 path 不进缺失集

    const ok = String(await call.execute({ name: "ro_deferred", arguments: { path: "/tmp/a", offset: 3 } }));
    expect(ok).toBe('forwarded:{"path":"/tmp/a","offset":3}');
  });
});

describe("目录预算降级 full→names→summary→bare→none", () => {
  it("默认预算 4000;不足则逐档降级,tool_view 目录文本与档位一致", () => {
    expect(TOOL_CATALOG_MAX_CHARS).toBe(4000);
    const full = new Map([mk("a1", "描述。"), mk("a2", "描述。"), mk("a3", "描述。")].map((t) => [t.name, t]));

    // none:没有延迟工具 → 不写目录
    expect(buildToolCatalog([], full).mode).toBe("none");
    // full:名字+首句(默认预算足够)
    const f = buildToolCatalog(["a1", "a2", "a3"], full);
    expect(f.mode).toBe("full");
    expect(f.text).toBe("a1(描述…),a2(描述…),a3(描述…)");
    // names:装不下 full,但名字列表装得下
    const n = buildToolCatalog(["a1", "a2", "a3"], full, 20);
    expect(n.mode).toBe("names");
    expect(n.text).toBe("a1,a2,a3");
    // summary:名字列表也装不下 → 前若干个 + 计数提示
    const many = Array.from({ length: 20 }, (_, i) => `n${String(i).padStart(2, "0")}`);
    const manyMap = new Map(many.map((x) => [x, mk(x, "描述。")]));
    const s = buildToolCatalog(many, manyMap, 40);
    expect(s.mode).toBe("summary");
    expect(s.text.length).toBeLessThanOrEqual(40);
    expect(s.text).toContain("tool_search");
    // bare:预算小到连摘要都放不下 → 硬截断并以逗号收尾
    const b = buildToolCatalog(many, manyMap, 10);
    expect(b.mode).toBe("bare");
    expect(b.text.length).toBe(10);
    expect(b.text.endsWith(",")).toBe(true);
  });

  it("tool_view 的 description 携带降级后的目录(不超预算),tool_search 只写方法不含全量目录", () => {
    const tools = [mk("big_tool", LONG), mk("huge_tool", LONG)];
    const out = attachToolView(tools, { defer: true, deferMinChars: TOOL_DEFER_MIN_CHARS, catalogMaxChars: 12 });
    const tv = byName(out).get("tool_view")!;
    expect(tv.description).toContain("目录");
    expect(tv.description).toContain("big_tool"); // 降级(bare 截断)后仍点名可用工具
    expect(byName(out).get("tool_search")!.description).not.toContain("big_tool(");
    expect(byName(out).get("tool_search")!.description).toContain("limit");
  });
});

describe("装配失败回退", () => {
  it("negative 装配抛异常时原样返回入参工具列表,console.error 只打一次", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom: Tool = {
      name: "boom",
      get description(): string {
        throw new Error("assembly boom");
      },
      parameters: { type: "object", properties: {} },
      async execute() {
        return "never";
      },
    };
    const input: Tool[] = [boom];
    const out = attachToolView(input);
    expect(out).toBe(input); // 逐引用相同:未包装、未丢工具
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
