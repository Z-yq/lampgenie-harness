/**
 * 系统提醒来源登记:封闭源表 / descriptor / 渲染 fail-closed / 转义 / 长度 / 合并 / MCS 单点。
 * 纯逻辑零 IO,全部用例同步、确定性。
 */
import { describe, it, expect } from "vitest";
import {
  PERSISTED_REMINDER_SOURCES,
  EPHEMERAL_REMINDER_SOURCES,
  REMINDER_SOURCES,
  REMINDER_MAX_CHARS,
  isReminderSource,
  reminderDescriptor,
  renderSystemReminder,
  mergeReminders,
  providerSupportsMcs,
  type ReminderItem,
} from "../src/agent/reminder-source";

/** 旧实现形态(golden):["<system-reminder>", ...lines, "</system-reminder>"].join("\n")。 */
const legacyBlock = (lines: string[]): string => ["<system-reminder>", ...lines, "</system-reminder>"].join("\n");

describe("源表与 descriptor", () => {
  it("两张表互斥(无同名源)", () => {
    const overlap = (PERSISTED_REMINDER_SOURCES as readonly string[])
      .filter((s) => (EPHEMERAL_REMINDER_SOURCES as readonly string[]).includes(s));
    expect(overlap).toEqual([]);
  });

  it("两张表并集=11 个来源且无重复", () => {
    expect(PERSISTED_REMINDER_SOURCES.length).toBe(5);
    expect(EPHEMERAL_REMINDER_SOURCES.length).toBe(6);
    expect(REMINDER_SOURCES.length).toBe(11);
    expect(new Set(REMINDER_SOURCES).size).toBe(11);
  });

  it("每个登记源都有 descriptor,且表外源一个都进不来", () => {
    for (const source of REMINDER_SOURCES) {
      expect(reminderDescriptor(source), source).not.toBeNull();
      expect(isReminderSource(source), source).toBe(true);
    }
  });

  it("descriptor 字段取值域合法(channel / providerVisibility)", () => {
    for (const source of REMINDER_SOURCES) {
      const d = reminderDescriptor(source)!;
      expect(["system", "user"]).toContain(d.channel);
      expect(["always", "mcs-only"]).toContain(d.providerVisibility);
      expect(d.evidenceLabel.trim().length).toBeGreaterThan(0);
    }
  });

  it("descriptor.lifecycle 与所在表一致", () => {
    for (const s of PERSISTED_REMINDER_SOURCES) expect(reminderDescriptor(s)!.lifecycle).toBe("persisted");
    for (const s of EPHEMERAL_REMINDER_SOURCES) expect(reminderDescriptor(s)!.lifecycle).toBe("ephemeral");
  });

  it("order 唯一且随 REMINDER_SOURCES 单调递增", () => {
    const orders = REMINDER_SOURCES.map((s) => reminderDescriptor(s)!.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("evidenceLabel 唯一(遥测/面板据此区分来源)", () => {
    const labels = REMINDER_SOURCES.map((s) => reminderDescriptor(s)!.evidenceLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("未知 source → reminderDescriptor=null", () => {
    expect(reminderDescriptor("mystery")).toBeNull();
    expect(reminderDescriptor("")).toBeNull();
    expect(reminderDescriptor(undefined)).toBeNull();
    expect(reminderDescriptor(42)).toBeNull();
  });

  it("原型链名不当成已登记来源", () => {
    expect(reminderDescriptor("toString")).toBeNull();
    expect(reminderDescriptor("__proto__")).toBeNull();
    expect(reminderDescriptor("constructor")).toBeNull();
    expect(isReminderSource("hasOwnProperty")).toBe(false);
  });

  it("descriptor 与来源清单不可变(冻结)", () => {
    expect(Object.isFrozen(REMINDER_SOURCES)).toBe(true);
    expect(Object.isFrozen(reminderDescriptor("todo"))).toBe(true);
    expect(Object.isFrozen(reminderDescriptor("read-files"))).toBe(true);
  });
});

describe("renderSystemReminder", () => {
  it("输出形态与旧实现逐字节一致", () => {
    const r = renderSystemReminder("todo", "第一行\n第二行");
    expect(r).toEqual({ ok: true, text: legacyBlock(["第一行", "第二行"]) });
  });

  it("未知 source → UNKNOWN_SOURCE 且不产文本(fail-closed)", () => {
    const r = renderSystemReminder("mystery", "任意内容");
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("text");
    expect((r as { code: string }).code).toBe("UNKNOWN_SOURCE");
  });

  it("空 body → EMPTY_BODY", () => {
    expect(renderSystemReminder("todo", "")).toEqual({ ok: false, code: "EMPTY_BODY" });
  });

  it("纯空白 body → EMPTY_BODY", () => {
    expect(renderSystemReminder("todo", "  \n\t ")).toEqual({ ok: false, code: "EMPTY_BODY" });
  });

  it("非字符串 body → EMPTY_BODY(不 throw)", () => {
    expect(renderSystemReminder("todo", undefined)).toEqual({ ok: false, code: "EMPTY_BODY" });
    expect(() => renderSystemReminder("todo", { body: "x" })).not.toThrow();
  });

  it("嵌套闭合标签被转义", () => {
    const r = renderSystemReminder("todo", "前 <system-reminder>内层</system-reminder> 后");
    expect(r.ok).toBe(true);
    const text = (r as { text: string }).text;
    expect(text).toContain("&lt;system-reminder&gt;内层&lt;/system-reminder&gt;");
    expect(text).not.toContain("<system-reminder>内层");
  });

  it("带属性的嵌套标签(含标签内空白)被转义", () => {
    const r = renderSystemReminder("todo", "<system-reminder foo=\"1\" >x</system-reminder >");
    const text = (r as { text: string }).text;
    expect(text).toContain("&lt;system-reminder foo=\"1\" &gt;");
    expect(text).toContain("&lt;/system-reminder &gt;");
  });

  it("大小写不敏感", () => {
    const text = (renderSystemReminder("todo", "<SYSTEM-REMINDER>x</System-Reminder>") as { text: string }).text;
    expect(text).toContain("&lt;SYSTEM-REMINDER&gt;x&lt;/System-Reminder&gt;");
  });

  it("其它 HTML 一律不动", () => {
    const text = (renderSystemReminder("todo", "<b>粗</b> & <i>斜</i>") as { text: string }).text;
    expect(text).toContain("<b>粗</b> & <i>斜</i>");
  });

  it("名字相近的标签(system-reminders)不误转义", () => {
    const text = (renderSystemReminder("todo", "<system-reminders>x</system-reminders>") as { text: string }).text;
    expect(text).toContain("<system-reminders>x</system-reminders>");
  });

  it("escapeNested:false 保留原样(已清洗 body 不重复处理)", () => {
    const body = "<system-reminder>x</system-reminder>";
    const text = (renderSystemReminder("timebox", body, { escapeNested: false, inline: true }) as { text: string }).text;
    expect(text).toBe(`<system-reminder>${body}</system-reminder>`);
  });

  it("恰好 4000 字 → ok", () => {
    const inner = REMINDER_MAX_CHARS - "<system-reminder>\n".length - "\n</system-reminder>".length;
    const r = renderSystemReminder("todo", "x".repeat(inner));
    expect(r.ok).toBe(true);
    expect((r as { text: string }).text.length).toBe(REMINDER_MAX_CHARS);
  });

  it("超 4000 字 → TOO_LONG(显式失败,不截断)", () => {
    const inner = REMINDER_MAX_CHARS - "<system-reminder>\n".length - "\n</system-reminder>".length + 1;
    const r = renderSystemReminder("todo", "x".repeat(inner));
    expect(r).toEqual({ ok: false, code: "TOO_LONG" });
  });

  it("三种失败都不 throw", () => {
    expect(() => renderSystemReminder("mystery", "")).not.toThrow();
    expect(() => renderSystemReminder("todo", "")).not.toThrow();
    expect(() => renderSystemReminder("todo", "x".repeat(REMINDER_MAX_CHARS * 2))).not.toThrow();
  });

  it("同输入两次调用结果完全相同(确定性)", () => {
    const a = renderSystemReminder("pending-questions", "问题 1");
    const b = renderSystemReminder("pending-questions", "问题 1");
    expect(a).toEqual(b);
  });
});

describe("mergeReminders", () => {
  const items: ReminderItem[] = [
    { source: "tip", body: "TIP-段" },
    { source: "todo", body: "TODO-段" },
    { source: "read-files", body: "READ-段" },
  ];

  it("空输入 → texts=[] merged=false", () => {
    expect(mergeReminders([], { supportsMcs: true, hasLegalAnchor: true })).toEqual({ texts: [], merged: false, skipped: [] });
  });

  it("supportsMcs=false → 整组合并成一条 user reminder", () => {
    const r = mergeReminders(items, { supportsMcs: false, hasLegalAnchor: true });
    expect(r.merged).toBe(true);
    expect(r.texts.length).toBe(1);
    expect(r.texts[0]!.startsWith("[系统提醒] ")).toBe(true);
    expect(r.texts[0]).not.toContain("<system-reminder>");
  });

  it("hasLegalAnchor=false → 同样整组合并(没有合法锚点就不许逐条投 system 块)", () => {
    const r = mergeReminders(items, { supportsMcs: true, hasLegalAnchor: false });
    expect(r.merged).toBe(true);
    expect(r.texts.length).toBe(1);
  });

  it("缺省选项按不支持 MCS 处理(fail-closed)", () => {
    const r = mergeReminders(items);
    expect(r.merged).toBe(true);
    expect(r.texts.length).toBe(1);
  });

  it("supportsMcs 与 hasLegalAnchor 都为 true → 逐条包装", () => {
    const r = mergeReminders(items, { supportsMcs: true, hasLegalAnchor: true });
    expect(r.merged).toBe(false);
    expect(r.texts.length).toBe(3);
    for (const t of r.texts) expect(t.startsWith("<system-reminder>\n")).toBe(true);
  });

  it("按 descriptor.order 排序(输入乱序也一样)", () => {
    const merged = mergeReminders(items, { supportsMcs: false, hasLegalAnchor: false }).texts[0]!;
    expect(merged.indexOf("TODO-段")).toBeLessThan(merged.indexOf("READ-段"));
    expect(merged.indexOf("READ-段")).toBeLessThan(merged.indexOf("TIP-段"));
    const perItem = mergeReminders(items, { supportsMcs: true, hasLegalAnchor: true }).texts;
    expect(perItem[0]).toContain("TODO-段");
    expect(perItem[1]).toContain("READ-段");
    expect(perItem[2]).toContain("TIP-段");
  });

  it("段间用空行分隔", () => {
    const merged = mergeReminders(items, { supportsMcs: false, hasLegalAnchor: false }).texts[0]!;
    expect(merged).toContain("TODO-段\n\nREAD-段");
  });

  it("未知 source → skipped 且不进文本", () => {
    const r = mergeReminders([{ source: "mystery", body: "SECRET" }, { source: "todo", body: "TODO-段" }], { supportsMcs: false, hasLegalAnchor: false });
    expect(r.skipped).toEqual(["mystery"]);
    expect(r.texts[0]).not.toContain("SECRET");
  });

  it("空 body 的来源进 skipped", () => {
    const r = mergeReminders([{ source: "todo", body: "   " }], { supportsMcs: false, hasLegalAnchor: false });
    expect(r.skipped).toEqual(["todo"]);
    expect(r.texts).toEqual([]);
  });

  it("全部来源未知 → 不产文本", () => {
    const r = mergeReminders([{ source: "a", body: "x" }, { source: "b", body: "y" }], { supportsMcs: true, hasLegalAnchor: true });
    expect(r.texts).toEqual([]);
    expect(r.skipped).toEqual(["a", "b"]);
  });

  it("合并态剥掉内层 reminder 标签", () => {
    const r = mergeReminders([{ source: "todo", body: "前 <system-reminder>内层</system-reminder> 后" }], { supportsMcs: false, hasLegalAnchor: false });
    expect(r.texts[0]).toBe("[系统提醒] 前 内层 后");
  });

  it("逐条态把内层标签转义而不是留成嵌套块", () => {
    const r = mergeReminders([{ source: "todo", body: "<system-reminder>内层</system-reminder>" }], { supportsMcs: true, hasLegalAnchor: true });
    expect(r.texts[0]).toContain("&lt;system-reminder&gt;");
    expect(r.texts[0]!.match(/<system-reminder>/g)?.length).toBe(1);
  });

  it("不修改入参数组(不可变)", () => {
    const frozen: readonly ReminderItem[] = Object.freeze([
      Object.freeze({ source: "tip", body: "T" }),
      Object.freeze({ source: "todo", body: "D" }),
    ]);
    const before = JSON.stringify(frozen);
    expect(() => mergeReminders(frozen, { supportsMcs: true, hasLegalAnchor: true })).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("同输入两次调用结果完全相同(确定性)", () => {
    const a = mergeReminders(items, { supportsMcs: false, hasLegalAnchor: true });
    const b = mergeReminders(items, { supportsMcs: false, hasLegalAnchor: true });
    expect(a).toEqual(b);
  });
});

describe("providerSupportsMcs 单点判定", () => {
  it("缺省 false", () => {
    expect(providerSupportsMcs()).toBe(false);
    expect(providerSupportsMcs("")).toBe(false);
  });

  it("不靠模型名猜:名字里带 mcs 也是 false", () => {
    expect(providerSupportsMcs("gpt-4o-mcs")).toBe(false);
    expect(providerSupportsMcs("MCS-1")).toBe(false);
    expect(providerSupportsMcs("claude-sonnet-4.5")).toBe(false);
  });

  it("原型链名不算能力位", () => {
    expect(providerSupportsMcs("__proto__")).toBe(false);
    expect(providerSupportsMcs("toString")).toBe(false);
  });
});

describe("旧文本 golden 等价(接入前形态)", () => {
  it("read-files body 逐字节一致", () => {
    const lines = [
      "本会话已读文件清单(按读取时间新→旧):",
      "- packages/a.ts(3 分钟前)",
      "- packages/b.ts(刚刚)",
      "(共 20 个,只列最近 12 个)",
      "重读前先看清单:文件未变就不要整读,要细节用 offset/limit 局部读。",
    ];
    expect(renderSystemReminder("read-files", lines.join("\n"))).toEqual({ ok: true, text: legacyBlock(lines) });
  });

  it("todo body 逐字节一致", () => {
    const lines = ["当前工作计划还有未完成项:", "- [进行中] 定位渲染点", "- [待办] 写测试", "进度有变化时用 todo_write 更新状态;全部完成前不要提前收尾。"];
    expect(renderSystemReminder("todo", lines.join("\n"))).toEqual({ ok: true, text: legacyBlock(lines) });
  });

  it("timebox 单行形态逐字节一致", () => {
    const body = "时间盒仅剩约 2 分钟:立即停止继续检索/探路,基于已获得的信息输出任务书要求的最终结论。";
    expect(renderSystemReminder("timebox", body, { escapeNested: false, inline: true })).toEqual({
      ok: true,
      text: "<system-reminder>" + body + "</system-reminder>",
    });
  });

  it("pending-questions body 逐字节一致", () => {
    const lines = ["[子代理重操作审批] 有 1 个待决申请需要你决策", "1. [r1] 子代理 worker(task=t1)经 terminal 请求执行 [build] `pnpm build`"];
    expect(renderSystemReminder("pending-questions", lines.join("\n"))).toEqual({ ok: true, text: legacyBlock(lines) });
  });
});

describe("productive-nudge(修复:产出纪律提醒收进登记表)", () => {
  it("descriptor = user / ephemeral / always,order 紧跟 tip 之后", () => {
    const d = reminderDescriptor("productive-nudge")!;
    expect(d).toEqual({
      channel: "user",
      lifecycle: "ephemeral",
      order: reminderDescriptor("tip")!.order + 1,
      providerVisibility: "always",
      evidenceLabel: "产出纪律",
    });
    expect(Object.isFrozen(d)).toBe(true);
  });

  it("ephemeral 表末尾追加,已有源顺序不动(旧拼接调用点零迁移成本)", () => {
    expect(EPHEMERAL_REMINDER_SOURCES).toEqual([
      "read-files", "timebox", "trajectory", "pending-questions", "tip", "productive-nudge",
    ]);
    expect(REMINDER_SOURCES[REMINDER_SOURCES.length - 1]).toBe("productive-nudge");
  });

  it("inline 渲染与旧拼接逐字节一致", () => {
    const body = "[产出纪律] 已连续 25 步只调工具、未输出任何文本结论。现在立刻用一段文字写出:①已完成什么(带 file:line 证据)②结论是什么 ③还差什么。写完再决定是否继续查。禁止再开新勘察方向。";
    expect(renderSystemReminder("productive-nudge", body, { inline: true, escapeNested: false })).toEqual({
      ok: true,
      text: "<system-reminder>" + body + "</system-reminder>",
    });
  });

  it("未显式关闭转义时,body 里的嵌套标签照统一口径转义", () => {
    const r = renderSystemReminder("productive-nudge", "x<system-reminder>y</system-reminder>");
    expect(r).toEqual({ ok: true, text: legacyBlock(["x&lt;system-reminder&gt;y&lt;/system-reminder&gt;"]) });
  });
});
