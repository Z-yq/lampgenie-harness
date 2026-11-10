/** 标准化 workflow 模板(designs/19 §2.4):模型/面板可直接按名调用。 */
export const TEMPLATES: Record<string, string> = {
  /** 单元测试:按包循环跑 vitest,失败包派 agent 分析。 */
  "unit-tests": `
const packages = await world.glob("packages/*/package.json");
const pkgs = packages.map(p => p.split("/")[1]).filter(p => p);
log("将测试 " + pkgs.length + " 个包");
for (const pkg of pkgs) {
  const r = await world.run("pnpm --filter @lampgenie/" + (pkg === "core" ? "core" : pkg.replace("harness-", "")) + " test 2>&1 | tail -5 || true", { timeoutMs: 180000 });
  const passed = /Tests\\s+\\d+ passed/.test(r.stdout) && !/failed/.test(r.stdout.split("Tests")[1] ?? "");
  if (passed) {
    report({ pkg, ok: true, tail: r.stdout.split("\\n").filter((l) => /Test Files|Tests\\s|FAIL|failed/.test(l)).slice(-3).join(" ") });
  } else {
    const analysis = await agent("test-analyst").ask(
      "以下测试输出来自包 " + pkg + ",一句话给出失败根因与修复建议:\\n" + r.stdout.slice(-2000)
    );
    report({ pkg, ok: false, tail: r.stdout.slice(-800), analysis });
  }
}
`,
  /** 功能测试:场景清单逐项 agent 执行+确定性验证。 */
  "functional-test": `
const scenarios = JSON.parse(args.scenarios ?? "[]") as { name: string; run: string }[];
for (const s of scenarios) {
  const r = await world.run(s.run, { timeoutMs: 120000 });
  report({ scenario: s.name, ok: r.code === 0, stdoutTail: r.stdout.slice(-300) });
}
`,
  /** 算法效果测试:数据集确定性循环+agent 判分+聚合。 */
  "algo-eval": `
const cases = JSON.parse(args.cases ?? "[]") as { id: string; input: string; expect: string }[];
let hit = 0;
for (const c of cases) {
  const verdict = await agent("judge").ask(
    "判定输出是否满足期望。输入:" + c.input + "\\n期望:" + c.expect + "\\n严格输出 JSON:{\\"pass\\":boolean,\\"reason\\":\\"\\"}",
  );
  const v = JSON.parse(verdict as string) as { pass: boolean; reason: string };
  if (v.pass) hit++;
  report({ case: c.id, pass: v.pass, reason: v.reason });
}
log("命中率 " + hit + "/" + cases.length);
report({ summary: true, hitRate: cases.length ? hit / cases.length : 0 });
`,
};

/** 模板渲染(args 注入为模板里的 args 变量)。 */
export function renderTemplate(name: string, args: Record<string, unknown> = {}): string {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`未知模板: ${name}(可用: ${Object.keys(TEMPLATES).join("/")})`);
  return `const args = ${JSON.stringify(args)};\n` + tpl;
}
