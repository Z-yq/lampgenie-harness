/** change-scope:11 个中文动词各 1 例判 surface;空串/问候语/小改 → normal。 */
import { describe, it, expect } from "vitest";
import { classifyChangeScope } from "../src/surface/change-scope.js";

const VERBS = ["替换", "迁移", "重命名", "改名", "下线", "统一", "换掉", "改成", "废弃", "删除旧", "全面改"];

describe("classifyChangeScope", () => {
  it("11 个动词各 1 例 → surface,且 matched 含该动词", () => {
    for (const v of VERBS) {
      const text = `把这个 ${v} 一下`;
      const r = classifyChangeScope(text);
      expect(r.scope, `${v} 应判 surface`).toBe("surface");
      expect(r.matched).toContain(v);
    }
  });

  it("第二批中文动词(17 个)各 1 例 → surface", () => {
    const SECOND_BATCH = [
      "换成", "换为", "换用", "切换为", "统一到", "统一成", "改名为", "重命名为",
      "移除", "删掉", "取代", "替代", "搬迁", "迁移到", "升级到", "整合到", "收敛到",
    ];
    for (const v of SECOND_BATCH) {
      const r = classifyChangeScope(`请把 ${v} 新实现`);
      expect(r.scope, `${v} 应判 surface`).toBe("surface");
      expect(r.matched, `${v} 应在 matched 里`).toContain(v);
    }
  });

  it("第二批英文动词(9 个)各 1 例 → surface", () => {
    const SECOND_BATCH_EN = [
      "swap", "switch to", "convert to", "consolidate", "unify", "sunset", "drop", "move to", "replace with",
    ];
    for (const v of SECOND_BATCH_EN) {
      const r = classifyChangeScope(`please ${v} the legacy flag everywhere`);
      expect(r.scope, `${v} 应判 surface`).toBe("surface");
      expect(r.matched, `${v} 应在 matched 里`).toContain(v);
    }
  });

  it("反例:没有换代动词的普通请求仍判 normal", () => {
    for (const text of ["给面板加个按钮", "把这个函数打印出来看看", "跑一下测试"]) {
      const r = classifyChangeScope(text);
      expect(r.scope, `${JSON.stringify(text)} 应判 normal`).toBe("normal");
      expect(r.matched).toEqual([]);
    }
  });

  it("反例:新增动词遇显式小改标记仍被抑制(normal 但 matched 照实回报)", () => {
    const r = classifyChangeScope("把这里的文案换成新标题,明确小改");
    expect(r.scope).toBe("normal");
    expect(r.matched).toContain("换成");
  });

  it("英文动词(可选词表)也能识别", () => {
    expect(classifyChangeScope("rename demoFlag everywhere").scope).toBe("surface");
    expect(classifyChangeScope("please remove all legacy flags").scope).toBe("surface");
  });

  it("小改/空串/问候语 → normal", () => {
    for (const text of ["新建按钮", "小修文案", "", "   ", "你好", "帮我看看这个函数"]) {
      const r = classifyChangeScope(text);
      expect(r.scope, `${JSON.stringify(text)} 应判 normal`).toBe("normal");
      expect(r.matched).toEqual([]);
    }
  });

  it("matched 去重且确定性(两跑一致)", () => {
    const a = classifyChangeScope("替换并统一 demoFlag");
    const b = classifyChangeScope("替换并统一 demoFlag");
    expect(a).toEqual(b);
    expect(new Set(a.matched).size).toBe(a.matched.length);
  });

  it("显式小改标记优先:「改成 30 秒,明确小改」判 normal 但 matched 照实回报(实测回归)", () => {
    const r = classifyChangeScope("把 config.ts 里的超时改成 30 秒,明确小改");
    expect(r.scope).toBe("normal");
    expect(r.matched).toContain("改成"); // 命中照实留痕,便于审计「为什么没升级」
  });

  it("没有显式标记时「改成」仍是 surface(不弱化原词表)", () => {
    expect(classifyChangeScope("把超时改成 30 秒").scope).toBe("surface");
  });
});
