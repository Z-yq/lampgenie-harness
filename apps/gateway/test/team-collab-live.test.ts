/**
 * 虚拟组织协作开发流 live 测试(tasks/step-1525-j3-team-collab):对仓内活组织
 * `<repo>/.genie/team` 真跑一轮(live 模式复用同一组步骤)。
 *
 * 门控:`TEAM_COLLAB_LIVE=1` 才跑;默认整文件 skipped,不影响 e2e 全绿统计。
 * 硬纪律:绝不重启 7700/7870;不写 .genie 之外;报告落 `<repo>/.genie/team-collab/live-report.json`。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeCollabScenario, runCollabScenario, type CollabReport } from "./team-collab-scenario";

const LIVE = Boolean(process.env.TEAM_COLLAB_LIVE);
const REPO_ROOT = join(__dirname, "..", "..", "..");
const REPORT_DIR = join(REPO_ROOT, ".genie", "team-collab");
const REPORT_PATH = join(REPORT_DIR, "live-report.json");

describe.skipIf(!LIVE)("虚拟组织协作开发流(live 活组织)", () => {
  it(
    "对 .genie/team 活组织跑一轮并落报告",
    async () => {
      const { ctx, report } = await runCollabScenario({ mode: "live" });
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
      await closeCollabScenario(ctx);

      const failed = report.checks.filter((c) => !c.ok);
      expect(report.checks.length, "步骤数").toBeGreaterThan(0);
      expect(failed.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
      const weekly = report as CollabReport;
      expect(weekly.weekly?.total ?? -1).toBeGreaterThanOrEqual(0);
    },
    600_000,
  );
});
