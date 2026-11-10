import { describe, it, expect } from "vitest";
import { codeSense } from "../src/index";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("python 符号接入 debug 剖面(step-034 F4:adapter 此前为孤儿)", () => {
  it("py 仓 debug 查询:符号可定位、不再是『未找到符号』", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-py-"));
    try {
      writeFileSync(join(dir, "svc.py"), [
        "def resolve_user(payload):",
        "    return normalize(payload)",
        "",
        "",
        "def normalize(p):",
        "    return str(p).strip()",
        "",
      ].join("\n"));
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "helper.py"), "def util_x():\n    return 1\n");
      const r = await codeSense(dir, "resolve_user", { mode: "debug" });
      expect(r.callchain?.center?.name).toBe("resolve_user");
      expect(r.callchain?.center?.file).toBe("svc.py");
      expect((r.degraded ?? []).some((d) => d.reason.includes("未找到符号"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
