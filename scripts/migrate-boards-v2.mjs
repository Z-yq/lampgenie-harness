#!/usr/bin/env node
/**
 * board JSON v1 → v2 迁移脚本( / data 板 P0 实施)。
 * 设计约束(来自规划稿):
 * - node fs 递归扫描(.genie 隐藏目录对 glob 零命中,禁止 shell glob);
 * - 缺省 dry-run 只报不写;--apply 才写;真目录 --apply 必须显式 --allow-live(人工停写确认);
 * - 幂等:version==2 跳过;第二次 --apply migrated=0;
 * - 原子写:同目录 .migrate.tmp + rename;首次升级前留 .json.v1.bak;
 * - 脏数据:逐文件 failed 原因,不中断批;--apply 有 failed 则 exit 1;
 * - --verify:按 manifest 对账 parse 成功数 / nodes+edges 总数 / 未知字段丢失=0;
 * - --rollback:按 .v1.bak 逐字节还原(删备份与 manifest,便于 diff -r 与迁移前快照一致)。
 */
import { readdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, statSync, rmSync } from "node:fs";
import { join, relative, resolve, basename } from "node:path";

const DEFAULT_ROOT = resolve(".genie/boards");
const MANIFEST = ".migrate-v2-manifest.json";
const BAK = ".json.v1.bak";
const TMP = ".migrate.tmp";

const argv = process.argv.slice(2);
const has = (x) => argv.includes(x);
const val = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const root = resolve(val("--root", DEFAULT_ROOT));
const isLive = root === DEFAULT_ROOT;
const action = has("--list") ? "list"
  : has("--verify") ? "verify"
  : has("--rollback") ? "rollback"
  : has("--apply") ? "apply"
  : "dry";
const allowLive = has("--allow-live");

function walk(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === MANIFEST || name.startsWith(".")) continue;
    if (name.endsWith(BAK) || name.endsWith(TMP)) continue;
    if (name === ".run.json" || name.endsWith(".run.json")) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

function classify(file) {
  let raw;
  try { raw = readFileSync(file, "utf-8"); } catch (e) { return { kind: "failed", reason: `io:${e.code || e.message}` }; }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return { kind: "failed", reason: `parse:${String(e.message).slice(0, 80)}` }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { kind: "failed", reason: "invalid-doc:not-object" };
  if (doc.version === 2) return { kind: "skipped", doc };
  if (doc.version !== 1) return { kind: "failed", reason: `unknown-version:${String(doc.version)}` };
  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0 || doc.nodes.length > 60) return { kind: "failed", reason: `invalid-doc:nodes=${Array.isArray(doc.nodes) ? doc.nodes.length : "missing"}` };
  return { kind: "migrated", doc };
}

function migrate(doc) {
  const beforeKeys = Object.keys(doc);
  const next = { ...doc, version: 2 };
  if (!Array.isArray(next.edges)) next.edges = [];
  if (!Array.isArray(next.planned_files)) next.planned_files = [];
  return { next, beforeKeys };
}

const rel = (p) => relative(root, p);

function loadManifest() {
  const p = join(root, MANIFEST);
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return { version: 1, files: {} }; }
}
function saveManifest(m) {
  const p = join(root, MANIFEST);
  const tmp = p + TMP;
  writeFileSync(tmp, JSON.stringify(m, null, 1), "utf-8");
  renameSync(tmp, p);
}

if (isLive && (action === "apply" || action === "rollback") && !allowLive) {
  console.error(`拒绝直接写真实板目录 ${root}:先停写网关并确认无活跃会话落板,再显式加 --allow-live。`);
  process.exit(2);
}
if (!existsSync(root)) {
  console.log(`root=${root} 不存在:0 文件(空态非错误)`);
  process.exit(0);
}
const files = walk(root).sort();
if (action === "list") {
  console.log(`root=${root} files=${files.length}`);
  process.exit(0);
}

if (action === "apply") {
  const manifest = loadManifest();
  let migrated = 0, skipped = 0, failed = 0;
  const failedDetail = [];
  for (const file of files) {
    const c = classify(file);
    if (c.kind === "skipped") { skipped++; continue; }
    if (c.kind === "failed") { failed++; failedDetail.push(`${rel(file)} ${c.reason}`); continue; }
    const { next, beforeKeys } = migrate(c.doc);
    const bak = file + BAK;
    try {
      if (!existsSync(bak)) copyFileSync(file, bak);
      const tmp = file + TMP;
      writeFileSync(tmp, JSON.stringify(next, null, 1), "utf-8");
      renameSync(tmp, file);
      manifest.files[rel(file)] = { nodes: next.nodes.length, edges: next.edges.length, keys: beforeKeys };
      migrated++;
    } catch (e) {
      failed++;
      failedDetail.push(`${rel(file)} write:${e.code || e.message}`);
    }
  }
  if (migrated > 0 || Object.keys(manifest.files).length > 0) saveManifest(manifest);
  console.log(`scan=${files.length} migrated=${migrated} skipped=${skipped} failed=${failed}`);
  for (const x of failedDetail.slice(0, 30)) console.log(`FAILED ${x}`);
  if (failedDetail.length > 30) console.log(`... 还有 ${failedDetail.length - 30} 条`);
  process.exit(failed > 0 ? 1 : 0);
}

if (action === "verify") {
  const manifest = loadManifest();
  let parsed = 0, mismatched = 0, lostKeys = 0, missingManifest = 0;
  const detail = [];
  for (const file of files) {
    const c = classify(file);
    if (c.kind === "failed") { mismatched++; detail.push(`${rel(file)} ${c.reason}`); continue; }
    parsed++;
    const m = manifest.files[rel(file)];
    if (!m) { missingManifest++; detail.push(`${rel(file)} manifest-missing`); continue; }
    if (c.doc.nodes.length !== m.nodes || (c.doc.edges ?? []).length !== m.edges) {
      mismatched++;
      detail.push(`${rel(file)} count nodes=${c.doc.nodes.length}/${m.nodes} edges=${(c.doc.edges ?? []).length}/${m.edges}`);
    }
    const nowKeys = new Set(Object.keys(c.doc));
    const lost = m.keys.filter((k) => !nowKeys.has(k));
    if (lost.length) { lostKeys += lost.length; detail.push(`${rel(file)} lost-keys:${lost.join(",")}`); }
  }
  console.log(`parsed=${parsed} files=${files.length} manifest_entries=${Object.keys(manifest.files).length} mismatched=${mismatched} missing_manifest=${missingManifest} lost_keys=${lostKeys}`);
  for (const x of detail.slice(0, 30)) console.log(`MISMATCH ${x}`);
  process.exit(mismatched || missingManifest || lostKeys ? 1 : 0);
}

if (action === "rollback") {
  const backups = [];
  (function scanBak(dir) {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) scanBak(p);
      else if (name.endsWith(BAK)) backups.push(p);
    }
  })(root);
  let restored = 0;
  for (const bak of backups) {
    const target = bak.slice(0, -BAK.length);
    try { copyFileSync(bak, target); rmSync(bak, { force: true }); restored++; } catch (e) { console.error(`restore failed ${rel(bak)}: ${e.message}`); }
  }
  const mp = join(root, MANIFEST);
  if (existsSync(mp)) rmSync(mp, { force: true });
  console.log(`rollback restored=${restored} backups=${backups.length} manifest_removed=${!existsSync(mp)}`);
  process.exit(0);
}

// dry-run(缺省)
let plan = 0, skipped = 0, failed = 0;
for (const file of files) {
  const c = classify(file);
  if (c.kind === "skipped") { skipped++; continue; }
  if (c.kind === "failed") { failed++; console.log(`FAILED ${rel(file)} ${c.reason}`); continue; }
  const { next } = migrate(c.doc);
  plan++;
  console.log(`PLAN ${rel(file)} v1->v2 nodes=${next.nodes.length} edges=${next.edges.length}`);
}
console.log(`scan=${files.length} plan=${plan} skipped=${skipped} failed=${failed} dry_run=1`);
