/**
 * 按需下钻的**确定性打分**(零 LLM)。
 * 问题:把 40 个模块页全量注入是浪费(任务通常只碰 1–3 个模块),但「该下钻哪个」不该交给模型猜。
 * 做法:`world --rebuild` 时把「模块 × (职责/目录/文件名/符号名)」的语料落成小文件 `drill.json`,
 * 查询时对一个任务文本或一组改动文件做**词面打分**,只返回 top-1..3 个模块页。
 * 打分口径(全部确定性、可复现,同输入同输出):
 * 文件输入:直接命中该文件所属模块 +20
 * 模块名:任务文本里出现完整模块名 +10;模块名的某一段与任务词相等 +6
 * 目录段:模块下二级目录名与任务词相等 +3(每模块最多计 3 个)
 * 文件名:文件主名(去扩展名,≥4 字符)出现在任务文本 +3(最多 3 个)
 * 符号名:模块内热点符号名出现在任务文本 +4(最多 3 个,大小写敏感)
 * 职责文本:中英词面命中 +1/词(最多 3 分)
 * 排序:分数降序 → 模块名字典序(码元序,不受 locale 影响)。零分不返回。
 */
import type { C2fIndex } from "../callgraph/c2f.js";
import { moduleGroupOf } from "../callgraph/modview.js";
import { moduleAnnotationText, moduleNotes, type ModuleNote } from "../callgraph/module-notes.js";
import type { CodeFlow } from "../callgraph/flow.js";

/** 下钻语料里的单个模块条目(落盘 drill.json,不进注入面)。 */
export interface DrillModule {
  name: string;
  slug: string;
 /** 一句职责(确定性来源;缺失=无职责线索)。 */
  note?: string;
 /** 模块下的目录前缀(≤12,按文件数降序)。 */
  dirs: string[];
 /** 文件主名(去扩展名、去重,≤40)。 */
  files: string[];
 /** 热点符号名(按出入度降序去重,≤40)。 */
  symbols: string[];
}

export interface DrillCorpus {
  version: 1;
 /** 与 world 产物同代(索引 builtAt)。 */
  indexBuiltAt: number;
  modules: DrillModule[];
}

export interface ModuleHit {
  module: string;
  slug: string;
  score: number;
 /** 命中理由(人读;≤6 条)。 */
  hits: string[];
}

/** 码元序比较(与 locale 无关,保证逐字节可复现)。 */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqCap(xs: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (x.length === 0 || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= cap) break;
  }
  return out;
}

/** 文件主名:last segment 去扩展名(panel.ts → panel;apps/gateway/src/cli.ts → cli)。 */
export function fileStem(file: string): string {
  const base = file.split("/").pop() ?? file;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 构建下钻语料。`modules` 给定时只产这些模块(通常与 L1 页表一致);不给则按索引全量分组。
 * `flow` 可选:给了才能取到职责文本(moduleNotes 需要模块级 CodeFlow)。
 */
export function buildDrillCorpus(idx: C2fIndex, modules?: string[], flow?: CodeFlow): DrillCorpus {
  const filesByModule = new Map<string, string[]>();
  for (const file of Object.keys(idx.byFile)) {
    const g = moduleGroupOf(file);
    let arr = filesByModule.get(g);
    if (!arr) {
      arr = [];
      filesByModule.set(g, arr);
    }
    arr.push(file);
  }
  const wanted = modules ?? [...filesByModule.keys()].sort(cmpStr);

 // 每文件的热点符号(按出入度)与模块级符号表
  const rankByFile = new Map<string, { name: string; rank: number }[]>();
  for (const n of idx.nodes) {
    let arr = rankByFile.get(n.file);
    if (!arr) {
      arr = [];
      rankByFile.set(n.file, arr);
    }
    arr.push({ name: n.name, rank: (n.inCount ?? 0) + (n.outCount ?? 0) });
  }
  for (const arr of rankByFile.values()) arr.sort((a, b) => b.rank - a.rank || cmpStr(a.name, b.name));

  const notes: Record<string, ModuleNote> = flow ? moduleNotes(idx.root, flow) : {};

  const out: DrillModule[] = [];
  for (const name of wanted) {
    const files = filesByModule.get(name) ?? [];
    const dirCounter = new Map<string, number>();
    const prefixSegs = name.split("/").length;
    for (const f of files) {
      const segs = f.split("/");
 // 模块路径前缀之后、文件名之前的**所有**目录段都算词面信号(校准:
 // 只取紧邻模块名的那一段,21 个模块里绝大多数只产出 "src",对下钻毫无区分度)。
      for (const seg of segs.slice(prefixSegs, -1)) {
        if (seg.length >= 3) dirCounter.set(seg, (dirCounter.get(seg) ?? 0) + 1);
      }
    }
    const dirs = [...dirCounter.entries()]
      .sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))
      .map(([d]) => d)
      .slice(0, 24);
    const symbols = uniqCap(
      files.flatMap((f) => (rankByFile.get(f) ?? []).map((s) => s.name)),
      40,
    );
    const note = notes[name];
    out.push({
      name,
      slug: name.replace(/[^A-Za-z0-9._-]+/g, "__").replace(/^__+|__+$/g, "") || "_root",
      note: note ? moduleAnnotationText(note) : undefined,
      dirs,
 // 文件名**不封顶**(校准:封 40 个时 gateway 的 923 个文件只留前 40 个字母序,
 // 真被点名的 canvas-shell.js 常常不在里面 → 下钻假零命中)。语料是机器面(不注入),
 // 全量文件名总代价约几十 KB,换来「点到哪个文件就命中哪个模块」。
      files: uniqCap(files.map(fileStem), 4000),
      symbols,
    });
  }
  return { version: 1, indexBuiltAt: idx.builtAt, modules: out };
}

/** 任务文本 → 词表(英文/数字按词切;CJK 连续段补 2-gram,避免中文长句整段无法匹配)。 */
export function tokenizeTask(text: string): string[] {
  const out: string[] = [];
  const ascii = text.match(/[A-Za-z][A-Za-z0-9_.-]{1,}/g) ?? [];
  for (const a of ascii) {
    out.push(a, a.toLowerCase());
 // `canvas-shell.js` 这类「带扩展名/连字符」的写法要能对上文件名主名 canvas-shell:
 // 拆出去扩展名的本体、以及各段(校准:不拆时真点名的文件也判零命中)
    const noExt = a.replace(/\.[A-Za-z][A-Za-z0-9]{0,9}$/, "");
    if (noExt !== a) out.push(noExt, noExt.toLowerCase());
    for (const part of a.split(/[._-]+/)) if (part.length >= 2) out.push(part, part.toLowerCase());
  }
  const cjkRuns = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length <= 4) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return [...new Set(out)];
}

/** 归一:去连字符/下划线/点并小写(code-sense-cli → codesensecli),用于「codesense ↔ code-sense-cli」。 */
function normToken(s: string): string {
  return s.toLowerCase().replace(/[._-]+/g, "");
}

/**
 * 选择下钻模块:任务文本 + 可选改动文件 → 打分 top-N。
 * 零分模块不返回;`max` 缺省 3。
 */
export function selectModules(
  corpus: DrillCorpus,
  query: { text?: string; files?: string[] },
  opts: { max?: number } = {},
): ModuleHit[] {
  const max = opts.max ?? 3;
  const text = (query.text ?? "").trim();
  const tokens = text ? tokenizeTask(text) : [];
  const lowerText = text.toLowerCase();
  const tokenSet = new Set(tokens);
  const fileModules = new Map<string, string>();
  for (const m of corpus.modules) for (const d of m.dirs) fileModules.set(d, m.name); // 目录→模块(粗粒度,备用)

  const hits: ModuleHit[] = [];
  for (const m of corpus.modules) {
    let score = 0;
    const why: string[] = [];

    for (const f of query.files ?? []) {
      const rel = f.replace(/^\.\//, "").replace(/\\/g, "/");
      if (moduleGroupOf(rel) === m.name) {
        score += 20;
        why.push(`file:${rel}`);
      }
    }

    if (text.length > 0) {
      if (text.includes(m.name)) {
        score += 10;
        why.push(`name:${m.name}`);
      } else {
        const segs = m.name.split("/").filter((s) => s.length >= 2);
        const normSegs = segs.map(normToken);
        let segHit = "";
        for (const s of segs) {
          if (tokenSet.has(s)) {
            segHit = s;
            break;
          }
        }
        if (segHit === "") {
 // 「codesense」这种去连字符写法 ↔ 「code-sense-cli」段名:归一后再判包含
          for (let i = 0; i < normSegs.length && segHit === ""; i++) {
            const ns = normSegs[i]!;
            if (ns.length < 4) continue;
            for (const t of tokens) {
              const nt = normToken(t);
              if (nt.length >= 4 && (ns.includes(nt) || nt.includes(ns))) {
                segHit = `${t}≈${segs[i]}`;
                break;
              }
            }
          }
        }
        if (segHit !== "") {
          score += 6;
          why.push(`seg:${segHit}`);
        }
      }
      let dirHits = 0;
      for (const d of m.dirs) {
        if (d.length >= 3 && tokenSet.has(d) && dirHits < 3) {
          score += 3;
          dirHits++;
          why.push(`dir:${d}`);
        }
      }
      let fileHits = 0;
      for (const f of m.files) {
        if (f.length >= 4 && tokenSet.has(f) && fileHits < 3) {
          score += 5;
          fileHits++;
          why.push(`stem:${f}`);
        }
      }
      let symHits = 0;
      for (const s of m.symbols) {
        if (s.length >= 4 && text.includes(s) && symHits < 3) {
          score += 4;
          symHits++;
          why.push(`sym:${s}`);
        }
      }
      if (m.note) {
        const noteLower = m.note.toLowerCase();
        let noteHits = 0;
        for (const t of tokens) {
          if (t.length < 2 || noteHits >= 3) continue;
          if (noteLower.includes(t.toLowerCase()) || (t.length >= 2 && m.note.includes(t))) {
            score += 1;
            noteHits++;
            why.push(`note:${t}`);
          }
          void lowerText;
        }
      }
    }

    if (score > 0) hits.push({ module: m.name, slug: m.slug, score, hits: uniqCap(why, 6) });
  }
  hits.sort((a, b) => b.score - a.score || cmpStr(a.module, b.module));
  return hits.slice(0, max);
}
