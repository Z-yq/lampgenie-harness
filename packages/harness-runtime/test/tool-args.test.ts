/**
 * 工具入参归一与校验诊断(机制)。
 * 契约:
 *  - JSON-string 参数解析;坏 JSON / 非对象字符串 → issue(不是抛错);
 *  - 无歧义 coercion(数字串/布尔串/数组/对象/字符串),不确定则保留原值且不 issue;
 *  - required 缺失 → issue(path/expected=required/got=undefined);改名映射;未知键透传;
 *  - renderToolArgError 固定框 ≤2000 字符、issue ≤10 条。
 */
import { describe, it, expect } from "vitest";
import { normalizeToolArgs, renderToolArgError, type ToolArgIssue } from "../src/agent/tool-args";

const objSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

const pathSchema = objSchema({ path: { type: "string" } }, ["path"]);

describe("normalizeToolArgs:JSON-string 归一", () => {
  it("字符串形态的 JSON 对象被解析并校验通过", () => {
    const r = normalizeToolArgs('{"path":"a.txt"}', pathSchema);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual({ path: "a.txt" });
  });

  it("坏 JSON → issue「JSON 解析失败」,不抛", () => {
    const r = normalizeToolArgs('{"path":', pathSchema);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.path).toBe("$");
    expect(r.issues[0]!.message).toContain("JSON 解析失败");
    expect(r.value).toBe('{"path":'); // 保留原值
  });

  it("非 JSON 形态的字符串(裸文本)→ issue「参数必须是 JSON 对象」", () => {
    const r = normalizeToolArgs("not-json", pathSchema);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.expected).toBe("object");
    expect(r.issues[0]!.message).toContain("参数必须是 JSON 对象");
  });

  it("对象原样通过(不拷贝、不报 issue)", () => {
    const args = { path: "a.txt" };
    const r = normalizeToolArgs(args, pathSchema);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(args);
  });
});

describe("normalizeToolArgs:无歧义 coercion", () => {
  const schema = objSchema({
    n: { type: "number" },
    i: { type: "integer" },
    b: { type: "boolean" },
    list: { type: "array" },
    cfg: { type: "object" },
    s: { type: "string" },
  });

  it('"42" → 42(记录 coerced)', () => {
    const r = normalizeToolArgs({ n: "42" }, schema);
    expect(r.ok).toBe(true);
    expect((r.value as { n: unknown }).n).toBe(42);
    expect(r.coerced).toEqual([{ path: "n", from: "string", to: "number" }]);
  });

  it('"-3.5" → -3.5;整数 schema 同样接受小数串', () => {
    expect((normalizeToolArgs({ n: "-3.5" }, schema).value as { n: unknown }).n).toBe(-3.5);
    expect((normalizeToolArgs({ i: "7" }, schema).value as { i: unknown }).i).toBe(7);
  });

  it('"true" → true,"  FALSE  " → false(大小写/空白忽略)', () => {
    expect((normalizeToolArgs({ b: "true" }, schema).value as { b: unknown }).b).toBe(true);
    expect((normalizeToolArgs({ b: "  FALSE  " }, schema).value as { b: unknown }).b).toBe(false);
  });

  it('裸标量 "a.txt" → ["a.txt"];[1,2] 字符串 → [1,2];对象/数组原样', () => {
    expect((normalizeToolArgs({ list: "a.txt" }, schema).value as { list: unknown }).list).toEqual(["a.txt"]);
    expect((normalizeToolArgs({ list: "[1,2]" }, schema).value as { list: unknown }).list).toEqual([1, 2]);
    const arr = ["x"];
    expect((normalizeToolArgs({ list: arr }, schema).value as { list: unknown }).list).toBe(arr);
  });

  it('数组位置的 {…} 对象原样保留(不猜成 [obj])', () => {
    const cfg = { a: 1 };
    expect((normalizeToolArgs({ list: cfg }, schema).value as { list: unknown }).list).toBe(cfg);
  });

  it('{...} 字符串 → 对象', () => {
    expect((normalizeToolArgs({ cfg: '{"a":1}' }, schema).value as { cfg: unknown }).cfg).toEqual({ a: 1 });
  });

  it("number/boolean → string", () => {
    expect((normalizeToolArgs({ s: 5 }, schema).value as { s: unknown }).s).toBe("5");
    expect((normalizeToolArgs({ s: true }, schema).value as { s: unknown }).s).toBe("true");
  });

  it('"12abc" 与空串:保留原值、不报 issue(不确定不猜)', () => {
    const r1 = normalizeToolArgs({ n: "12abc", list: "", cfg: "not-object" }, schema);
    expect(r1.ok).toBe(true);
    expect(r1.issues).toEqual([]);
    expect((r1.value as { n: unknown }).n).toBe("12abc");
    expect((r1.value as { list: unknown }).list).toBe("");
    expect((r1.value as { cfg: unknown }).cfg).toBe("not-object");
    expect(r1.coerced).toEqual([]);
  });

  it("schema 未声明类型的键不动(不猜)", () => {
    const loose = objSchema({});
    const r = normalizeToolArgs({ n: "42" }, loose);
    expect(r.ok).toBe(true);
    expect((r.value as { n: unknown }).n).toBe("42");
    expect(r.coerced).toEqual([]);
  });
});

describe("normalizeToolArgs:required / 改名 / 未知键", () => {
  it("缺 required → issue(path=字段名, expected=required, got=undefined)", () => {
    const r = normalizeToolArgs({}, pathSchema);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      { path: "path", expected: "required", got: "undefined", message: "缺少必填参数 path" },
    ]);
  });

  it("file_path → path 改名(先改后查 required)", () => {
    const r = normalizeToolArgs({ file_path: "a.txt" }, pathSchema);
    expect(r.ok).toBe(true);
    expect(r.renamed).toEqual([{ from: "file_path", to: "path" }]);
    expect(r.value).toEqual({ path: "a.txt" });
  });

  it("目标键已存在时不改名;schema 未声明目标键时也不改名", () => {
    const r1 = normalizeToolArgs({ file_path: "x", path: "y" }, pathSchema);
    expect(r1.renamed).toEqual([]);
    expect((r1.value as { path: unknown }).path).toBe("y");
    const r2 = normalizeToolArgs({ file_path: "x" }, objSchema({ file_path: { type: "string" } }));
    expect(r2.renamed).toEqual([]);
  });

  it("六条改名映射全部生效", () => {
    const schema = objSchema({
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
      query: { type: "string" },
    });
    const r = normalizeToolArgs(
      { filePath: "p", oldString: "o", newString: "n", replaceAll: "true", query_string: "q" },
      schema);
    expect(r.ok).toBe(true);
    expect(r.renamed.map((x) => `${x.from}->${x.to}`).sort()).toEqual(
      ["filePath->path", "newString->new_string", "oldString->old_string", "query_string->query", "replaceAll->replace_all"].sort(),
    );
    expect(r.value).toEqual({ path: "p", old_string: "o", new_string: "n", replace_all: true, query: "q" });
  });

  it("未知键透传(不报错、不删)", () => {
    const r = normalizeToolArgs({ path: "a", extra: 1 }, pathSchema);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ path: "a", extra: 1 });
  });
});

describe("normalizeToolArgs:零回归透传", () => {
  it("无 schema / schema 非 object → 原值原引用", () => {
    const raw = { anything: "42" };
    expect(normalizeToolArgs(raw).value).toBe(raw);
    expect(normalizeToolArgs(raw, {}).value).toBe(raw);
    expect(normalizeToolArgs(raw, { type: "string" }).value).toBe(raw);
    expect(normalizeToolArgs(raw).issues).toEqual([]);
  });
});

describe("renderToolArgError", () => {
  const issue = (p: string): ToolArgIssue => ({ path: p, expected: "number", got: 'string "x"', message: "类型不符" });

  it("固定框:标题 + 逐条 + 重试指引", () => {
    const out = renderToolArgError("read_file", [issue("path")]);
    expect(out.split("\n")[0]).toBe("[工具参数错误] read_file");
    expect(out).toContain('- path: 期望 number,收到 string "x" — 类型不符');
    expect(out.trimEnd().endsWith("修正后重试;不要改变无关参数。")).toBe(true);
  });

  it("issue >10 条只列 10 条并注明剩余", () => {
    const out = renderToolArgError("t", Array.from({ length: 13 }, (_, i) => issue(`k${i}`)));
    expect(out).toContain("(另有 3 条未列出)");
    expect(out).not.toContain("k12");
  });

  it("总长 ≤2000", () => {
    const long = Array.from({ length: 10 }, (_, i) => ({
      path: `field_${i}`, expected: "object", got: "string " + "x".repeat(60), message: "说明".repeat(100),
    }));
    const out = renderToolArgError("tool", long);
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});
