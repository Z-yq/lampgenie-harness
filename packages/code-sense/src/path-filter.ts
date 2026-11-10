/**
 * 路径口径共享模块(从 project-profile.ts 提出:
 * 「这是不是产品主线路径」+「证据优先级」的唯一真相,供六个面同源消费——
 * project-profile / entrypoints(c2f.queryEntryPoints)/ api / state / algo / bridge。
 * 提出原因(全命令经验证):今日 project-profile 已落地非产品路径判定,但另外五面仍是
 * 各自黑名单且口径漂移——py-fastapi 的 docs_src/** 教程占入口 top8 的 6 席、同仓 api 474 端点
 * 绝大多数来自 docs_src;mmdetection 把 docs/ 当算法文件;ts-xstate 把 migration.md 文档示例
 * 算成 3 个状态机;poly-grafana 的 public/test/mocks/** 被当前端证据。判定必须单点,
 * 否则每加一种噪声目录就要改五处且必有漏改。
 * 纪律:过滤不得清零后假装没数据——调用方(filterNonProductPaths + nonProductFilterNote)
 * 输出「已过滤 N 条非产品路径条目」并给 --all 逃生口(诚实原则:采样/过滤口径可见)。
 */

/** 测试文件路径判定(导出共享; 定义迁入本模块,c2f 侧 re-export 保持既有导入面)。
 * (RC-096-A2①/B1)补全语言族形态:Go `_test.go`、Java `TestX.java`/`XTest.java`/`XTests.java`、
 * JS/TS `.spec.` 中缀——旧版只认 py/JS 形态,Go/Java 测试文件不被降权(go-cobra 入口表 11/12 被
 * Test 函数占领注意)。
 * Rust/C#/Ruby/PHP 接入结构 adapter 后同步补文件命名形态(`_test.rs`/`_spec.rb`/
 * `Tests?.cs`/`Tests?.php`)——只认强约定后缀,不把 `spec/` 目录整段判成测试(OpenAPI spec
 * 目录与源码目录在多个仓里并存,误伤面大于收益)。 */
export function isTestPath(f: string): boolean {
  const segs = f.split("/");
  if (segs.some((s) => /^tests?$/i.test(s) || s === "__tests__")) return true;
  const base = segs[segs.length - 1] ?? "";
  return /^test_/.test(base)
    || /\.test\./.test(base)
    || /\.spec\./.test(base)
    || /_test\.py$/.test(base)
    || /_test\.go$/.test(base)
    || /^Test[A-Z][\w]*\.java$/.test(base)
    || /Tests?\.java$/.test(base)
    || /_test\.rs$/.test(base)
    || /_test\.rb$/.test(base)
    || /_spec\.rb$/.test(base)
    || /Tests?\.cs$/.test(base)
    || /Tests?\.php$/.test(base);
}

/** 文档类扩展名:文档里的示例代码不是「这个项目提供的代码能力」(ts-xstate 的 migration.md
 * 被算成 3 个状态机、streamlit 的 specs/*.md 被当端点,都是这一族)。 */
const DOC_EXT_RE = /\.(md|mdx|markdown|adoc|asciidoc|rst|txt)$/i;

/** 非产品主线目录段(小写比较)。
 * - 任务史/参考仓/依赖产物:
 * - 文档与教程:docs/doc/doc_src/docs_src/documentation(examples/tutorials 同族)
 * - 示例与样例:examples/example/samples/sample/demos/demo
 * - 测试支撑与夹具:fixtures/testdata/mocks/mock/e2e(grafana public/test/mocks 注意)
 * - 压测/基准:bench/benchmark/benchmarks(证据降权口径同族)
 * 注意:plain `test`/`tests` 段不在此列——测试文件按 isTestPath 降权而非整段剔除
 * (entrypoints 的「测试入口保留在清单尾部不隐瞒」语义不能被破坏)。 */
const NON_PRODUCT_SEGS = new Set([
  "tasks", ".genie", "ref", "vendor", "thirdparty", "third_party", "3rdparty", "gtestlib", "googletest", "node_modules", "dist", "build", "coverage",
  "docs", "doc", "doc_src", "docs_src", "documentation",
  "examples", "example", "samples", "sample", "tutorials", "tutorial", "demos", "demo",
  "fixtures", "testdata", "mocks", "mock", "e2e",
  "bench", "benchmark", "benchmarks",
]);

/** 第三方依赖/内嵌源码路径( P0):entrypoints/explore 的默认过滤面。
 * saadk_6920 注意:thirdparty/opencv 的 flann 头把前 8 个入口全占了,真实算法入口被挤掉。
 *  与 isNonProductPath 分开:explore 只清「外来代码」,docs/examples 仍保留(已降权)。 */
const VENDOR_SEGS = new Set(["vendor", "thirdparty", "third_party", "3rdparty", "gtestlib", "googletest", "node_modules", ".pnpm", "deps", "external", "extern"]);
export function isVendoredPath(f: string): boolean {
  return f.toLowerCase().split("/").some((s) => VENDOR_SEGS.has(s));
}

/** 文档类文件(扩展名口径;桥/状态机/算法这些「按内容提取」的面用它拦 .md 示例)。 */
export function isDocLikePath(f: string): boolean {
  return DOC_EXT_RE.test(f);
}

// ============================ 构建产物路径 ============================
// 盲区注意(poly-owncast,25 仓基线盘点):Next 编译产物 `static/web/_next/static/{media,chunks}/*.js`
// 里的 minified `switch (a) { case 1: return "fulfilled" }` 被 state 面算成状态机(3 台机里有产物机)、
// `React@static/web/_next/...` 被框架指纹算成主线能力、`static/_next` 路径被当 bridge 前端证据。
// 这些是构建输出的 JS,不是「这个项目提供的代码能力」——判定必须单点(六面同源),故在此新增
// isBuildArtifactPath 并由 isNonProductPath 合并。

/** 整段剔除的强构建目录段(小写比较)。
 * 只收「目录名本身 = 某构建工具的产物/缓存目录」的形态:
 * - .next/_next(Next.js;两种写法都写——`.next` 是构建目录,`_next` 是导出产物里的 URL 段)
 * - .nuxt/_nuxt 族(Nuxt)、.output(Nitro/Nuxt build output)、.svelte-kit、.astro、.angular、.docusaurus
 * - .vite/.webpack/.rollup.cache/.esbuild/.parcel-cache/.turbo(vite/webpack/rollup/esbuild/parcel/turborepo 缓存)
 * - .cache(Nx/Turbo/通用缓存目录;**只收点号形态**——裸 `cache` 段在基线里 7 处全是源码目录:
 *   go-grpc-go/internal/cache、poly-grafana/apps/dashvalidator/pkg/cache、
 *   ruby-rails/activesupport/lib/active_support/cache 等,**绝不能整段剔除**)
 * - __pycache__/.pytest_cache/.mypy_cache(Python 字节码与工具缓存)
 * - .gradle/.terraform(构建状态目录,含二进制/生成物)
 * 明确**不收**的段(基线注意,收录会误杀手写源码):
 * - `static`:基线 8 处 static/ 中有手写源码 poly-grafana/pkg/api/static/static.go(Go embed 服务端)
 *   与 poly-owncast/static/offline-v2.ts(手写前端逻辑),整段剔除会误杀 → 交给 bundle 哈希兜底精确识别产物。
 * - `web`/`public`:poly-owncast 的 web/ 是手写前端源码,public/ 是静态资源入口(基线多处手写)。
 * - 裸 `cache`/`tmp`/`temp`:见上,cache 命中全是源码目录;tmp 只命中 ruby-rails/test/dummy/tmp
 *   (已被 test 过滤),整段剔除收益为零、误杀风险实存。
 * - `build`/`dist`/`coverage` 已在 NON_PRODUCT_SEGS(不是本集合,语义不同:那三个也是任务史/依赖产物口径)。
 * - `webpack`(裸):poly-grafana/scripts/webpack 是**构建脚本源码**目录,不是产物;
 *   若要识别 webpack 产物只认点号形态 `.webpack`(已在上表)。
 */
const BUILD_SEGS = new Set([
  ".next", "_next", ".nuxt", "_nuxt", ".output", ".svelte-kit", ".vite", ".cache", ".turbo",
  ".parcel-cache", ".angular", ".astro", ".docusaurus", ".webpack", ".rollup.cache", ".esbuild",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".terraform",
]);

/** bundle 哈希文件名:`<name>.<hash>.js` / `<hash>.js` / `<hash>.mjs|cjs|css`。
 * 哈希段 = ≥8 位 base36 且至少含一个数字(纯字母的 `client.minified.js` 不算哈希)。
 * 覆盖 owncast 的 `airplay.svg.201ld829s92qg.js`(带 artifact 中缀)与
 * `02if5pgqr6o9c.js`(纯哈希名);`index.js`/`v2.js`/`main.js` 这类短名不命中(无 ≥8 位哈希段)。
 * 正则带 i 标志(扩展名/哈希段大小写不敏感),但**命中后再要求哈希段全小写**:
 * 混大小写的字母数字名多是驼峰标识符——poly-grafana/scripts/cli/reportI18nStats.mjs 是
 * 手写统计脚本,却因「1 + 8nStats(≥7 位)」被 i 标志判成哈希(基线全仓扫描注意)。
 * 真实打包器产物哈希是 lowercase base36/hex(`201ld829s92qg`/`02if5pgqr6o9c`/`b3c4d5e6f7`)。 */
const BUNDLE_HASH_RE = /^(?:.*[._-])?([0-9a-z]*[0-9][0-9a-z]{7,})\.(?:m?js|cjs|css)$/i;

/** bundle 哈希名判定:匹配 BUNDLE_HASH_RE 且哈希段全小写(见上方 reportI18nStats 注意)。 */
function isBundleHashName(base: string): boolean {
  const m = BUNDLE_HASH_RE.exec(base);
  if (!m) return false;
  const hash = m[1]!;
  return hash === hash.toLowerCase();
}

/** 构建产物路径判定(手写源码的反面:编译器/打包器吐出来的东西)。
 * 判定三档:① 强构建目录段;② 根级 out/(仅路径首段是 out——基线 `out/` 零命中,
 * 只按根级判以免误杀 internal/out 这类源码目录);③ bundle 哈希文件名兜底。 */
export function isBuildArtifactPath(f: string): boolean {
  const segs = f.toLowerCase().split("/");
  if (segs.some((s) => BUILD_SEGS.has(s))) return true;
  // ② 根级 out/:构建输出惯例目录(Nuxt/Vite/webpack 的 outDir);只认首段,不做全路径匹配。
  if (segs[0] === "out") return true;
  // ③ 哈希名兜底:静态资源目录下的产物没有强构建段(owncast 的 static/web/_next/... 有 _next,
  // 但 static/web/xxx.201ld….js 这类同族产物只有文件名可判)。
  // 注意取**原始大小写**的 basename:isBundleHashName 的大小写闸就是靠它
 // (先 toLowerCase 会把 reportI18nStats.mjs 判成产物——基线注意)。
  const base = f.split("/").pop() ?? "";
  return isBundleHashName(base);
}

/** 非产品主线路径:任务史/文档/教程/示例/夹具/参考仓/依赖产物不是「这个项目提供的代码能力」。
 * 下 step 验收探针曾在入口榜压过真实入口(main@);
 * vendor/ 下第三方依赖的 import 也曾被算进项目框架( lampgenie-harness 画像注意);
 * py-fastapi 的 docs_src/** 教程、mmdetection 的 docs/**、grafana 的 public/test/mocks/** 同族。
 * 构建产物(.next/_next 等与 bundle 哈希名)并入同一口径——编译器输出不是产品能力。 */
export function isNonProductPath(f: string): boolean {
  if (DOC_EXT_RE.test(f)) return true;
  if (isBuildArtifactPath(f)) return true;
  return f.toLowerCase().split("/").some((s) => NON_PRODUCT_SEGS.has(s));
}

/** 证据路径优先级:0=产品源码;1=测试/示例/脚本/压测 mock(仍可作事实,但不当主线)。
 * dify 经验证:Flask 的 production 证据在 api/,但 scripts/stress-test 的 mock
 * 服务排在前面,LLM 事实表把压测 mock 写成了能力;降权后取 api/ 源码。 */
export function evidenceRank(f: string): number {
  if (isTestPath(f)) return 1;
  // 构建产物与测试/示例同档降权(2026-10-21):isNonProductPath 已在六面主链路上剔除它们;
  // 此处再给 rank=1 是给「只用 evidenceRank 排序、不过滤」的消费方兜底(不新增语义)。
  if (isBuildArtifactPath(f)) return 1;
  const segs = f.toLowerCase().split("/");
  if (segs.some((s) => ["scripts", "e2e", "examples", "example", "bench", "benchmark", "benchmarks", "fixtures", "testdata", "mock", "mocks", "testing", "stories"].includes(s))) return 1;
 // test-support/test-utils 等中缀目录同样是测试支撑(deepseek-harness 的 React 证据注意)
  if (segs.some((s) => /(^|[-_])tests?([-_]|$)/.test(s) || /(^|[-_])specs?([-_]|$)/.test(s))) return 1;
  const base = segs[segs.length - 1] ?? "";
  if (/^(vitest|jest)\./.test(base)) return 1;
  if (/(^|[._-])(test|spec|mock|fixture|testing|stories)([._-]|$)/.test(base)) return 1;
  return 0;
}

/** 过滤结果:kept=保留条目;filtered=被过滤条数(诚实输出用);samples=被过滤样本(≤3,便于人核对)。 */
export interface PathFilterResult<T> {
  kept: T[];
  filtered: number;
  samples: string[];
}

/** 非产品路径过滤(opts.all=true 原样放行,逃生口)。
 * getPath=条目取路径的函数;samples 收集被丢弃的路径(≤3)。 */
export function filterNonProductPaths<T>(
  items: readonly T[],
  getPath: (x: T) => string,
  opts: { all?: boolean } = {},
): PathFilterResult<T> {
  if (opts.all) return { kept: [...items], filtered: 0, samples: [] };
  const kept: T[] = [];
  const samples: string[] = [];
  let filtered = 0;
  for (const x of items) {
    const p = getPath(x);
    if (isNonProductPath(p)) {
      filtered++;
      if (samples.length < 3) samples.push(p);
      continue;
    }
    kept.push(x);
  }
  return { kept, filtered, samples };
}

/** 「不是产品证据」的合并判定:非产品路径(docs/examples/产物/mocks…)或测试文件。
 * 为什么要合并:bridge 的四条前端证据通道(http-api 字面量、ws 连接点、ws 路径字面量、
 * ipc 调用点)都要「既剔非产品路径又剔测试文件」,旧写法在每处各写一遍
 * `isNonProductPath(x) || isTestPath(x)`——五处条件堆叠既难对账(注记与实际滤网是否同源
 * 全靠人工核对)也容易漏一处( owncast 注意:注记说过滤了,exact 边里仍有
 * test/automated/api/lib/openapi.smoke.js 证据)。合并成单一谓词后,通道要过滤就调它,
 * 口径不可能再漂移。 */
export function isNonProductEvidencePath(f: string): boolean {
  return isNonProductPath(f) || isTestPath(f);
}

/** 过滤注记(空串=无需注记):过滤发生时显式呈报条数+样本+逃生口,--all 在场时说明已包含。 */
export function nonProductFilterNote(filtered: number, samples: readonly string[] = [], opts: { all?: boolean } = {}): string {
  if (opts.all) {
    return filtered > 0 ? `(已含 ${filtered} 条非产品路径条目(--all))` : "";
  }
  if (filtered <= 0) return "";
  const sample = samples.length ? `:${samples.join(", ")}` : "";
  return `(已过滤 ${filtered} 条非产品路径条目(docs/examples/test;--all 查看)${sample})`;
}