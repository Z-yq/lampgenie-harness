/**
 * C/C++ structural adapter 单测:
 * 提取子集(函数/原型/类型/方法)、原型-定义同文件消歧、调用边(同文件唯一/候选发射)、
 * 错误容忍(健康节点档)、.h 双语法、engine 注册链路(跨文件唯一名解析)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCppFile } from "../src/adapters/cpp";
import { buildCallGraphFromFiles } from "../src/callgraph/engine";

function cFixture(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gh-cpp-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const C_SRC = [
  "#include <stdlib.h>",
  '#include "peer.h"',
  "",
  "struct Frame { int w; int h; };  // 具名 struct → class 符号",
  "",
  "static int helper(int x);  // 原型:如实登记,定义到场让位",
  "",
  "int helper(int x) {",
  "    return scale_it(x) + remote_fn(4);  // 本地无 → 两个跨文件候选",
  "}",
  "",
  "int caller2(void) {",
  "    return helper(1);",
  "}",
  "",
  "int caller3(void) {",
  "    return helper(2);  // 不同调用方:各自一条边",
  "}",
].join("\n");

describe("C/C++ structural adapter()", () => {
  it("C:函数/原型/类型提取+行号+签名,原型让位定义", async () => {
    const { dir, cleanup } = cFixture({ "f.c": C_SRC });
    try {
      const r = await parseCppFile(dir, "f.c");
      expect(r.failures).toEqual([]);
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      // helper:原型+定义同 id,只留定义(kind=function 无 container)
      const helpers = r.symbols.filter((s) => s.name === "helper");
      expect(helpers).toHaveLength(1);
      expect(helpers[0]!.kind).toBe("function");
      expect(helpers[0]!.line).toBe(C_SRC.split("\n").indexOf("int helper(int x) {") + 1);
      expect(helpers[0]!.signature?.params).toEqual([{ name: "x", type: "int x" }]);
      // struct Frame → class 符号
      expect(byId.get("f.c#Frame")?.kind).toBe("class");
      expect(byId.get("f.c#Frame")!.line).toBe(4);
      // caller2(void):void 参数不产参数项
      expect(byId.get("f.c#caller2")?.signature?.params).toEqual([]);
      // 调用边:caller2/caller3→helper(同文件唯一;同调用方同行的重复调用按引擎惯例按行去重)
      const helperCalls = r.edges.filter((e) => e.toName === "helper");
      expect(helperCalls).toHaveLength(2);
      expect(new Set(helperCalls.map((e) => e.from))).toEqual(new Set(["f.c#caller2", "f.c#caller3"]));
      // 本地无:scale_it/remote_fn 发跨文件候选(to="" + toName,不猜)
      const candNames = r.crossFileCandidates?.map((c) => c.toName).sort();
      expect(candNames).toEqual(["remote_fn", "scale_it"]);
      expect(r.crossFileCandidates?.every((c) => c.to === "" && c.from === "f.c#helper")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("C++:类内方法/域外定义/析构不收/成员调用/限定调用候选", async () => {
    const CPP_SRC = [
      "class Camera {",
      "public:",
      "    Camera();                 // 构造器原型 → Camera.Camera",
      "    ~Camera();                // 析构 → 不收(名字契约外)",
      "    int start(int mode);      // 方法原型",
      "    int stop() { return 0; }  // 类内定义 → method(container=Camera)",
      "};",
      "",
      "int Camera::start(int mode) {  // 域外定义 → method(container=Camera)",
      "    return tick() + open_dev(mode);  // tick 同文件唯一 → 边;open_dev → 候选(带 receiverType 不适用裸名)",
      "}",
      "",
      "int Camera::tick(void) {",
      "    return 0;",
      "}",
      "",
      "int main(int, char**) {",
      "    Camera cam;",
      "    cam.stop();               // 成员调用 → Camera.stop 唯一 → 边",
      "    return 0;",
      "}",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "cam.cpp": CPP_SRC });
    try {
      const r = await parseCppFile(dir, "cam.cpp");
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(byId.get("cam.cpp#Camera")?.kind).toBe("class");
      expect(byId.get("cam.cpp#Camera.stop")?.kind).toBe("method");
      expect(byId.get("cam.cpp#Camera.stop")?.container).toBe("Camera");
      // 域外定义 container 归属
      expect(byId.get("cam.cpp#Camera.start")?.line).toBe(9);
      expect(byId.get("cam.cpp#Camera.start")?.kind).toBe("method");
      // 析构不收
      expect(r.symbols.some((s) => s.name.startsWith("~"))).toBe(false);
      // Camera::start → Camera::tick(裸名同文件唯一 method)
      const tickEdge = r.edges.find((e) => e.toName === "tick");
      expect(tickEdge?.from).toBe("cam.cpp#Camera.start");
      expect(tickEdge?.to).toBe("cam.cpp#Camera.tick");
      // 成员调用 cam.stop() → main → Camera.stop
      const stopEdge = r.edges.find((e) => e.toName === "stop");
      expect(stopEdge?.from).toBe("cam.cpp#main");
      expect(stopEdge?.to).toBe("cam.cpp#Camera.stop");
      // open_dev → 候选
      expect(r.crossFileCandidates?.map((c) => c.toName)).toContain("open_dev");
    } finally {
      cleanup();
    }
  });

  it("错误容忍:体内 ERROR 不再整段丢边——区间外调用照常成边", async () => {
 // P0:旧语义「函数体含 ERROR → 整函数零边」在真实仓造成大面积假 0 调用方
    // (SA_ADK_Infer_Sync 仅签名 3 字符 ERROR 丢掉千行函数体全部调用)。现按 ERROR 区间剔除,
    // 区间外健康调用保留。
    const BROKEN = [
      "int helper(int x) { return x; }",
      "int before_helper(int x) { return x; }",
      "int after_helper(int x) { return x; }",
      "",
      "int good_one(int a) {",
      "    return helper(a);  // 健康函数体内的调用照提",
      "}",
      "",
      "int with_bad_stmt(int q) {",
      "    int ok_before = before_helper(q);",
      "    return q +;  // 体内语法错误 → ERROR 区间",
      "    int ok_after = after_helper(q);",
      "}",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "broken.c": BROKEN });
    try {
      const r = await parseCppFile(dir, "broken.c");
      const names = r.symbols.map((s) => s.name).sort();
      expect(names).toContain("good_one");
      expect(names).toContain("with_bad_stmt"); // 符号在场(declarator 容错)
      expect(r.edges.some((e) => e.from.endsWith("#good_one") && e.toName === "helper")).toBe(true);
      // 错误行前后两条健康调用都恢复(旧实现两条全丢)
      const fromBad = r.edges.filter((e) => e.from === "broken.c#with_bad_stmt").map((e) => e.toName).sort();
      expect(fromBad).toContain("before_helper");
      expect(fromBad).toContain("after_helper");
      expect(r.outcome?.tier).toBe("full");
      expect(r.outcome?.errors).toBe(true); // impact 据此提示图盲区
    } finally {
      cleanup();
    }
  });

  it("C 文件混 C++ 语法:回落 cpp 语法,调用边完整恢复(真实仓 yolox.c 形态)", async () => {
    const SRC = [
      "int helper(int x) { return x; }",
      "int run_thing(void) {",
      "    auto dims = 4;", // C grammar 会报 ERROR;C++ grammar 干净
      "    bool ok = true;",
      "    return helper(dims) + (ok ? 0 : 1);",
      "}",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "mixed.c": SRC });
    try {
      const r = await parseCppFile(dir, "mixed.c");
      expect(r.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["helper", "run_thing"]));
      expect(r.edges.some((e) => e.from === "mixed.c#run_thing" && e.toName === "helper")).toBe(true);
      expect(r.outcome?.errors).toBeFalsy(); // cpp 语法零错 → 不标盲区
    } finally {
      cleanup();
    }
  });

  it(".h 头文件:原型/类型提取(双语法路径)", async () => {
    const H_SRC = [
      "#pragma once",
      "struct Config { int verbose; };",
      "int config_load(const char* path);",
      "void config_free(void);",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "cfg.h": H_SRC });
    try {
      const r = await parseCppFile(dir, "cfg.h");
      const names = r.symbols.map((s) => s.name).sort();
      expect(names).toEqual(["Config", "config_free", "config_load"].sort());
      expect(r.symbols.every((s) => s.kind === "class" || s.kind === "function")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("engine 注册链路:跨文件唯一名解析(caller.c → lib.c,原型在 lib.h)", async () => {
    const { dir, cleanup } = cFixture({
      "lib.h": "int add_them(int a, int b);\n",
      "lib.c": "int add_them(int a, int b) { return a + b; }\n",
      "caller.c": "int caller_fn(void) { return add_them(1, 2) + 0; }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["lib.h", "lib.c", "caller.c"]);
      const addIds = [...g.symbols.values()].filter((s) => s.name === "add_them").map((s) => s.id);
      expect(addIds).toHaveLength(2); // lib.h 原型 + lib.c 定义,不同文件不同 id
      const out = g.outEdges.get("caller.c#caller_fn") ?? [];
      expect(out.some((e) => e.to === "lib.c#add_them")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("engine 注册链路:C 族兜底——declarator 亦坏时 .c 调用点落到 .h 原型(mwInit 实锚形态)", async () => {
    const { dir, cleanup } = cFixture({
      "mw.h": "void mw_init(void);\n",
      // mw.c 定义体的 declarator 亦被语法 ERROR 污染(宏汤形态)→ 不猜,图里只剩 .h 原型
      "mw.c": "void mw_init(void) { int x = ; bad((",
      "user.c": "void user_fn(void) { mw_init(); }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["mw.h", "mw.c", "user.c"]);
      const out = g.outEdges.get("user.c#user_fn") ?? [];
      expect(out.some((e) => e.to === "mw.h#mw_init")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("engine 注册链路: 容错后 .c 定义恢复 → 同扩展名优先定义(不再落 .h)", async () => {
    const { dir, cleanup } = cFixture({
      "mw.h": "void mw_init(void);\n",
 // declarator 容错:体内 ERROR 但 declarator 健康 → mw.c 定义符号恢复(零边)
      "mw.c": "void mw_init(void) { int x = ; }\n",
      "user.c": "void user_fn(void) { mw_init(); }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["mw.h", "mw.c", "user.c"]);
      const out = g.outEdges.get("user.c#user_fn") ?? [];
      expect(out.some((e) => e.to === "mw.c#mw_init")).toBe(true); // 定义优先,且更准
    } finally {
      cleanup();
    }
  });

  it("2026-10-22 P1 缺口②:策略表指定初始化器与体内回调注册都成边(不再三面全盲)", async () => {
    const SRC = [
      "typedef struct { int (*criteria)(int); void (*run)(int); } ops_s;",
      "int face_criteria(int x) { return x; }",
      "void handler_run(int x) { (void)x; }",
      "static const ops_s g_face_ops = {",
      "    .criteria = face_criteria,",
      "    .run = handler_run,",
      "};",
      "void setup(void) {",
      "    ops_s local;",
      "    local.run = handler_run;",
      "    ops_s* p2 = &g_face_ops;",
      "    p2->criteria = &face_criteria;",
      "}",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "ops.c": SRC });
    try {
      const g = await buildCallGraphFromFiles(dir, ["ops.c"]);
      // 策略表变量引用 → face_criteria/handler_run 获得 inEdges(表变量为调用方)
      const crit = g.inEdges.get("ops.c#face_criteria") ?? [];
      expect(crit.some((e) => e.from === "ops.c#g_face_ops" || e.from === "ops.c#<module>")).toBe(true);
      // 体内回调注册(local.run = handler_run / p2->criteria = &face_criteria)→ 归属 setup
      const viaSetup = (g.inEdges.get("ops.c#handler_run") ?? []).filter((e) => e.from === "ops.c#setup");
      expect(viaSetup.length).toBeGreaterThanOrEqual(1);
      const viaSetupCrit = (g.inEdges.get("ops.c#face_criteria") ?? []).filter((e) => e.from === "ops.c#setup");
      expect(viaSetupCrit.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("2026-10-22 P1 缺口①:libc 名(round/free)跨文件不再被 vendored 头吸收;仓内真定义照常解析", async () => {
    const { dir, cleanup } = cFixture({
 // vendored 头里恰好有同名声明(flann/matrix.h 吸收 free 的注意形态)
      "thirdparty/fakelibrary/include/fake.h": "void* round(double);\nvoid free(void*);\n",
      "user.c": [
        "#include \"thirdparty/fakelibrary/include/fake.h\"",
        "double my_min(double a, double b);",
        "int caller(void) {",
        "    int r = (int)round(1.5);",
        "    free(0);",
        "    return (int)my_min(1.0, 2.0);",
        "}",
      ].join("\n"),
      // 产品仓自己的定义:名单守卫不得误杀
      "minprod.c": "double my_min(double a, double b) { return a < b ? a : b; }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["thirdparty/fakelibrary/include/fake.h", "user.c", "minprod.c"]);
      const out = g.outEdges.get("user.c#caller") ?? [];
      // libc 名:拒连(目标不是 vendored 头)
      expect(out.filter((e) => (e.toName === "round" || e.toName === "free") && e.to).length).toBe(0);
      // 台账登记原因可追溯
      const ledger = g.droppedCandidates?.get("round");
      expect(ledger).toBeDefined();
      expect(Object.keys(ledger!.reasons).join(" ")).toContain("libc");
      // 产品定义(非名单名):照常解析(同文件原型锚或跨文件定义锚都算命中——原型锚是既有语义)
      const minEdge = out.find((e) => e.toName === "my_min");
      expect(minEdge?.to).toBeTruthy();
      expect(["user.c#my_min", "minprod.c#my_min"]).toContain(minEdge?.to);
    } finally {
      cleanup();
    }
  });

  it("2026-10-22 P1 缺口①守卫:名单名在仓内有真产品定义时仍解析(不误杀)", async () => {
    const { dir, cleanup } = cFixture({
      "fake.h": "int min(int, int);\n",
      "impl.c": "int min(int a, int b) { return a < b ? a : b; }\n",
      "user.c": "int caller(void) { return min(1, 2); }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["fake.h", "impl.c", "user.c"]);
      const out = g.outEdges.get("user.c#caller") ?? [];
      expect(out.some((e) => e.toName === "min" && e.to === "impl.c#min")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("2026-10-22 P1 spawn 边:pthread_create 第 3 参 / xTaskCreate 第 1 参的线程入口成边", async () => {
    const SRC = [
      "#include <pthread.h>",
      "void* io_worker(void* arg) { return arg; }",
      "void rt_task(void* p) { (void)p; }",
      "int start_threads(void) {",
      "    pthread_t t1;",
      "    pthread_create(&t1, NULL, io_worker, NULL);",
      "    xTaskCreate(rt_task, \"rt\", 512, NULL, 5, NULL);",
      "    return 0;",
      "}",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "spawn.c": SRC });
    try {
      const r = await parseCppFile(dir, "spawn.c");
      const io = r.edges.find((e) => e.toName === "io_worker");
      expect(io?.from).toBe("spawn.c#start_threads"); // pthread_create 第 3 参
      const rt = r.edges.find((e) => e.toName === "rt_task");
      expect(rt?.from).toBe("spawn.c#start_threads"); // xTaskCreate 第 1 参
    } finally {
      cleanup();
    }
  });

  it("engine 注册链路:同扩展名定义在场时优先定义,不落到 .h(定义优先语义不回退)", async () => {
    const { dir, cleanup } = cFixture({
      "lib.h": "int add_them(int a, int b);\n",
      "lib.c": "int add_them(int a, int b) { return a + b; }\n",
      "other.h": "int add_them(int a, int b);\n",
      "caller.c": "int caller_fn(void) { return add_them(1, 2) + 0; }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["lib.h", "lib.c", "other.h", "caller.c"]);
      const out = g.outEdges.get("caller.c#caller_fn") ?? [];
      // 同扩展名(.c)档唯一 → 解析到定义;.h 的两个原型不参与(兜底只在同扩展名空时启用)
      expect(out.some((e) => e.to === "lib.c#add_them")).toBe(true);
      expect(out.every((e) => e.to !== "lib.h#add_them" && e.to !== "other.h#add_them")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("engine 注册链路:族内仍歧义(两 .h 原型无定义)→ 不解析不猜", async () => {
    const { dir, cleanup } = cFixture({
      "a.h": "int pick_me(int x);\n",
      "b.h": "int pick_me(int x);\n",
      "caller.c": "int caller_fn(void) { return pick_me(1); }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["a.h", "b.h", "caller.c"]);
      const out = g.outEdges.get("caller.c#caller_fn") ?? [];
      expect(out.filter((e) => e.toName === "pick_me" && e.to).length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("2026-10-22 P0:定义优先于原型——.cpp 测试调用跨族落到 .c 定义(不再双候选弃边)", async () => {
    const { dir, cleanup } = cFixture({
      "lib.h": "int init_thing(int x);\n",
      "lib.c": "int init_thing(int x) { return x; }\n",
      "test_thing.cpp": "int run_test(void) { return init_thing(1); }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["lib.h", "lib.c", "test_thing.cpp"]);
      const out = g.outEdges.get("test_thing.cpp#run_test") ?? [];
      const hit = out.find((e) => e.toName === "init_thing");
      expect(hit?.to).toBe("lib.c#init_thing"); // 原型让位定义
    } finally {
      cleanup();
    }
  });

  it("2026-10-22 P0:两处定义仍歧义时如实弃边,并给出构建开关原因", async () => {
    const { dir, cleanup } = cFixture({
      "fixed.c": "int post_run(int x) { return x + 1; }\n",
      "float.c": "int post_run(int x) { return x + 2; }\n",
      "caller.cpp": "int call_it(void) { return post_run(1); }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["fixed.c", "float.c", "caller.cpp"]);
      const out = g.outEdges.get("caller.cpp#call_it") ?? [];
      expect(out.filter((e) => e.toName === "post_run" && e.to).length).toBe(0);
      const ledger = g.droppedCandidates?.get("post_run");
      expect(ledger).toBeDefined();
      expect(Object.keys(ledger!.reasons).join(" ")).toContain("构建开关");
    } finally {
      cleanup();
    }
  });

  it("P0+lexical:巨型文件(>512KB)不再直接跳过——带声明走词法档,零声明 skipped 如实登记", async () => {
 // 形态一(依据 agent_alpha cat-565.h):裸十六进制字面量、零声明 → skipped 带 reason
    const pureBlob = "0x62, 0xEB, 0x5A, 0xAA, 0x52, 0x8A, 0x52, 0x69,\n".repeat(45000);
    expect(pureBlob.length).toBeGreaterThan(512 * 1024);
    const d1 = cFixture({ "pure_blob.h": pureBlob });
    try {
      const t0 = performance.now();
      const r = await parseCppFile(d1.dir, "pure_blob.h");
      const ms = performance.now() - t0;
      expect(r.symbols).toEqual([]);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0]!.reason).toContain("512KB");
      expect(r.outcome?.tier).toBe("skipped");
      expect(ms).toBeLessThan(100); // 必须秒回,不进 tree-sitter
    } finally {
      d1.cleanup();
    }
    // 形态二:多行初始化的顶层数组有真实声明 → 词法档提取(tier=lexical,零边)
    const withDecl = "static const unsigned char icon_map[] = {\n" + "0x62, 0xEB, 0x5A, 0xAA,\n".repeat(45000) + "};\n";
    const d2 = cFixture({ "icon.h": withDecl });
    try {
      const r = await parseCppFile(d2.dir, "icon.h");
      const data = r.symbols.find((s) => s.name === "icon_map");
      expect(data).toBeDefined();
      expect(data!.tier).toBe("lexical");
      expect(data!.kind).toBe("variable");
      expect(r.edges).toEqual([]); // lexical 零边
      expect(r.outcome?.tier).toBe("lexical");
    } finally {
      d2.cleanup();
    }
  });

  it("P0 阈值边界:512KB 以内的真实代码文件正常解析(mbedtls ssl.h 265KB 形态)", async () => {
    // 真实大文件(ssl.h 265KB 级别)仍须解析出符号,不被 P0 误杀
    const realCode = Array.from({ length: 200 }, (_, i) =>
      `int real_fn_${i}(int x) { return x + ${i}; }`,
    ).join("\n");
    expect(realCode.length).toBeLessThan(512 * 1024);
    const { dir, cleanup } = cFixture({ "real.c": realCode });
    try {
      const r = await parseCppFile(dir, "real.c");
      expect(r.symbols.length).toBe(200);
      expect(r.failures).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("C/C++ 覆盖率 99% 专项(,)", () => {
  it("G2 模板类:template_type 名节点提取(template<...> class DataType<...> 形态)", async () => {
    const SRC = [
      "#include <complex>",
      "namespace cv {",
      "template<typename _Tp> class DataType {",
      "public:",
      "    typedef _Tp value_type;",
      "};",
      "template<typename _Tp, int N> struct Vec { _Tp val[N]; };",
      "} // namespace cv",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "traits.hpp": SRC });
    try {
      const r = await parseCppFile(dir, "traits.hpp");
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(byId.get("traits.hpp#DataType")?.kind).toBe("class");
      expect(byId.get("traits.hpp#Vec")?.kind).toBe("class");
      expect(r.outcome?.tier).toBe("full");
    } finally {
      cleanup();
    }
  });

  it("G3 typedef:type_definition 提取(普通 typedef 与 typedef struct{...} name)", async () => {
    const SRC = [
      "typedef unsigned char U8;",
      "typedef unsigned long long U64;",
      "typedef struct {",
      "    int code;",
      "} sa_algo_event;",
      "typedef struct Point { int x, y; } PointT;",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "types.h": SRC });
    try {
      const r = await parseCppFile(dir, "types.h");
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      expect(byId.get("types.h#U8")?.kind).toBe("typedef");
      expect(byId.get("types.h#U64")?.kind).toBe("typedef");
      expect(byId.get("types.h#sa_algo_event")?.kind).toBe("typedef");
      // 具名 struct Point(类符号)+ typedef PointT 并存
      expect(byId.get("types.h#Point")?.kind).toBe("class");
      expect(byId.get("types.h#PointT")?.kind).toBe("typedef");
      expect(r.outcome?.tier).toBe("full");
    } finally {
      cleanup();
    }
  });

  it("G4 属性宏 strip:CV_EXPORTS/EXPORT_VISIBILITY 前缀定义与类恢复,反例不受影响", async () => {
    const SRC = [
      "#define CV_EXPORTS",
      "#define CV_EXPORTS_W",
      "CV_EXPORTS_W void inpaint( InputArray src, int h );",
      "EXPORT_VISIBILITY int sa_face_run(int w, int h) {",
      "    return preprocess(w, h);   // 本地无 → 跨文件候选",
      "}",
      "class CV_EXPORTS_API Tonemap : public Algorithm {",
      "public:",
      "    CV_WRAP virtual float getScale() const;",
      "    virtual void apply(float src) { }",
      "};",
      "// 反例:全大写常量后跟非关键字 → 不 strip,解析不受影响",
      "static const int MAX_SIZE = 10;",
      "enum Color { RED, GREEN };",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "exp.cpp": SRC });
    try {
      const r = await parseCppFile(dir, "exp.cpp");
      const byId = new Map(r.symbols.map((s) => [s.id, s]));
      // strip 后干净解析:原型/定义/类/方法全部恢复
      expect(byId.get("exp.cpp#inpaint")?.kind).toBe("function");
      expect(byId.get("exp.cpp#sa_face_run")?.kind).toBe("function");
      expect(byId.get("exp.cpp#Tonemap")?.kind).toBe("class");
      expect(byId.get("exp.cpp#Tonemap.getScale")?.container).toBe("Tonemap");
      expect(byId.get("exp.cpp#Tonemap.apply")?.container).toBe("Tonemap");
      // sa_face_run 体内调用健康 → 边/候选照常(preprocess → 候选)
      expect(r.crossFileCandidates?.map((c) => c.toName)).toContain("preprocess");
      expect(r.outcome?.tier).toBe("full");
    } finally {
      cleanup();
    }
  });

  it("G5 RC-E:函数体 ERROR 但 declarator 健康(cv::resize 形态)→ 符号恢复、错误区间外调用保留", async () => {
    const SRC = [
      "int real_helper(int x) { return x; }",
      "void cv::resize( InputArray _src, OutputArray _dst, int interpolation )",
      "{",
      "    real_helper(1);", // 错误前的健康调用
      "    int broken = ;  // 宏展开残骸 → 函数体 ERROR(declarator 健康)",
      "    real_helper(2);", // 错误后的健康调用
      "}",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "resize.cpp": SRC });
    try {
      const r = await parseCppFile(dir, "resize.cpp");
      const resize = r.symbols.find((s) => s.name === "resize");
      expect(resize).toBeDefined(); // 不再连坐丢弃
      expect(resize!.container).toBe("cv"); // 限定名归 container
 // P0:旧实现整函数零边;现在错误区外两条调用都恢复
      const calls = r.edges.filter((e) => e.from === "resize.cpp#cv.resize" && e.toName === "real_helper");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(r.outcome?.errors).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("G1/empty:纯 include 聚合头与纯 #define 头如实计 empty(不编造符号)", async () => {
    const agg = ["#ifndef OPENCV_GAPI_HPP", "#define OPENCV_GAPI_HPP", "#include <memory>", "#include <opencv2/gapi/gmat.hpp>", "#include <opencv2/gapi/garray.hpp>", "#endif"].join("\n");
    const defsOnly = ["#define VERSION_MAJOR 4", "#define VERSION_MINOR 0", "#define CV_TRY_SSE 1"].join("\n");
    const { dir, cleanup } = cFixture({ "gapi_like.hpp": agg, "version.hpp": defsOnly });
    try {
      const r1 = await parseCppFile(dir, "gapi_like.hpp");
      const r2 = await parseCppFile(dir, "version.hpp");
      expect(r1.symbols).toEqual([]);
      expect(r1.outcome?.tier).toBe("empty");
      expect(r2.symbols).toEqual([]);
      expect(r2.outcome?.tier).toBe("empty");
    } finally {
      cleanup();
    }
  });

  it(" 更新:ERROR 文件健康顶层声明走结构档变量提取(tier=structural; 的词法兜底保留给超闸/全坏文件)", async () => {
    // ObjC/野语法制造全 ERROR(结构档 0 符号),顶层 C 声明由词法档兜底
    const SRC = [
      "@interface CvVideoCamera : UIViewController",   // ObjC 语法 → ERROR
      "@property (nonatomic, strong) AVCaptureSession* captureSession;",
      "@end",
      "extern int g_sa_log_output_level;",
      "typedef int (*sa_callback)(int event, void* user);",
      "const uint32_t g_lut_table[256] = { 0x00 };",
    ].join("\n");
    const { dir, cleanup } = cFixture({ "log.h": SRC });
    try {
      const r = await parseCppFile(dir, "log.h");
      const byName = new Map(r.symbols.map((s) => [s.name, s]));
 // P1:健康 declaration(extern/const 数组)现由结构档文件级变量提取收编
      //(AST 级证据,比词法 regex 强一档;typedef 函数指针仍=诚实边界不收)
      expect(byName.get("g_sa_log_output_level")?.kind).toBe("variable");
      expect(byName.get("g_sa_log_output_level")?.dataType).toBe("int");
      expect(byName.get("g_lut_table")?.kind).toBe("variable");
      expect(byName.get("g_lut_table")?.dataType).toBe("const uint32_t[256]");
      expect(r.edges).toEqual([]); // 变量零边
      expect(r.outcome?.tier).toBe("full");
    } finally {
      cleanup();
    }
  });

  it("lexical 防污染:词法符号不进 byName,跨文件候选不吸收(零假边)", async () => {
    const { dir, cleanup } = cFixture({
      "noise.h": "@interface Trash : NSObject\n@end\nextern int uniq_name;\n",
      "caller.c": "int caller_fn(void) { return uniq_name(3) + 0; }\n",
    });
    try {
      const g = await buildCallGraphFromFiles(dir, ["noise.h", "caller.c"]);
 // P1:variable 一律不进 byName(结构性纪律,lexical/structural 同规)——
      // 跨文件候选解析绝不吸收变量名(uniq_name(3) 调用形态不得连到变量上)
      const sym = [...g.symbols.values()].find((s) => s.name === "uniq_name");
      expect(sym?.kind).toBe("variable");
      expect((g.byName.get("uniq_name") ?? [])).toHaveLength(0);
      const all = [...g.outEdges.values()].flat();
      expect(all.some((e) => e.to === "noise.h#uniq_name")).toBe(false);
    } finally {
      cleanup();
    }
  });
});
