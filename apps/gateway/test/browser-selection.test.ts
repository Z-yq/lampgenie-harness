/**
 * browser-selection 纯函数单测(不启浏览器):
 * ref 解析(正/负例)、多 ref 拒绝、快照 URL 过期判定、e1..eN 按 DOM 序编号。
 */
import { describe, it, expect } from "vitest";
import { buildRefMap, normalizeRef, refsStale, resolveRef, splitRefs } from "../src/browser-selection.js";

const MAP = new Map([
  ["e1", { selector: "#name", name: "输入名字" }],
  ["e2", { selector: "#go", name: "提交" }],
  ["e3", { selector: "div:nth-of-type(2)", name: "无 checkbox" }],
]);

describe("resolveRef", () => {
  it("正例:ref 存在 → 回 selector 与 name", () => {
    expect(resolveRef(MAP, "e2")).toEqual({ ok: true, selector: "#go", name: "提交" });
  });

  it("正例:纯数字 ref 等价 e<n>", () => {
    expect(resolveRef(MAP, "2")).toEqual({ ok: true, selector: "#go", name: "提交" });
  });

  it("正例:数组形态按 DOM 序取下标", () => {
    const arr = [{ selector: "#a" }, { selector: "#b" }];
    expect(resolveRef(arr, "e2")).toEqual({ ok: true, selector: "#b" });
  });

  it("负例:ref 不存在 → ok=false 且提示先 snapshot", () => {
    const r = resolveRef(MAP, "e9");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("未知 ref「e9」");
      expect(r.error).toContain("snapshot");
    }
  });

  it("负例:空 ref → ok=false", () => {
    const r = resolveRef(MAP, "  ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ref 为空");
  });

  it("负例:多 ref 语法直接拒绝(不拼多目标选择器)", () => {
    const r = resolveRef(MAP, "e1,e2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("多 ref");
  });
});

describe("normalizeRef / splitRefs", () => {
  it("normalizeRef:E3/3/e3 归一", () => {
    expect(normalizeRef("E3")).toBe("e3");
    expect(normalizeRef("3")).toBe("e3");
    expect(normalizeRef("e3")).toBe("e3");
    expect(normalizeRef("")).toBe("");
  });

  it("splitRefs:逗号/空白分隔,去重保序", () => {
    expect(splitRefs("e3, e5 e3")).toEqual(["e3", "e5"]);
    expect(splitRefs(["1", "", "e1"])).toEqual(["e1"]);
  });
});

describe("refsStale", () => {
  it("同 URL → 不过期", () => {
    expect(refsStale("https://a.test/x", "https://a.test/x")).toBe(false);
  });

  it("不同 URL → 过期(对齐 ZCode:导航后 ref 失效)", () => {
    expect(refsStale("https://a.test/x", "https://a.test/y")).toBe(true);
  });

  it("snapshotUrl 为 undefined(从未快照)→ 过期", () => {
    expect(refsStale(undefined, "https://a.test/x")).toBe(true);
    expect(refsStale("", "https://a.test/x")).toBe(true);
  });
});

describe("buildRefMap", () => {
  it("按 DOM 序生成 e1..eN,保留 name", () => {
    const m = buildRefMap([
      { selector: "#a", name: "A" },
      { selector: "#b" },
      { selector: "#c", name: "C" },
    ]);
    expect(Array.from(m.keys())).toEqual(["e1", "e2", "e3"]);
    expect(m.get("e1")).toEqual({ selector: "#a", name: "A" });
    expect(m.get("e2")).toEqual({ selector: "#b" });
    expect(m.get("e3")).toEqual({ selector: "#c", name: "C" });
  });

  it("selector 为空的元素跳过且不占号(编号与显示一致)", () => {
    const m = buildRefMap([{ selector: "" }, { selector: "#a" }, { selector: "  " }, { selector: "#b" }]);
    expect(Array.from(m.keys())).toEqual(["e1", "e2"]);
    expect(m.get("e1")).toEqual({ selector: "#a" });
    expect(m.get("e2")).toEqual({ selector: "#b" });
  });
});
