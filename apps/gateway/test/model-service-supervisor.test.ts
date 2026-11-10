import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "@lampgenie/core";
import { Model150mSupervisor } from "../src/model-service-supervisor.js";

function configWith(ms: Record<string, unknown>) {
  return ConfigSchema.parse({ context: { modelScoring: ms } });
}

describe("Model150mSupervisor:内置模型生命周期边界", () => {
  it("autoStart=false:不探活、不拉起", async () => {
    const root = mkdtempSync(join(tmpdir(), "gh-ms-"));
    try {
      const s = new Model150mSupervisor({
        repoRoot: root,
        config: configWith({ mode: "shadow", localService: { autoStart: false } }),
        log: () => {},
      });
      await s.start();
      expect(s.statusOf().state).toBe("disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("外部 provider URL:不启动本地服务", async () => {
    const root = mkdtempSync(join(tmpdir(), "gh-ms-"));
    try {
      const s = new Model150mSupervisor({
        repoRoot: root,
        config: configWith({ mode: "shadow", providerUrl: "https://example.com/v1" }),
        log: () => {},
      });
      await s.start();
      expect(s.statusOf().state).toBe("external");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("本地 URL 但模型未安装:missing + 明确错误,不 spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "gh-ms-"));
    try {
      const s = new Model150mSupervisor({
        repoRoot: root,
        config: configWith({ mode: "shadow", providerUrl: "http://127.0.0.1:65530" }),
        log: () => {},
      });
      await s.start();
      const status = s.statusOf();
      expect(status.state).toBe("missing");
      expect(status.lastError).toContain("setup.sh");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
