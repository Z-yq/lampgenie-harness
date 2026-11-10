import { describe, it, expect } from "vitest";
import { runOfficeDoctor, type DoctorProbe, type EnvCheckItem } from "../src/office-doctor.js";

/** M104 办公环境 doctor:probe 桩注入,覆盖
 *  - 全 ok;
 *  - 缺 optional(中文字体)→ needs-install 且 installAttempted=false(不许标 ok / 静默跳过);
 *  - attemptInstall 成功后复验版本;
 *  - 安装失败 → install-failed 且 ok=false;
 *  - core(node)缺失 → ok=false。 */

type Table = Record<string, string | null>;

/** 造一个按命令查表的 probe;sh(安装)默认成功。 */
function tableProbe(overrides: Table = {}): DoctorProbe {
  const base: Table = {
    node: "v24.22.2",
    soffice: "LibreOffice 24.2.7.2 420(Build:2)",
    "fc-list": "Noto Sans CJK SC:style=Regular\nDejaVu Sans",
    python3: "Python 3.11.2",
  };
  const table: Table = { ...base, ...overrides };
  return async (cmd, _args) => {
    if (cmd === "sh") return { ok: true, out: "" };
    const out = table[cmd];
    if (out === null || out === undefined) return { ok: false, out: "command not found" };
    return { ok: true, out };
  };
}

function itemOf(report: { items: EnvCheckItem[] }, name: string): EnvCheckItem {
  const item = report.items.find((it) => it.name === name);
  expect(item, `缺少 ${name} 项(不允许静默跳过)`).toBeTruthy();
  return item as EnvCheckItem;
}

describe("office-doctor", () => {
  it("全 ok:core/optional/install-on-demand 都可用 → ok=true,均未尝试安装", async () => {
    const report = await runOfficeDoctor({ probe: tableProbe() });
    expect(report.ok).toBe(true);
    expect(report.items.map((it) => it.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(report.items.every((it) => it.installAttempted === false)).toBe(true);
    expect(itemOf(report, "node").version).toBe("24.22.2");
    expect(itemOf(report, "libreoffice").version).toBe("24.2.7.2");
    expect(itemOf(report, "python3").version).toBe("3.11.2");
  });

  it("缺 optional(中文字体)→ needs-install 且 installAttempted=false", async () => {
    const report = await runOfficeDoctor({ probe: tableProbe({ "fc-list": "DejaVu Sans" }) });
    const fonts = itemOf(report, "中文字体");
    expect(fonts.kind).toBe("optional");
    expect(fonts.status).toBe("needs-install");
    expect(fonts.installAttempted).toBe(false);
    expect(fonts.remediation.length).toBeGreaterThan(0);
    // optional 缺失不阻断整体
    expect(report.ok).toBe(true);
  });

  it("attemptInstall=true 且装成功 → ok 且版本已复验", async () => {
    let installed = false;
    const probe: DoctorProbe = async (cmd, args) => {
      if (cmd === "sh") {
        installed = true;
        return { ok: true, out: "installed" };
      }
      if (cmd === "python3") {
        return installed ? { ok: true, out: "Python 3.12.1" } : { ok: false, out: "python3: not found" };
      }
      return tableProbe()(cmd, args);
    };
    const report = await runOfficeDoctor({ probe, attemptInstall: true });
    const py = itemOf(report, "python3");
    expect(py.kind).toBe("install-on-demand");
    expect(py.status).toBe("ok");
    expect(py.installAttempted).toBe(true);
    expect(py.version).toBe("3.12.1");
    expect(report.ok).toBe(true);
  });

  it("安装失败 → install-failed 且 ok=false", async () => {
    const probe: DoctorProbe = async (cmd, args) => {
      if (cmd === "sh") return { ok: false, out: "E: 无法安装,没有管理员权限" };
      if (cmd === "soffice" || cmd === "libreoffice") return { ok: false, out: "not found" };
      return tableProbe()(cmd, args);
    };
    const report = await runOfficeDoctor({ probe, attemptInstall: true });
    const lo = itemOf(report, "libreoffice");
    expect(lo.status).toBe("install-failed");
    expect(lo.installAttempted).toBe(true);
    expect(lo.remediation).toContain("安装失败");
    expect(report.ok).toBe(false);
  });

  it("未尝试安装的 install-on-demand 项 → needs-install,不阻断整体", async () => {
    const report = await runOfficeDoctor({ probe: tableProbe({ soffice: null, libreoffice: null }) });
    const lo = itemOf(report, "libreoffice");
    expect(lo.status).toBe("needs-install");
    expect(lo.installAttempted).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("core(node)缺失 → ok=false,且不会走安装尝试", async () => {
    const report = await runOfficeDoctor({ probe: tableProbe({ node: null }), attemptInstall: true });
    const node = itemOf(report, "node");
    expect(node.kind).toBe("core");
    expect(node.status).toBe("missing");
    expect(node.installAttempted).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("core(node 版本过低)→ missing 且 ok=false", async () => {
    const report = await runOfficeDoctor({ probe: tableProbe({ node: "v16.20.0" }) });
    const node = itemOf(report, "node");
    expect(node.status).toBe("missing");
    expect(node.version).toBe("16.20.0");
    expect(report.ok).toBe(false);
  });
});
