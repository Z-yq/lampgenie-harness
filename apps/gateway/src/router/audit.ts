/**
 * audit:append-only jsonl 落账 + 无凭证断言 + accept 缺 intent_evidence → ignore 不 throw。
 * 落 .genie/router/audit.jsonl;每行一个 disposition/决策快照。
 * 凭证字段(verificationToken/encryptKey 等)一律不得入账——assertNoCredential 拒绝写。
 */
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditRecord {
  at: number;
  triggerId: string;
  outcome: string;
  [k: string]: unknown;
}

const CREDENTIAL_KEYS = ["token", "secret", "password", "credential", "credentialref", "encryptkey", "verificationtoken", "apikey", "api_key"];

/** 无凭证断言:递归查 key(小写含匹配),命中即抛(不写盘)。 */
export function assertNoCredential(record: unknown, prefix = ""): void {
  if (record === null || typeof record !== "object") return;
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.some((c) => k.toLowerCase().includes(c))) {
      throw new Error(`audit 记录含凭证字段:${prefix}${k}(audit.jsonl 无凭证落账纪律)`);
    }
    assertNoCredential(v, prefix + k + ".");
  }
}

export interface AuditLog {
  append(record: AuditRecord): void;
  readAll(): AuditRecord[];
}

/** 最小 IO 面(结构化签名,测试可注入内存实现)。 */
export interface AuditIo {
  mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
  appendFileSync?: (p: string, data: string, enc: string) => void;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string, enc: string) => string;
}

export function createAuditLog(path: string, io?: AuditIo): AuditLog {
  const m = io?.mkdirSync ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const a = io?.appendFileSync ?? ((p: string, d: string, _e: string) => appendFileSync(p, d, "utf8"));
  const e = io?.existsSync ?? existsSync;
  const r = io?.readFileSync ?? ((p: string, _enc: string) => readFileSync(p, "utf8"));
  const records: AuditRecord[] = [];
  if (e(path)) {
    try {
      for (const line of r(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line) as AuditRecord); } catch { /* 脏行跳过(append-only 容错) */ }
      }
    } catch { /* 读失败=空账本重开 */ }
  }
  return {
    append(record) {
      assertNoCredential(record);
      m(dirname(path), { recursive: true });
      a(path, JSON.stringify(record) + "\n", "utf8");
      records.push(record);
    },
    readAll() { return [...records]; },
  };
}

/** accept 决策缺 intent_evidence → 降级 ignore(不 throw;缺证据不拦截,静默降级)。 */
export function settleAccept(input: { decision: "accept" | "ignore"; intent_evidence?: string | null }): { kind: "accept" | "ignore"; reason?: string } {
  if (input.decision !== "accept") return { kind: "ignore", reason: "decision-ignore" };
  if (!input.intent_evidence) return { kind: "ignore", reason: "missing-intent-evidence" };
  return { kind: "accept" };
}
