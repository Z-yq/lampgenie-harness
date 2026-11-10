#!/usr/bin/env tsx
/**
 * 凭证红线门禁( §5 红线①, D3):全仓精确前缀 grep,
 * 排除 fixture/测试样例/vendor/lock(精确前缀纪律:裸 "sk-" 会误伤 sk-m 子串—— 经验证教训)。
 * --self-test:植入一个真形态密钥到临时文件,断言真能抓到(防自证空转)。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..");

/** 精确前缀模式:密钥形态(长度门槛滤掉普通词);新增形态走这里,别放宽成裸 sk-。 */
const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9]{16,}/, label: "OpenAI 形态 sk-…" },
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS AKIA…" },
  { re: /ghp_[A-Za-z0-9]{20,}/, label: "GitHub ghp_…" },
  { re: /eyJhbGciOi[A-Za-z0-9._-]{40,}/, label: "JWT eyJ…" },
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "vendor", "ref", "docs/ui-shots"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml", "cred-gate.ts", "audit-reconcile.ts"]);
/** 允许的假密钥样例(测试夹具):白名单文件级,不是词级。 */
const FIXTURE_ALLOW = /(test|spec|mock|fixture|example|\.test\.)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (SKIP_DIRS.has(f)) continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|json|yaml|yml|md|env|sh)$/.test(f)) out.push(p);
  }
  return out;
}

function scan(files: string[], allowFixture: boolean): { file: string; line: number; label: string; hit: string }[] {
  const hits: { file: string; line: number; label: string; hit: string }[] = [];
  for (const f of files) {
    if (SKIP_FILES.has(f.split("/").pop()!)) continue;
    const isFixture = allowFixture && FIXTURE_ALLOW.test(f);
    if (isFixture) continue;
    const lines = readFileSync(f, "utf-8").split("\n");
    lines.forEach((line, i) => {
      for (const { re, label } of PATTERNS) {
        const m = re.exec(line);
        if (m) hits.push({ file: f.replace(ROOT + "/", ""), line: i + 1, label, hit: m[0].slice(0, 12) + "…" });
      }
    });
  }
  return hits;
}

if (process.argv.includes("--self-test")) {
  // 自证:植入真形态密钥,扫描必须命中(否则门禁是空转)。
  const tmp = mkdtempSync(join(tmpdir(), "credgate-"));
  const planted = join(tmp, "leaked.ts");
  writeFileSync(planted, `const k = "sk-selftest1234567890abcdef";\n`);
  const hits = scan([planted], false);
  rmSync(tmp, { recursive: true, force: true });
  if (hits.length === 0) {
    console.error("❌ 自测失败:植入密钥未被检出(门禁空转)");
    process.exit(1);
  }
  console.log(`✅ 自测:植入密钥被检出(${hits[0]!.label})`);
  process.exit(0);
}

const files = walk(ROOT);
const hits = scan(files, true);
if (hits.length > 0) {
  console.error(`❌ 凭证红线:${hits.length} 处命中`);
  for (const h of hits) console.error(`  ${h.file}:${h.line} [${h.label}] ${h.hit}`);
  process.exit(1);
}
console.log(`✅ 凭证红线:${files.length} 文件扫描零命中(精确前缀;fixture/lock/vendor 排除)`);
