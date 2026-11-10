import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** step-112 设置→Coding 模型:结构回归(真 UI 在 panel.ts 模板内,这里锁关键面不丢)。 */
describe("step-112 Coding 模型设置结构", () => {
  it("四角色下拉/思考力度/Provider 编辑/模型目录/高级折叠均在", async () => {
    const panel = servePanel(7894, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch("http://127.0.0.1:7894/");
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const marker of [
        "sec-model",
        "cm-roles",
        "role-main", "role-subagent", "role-compact", "role-review", "role-digest",
        "role-digest-badge", "coding.models.digest", "提炼模型", "(默认回退压缩模型)",
        "effortSeg", "effortNow",
        "prov-type", "apiType", "headers",
        "cm-new-name", "cm-new-prov", "cm-new-add",
        "modelList", "cm-mrow", "cm-cw", "cm-mt",
        "supportsToolCall", "supportsImage",
        "setmain", "data-act=\"toggle\"",
        "cfg-adv", "cfg-kv", "cfg-mt",
        "回退主模型", "仅确定性层",
      ]) {
        expect(html, "缺少标记:" + marker).toContain(marker);
      }
    } finally {
      await panel.close();
    }
  });
});
