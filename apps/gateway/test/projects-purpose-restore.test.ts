// 「显式添加 harness 根后每次刷新项目消失」回归(2026-10-27):
// add() 置 purpose=project 落盘 → 重建注册表(load)必须保留 purpose,而非回退 conversation。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry, HARNESS_PROJECT_ID } from "../src/projects.js";

describe("项目注册表 purpose 持久化", () => {
  it("显式添加 harness 根 → 重启(load)后 purpose=project 保留(面板不再过滤)", () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-purpose-"));
    try {
      const file = join(dir, "projects.json");
      const root = join(dir, "harness");
      mkdirSync(root);
      const a = new ProjectRegistry(root, file);
      const r = a.add(root); // 显式添加 harness 根=用户要求它作为项目
      expect(r.ok).toBe(true);
      expect(a.list().find((p) => p.id === HARNESS_PROJECT_ID)?.purpose).toBe("project");
      // 模拟重启:同文件重建
      const b = new ProjectRegistry(root, file);
      const hp = b.list().find((p) => p.id === HARNESS_PROJECT_ID);
      expect(hp?.purpose).toBe("project"); // 修复前:回退 conversation → 面板过滤 → 「项目消失」
      expect(hp?.availability).toBe("available");
      // 未显式添加过的全新注册表:默认仍是 conversation(新用户空态不受影响)
      const c = new ProjectRegistry(root, join(dir, "fresh.json"));
      expect(c.list().find((p) => p.id === HARNESS_PROJECT_ID)?.purpose).toBe("conversation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
