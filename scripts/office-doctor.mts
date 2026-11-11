#!/usr/bin/env tsx
/**
 * 办公环境 doctor CLI。
 * 用法:tsx scripts/office-doctor.mts [--json] [--install]
 * 退出码:0 = core 全 ok 且没有 install-on-demand 安装失败;2 = 否则。
 * --install 会真的执行安装命令(apt 等),默认只探测不安装;
 * 缺失但没尝试安装的项 status=needs-install,不会被标成 ok。
 */
import { runOfficeDoctor } from "../apps/gateway/src/office-doctor.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const attemptInstall = args.includes("--install");

const report = await runOfficeDoctor({ attemptInstall });

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`办公环境体检: ${report.ok ? "PASS" : "FAIL"}`);
  for (const it of report.items) {
    const ver = it.version ? ` ${it.version}` : "";
    console.log(`  [${it.status}] ${it.name}${ver} (${it.kind}${it.installAttempted ? ", 已尝试安装" : ""})`);
    if (it.remediation) console.log(`    → ${it.remediation}`);
  }
}

process.exitCode = report.ok ? 0 : 2;
