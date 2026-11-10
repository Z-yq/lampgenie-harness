import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** 组件拆移布局引擎(自研实现,apps/gateway/src/assets/annotate-layout.js)的 oracle 回归。
 * 引擎为单一来源资产,面板 <script> 与本测试同源同文件(此处按浏览器方式在 vm 沙箱执行,
 * 取 window.GenieAnnotateLayout);用例覆盖分区不变量/仿射搬运/账本推导/批注重映射。 */

const assetPath = join(dirname(fileURLToPath(import.meta.url)), "../src/assets/annotate-layout.js");
const sandbox: Record<string, unknown> = { window: {} };
vm.runInNewContext(readFileSync(assetPath, "utf8"), sandbox);
const layout = (sandbox.window as Record<string, any>).GenieAnnotateLayout;

const rect = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 });
const area = (r: { x1: number; y1: number; x2: number; y2: number }) => (r.x2 - r.x1) * (r.y2 - r.y1);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const approximately = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);
const sameRect = (a: any, b: any) => Object.keys(b).forEach((key) => approximately(a[key], b[key]));
const selectedPieces = (state: any, id: string) => {
  const ids = new Set(state.groups.find((g: any) => g.id === id).pieces);
  return state.pieces.filter((p: any) => ids.has(p.id));
};

describe("布局引擎:分区与检测", () => {
  it("初始候细分无空洞、无重复源像素,背景/重复块不成组", () => {
    const state = layout.build(100, 80, [
      { bounds: rect(0, 0, 100, 80), label: "background" },
      { bounds: rect(10, 10, 70, 50), label: "panel" },
      { bounds: rect(20, 20, 35, 35), label: "child" },
      { bounds: rect(20, 20, 35, 35), label: "duplicate" },
      { bounds: rect(-10, 50, 40, 100), label: "clipped" },
    ]);
    expect(state.groups.length).toBe(3);
    expect(state.groups.some((g: any) => g.label === "background")).toBe(false);
    expect(state.groups.some((g: any) => g.label === "duplicate")).toBe(false);
    expect(layout.verify(state, 100, 80)).toBe(true);
    expect(state.pieces.reduce((sum: number, p: any) => sum + area(p.source), 0)).toBe(8000);
    expect(layout.moves(state)).toEqual([]);
    expect(layout.pick(state, 22, 22)[0].label).toBe("child");
  });

  it("检测器细分经一次仿射变换合并为一条 movement", () => {
    const state = layout.build(100, 100, [{ bounds: rect(20, 20, 30, 30) }]);
    const id = layout.carve(state, rect(10, 10, 40, 40));
    layout.moveGroup(state, id, rect(50, 50, 80, 80));
    expect(layout.moves(state)).toEqual([{ source: rect(10, 10, 40, 40), movements: [{ to: rect(50, 50, 80, 80) }], annotations: [] }]);
  });
});

describe("布局引擎:搬运与轨迹", () => {
  it("反复平移缩放保持源几何,最终只产出一条 movement;搬回原位则清零", () => {
    const state = layout.build(100, 100);
    const id = layout.carve(state, rect(10, 10, 30, 30));
    layout.moveGroup(state, id, rect(40, 40, 60, 60));
    layout.moveGroup(state, id, rect(50, 20, 90, 60));
    layout.moveGroup(state, id, rect(20, 60, 40, 80));
    expect(layout.moves(state)).toEqual([{ source: rect(10, 10, 30, 30), movements: [{ to: rect(20, 60, 40, 80) }], annotations: [] }]);
    expect(layout.verify(state)).toBe(true);
    layout.moveGroup(state, id, rect(10, 10, 30, 30));
    expect(layout.moves(state)).toEqual([]);
  });

  it("目标约束:贴边保持尺寸,超限变换被钳制", () => {
    const state = layout.build(100, 100);
    const id = layout.carve(state, rect(10, 10, 30, 30));
    expect(layout.moveGroup(state, id, rect(-5, 95, 15, 115))).toEqual(rect(0, 80, 20, 100));
    expect(layout.moveGroup(state, id, rect(-20, -50, 150, 140))).toEqual(rect(0, 0, 100, 100));
    expect(layout.verify(state)).toBe(true);
    expect(() => layout.moveGroup(state, id, rect(10, 10, 10, 20))).toThrow(/尺寸必须为正/);
    expect(() => layout.carve(state, rect(NaN, 0, 10, 10))).toThrow(/有限数值/);
    expect(layout.carve(state, rect(110, 110, 120, 120))).toBe(null);
  });

  it("已缩放搬运件内再切区域,切面映射回原图坐标", () => {
    const state = layout.build(100, 100);
    const parent = layout.carve(state, rect(10, 10, 30, 30));
    layout.moveGroup(state, parent, rect(40, 40, 80, 80));
    const child = layout.carve(state, rect(50, 50, 70, 70));
    const pieces = selectedPieces(state, child);
    expect(pieces.length).toBe(1);
    sameRect(pieces[0].source, rect(15, 15, 25, 25));
    sameRect(pieces[0].to, rect(50, 50, 70, 70));
    layout.moveGroup(state, child, rect(70, 0, 90, 20));
    expect(layout.verify(state)).toBe(true);
    sameRect(layout.extentOf(state, parent), rect(40, 40, 80, 80));
    sameRect(layout.extentOf(state, child), rect(70, 0, 90, 20));
  });

  it("跨前景/可见背景的区域,每个源只选一次", () => {
    const state = layout.build(100, 100);
    const moved = layout.carve(state, rect(10, 10, 30, 30));
    layout.moveGroup(state, moved, rect(40, 40, 60, 60));
    const region = layout.carve(state, rect(50, 50, 70, 70));
    const pieces = selectedPieces(state, region);
    expect(pieces.reduce((sum: number, p: any) => sum + area(p.to), 0)).toBe(400);
    const originalMoved = pieces.find((p: any) => p.source.x1 < 30);
    expect(originalMoved.source).toEqual(rect(20, 20, 30, 30));
    layout.moveGroup(state, region, rect(60, 60, 80, 80));
    expect(layout.verify(state)).toBe(true);
  });

  it("嵌套子组件随父搬运,独立搬动后脱离", () => {
    const state = layout.build(120, 120);
    const parent = layout.carve(state, rect(10, 10, 60, 60));
    const child = layout.carve(state, rect(20, 20, 40, 40));
    layout.moveGroup(state, parent, rect(20, 20, 120, 120));
    sameRect(layout.extentOf(state, child), rect(40, 40, 80, 80));
    layout.moveGroup(state, child, rect(0, 0, 20, 20));
    sameRect(layout.extentOf(state, parent), rect(20, 20, 120, 120));
    const reloaded = clone(state);
    expect(layout.verify(reloaded)).toBe(true);
    expect(layout.moves(reloaded)).toEqual(layout.moves(state));
    const additional = layout.carve(reloaded, rect(0, 0, 10, 10));
    layout.moveGroup(reloaded, additional, rect(80, 0, 90, 10));
    expect(layout.verify(reloaded)).toBe(true);
  });

  it("不可表达的极小缩放失败且不破坏当前布局", () => {
    const state = layout.build(100, 100);
    layout.carve(state, rect(10, 10, 10.000001, 20));
    const parent = layout.carve(state, rect(0, 0, 50, 50));
    const before = clone(state);
    expect(() => layout.moveGroup(state, parent, rect(0, 0, 0.001, 0.001))).toThrow(/区域过小/);
    expect(state).toEqual(before);
    expect(layout.verify(state)).toBe(true);
  });

  it("确定性混合编辑序列保持完整唯一的源分区(35 轮随机)", () => {
    const state = layout.build(180, 140);
    let seed = 1234567;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 35; ++i) {
      const x = Math.floor(random() * 130), y = Math.floor(random() * 90);
      const id = layout.carve(state, rect(x, y, x + 15 + random() * 25, y + 15 + random() * 25));
      if (id) {
        const b = layout.extentOf(state, id);
        const dx = random() * 80 - 40, dy = random() * 70 - 35, factor = 0.6 + random() * 1.2;
        layout.moveGroup(state, id, rect(b.x1 + dx, b.y1 + dy, b.x1 + dx + (b.x2 - b.x1) * factor, b.y1 + dy + (b.y2 - b.y1) * factor));
      }
      expect(layout.verify(state)).toBe(true);
      const sequences = layout.moves(state);
      expect(new Set(sequences.map((s: any) => JSON.stringify(s.source))).size).toBe(sequences.length);
    }
  });
});

describe("布局引擎:paint/hit/remapNotes", () => {
  it("paint 清屏、保存/恢复上下文、背景先画移动件后画", () => {
    const state = layout.build(100, 100);
    const id = layout.carve(state, rect(10, 10, 30, 30));
    layout.moveGroup(state, id, rect(40, 40, 60, 60));
    const calls: any[] = [];
    const ctx: any = Object.fromEntries(["save", "restore", "setTransform", "clearRect", "beginPath", "rect", "clip", "drawImage"].map((name) => [name, (...args: any[]) => calls.push({ name, args })]));
    const image = {};
    layout.render(ctx, image, state);
    expect(calls[0].name).toBe("save");
    expect(calls.find((c) => c.name === "clearRect").args).toEqual([0, 0, 100, 100]);
    const draws = calls.filter((c) => c.name === "drawImage");
    expect(draws.length).toBe(state.pieces.length);
    expect(draws[draws.length - 1].args).toEqual([image, 10, 10, 20, 20, 40, 40, 20, 20]);
    expect(calls[calls.length - 1].name).toBe("restore");
  });

  it("hit 选可见成员:排除被覆盖组与空洞,保留嵌套选择", () => {
    const state = layout.build(100, 100);
    const lower = layout.carve(state, rect(40, 40, 60, 60));
    const upper = layout.carve(state, rect(10, 10, 30, 30));
    layout.moveGroup(state, upper, rect(40, 40, 60, 60));
    expect(layout.pick(state, 50, 50).map((c: any) => c.id)).toEqual([upper]);
    expect(layout.pick(state, 50, 50).some((c: any) => c.id === lower)).toBe(false);
    expect(layout.pick(state, 20, 20)).toEqual([]);
    const nested = layout.build(100, 100);
    const parent = layout.carve(nested, rect(10, 10, 60, 60));
    const child = layout.carve(nested, rect(20, 20, 30, 30));
    expect(layout.pick(nested, 25, 25).map((c: any) => c.id)).toEqual([child, parent]);
    layout.moveGroup(nested, child, rect(80, 80, 90, 90));
    expect(layout.pick(nested, 85, 85).map((c: any) => c.id)).toEqual([child]);
    expect(layout.pick(nested, 70, 70)).toEqual([]);
  });

  it("跨检测细分的普通矩形批注沿同一条仿射映射", () => {
    const state = layout.build(100, 100, [{ bounds: rect(20, 20, 30, 30) }]);
    const parent = layout.carve(state, rect(10, 10, 40, 40));
    const notes: any[] = [
      { id: "rect", text: "panel", source: rect(10, 10, 40, 40), meta: { tags: ["local"] } },
      { id: "point", text: "pixel", source: rect(25, 25, 25, 25) },
      { id: "group", text: "component", source: rect(10, 10, 40, 40), groupId: parent },
      { id: "global", text: "global", source: null },
    ];
    const unchanged = clone(notes), before = clone(state);
    layout.moveGroup(state, parent, rect(40, 40, 100, 100));
    const remapped = layout.reflowNotes(notes, before, state);
    sameRect(remapped[0].source, rect(40, 40, 100, 100));
    sameRect(remapped[1].source, rect(70, 70, 70, 70));
    expect(remapped[2]).toEqual(notes[2]);
    expect(remapped[3].source).toBe(null);
    expect(notes).toEqual(unchanged);
    remapped[0].meta.tags.push("copy");
    expect(notes[0].meta.tags).toEqual(["local"]);
  });

  it("点批注跟随可见层(另一组件回位时)", () => {
    const state = layout.build(100, 100);
    const a = layout.carve(state, rect(10, 10, 30, 30));
    const b = layout.carve(state, rect(40, 40, 60, 60));
    layout.moveGroup(state, a, rect(40, 40, 60, 60));
    layout.moveGroup(state, b, rect(70, 70, 90, 90));
    layout.moveGroup(state, b, rect(40, 40, 60, 60));
    const before = clone(state), notes = [{ id: "point", text: "visible A", source: rect(50, 50, 50, 50) }];
    layout.moveGroup(state, a, rect(60, 60, 80, 80));
    expect(layout.reflowNotes(notes, before, state)[0].source).toEqual(rect(70, 70, 70, 70));
  });

  it("跨不同变换或透明空洞的矩形批注保持原锚", () => {
    const state = layout.build(100, 100);
    const parent = layout.carve(state, rect(10, 10, 40, 40));
    const child = layout.carve(state, rect(20, 20, 30, 30));
    const before = clone(state), notes = [{ id: "rect", text: "mixed", source: rect(10, 10, 40, 40) }];
    layout.moveGroup(state, child, rect(50, 50, 60, 60));
    expect(layout.reflowNotes(notes, before, state)).toEqual(notes);
    const beforeHole = clone(state);
    layout.moveGroup(state, parent, rect(20, 20, 70, 70));
    expect(layout.reflowNotes(notes, beforeHole, state)).toEqual(notes);
  });

  it("重映射的细长矩形保持正的分数几何且不出画布", () => {
    const state = layout.build(100, 100);
    const id = layout.carve(state, rect(10, 10, 30, 30));
    const before = clone(state), notes = [{ id: "tiny", text: "thin", source: rect(10.2, 10.4, 10.7, 20.4) }];
    layout.moveGroup(state, id, rect(-5, 95, 5, 100));
    const mapped = layout.reflowNotes(notes, before, state)[0].source;
    sameRect(mapped, rect(0.1, 95.1, 0.35, 97.6));
    expect(mapped.x2).toBeGreaterThan(mapped.x1);
    expect(mapped.y2).toBeGreaterThan(mapped.y1);
    expect(mapped.x1).toBeGreaterThanOrEqual(0);
    expect(mapped.y1).toBeGreaterThanOrEqual(0);
    expect(mapped.x2).toBeLessThanOrEqual(state.width);
    expect(mapped.y2).toBeLessThanOrEqual(state.height);
  });
});

describe("布局引擎:父子组件规则", () => {
  it("独立搬动的子组件脱离,父再动时子原地不动", () => {
    const state = layout.build(100, 100);
    const parent = layout.carve(state, rect(10, 10, 60, 60));
    const child = layout.carve(state, rect(20, 20, 30, 30));
    const childIds = new Set(state.groups.find((g: any) => g.id === child).pieces);
    layout.moveGroup(state, child, rect(80, 80, 90, 90));
    const parentGroup = state.groups.find((g: any) => g.id === parent);
    expect(parentGroup.pieces.some((id: string) => childIds.has(id))).toBe(false);
    sameRect(layout.extentOf(state, parent), rect(10, 10, 60, 60));
    layout.moveGroup(state, parent, rect(0, 0, 50, 50));
    sameRect(layout.extentOf(state, child), rect(80, 80, 90, 90));
    expect(layout.verify(state)).toBe(true);
  });

  it("no-op 与非法子变换都保持父成员关系", () => {
    const state = layout.build(100, 100);
    const parent = layout.carve(state, rect(10, 10, 60, 60));
    const child = layout.carve(state, rect(20, 20, 30, 30));
    const original = clone(state);
    layout.moveGroup(state, child, rect(20, 20, 30, 30));
    expect(state).toEqual(original);
    expect(() => layout.moveGroup(state, child, rect(20, 20, 20, 30))).toThrow(/尺寸必须为正/);
    expect(state).toEqual(original);
    layout.moveGroup(state, parent, rect(20, 20, 70, 70));
    sameRect(layout.extentOf(state, child), rect(30, 30, 40, 40));
    const childIds = state.groups.find((g: any) => g.id === child).pieces;
    expect(childIds.every((id: string) => state.groups.find((g: any) => g.id === parent).pieces.includes(id))).toBe(true);
  });

  it("搬父组件恰好携带一次内部子引用", () => {
    const state = layout.build(100, 100);
    const parent = layout.carve(state, rect(10, 10, 50, 50));
    const child = layout.carve(state, rect(20, 20, 30, 30));
    layout.moveGroup(state, parent, rect(20, 20, 100, 100));
    sameRect(layout.extentOf(state, child), rect(40, 40, 60, 60));
    expect(layout.pick(state, 45, 45).map((c: any) => c.id)).toEqual([child, parent]);
    expect(state.groups.find((g: any) => g.id === child).pieces.every((id: string) => state.groups.find((g: any) => g.id === parent).pieces.includes(id))).toBe(true);
    expect(layout.verify(state)).toBe(true);
  });
});

describe("布局引擎:movements 合并", () => {
  function adjacentMovedGroups() {
    const state = layout.build(100, 100);
    const a = layout.carve(state, rect(10, 10, 30, 30));
    const b = layout.carve(state, rect(30, 10, 50, 30));
    layout.moveGroup(state, a, rect(50, 50, 70, 70));
    layout.moveGroup(state, b, rect(70, 50, 90, 70));
    return { state, a: new Set(state.groups.find((g: any) => g.id === a).pieces), b: new Set(state.groups.find((g: any) => g.id === b).pieces) };
  }

  it("相邻搬运、批注不同:保持各自位置", () => {
    const { state, a } = adjacentMovedGroups();
    const notesA = ["change A"], notesB = ["change B"];
    const sequences = layout.moves(state, (piece: any) => a.has(piece.id) ? notesA : notesB);
    expect(sequences).toEqual([
      { source: rect(10, 10, 30, 30), movements: [{ to: rect(50, 50, 70, 70) }], annotations: ["change A"] },
      { source: rect(30, 10, 50, 30), movements: [{ to: rect(70, 50, 90, 70) }], annotations: ["change B"] },
    ]);
    notesA.push("later input mutation");
    expect(sequences[0].annotations).toEqual(["change A"]);
    sequences[1].annotations.push("later output mutation");
    expect(notesB).toEqual(["change B"]);
  });

  it("相邻搬运、有序批注相同:合并为一条;乱序相同不合并", () => {
    const { state } = adjacentMovedGroups();
    expect(layout.moves(state, () => ["same", "second"])).toEqual([
      { source: rect(10, 10, 50, 30), movements: [{ to: rect(50, 50, 90, 70) }], annotations: ["same", "second"] },
    ]);
    const idsA = new Set(state.groups[0].pieces);
    expect(layout.moves(state, (piece: any) => idsA.has(piece.id) ? ["same", "second"] : ["second", "same"]).length).toBe(2);
  });

  it("无批注回调时保持既有合并几何;回调非法报错", () => {
    const { state } = adjacentMovedGroups();
    const expected = [{ source: rect(10, 10, 50, 30), movements: [{ to: rect(50, 50, 90, 70) }], annotations: [] }];
    expect(layout.moves(state)).toEqual(expected);
    expect(layout.moves(state, () => [])).toEqual(expected);
    expect(() => layout.moves(state, () => "wrong")).toThrow(/批注格式不正确/);
  });
});

describe("布局引擎:校验", () => {
  it("检出源像素重复/空洞/悬挂引用/越界", () => {
    const state = layout.build(10, 10);
    const duplicated = clone(state);
    duplicated.pieces.push({ ...clone(duplicated.pieces[0]), id: "duplicate" });
    expect(() => layout.verify(duplicated)).toThrow(/重复使用原图像素/);
    const hole = clone(state);
    hole.pieces[0].source.x2 = 9;
    expect(() => layout.verify(hole)).toThrow(/未完整覆盖原图/);
    const invalid = clone(state);
    invalid.groups.push({ id: "dangling", label: "invalid", pieces: ["missing"] });
    expect(() => layout.verify(invalid)).toThrow(/引用无效/);
    const out = clone(state);
    out.pieces[0].to.x2 = 11;
    expect(() => layout.verify(out)).toThrow(/坐标或编号不正确/);
  });
});
