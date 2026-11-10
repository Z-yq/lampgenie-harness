/** 板型一致性门(用户 13 类规范):确定性、纯函数、零 IO。
 * 背景:类型规范长期只在 planner 提示词里,经验证出现 test 板画成代码变更图、ui 板混代码
 * targets/WS 逻辑、research 板不是矩阵、contract 板留占位消费者、deploy smoke 未接线。
 * 本规则把「这张图是否回答了该类型的问题」变成可点名的问题,供 board_upsert/audit 回执;
 * 与 validateChangeContract 分开:后者保持 等价对拍基线,板型门是增量检查。
 */
import type { BoardContractIssue, BoardNodeT, EdgeLike } from "../shared.js";
import { DOC_GENRES } from "../../board-skills.js";
import { COMPOSITION_RELATIONS, hasThemeNode, isCompositionStructure, isContentNode } from "../../board-content-predicate.js";

const T = (n: BoardNodeT): string =>
  `${n.group ?? ""} ${n.label ?? ""} ${n.summary ?? ""} ${JSON.stringify(n.flow ?? [])}`;
const allText = (nodes: BoardNodeT[]): string => nodes.map(T).join(" ");
const labelText = (n: BoardNodeT): string => `${n.group ?? ""} ${n.label ?? ""}`;
const kindSet = (nodes: BoardNodeT[]): Set<string> => new Set(nodes.map((n) => String(n.kind ?? "")));
const hasKind = (nodes: BoardNodeT[], ...kinds: string[]): boolean => nodes.some((n) => kinds.includes(String(n.kind ?? "")));
const hasEdge = (edges: EdgeLike[], pred: (e: EdgeLike) => boolean): boolean => edges.some(pred);
const issue = (problems: string[], nodeId = "(board)", label = "整板"): BoardContractIssue => ({
  nodeId, label, problems: problems.map((p) => `[类型门] ${p}`),
});

/** 多屏 UI 交互图底线:页面间必须有 nav 跳转、每屏至少出现在一条交互边上。
 * 元素级锚点(component→page)由 planner 提示词引导,渲染层对 page→page 的触发 label 做真实元素归位;
 * 这里不硬卡元素级(存量板仍可读),只卡「连不起来/孤屏」这两类硬缺口。 */
function multiPageFlowIssues(nodes: BoardNodeT[], es: EdgeLike[]): string[] {
  const pages = nodes.filter((n) => String(n.kind ?? "") === "page");
  if (pages.length < 2) return [];
  const pageIds = new Set(pages.map((p) => String(p.id)));
  const parent = new Map<string, string>();
  for (const e of es) {
    if (String(e.kind ?? "") !== "contains") continue;
    const to = String(e.to);
    if (!parent.has(to)) parent.set(to, String(e.from));
  }
  // 元素→页面也是跨屏交互(元素级锚点是首选写法);owner 沿 contains 找所属 page。
  const owner = (id: string): string | null => {
    let cur = id;
    for (let guard = 0; cur && guard < 30; guard++) {
      if (pageIds.has(cur)) return cur;
      cur = parent.get(cur) ?? "";
    }
    return null;
  };
  const navs = es.filter((e) => String(e.kind ?? "") === "nav" && !!String(e.label ?? "").trim());
  const out: string[] = [];
  const cross = navs.some((e) => {
    const a = owner(String(e.from)), b = owner(String(e.to));
    return !!a && !!b && a !== b;
  });
  if (!cross) {
    out.push("多页 UI 缺跨屏 nav 跳转:交互流程图连不起来(元素→页面或页面→页面至少一条)");
  }
  const touched = new Set<string>();
  for (const e of navs) {
    const a = owner(String(e.from)), b = owner(String(e.to));
    if (a) touched.add(a);
    if (b) touched.add(b);
  }
  const isolated = pages.filter((p) => !touched.has(String(p.id)));
  if (isolated.length) {
    out.push(`页面没有交互连线:${isolated.slice(0, 6).map((p) => p.id).join(",")}——多屏板每屏至少有一条 nav 进出`);
  }
 // 空白屏过多:交互地图会退化成「一堆空手机壳」(经验证 22 屏规划板只有 5 屏有区块)。
  const childCount = new Map<string, number>();
  for (const e of es) {
    if (String(e.kind ?? "") !== "contains") continue;
    const from = String(e.from);
    if (pageIds.has(from)) childCount.set(from, (childCount.get(from) ?? 0) + 1);
  }
  const emptyPages = pages.filter((p) => (childCount.get(String(p.id)) ?? 0) === 0);
  if (emptyPages.length > Math.floor(pages.length * 0.6)) {
    out.push(`空白屏过多(${pages.length - emptyPages.length}/${pages.length} 屏有区块):先补每屏 section/component,否则交互图只剩空手机壳`);
  }
  return out;
}

/** :code 板的步骤节点 = 图上要写代码级动作的节点族。 */
const CODE_STEP_KINDS = ["function", "module", "io", "tool", "http"];

/** :
 *  「待办动作」形态判定——label 以祈使动词开头(实现/修复/添加…),且 flow 里没有任何
 *  函数调用形(`fn(` / `a.b` / `→`),说明它描述的是要做的事,不是代码里已经存在的步骤。
 *  保守口径:change=keep 的节点不判(keep 的动词 label 可能是在描述现有动作);
 *  test/page/ui 板不走这条(只在 case "code" 里调用)。 */
const TODO_VERB_RE = /^\s*[\d.、)_-]*\s*(实现|修复|添加|新增|重构|删除|补充|更新|编写|跑|执行|验证|测试|优化|改造)/;
const CALL_SHAPE_RE = /\w+\(|\w+\.\w+|→/;
const flowTexts = (n: BoardNodeT): string[] => {
  const out: string[] = [];
  const walk = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const st of arr) {
      if (!st || typeof st !== "object") continue;
      const s = st as Record<string, unknown>;
      if (typeof s.text === "string") out.push(s.text);
      if (typeof s.cond === "string") out.push(s.cond);
      if (typeof s.over === "string") out.push(s.over);
      walk(s.then);
      walk(s.else);
    }
  };
  walk(n.flow);
  return out;
};
const isTodoActionNode = (n: BoardNodeT): boolean => {
  if (String(n.change ?? "") === "keep") return false;
  if (!TODO_VERB_RE.test(String(n.label ?? ""))) return false;
  const texts = flowTexts(n);
  if (!texts.length) return true;
  return !texts.some((t) => CALL_SHAPE_RE.test(t));
};

/** 仓库相对路径形态:含 `/` 或带代码/文档扩展名。纯中文描述、纯符号名(如 `validate`)不算——
 *  读者看不出「改的是仓库里哪个文件」。`packages/x/src/y.ts#symbol` 由 # 前部分判定。 */
const REPO_PATH_RE = /(?:[\w.@$-]+\/)+[\w.@$-]+|[\w.@$-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|mdx|json|py|go|rs|java|kt|sql|yml|yaml|toml|css|scss|html|vue|svelte|sh)/;
const asRepoPath = (s: unknown): string | null => {
  const t = String(s ?? "").trim();
  if (!t) return null;
  return REPO_PATH_RE.test(t.split("#")[0] ?? t) ? t : null;
};
/** 节点自带的仓库锚点(targets + symbolRef.name/file)。 */
const nodeAnchors = (n: BoardNodeT): string[] => {
  const out: string[] = [];
  if (Array.isArray(n.targets)) out.push(...n.targets.map((t) => String(t ?? "")));
  const sym = n.symbolRef as { name?: string; file?: string } | undefined;
  if (String(sym?.name ?? "").trim()) out.push(String(sym?.name));
  if (String(sym?.file ?? "").trim()) out.push(String(sym?.file));
  return out.map((s) => s.trim()).filter(Boolean);
};

/** 二期内容来源层:
 * keep(现状)节点与 modify/delete 的 before 都要带**验证锚**——锚只能来自 code_sense 查证,
 *  不许凭印象写。可判定形态:
 *  ① file:line(如 `type-conformance.ts:166` / `apps/gateway/src/x.ts:12`);
 *  ② 「调用方/被调方/callers/callees/被调」+ 真实文件名(带扩展名或路径)。
 *  纯抽象描述(「处理逻辑」「优化性能」)两个都不命中 → 判印象描述,点名回炉。 */
const EXT_ALT = "ts|tsx|js|jsx|mjs|cjs|md|mdx|json|py|go|rs|java|kt|sql|yml|yaml|toml|css|scss|html|vue|svelte|sh";
const FILE_TOKEN = String.raw`[\w.@$/-]+\.(?:${EXT_ALT})`;
const FILE_LINE_RE = new RegExp(String.raw`${FILE_TOKEN}:\d+`);
const FILE_NAME_RE = new RegExp(String.raw`${FILE_TOKEN}(?![\w-])`);
const CALL_WORD_RE = /(callers?|callees?|被调(?:用)?方?|调用方?|被调用|调用)/i;
/** 验证锚判定(三条任一条成立即可回链到仓库真实结构):
 *  ① 正文(summary/label/flow)出现 file:line;
 *  ② 正文出现「调用词 + 真实文件名」;
 *  ③ 节点自带仓库锚(targets 形如 src/x.ts#symbol、或 symbolRef.file)——同样是能点开的真实位置,
 *     且已被「步骤 targets 必须是仓库相对路径」那条门单独校验过。 */
const hasEvidenceAnchor = (n: BoardNodeT): boolean => {
  const t = `${String(n.summary ?? "")} ${String(n.label ?? "")}\n${flowTexts(n).join("\n")}`;
  if (FILE_LINE_RE.test(t) || (CALL_WORD_RE.test(t) && FILE_NAME_RE.test(t))) return true;
  return nodeAnchors(n).some((a) => asRepoPath(a));
};
/** before 锚判定(比现状锚宽一档:符号名也算锚——before 讲的是「现有这段代码在做什么」,
 *  符号名(如 `parseOffice(` / `readConfig`)足以定位到具体代码段,不必非要行号)。 */
const SYMBOL_ANCHOR_RE = /\b[a-zA-Z_$][\w$]{2,}\b/;
const hasBeforeAnchor = (text: string): boolean => {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  if (FILE_LINE_RE.test(t) || FILE_NAME_RE.test(t)) return true;
  return SYMBOL_ANCHOR_RE.test(t);
};
/** 结构化锚判定(「白板看得懂」):锚必须挂在节点字段上——targets 含真实仓库路径
 *  或 symbolRef 带 file/name,渲染层才能把锚画在卡上。只把 file:line 写进 summary 的「文本锚」
 *  读者在画布上看不见,不算;`targets:[""]` / `symbolRef:{}` 这类空壳也不算(否则门形同虚设)。
 *  (hasEvidenceAnchor 的文本三路语义不动:断言节点证据判定仍用它。) */
const hasStructuredAnchor = (n: BoardNodeT): boolean => {
  const ts = (Array.isArray(n.targets) ? n.targets : []).map((t) => String(t ?? "").trim()).filter(Boolean);
  if (ts.some((t) => !!asRepoPath(t))) return true;
  const sym = n.symbolRef as { name?: string; file?: string } | undefined;
  if (!sym) return false;
  const file = String(sym.file ?? "").trim();
  const name = String(sym.name ?? "").trim();
  return (!!file && !!asRepoPath(file)) || (!!name && !!file);
};

export interface TypeConformanceOpts {
 /** 显式规模(新板必填):带 scale = 启用 通用硬规则;旧板不背。 */
  scale?: string;
  /** 测试/调用方可强制严格规则(不看 scale)。 */
  strict?: boolean;
 /** 文档体裁(docs 板, 通用机制):board-skills DOC_GENRES 的 key;
   * 在场时按体裁必答维度查覆盖(章/页 label+summary 命中别名=有落点),缺维度点名。 */
  docGenre?: string;
}

const hasText = (s: unknown): boolean => !!String(s ?? "").trim();
const textOfNode = (n: BoardNodeT): string => T(n);
const byIdOf = (nodes: BoardNodeT[]): Map<string, BoardNodeT> => new Map(nodes.map((n) => [String(n.id), n]));
const isVerificationType = (t: string): boolean =>
  ["code", "test", "ui-func", "fault", "refactor", "perf", "data", "contract", "deploy", "orchestration"].includes(t);

/** 通用硬规则(仅新板/显式 strict):before/边 label/P0 accept/断言证据/数字口径/孤儿。 */
/** 纯计划步骤板检测:
 * 长尾注意——2-3 节点板全是「s1 梳理→s2 归因→s3 修复」「v1 确认→v2 验证」,零 targets/
 * symbolRef/accept/数据,退化成 TODO 序列。内容节点=指向实际对象(targets/symbolRef)或带
 * 命令级验收(accept),或 summary/label 带指标数字/文件路径(分析类任务的「内容」=数据与口径)。
 * 全板(除 ph-)无任何内容节点才点名;有内容节点时步骤节点是合法的执行过程节点,不误伤。 */
function narrativeBoardIssues(nodes: BoardNodeT[], docKind?: string, boardType?: string): string[] {
 // 页面结构/工作流板:合法无 targets(口径「非代码目标件不要求 targets」)
  if (String(docKind ?? "") === "page" || String(docKind ?? "") === "workflow") return [];
 // 作业思路板(composition:主题/受众/章节是表达结构,本来就不指向代码对象——
  // 「纯计划步骤板」那条判据不适用,改由 case "composition" 的内容判据兜。
  if (String(boardType ?? "") === "composition") return [];
  const real = nodes.filter((n) => !/^ph-/.test(String(n.id)));
  if (real.length < 2) return [];
 // 内容节点判据归一到 board-content-predicate.ts(取原类型门的宽版;
  // 与 plan-gate 共享同一实现,防两侧分叉导致同一张板得两个结论。
  if (real.some((n) => isContentNode(n))) return [];
  return [`纯计划步骤板:${real.length} 个节点全是执行序列(先做A→再做B),零 targets/symbolRef/accept/数据——板是「本次变更在系统里的内容契约」不是 TODO 清单。每个节点要么指向实际对象(targets=文件/函数路径,或 symbolRef),要么带命令级 accept;分析/性能任务写指标数字与数据来源,不写「拆解→砍→复跑」`];
}

function strictCommonIssues(nodes: BoardNodeT[], es: EdgeLike[], boardType: string): string[] {
  const out: string[] = [];
  const byId = byIdOf(nodes);
  const needsBefore = ["code", "refactor", "fault", "perf", "data", "contract", "deploy", "orchestration"].includes(boardType);
  if (needsBefore) {
    const bad = nodes.filter((n) => ["modify", "delete"].includes(String(n.change ?? "")) && !hasText(n.before));
    if (bad.length) out.push(`modify/delete 缺 before(原行为/原代码锚点):${bad.slice(0, 6).map((n) => n.id).join(",")}`);
 // 二期①:keep=现状节点必须带
 // 验证锚——summary(label/flow 作补充)里至少一个 file:line,或「调用方/被调方 + 真实文件名」。
    // 纯抽象描述(「处理逻辑」「优化性能」)没有锚 → 读者无法回链到代码,判印象描述。
 // 二次收紧(p1「白板看得懂」):锚必须**结构化**(挂 targets/symbolRef),只写在 summary
    // 里的 file:line 在画布上渲染不出来,读者看不见 → 也判不合格;文案教怎么改成结构化锚。
    const keepNodes = nodes.filter((n) => !/^ph-/.test(String(n.id)) && String(n.change ?? "") === "keep"
      // 主题节点豁免:它讲「整板用途 + 本次改哪一环」,天然不指向具体代码段;强制它带 targets
 // 会逼模型给主题塞假锚( code review 指出的一致性缺口)。
      && !hasThemeNode([n]));
    const unanchored = keepNodes.filter((n) => !hasStructuredAnchor(n));
    if (unanchored.length) {
      out.push(`keep(现状)节点锚不可见:${unanchored.length} 个节点只在 summary 写了 file:line,画布上看不到——把锚挂到 targets=['仓库相对路径#符号名'] 或 symbolRef{file,name,line}(可直接用 board_upsert action=skeleton 预填结构化锚):${unanchored.slice(0, 6).map((n) => `${n.id}「${String(n.label ?? n.id)}」`).join(",")}`);
    }
 // 二期②:before 升级为「带真依据」——只说「旧行为」等于没说;要写现有符号名(parseOffice(/readConfig)或 file:line。
    const weakBefore = nodes.filter((n) => ["modify", "delete"].includes(String(n.change ?? ""))
      && hasText(n.before) && !hasBeforeAnchor(String(n.before)));
    if (weakBefore.length) {
      out.push(`before 缺真实锚(现有符号名或 file:line):${weakBefore.slice(0, 6).map((n) => `${n.id}「${String(n.before ?? "")}」`).join(",")}——before 要讲当前真实行为(哪个函数/哪行怎么走),不写「旧行为」「原逻辑」这类空描述`);
    }
  }
  const unlabeled = es.filter((e) => String(e.kind ?? "call") !== "contains" && !hasText(e.label));
  if (unlabeled.length) out.push(`边缺显式 label:${unlabeled.slice(0, 6).map((e) => `${e.from}→${e.to}`).join(",")}`);
 // (逻辑层口径):keep 节点是「纯读现有逻辑」的快照,不改代码没有可验收的东西 → 免 accept。
  const p0 = nodes.filter((n) => String(n.phase ?? "") === "P0" && String(n.change ?? "") !== "keep");
  const accAll = p0.flatMap((n) => (Array.isArray(n.accept) ? n.accept : []).map((a) => ({ n, a })));
  if (p0.length && accAll.length === 0) out.push("P0 节点没有 accept:无法验收");
  const badAcc = accAll.filter(({ a }) =>
    !["command", "browser", "manual", "negative"].includes(String(a?.type ?? "")) || !hasText(a?.expect));
  if (badAcc.length) out.push(`P0 accept 缺四类 type 或 expect:${badAcc.slice(0, 5).map(({ n, a }) => `${n.id}:${String(a?.cmd ?? "")}`).join(",")}`);
  if (isVerificationType(boardType) && accAll.length && !accAll.some(({ a }) => String(a?.type ?? "") === "negative")) {
    out.push("验证语义板型至少 1 条 negative 断言:没有失败/异常路径验收");
  }
  // 断言类节点必须有证据入边;测试断言允许自身 expect 文本作为证据载体。
  const assertNodes = nodes.filter((n) => /(根因|结论|瓶颈|评分|推荐|断言)/.test(String(n.label ?? "")));
  for (const n of assertNodes) {
    if (boardType === "docs" && /结论/.test(String(n.label ?? ""))) continue; // 文档结论是全文根,证据在后续章节
    const own = (Array.isArray(n.evidence) && n.evidence.length > 0) ||
      /(证据|日志|log|trace|行号|file:|实测|profiling|火焰图|指标|截图|expect|期望|断言)/i.test(textOfNode(n));
    if (own) continue;
    const incoming = es.filter((e) => String(e.to) === String(n.id));
    const srcEv = incoming.some((e) => {
      const src = byId.get(String(e.from));
      return /(证据|日志|log|trace|行号|file:|实测|profiling|火焰图|指标|截图)/i.test(`${textOfNode(src as BoardNodeT)} ${String(e.label ?? "")}`);
    });
    if (!srcEv) out.push(`断言节点缺证据入边:${n.id}「${String(n.label ?? "")}」——先补观测/实测/文件证据`);
  }
  const vague = nodes.filter((n) => /(尽快|后续再|适当|稍后)/.test(textOfNode(n)));
  if (vague.length) out.push(`数字/时间承诺用了模糊词(尽快/后续/适当):${vague.slice(0, 5).map((n) => n.id).join(",")}`);
  // 孤儿:有边的板不允许节点完全游离(ph- 阶段卡除外)。
  const touched = new Set<string>();
  for (const e of es) { touched.add(String(e.from)); touched.add(String(e.to)); }
  const orphans = nodes.filter((n) => !/^ph-/.test(String(n.id)) && !touched.has(String(n.id)));
  if (es.length && orphans.length) out.push(`存在孤儿节点(无任何边):${orphans.slice(0, 6).map((n) => n.id).join(",")}`);
  return out;
}

/** 各类 ➕ 硬规则(文本/边可判定子集;渲染层再出阶段/角色/徽标)。 */
function strictTypeIssues(nodes: BoardNodeT[], es: EdgeLike[], boardType: string): string[] {
  const out: string[] = [];
  const text = allText(nodes);
  const label = (e: EdgeLike): string => String(e.label ?? "");
  const idsBy = (re: RegExp): Set<string> => new Set(nodes.filter((n) => re.test(labelText(n))).map((n) => String(n.id)));
  const one = (cond: boolean, msg: string) => { if (!cond) out.push(msg); };
  switch (boardType) {
    case "code": {
      const testIds = idsBy(/(测试|test|spec|回归)/i);
      one(es.some((e) => testIds.has(String(e.to)) || testIds.has(String(e.from)) || /测试|test|spec|verify/i.test(label(e))), "缺关联测试边:影响面没有 tests 锚点");
      const changeIds = new Set(nodes.filter((n) => ["add", "modify", "delete"].includes(String(n.change ?? ""))).map((n) => String(n.id)));
      // 纯 flow 分析板可以没有变更节点;只有存在变更节点时才要求上游 caller 方向
      if (changeIds.size) one(es.some((e) => changeIds.has(String(e.to)) && !changeIds.has(String(e.from))), "缺上游 caller 方向:变更节点的入边没有波及面");
      break;
    }
    case "test": {
      one(/(执行|运行|run)/i.test(text), "测试六段缺「执行」");
      one(/(被测|logic|symbol)/i.test(text), "测试六段缺「被测逻辑」(symbolRef linked)");
      one(/(回归|regression|复跑)/i.test(text), "测试六段缺「回归锚」");
      const dec = nodes.filter((n) => String(n.kind ?? "") === "decision" || /decision|分支/.test(labelText(n)));
      one(dec.some((n) => es.filter((e) => String(e.from) === String(n.id)).length >= 2), "decision 分支不足 2 出口");
      one(/(期望|expect|断言)/i.test(text), "断言缺可判定期望 expect");
      break;
    }
    case "docs": {
      const conclusion = nodes.filter((n) => /结论|推荐|verdict/i.test(labelText(n)));
      one(conclusion.length > 0, "缺全文结论节点");
      const roots = conclusion.filter((n) => !es.some((e) => String(e.to) === String(n.id) && String(e.kind ?? "") === "data"));
      one(roots.length > 0, "结论不是根(被 data 边指向):结论先行,不是最后补一条");
      const vagueTitles = nodes.filter((n) => /^(概述|背景|介绍|调研|现状)$/.test(String(n.label ?? "").replace(/^\d+[\s._-]*/, "").trim()));
      one(vagueTitles.length === 0, `章节标题缺断言句(概述/背景类名词):${vagueTitles.slice(0, 5).map((n) => n.id).join(",")}`);
      break;
    }
    case "fault": {
      const hyps = nodes.filter((n) => /假设|hypothesis/i.test(labelText(n)));
      one(hyps.length >= 2, "候选假设不足 2 个");
      one(/排除/.test(text), "被排除假设缺排除依据");
      one(/(owner|负责|责任人)/i.test(text), "防复发缺可执行动作+owner");
      const roots = nodes.filter((n) => /根因/.test(labelText(n)));
      one(roots.some((n) => es.some((e) => String(e.to) === String(n.id))), "根因缺证据入边");
      break;
    }
    case "refactor":
      one(/(展开|expand)/i.test(text), "重构缺 expand(新旧并存)阶段");
      one(/(迁移|migrate)/i.test(text), "重构缺 migrate(逐消费方)阶段");
      one(/(收口|contract|零读取|删旧)/i.test(text), "重构缺 contract(零读取后删旧)阶段");
      one(/(回滚|rollback|revert)/i.test(text) && /(触发|阈值|条件)/.test(text), "回滚缺触发条件/阈值");
      break;
    case "perf": {
      one(/(同环境|同负载|同一环境|同口径)/i.test(text), "基线/验收缺同口径同环境说明");
      const changeIds = new Set(nodes.filter((n) => /(改动|优化|change|修复)/.test(labelText(n))).map((n) => String(n.id)));
      const targetIds = new Set(nodes.filter((n) => /(目标|阈值|target|验收)/.test(labelText(n))).map((n) => String(n.id)));
      one(es.some((e) => (changeIds.has(String(e.from)) && targetIds.has(String(e.to))) || (targetIds.has(String(e.from)) && changeIds.has(String(e.to)))), "改动→指标缺 verify 边");
      one(/(CI|门禁|监控|预算)/i.test(text), "缺 CI/监控门禁:收益会随提交流失");
      break;
    }
    case "data":
      one(/(overwrite|delete.?insert|upsert|分区覆盖)/i.test(text), "幂等策略缺失(三选一 overwrite/delete-insert/upsert)");
      one(/(unique|not_null|accepted_values|引用完整性|新鲜度|质量断言)/i.test(text), "缺质量断言(unique/not_null/引用完整性/新鲜度)");
      one(/(quarantine|DLQ|隔离)/i.test(text) && /triage|分诊|人工处置/i.test(text), "脏数据缺 quarantine/DLQ + triage");
      one(/(backfill|回填|重跑|部分失败)/i.test(text), "缺部分失败/重跑/backfill 入口");
      break;
    case "contract":
      one(/(semver|major|minor|版本策略)/i.test(text), "缺 semver/版本策略");
      one(/弃用至\s*\d{4}[-/年]\d{1,2}/.test(text), "弃用窗口缺机器可读日期(弃用至 YYYY-MM-DD)");
      one(/(迁移|migrate|升级)/i.test(text), "breaking change 缺消费方迁移路径");
      one(/(Tolerant Reader|契约测试|contract test|新旧共存)/i.test(text), "缺 Tolerant Reader/契约测试");
      break;
    case "deploy":
      one(/(判据|pass|fail|通过判据|命令|url)/i.test(text), "preflight 缺每项通过判据");
      one(/(rolling|蓝绿|canary|灰度|放量|观察窗)/i.test(text), "缺发布策略(rolling/蓝绿/canary)");
      one(/(P0|启动.*配置.*任务|负面)/i.test(text), "smoke 缺 P0 用户旅程/负面断言");
      one(/(回滚|rollback)/i.test(text) && /(触发|阈值|条件)/.test(text), "回滚缺触发条件/阈值");
      break;
    case "research":
      one(/(权重|weight|\d+\s*%)/i.test(text), "决策矩阵缺维度权重(加权分不可复算)");
      one(/(高|中|低|置信|可信度|未知)/.test(text), "证据缺可信度档位/未知标记");
      one(/(放弃|不选|理由)/.test(text), "缺被拒候选的放弃理由");
      break;
    case "orchestration":
      one(/(职责|role)/i.test(text) && /(输入|input|schema)/i.test(text) && /(输出|output|schema)/i.test(text) && /(工具|tool)/i.test(text), "agent 缺四字段(职责/输入/输出/工具面)");
      one(/(timeout|超时)/i.test(text) && /(retry|重试)/i.test(text), "缺 timeout/retry 失败分支");
      one(/(fan-in|回收|聚合|终态)/i.test(text), "fan-out 缺 fan-in 回收");
      one(/(共享存储|shared storage|引用)/i.test(text), "大载荷未经共享存储引用传递");
      break;
  }
  return out;
}

/** 主入口:boardType 缺省/未知 → 不检查(旧板/设计板不背类型门);返回 [] 表示通过。
 * opts.scale 存在(新板显式标规模)时追加 通用+分类硬规则;旧板保持旧口径。 */
export function validateBoardTypeConformance(
  nodes: BoardNodeT[],
  edges: EdgeLike[] | undefined,
  boardType?: string,
  docKind?: string,
  opts?: TypeConformanceOpts): BoardContractIssue[] {
  if (!boardType) return [];
  const es = edges ?? [];
  const text = allText(nodes);
  const out: BoardContractIssue[] = [];
 // 纯计划步骤板:无条件检查——新旧板通杀(长尾注意的 2-3 节点 TODO 板不分规模)。
  const narrative = narrativeBoardIssues(nodes, docKind, boardType);
  if (narrative.length) out.push(issue(narrative));
 /** flow 板(start/end 存在)通用检查:code 与 test 共用(测试类型接入 code flow)。 */
  function flowBoardMissing(nodes: BoardNodeT[], es: EdgeLike[]): string[] {
    const missing: string[] = [];
    if (!nodes.some((n) => String(n.kind ?? "") === "start")) missing.push("缺 start:读者找不到触发入口(补一个 kind=start 的触发节点)");
    if (!nodes.some((n) => String(n.kind ?? "") === "end")) missing.push("缺 end:读者找不到结果出口(补 kind=end 的结果节点)");
    const decs = nodes.filter((n) => String(n.kind ?? "") === "decision");
    if (!decs.length) missing.push("缺 decision:看不出分支/失败路径(补一个 kind=decision 判断节点,是/否双出口)");
    else {
      const open = decs.filter((d) => {
        // 排除系统推导的「同组次序」nav 虚边:它们不是判断分支
        const outs = es.filter((e) =>
          String(e.from) === String(d.id)
          && String(e.kind ?? "call") !== "nav"
          && String(e.label ?? "") !== "同组次序");
        if (outs.length < 2) return true;
        if (!outs.some((e) => /是|true|yes/i.test(String(e.label ?? "")))) return true;
        if (!outs.some((e) => /否|false|no/i.test(String(e.label ?? "")))) return true;
        // 每条分支都必须有 label、目标存在;不能指向会被面板剥离到侧栏的 note/aggregate/io
        return outs.some((e) => {
          if (!String(e.label ?? "").trim()) return true;
          const t = nodes.find((n) => String(n.id) === String(e.to));
          if (!t) return true;
          const k = String(t.kind ?? "");
          if (["start", "end", "decision"].includes(k)) return false;
          if (!["note", "aggregate", "io"].includes(k)) return false;
          return /(影响|验收|风险|回滚|测试|根因)/.test(`${t.label ?? ""} ${t.group ?? ""} ${t.summary ?? ""}`);
        });
      });
      if (open.length) missing.push(`decision 出边不完整(需是/否双出口、每条 label、目标存在且不落侧栏):${open.slice(0, 4).map((d) => String(d.id)).join(",")}`);
    }
    const groups = new Set(nodes.map((n) => String(n.group ?? "").trim()).filter(Boolean));
    if (groups.size < 2) missing.push("flow 板只有一个 group:没有方法/阶段边界");
    const steps = nodes.filter((n) => ["function", "module", "io", "tool", "http"].includes(String(n.kind ?? "")));
    const withFlow = steps.filter((n) => Array.isArray(n.flow) && n.flow.length > 0);
    if (steps.length && withFlow.length / steps.length < 0.6) {
      missing.push("步骤节点缺代码级 flow 行:面板只能显示摘要,读不出代码逻辑");
    }
    return missing;
  }
  switch (boardType) {
    case "code": {
      const missing: string[] = [];
      // code 板一律是控制流程图——start(触发)→编号步骤(每步 flow 写 2~4 行代码动作)→
      // decision(「是：…」「否：…」双出口)→end(结果)。**不再有「现状/变更双泳道」免检路径**:
      // 模块清单式(code 板画成一排 module 卡 + 调用边)现在判不合规,文案点名缺什么、怎么改。
      // test 板(下方 case "test")与 page/ui/docs 等板型行为不变。
      missing.push(...flowBoardMissing(nodes, es));
      // 节点级仓库锚点:每个步骤节点自带 targets(≥1)或 symbolRef.name,且至少一项形如仓库相对路径。
      // 纯中文/纯符号名不算——读者要能一眼看出这一步动的是仓库里哪个文件。
      const steps = nodes.filter((n) => CODE_STEP_KINDS.includes(String(n.kind ?? "")));
      const noTarget = steps.filter((n) => nodeAnchors(n).length === 0);
      if (noTarget.length) {
        missing.push(`步骤节点缺 targets:读者看不出改哪个已存在的文件/符号(${noTarget.slice(0, 8).map((n) => n.id).join(",")})——补 targets=['apps/gateway/src/x.ts#symbol'] 或 symbolRef.name+file`);
      }
      const noRepoPath = steps.filter((n) => nodeAnchors(n).length > 0 && !nodeAnchors(n).some((a) => asRepoPath(a)));
      if (noRepoPath.length) {
        missing.push(`步骤节点 targets 不是仓库相对路径:纯中文描述/纯符号名读者定位不到文件(${noRepoPath.slice(0, 8).map((n) => n.id).join(",")})——写成 packages/x/src/y.ts 或 x/y.ts#symbol`);
      }
      // 节点级 change(add/modify/keep/delete):分流口径由 BoardNodeZ.change 决定。
 // §取舍:`packages/protocol/src/index.ts:937` 里 change 是
      // `z.enum([...]).default("modify")`,parse 后无法区分「显式标注」与「默认填充」——
      // 门收到的是 parse 后的 doc,所以这里退一步用宽松判定:
      //   显式非 modify(add/keep/delete) 一律算标注;change 缺失(undefined)算未标注;
      //   change="modify" 可能是默认填充 → 只要有 targets/symbolRef(已由上面两条保证),
      //   读者就能看出动的是仓库哪段现有逻辑,视为「关系已标注」,不再报错。
      // 想更严(grid 里区分显式 modify)需要 schema 侧去掉 .default() 或加显式标记位(不在本卡范围)。
      const unmarked = steps.filter((n) => !["add", "modify", "keep", "delete"].includes(String(n.change ?? "")));
      if (unmarked.length) {
        missing.push(`步骤节点未标 change:读者看不出是复用现有逻辑还是改/加/删(${unmarked.slice(0, 8).map((n) => n.id).join(",")})——写 change=keep(复用不改)/modify(改已有)/add(新增)/delete(删)`);
      }
 // :code 板画的是「现有代码/内容怎么走」,不是 agent 的实施计划。
      // 待办动作形态的节点(实现/修复/添加…且 flow 没有函数调用形)点名回炉:改画现有代码动作,
      // 实施计划留在 step.md。
      const todos = nodes.filter((n) => !/^ph-/.test(String(n.id)) && isTodoActionNode(n));
      if (todos.length) {
        missing.push(`节点是 agent 的待办动作,不是代码里存在的步骤:${todos.slice(0, 8).map((n) => `${n.id}「${String(n.label ?? n.id)}」`).join(",")}——改画现有代码动作(flow 写真实调用:fn(...) / a.b / →),或把计划留在 step.md`);
      }
      // 旧「现状/变更双泳道」降级为附加提示:只在没有 start/end(即不是 flow 形)时提示一次,
      // 不再作为通过条件——flow 形板的方法/阶段边界由 group 表达。
      const hasStartOrEnd = nodes.some((n) => ["start", "end"].includes(String(n.kind ?? "")));
      if (!hasStartOrEnd) {
        missing.push("必须是流程图(不是模块清单):补 start(触发)→步骤→decision(是/否双出口)→end;现状/变更双泳道不再是免检替代写法");
      }
 // 「白板看得懂」:板首必须有主题节点——读者看完整板要知道「这个大流程在系统里
      // 干什么用、本次开发改的是其中哪一环」。判据归一到 board-content-predicate.hasThemeNode。
      if (!hasThemeNode(nodes)) {
        missing.push("code 板缺板首主题节点:读者看完整板不知道「这个大流程在系统里是干什么用的、本次开发改的是其中哪一环」——加一个 id 以 theme 开头(或 group=主题)的节点横贯板首,summary 一句话讲清用途与本次改动在流程中的位置");
      }
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "test": {
      const missing: string[] = [];
 // 测试类型接入 code flow:带 start/end 的测试板与 code flow 同规则
      // (主线=测试执行流,被测链路逐函数展开),另加测试特有要求;六段契约仅适用于无 start/end 的旧板。
      const testIsFlow = nodes.some((n) => String(n.kind ?? "") === "start") || nodes.some((n) => String(n.kind ?? "") === "end");
      if (testIsFlow) {
        missing.push(...flowBoardMissing(nodes, es));
        if (!/(回归|regression)/i.test(text)) missing.push("缺回归锚:测试 flow 板要有回归锚(侧栏组,带可执行命令)");
        if (!/(expect|断言|toContain|toEqual|toBe\(|toHaveLength)/i.test(text)) missing.push("断言缺可判定 expect:断言 decision/步骤 flow 行要写 expect 原文");
        const caseCards = nodes.filter((n) => /^用例/i.test(String(n.label ?? "")));
        if (caseCards.length >= 3) missing.push("疑似用例卡清单层(用例A/B/C…):测试任务用一条 code flow 主线讲完,不用例卡层");
        if (missing.length) out.push(issue(missing));
        break;
      }
      if (!/(正常|边界|异常|空板|藏词|normal|boundary|exception|edge case)/i.test(text)) {
        missing.push("没有测试数据组(正常/边界/异常):不知道用哪些输入");
      }
      if (!hasKind(nodes, "decision")) missing.push("没有 decision 节点:分支覆盖不可见(测试任务用 decision 表达分支)");
      if (!/(断言|期望|通过标准|expect|assert)/i.test(text)) missing.push("没有断言/通过标准:不知道验证什么");
      if (!hasEdge(es, (e) => (e.kind ?? "call") === "verify")) {
        missing.push("没有 verify 边连被测逻辑:测试流程与被测代码脱节");
      }
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "docs": {
      const missing: string[] = [];
      const codeKinds = nodes.filter((n) => ["function", "tool", "http", "llm", "agent"].includes(String(n.kind ?? "")));
      if (codeKinds.length) {
        missing.push(`文档/PPT 板出现代码级节点 ${codeKinds.slice(0, 5).map((n) => `${n.id}[${n.kind}]`).join(",")}:内容骨架不画代码细节`);
      }
      const chapters = nodes.filter((n) => String(n.kind ?? "") === "section");
      const pages = nodes.filter((n) => String(n.kind ?? "") === "page");
 // 两层结构(先大骨架→骨架再丰富成页):章(section)≥3,
      // 每章 ≥1 个 page 子节点(contains);页总数 ≥ 章数。旧板(无 page)退回旧口径只查章数。
      if (pages.length > 0 || chapters.length >= 3) {
        if (chapters.length < 3) missing.push(`章(section)不足(${chapters.length} 个):PPT 大骨架至少 3 章`);
        if (pages.length < chapters.length) missing.push(`页(page)比章少(${pages.length} 页 / ${chapters.length} 章):大骨架要逐章丰富成页,每章至少 1 页,一页一论点`);
        for (const ch of chapters) {
          const hasPage = es.some((e) => String(e.kind ?? "") === "contains" && String(e.from) === String(ch.id) && pages.some((p) => String(p.id) === String(e.to)));
          if (!hasPage) missing.push(`章「${String(ch.label ?? ch.id)}」没有页(contains):大骨架未丰富`);
        }
      } else {
        const contentNodes = nodes.filter((n) => ["section", "page", "module"].includes(String(n.kind ?? "")));
        if (contentNodes.length < 3) missing.push(`章节/页面骨架不足(${contentNodes.length} 个):文档板至少给 3 个内容段`);
      }
      if (!hasEdge(es, (e) => (e.kind ?? "") === "data")) missing.push("没有 data 推进边:章节之间没有内容承接");
 // 体裁必答维度覆盖(通用机制):docGenre 在场时,每个必答维度都要有章/页
      // 落点(label+summary 命中维度别名);缺维度=读者的问题没被回答,点名回炉。
      // 数据驱动:新增文档体裁只需在 DOC_GENRES 加条目,这里零改动。
      const genre = opts?.docGenre ? DOC_GENRES[String(opts.docGenre)] : null;
      if (genre) {
        const nodeText = (n: BoardNodeT): string => `${String(n.label ?? "")} ${String(n.summary ?? "")} ${String(n.group ?? "")}`;
        const uncovered = genre.dimensions.filter((d) =>
          !nodes.some((n) => d.aliases.some((a) => nodeText(n).includes(a))));
        if (uncovered.length) {
          missing.push(`体裁「${genre.label}」缺必答维度:${uncovered.map((d) => `${d.label}(必答:${d.question})`).join("；")}——每个维度都要有章/页真实回答`);
        }
      }
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "ui": {
      const missing: string[] = [];
      if (docKind !== "page") missing.push(`纯 UI 板必须 docKind=page(当前 ${docKind ?? "design"}):否则不是页面结构板`);
      if (!hasKind(nodes, "page")) missing.push("缺 page 页面节点:看不出这是哪个页面");
      if (!hasKind(nodes, "section", "component")) missing.push("缺 section/component:控件/区块层级不可见");
      if (!hasEdge(es, (e) => (e.kind ?? "") === "nav" && !!String(e.label ?? "").trim())) {
        missing.push("缺带触发 label 的 nav 边:点击后跳哪/弹哪不可见");
      }
      if (!/(空态|加载|错误|禁用|权限|只读)/.test(text)) missing.push("缺空/加载/错误/禁用/权限态:只画了 happy path");
      const codeTargets = nodes.filter((n) => (Array.isArray(n.targets) && n.targets.length > 0) || String(n.symbolRef?.name ?? "").trim());
      if (codeTargets.length) {
        missing.push(`纯 UI 板不应带代码 targets/symbolRef:${codeTargets.slice(0, 5).map((n) => n.id).join(",")}`);
      }
      const logic = nodes.filter((n) => ["function", "tool", "agent", "http", "llm"].includes(String(n.kind ?? "")));
      if (logic.length) missing.push(`纯 UI 板不应有逻辑节点:${logic.slice(0, 5).map((n) => `${n.id}[${n.kind}]`).join(",")}`);
      missing.push(...multiPageFlowIssues(nodes, es));
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "ui-func": {
      const missing: string[] = [];
      if (docKind !== "page") missing.push(`UI+功能板必须 docKind=page(当前 ${docKind ?? "design"})`);
      if (!hasKind(nodes, "page")) missing.push("缺 page 页面节点");
      if (!hasKind(nodes, "section", "component")) missing.push("缺 UI section/component");
      const logicIds = new Set(nodes.filter((n) => ["function", "tool", "module", "agent", "http", "llm"].includes(String(n.kind ?? ""))).map((n) => String(n.id)));
      if (logicIds.size === 0) missing.push("缺逻辑节点(function/tool/module):UI 点完之后走哪段代码不可见");
      const uiIds = new Set(nodes.filter((n) => ["page", "section", "component", "nav"].includes(String(n.kind ?? ""))).map((n) => String(n.id)));
      if (!hasEdge(es, (e) => (e.kind ?? "") === "nav" && (uiIds.has(String(e.from)) || uiIds.has(String(e.to))) && (logicIds.has(String(e.to)) || logicIds.has(String(e.from))))) {
        missing.push("缺 UI→逻辑的 nav 边:交互与代码两张皮");
      }
      if (!hasEdge(es, (e) => ["call", "data"].includes(String(e.kind ?? "")) && (logicIds.has(String(e.from)) || logicIds.has(String(e.to))))) {
        missing.push("缺逻辑节点之间的 call/data 边:点提交后内部流程断掉");
      }
      if (!/(空态|加载|错误|禁用|权限|只读)/.test(text)) missing.push("缺五态(空/加载/错误/禁用/权限)");
      missing.push(...multiPageFlowIssues(nodes, es));
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "fault": {
      const missing: string[] = [];
      const roots = nodes.filter((n) => /根因/.test(labelText(n)));
      if (!roots.length) missing.push("没有「根因」节点:故障链推理没有落点");
      for (const r of roots) {
        if (/(预期|待定|待确认|写结论|TBD)/i.test(T(r))) {
          out.push(issue(["根因仍是占位(预期/待定/写结论):故障链必须写已锁定根因"], String(r.id), String(r.label ?? r.id)));
        }
      }
      if (!/(修复|fix)/i.test(text)) missing.push("没有修复点节点");
      if (!/(防复发|回归|regression|recur)/i.test(text)) missing.push("没有防复发/回归验证节点");
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "refactor": {
      const missing: string[] = [];
      const groups = nodes.map((n) => String(n.group ?? "")).filter(Boolean);
      if (!groups.some((g) => g.includes("现状")) || !groups.some((g) => g.includes("目标"))) {
        missing.push("缺现状/目标双泳道:双图映射不可见");
      }
      if (!hasEdge(es, (e) => /1\s*[:：]\s*1|N\s*[:：]\s*1/i.test(String(e.label ?? "")))) {
        missing.push("缺 1:1/N:1 映射边:看不出新旧节点对应关系");
      }
      if (!nodes.some((n) => /^\s*\d{1,2}[\s._-]/.test(String(n.label ?? "")))) {
        missing.push("缺顺序编号(01/02…):迁移步骤先后不可读");
      }
      if (!/(兼容|compat|窗口|回滚|rollback|revert)/i.test(text)) missing.push("缺兼容窗口或回滚点");
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "perf": {
      const missing: string[] = [];
 // perf 板与 code/test 同一套 flow 门——
      // 主形态是控制流程图(start 触发→采样与基线→定位瓶颈→改动→复测→decision(达标?)→end),
      // 3 张并列模块卡(基线/瓶颈/改动)+ 0 条边 = 模块清单式,不合格。
      // 与 code 一致:不做 grandfather,历史 perf 板同样按流程形态判。
      missing.push(...flowBoardMissing(nodes, es));
      const perfFlowForm = nodes.some((n) => ["start", "end"].includes(String(n.kind ?? "")));
      if (!perfFlowForm) {
        const isolated = nodes
          .filter((n) => ["function", "module"].includes(String(n.kind ?? "")))
          .filter((n) => !es.some((e) => String(e.from) === String(n.id) || String(e.to) === String(n.id)))
          .map((n) => String(n.id));
        missing.push(
          `必须是流程图(不是模块清单):补 start(触发:谁变慢/哪个指标超阈)→采样与基线→定位瓶颈→改动→复测→decision(达到目标?是/否)→end`
          + (isolated.length >= 3 ? `;现在是无边并列卡 ${isolated.slice(0, 6).join(",")},一个回合都没走通` : ""),
        );
      }
      if (!/(基线|baseline)/i.test(text) || !/\d+(\.\d+)?\s*(ms|毫秒|s|秒|%)/i.test(text)) {
        missing.push("缺基线指标(基线/baseline + 数字/ms):性能板要先有起跑线");
      }
      if (!/(瓶颈|profiling|profile|耗时|热点|bench)/i.test(text)) missing.push("缺瓶颈/耗时证据:不知道慢在哪");
      if (!/(目标|≤|≥|<|>|P95|P99|阈值)/i.test(text) || !/\d/.test(text)) {
        missing.push("缺目标数字阈值(≤/≥/P95 + 数字):无法判定优化是否达标");
      }
      if (!nodes.some((n) => (n.accept ?? []).some((a) => /\d/.test(String(a?.expect ?? ""))))) {
        missing.push("P0 accept 里没有数字期望:验收无法量化");
      }
      if (!/(P50|P95|P99|百分位|分位)/i.test(text)) {
        missing.push("缺百分位口径(P50/P95/P99):基线/目标只给均值判不出用户实际感受到的慢尾");
      }
      if (!/(复测|重跑|复跑|再测|re-?bench)/i.test(text)) {
        missing.push("缺复测步骤:改完要在同环境同口径上再测一组数字,不能只有改前基线");
      }
      if (!nodes.some((n) => (n.accept ?? []).some((a) => /negative/i.test(String(a?.type ?? ""))))) {
        missing.push("P0 accept 缺 negative 断言:回退/超阈/过载路径没验收(如 expect「P95 不退化 >5%」)");
      }
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "data": {
      const missing: string[] = [];
      if (!/(dry.?run|干跑)/i.test(text)) missing.push("缺 dry-run 先行:数据/迁移板必须先只报不写");
      if (!/(幂等|idempot)/i.test(text)) missing.push("缺幂等保证:重跑会不会重复写不可见");
      if (!/(脏数据|脏|部分失败|失败|异常|回滚)/i.test(text)) missing.push("缺脏数据/部分失败分支");
      if (!/(样本|文件数|\d+\s*(个|条|行|份|会话|目录|文件|张|页))/.test(text)) missing.push("缺样本量/规模数字");
      if (!/(输入|输出|清洗|转换|transform|流)/i.test(text)) missing.push("缺输入→清洗→输出数据流");
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "contract": {
      const missing: string[] = [];
      if (/(待\s*glob|待定|待确认|TBD|位置待|\(待)/i.test(text)) {
        missing.push("还有未定位/待定占位:契约板必须给全部消费者与字段落点");
      }
      if (!/(字段|schema|accept|type)/i.test(text)) missing.push("缺契约字段描述");
      if (!/(消费者|consumer|消费点)/i.test(text)) missing.push("缺消费者清单");
      if (!/(弃用|deprecat|optional|版本|version)/i.test(text)) missing.push("缺版本策略/弃用窗口");
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "deploy": {
      const missing: string[] = [];
      if (!nodes.some((n) => /(preflight|预检)/i.test(`${n.id} ${n.label} ${n.summary}`))) missing.push("缺 preflight 环境预检");
      const smoke = nodes.filter((n) => /(smoke|冒烟)/i.test(`${n.id} ${n.label} ${n.summary}`));
      if (!smoke.length) missing.push("缺 smoke 用户旅程冒烟");
      for (const s of smoke) {
        const id = String(s.id);
        if (!es.some((e) => String(e.from) === id || String(e.to) === id)) {
          out.push(issue(["smoke 节点未接线(无任何边):冒烟挂在板外,部署流程没走到"], id, String(s.label ?? id)));
        }
      }
      if (!/(回滚|rollback|降级|revert)/i.test(text)) missing.push("缺回滚/降级路径");
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "matrix":
    case "research": {
      const missing: string[] = [];
      const cands = nodes.filter((n) => /(候选|candidate)/i.test(labelText(n)));
      if (cands.length < 2) missing.push(`候选方案不足(${cands.length} 个):决策矩阵至少 2 个候选`);
      if (!/(成本|cost)/i.test(text) || !/(风险|risk)/i.test(text) || !/(可维护|维护|maintain)/i.test(text)) {
        missing.push("缺评估维度(成本/风险/可维护性)");
      }
      if (!/(证据|evidence|file:|行号)/i.test(text)) missing.push("缺每格证据来源");
      if (!/(结论|推荐|verdict|放弃)/i.test(text)) missing.push("缺结论节点(推荐/放弃理由)");
      if (!nodes.some((n) => /矩阵|matrix/i.test(T(n))) && !cands.some((n) => /(成本|风险|维护|证据)/.test(T(n)))) {
        missing.push("缺决策矩阵表达(候选×维度),现在只是流程叙述");
      }
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "orchestration": {
      const missing: string[] = [];
      if (!hasKind(nodes, "agent")) missing.push("缺 agent 节点:编排板画的是谁派谁");
      const agents = nodes.filter((n) => String(n.kind ?? "") === "agent");
      if (agents.length < 2) missing.push(`agent 节点不足(${agents.length} 个):至少 2 个角色才能画拓扑`);
      const agentIds = new Set(agents.map((n) => String(n.id)));
      if (!hasEdge(es, (e) => agentIds.has(String(e.from)) || agentIds.has(String(e.to)))) {
        missing.push("agent 之间没有 call/data 边:拓扑不连通");
      }
      if (!/(超时|timeout|失败|重试|retry|回收|task_output|deadline)/i.test(text)) {
        missing.push("缺超时/失败/重试/回收分支:编排板不能只画 happy path");
      }
      if (missing.length) out.push(issue(missing));
      break;
    }
    case "composition": {
 // 作业思路板:办公任务上板画的是「表达结构」——
      // 主题是什么、受众是谁、分几章、章与章什么关系、顺序如何;不是 todo list,也不带代码契约。
      const missing: string[] = [];
      const nodeText = (n: BoardNodeT): string => `${String(n.label ?? "")} ${String(n.summary ?? "")}`;
      const sections = nodes.filter((n) => String(n.kind ?? "") === "section");
      const sectionIds = new Set(sections.map((n) => String(n.id)));
      const sectionEdge = es.filter((e) => sectionIds.has(String(e.from)) && sectionIds.has(String(e.to)));
      const relEdge = sectionEdge.some((e) => {
        const l = String(e.label ?? "").trim();
        return COMPOSITION_RELATIONS.some((r) => l.includes(r));
      });
      if (!hasThemeNode(nodes) && !nodes.some((n) => /主题|论题|主张/.test(nodeText(n)))) {
        missing.push("作业思路板缺主题:需要一个主题节点(label 含『主题』,或 id 以 theme 开头/group=主题)或板级主题说明");
      }
      if (!nodes.some((n) => /受众|读者|面向|写给|给.{0,8}看|讲给/.test(nodeText(n)))) {
        missing.push("作业思路板缺受众:写明表达受众(如『受众:Q4 复盘读者/技术团队』)");
      }
      if (sections.length < 2 || !relEdge) {
        // 结构判据与 board-content-predicate.isCompositionStructure 同一口径(章节数+关系边),
        // 这里拆成两条文案点名具体缺哪半。
        if (sections.length < 2) {
          missing.push("作业思路板章节不足 2 章:用 node sN section 落章节");
        }
        if (!relEdge) {
          missing.push("章与章之间缺关系:用 edge s1 ->> s2 : 递进(关系词限承接/递进/并列/对照/因果)");
        }
      } else if (!isCompositionStructure(nodes, es)) {
        missing.push("作业思路板结构不成立:至少 2 个 section 且章间边 label 命中关系词(承接/递进/并列/对照/因果)");
      }
      // 顺序不新增字段:章节顺序由节点声明序表达(画布与渲染按 nodes 数组序出章),这里不额外校验。
      // 代码契约字段一律不许带(作业思路板是表达结构,不是代码契约)——节点级点名。
      for (const n of nodes) {
        const hasTargets = Array.isArray(n.targets) && n.targets.length > 0;
        const hasSymbol = !!String((n.symbolRef as { name?: string } | undefined)?.name ?? "").trim();
        const hasBefore = !!String(n.before ?? "").trim();
        if (hasTargets || hasSymbol || hasBefore) {
          out.push(issue(
            ["作业思路板是表达结构不是代码契约:节点不应带 targets/symbolRef/before"],
            String(n.id),
            String(n.label ?? n.id),
          ));
        }
      }
      if (missing.length) out.push(issue(missing));
      break;
    }
    default:
      return [];
  }
 // 新板(显式标 scale)/强制 strict:追加 通用硬规则 + 分类 ➕ 规则。
  // 旧板(无 scale)保持既有口径,避免存量板因新规突然全红;画布顶部会对缺 scale 亮黄牌。
  if (opts && (opts.strict || hasText(opts.scale))) {
    const strict = strictCommonIssues(nodes, es, boardType).concat(strictTypeIssues(nodes, es, boardType));
    if (strict.length) out.push(issue(strict));
  }
  return out;
}

/** 审计/提示用短文本(不写入板数据)。 */
export function renderTypeConformanceIssues(issues: BoardContractIssue[]): string {
  return issues.map((i) => `${i.nodeId}「${i.label}」${i.problems.join("、")}`).join("\n");
}

export function typeConformancePass(nodes: BoardNodeT[], edges: EdgeLike[] | undefined, boardType?: string, docKind?: string, opts?: TypeConformanceOpts): boolean {
  return validateBoardTypeConformance(nodes, edges, boardType, docKind, opts).length === 0;
}

/** 调试:返回板型门摘要(用于审计 JSON 的 typeIssues 行)。 */
export function typeConformanceLines(nodes: BoardNodeT[], edges: EdgeLike[] | undefined, boardType?: string, docKind?: string, opts?: TypeConformanceOpts): string[] {
  return validateBoardTypeConformance(nodes, edges, boardType, docKind, opts).map((i) =>
    `${i.nodeId}「${i.label}」${i.problems.join("、")}`,
  );
}

