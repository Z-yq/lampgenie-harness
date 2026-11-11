/**
 * 沙箱事实纯逻辑验证。
 * 断言口径:等级由 runner 能力推出,声明本身不产生隔离;越界请求逐条拒绝且不改 spec。
 */
import { describe, it, expect } from "vitest";
import {
  assessConfinement,
  confineSpec,
  describeConfinement,
  runnerLabel,
  runnerOf,
  type ConfinementCapabilities,
  type ConfinementSpecInput,
} from "../src/sandbox-confinement";

const FULL: ConfinementCapabilities = Object.freeze({
  fsIsolation: true,
  networkIsolation: true,
  processIsolation: true,
  envScrub: true,
});
const ONE: ConfinementCapabilities = { fsIsolation: true, networkIsolation: false, processIsolation: false, envScrub: false };
const NONE_CAP: ConfinementCapabilities = { fsIsolation: false, networkIsolation: false, processIsolation: false, envScrub: false };

const ctx = { backendKind: "ndjson", capabilities: FULL };

const mkSpec = (over: Partial<ConfinementSpecInput> = {}): ConfinementSpecInput => ({
  permissions: "sandbox",
  workdir: "/tmp/m76-work",
  instructions: "跑一遍测试并汇总",
  ...over,
});

describe("assessConfinement:能力 → 事实等级", () => {
  it("四能力全真 → full 且 enforced", () => {
    const facts = assessConfinement("ndjson", FULL);
    expect(facts.level).toBe("full");
    expect(facts.enforced).toBe(true);
    expect(facts.runner).toBe("ndjson");
    expect(facts.reasons).toEqual([]);
  });

  it("只有一项能力 → partial,并逐项记缺失原因", () => {
    const facts = assessConfinement("ndjson", ONE);
    expect(facts.level).toBe("partial");
    expect(facts.enforced).toBe(false);
    expect(facts.reasons).toHaveLength(3);
    const joined = facts.reasons.join("|");
    expect(joined).toContain("networkIsolation");
    expect(joined).toContain("processIsolation");
    expect(joined).toContain("envScrub");
  });

  it("三项为真一项为假 → partial 且只记一项原因", () => {
    const facts = assessConfinement("ndjson", { ...FULL, envScrub: false });
    expect(facts.level).toBe("partial");
    expect(facts.reasons).toHaveLength(1);
    expect(facts.reasons[0]).toContain("envScrub");
  });

  it("四项全假 → none", () => {
    const facts = assessConfinement("ndjson", NONE_CAP);
    expect(facts.level).toBe("none");
    expect(facts.enforced).toBe(false);
    expect(facts.reasons).toHaveLength(4);
  });

  it("capabilities 省略 → none(未知一律按无隔离计)", () => {
    const facts = assessConfinement("ndjson");
    expect(facts.level).toBe("none");
    expect(facts.reasons).toHaveLength(4);
  });

  it("未知 runner 即使四能力全真也判 none", () => {
    const facts = assessConfinement("mystery-runner", FULL);
    expect(facts.runner).toBe("unknown");
    expect(facts.level).toBe("none");
    expect(facts.enforced).toBe(false);
    expect(facts.reasons.some((r) => r.includes("未知 runner"))).toBe(true);
  });

  it("runner 归因:五类登记 + 前缀识别 + 未知识别", () => {
    expect(runnerOf("ndjson")).toBe("ndjson");
    expect(runnerOf("echo-child")).toBe("echo");
    expect(runnerOf("acp")).toBe("acp");
    expect(runnerOf("cli:claude")).toBe("cli");
    expect(runnerOf("dsh-sdk")).toBe("dsh");
    expect(runnerOf(undefined)).toBe("unknown");
    expect(runnerOf("whatever")).toBe("unknown");
  });

  it("echo-child 归因为 echo,不继承 ndjson", () => {
    expect(runnerOf("echo-child")).toBe("echo");
    expect(assessConfinement("echo-child", FULL).runner).toBe("echo");
  });

  it("runnerLabel 已知 runner 给人读说明", () => {
    const label = runnerLabel("ndjson");
    expect(label).toContain("runner=ndjson");
    expect(label).toContain("全能力");
  });

  it("runnerLabel 未知 runner 显式写明无法归因", () => {
    expect(runnerLabel(undefined)).toContain("未知");
    expect(runnerLabel("zzz")).toContain("未知 runner");
  });

  it("describeConfinement 输出 level/enforced 与缺失项", () => {
    const text = describeConfinement(assessConfinement("ndjson", ONE));
    expect(text).toContain("level=partial");
    expect(text).toContain("enforced=no");
    expect(text).toContain("networkIsolation");
  });

  it("describeConfinement 带拒绝类别", () => {
    const verdict = confineSpec(mkSpec({ network: true }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(describeConfinement(verdict.facts)).toContain("拒绝=network");
  });

  it("确定性:同输入两次结果逐字相等", () => {
    const a = assessConfinement("ndjson", ONE);
    const b = assessConfinement("ndjson", ONE);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("不可变:冻结的入参不会被改,返回新对象", () => {
    const caps = Object.freeze({ ...ONE });
    const spec = Object.freeze(mkSpec());
    const policy = Object.freeze({});
    expect(() => assessConfinement("ndjson", caps)).not.toThrow();
    expect(() => confineSpec(spec, policy, { backendKind: "ndjson", capabilities: caps })).not.toThrow();
    expect(caps).toEqual(ONE);
    expect(assessConfinement("ndjson", ONE).reasons).not.toBe(assessConfinement("ndjson", ONE).reasons);
  });
});

describe("confineSpec:放行路径", () => {
  it("full + sandbox → ok,level=full,spec 原样返回", () => {
    const spec = mkSpec();
    const verdict = confineSpec(spec, {}, ctx);
    expect(verdict.ok).toBe(true);
    expect(verdict.facts.level).toBe("full");
    if (verdict.ok) expect(verdict.spec).toBe(spec);
  });

  it("readonly 不产生声明落差原因", () => {
    const verdict = confineSpec(mkSpec({ permissions: "readonly" }), {}, ctx);
    expect(verdict.ok).toBe(true);
    expect(verdict.facts.reasons.some((r) => r.includes("permissions="))).toBe(false);
  });

  it("permissions=inherit → 仍放行但记原因(level 保持)", () => {
    const verdict = confineSpec(mkSpec({ permissions: "inherit" }), {}, ctx);
    expect(verdict.ok).toBe(true);
    expect(verdict.facts.level).toBe("full");
    expect(verdict.facts.reasons.some((r) => r.includes("inherit"))).toBe(true);
  });

  it("sandbox 声明 + 无任何能力 → 放行但原因点明「仅为声明」", () => {
    const verdict = confineSpec(mkSpec(), {}, { backendKind: "echo", capabilities: NONE_CAP });
    expect(verdict.ok).toBe(true);
    expect(verdict.facts.level).toBe("none");
    expect(verdict.facts.reasons.some((r) => r.includes("仅为声明"))).toBe(true);
  });

  it("非凭据 env 键不触发拒绝", () => {
    const verdict = confineSpec(mkSpec({ env: { NODE_ENV: "test", LANG: "zh_CN" } }), {}, ctx);
    expect(verdict.ok).toBe(true);
  });

  it("普通绝对 workdir 无 workdir 违规", () => {
    const verdict = confineSpec(mkSpec({ workdir: "/home/u/proj/sub" }), {}, ctx);
    expect(verdict.ok).toBe(true);
  });
});

describe("confineSpec:拒绝四类(默认拒绝)", () => {
  it("network=true 被拒,violations/denied 含 network", () => {
    const verdict = confineSpec(mkSpec({ network: true }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.includes("network"))).toBe(true);
      expect(verdict.facts.denied).toContain("network");
    }
  });

  it("allowNetwork 放行网络请求", () => {
    expect(confineSpec(mkSpec({ network: true }), { allowNetwork: true }, ctx).ok).toBe(true);
  });

  it("空 workdir 被拒", () => {
    const verdict = confineSpec(mkSpec({ workdir: "   " }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.facts.denied).toContain("workdir");
  });

  it("相对 workdir 被拒(随 cwd 漂移)", () => {
    const verdict = confineSpec(mkSpec({ workdir: "sub/dir" }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.some((v) => v.includes("相对路径"))).toBe(true);
  });

  it("workdir 含 .. 越界被拒", () => {
    const verdict = confineSpec(mkSpec({ workdir: "/tmp/a/../../../etc" }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.some((v) => v.includes("越界"))).toBe(true);
  });

  it("allowWriteOutsideWorkdir 放行 .. 越界", () => {
    expect(confineSpec(mkSpec({ workdir: "/tmp/a/../b" }), { allowWriteOutsideWorkdir: true }, ctx).ok).toBe(true);
  });

  it("env 含 OPENAI_API_KEY 被拒(violations 含 env)", () => {
    const verdict = confineSpec(mkSpec({ env: { OPENAI_API_KEY: "fake-key" } }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.includes("env"))).toBe(true);
      expect(verdict.violations[0]).toContain("OPENAI_API_KEY");
      expect(verdict.facts.denied).toContain("env");
    }
  });

  it("TOKEN 与 PASSWORD 各记一条 env 违规", () => {
    const verdict = confineSpec(mkSpec({ env: { GITHUB_TOKEN: "fake-t", DB_PASSWORD: "fake-p" } }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.violations.filter((v) => v.startsWith("env:"))).toHaveLength(2);
  });

  it("allowEnvInherit 放行凭据类 env", () => {
    const verdict = confineSpec(mkSpec({ env: { API_KEY: "fake-k" } }), { allowEnvInherit: true }, ctx);
    expect(verdict.ok).toBe(true);
  });

  it("instructions 含 sudo 被拒(violations 含 privilege)", () => {
    const verdict = confineSpec(mkSpec({ instructions: "先 sudo apt-get install x" }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.violations.some((v) => v.includes("privilege"))).toBe(true);
      expect(verdict.facts.denied).toContain("privilege");
    }
  });

  it("su -c / doas / runas / setuid 四种提权形态都命中", () => {
    for (const text of ["su -c 'id'", "doas rm -rf /tmp/x", "runas /user:admin cmd", "setuid(0)"]) {
      const verdict = confineSpec(mkSpec({ instructions: text }), {}, ctx);
      expect(verdict.ok, text).toBe(false);
    }
  });

  it("allowPrivilege 放行提权指令", () => {
    expect(confineSpec(mkSpec({ instructions: "sudo id" }), { allowPrivilege: true }, ctx).ok).toBe(true);
  });

  it("多类违规累积:network + workdir + env 三条,顺序稳定", () => {
    const verdict = confineSpec(mkSpec({ network: true, workdir: "", env: { X_TOKEN: "fake" } }), {}, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.facts.denied).toEqual(["network", "workdir", "env"]);
      expect(verdict.violations).toHaveLength(3);
    }
  });

  it("违规不改写能力事实(level/enforced 仍是 full)", () => {
    const verdict = confineSpec(mkSpec({ network: true }), {}, ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.facts.level).toBe("full");
    expect(verdict.facts.enforced).toBe(true);
  });

  it("不 throw:instructions/env 缺省 + 空能力上下文", () => {
    let verdict: ReturnType<typeof confineSpec> | undefined;
    expect(() => {
      verdict = confineSpec({ permissions: "sandbox", workdir: "/tmp/x" }, {}, {});
    }).not.toThrow();
    expect(verdict!.ok).toBe(true);
    expect(verdict!.facts.level).toBe("none");
  });

  it("返回值数组是独立实例(改返回值不污染下一次判定)", () => {
    const first = confineSpec(mkSpec({ network: true }), {}, ctx);
    if (!first.ok) first.violations.push("伪造");
    const second = confineSpec(mkSpec({ network: true }), {}, ctx);
    if (!second.ok) expect(second.violations.some((v) => v.includes("伪造"))).toBe(false);
  });
});
