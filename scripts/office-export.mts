#!/usr/bin/env node
/**
 * Office 导出 CLI(2026-11 #-B):只做 argv 折参数 + 打印 + 退出码,不掺业务判定。
 * 分工:
 * - 抽取/落盘/引擎壳在 apps/gateway/src/office-export-store.ts;
 * - 路由与内容裁决在 packages/harness-runtime/src/agent/office-export.ts;
 * - 本文件把 argv 折成一次调用,把结论打成稳定码行(人读)或 JSON(机器读),再原样转成退出码。
 * 用法:
 * node --experimental-strip-types --conditions=development scripts/office-export.mts \
 * --root /tmp/m106-export [--manifest-register acme --file vendor.zip] \
 * [--manifest-verify acme --file a.bin --file b.bin [--offline]] \
 * [--plan deck.pptx --target pdf] \
 * [--preflight deck.pptx --target pdf [--offline] [--manifest acme] [--json]] \
 * [--verify deck.pptx --artifact deck.pdf [--expected-pages 3]] \
 * [--report]
 * 退出码:0 EXPORT_OK;2 内容/路由违规(UNSUPPORTED、MANIFEST_MISSING、MANIFEST_MISMATCH、EXTERNAL_REF、
 * PLACEHOLDER、EMPTY_PAGE、EMPTY_DECK、OFFLINE_VIOLATION、ARTIFACT_INVALID);
 * 1 参数错误、引擎缺失、读取失败与其它 store 码。
 */
import { existsSync } from "node:fs";

import { routeExport } from "../packages/harness-runtime/src/agent/office-export.ts";
import {
  OfficeExportError,
  exitCodeOf,
  extractFacts,
  inputKindOf,
  readExportLedger,
  registerManifest,
  runPreflight,
  runVerify,
  verifyManifestFiles,
} from "../apps/gateway/src/office-export-store.ts";
import type { Target } from "@lampgenie/runtime/agent/office-export";

const EXIT_USAGE = 1;

const VALUE_FLAGS = new Set([
  "root",
  "manifest-register",
  "manifest-verify",
  "file",
  "plan",
  "preflight",
  "verify",
  "target",
  "artifact",
  "expected-pages",
  "manifest",
]);
const BOOL_FLAGS = new Set(["offline", "json", "report", "help"]);
const TARGETS: readonly Target[] = ["pptx", "pdf", "png", "md", "html"];

interface Parsed {
  root?: string;
  manifestRegister?: string;
  manifestVerify?: string;
 /** --file 可重复:登记只要一个,清单校验可给多个(逐份算 sha/bytes 与清单比对)。 */
  files: string[];
  plan?: string;
  preflight?: string;
  verify?: string;
  target?: string;
  artifact?: string;
  expectedPages?: number;
  manifest?: string;
  offline: boolean;
  json: boolean;
  report: boolean;
  help: boolean;
}

/** argv → Parsed;未知 flag/缺值一律 throw(由 main 折成 exit 1,不猜默认值)。 */
function parseArgv(argv: readonly string[]): Parsed {
  const out: Parsed = { files: [], offline: false, json: false, report: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (!raw.startsWith("--")) throw new Error(`无法识别的参数:${raw}`);
    const eq = raw.indexOf("=");
    const flag = (eq < 0 ? raw.slice(2) : raw.slice(2, eq)).trim();
    const inline = eq < 0 ? undefined : raw.slice(eq + 1);
    if (BOOL_FLAGS.has(flag)) {
      if (inline !== undefined) throw new Error(`--${flag} 不接受取值`);
      if (flag === "offline") out.offline = true;
      else if (flag === "json") out.json = true;
      else if (flag === "report") out.report = true;
      else out.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`无法识别的参数:--${flag}`);
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`--${flag} 需要取值`);
      value = next;
      i += 1;
    }
    if (flag === "root") out.root = value;
    else if (flag === "manifest-register") out.manifestRegister = value;
    else if (flag === "manifest-verify") out.manifestVerify = value;
    else if (flag === "file") out.files.push(value);
    else if (flag === "plan") out.plan = value;
    else if (flag === "preflight") out.preflight = value;
    else if (flag === "verify") out.verify = value;
    else if (flag === "target") out.target = value;
    else if (flag === "artifact") out.artifact = value;
    else if (flag === "manifest") out.manifest = value;
    else if (flag === "expected-pages") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--expected-pages 需要正整数");
      out.expectedPages = parsed;
    }
  }
  return out;
}

const USAGE = [
  "用法: node --experimental-strip-types scripts/office-export.mts --root <dir> <动作> [选项]",
  "  --root               产物根(必须在 /tmp 下的绝对路径)",
  "  --manifest-register  登记厂商清单名(需配一个 --file)",
  "  --manifest-verify    按清单逐份校验实际文件 sha/bytes(需配 --file,可多个;可加 --offline)",
  "  --file               被登记/被校验的文件(可重复)",
  "  --plan               只看路由(需配 --target)",
  "  --preflight          导出前预检(需配 --target;可加 --offline/--manifest/--json)",
  "  --verify             校验产物(需配 --artifact;可加 --expected-pages)",
  "  --report             打印账本摘要",
  "退出码: 0 EXPORT_OK, 2 内容/路由违规, 1 参数错误或引擎/读取失败",
].join("\n");

function targetOf(raw: string | undefined): Target {
  const value = (raw ?? "").trim().toLowerCase();
  if (!TARGETS.includes(value as Target)) throw new Error(`--target 必须是 ${TARGETS.join("|")}:${raw ?? "(缺)"}`);
  return value as Target;
}

function requirePath(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") throw new Error(`缺 --${flag}`);
  if (!existsSync(value)) throw new Error(`--${flag} 指向的文件不存在:${value}`);
  return value;
}

async function main(): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误:${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const root = parsed.root;
  if (root === undefined || root.trim() === "") {
    console.error("参数错误:缺 --root");
    console.error(USAGE);
    return EXIT_USAGE;
  }

  try {
    if (parsed.manifestRegister !== undefined) {
      if (parsed.files.length !== 1) throw new Error("--manifest-register 需要且只接受一个 --file");
      const file = requirePath("file", parsed.files[0]);
      const out = registerManifest(root, parsed.manifestRegister, file);
      console.log(
        `MANIFEST_REGISTERED name=${out.manifest.name} entries=${out.manifest.entries.length} reused=${String(out.reused)}`,
      );
      if (parsed.json) console.log(JSON.stringify({ code: "MANIFEST_REGISTERED", manifest: out.manifest, path: out.path }, null, 2));
      return 0;
    }

    if (parsed.manifestVerify !== undefined) {
      if (parsed.files.length === 0) throw new Error("--manifest-verify 需要至少一个 --file");
      const files = parsed.files.map((item) => ({ path: requirePath("file", item) }));
      const { verdict } = verifyManifestFiles(root, parsed.manifestVerify, files, {
        ...(parsed.offline ? { offline: true } : {}),
      });
      const line = `${verdict.code} manifest=${parsed.manifestVerify} files=${files.length}`;
      if (parsed.json) {
        console.error(line);
        console.log(
          JSON.stringify(
            { mode: "manifest-verify", ...verdict, manifest: parsed.manifestVerify, files: parsed.files },
            null,
            2),
        );
      } else {
        console.log(line);
        for (const item of verdict.mismatches) console.log(`  - [mismatch] ${item}`);
        for (const item of verdict.warnings) console.log(`  - [warn] ${item}`);
      }
      return exitCodeOf(verdict.code);
    }

    if (parsed.plan !== undefined) {
      const file = requirePath("plan", parsed.plan);
      const target = targetOf(parsed.target);
      const kind = inputKindOf(file);
      if (kind === null) {
        console.error(`EXPORT_INVALID 无法识别的输入扩展名:${file}`);
        return 1;
      }
      const route = routeExport({ input: kind, target, ...(parsed.offline ? { offline: true } : {}) });
      const engine = route.engine === undefined ? "none" : route.engine;
      const line = `${route.code} ${kind}->${target} engine=${engine}${route.reason === undefined ? "" : ` (${route.reason})`}`;
      if (parsed.json) {
 // JSON 走 stdout(机器读),稳定码行进 stderr:两边都不破坏。
        console.error(line);
        console.log(JSON.stringify({ mode: "plan", code: route.code, route, input: kind, target }, null, 2));
      } else {
        console.log(line);
      }
      return exitCodeOf(route.code);
    }

    if (parsed.preflight !== undefined) {
      const file = requirePath("preflight", parsed.preflight);
      const target = targetOf(parsed.target);
      const out = await runPreflight(root, file, target, {
        ...(parsed.offline ? { offline: true } : {}),
        ...(parsed.manifest === undefined ? {} : { manifest: parsed.manifest }),
      });
      const engine = out.preflight.route.engine ?? "none";
      const { code, ok, failures, warnings, perPage } = out.preflight;
      const line = `${code} ${out.facts.inputKind}->${target} engine=${engine}`;
      if (parsed.json) {
 // stdout 只放 JSON(机器读);稳定码行放 stderr,人读一眼能抓到结论。
        console.error(line);
        console.log(
          JSON.stringify(
            {
              mode: "preflight",
              code,
              ok,
              engine,
              route: out.preflight.route,
              failures,
              warnings,
              perPage,
              facts: {
                inputKind: out.facts.inputKind,
                pageCount: out.facts.pageCount,
                fonts: out.facts.fonts,
                externalRefs: out.facts.externalRefs,
                placeholders: out.facts.placeholders,
                mediaEmbedded: out.facts.mediaEmbedded,
              },
              reportPath: out.reportPath,
            },
            null,
            2),
        );
      } else {
        console.log(line);
        for (const issue of failures) console.log(`  - [fail] ${issue.code} ${issue.detail}`);
        for (const issue of warnings) console.log(`  - [warn] ${issue.code} ${issue.detail}`);
        console.log(`  页数 ${perPage.length};报告 ${out.reportPath}`);
      }
      return exitCodeOf(code);
    }

    if (parsed.verify !== undefined) {
      const file = requirePath("verify", parsed.verify);
      const artifact = requirePath("artifact", parsed.artifact);
      const out = runVerify(root, file, artifact, parsed.expectedPages);
      const line = `${out.verdict.code} pages=${out.artifactPages} sha=${out.artifactSha256.slice(0, 12)}`;
      if (parsed.json) {
        console.error(`${line} (${out.verdict.detail})`);
        console.log(
          JSON.stringify(
            {
              mode: "verify",
              code: out.verdict.code,
              ok: out.verdict.ok,
              detail: out.verdict.detail,
              artifactPages: out.artifactPages,
              artifactSha256: out.artifactSha256,
              reportPath: out.reportPath,
            },
            null,
            2),
        );
      } else {
        console.log(
          `${out.verdict.code} pages=${out.artifactPages} sha=${out.artifactSha256.slice(0, 12)} (${out.verdict.detail})`,
        );
      }
      return exitCodeOf(out.verdict.code);
    }

    if (parsed.report) {
      const ledger = readExportLedger(root);
      for (const line of ledger) {
        console.log(`${line.target}\t${line.code}\t${line.inputSha256.slice(0, 12)}\t${new Date(line.at).toISOString()}`);
      }
      console.log(`汇总: 账本 ${ledger.length} 条;root=${root}`);
      return 0;
    }
  } catch (err) {
    if (err instanceof OfficeExportError) {
      console.error(`${err.code} ${err.message}`);
      return exitCodeOf(err.code);
    }
    console.error(`EXPORT_INVALID ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_USAGE;
  }

  console.error("参数错误:需要一个动作(--manifest-register/--plan/--preflight/--verify/--report)");
  console.error(USAGE);
  return EXIT_USAGE;
}

process.exitCode = await main();
