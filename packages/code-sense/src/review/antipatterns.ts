/**
 * 反模式八类检测(用户口径 2026-10-11):另起炉灶/孤独逻辑/丢三落四/换头不换尾/
 * 虚假测试/作弊/补丁式屎山/治标不治本。
 * 确定性层(grep/diff 文本分析,零 LLM)+ LLM 维度(进 prompt)。
 * 经验来源:本工作区 completion-auditor P-NN 模式体系的实战语言。
 *
 * step-058 加强(vibe coding 孤儿逻辑全覆盖):
 * - 修死因:execFile 无 shell,--include=*.{ts,tsx} 花括号是字面量 → 引用计数恒零,
 *   孤独逻辑全靠「全部误报」活着、另起炉灶分支永死。改为重复 --include 逐扩展名传参。
 * - 引用计数升级:排除定义文件 + 引用文件分类(测试/生产)——「只有测试接线」是
 *   vibe coding 最高发的孤儿形态(agent 写完模块+测试,从不接进生产链路)。
 * - 导出提取扩到 interface/type/enum(此前类型孤儿不可见)。
 * - 新增:孤儿事件(emit 无监听 / on 无发出者)、双胞胎实现(diff 内函数体雷同)、
 *   空 catch(治标不治本的确定性形态)、换头不换尾参数差加强。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { ReviewTarget, Finding } from "./index";

const execFileP = promisify(execFile);

/** 每类反模式的说明(LLM 维度判据,进 prompt)。 */
export const ANTIPATTERN_DIMENSION = `**反模式(八类,重点检查 AI 生成的变更;vibe coding 孤儿逻辑高发)**
- 另起炉灶:重复实现仓内已有能力(先搜既有 util/抽象再写新的);diff 内两处函数体雷同(复制漂移温床)
- 孤独逻辑:新增的导出(含 interface/type)无任何调用方(写了没接线);或**只有测试引用、生产链路零调用**(agent 最爱写完模块+测试就收工);跨模块事件 emit 无监听 / on 无发出者
- 丢三落四:改了 A 漏了配套(类型字段删了但引用还在/改行为漏改文档与配置)
- 换头不换尾:改了定义没改使用处(签名变了调用方没同步/半截重构)
- 虚假测试:空断言(仅 toBeTruthy/not.toThrow)/mock 了被测对象本身/测试与变更无关
- 作弊:期望值 hardcode 与实现串通/对特定测试输入特判/改测试迁就错误实现
- 补丁式屎山:层层特判堆叠不清理(纯叠加无删减/同函数第 N 层 if 补丁)
- 治标不治本:只压症状(catch 吞掉——尤其空 catch/except pass/特判绕过)而根因路径仍可达
命中即报,detail 引用具体证据;不确定降为 nit 并写明存疑点。`;

/** grep --include 必须逐个传(execFile 无 shell,花括号是字面量——step-058 修死因)。 */
// 2026-10-20 修复(code_review 卡死实锤):全仓 grep 未排除 node_modules/dist 等目录——从仓根扫
// 会进 node_modules(数百万文件),单个 pattern 实测 79.5s;一次审查跑几十个 pattern/事件名 =
// 几十分钟不返回(父任务卡在 code_review 的直接原因)。排除后同一 pattern 1.9s(42x)。
const GREP_EXCLUDES = [
  "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=build",
  "--exclude-dir=.git", "--exclude-dir=.genie", "--exclude-dir=.zcode", "--exclude-dir=.agents",
  "--exclude-dir=ref", "--exclude-dir=vendor", "--exclude-dir=coverage", "--exclude-dir=.next",
  "--exclude-dir=__pycache__", "--exclude-dir=.venv", "--exclude-dir=worktrees", "--exclude-dir=devlog",
];
const GREP_INCLUDES = [...GREP_EXCLUDES, "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.mjs", "--include=*.py"];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 判定引用文件是否测试文件(仅测试接线检测的分界)。 */
function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[tj]sx?$/.test(path) || /(^|\/)__tests__(\/|$)/.test(path);
}

interface AddedExport { name: string; line: number; kind: "code" | "type" }

/** 新增导出提取(diff + 行;含 interface/type/enum)。精度纪律:TS 家族必须显式 export——
 *  可选 export 前缀会把 diff 里每条 const 都当导出(「导出 a 无调用方」噪音刷屏,step-058 实测)。 */
function addedExports(diffText: string): AddedExport[] {
  const out: AddedExport[] = [];
  const seen = new Set<string>();
  let newLine = 0;
  for (const line of diffText.split("\n")) {
    const h = /^@@ .* \+(\d+)/.exec(line);
    if (h) { newLine = Number(h[1]); continue; }
    newLine++;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const m = /^\+\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^\+\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^\+\s*export\s+\{([^}]+)\}/.exec(line);
    const kind: AddedExport["kind"] = /export\s+(?:interface|type|enum)/.test(line) ? "type" : "code";
    if (m) {
      if (m[1]!.includes(",")) {
        for (const n of m[1]!.split(",")) {
          const nm = n.trim().split(/\s+as\s+/)[0]!.trim();
          if (nm && !seen.has(nm)) { seen.add(nm); out.push({ name: nm, line: newLine, kind: "code" }); }
        }
      } else if (!seen.has(m[1]!)) {
        seen.add(m[1]!);
        out.push({ name: m[1]!, line: newLine, kind });
      }
    } else {
      const d = /^\+\s*def\s+([A-Za-z_]\w*)/.exec(line); // python 无 export 关键字:顶层 def 视作导出
      if (d && !seen.has(d[1]!)) { seen.add(d[1]!); out.push({ name: d[1]!, line: newLine, kind: "code" }); }
    }
  }
  return out;
}

/**
 * 批量引用扫描(R4-C10 修正版):一次进程扫全部名字,返回 name → 引用文件集合。
 * 修正三点(此前引用层整体失效):①--include 逐扩展名(execFile 无 shell,花括号是字面量);
 * ②**按行内容**排除定义行——同文件的其他调用是合法接线,按文件排除会把「定义+同文件使用」
 * 误判孤儿(codeIndexTool 形态);③输出带绝对路径,调用方按内容判定不受相对/绝对影响。
 */
async function grepRefFiles(root: string, names: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  if (names.length === 0) return out;
  try {
    const { stdout } = await execFileP("grep", [
      "-rnE", ...GREP_INCLUDES,
      "--", names.map((n) => `\\b${escapeRe(n)}\\b`).join("|"), root,
    ], { maxBuffer: 32 * 1024 * 1024 });
    const defRes = names.map((n) =>
      new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function\\s+${escapeRe(n)}\\b|(?:const|let|var)\\s+${escapeRe(n)}\\b|class\\s+${escapeRe(n)}\\b|def\\s+${escapeRe(n)}\\b|interface\\s+${escapeRe(n)}\\b|(?:type|enum)\\s+${escapeRe(n)}\\b)`),
    );
    for (const line of stdout.split("\n")) {
      const m = /^(.*?):\d+:(.*)$/.exec(line);
      if (!m) continue;
      const content = m[2]!;
      for (let i = 0; i < names.length; i++) {
        if (!new RegExp(`\\b${escapeRe(names[i]!)}\\b`).test(content)) continue;
        if (defRes[i]!.test(content)) continue; // 定义行不算调用方;同文件其他调用=合法接线
        out.get(names[i]!)!.add(m[1]!);
      }
    }
  } catch {
    /* 无命中(grep exit 1)=全零 */
  }
  return out;
}

/** 仓内 quoted-name 分类计数(孤儿事件):返回 [发出者行数, 监听者行数]。 */
async function grepEventWiring(root: string, name: string): Promise<{ emitters: number; handlers: number }> {
  try {
    const q = escapeRe(name);
    const { stdout } = await execFileP("grep", [
      "-rnE", ...GREP_INCLUDES,
      "--", `["']${q}["']`, root,
    ], { maxBuffer: 8 * 1024 * 1024 });
    let emitters = 0, handlers = 0;
    for (const line of stdout.split("\n")) {
      if (!/:\d+:/.test(line)) continue;
      if (/\.(on|once|addListener|subscribe)\s*\(/.test(line)) handlers++;
      if (/\.(emit|publish|dispatchEvent|notify)\s*\(/.test(line)) emitters++;
    }
    return { emitters, handlers };
  } catch {
    return { emitters: 0, handlers: 0 };
  }
}

/** 修改文件中新增行里的测试弱断言密度(虚假测试信号)。 */
function weakAssertionCount(diffText: string): { weak: number; strong: number } {
  let weak = 0, strong = 0;
  for (const line of diffText.split("\n")) {
    if (!line.startsWith("+")) continue;
    if (/expect\([^)]*\)\.(toBeTruthy|toBeDefined|not\.toThrow)\(\)/.test(line)) weak++;
    else if (/\.toBe\(|\.toEqual\(|\.toContain\(|assert [_a-z]|\.toBeGreaterThan/.test(line)) strong++;
  }
  return { weak, strong };
}

/** 新增行提取事件名(emit 侧 / on 侧)。 */
function addedEventNames(diffText: string): { emits: Set<string>; ons: Set<string> } {
  const emits = new Set<string>(), ons = new Set<string>();
  for (const line of diffText.split("\n")) {
    if (!line.startsWith("+")) continue;
    for (const m of line.matchAll(/\.(?:emit|publish|dispatchEvent|notify)\s*\(\s*["'`]([A-Za-z0-9_.:-]+)["'`]/g)) emits.add(m[1]!);
    for (const m of line.matchAll(/\.(?:on|once|addListener|subscribe)\s*\(\s*["'`]([A-Za-z0-9_.:-]+)["'`]/g)) ons.add(m[1]!);
  }
  return { emits, ons };
}

/** 新增函数体提取(双胞胎检测):name → 归一化体行数组。 */
function addedFunctionBodies(diffText: string, cap = 40): Array<{ name: string; body: string[] }> {
  const lines = diffText.split("\n");
  const out: Array<{ name: string; body: string[] }> = [];
  let cur: { name: string; body: string[] } | null = null;
  for (const line of lines) {
    if (!line.startsWith("+") || line.startsWith("+++")) { continue; }
    const def = /^\+\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^\+\s*def\s+([A-Za-z_]\w*)/.exec(line);
    if (def) {
      if (cur && cur.body.length >= 3) out.push(cur);
      cur = { name: def[1] ?? def[2] ?? "?", body: [] };
      continue;
    }
    if (cur) {
      const norm = line.slice(1).trim().replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (norm) cur.body.push(norm);
      if (/^\+\s*}\s*$/.test(line)) {
        if (cur.body.length >= 3) out.push(cur);
        cur = null;
      }
      if (out.length >= cap) return out;
    }
  }
  if (cur && cur.body.length >= 3) out.push(cur);
  return out;
}

/**
 * 反模式确定性检测主入口。返回 findings。
 * step-058:孤儿逻辑家族六维全覆盖(vibe coding 高发),引用计数层修活。
 */
export async function detectAntipatterns(root: string, t: ReviewTarget): Promise<Finding[]> {
  const out: Finding[] = [];
  const srcFiles = t.files.filter((f) => !/\.(test|spec)\.[tj]sx?$/.test(f.path) && f.status !== "deleted");
  const testFiles = t.files.filter((f) => /\.(test|spec)\.[tj]sx?$/.test(f.path));

  // ---- 1/2. 另起炉灶 + 孤独逻辑(含仅测试接线/类型孤儿):新增导出批量引用分类计数 ----
  const allExports = srcFiles.flatMap((f) => addedExports(f.diffText).map((e) => ({ file: f.path, line: e.line, name: e.name, kind: e.kind })));
  const refMap = await grepRefFiles(root, allExports.map((e) => e.name));
  for (const exp of allExports) {
    const refFiles = refMap.get(exp.name) ?? new Set<string>();
    const kindTxt = exp.kind === "type" ? "类型 " : "导出 ";
    if (refFiles.size === 0) {
      // 孤独逻辑:全仓无人引用(入口文件除外)
      const isEntry = /(^|\/)(main|index|app|gateway|server)\.[tj]sx?$/.test(exp.file);
      if (!isEntry) {
        out.push({
          file: exp.file, line: exp.line, severity: "warning",
          title: `孤独逻辑:${kindTxt}${exp.name} 无任何调用方`,
          detail: `新增${kindTxt.trim()}在全仓(除定义文件)零引用——写了没接线,或是死代码`,
          scenario: "若为有意预留 API 请标注;否则应删除或接线上下游",
        });
      }
    } else if ([...refFiles].every((f) => isTestFile(f))) {
      // vibe coding 最高发:模块+测试写完收工,生产链路零调用
      out.push({
        file: exp.file, line: exp.line, severity: "nit",
        title: `孤独逻辑:仅测试接线——${kindTxt}${exp.name} 生产链路零调用`,
        detail: `引用全部来自测试文件([${[...refFiles].map((x) => x.split("/").pop()).join(", ")}]),生产代码没有任何调用方`,
        scenario: "若为测试先行(TDD)且接线在后续变更,可豁免;否则应接进生产链路",
      });
    } else if (isLikelyReinvention(exp.name)) {
      out.push({
        file: exp.file, line: exp.line, severity: "nit",
        title: `疑似另起炉灶:${exp.name}`,
        detail: `名字暗示通用能力,请确认仓内是否已有等价实现`,
        scenario: "仅当既有 util/抽象可复用时成立",
      });
    }
  }

  // ---- 2b. 孤儿事件(跨模块各玩各的数据):新 emit 无监听 / 新 on 无发出者 ----
  {
    let capped = 0;
    const nameFile = new Map<string, string>();
    const emits = new Set<string>(), ons = new Set<string>();
    for (const f of srcFiles) {
      const { emits: e2, ons: o2 } = addedEventNames(f.diffText);
      for (const n of e2) { emits.add(n); if (!nameFile.has(n)) nameFile.set(n, f.path); }
      for (const n of o2) { ons.add(n); if (!nameFile.has(n)) nameFile.set(n, f.path); }
    }
    for (const name of [...emits, ...ons]) {
      if (capped >= 8) break;
      const w = await grepEventWiring(root, name);
      if (emits.has(name) && w.handlers === 0) {
        out.push({
          file: nameFile.get(name) ?? "", line: 1, severity: "warning",
          title: `孤儿事件:emit "${name}" 全仓无监听`,
          detail: `发出了事件但没有任何 .on/.once/subscribe 消费——跨模块接线缺失,数据各玩各的`,
          scenario: "若监听方在后续变更/外部系统可豁免",
        });
        capped++;
      } else if (ons.has(name) && w.emitters === 0) {
        out.push({
          file: nameFile.get(name) ?? "", line: 1, severity: "warning",
          title: `孤儿监听:on "${name}" 全仓无发出者`,
          detail: `注册了监听但没有任何 .emit/publish 发出该事件——回调永远不触发(死接线)`,
          scenario: "若发出方在后续变更/外部系统可豁免",
        });
        capped++;
      }
    }
  }

  // ---- 2c. 双胞胎实现:diff 内两处函数体雷同(复制漂移温床) ----
  {
    const bodies = new Map<string, { name: string; file: string; line: number }>();
    let capped = 0;
    for (const f of srcFiles) {
      for (const fn of addedFunctionBodies(f.diffText)) {
        const key = fn.body.join("\n");
        const prev = bodies.get(key);
        if (prev && prev.name !== fn.name) {
          out.push({
            file: f.path, line: 1, severity: "warning",
            title: `双胞胎实现:${fn.name} 与 ${prev.name} 函数体逐行相同`,
            detail: `复制出的第二份实现(${prev.file})——将来改一处漏一处,复制漂移温床;应提取共用或删除`,
            scenario: "若为有意桥接两个不允许互相依赖的层,请注明",
          });
          if (++capped >= 10) break;
        } else if (!prev) {
          bodies.set(key, { name: fn.name, file: f.path, line: 1 });
        }
      }
      if (capped >= 10) break;
    }
  }

  // ---- 2d. 空 catch(治标不治本的确定性形态):异常静默吞掉 ----
  {
    let capped = 0;
    for (const f of srcFiles) {
      for (const line of f.diffText.split("\n")) {
        if (!line.startsWith("+")) continue;
        if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line) || /^\+\s*except\s*[^:]*:\s*pass\s*$/.test(line)) {
          out.push({
            file: f.path, line: 1, severity: "nit",
            title: "空 catch:异常被静默吞掉",
            detail: `新增行:${line.slice(1, 100).trim()}——失败不可见(fail-invisible),排障最大障碍`,
            scenario: "若为有意的可忽略清理路径,请写明注释理由",
          });
          if (++capped >= 5) break;
        }
      }
      if (capped >= 5) break;
    }
  }

  // ---- 3. 丢三落四:src 改了,同名测试存在但未在 diff 中 ----
  for (const f of srcFiles) {
    const base = f.path.replace(/\.[tj]sx?$/, "");
    const hasTest = await exists(join(root, `${base}.test.ts`)) || await exists(join(root, `${base}.test.tsx`));
    const testInDiff = t.files.some((x) => x.path === `${base}.test.ts` || x.path === `${base}.test.tsx`);
    if (hasTest && !testInDiff) {
      out.push({
        file: f.path, line: 1, severity: "nit",
        title: "丢三落四:实现变更但同名测试未动",
        detail: `${base}.test.ts 存在但不在本次 diff 中`,
        scenario: "仅当变更不影响测试覆盖的行为时可豁免",
      });
    }
  }

  // ---- 4. 换头不换尾(参数差加强):同名函数 -/+ 行参数个数不同,且调用方不在 diff ----
  {
    let capped = 0;
    const arityOf = (s: string): number => (s.trim() ? s.split(",").length : 0);
    for (const f of srcFiles) {
      const removedDefs = new Map<string, number>();
      const addedDefs = new Map<string, number>();
      for (const line of f.diffText.split("\n")) {
        let m = /^-\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/.exec(line);
        if (m) removedDefs.set(m[1]!, arityOf(m[2]!));
        m = /^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/.exec(line);
        if (m) addedDefs.set(m[1]!, arityOf(m[2]!));
      }
      for (const [name, before] of removedDefs) {
        const after = addedDefs.get(name);
        if (after === undefined || after === before) continue;
        const callerInDiff = t.files.some((x) => x.path !== f.path && new RegExp(`\\b${escapeRe(name)}\\b`).test(x.diffText));
        if (!callerInDiff) {
          out.push({
            file: f.path, line: 1, severity: "warning",
            title: `换头不换尾:${name} 参数 ${before}→${after} 个,调用方未同步`,
            detail: `签名参数个数变更,且全 diff 无其他文件引用 ${name}——调用方要么在本 diff 外(运行必炸),要么此函数是新孤岛`,
            scenario: "若签名兼容(加可选参/内部实现)则不成立",
          });
          if (++capped >= 5) break;
        }
      }
      if (capped >= 5) break;
    }
  }

  // ---- 5. 虚假测试:弱断言占主导 ----
  for (const tf of testFiles) {
    const { weak, strong } = weakAssertionCount(tf.diffText);
    if (weak >= 3 && weak > strong) {
      out.push({
        file: tf.path, line: 1, severity: "warning",
        title: `虚假测试信号:弱断言 ${weak} 条 vs 实断言 ${strong} 条`,
        detail: "toBeTruthy/toBeDefined/not.toThrow 不验证行为,只证明不抛错",
        scenario: "测试通过≠功能正确(自证陷阱)",
      });
    }
    // mock 了被测对象自身
    if (/vi\.mock\(|jest\.mock\(/.test(tf.diffText)) {
      const mocked = /(?:vi|jest)\.mock\(["']([^"']+)["']/.exec(tf.diffText)?.[1];
      const selfPath = tf.path.replace(/\.test\.[tj]sx?$/, "");
      if (mocked && (mocked.includes(selfPath.split("/").pop()!.replace(/\.[tj]sx?$/, "")) || tf.path.includes(mocked.replace(/^\.?\//, "")))) {
        out.push({
          file: tf.path, line: 1, severity: "blocker",
          title: "作弊:mock 了被测对象本身",
          detail: `vi.mock(${mocked}) 把被测模块替身化——测试永远绿`,
          scenario: "任何实现错误该测试都无法发现",
        });
      }
    }
  }

  // ---- 6. 作弊:相同长字面量同时出现在 src 新增与 test 新增 ----
  const srcLiterals = new Set<string>();
  for (const f of srcFiles) {
    for (const m of f.diffText.matchAll(/^\+.*(?:return|=)\s*"([^"\\]{8,})"/gm)) {
      srcLiterals.add(m[1]!);
    }
  }
  for (const tf of testFiles) {
    for (const line of tf.diffText.split("\n")) {
      if (!line.startsWith("+")) continue;
      for (const lit of srcLiterals) {
        if (line.includes(lit) && /\.toBe\(|toEqual\(/.test(line) && !/[\n\\]/.test(lit)) {
          out.push({
            file: tf.path, line: 1, severity: "warning",
            title: "疑似作弊:期望值与实现字面量相同",
            detail: `字面量 "${lit.slice(0, 40)}" 同时出现在实现与断言——像为实现量身定做的期望`,
            scenario: "若该值为协议/规范常量则合理;若为输出计算结果则测试无鉴别力",
          });
          break;
        }
      }
    }
  }

  // ---- 7. 补丁式屎山:同文件纯叠加(增行 >> 删行)+ 多层特判 ----
  for (const f of srcFiles) {
    const lines = f.diffText.split("\n");
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    const condAdded = lines.filter((l) => l.startsWith("+") && /(if\s*\(|&&|\|\|)\s/.test(l)).length;
    if (added > 15 && added > removed * 3 && condAdded >= 5) {
      out.push({
        file: f.path, line: 1, severity: "warning",
        title: `补丁式屎山信号:纯叠加(+${added}/-${removed})新增条件 ${condAdded} 处`,
        detail: "只增不删+条件堆叠=特判补丁累积,应重构收敛而非再叠一层",
        scenario: "当本变更是收敛性重构时豁免",
      });
    }
  }

  return out;
}

function isLikelyReinvention(name: string): boolean {
  // 通用能力词(另起炉灶高发区)
  return /^(format|parse|deep)?[Cc]opy$|^deepClone$|^merge$|^unique|debounce|throttle|sleep|retry|^formatDate|^isEmpty/.test(name);
}

async function exists(p: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  return access(p).then(() => true).catch(() => false);
}
