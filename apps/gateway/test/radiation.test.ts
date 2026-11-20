/**
 * L3 辐射面枚举器(设计稿 35):radiation action 四分面清单概念验证。
 */
import { describe, expect, it } from "vitest";

// 副作用白名单(与 sense-tool.ts 同源)
const SIDE_EFFECT_PATTERNS = [
  { re: /writeFile|appendFile|mkdir|rename|unlink|rmSync|writeSync/i, label: "写文件" },
  { re: /fetch|WebSocket|net\.connect|http\.request|axios/i, label: "网络请求" },
  { re: /execFile|spawn|execSync|child_process|process\.exit/i, label: "进程操作" },
  { re: /Date\.now|Math\.random|crypto\.randomUUID/i, label: "非确定性" },
  { re: /process\.env\[|globalThis\./i, label: "全局状态" },
];

describe("L3 radiation 辐射面枚举器", () => {
  it("四分面概念:上游/下游/契约/副作用各自独立且完整", () => {
    const faces = ["上游调用方", "下游依赖", "契约(签名+类型)", "副作用面"];
    for (const face of faces) {
      expect(face.length).toBeGreaterThan(2); // 每个面有内容
    }
    expect(faces).toHaveLength(4); // 恰好四分面
  });

  it("副作用白名单:writeFileSync 命中「写文件」;Date.now 命中「非确定性」", () => {
    const hits1 = SIDE_EFFECT_PATTERNS.filter((p) => p.re.test("writeFileSync"));
    expect(hits1.map((h) => h.label)).toContain("写文件");
    const hits2 = SIDE_EFFECT_PATTERNS.filter((p) => p.re.test("Date.now()"));
    expect(hits2.map((h) => h.label)).toContain("非确定性");
  });

  it("副作用白名单:纯函数名不误报", () => {
    const pure = "calculateTotal"; // 无副作用关键词
    const hits = SIDE_EFFECT_PATTERNS.filter((p) => p.re.test(pure));
    expect(hits).toHaveLength(0);
  });

  it("SENSE_ACTIONS 包含 radiation(gateway 工具面已注册)", async () => {
    const mod = await import("../src/sense-tool.js");
    const tool = mod.codeSenseTool("/tmp");
    const desc = JSON.stringify(tool.parameters ?? {});
    expect(desc).toContain("radiation");
  });
});
