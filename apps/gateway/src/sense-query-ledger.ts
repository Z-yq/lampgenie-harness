/**
 * 改前链路台账:记录本任务的 code_sense 结构面查询,
 * 供 sense-edit-guard 判定「改这个文件前查没查过它的链路」。每任务一个实例(闭包),不跨任务共享。
 * 覆盖判定(确定性,零索引):
 * - file/vars/branches/flow:target 归一后与文件相对路径相等(或互为后缀,容忍根收窄前缀);
 * - symbol/impact/radiation:target 符号名以**词边界**命中文件内容(子串不算,防 gate 误匹配 gatePolicy);
 * - refs/surface 等字面量/概念面不计入符号覆盖(语义不同),只记录。
 */
export interface SenseQuery {
  action: string;
  target: string;
}

export interface SenseQueryLedger {
  record(action: string, target: string): void;
  coversFile(rel: string, fileContent: string): boolean;
  queries(): readonly SenseQuery[];
}

const FILE_ACTIONS = new Set(["file", "vars", "branches", "flow"]);
const SYMBOL_ACTIONS = new Set(["symbol", "impact", "radiation"]);

const norm = (s: string): string => String(s ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();

export function createSenseQueryLedger(): SenseQueryLedger {
  const qs: SenseQuery[] = [];
  return {
    record(action: string, target: string): void {
      const a = String(action ?? "").trim();
      const t = norm(target);
      if (a && t) qs.push({ action: a, target: t });
    },
    coversFile(rel: string, fileContent: string): boolean {
      const r = norm(rel);
      if (!r) return false;
      const content = String(fileContent ?? "");
      for (const q of qs) {
        if (FILE_ACTIONS.has(q.action)) {
          if (q.target === r || r.endsWith("/" + q.target) || q.target.endsWith("/" + r)) return true;
        } else if (SYMBOL_ACTIONS.has(q.action) && q.target) {
          const esc = q.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`);
          if (re.test(content)) return true;
        }
      }
      return false;
    },
    queries(): readonly SenseQuery[] {
      return qs;
    },
  };
}
