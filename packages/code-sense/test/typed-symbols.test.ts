/**
 * typed symbols 单测( P1 / §2):
 * C 深提取七形态(int / char 指针 / struct X / typedef / enum / 数组 / 函数指针)+span;
 * Py/Go/Java/TS 补导出;groupByDataType/semantic-token 流;索引档零回退锚
 * (variable 不进 engine byName——跨文件候选解析不吸收变量名)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCppFile } from "../src/adapters/cpp";
import { parsePythonFile } from "../src/adapters/python";
import { parseGoFile } from "../src/adapters/go";
import { parseJavaFile } from "../src/adapters/java";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";
import { extractTypedSymbols, varsOf, groupByDataType, toSemanticTokens, renderVars } from "../src/typed/index";

function fixture(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gh-typed-"));
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const C_SRC = [
  "#include <stdlib.h>",
  "",
  "struct Frame { int w; int h; };",
  "enum Color { RED, GREEN };",
  "typedef unsigned char U8;",
  "",
  "static int counter = 5;",
  "const char *version = \"1.0\";",
  "struct Frame global_frame;",
  "int primes[10] = {2, 3};",
  "void (*handler)(int);",
  "",
  "int compute(int x) {",
  "    return x + 1;",
  "}",
].join("\n");

describe("typed/C( P1,C 做深)", () => {
  it("索引档:文件级变量七形态带 dataType;typedef 带底层类型", async () => {
    const { dir, cleanup } = fixture({ "f.c": C_SRC });
    try {
      const r = await parseCppFile(dir, "f.c");
      expect(r.failures).toEqual([]);
      const vars = new Map(r.symbols.filter((s) => s.kind === "variable").map((s) => [s.name, s]));
      expect(vars.get("counter")?.dataType).toBe("static int");
      expect(vars.get("version")?.dataType).toBe("const char*");
      expect(vars.get("global_frame")?.dataType).toBe("struct Frame");
      expect(vars.get("primes")?.dataType).toBe("int[10]");
      expect(vars.get("handler")?.dataType).toBe("void (*)(int)");
      const typedefs = new Map(r.symbols.filter((s) => s.kind === "typedef").map((s) => [s.name, s]));
      expect(typedefs.get("U8")?.dataType).toBe("unsigned char");
    } finally {
      cleanup();
    }
  });

  it("typed 档:文件级变量+struct 字段+enum 常量,全带 span;groupBy/semantic-token 流", async () => {
    const { dir, cleanup } = fixture({ "f.c": C_SRC });
    try {
      const r = await extractTypedSymbols(dir, "f.c");
      expect(r.language).toBe("c");
      const vars = varsOf(r.symbols);
      const byName = new Map(vars.map((v) => [v.name, v]));
      // C 深提取面:文件级变量+字段+enum 常量+typedef 全在
      expect(byName.get("w")?.kind).toBe("property");
      expect(byName.get("w")?.container).toBe("Frame");
      expect(byName.get("RED")?.kind).toBe("enumMember");
      expect(byName.get("RED")?.dataType).toBe("Color");
      expect(byName.get("U8")?.kind).toBe("type");
      // span 供位(semantic-token 前提)
      expect(byName.get("counter")?.span?.length).toBe(7);
      expect(byName.get("counter")?.span?.character).toBeGreaterThanOrEqual(0);
      // 类型分组
      const groups = groupByDataType(r.symbols);
      const dataTypes = groups.map((g) => g.dataType);
      expect(dataTypes).toContain("int");
      expect(dataTypes).toContain("int[10]");
      expect(dataTypes).toContain("void (*)(int)");
      // semantic-token 流
      const tokens = toSemanticTokens(r);
      expect(tokens?.version).toBe(1);
      expect(tokens?.file).toBe("f.c");
      expect(tokens?.tokens.length).toBeGreaterThan(5);
      const fnToken = tokens?.tokens.find((t) => t.name === "compute");
      expect(fnToken?.kind).toBe("function");
      expect(fnToken?.line).toBe(13);
      // 渲染:类型分组可读
      const text = renderVars(r);
      expect(text).toContain("f.c");
      expect(text).toContain("int[10]");
    } finally {
      cleanup();
    }
  });

  it("零回退锚:variable 不进 engine byName(跨文件候选解析不吸收变量名)", async () => {
    const { dir, cleanup } = fixture({
      "a.c": "int target = 1;\nint caller(void) { return target + remote_fn(1); }\n",
      "b.c": "int remote_fn(int x) { return x; }\n",
    });
    try {
      const graph = await buildCallGraphFromFiles(dir, ["a.c", "b.c"]);
      // 变量 target 在 symbols(可被 file 查询),但绝不在 byName
      const varId = [...graph.symbols.values()].find((s) => s.name === "target" && s.kind === "variable");
      expect(varId).toBeDefined();
      const byNameList = graph.byName.get("target") ?? [];
      expect(byNameList).not.toContain(varId!.id);
    } finally {
      cleanup();
    }
  });
});

const PY_SRC = [
  "import os",
  "",
  "MAX_RETRIES: int = 5",
  "DEFAULT_NAME: str = \"agent\"",
  "cache = {}",
  "",
  "class Handler:",
  "    timeout: float = 1.5",
  "",
  "    def run(self):",
  "        return 1",
].join("\n");

describe("typed/Python(注解+字面量推断)", () => {
  it("索引档:模块级注解变量入符号;控制流语句不误捕", async () => {
    const { dir, cleanup } = fixture({ "m.py": PY_SRC });
    try {
      const r = await parsePythonFile(dir, "m.py");
      const vars = new Map(r.symbols.filter((s) => s.kind === "variable").map((s) => [s.name, s]));
      expect(vars.get("MAX_RETRIES")?.dataType).toBe("int");
      expect(vars.get("DEFAULT_NAME")?.dataType).toBe("str");
      expect(vars.has("cache")).toBe(false); // 无注解:索引档不收(typed/ 档推断)
    } finally {
      cleanup();
    }
  });

  it("typed 档:注解(structural)+字面量推断(lexical 如实)+类属性归属", async () => {
    const { dir, cleanup } = fixture({ "m.py": PY_SRC });
    try {
      const r = await extractTypedSymbols(dir, "m.py");
      const byName = new Map(r.symbols.map((s) => [s.name, s]));
      expect(byName.get("MAX_RETRIES")?.dataType).toBe("int");
      expect(byName.get("MAX_RETRIES")?.tier).toBe("structural");
      expect(byName.get("cache")?.dataType).toBe("dict");
      expect(byName.get("cache")?.tier).toBe("lexical");
      expect(byName.get("timeout")?.kind).toBe("property");
      expect(byName.get("timeout")?.container).toBe("Handler");
      expect(byName.get("run")?.kind).toBe("method");
    } finally {
      cleanup();
    }
  });
});

const GO_SRC = [
  "package main",
  "",
  "var MaxSize int = 100",
  "var (",
  "    Name string",
  "    Count int = 3",
  ")",
  "",
  "type Server struct {",
  "    Port int",
  "    Host string",
  "}",
  "",
  "func (s *Server) Start() error {",
  "    local := 42",
  "    return nil",
  "}",
].join("\n");

describe("typed/Go(var/const/字段)", () => {
  it("索引档:包级 var/const 显式类型入符号", async () => {
    const { dir, cleanup } = fixture({ "m.go": GO_SRC });
    try {
      const r = await parseGoFile(dir, "m.go");
      const vars = new Map(r.symbols.filter((s) => s.kind === "variable").map((s) => [s.name, s]));
      expect(vars.get("MaxSize")?.dataType).toBe("int");
      expect(vars.get("Name")?.dataType).toBe("string");
      expect(vars.get("Count")?.dataType).toBe("int");
    } finally {
      cleanup();
    }
  });

  it("typed 档:struct 字段+:= 字面量推断(lexical)", async () => {
    const { dir, cleanup } = fixture({ "m.go": GO_SRC });
    try {
      const r = await extractTypedSymbols(dir, "m.go");
      const byName = new Map(r.symbols.map((s) => [s.name, s]));
      expect(byName.get("Port")?.kind).toBe("property");
      expect(byName.get("Port")?.dataType).toBe("int");
      expect(byName.get("Host")?.container).toBe("Server");
      expect(byName.get("local")?.dataType).toBe("int");
      expect(byName.get("local")?.tier).toBe("lexical");
      expect(byName.get("Start")?.kind).toBe("method");
    } finally {
      cleanup();
    }
  });
});

const JAVA_SRC = [
  "public class Server {",
  "    private int port;",
  "    public String host = \"localhost\";",
  "",
  "    public int getPort() {",
  "        return port;",
  "    }",
  "}",
].join("\n");

describe("typed/Java(类字段)", () => {
  it("索引档+typed 档:字段带 dataType+container", async () => {
    const { dir, cleanup } = fixture({ "Server.java": JAVA_SRC });
    try {
      const r = await parseJavaFile(dir, "Server.java");
      const fields = new Map(r.symbols.filter((s) => s.kind === "variable").map((s) => [s.name, s]));
      expect(fields.get("port")?.dataType).toBe("int");
      expect(fields.get("port")?.container).toBe("Server");
      expect(fields.get("host")?.dataType).toBe("String");
      const t = await extractTypedSymbols(dir, "Server.java");
      const byName = new Map(t.symbols.map((s) => [s.name, s]));
      expect(byName.get("port")?.kind).toBe("property");
      expect(byName.get("port")?.span?.length).toBe(4);
    } finally {
      cleanup();
    }
  });
});

const TS_SRC = [
  "export const MAX: number = 10;",
  "const names: string[] = [];",
  "let count = 5;",
  "",
  "export interface Config {",
  "  retries: number;",
  "  label?: string;",
  "}",
  "",
  "export type Handler = (x: number) => void;",
  "",
  "export function run(cfg: Config): void {}",
].join("\n");

describe("typed/TS(注解原生/泛型/联合+字面量推断)", () => {
  it("索引档+typed 档:注解类型(structural)+推断(lexical)", async () => {
    const { dir, cleanup } = fixture({ "m.ts": TS_SRC });
    try {
      const r = await extractTypedSymbols(dir, "m.ts");
      const byName = new Map(r.symbols.map((s) => [s.name, s]));
      expect(byName.get("MAX")?.dataType).toBe("number");
      expect(byName.get("MAX")?.tier).toBe("structural");
      expect(byName.get("names")?.dataType).toBe("string[]");
      expect(byName.get("count")?.dataType).toBe("number");
      expect(byName.get("count")?.tier).toBe("lexical");
      expect(byName.get("retries")?.kind).toBe("property");
      expect(byName.get("Handler")?.dataType).toContain("number");
      expect(byName.get("run")?.kind).toBe("function");
    } finally {
      cleanup();
    }
  });
});

describe("typed/边界(不支持语言显式降级)", () => {
  it("rs 扩展名=language undefined+degraded,不猜", async () => {
    const { dir, cleanup } = fixture({ "m.rs": "fn main() {}" });
    try {
      const r = await extractTypedSymbols(dir, "m.rs");
      expect(r.language).toBeUndefined();
      expect(r.symbols).toHaveLength(0);
      expect(r.degraded?.reason).toContain("不支持的扩展名");
    } finally {
      cleanup();
    }
  });
});

// 读取失败降级理由不截断完整路径(旧 slice(0,80) 把 ENOENT 路径拦腰斩成「参数被截断」幻象)。
describe("typed/读取失败理由(完整路径不截断)", () => {
  it("长路径 ENOENT:五语言降级理由全量含完整路径", async () => {
    const { dir, cleanup } = fixture({});
    try {
      const deep = "a/very/long/".repeat(12) + "missing-target-dir";
      for (const f of ["m.c", "m.go", "m.py", "m.java", "m.ts"]) {
        const rel = deep + "/" + f;
        const r = await extractTypedSymbols(dir, rel);
        expect(r.symbols).toHaveLength(0);
        const reason = r.degraded?.reason ?? "";
        expect(reason.startsWith("读取失败: ")).toBe(true);
        expect(reason).toContain("ENOENT");
        expect(reason).toContain(rel); // 完整相对路径不被拦腰截断
      }
    } finally {
      cleanup();
    }
  });
  it("超长发理由(>300)中段截断但保尾部(路径恒在尾)", async () => {
    const { readFailReason } = await import("../src/typed/types");
    const tail = "open '/" + "x".repeat(200) + "/leaf.c'";
    const long = "Error: ENOENT: " + "前缀噪声 ".repeat(60) + tail;
    const out = readFailReason(new Error(long));
    expect(out.length).toBeLessThanOrEqual(310);
    expect(out.endsWith(tail.slice(-130))).toBe(true); // 尾部(路径)完整保留
    expect(out).toContain("leaf.c");
    const short = readFailReason(new Error("Error: ENOENT: no such file or directory, open '/tmp/a.c'"));
    expect(short).toContain("/tmp/a.c");
  });
});

// opencv 风格 C++(namespace 包裹/调用约定宏吊死 qualified/函数指针 typedef/
// 宏常量维度数组/多行声明)——accum.cpp 与 imgproc.hpp 真实形态的浓缩 fixture。
const OPENCV_STYLE_SRC = [
  "namespace cv",
  "{",
  "",
  "typedef void(*AccFunc)(const void*, void*, const uchar*, int, int);",
  "",
  "template<typename ST, typename DT>",
  "static void accWrap(const void* src, void* dst) { /* … */ }",
  "",
  "static AccFunc accTab[CV_DEPTH_MAX] =",
  "{",
  "    accWrap<uchar, float>,",
  "};",
  "",
  "inline int getAccTabIdx(int sdepth)",
  "{",
  "    return sdepth;",
  "}",
  "",
  "static IppStatus CV_STDCALL ippiAddWrap(const void* pSrc, int srcStep)",
  "{",
  "    return (IppStatus)0;",
  "}",
  "",
  "} // namespace cv",
  "",
  "void cv::accumulate( InputArray _src, InputOutputArray _dst )",
  "{",
  "    CV_INSTRUMENT_REGION();",
  "}",
  "",
  "static const softfloat uLow(-134), uHigh(220);",
  "",
  "static struct LUT_T {",
  "    const int *RGB2Lab;",
  "} LABLUVLUTs16 = {0};",
  "",
  "inline",
  "float initWideAngleProjMap(InputArray cameraMatrix,",
  "                           Size imageSize)",
  "{",
  "    return 0.f;",
  "}",
].join("\n");

describe("typed/C++ opencv 风格(着色补位)", () => {
  it("namespace 下探变量+宏吊死 qualified 营救+fn-ptr typedef+数组名纠偏+多行声明整流", async () => {
    const { dir, cleanup } = fixture({ "accum.cpp": OPENCV_STYLE_SRC });
    try {
      const r = await extractTypedSymbols(dir, "accum.cpp");
      expect(r.degraded).toBeUndefined();
      const byName = new Map(r.symbols.map((s) => [s.name, s]));
      // ① namespace 下探:accTab 文件级变量(数组名=首个 [ 前标识符,非维度宏 CV_DEPTH_MAX)
      expect(byName.get("accTab")?.kind).toBe("variable");
      expect(byName.get("accTab")?.dataType).toBe("static AccFunc[CV_DEPTH_MAX]");
      expect(byName.has("CV_DEPTH_MAX")).toBe(false);
      // ② 多 declarator 声明的两个变量都在(uLow/uHigh)
      expect(byName.get("uLow")?.dataType).toContain("softfloat");
      expect(byName.get("uHigh")?.dataType).toContain("softfloat");
      // ③ 函数指针 typedef 营救
      expect(byName.get("AccFunc")?.kind).toBe("type");
      expect(byName.get("AccFunc")?.dataType).toContain("(*)(const void*");
      // ④ qualified 营救:宏吊死形态 ippiAddWrap(ALLCAPS 宏不冒充 container)
      expect(byName.get("ippiAddWrap")?.kind).toBe("function");
      expect(byName.get("ippiAddWrap")?.container).toBeUndefined();
      // 清洁形态 cv::accumulate → container=cv(如实,与 adapters 同规)
      expect(byName.get("accumulate")?.container).toBe("cv");
      // struct 内变量声明的 declarator 名(LABLUVLUTs16 在 } 之后行)
      expect(byName.get("LABLUVLUTs16")?.kind).toBe("variable");
      expect(byName.get("RGB2Lab")?.container).toBe("LUT_T");
      // ⑤ span 整流:全部 token 的 (line,character,length) 切片===name(多行声明
      // initWideAngleProjMap / LABLUVLUTs16 / uHigh 曾是错配形态)
      const tokens = toSemanticTokens(r)!;
      const srcLines = OPENCV_STYLE_SRC.split("\n");
      expect(tokens.tokens.length).toBeGreaterThan(10);
      for (const t of tokens.tokens) {
        expect(srcLines[t.line - 1]!.substr(t.character, t.length)).toBe(t.name);
      }
      // 名字行=声明名所在行(非声明起始行):initWideAngleProjMap 名字在 inline 下一行
      const init = byName.get("initWideAngleProjMap")!;
      expect(srcLines[init.line - 1]).toContain("float initWideAngleProjMap(");
    } finally {
      cleanup();
    }
  });
});
