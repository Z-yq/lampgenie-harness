#!/usr/bin/env tsx
/**
 * 产物 QA CLI(M101 / M103)。
 *
 * 用法:tsx scripts/office-qa.mts <file> [--json] [--recalc]
 *   --recalc  对 .xlsx 用 soffice 真重算一次 —— 脚本写出的公式常常没有缓存值,
 *             只有重算后才知道到底算出了什么。没有重算引擎时输出 recalc-skipped
 *             并保持退出码 0,但会明说「未重算」(不把「没检查」说成「干净」)。
 * 退出码:0 = 无 error 级失败;2 = 有 error 级失败或用法错误(脚本异常同样非 0)。
 *
 * 人类可读模式打印每项结果与 remediation;--json 输出机器可读 {file, ok, findings}。
 */
import { checkOfficeArtifact } from "../apps/gateway/src/office-qa.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const recalc = args.includes("--recalc") || args.includes("--recalc=true");
const file = args.find((a) => !a.startsWith("--"));

if (!file) {
  console.error("用法: tsx scripts/office-qa.mts <file> [--json] [--recalc]");
  process.exitCode = 2;
} else {
  const report = await checkOfficeArtifact(file, { recalc });
  if (json) {
    console.log(JSON.stringify({ file, ok: report.ok, findings: report.findings }, null, 2));
  } else {
    console.log(`${report.ok ? "PASS" : "FAIL"} ${file}`);
    for (const f of report.findings) {
      if (f.passed) continue;
      console.log(`  [${f.severity}] ${f.code} ${f.name}: ${f.message}`);
      if (f.remediation) console.log(`    → ${f.remediation}`);
    }
    const passed = report.findings.filter((f) => f.passed).length;
    console.log(`  ${passed}/${report.findings.length} 项通过`);
    if (report.findings.some((f) => f.code === "recalc-skipped" && !f.passed)) {
      console.log("  未重算:本次结果不含重算真值(公式没有缓存值时无法确认是否算错)");
    }
    if (recalc && !/\.xlsx$/i.test(file)) {
      console.log("  --recalc 只对 .xlsx 生效,已忽略");
    }
  }
  process.exitCode = report.ok ? 0 : 2;
}
