/**
 * 括号深度扫描器(Go/Java 结构 adapter 共用,designs/16 §5 二期多语言)。
 * 逐行喂入,返回剥离字符串/注释后的代码文本与累计深度——
 * 字符串/字符/反引号原始串/行注释/块注释内的 { } 不计深度
 * (误计是括号栈解析器产生假符号的经典来源,fixture 专项覆盖)。
 */
export interface BraceTracker {
  /** 当前累计深度。 */
  readonly depth: number;
  /** 喂入一行;code=剥离字符串内容与注释后的代码(括号保留),depth=该行处理完成后的累计深度。 */
  feed(line: string): { code: string; depth: number };
}

export function createBraceTracker(): BraceTracker {
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null; // 跨行(反引号原始串/未闭合块注释)状态跨 feed 保持
  let inBlock = false;

  return {
    get depth(): number {
      return depth;
    },
    feed(line: string): { code: string; depth: number } {
      let out = "";
      let i = 0;
      while (i < line.length) {
        const ch = line[i]!;
        const next = line[i + 1];
        if (inStr) {
          if (inStr === "`") {
            // 原始串:无转义概念(Go backtick),只认闭引号
            if (ch === "`") inStr = null;
            i++;
            continue;
          }
          // 普通串/字符:转义吃两字符(行尾截断则下一行从串内继续——与真实语法一致)
          if (ch === "\\") {
            i += 2;
            continue;
          }
          if (ch === inStr) inStr = null;
          i++;
          continue;
        }
        if (inBlock) {
          if (ch === "*" && next === "/") {
            inBlock = false;
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        // 普通代码态
        if (ch === "/" && next === "/") break; // 行注释:到行尾(跨行状态无需保持)
        if (ch === "/" && next === "*") {
          inBlock = true;
          i += 2;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
          i++;
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth = Math.max(0, depth - 1); // 散落闭括号不打出负深度
        out += ch;
        i++;
      }
      return { code: out, depth };
    },
  };
}

/** 顶层分隔符切分(括号/方括号/花括号内的分隔符不切)——Go/Java 参数列表解析共用。 */
export function splitTopLevel(s: string, sep = ","): string[] {
  const out: string[] = [];
  let cur = "";
  let paren = 0, brack = 0, brace = 0;
  for (const ch of s) {
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") brack++;
    else if (ch === "]") brack--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    if (ch === sep && paren === 0 && brack === 0 && brace === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
