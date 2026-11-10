/**
 * 研究引用账本(cite_source。
 * A. 工具层(假 journal 带 web_fetch call/result):登记成功、编号连续、重复幂等;
 *    未抓取 / 引文不在文本 / 引文过短 / 非 http(s) → 拒绝且不落账;
 *    归一化:末尾斜杠 + host 大小写可命中,空白归一可命中,引文大小写不同拒绝;
 * B. 收尾纯函数:auditCitations 的 cited/missing(越界)/unused(不报警)/无引用;
 *    renderCitationWarning 只在 missing>0 时出。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { acquireEnvLock, releaseEnvLock } from "./support/env-lock.js";
import {
  CITE_SOURCE_TOOL_NAME,
  makeCiteSourceTool,
  readCitations,
  auditCitations,
  shouldAuditCitations,
  renderCitationWarning,
  normalizeUrl,
  normalizeWhitespace,
  extractFetchedText,
  type CitationJournal,
  type CitationJournalEvent,
} from "../src/citation-ledger.js";

/** 假 journal:append 顺序落事件(seq 递增);tool.call/tool.result 由测试直接预置。 */
function fakeJournal(pre: CitationJournalEvent[] = []) {
  const evs: CitationJournalEvent[] = [...pre];
  let seq = evs.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0);
  const j: CitationJournal & { evs: CitationJournalEvent[] } = {
    evs,
    append(e) {
      const created = { ...e, seq: ++seq };
      evs.push(created as CitationJournalEvent);
      return created;
    },
    readAll() { return evs; },
  };
  return j;
}

const SID = "s1";
const TID = "t1";
const URL_A = "https://example.com/doc/a/";
const URL_B = "https://Example.COM/doc/b";

/** web_fetch 成功的抓取事件(content 是 web_fetch 的 JSON 回执,正文在 content 字段)。 */
function fetched(id: string, url: string, text: string): CitationJournalEvent[] {
  let seq = id === "fc1" ? 1 : 3;
  return [
    { seq: seq++, kind: "tool.call", sessionId: SID, payload: { name: "web_fetch", toolCallId: id, arguments: JSON.stringify({ url }) } },
    { seq: seq++, kind: "tool.result", sessionId: SID, payload: { toolCallId: id, content: JSON.stringify({ url, status: 200, content: text }) } },
  ];
}

const TEXT_A = "Harness 的研究稿必须给每个检索来源登记编号。模型知识必须显式标 [unverified],不得占用引用编号。";
const TEXT_B = "The ledger assigns numbers in registration order; repeated registration is idempotent.";

function tool(j: CitationJournal, taskId = TID) {
  return makeCiteSourceTool({ journal: j, sessionId: SID, taskId });
}

describe("cite_source 工具", () => {
  it("已抓取 + 引文逐字命中:登记成功,编号从 1 连续,落 citation.registered 且带 sourceToolCallId", async () => {
    const j = fakeJournal([...fetched("fc1", URL_A, TEXT_A), ...fetched("fc2", URL_B, TEXT_B)]);
    const t = tool(j);
    const r1 = String(await t.execute({ url: URL_A, quote: "研究稿必须给每个检索来源登记编号", title: "研究规范" }));
    expect(r1).toContain("已登记引用 [1]");
    const r2 = String(await t.execute({ url: URL_B, quote: "repeated registration is idempotent" }));
    expect(r2).toContain("已登记引用 [2]");
    const regs = readCitations(j, SID, TID);
    expect(regs.map((r) => r.n)).toEqual([1, 2]);
    expect(regs[0]!.sourceToolCallId).toBe("fc1");
    expect(regs[1]!.sourceToolCallId).toBe("fc2");
    expect(regs[0]!.title).toBe("研究规范");
  });

  it("同一 url+quote 重复登记幂等:返回原 n,不新增事件", async () => {
    const j = fakeJournal(fetched("fc1", URL_A, TEXT_A));
    const t = tool(j);
    await t.execute({ url: URL_A, quote: "研究稿必须给每个检索来源登记编号" });
    const before = j.evs.filter((e) => e.kind === "custom").length;
    const again = String(await t.execute({ url: URL_A, quote: "研究稿必须给每个检索来源登记编号" }));
    expect(again).toContain("[1]");
    expect(again).toContain("重复");
    expect(j.evs.filter((e) => e.kind === "custom").length).toBe(before);
    expect(readCitations(j, SID, TID)).toHaveLength(1);
  });

  it("URL 未在本会话抓取 → 拒绝且不落账;抓取结果错误/仅失败也拒绝", async () => {
    const j = fakeJournal([
      ...fetched("fc1", URL_A, TEXT_A),
      // 同 URL 只留失败结果(另一条叫 fc2 的是不同 url)
      { seq: 9, kind: "tool.call", sessionId: SID, payload: { name: "web_fetch", toolCallId: "bad", arguments: JSON.stringify({ url: "https://example.com/broken" }) } },
      { seq: 10, kind: "tool.result", sessionId: SID, payload: { toolCallId: "bad", content: "错误: 抓取超时" } },
    ]);
    const t = tool(j);
    const r1 = String(await t.execute({ url: "https://example.com/never-fetched", quote: "这段引文不在任何抓取结果里" }));
    expect(r1).toContain("未在本会话抓到该 URL");
    const r2 = String(await t.execute({ url: "https://example.com/broken", quote: "这段引文不在任何抓取结果里" }));
    expect(r2).toContain("未在本会话抓到该 URL");
    expect(readCitations(j, SID, TID)).toHaveLength(0);
  });

  it("引文不在抓取文本 / 大小写不同 / 过短 → 拒绝且不落账", async () => {
    const j = fakeJournal(fetched("fc1", URL_A, TEXT_A));
    const t = tool(j);
    const miss = String(await t.execute({ url: URL_A, quote: "这句话根本不在抓取正文里面出现" }));
    expect(miss).toContain("引文未在抓取文本出现");
    const caseMismatch = String(await t.execute({ url: URL_A, quote: "模型知识必须显式标 [UNVERIFIED]" }));
    expect(caseMismatch).toContain("引文未在抓取文本出现");
    const short = String(await t.execute({ url: URL_A, quote: "研究稿必须" }));
    expect(short).toContain("引文过短");
    const badUrl = String(await t.execute({ url: "ftp://example.com/x", quote: "研究稿必须给每个检索来源登记编号" }));
    expect(badUrl).toContain("url 必须是 http(s)");
    expect(readCitations(j, SID, TID)).toHaveLength(0);
  });

  it("归一化:末尾斜杠与 host 大小写可命中;引文空白归一后逐字比对", async () => {
    // 抓取用的是 URL_B 的 Example.COM 形态,登记用小写 host + 无尾斜杠
    const j = fakeJournal([
      ...fetched("fc1", "https://example.com/doc/b/", TEXT_B),
    ]);
    const t = tool(j);
    // host 大小写不同 + 多一个尾斜杠
    const r = String(await t.execute({ url: "https://EXAMPLE.com/doc/b//", quote: "numbers   in registration order" }));
    expect(r).toContain("已登记引用 [1]");
    expect(normalizeUrl("https://Example.COM/a/")).toBe("https://example.com/a");
    expect(normalizeWhitespace("a \n b\t c")).toBe("a b c");
  });

  it("extractFetchedText:JSON 取 content 字段,非 JSON 用原文", () => {
    expect(extractFetchedText(JSON.stringify({ content: "正文" }))).toBe("正文");
    expect(extractFetchedText("纯文本")).toBe("纯文本");
  });

  it("工具名与 schema:cite_source,url/quote 必填", () => {
    const t = tool(fakeJournal());
    expect(t.name).toBe(CITE_SOURCE_TOOL_NAME);
    const params = t.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(params.required).toEqual(["url", "quote"]);
    expect(Object.keys(params.properties ?? {})).toEqual(["url", "quote", "title"]);
  });

  it("编号按 taskId 隔离:另一 taskId 从 1 起", async () => {
    const j = fakeJournal(fetched("fc1", URL_A, TEXT_A));
    await tool(j, "t1").execute({ url: URL_A, quote: "研究稿必须给每个检索来源登记编号" });
    const other = String(await tool(j, "t2").execute({ url: URL_A, quote: "模型知识必须显式标 [unverified]" }));
    expect(other).toContain("已登记引用 [1]");
    expect(readCitations(j, SID, "t1").map((r) => r.n)).toEqual([1]);
    expect(readCitations(j, SID, "t2").map((r) => r.n)).toEqual([1]);
  });
});

describe("收尾引用审计(auditCitations / renderCitationWarning)", () => {
  const reg = (n: number, url = `https://e.com/${n}`): { taskId: string; n: number; url: string; quote: string; at: number } =>
    ({ taskId: TID, n, url, quote: `q${n}`, at: 0 });

  it("正文 [1][2] 都有登记 → 无 missing、无警告", () => {
    const a = auditCitations("结论见 [1],数据见 [2]。", [reg(1), reg(2)]);
    expect(a.cited).toEqual([1, 2]);
    expect(a.missing).toEqual([]);
    expect(a.unused).toEqual([]);
    expect(renderCitationWarning(a)).toBe("");
  });

  it("正文 [3] 越界 → missing 警告点名 [3]", () => {
    const a = auditCitations("结论见 [1] 与 [3]。", [reg(1), reg(2)]);
    expect(a.missing).toEqual([3]);
    expect(a.cited).toEqual([1]);
    expect(a.unused).toEqual([2]);
    const warn = renderCitationWarning(a);
    expect(warn).toContain("[引用账本]");
    expect(warn).toContain("[3]");
    expect(warn).toContain("unverified");
  });

  it("已登记但正文未引用 → unused,不报警", () => {
    const a = auditCitations("结论见 [1]。", [reg(1), reg(2)]);
    expect(a.unused).toEqual([2]);
    expect(a.missing).toEqual([]);
    expect(renderCitationWarning(a)).toBe("");
  });

  it("无引用、无登记 → 全空,不追加", () => {
    const a = auditCitations("纯结论,没有编号。", []);
    expect(a).toEqual({ registered: [], cited: [], missing: [], unused: [] });
    expect(renderCitationWarning(a)).toBe("");
  });

  it("重复编号去重:[1][1] 只算一次", () => {
    const a = auditCitations("[1] 和 [1] 和 [2]", [reg(1)]);
    expect(a.cited).toEqual([1]);
    expect(a.missing).toEqual([2]);
  });
});

describe("收尾审计作用域(shouldAuditCitations)", () => {
  it("coding + 无登记 + 指令无研究词 → 不审计", () => {
    expect(shouldAuditCitations({ taskClass: "coding", instruction: "修一下 button 组件的样式", registeredCount: 0 })).toBe(false);
    expect(shouldAuditCitations({ taskClass: "coding", instruction: "修一下 button 组件的样式" })).toBe(false);
  });

  it("任何类别只要有已登记引用 → 审计", () => {
    expect(shouldAuditCitations({ taskClass: "coding", instruction: "修 bug", registeredCount: 1 })).toBe(true);
    expect(shouldAuditCitations({ registeredCount: 3 })).toBe(true);
  });

  it("office / qa 无登记也审计", () => {
    expect(shouldAuditCitations({ taskClass: "office", instruction: "做个周报" })).toBe(true);
    expect(shouldAuditCitations({ taskClass: "qa", instruction: "这个函数干啥的" })).toBe(true);
  });

  it("指令命中研究/调研词 → 审计(coding 类也审)", () => {
    for (const kw of ["研究", "调研", "调查", "综述", "文献", "参考资料", "论文", "报告", "白皮书", "查一下", "搜集", "对比分析"]) {
      expect(shouldAuditCitations({ taskClass: "coding", instruction: `帮我${kw}一下这个库` }), kw).toBe(true);
    }
  });
});

describe("接线(agent-wiring)", () => {
  it("TOOL_HINTS 有 cite_source 且提示研究来源登记;office 纪律卡含引用账本、coding 不含", async () => {
    const { TOOL_HINTS, systemForTaskClass, SYSTEM } = await import("../src/agent-wiring.js");
    const hint = TOOL_HINTS.find((h) => h.name === CITE_SOURCE_TOOL_NAME);
    expect(hint, "TOOL_HINTS 缺 cite_source").toBeTruthy();
    expect(hint!.hint).toContain("cite_source");
    expect(hint!.hint).toContain("[unverified]");
    expect(systemForTaskClass("office")).toContain("引用账本");
    expect(systemForTaskClass("office")).toContain("cite_source");
    expect(SYSTEM).not.toContain("引用账本");
    expect(systemForTaskClass("qa")).not.toContain("引用账本");
  });
});

// ---- 收尾钩子(agent-wiring 实际终态) ----
type CApp = ReturnType<typeof createGatewayApp>;
const cApps: CApp[] = [];
beforeAll(async () => { await acquireEnvLock("citation"); }, 240_000);
afterAll(() => { releaseEnvLock("citation"); });
afterEach(async () => {
  for (const a of cApps.splice(0)) await a.close();
  delete process.env.GENIE_CITATION_AUDIT;
});

type CAppend = (e: { kind: string; sessionId: string; payload: Record<string, unknown> }) => void;

/** 第 0 步在 journal 里落一条已登记引用(编号 1),模型终稿按 finalText 返回。 */
async function runClose(s: { sid: string; finalText: string; seedReg?: boolean; instruction?: string }): Promise<{ state: string; result: string; app: CApp }> {
  let appRef: CApp;
  let step = 0;
  const app = createGatewayApp({
    port: 0,
    llm: {
      async chat() {
        if (step++ === 0) {
          const tid = appRef.taskManager.list().find((x) => x.sessionId === s.sid)?.id ?? "";
          if (s.seedReg !== false) {
            appRef.journal.append({
              kind: "custom", sessionId: s.sid,
              payload: { type: "citation.registered", taskId: tid, n: 1, url: "https://example.com/a", quote: "引文一段足够长的原句", sourceToolCallId: "fc1", at: Date.now() },
            } as never);
          }
          return { content: s.finalText };
        }
        return { content: s.finalText };
      },
    } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  appRef = app;
  cApps.push(app);
  app.taskManager.submit("user", s.sid, s.instruction ?? "调研报告");
  for (let k = 0; k < 240; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === s.sid);
    if (t && (t.state === "done" || t.state === "failed")) return { state: t.state, result: String(t.result ?? ""), app };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("任务未在时限内终态");
}

const customTypesOf = (app: CApp, sid: string): string[] =>
  app.journal.readAll()
    .filter((e) => e.kind === "custom" && e.sessionId === sid)
    .map((e) => String((e.payload as { type?: string }).type ?? ""));

describe("收尾引用校验(agent-wiring)", () => {
  it("正文 [1] 有登记 → done、无引用账本警告、落 citation.audit", async () => {
    const r = await runClose({ sid: "cite-done-1", finalText: "结论见 [1]。" });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("[引用账本]");
    expect(customTypesOf(r.app, "cite-done-1")).toContain("citation.audit");
  }, 120_000);

  it("正文 [3] 越界 → 警告追加到终稿,journal 记 missing", async () => {
    const r = await runClose({ sid: "cite-warn-1", finalText: "结论见 [1],数据见 [3]。" });
    expect(r.state).toBe("done");
    expect(r.result).toContain("[引用账本]");
    expect(r.result).toContain("[3]");
    const audit = r.app.journal.readAll().find((e) => e.kind === "custom" && e.sessionId === "cite-warn-1" && (e.payload as { type?: string }).type === "citation.audit");
    expect((audit!.payload as { missing?: number[] }).missing).toEqual([3]);
  }, 120_000);

  it("无引用无登记 → 不追加警告", async () => {
    const r = await runClose({ sid: "cite-none-1", finalText: "纯结论文本。", seedReg: false });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("[引用账本]");
  }, 120_000);

  it("hard:越界补跑一轮仍缺 → failed + citation.audit.hard-fail", async () => {
    process.env.GENIE_CITATION_AUDIT = "hard";
    const r = await runClose({ sid: "cite-hard-1", finalText: "结论见 [3]。" });
    expect(r.state).toBe("failed");
    expect(r.result).toContain("未通过引用账本");
    expect(customTypesOf(r.app, "cite-hard-1")).toContain("citation.audit.hard-fail");
  }, 120_000);

  it("off:越界也不追加、不落 citation.audit", async () => {
    process.env.GENIE_CITATION_AUDIT = "off";
    const r = await runClose({ sid: "cite-off-1", finalText: "结论见 [3]。" });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("[引用账本]");
    expect(customTypesOf(r.app, "cite-off-1")).not.toContain("citation.audit");
  }, 120_000);

  it("coding 终稿含 [1]、无登记、指令无研究词 → 不警告、不落 citation.audit", async () => {
    const r = await runClose({
      sid: "cite-coding-skip-1",
      finalText: "改动见 arr[1] 与 [2] 号脚注。",
      seedReg: false,
      instruction: "修一下 button 组件的样式",
    });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("[引用账本]");
    expect(customTypesOf(r.app, "cite-coding-skip-1")).not.toContain("citation.audit");
  }, 120_000);

  it("coding 但有已登记引用 → 仍审计(正文 [1] 命中,不警告)", async () => {
    const r = await runClose({
      sid: "cite-coding-keep-1",
      finalText: "改动见 [1]。",
      instruction: "修一下 button 组件的样式",
    });
    expect(r.state).toBe("done");
    expect(r.result).not.toContain("[引用账本]");
    expect(customTypesOf(r.app, "cite-coding-keep-1")).toContain("citation.audit");
  }, 120_000);
});
