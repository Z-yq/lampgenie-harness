/**
 * 评论定位(定位思想参考 alibaba open-code-review 的 diff/resolver,Apache-2.0,致谢;TS 独立实现):
 * 滑动窗口匹配 existing_code → 跨文件重定位 → fallback 首行 → (LLM 重定位可选第四级)。
 * 解决「模型给的锚点如何可信地变成行号」(Position drift)。
 */

export interface HunkLine { oldLine: number; newLine: number; text: string }
export interface DiffHunk { file: string; newStart: number; lines: HunkLine[] }

/** 解析单个文件的 unified diff 为 hunk(new 侧行号)。 */
export function parseHunks(diffText: string, file: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldLn = 0, newLn = 0;
  for (const line of diffText.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      if (cur) hunks.push(cur);
      newLn = Number(h[1]!);
      oldLn = 0;
      cur = { file, newStart: newLn, lines: [] };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) {
      cur.lines.push({ oldLine: 0, newLine: newLn, text: line.slice(1) });
      newLn++;
    } else if (line.startsWith("-")) {
      oldLn++;
    } else if (line.startsWith(" ") || line === "") {
      newLn++; oldLn++;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/** 滑动窗口:在 hunk 新侧找与 anchorText 连续匹配的起始行(ocr matchConsecutive)。 */
export function resolveByAnchor(hunks: DiffHunk[], anchorText: string): { line: number; matched: string } | null {
  // 保留中间空行(它们参与连续性);只去首尾空行。
  const anchorLines = anchorText.split("\n").map((l) => l.trim());
  while (anchorLines.length && anchorLines[0] === "") anchorLines.shift();
  while (anchorLines.length && anchorLines[anchorLines.length - 1] === "") anchorLines.pop();
  if (anchorLines.length === 0) return null;
  for (const hunk of hunks) {
    const lines = hunk.lines.map((l) => l.text.trim());
    for (let i = 0; i + anchorLines.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < anchorLines.length; j++) {
        if (lines[i + j] !== anchorLines[j]) { ok = false; break; }
      }
      if (ok) {
        return { line: hunk.lines[i]!.newLine, matched: anchorLines[0]!.slice(0, 60) };
      }
    }
  }
  return null;
}

export interface LocatedFinding {
  file: string;
  line: number;
  resolution: "anchor" | "refile" | "fallback" | "llm" | "unresolved";
}

/** LLM 重定位回调(第四级,纯 opt-in):入参=定位失败的 finding 与候选文件摘要;返回建议位置。 */
export type LlmRelocate = (
  finding: { file: string; anchorText: string; fallbackLine: number },
  files: { path: string; snippet: string }[],
) => Promise<{ path: string; line: number; confidence: number } | null>;

export interface LocateOpts {
  llmRelocate?: LlmRelocate;
}

/**
 * 三级降级+可选第四级:①锚点匹配本文件 ②跨文件(锚点其实在另一个 diff 文件里)
 * ③fallback 模型行号在 diff 范围内 ④LLM 重定位(需 confidence>=0.5 且 path 在候选集内)。
 * 未注入 llmRelocate 时行为与三档版完全一致(同步返回)。
 */
export function locateFinding(
  anchor: { file: string; anchorText: string; fallbackLine: number },
  filesDiffs: { path: string; diffText: string }[],
  opts: LocateOpts = {},
): LocatedFinding | Promise<LocatedFinding> {
  const own = filesDiffs.find((f) => f.path === anchor.file);
  if (own) {
    const r = resolveByAnchor(parseHunks(own.diffText, anchor.file), anchor.anchorText);
    if (r) return { file: anchor.file, line: r.line, resolution: "anchor" };
  }
  // 跨文件:锚点可能在其他变更文件
  for (const f of filesDiffs) {
    if (f.path === anchor.file) continue;
    const r = resolveByAnchor(parseHunks(f.diffText, f.path), anchor.anchorText);
    if (r) return { file: f.path, line: r.line, resolution: "refile" };
  }
  // fallback:模型给的行号在 diff 范围内则用,否则文件级(行 1)+ unresolved 标注
  const inRange = own && parseHunks(own.diffText, anchor.file)
    .some((h) => anchor.fallbackLine >= h.newStart && anchor.fallbackLine <= h.newStart + h.lines.length);
  if (inRange) return { file: anchor.file, line: anchor.fallbackLine, resolution: "fallback" };

  // 第四级:LLM 重定位(纯 opt-in)。三闸:confidence>=0.5、path 在候选集、line>=1。
  const rel = opts.llmRelocate;
  if (!rel) return { file: anchor.file, line: 1, resolution: "unresolved" };
  return (async (): Promise<LocatedFinding> => {
    try {
      const r = await rel(
        { file: anchor.file, anchorText: anchor.anchorText, fallbackLine: anchor.fallbackLine },
        filesDiffs.map((f) => ({ path: f.path, snippet: f.diffText.slice(0, 2000) })),
      );
      if (
        r &&
        filesDiffs.some((f) => f.path === r.path) &&
        Number.isFinite(r.confidence) && r.confidence >= 0.5 &&
        Number.isFinite(r.line) && r.line >= 1
      ) {
        return { file: r.path, line: Math.trunc(r.line), resolution: "llm" };
      }
    } catch {
      /* LLM 失败=保持未定位(诚实),不冒充成功 */
    }
    return { file: anchor.file, line: 1, resolution: "unresolved" };
  })();
}
