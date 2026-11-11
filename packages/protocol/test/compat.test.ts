/**
 *  协议/数据兼容:封闭兼容登记表 + 读侧归一/投影助手。
 * 锁住七条面(白板 n1/n4 的 accept):
 * A) 窗口内 legacy → canonical + deprecated + dual-read
 * B) 窗口后 → phase=sunset(码仍是 canonical)
 * C) 老客户端(clientContractVersion<2 或缺失)窗口内投影回 legacy 原文
 * D) 新客户端(>=2)→ canonical
 * E) 未登记码原样 passthrough(不被任何归一/投影改写)
 * F) 登记表自检 0 issues;坏表逐条命中且 issues 确定性排序
 * G) 不可变/确定性:表与返回结构全部冻结,同 now 同输出
 * 时间一律注入固定 ISO 串(`now`),不打桩系统时钟 —— 本模块自己不读 Date.now,
 * 所以「窗口内/窗口后」的结论永不过期(除了 assertCompatRegistry 的 status 一致性检查本身就以 now 为参)。
 */
import { describe, it, expect } from "vitest";
import {
  COMPAT_WINDOWS,
  CANONICAL_CONTRACT_VERSION,
  ERROR_CODE_VALUES,
  ErrorCode,
  resolveErrorCodeCompat,
  projectErrorCodeForClient,
  assertCompatRegistry,
  assertCompatEntries,
  describeCompatWindow,
  type CompatWindowEntry,
} from "../src/index.js";

const SINCE = "2026-11-09";
const SUNSET = "2027-05-09";
/** 窗口内(双读期)。 */
const IN_WINDOW = "2026-11-10T00:00:00.000Z";
/** 正好压在下线日零点(=已下线:比较用 >=)。 */
const AT_SUNSET = SUNSET + "T00:00:00.000Z";
/** 明显在窗口之后。 */
const AFTER_SUNSET = "2027-06-01T00:00:00.000Z";

const LEGACY_OK = "companion-failed";
const CANON_OK = "super-failed";
const LEGACY_ANNOUNCE = "companion-announce-failed";
const CANON_ANNOUNCE = "super-announce-failed";

const entry = (legacy: string) => {
  const found = COMPAT_WINDOWS.find((e) => e.legacy === legacy);
  if (!found) throw new Error("登记表缺条目:" + legacy);
  return found;
};

describe("封闭兼容登记表 COMPAT_WINDOWS", () => {
  it("①两条 legacy→canonical 映射逐字正确,窗口字段齐备(YYYY-MM-DD)", () => {
    expect(COMPAT_WINDOWS.length).toBeGreaterThanOrEqual(2);
    expect(entry(LEGACY_OK).canonical).toBe(CANON_OK);
    expect(entry(LEGACY_ANNOUNCE).canonical).toBe(CANON_ANNOUNCE);
    for (const e of COMPAT_WINDOWS) {
      expect(e.since).toBe(SINCE);
      expect(e.sunsetAt).toBe(SUNSET);
 // 机器可读日期:YYYY-MM-DD
      expect(e.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.sunsetAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Date.parse(e.sunsetAt)).toBeGreaterThan(Date.parse(e.since));
      expect(e.reason.length).toBeGreaterThan(4);
      expect(["dual-read", "sunset"]).toContain(e.status);
    }
 // canonical 必须是 ErrorCode 里真实存在的值(登记表不许发明新码)
    const values = ERROR_CODE_VALUES as readonly string[];
    for (const e of COMPAT_WINDOWS) expect(values).toContain(e.canonical);
  });

  it("②表与每一项都不可变(冻结;严格模式下写入抛 TypeError)", () => {
    expect(Object.isFrozen(COMPAT_WINDOWS)).toBe(true);
    for (const e of COMPAT_WINDOWS) expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (COMPAT_WINDOWS as unknown as CompatWindowEntry[])[0] = entry(LEGACY_OK);
    }).toThrow();
    expect(() => {
      (entry(LEGACY_OK) as unknown as { canonical: string }).canonical = "tampered";
    }).toThrow();
    expect(entry(LEGACY_OK).canonical).toBe(CANON_OK);
  });
});

describe("resolveErrorCodeCompat:读侧归一", () => {
  it("A) 窗口内 legacy → canonical + deprecated=true + phase=dual-read(带 sunsetAt/reason)", () => {
    const r = resolveErrorCodeCompat(LEGACY_OK, { now: IN_WINDOW });
    expect(r.code).toBe(CANON_OK);
    expect(r.deprecated).toBe(true);
    expect(r.phase).toBe("dual-read");
    expect(r.sunsetAt).toBe(SUNSET);
    expect(r.reason).toContain("super");
 // 两条 legacy 各自归一到自己的 canonical
    expect(resolveErrorCodeCompat(LEGACY_ANNOUNCE, { now: IN_WINDOW }).code).toBe(CANON_ANNOUNCE);
  });

  it("B) 窗口后 → phase=sunset,码仍是 canonical(不再区分客户端)", () => {
    const r = resolveErrorCodeCompat(LEGACY_OK, { now: AFTER_SUNSET });
    expect(r.code).toBe(CANON_OK);
    expect(r.phase).toBe("sunset");
    expect(r.deprecated).toBe(true);
  });

  it("B') 边界:now 正好等于 sunsetAt 即判下线(>=);since 当天与之前都还在双读", () => {
    expect(resolveErrorCodeCompat(LEGACY_OK, { now: AT_SUNSET }).phase).toBe("sunset");
    expect(resolveErrorCodeCompat(LEGACY_OK, { now: SINCE + "T00:00:00.000Z" }).phase).toBe("dual-read");
    expect(resolveErrorCodeCompat(LEGACY_OK, { now: "2026-11-01T00:00:00.000Z" }).phase).toBe("dual-read");
  });

  it("E) 未登记码原样:普通码/canonical 本身/任意未知串都 active+deprecated=false", () => {
    for (const code of ["board-invalid", CANON_OK, CANON_ANNOUNCE, "legacy-unlisted-code", "custom_command_reserved_name"]) {
      const r = resolveErrorCodeCompat(code, { now: IN_WINDOW });
      expect(r.code, code).toBe(code);
      expect(r.deprecated, code).toBe(false);
      expect(r.phase, code).toBe("active");
      expect(r.sunsetAt, code).toBeUndefined();
      expect(r.reason, code).toBeUndefined();
    }
  });

  it("E') 不 throw:null/undefined/数字/空串都收敛(空串原样 active,数字被 toCode 成字符串)", () => {
    const weird = [null, undefined, 123, "", "  "] as unknown as string[];
    for (const input of weird) {
      expect(() => resolveErrorCodeCompat(input)).not.toThrow();
    }
    expect(resolveErrorCodeCompat(undefined as unknown as string).code).toBe("");
    expect(resolveErrorCodeCompat(123 as unknown as string).code).toBe("123");
    expect(resolveErrorCodeCompat(undefined as unknown as string).phase).toBe("active");
 // now 不可解析 → 按窗口内处理(码仍归一到 canonical,不回落 legacy;phase 不谎报已下线)
    expect(resolveErrorCodeCompat(LEGACY_OK, { now: "not-a-date" }).phase).toBe("dual-read");
  });

  it("G') 确定性 + 结果冻结:同输入两次逐字相等,返回对象不可写", () => {
    const a = resolveErrorCodeCompat(LEGACY_OK, { now: IN_WINDOW });
    const b = resolveErrorCodeCompat(LEGACY_OK, { now: IN_WINDOW });
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { code: string }).code = "tampered";
    }).toThrow();
 // now 接受 Date / 数字时间戳 / ISO 串三种形态,结论一致
    const byDate = resolveErrorCodeCompat(LEGACY_OK, { now: new Date(IN_WINDOW) });
    const byMs = resolveErrorCodeCompat(LEGACY_OK, { now: Date.parse(IN_WINDOW) });
    expect(byDate).toEqual(a);
    expect(byMs).toEqual(a);
  });
});

describe("projectErrorCodeForClient:按客户端契约版本投影", () => {
  it("C) 老客户端(contractVersion<2 或缺失)窗口内回 legacy 原文", () => {
    for (const version of [1, 0, -1, undefined, null]) {
      const out = projectErrorCodeForClient(LEGACY_OK, { clientContractVersion: version as never, now: IN_WINDOW });
      expect(out, String(version)).toBe(LEGACY_OK);
    }
    expect(projectErrorCodeForClient(LEGACY_ANNOUNCE, { clientContractVersion: 1, now: IN_WINDOW })).toBe(LEGACY_ANNOUNCE);
  });

  it("D) 新客户端(>= CANONICAL_CONTRACT_VERSION)与窗口后一律 canonical", () => {
    expect(CANONICAL_CONTRACT_VERSION).toBe(2);
    expect(projectErrorCodeForClient(LEGACY_OK, { clientContractVersion: 2, now: IN_WINDOW })).toBe(CANON_OK);
    expect(projectErrorCodeForClient(LEGACY_OK, { clientContractVersion: 9, now: IN_WINDOW })).toBe(CANON_OK);
 // 窗口后:老客户端也拿 canonical(旧码不再下发)
    expect(projectErrorCodeForClient(LEGACY_OK, { clientContractVersion: 1, now: AFTER_SUNSET })).toBe(CANON_OK);
    expect(projectErrorCodeForClient(LEGACY_OK, { now: AFTER_SUNSET })).toBe(CANON_OK);
  });

  it("D') 反向投影:服务端已改发 canonical 时,窗口内老客户端降回 legacy(升级不炸旧面板)", () => {
    expect(projectErrorCodeForClient(CANON_OK, { clientContractVersion: 1, now: IN_WINDOW })).toBe(LEGACY_OK);
    expect(projectErrorCodeForClient(CANON_ANNOUNCE, { clientContractVersion: 1, now: IN_WINDOW })).toBe(LEGACY_ANNOUNCE);
    expect(projectErrorCodeForClient(CANON_OK, { clientContractVersion: 2, now: IN_WINDOW })).toBe(CANON_OK);
  });

  it("E'') 未登记码原样透传,且不 throw、同输入同输出", () => {
    for (const code of ["board-invalid", "legacy-unlisted-code", ""]) {
      expect(projectErrorCodeForClient(code, { clientContractVersion: 1, now: IN_WINDOW })).toBe(code);
      expect(projectErrorCodeForClient(code, { now: AFTER_SUNSET })).toBe(code);
    }
    expect(() => projectErrorCodeForClient(undefined as unknown as string, { now: IN_WINDOW })).not.toThrow();
    const one = projectErrorCodeForClient(LEGACY_OK, { clientContractVersion: 1, now: IN_WINDOW });
    const two = projectErrorCodeForClient(LEGACY_OK, { clientContractVersion: 1, now: IN_WINDOW });
    expect(one).toBe(two);
  });
});

describe("assertCompatRegistry:登记表自检", () => {
  it("F) 真实登记表在窗口内 0 issues(ok=true)", () => {
    const report = assertCompatRegistry(ERROR_CODE_VALUES, { now: IN_WINDOW });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("F') canonical 不在 ErrorCode 值集合里 → 逐条点名", () => {
    const withoutCanon = (ERROR_CODE_VALUES as readonly string[]).filter((v) => v !== CANON_OK);
    const report = assertCompatRegistry(withoutCanon, { now: IN_WINDOW });
    expect(report.ok).toBe(false);
    expect(report.issues).toContain("canonical not in ErrorCode values: " + CANON_OK + " (legacy " + LEGACY_OK + ")");
 // 另一条 canonical 仍在集合里,不该被误报
    expect(report.issues.some((i) => i.includes(CANON_ANNOUNCE))).toBe(false);
  });

  it("F'') status 与时间一致:窗口过完而表还写 dual-read → 点名", () => {
    const report = assertCompatRegistry(ERROR_CODE_VALUES, { now: AFTER_SUNSET });
    expect(report.ok).toBe(false);
    expect(report.issues.length).toBe(COMPAT_WINDOWS.length);
    for (const issue of report.issues) expect(issue).toContain("declared dual-read but sunsetAt");
 // 表改成 sunset 后同一时刻即 0 issues
    const retired = COMPAT_WINDOWS.map((e) => ({ ...e, status: "sunset" as const }));
    expect(assertCompatEntries(retired, ERROR_CODE_VALUES, { now: AFTER_SUNSET }).issues).toEqual([]);
 // 反过来:声明 sunset 但还没到下线日 → 也点名
    const early = assertCompatEntries(retired, ERROR_CODE_VALUES, { now: IN_WINDOW });
    expect(early.ok).toBe(false);
    expect(early.issues.every((i) => i.includes("declared sunset but sunsetAt"))).toBe(true);
  });

  it("F''') 坏表逐条命中:重复 legacy / sunsetAt<=since / 空 reason / canonical 是别名 / 日期不可解析", () => {
    const base = entry(LEGACY_OK);
    const other = entry(LEGACY_ANNOUNCE);
    const bad: CompatWindowEntry[] = [
      { ...base, sunsetAt: SINCE },
      { ...base, reason: "   " },
      { ...base, canonical: LEGACY_ANNOUNCE },
      { ...base, since: "not-a-date" },
      { ...base, status: "retired" as unknown as CompatWindowEntry["status"] },
      base,
      other,
    ];
    const report = assertCompatEntries(bad, ERROR_CODE_VALUES, { now: IN_WINDOW });
    expect(report.ok).toBe(false);
    expect(report.issues).toContain("duplicate legacy: " + LEGACY_OK);
    expect(report.issues).toContain("sunsetAt not after since: " + LEGACY_OK);
    expect(report.issues).toContain("empty reason: " + LEGACY_OK);
    expect(report.issues).toContain("canonical is itself a legacy alias: " + LEGACY_ANNOUNCE);
    expect(report.issues.some((i) => i.startsWith("unparsable since: " + LEGACY_OK))).toBe(true);
    expect(report.issues).toContain("unknown status: " + LEGACY_OK + " -> retired");
 // issues 确定性排序(字典序)且去重逻辑不吞重复项
    expect(report.issues).toEqual([...report.issues].sort());
    const dupCount = bad.filter((e) => e.legacy === LEGACY_OK).length - 1;
    expect(report.issues.filter((i) => i === "duplicate legacy: " + LEGACY_OK).length).toBe(dupCount);
  });

  it("F'''') 确定性:同输入两次逐字相等,返回结构冻结;空 values 不 throw", () => {
    const a = assertCompatRegistry(ERROR_CODE_VALUES, { now: IN_WINDOW });
    const b = assertCompatRegistry(ERROR_CODE_VALUES, { now: IN_WINDOW });
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.issues)).toBe(true);
    const empty = assertCompatRegistry([], { now: IN_WINDOW });
    expect(empty.ok).toBe(false);
    expect(empty.issues.length).toBe(COMPAT_WINDOWS.length);
    expect(() => assertCompatRegistry(undefined as unknown as string[], { now: IN_WINDOW })).not.toThrow();
  });
});

describe("describeCompatWindow:一行摘要", () => {
  it("窗口内带剩余天数、窗口后写已下线,单行无换行", () => {
    const live = describeCompatWindow(entry(LEGACY_OK), IN_WINDOW);
    expect(live.startsWith(LEGACY_OK + " → " + CANON_OK)).toBe(true);
    expect(live).toContain(SINCE);
    expect(live).toContain(SUNSET);
    expect(live).toMatch(/剩 \d+ 天/);
    expect(live).not.toContain("\n");
    const expired = describeCompatWindow(entry(LEGACY_OK), AFTER_SUNSET);
    expect(expired).toContain("下线");
    expect(expired).toMatch(/已于 \d{4}-\d{2}-\d{2} 下线/);
    expect(expired).not.toBe(live);
 // 同 now 同输出(确定性)
    expect(describeCompatWindow(entry(LEGACY_OK), IN_WINDOW)).toBe(live);
  });

  it("日期不可解析时也不 throw,写「不可解析」", () => {
    const broken = { ...entry(LEGACY_OK), sunsetAt: "tomorrow" } as CompatWindowEntry;
    const text = describeCompatWindow(broken, IN_WINDOW);
    expect(text).toContain("tomorrow 不可解析");
    expect(text).not.toContain("\n");
    expect(ErrorCode.CompanionFailed).toBe(LEGACY_OK);
  });
});
