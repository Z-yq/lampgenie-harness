/**
 * office-voice:办公文案「人话/关键词」检测。
 * 输出要像工程师下结论——关键词 + 数字 + 留白;不要 agent 报告腔。
 * 本测试锁三件事:高置信规则命中、正常业务词不误杀、长段落被长度门拦住。
 */
import { describe, expect, it } from "vitest";
import { VOICE_CODES, VOICE_MAX_BULLET_CHARS, VOICE_RULES_VERSION, analyzeVoice, voiceRuleCatalog } from "../src/office-voice.mjs";

describe("office-voice", () => {
  it("干净关键词文案零问题", () => {
    const r = analyzeVoice({
      title: "缓存改造：P95 从 800ms 降到 210ms",
      bullets: [
        { lead: "前缀稳定", text: "历史中段不改写，缓存命中 99%" },
        { lead: "失败重试", text: "只重试一次，坏数据不拖整批" },
        { lead: "回滚脚本", text: "李工，6 月 12 日前" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.codes).toEqual(["VOICE_OK"]);
    expect(r.issues).toEqual([]);
  });

  it("序数/总结连接词命中 VOICE_CONNECTOR", () => {
    for (const text of [
      "首先做缓存改造，其次补压测，最后再上线",
      "综上所述，这个方案值得推进",
      "由此可见，问题在接入层",
      "不仅省机器，而且延迟更低",
      "一方面要稳，另一方面要快",
    ]) {
      const r = analyzeVoice({ title: "方案", bullets: [{ lead: "结论", text }] });
      expect(r.codes, text).toContain("VOICE_CONNECTOR");
      expect(r.ok).toBe(false);
    }
  });

  it("报告框架语命中 VOICE_META", () => {
    for (const text of ["本页讲三件事", "接下来我们看写入链", "本节先给结论", "让我们复盘一下"]) {
      const r = analyzeVoice({ title: "方案", bullets: [{ lead: "开头", text }] });
      expect(r.codes, text).toContain("VOICE_META");
    }
  });

  it("解释性脚手架/空泛大词命中", () => {
    expect(analyzeVoice({ title: "方案", bullets: [{ lead: "解释", text: "这意味着缓存会失效" }] }).codes).toContain("VOICE_EXPLAIN");
    expect(analyzeVoice({ title: "方案", bullets: [{ lead: "解释", text: "通过统一入口实现灰度" }] }).codes).toContain("VOICE_EXPLAIN");
    expect(analyzeVoice({ title: "方案", bullets: [{ lead: "价值", text: "赋能业务，形成闭环" }] }).codes).toContain("VOICE_PUFFERY");
    expect(analyzeVoice({ title: "方案", bullets: [{ lead: "价值", text: "全面提升系统能力" }] }).codes).toContain("VOICE_PUFFERY");
  });

  it("正常业务词不误杀：维度配置 / 有效期 / 通过评审", () => {
    const r = analyzeVoice({
      title: "维度配置与有效期",
      bullets: [
        { lead: "维度配置", text: "8 份配置决定浓缩触发条件" },
        { lead: "有效期", text: "缓存有效期 24 小时" },
        { lead: "评审", text: "方案通过评审，下一步补压测" },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("长段落超 64 字命中 VOICE_LONG（lead+text 合计）", () => {
    const long = "这条要点的说明写得像一段报告而不是关键词所以它超过了单行上限并且应该被拆成两条或者删掉解释性从句只留下判断和数字以及对应的证据来源与负责人和截止时间";
    expect([...long].length).toBeGreaterThan(VOICE_MAX_BULLET_CHARS);
    const r = analyzeVoice({ title: "方案", bullets: [{ lead: "长说明", text: long }] });
    expect(r.codes).toContain("VOICE_LONG");
    expect(r.issues.some((i) => i.msg.includes(String(VOICE_MAX_BULLET_CHARS)))).toBe(true);
  });

  it("标题也过同一套规则；空输入稳定失败不抛", () => {
    expect(analyzeVoice({ title: "本页讲什么", bullets: [] }).codes).toContain("VOICE_META");
    expect(() => analyzeVoice(undefined)).not.toThrow();
    expect(analyzeVoice(undefined).codes).toEqual(["VOICE_INVALID"]);
  });

  it("规则目录/版本可审计；VOICE_CODES 是封闭集合", () => {
    expect(VOICE_RULES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const catalog = voiceRuleCatalog();
    expect(catalog).toHaveLength(4);
    for (const item of catalog) expect(VOICE_CODES).toContain(item.code);
  });
});