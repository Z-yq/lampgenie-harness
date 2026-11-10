/**
 * `codesense doctor`——环境自检:Node 版本/依赖可载入(tree-sitter wasm 逐语言)/注册表/
 * 当前目录解析出的根与索引健康/索引目录可写性。fail=exit 1;warn(如 wasm 回退纯文本解析)不失败。
 */
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadTsParser } from "@lampgenie/code-sense/adapters/tree-sitter";
import { indexDir, indexStale, loadIndex } from "@lampgenie/code-sense/callgraph/c2f";
import { INDEX_EXTRACTOR_VERSION } from "@lampgenie/code-sense/callgraph/engine";
import { languageCoverageCached, coverageWarnings, formatCoverageLine, C_CPP_EXTS } from "@lampgenie/code-sense/callgraph/coverage";
import { loadRegistry, registryPath, resolveProjectRoot, sidecarPath } from "./registry.js";
import { estimateIndexMemory } from "./heap-budget.js";
import { maskKey, resolveLlmConfig } from "./llm-config.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function runDoctor(rootArg?: string): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck["status"], detail: string): void => {
    checks.push({ name, status, detail });
  };

  const major = Number(process.versions.node.split(".")[0] ?? 0);
  add("node", major >= 20 ? "ok" : "fail", `node ${process.versions.node}(要求 >= 20)`);
  add("platform", "ok", `${process.platform}/${process.arch}`);

  // step-089 P2:LLM 档位检查(直连/中继/无;凭证只出脱敏形态,永不打原文)
  try {
    const r = resolveLlmConfig();
    if (!r) {
      add("llm", "warn", "未配置——语义层确定性降级(显式,不冒充)。激活: codesense config set llm.baseURL/llm.model/llm.apiKey,或 GENIE_LLM_* env,或 config set llm.askFile.dir <目录>(宿主 agent 应答中继)");
    } else if (r.kind === "ask-file") {
      add("llm", "ok", `ask-file 中继(${r.dir})——宿主 agent 读 ask-*.json 作答 answer-*.json(120s 超时)`);
    } else {
      add("llm", "ok", `direct(来源=${r.source};model=${r.cfg.model};key=${maskKey(r.cfg.apiKey)})`);
    }
  } catch (e) {
    add("llm", "fail", `凭证配置无效: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
  }

  try {
    await import("ts-morph");
    add("ts-morph", "ok", "可加载(ts/js 语义解析档)");
  } catch (e) {
    add("ts-morph", "fail", `加载失败: ${String(e).slice(0, 120)}`);
  }

  // 2026-10-25:Rust/C#/Ruby/PHP 接入结构 adapter → doctor 的 wasm 语法档检查同步覆盖
  for (const lang of ["python", "go", "java", "c", "cpp", "rust", "csharp", "ruby", "php"] as const) {
    const parser = await loadTsParser(lang);
    add(
      `tree-sitter:${lang}`,
      parser ? "ok" : "warn",
      parser ? "wasm 语法档可用" : "wasm 不可用——该语言回退纯文本解析或不可索引(功能不炸,召回降低;检查 tree-sitter-wasms 资产)",
    );
  }

  const rp = registryPath();
  const reg = loadRegistry();
  add("registry", existsSync(rp) ? "ok" : "warn", `${rp}(已登记 ${reg.roots.length} 个根${existsSync(rp) ? "" : ";文件尚不存在——首次 index --register 后创建"})`);

  const resolved = rootArg ? { root: rootArg, source: "--root" as const } : resolveProjectRoot(process.cwd());
  if (!resolved) {
    add("root", "warn", "当前目录未解析出根(未建索引、上层无登记、也无 .genie/sense-index)——运行 codesense index --register");
  } else {
    const root = resolved.root;
    add("root", "ok", `${root}(${resolved.source})`);
    const idx = loadIndex(root);
    if (!idx) {
      add("index", "warn", "索引不存在——运行 codesense index 或 init");
    } else {
      const stale = indexStale(root, idx);
      // 抽取器版本一致性(2026-10-21 验收缺口 1):builtAt/源码 mtime 只证明「此时构建过」,
      // 不证明「产物由当前抽取器产出」——旧版索引会系统性缺报(纯类型文件 0 条/新 kind 缺席),
      // 必须在 doctor 显式告警,否则增量复用会把它保持成假绿。
      const versionSkew = idx.extractorVersion !== INDEX_EXTRACTOR_VERSION;
      const versionNote = versionSkew
        ? `抽取器已升级,索引为旧版(${idx.extractorVersion === undefined ? "未记录版本,隐式 v1" : `索引 v${idx.extractorVersion}`} → 当前 v${INDEX_EXTRACTOR_VERSION};建议下次构建自动全量重扫)`
        : "";
      const detail = `${idx.nodes.length} 节点 / ${idx.edges.length} 边,builtAt ${new Date(idx.builtAt).toISOString()}`
        + (stale ? "(可能过期:源码有变动,建议 codesense index)" : "")
        + (versionNote ? `;${versionNote}` : "");
      add("index", stale || versionSkew ? "warn" : "ok", detail);
      // 语言覆盖核对(step-067 fail-visible):「索引有符号文件数 vs 磁盘源文件数」按扩展名。
      // 根治 step-065 实测假绿:C 仓索引 1/~1846 文件 doctor 仍全 [ok]——零覆盖/低覆盖显式 WARN。
      // step-079:manifest 带分层 coverage(full/lexical/empty/skipped+coveragePct)时优先用
      // manifest(与索引同源),无 manifest(旧格式)才现场重算(legacy 口径,显式降级)。
      try {
        const cov = idx.coverage ?? (await languageCoverageCached(root, Object.keys(idx.byFile)));
        const warns = coverageWarnings(cov);
        if (warns.length > 0) {
          for (const w of warns) {
            const sep = w.indexOf(":");
            add(`coverage:${w.slice(0, sep)}`, "warn", w.slice(sep + 1).trim());
          }
        }
        const line = formatCoverageLine(cov);
        add("coverage", warns.length > 0 ? "warn" : "ok", line || "磁盘无源文件");
        if (!idx.coverage) {
          add("coverage:manifest", "warn", "索引缺语言覆盖数据(旧格式)——覆盖核对为现场重算;codesense index 重建后进 manifest");
        } else {
          const cppExts = Object.keys(idx.coverage.byExt).filter((e) => C_CPP_EXTS.has(e));
          if (cppExts.length > 0) {
            add("coverage:manifest", "ok", `manifest 含覆盖报告(${cppExts.join(" ")} 等扩展名)`);
          }
        }
      } catch (e) {
        add("coverage", "warn", `覆盖核对失败(如实告警,不假绿): ${String(e).slice(0, 120)}`);
      }
    }
    add("sidecar", existsSync(sidecarPath(root)) ? "ok" : "warn", sidecarPath(root) + (existsSync(sidecarPath(root)) ? "(增量复用指纹在)" : "(无——下次 index 走全量并生成)"));
    // 堆预算自适应检查(step-086 RC-K2):按仓规模估内存,分级 ok/warn/risk + 建议堆帽;
    // 估算失败如实 warn 不假绿(不拦 doctor 其它检查)。
    try {
      const est = await estimateIndexMemory(root);
      const cls = Object.entries(est.byClass).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(" ") || "无源文件";
      const tip = est.tier === "risk"
        ? `;建议 NODE_OPTIONS=--max-old-space-size=${est.recommendedHeapMb}${est.reducedMaxFiles ? ` 或按公平采样降数 ${est.reducedMaxFiles} 文件(GENIE_SENSE_MAX_FILES)` : ""}`
        : est.tier === "warn"
          ? `;建议显式堆帽 NODE_OPTIONS=--max-old-space-size=${est.recommendedHeapMb}`
          : "";
      add(
        "heap-budget",
        est.tier === "risk" ? "warn" : est.tier,
        `${cls};估算 ${est.estMb}MB(±40% 包络,进程堆帽 ${est.processHeapMb}MB)/预算 ${est.budgetMb}MB${tip}`,
      );
    } catch (e) {
      add("heap-budget", "warn", `堆预算估算失败(不拦构建,构建时也会跳过预算检查): ${String(e).slice(0, 120)}`);
    }
    // 索引目录可写性探针
    try {
      const dir = indexDir(root);
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, ".doctor-write-probe");
      writeFileSync(probe, "ok");
      unlinkSync(probe);
      add("index-dir-writable", "ok", dir);
    } catch (e) {
      add("index-dir-writable", "fail", `不可写: ${String(e).slice(0, 120)}`);
    }
  }

  return { checks, ok: checks.every((c) => c.status !== "fail") };
}
