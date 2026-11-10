#!/usr/bin/env node
/**
 * E2E 晋升事务(机制 M6):plan → validate(全量对账)→ apply(备份 / copy / matrix upsert)→ audit(重读真实文件)
 * → 任一步失败整体回滚(恢复备份、删除本次新建)。
 *
 * 用法:
 *   node scripts/e2e-promote.mjs --plan <plan.json>                 # dry-run(默认,只校验并打印动作)
 *   node scripts/e2e-promote.mjs --plan <plan.json> --apply --reviewed
 *   可选:--force(允许覆盖已存在的目标文件)、--root <dir>(晋升根,缺省 cwd)、-h/--help
 *
 * 纪律:
 *   - 只动 --root 内的目标文件与 matrix,不碰 apps/gateway/src;
 *   - apply 前必须每个 case.reviewed=true 且 CLI 带 --reviewed(人工审核确认);
 *   - 审计不看内存里的计划,一律重读落盘文件与 matrix,避免"矩阵说 covered 但 spec 不存在"。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 半转正信号:被 skip / only 掉的测试不算真覆盖。 */
const SKIP_ONLY_RE = /\.skip\(|\.only\(|\bskip:|\bonly:/;
/** 测试调用计数口径:it( / test( 各一次。 */
const TEST_CALL_RE = /\b(?:it|test)\(/g;

/** 去掉注释行(行首 // 与 /* *\/ 块),行号不变,便于报行号。 */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

/** 统计 spec 文本里 it( / test( 的出现次数(注释行不计)。 */
export function countTests(specText) {
  const code = stripComments(specText);
  const hits = code.match(new RegExp(TEST_CALL_RE.source, "g"));
  return hits ? hits.length : 0;
}

/** 找出 .skip( / .only( / skip: / only: 的行(注释行跳过),返回 [{line,text}]。 */
export function findSkipOnly(specText) {
  const out = [];
  String(specText)
    .split("\n")
    .forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (SKIP_ONLY_RE.test(line)) out.push({ line: i + 1, text: line.trim().slice(0, 120) });
    });
  return out;
}

/** 读计划 JSON(格式错误直接抛,CLI 转成非零退出)。 */
export function loadPlan(file) {
  const abs = resolve(file);
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    throw new Error(`计划文件读取失败(${abs}): ${e.message}`);
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    throw new Error(`计划 JSON 解析失败(${abs}): ${e.message}`);
  }
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.cases)) {
    throw new Error(`计划格式错误(${abs}):缺 cases 数组`);
  }
  return plan;
}

function absOf(rootAbs, p) {
  if (typeof p !== "string" || !p.trim()) return null;
  return isAbsolute(p) ? p : join(rootAbs, p);
}

function insideRoot(rootAbs, abs) {
  const rel = relative(rootAbs, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 全量对账:文件存在性 / 目标冲突 / 半转正 / fixtures / matrix 结构与 count / apply 审批门。
 * 只读,不写盘。
 */
export function validatePlan(root, plan, opts = {}) {
  const { apply = false, reviewed = false, force = false } = opts;
  const rootAbs = resolve(root);
  const errors = [];
  const warnings = [];
  const actions = [];
  const cases = Array.isArray(plan?.cases) ? plan.cases : [];
  if (!cases.length) errors.push("计划没有任何 case");
  if (apply && !reviewed) errors.push("apply 需要 CLI --reviewed(人工审核确认)");

  const seenIds = new Set();
  const seenRowIds = new Set();
  const matrixSeen = new Set();

  cases.forEach((c, i) => {
    const tag = `cases[${i}]${c && typeof c.id === "string" && c.id ? `(${c.id})` : ""}`;
    if (!c || typeof c !== "object") {
      errors.push(`${tag} 不是对象`);
      return;
    }
    if (typeof c.id !== "string" || !c.id.trim()) errors.push(`${tag} 缺 id`);
    else if (seenIds.has(c.id)) errors.push(`${tag} id 重复: ${c.id}`);
    else seenIds.add(c.id);

    const fromAbs = absOf(rootAbs, c.from);
    const toAbs = absOf(rootAbs, c.to);
    if (!fromAbs) errors.push(`${tag} 缺 from`);
    else if (!insideRoot(rootAbs, fromAbs)) errors.push(`${tag} from 越出 root: ${c.from}`);
    if (!toAbs) errors.push(`${tag} 缺 to`);
    else if (!insideRoot(rootAbs, toAbs)) errors.push(`${tag} to 越出 root: ${c.to}`);

    let specText = null;
    if (fromAbs) {
      if (!existsSync(fromAbs)) errors.push(`${tag} from 不存在: ${c.from}`);
      else if (!isFile(fromAbs)) errors.push(`${tag} from 不是文件: ${c.from}`);
      else {
        specText = readFileSync(fromAbs, "utf8");
        const hits = findSkipOnly(specText);
        if (hits.length) {
          errors.push(
            `${tag} spec 含 skip/only(半转正):第 ${hits.map((h) => h.line).join(",")} 行`,
          );
        }
      }
    }
    if (toAbs && existsSync(toAbs) && !force) {
      errors.push(`${tag} 目标已存在(需 --force 才覆盖): ${c.to}`);
    }

    // ---- fixtures ----
    const fixtures = Array.isArray(c.fixtures) ? c.fixtures : [];
    fixtures.forEach((f, fi) => {
      const ftag = `${tag}.fixtures[${fi}]`;
      if (!f || typeof f !== "object") {
        errors.push(`${ftag} 不是对象`);
        return;
      }
      const fFromAbs = absOf(rootAbs, f.from);
      const fToAbs = absOf(rootAbs, f.to);
      if (!fFromAbs) errors.push(`${ftag} 缺 from`);
      else if (!existsSync(fFromAbs)) errors.push(`${ftag} from 不存在: ${f.from}`);
      else if (!isFile(fFromAbs)) errors.push(`${ftag} from 不是文件: ${f.from}`);
      if (!fToAbs) errors.push(`${ftag} 缺 to`);
      else if (existsSync(fToAbs) && !force) {
        errors.push(`${ftag} 目标已存在(需 --force 才覆盖): ${f.to}`);
      }
    });

    // ---- matrix row ----
    const mPath = c.matrix?.path;
    const row = c.matrix?.row;
    if (typeof mPath !== "string" || !mPath.trim()) errors.push(`${tag} 缺 matrix.path`);
    if (!row || typeof row !== "object") errors.push(`${tag} 缺 matrix.row`);
    if (row && typeof row === "object") {
      if (typeof row.id !== "string" || !row.id.trim()) errors.push(`${tag} matrix.row.id 缺失`);
      else if (seenRowIds.has(row.id)) errors.push(`${tag} matrix.row.id 重复: ${row.id}`);
      else seenRowIds.add(row.id);
      if (row.status !== "covered") {
        errors.push(`${tag} matrix.row.status 只能是 covered,实际: ${JSON.stringify(row.status)}`);
      }
      if (typeof row.spec !== "string" || !row.spec.trim()) errors.push(`${tag} matrix.row.spec 缺失`);
      else if (toAbs && resolve(absOf(rootAbs, row.spec) || "") !== resolve(toAbs)) {
        warnings.push(`${tag} matrix.row.spec(${row.spec}) 与 case.to(${c.to}) 不一致,审计会按 row.spec 核对`);
      }

      // count 必须与真实文件的 test 调用数一致:以「晋升后的内容」(from)为准;
      // from 读不到时才退回 row.spec 已存在的文件(避免把即将被覆盖的旧文件当成真源)。
      if (typeof row.spec === "string" && row.spec.trim()) {
        const rowSpecAbs = absOf(rootAbs, row.spec);
        let countText = specText;
        if (countText == null && rowSpecAbs && isFile(rowSpecAbs)) {
          countText = readFileSync(rowSpecAbs, "utf8");
        }
        if (countText == null) {
          errors.push(`${tag} 无法计算 expected count(缺少 spec 文本)`);
        } else {
          const expected = countTests(countText);
          if (!Number.isInteger(row.count)) {
            errors.push(`${tag} matrix.row.count 必须是整数,实际: ${JSON.stringify(row.count)}`);
          } else if (row.count !== expected) {
            errors.push(`${tag} matrix.row.count 与真实 test 数不一致: expected ${expected}, got ${row.count}`);
          }
        }
      }
    }

    // ---- matrix 文件 ----
    if (typeof mPath === "string" && mPath.trim()) {
      const mAbs = absOf(rootAbs, mPath);
      if (!mAbs || !insideRoot(rootAbs, mAbs)) {
        errors.push(`${tag} matrix.path 越出 root: ${mPath}`);
      } else if (!existsSync(mAbs)) {
        if (!apply) errors.push(`${tag} matrix.path 不存在(dry-run 要求存在,apply 才允许新建): ${mPath}`);
        else warnings.push(`${tag} matrix.path 不存在,apply 时新建: ${mPath}`);
      } else if (!isFile(mAbs)) {
        const msg = `${tag} matrix.path 不是文件: ${mPath}`;
        // apply 时放行到执行期(必然失败并触发整体回滚),dry-run 直接判错
        if (!apply) errors.push(msg);
        else warnings.push(`${msg}(apply 写盘会失败并回滚)`);
      } else {
        try {
          const data = JSON.parse(readFileSync(mAbs, "utf8"));
          if (!data || typeof data !== "object" || !Array.isArray(data.cases)) {
            errors.push(`${tag} matrix JSON 缺 cases 数组: ${mPath}`);
          }
        } catch (e) {
          errors.push(`${tag} matrix JSON 解析失败(${mPath}): ${e.message}`);
        }
      }
      matrixSeen.add(mPath);
    }

    // ---- apply 审批门 ----
    if (apply && c.reviewed !== true) errors.push(`${tag} apply 要求 case.reviewed=true`);

    // ---- dry-run 动作清单 ----
    if (c.from && c.to) actions.push({ op: "copy", from: c.from, to: c.to });
    fixtures.forEach((f) => {
      if (f?.from && f?.to) actions.push({ op: "copy", from: f.from, to: f.to });
    });
    if (typeof mPath === "string" && mPath.trim() && row) {
      actions.push({ op: "matrix-upsert", path: mPath, row });
    }
  });

  if (matrixSeen.size === 0 && cases.length > 0) errors.push("计划里没有任何 matrix.path");
  return { ok: errors.length === 0, errors, warnings, actions };
}

/**
 * 审计:一律重读落盘文件(不看计划里的声明)。
 * to/spec/fixtures 必须存在;spec 无 skip/only;matrix row 的 spec/count 与真实文件一致。
 */
export function auditPlan(root, plan) {
  const rootAbs = resolve(root);
  const errors = [];
  const cases = Array.isArray(plan?.cases) ? plan.cases : [];

  cases.forEach((c, i) => {
    const tag = `cases[${i}]${c && typeof c.id === "string" && c.id ? `(${c.id})` : ""}`;
    const toAbs = absOf(rootAbs, c?.to);
    if (!toAbs || !isFile(toAbs)) {
      errors.push(`${tag} 审计失败:目标 spec 不存在 ${c?.to}`);
      return;
    }
    const hits = findSkipOnly(readFileSync(toAbs, "utf8"));
    if (hits.length) {
      errors.push(`${tag} 审计失败:目标 spec 含 skip/only(第 ${hits.map((h) => h.line).join(",")} 行)`);
    }

    (Array.isArray(c.fixtures) ? c.fixtures : []).forEach((f, fi) => {
      const fToAbs = absOf(rootAbs, f?.to);
      if (!fToAbs || !isFile(fToAbs)) {
        errors.push(`${tag}.fixtures[${fi}] 审计失败:目标 fixture 不存在 ${f?.to}`);
      }
    });

    const mAbs = absOf(rootAbs, c?.matrix?.path);
    let data = null;
    try {
      data = JSON.parse(readFileSync(mAbs, "utf8"));
    } catch (e) {
      errors.push(`${tag} 审计失败:读 matrix 失败(${c?.matrix?.path}): ${e.message}`);
      return;
    }
    const rows = Array.isArray(data?.cases) ? data.cases : [];
    const rowId = c?.matrix?.row?.id;
    const found = rows.find((r) => r && r.id === rowId);
    if (!found) {
      errors.push(`${tag} 审计失败:matrix 找不到 row.id=${rowId}`);
      return;
    }
    if (found.status !== "covered") {
      errors.push(`${tag} 审计失败:matrix row.status=${JSON.stringify(found.status)}`);
    }
    const rowSpecAbs = absOf(rootAbs, found.spec);
    if (!rowSpecAbs || !isFile(rowSpecAbs)) {
      errors.push(`${tag} 审计失败:matrix row.spec 指向的文件不存在 ${JSON.stringify(found.spec)}`);
      return;
    }
    const rowText = readFileSync(rowSpecAbs, "utf8");
    const rowHits = findSkipOnly(rowText);
    if (rowHits.length) {
      errors.push(`${tag} 审计失败:matrix row.spec 含 skip/only(第 ${rowHits.map((h) => h.line).join(",")} 行)`);
    }
    const expected = countTests(rowText);
    if (found.count !== expected) {
      errors.push(`${tag} 审计失败:matrix row.count 与真实文件不一致: expected ${expected}, got ${JSON.stringify(found.count)}`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * 事务执行:备份目标(内存 buffer)→ 逐项 copy + matrix upsert → audit → 失败整体回滚。
 * 返回 {ok:true, applied, matrixPath} 或 {ok:false, errors, rolledBack:true}。
 */
export function applyPlan(root, plan, opts = {}) {
  const rootAbs = resolve(root);
  const { reviewed = false, force = false } = opts;

  const pre = validatePlan(rootAbs, plan, { apply: true, reviewed, force });
  if (!pre.ok) {
    return { ok: false, errors: pre.errors, warnings: pre.warnings, rolledBack: false, applied: [] };
  }

  /** absPath -> Buffer(原内容) | null(原本不存在) */
  const backups = new Map();
  const backup = (p) => {
    if (backups.has(p)) return;
    backups.set(p, isFile(p) ? readFileSync(p) : null);
  };
  const rollback = () => {
    const errs = [];
    for (const [p, buf] of [...backups.entries()].reverse()) {
      try {
        if (buf === null) {
          if (isFile(p)) unlinkSync(p);
        } else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, buf);
        }
      } catch (e) {
        errs.push(`恢复失败 ${p}: ${e.message}`);
      }
    }
    return errs;
  };

  const applied = [];
  try {
    for (const c of plan.cases) {
      const toAbs = absOf(rootAbs, c.to);
      backup(toAbs);
      mkdirSync(dirname(toAbs), { recursive: true });
      copyFileSync(absOf(rootAbs, c.from), toAbs);
      applied.push({ op: "copy", to: c.to });

      for (const f of Array.isArray(c.fixtures) ? c.fixtures : []) {
        const fToAbs = absOf(rootAbs, f.to);
        backup(fToAbs);
        mkdirSync(dirname(fToAbs), { recursive: true });
        copyFileSync(absOf(rootAbs, f.from), fToAbs);
        applied.push({ op: "copy", to: f.to });
      }
    }

    // matrix 按文件聚合 upsert(同一文件多个 case 只读一次、只写一次)
    const matrixWrites = new Map();
    for (const c of plan.cases) {
      const mAbs = absOf(rootAbs, c.matrix.path);
      let entry = matrixWrites.get(mAbs);
      if (!entry) {
        let data;
        if (existsSync(mAbs)) {
          data = JSON.parse(readFileSync(mAbs, "utf8")); // 目录 → EISDIR;坏 JSON → SyntaxError:都进回滚
        } else {
          data = { cases: [] };
        }
        if (!data || typeof data !== "object") data = { cases: [] };
        if (!Array.isArray(data.cases)) data.cases = [];
        backup(mAbs);
        entry = { relPath: c.matrix.path, data };
        matrixWrites.set(mAbs, entry);
      }
      const row = { ...c.matrix.row };
      const idx = entry.data.cases.findIndex((r) => r && r.id === row.id);
      if (idx >= 0) entry.data.cases[idx] = row;
      else entry.data.cases.push(row);
    }
    for (const [mAbs, entry] of matrixWrites) {
      mkdirSync(dirname(mAbs), { recursive: true });
      writeFileSync(mAbs, `${JSON.stringify(entry.data, null, 2)}\n`);
      applied.push({ op: "matrix-upsert", path: entry.relPath });
    }

    const audit = auditPlan(rootAbs, plan);
    if (!audit.ok) {
      const rbErrs = rollback();
      return { ok: false, errors: [...audit.errors, ...rbErrs], rolledBack: true, applied: [] };
    }
    const paths = [...matrixWrites.values()].map((e) => e.relPath);
    return {
      ok: true,
      applied,
      matrixPath: paths.length === 1 ? paths[0] : paths,
      matrixPaths: paths,
      rolledBack: false,
    };
  } catch (e) {
    const rbErrs = rollback();
    return { ok: false, errors: [`执行失败: ${e.message}`, ...rbErrs], rolledBack: true, applied: [] };
  }
}

/** dry-run:只校验并打印将执行的动作(绝不写盘)。 */
export function dryRun(root, plan, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : null;
  const res = validatePlan(root, plan, { apply: false, force: opts.force === true });
  if (log) {
    log(`dry-run: ${Array.isArray(plan?.cases) ? plan.cases.length : 0} 个 case(未写盘)`);
    for (const a of res.actions) {
      const what = a.op === "copy" ? `copy ${a.from} -> ${a.to}` : `matrix-upsert ${a.path} (row.id=${a.row?.id})`;
      log(`  - ${what}`);
    }
    for (const w of res.warnings) log(`  ! ${w}`);
    for (const e of res.errors) log(`  ✗ ${e}`);
    log(res.ok ? "dry-run: 校验通过" : `dry-run: 校验失败(${res.errors.length} 项)`);
  }
  return res;
}

/** CLI 参数解析。 */
export function parseArgs(argv) {
  const out = { plan: null, apply: false, reviewed: false, force: false, root: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") out.plan = argv[++i] ?? null;
    else if (a === "--apply") out.apply = true;
    else if (a === "--reviewed") out.reviewed = true;
    else if (a === "--force") out.force = true;
    else if (a === "--root") out.root = argv[++i] ?? null;
    else if (a === "-h" || a === "--help") out.help = true;
    else out.unknown.push(a);
  }
  return out;
}

function usage() {
  return [
    "用法: node scripts/e2e-promote.mjs --plan <plan.json> [--apply --reviewed] [--force] [--root <dir>]",
    "",
    "  --plan <file>   晋升计划 JSON(必填)",
    "  --apply         真正写盘(缺省 dry-run:只校验并打印动作)",
    "  --reviewed      人工审核确认;--apply 时必须",
    "  --force         允许覆盖已存在的目标文件",
    "  --root <dir>    晋升根目录(计划内相对路径的基准),缺省当前目录",
    "  -h, --help      帮助",
  ].join("\n");
}

/** CLI 主流程,返回退出码。 */
export function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.unknown.length) console.error(`! 忽略未知参数: ${args.unknown.join(" ")}`);
  if (!args.plan) {
    console.error(`✗ 缺少 --plan <plan.json>\n\n${usage()}`);
    return 2;
  }
  if (args.apply && !args.reviewed) {
    console.error("✗ --apply 需要同时给 --reviewed(人工审核确认后才允许晋升)");
    return 2;
  }
  const root = resolve(args.root || process.cwd());
  let plan;
  try {
    plan = loadPlan(args.plan);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 2;
  }

  if (!args.apply) {
    const res = dryRun(root, plan, { force: args.force, log: (s) => console.log(s) });
    return res.ok ? 0 : 1;
  }

  const res = applyPlan(root, plan, { reviewed: args.reviewed, force: args.force });
  if (res.ok) {
    console.log(`✓ 晋升完成:${res.applied.length} 项,matrix=${JSON.stringify(res.matrixPath)}`);
    for (const a of res.applied) console.log(`  - ${a.op} ${a.to || a.path}`);
    return 0;
  }
  console.error(res.rolledBack ? "✗ 晋升失败,已整体回滚:" : "✗ 晋升失败(未写盘):");
  for (const e of res.errors) console.error(`  - ${e}`);
  return 1;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
