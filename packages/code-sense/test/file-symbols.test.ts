import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildC2fIndex, queryEntryPoints, queryFile, querySymbol, saveIndex,
  type C2fIndex, type C2fNode,
} from "../src/callgraph/c2f";
import { fileSymbolsOf } from "../src/index";
import { INDEX_EXTRACTOR_VERSION } from "../src/callgraph/engine";
import { extractTypedSymbols, renderVars, varsOf } from "../src/typed/index";

/** 2026-10-21 file 动作符号表补全:interface/type/enum/const 箭头/嵌套函数/类方法
 * 全进符号表且 parent 正确;类型声明不污染 trunk/leaf 与调用解析目标;
 * 模板字符串内嵌 JS 保持 inline-js 边界(短模板不触发既有 inline-js 提取)。 */
let dir = "";
let idx: C2fIndex;

const MODEL = [
  "export interface HostDeps {",
  "  name: string;",
  "}",
  "",
  'export type Mode = "a" | "b";',
  "",
  "export enum State { Idle, Busy }",
  "",
  "export const DEFAULT_LIMIT = 10;",
  "",
  "export const topArrow = (x: number): number => leafFn(x);",
  "",
  "export function leafFn(x: number): number { return x + 1; }",
  "",
  "export function createHost(deps: HostDeps): number {",
  "  const answer = (n: number): number => leafFn(n) + DEFAULT_LIMIT;",
  "  function helper(): number { return answer(1); }",
  '  const label = "x";',
  "  return helper() + label.length;",
  "}",
  "",
  "export class Host {",
  "  run(): number { return this.step(); }",
  "  step(): number { return leafFn(1); }",
  "}",
  "",
  "export function entry(): number {",
  '  return topArrow(1) + createHost({ name: "n" });',
  "}",
].join("\n");

const UTIL = [
  "export const CONFIG = { retries: 3 };",
  "",
  "export function util(): number { return CONFIG.retries; }",
].join("\n");

// 短模板(<512 字符且无 <script>)= 既有 inline-js 提取不候选;其中的 fakeInline 不得进符号表
const INLINE = [
  "export const PAGE = `function fakeInline() { return 1; }`;",
  "",
  "export function realTs(): number { return 1; }",
].join("\n");

// 类型声明不作调用解析目标:Thing 是 interface,裸调用 Thing() 必须保持未解析边
const SAME_NAME = [
  "export interface Thing { x: number }",
  "export function useThing(): number { return Thing(); }",
].join("\n");

// 纯类型文件(2026-10-21 验收缺口 1 活例 apps/gateway/src/session-worker-protocol.ts):
// 只有 interface/type/enum + 模块级 const(含非导出 const),没有任何函数——旧抽取器 0 节点,
// file/symbol 系统性缺报。Envelope/ClientMessage 形态对齐 packages/protocol(zod 联合)。
const TYPES_ONLY = [
  "const Envelope = { v: 1 };",
  "export interface SessionSpec { id: string }",
  'export type Notice = { t: "ready" } | { t: "log" };',
  "export enum Kind { A, B }",
  "export const ClientMessage = Envelope;",
  "export type Union = SessionSpec | Notice;",
].join("\n");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gh-filesym-kinds-"));
  writeFileSync(join(dir, "model.ts"), MODEL);
  writeFileSync(join(dir, "util.ts"), UTIL);
  writeFileSync(join(dir, "inline.ts"), INLINE);
  writeFileSync(join(dir, "same-name.ts"), SAME_NAME);
  writeFileSync(join(dir, "types-only.ts"), TYPES_ONLY);
  idx = await buildC2fIndex(dir);
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 按显示名找节点(model.ts 内)。 */
function node(name: string): C2fNode | undefined {
  return idx.nodes.find((n) => n.file === "model.ts" && n.name === name);
}

describe("file 符号表补全(2026-10-21)", () => {
  it("interface/type/enum/常量/const 箭头/嵌套函数/类方法全部进文件符号表", () => {
    const names = queryFile(idx, "model.ts").map((n) => n.name);
    for (const expected of [
      "HostDeps", "Mode", "State", "DEFAULT_LIMIT", "topArrow", "leafFn",
      "createHost", "createHost.answer", "createHost.helper",
      "Host", "Host.run", "Host.step", "entry",
    ]) {
      expect(names, `缺少符号 ${expected}`).toContain(expected);
    }
    // 函数体内局部非箭头 const 不是符号(label);类外顶层 util.ts 的常量对象登记为 variable
    expect(names).not.toContain("label");
    expect(queryFile(idx, "util.ts").map((n) => n.name)).toContain("CONFIG");
  });

  it("symKind/parent/container/dataType 正确", () => {
    expect(node("HostDeps")?.symKind).toBe("interface");
    expect(node("HostDeps")?.parent).toBeUndefined();
    expect(node("Mode")?.symKind).toBe("type");
    expect(node("Mode")?.dataType).toBe('"a" | "b"');
    expect(node("State")?.symKind).toBe("enum");
    expect(node("DEFAULT_LIMIT")?.symKind).toBe("variable");
    expect(node("topArrow")?.symKind).toBe("arrow");
    expect(node("leafFn")?.symKind).toBeUndefined(); // 普通函数不写冗余 symKind
    expect(node("createHost.answer")?.symKind).toBe("arrow");
    expect(node("createHost.answer")?.parent).toBe("createHost");
    expect(node("createHost.helper")?.parent).toBe("createHost");
    expect(node("Host")?.symKind).toBe("class");
    expect(node("Host.run")?.parent).toBe("Host");
    expect(node("Host.run")?.container).toBe("Host");
    expect(node("Host.step")?.container).toBe("Host");
  });

  it("类型声明/常量不进 trunk/leaf 语义:kind=regular 且不出现在入口清单", () => {
    for (const name of ["HostDeps", "Mode", "State", "DEFAULT_LIMIT"]) {
      expect(node(name)?.kind, `${name} 不应参与 trunk/leaf`).toBe("regular");
    }
    const eps = queryEntryPoints(idx, 50).map((n) => n.name);
    for (const name of ["HostDeps", "Mode", "State", "DEFAULT_LIMIT", "CONFIG"]) {
      expect(eps).not.toContain(name);
    }
    // 箭头/嵌套函数是真实函数,照常参与分类(topArrow 被 entry 调 → 非 trunk)
    expect(node("topArrow")?.kind).toBe("regular");
  });

  it("嵌套箭头/嵌套函数的调用归因到父限定的自身 id(不并回外层函数)", () => {
    expect(node("topArrow")?.kind).toBe("regular");
    expect(querySymbol(idx, "leafFn")[0]!.callers.map((c) => c.name)).toContain("createHost.answer");
    const answer = querySymbol(idx, "createHost.answer")[0]!;
    expect(answer.callees.map((c) => c.name)).toContain("leafFn");
    // helper 调 answer(nested arrow);createHost 直接调 helper
    expect(querySymbol(idx, "createHost.helper")[0]!.callees.map((c) => c.name)).toContain("createHost.answer");
    expect(querySymbol(idx, "createHost")[0]!.callees.map((c) => c.name)).toContain("createHost.helper");
    expect(querySymbol(idx, "topArrow")[0]!.callers.map((c) => c.name)).toContain("entry");
  });

  it("类型声明不作调用解析目标:裸调用 Thing() 保持未解析(interface 不进 CallGraph.byName)", () => {
    const hit = querySymbol(idx, "Thing")[0]!;
    expect(hit.symbol.symKind).toBe("interface");
    expect(hit.callers).toEqual([]); // 没有把 useThing 的 Thing() 伪连到 interface
    const unresolved = idx.edges.find((e) => e.from === "same-name.ts#useThing" && e.toName === "Thing");
    expect(unresolved?.to).toBe("");
  });

  it("模板字符串内嵌 JS 不混入符号表(inline-js 边界;短模板不触发既有提取)", () => {
    const names = queryFile(idx, "inline.ts").map((n) => n.name);
    expect(names).toContain("PAGE");
    expect(names).toContain("realTs");
    expect(querySymbol(idx, "fakeInline")).toEqual([]);
  });

  it("fileSymbolsOf 显示面:kind/parent 如实(interface/type/enum/arrow/class/method)", async () => {
    saveIndex(dir, idx);
    const r = await fileSymbolsOf(dir, "model.ts");
    const find = (name: string) => r.symbols.find((s) => s.name === name);
    expect(find("HostDeps")?.kind).toBe("interface");
    expect(find("Mode")?.kind).toBe("type");
    expect(find("State")?.kind).toBe("enum");
    expect(find("DEFAULT_LIMIT")?.kind).toBe("variable");
    expect(find("answer")?.kind).toBe("arrow");
    expect(find("answer")?.parent).toBe("createHost");
    expect(find("helper")?.kind).toBe("function");
    expect(find("helper")?.parent).toBe("createHost");
    expect(find("Host")?.kind).toBe("class");
    expect(find("run")?.kind).toBe("method");
    expect(find("run")?.parent).toBe("Host");
  });

  it("vars 不因新增索引节点重复计数(typed 提取面独立,基线 5 变量/4 组不变)", async () => {
    const typed = await extractTypedSymbols(dir, "model.ts");
    expect(varsOf(typed.symbols)).toHaveLength(5);
    const out = renderVars(typed);
    expect(out).toContain("变量 5 个 / 类型 4 组");
    // 枚举成员仍只在 typed 面出现一次;索引新增的 State 节点不进入 vars 分组
    expect((out.match(/State\.Idle@/g) ?? [])).toHaveLength(1);
  });

  it("纯类型文件(interface/type/enum/模块级 const)file 面必须有符号——验收缺口 1 回归", () => {
    const nodes = queryFile(idx, "types-only.ts");
    const names = nodes.map((n) => n.name);
    for (const expected of ["Envelope", "SessionSpec", "Notice", "Kind", "ClientMessage", "Union"]) {
      expect(names, `纯类型文件缺少符号 ${expected}`).toContain(expected);
    }
    expect(nodes.length).toBeGreaterThanOrEqual(6);
    // ClientMessage=export const(声明,不是 discriminatedUnion 数组里的引用):symbol 可查
    const cm = querySymbol(idx, "ClientMessage");
    expect(cm).toHaveLength(1);
    expect(cm[0]!.symbol.symKind).toBe("variable");
    expect(cm[0]!.symbol.file).toBe("types-only.ts");
    // 非导出模块级 const(Envelope)同样是声明符号,可查(只是不是 export)
    expect(querySymbol(idx, "Envelope")).toHaveLength(1);
  });

  it("索引落盘抽取器版本(增量复用闸/doctor 的单一真相依据)", () => {
    expect(idx.extractorVersion).toBe(INDEX_EXTRACTOR_VERSION);
  });
});
