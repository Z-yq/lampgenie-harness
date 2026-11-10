/**
 * RSI #209 提示词版本与覆盖治理(纯逻辑)契约测试。
 * 覆盖:保留名/未知 key/placeholder 缺失与未知/base 冲突且草稿保留/相同默认 NOOP 与自动删覆盖/
 * RSI 需审批/序列 predecessor+timestamp/钉扎会话不随保存变/历史回读/内置升级 default-updated 与 diff/
 * accept-default / keep-mine / prune / 非法输入 / 不可变性。
 */
import { describe, expect, it } from "vitest";
import {
  PROMPT_CONFLICT,
  PROMPT_DEFAULT_UPDATED,
  PROMPT_INVALID,
  PROMPT_NEEDS_APPROVAL,
  PROMPT_NOOP_SAME_AS_DEFAULT,
  PROMPT_PINNED,
  PROMPT_PLACEHOLDER_MISSING,
  PROMPT_PLACEHOLDER_UNKNOWN,
  PROMPT_PRUNED,
  PROMPT_RESERVED_NAME,
  PROMPT_RESOLVED,
  PROMPT_REVISION_NOT_FOUND,
  PROMPT_SAVED,
  PROMPT_UNKNOWN_KEY,
  PROMPT_VERSION_SCHEMA,
  acceptDefault,
  createBook,
  diffWithDefault,
  extractPlaceholders,
  isReservedKey,
  keepOverride,
  normalizePromptBook,
  pinSession,
  promptKeys,
  pruneRedundant,
  resolve,
  resolveForSession,
  saveRevision,
  updateBuiltin,
  validateRevision,
  type PromptBook,
} from "../src/agent/prompt-version";

const BUILTINS = {
  "system.coding": "你是编码助手\n工具:{{tools}}\n语言:{{lang}}",
  "user.summary": "总结:{{text}}",
};

function freshBook(): PromptBook {
  const { book } = createBook({ builtins: BUILTINS }, { at: 1000 });
  return book;
}

/** 在 freshBook 上把 system.coding 存成 v2 的 helper。 */
function bookAtV2(book: PromptBook = freshBook()): { book: PromptBook; text: string } {
  const text = "你是编码助手\n工具:{{tools}}\n语言:{{lang}} 中文";
  const res = saveRevision(book, { key: "system.coding", text, baseRevision: 1, origin: "user", author: "zhq" }, { at: 2000 });
  expect(res.codes).toEqual([PROMPT_SAVED]);
  return { book: res.book, text };
}

describe("schema 与稳定码", () => {
  it("schema 版本为 1", () => {
    expect(PROMPT_VERSION_SCHEMA).toBe(1);
  });

  it("稳定码字面量成对可用(前缀 PROMPT_)", () => {
    for (const code of [PROMPT_CONFLICT, PROMPT_SAVED, PROMPT_PRUNED, PROMPT_DEFAULT_UPDATED]) {
      expect(code.startsWith("PROMPT_")).toBe(true);
    }
  });
});

describe("createBook", () => {
  it("每个 key 生成 revision 1(builtin,predecessor=null,timestamp=at)", () => {
    const { book, codes } = createBook({ builtins: BUILTINS }, { at: 42 });
    expect(codes).toEqual([]);
    const history = book.keys["system.coding"]!;
    expect(history.builtin).toBe(BUILTINS["system.coding"]);
    expect(history.current).toBe(1);
    expect(history.status).toBe("active");
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]).toMatchObject({ revision: 1, text: BUILTINS["system.coding"], predecessor: null, timestamp: 42, origin: "builtin" });
  });

  it("system.* 内置命名空间允许声明", () => {
    const { book, codes } = createBook({ builtins: { "system.coding": "x {{tools}}" } });
    expect(codes).toEqual([]);
    expect(Object.keys(book.keys)).toEqual(["system.coding"]);
  });

  it("admin.* 与 __ 前缀是保留名,被拒", () => {
    const { book, codes } = createBook({ builtins: { "admin.secret": "x", __proto__x: "y", "system.a": "ok" } });
    expect(codes).toEqual([PROMPT_RESERVED_NAME]);
    expect(Object.keys(book.keys)).toEqual(["system.a"]);
  });

  it("空文本与非法输入报 INVALID", () => {
    expect(createBook({ builtins: { "system.a": "   " } }).codes).toEqual([PROMPT_INVALID]);
    expect(createBook({ builtins: { "system.a": 1 } }).codes).toEqual([PROMPT_INVALID]);
    expect(createBook(null).codes).toEqual([PROMPT_INVALID]);
  });

  it("isReservedKey 覆盖 system./admin./__", () => {
    expect(isReservedKey("system.x")).toBe(true);
    expect(isReservedKey("Admin.y")).toBe(true);
    expect(isReservedKey("__z")).toBe(true);
    expect(isReservedKey("user.a")).toBe(false);
  });

  it("不改入参", () => {
    const input = { builtins: { "system.a": "x" } };
    createBook(input);
    expect(input).toEqual({ builtins: { "system.a": "x" } });
  });
});

describe("extractPlaceholders", () => {
  it("按出现顺序去重", () => {
    expect(extractPlaceholders("a {{tools}} b {{lang}} c {{tools}}")).toEqual(["tools", "lang"]);
  });

  it("无占位符返回空数组", () => {
    expect(extractPlaceholders("纯文本")).toEqual([]);
    expect(extractPlaceholders("")).toEqual([]);
    expect(extractPlaceholders(null)).toEqual([]);
  });

  it("不匹配畸形占位符", () => {
    expect(extractPlaceholders("{{ }} {{a b}} {{ok}}")).toEqual(["ok"]);
  });
});

describe("validateRevision", () => {
  it("缺内置占位符 → PLACEHOLDER_MISSING", () => {
    const res = validateRevision(freshBook(), { key: "system.coding", text: "只有 {{tools}}" });
    expect(res.codes).toEqual([PROMPT_PLACEHOLDER_MISSING]);
  });

  it("多出内置没有的占位符 → PLACEHOLDER_UNKNOWN", () => {
    const res = validateRevision(freshBook(), { key: "system.coding", text: "{{tools}} {{lang}} {{extra}}" });
    expect(res.codes).toEqual([PROMPT_PLACEHOLDER_UNKNOWN]);
  });

  it("两者都违规 → 两码同报", () => {
    const res = validateRevision(freshBook(), { key: "system.coding", text: "{{tools}} {{extra}}" });
    expect(res.codes).toEqual([PROMPT_PLACEHOLDER_MISSING, PROMPT_PLACEHOLDER_UNKNOWN]);
  });

  it("合规文本空码", () => {
    expect(validateRevision(freshBook(), { key: "system.coding", text: "{{lang}} {{tools}} 随便" }).codes).toEqual([]);
  });

  it("未知 key → UNKNOWN_KEY;非法文本 → INVALID", () => {
    expect(validateRevision(freshBook(), { key: "nope", text: "x" }).codes).toEqual([PROMPT_UNKNOWN_KEY]);
    expect(validateRevision(freshBook(), { key: "system.coding", text: 1 }).codes).toEqual([PROMPT_INVALID]);
  });
});

describe("saveRevision", () => {
  it("新增 v2:predecessor/timestamp/baseRevision/author/note 全落", () => {
    const { book, revision, codes } = saveRevision(
      freshBook(),
      { key: "system.coding", text: "{{tools}} {{lang}} v2", baseRevision: 1, origin: "project", author: "zhq", note: "调语气" },
      { at: 2000 },
    );
    expect(codes).toEqual([PROMPT_SAVED]);
    expect(revision).toMatchObject({ revision: 2, predecessor: 1, timestamp: 2000, origin: "project", baseRevision: 1, author: "zhq", note: "调语气" });
    expect(book.keys["system.coding"]!.current).toBe(2);
    expect(book.keys["system.coding"]!.revisions).toHaveLength(2);
  });

  it("base 冲突:不修改 book,回 draft", () => {
    const { book } = bookAtV2();
    const before = JSON.stringify(book);
    const res = saveRevision(book, { key: "system.coding", text: "{{tools}} {{lang}} 冲突稿", baseRevision: 1, origin: "user" }, { at: 3000 });
    expect(res.codes).toEqual([PROMPT_CONFLICT]);
    expect(res.draft).toBe("{{tools}} {{lang}} 冲突稿");
    expect(JSON.stringify(res.book)).toBe(before);
    expect(res.revision).toBeUndefined();
  });

  it("未知 key 与保留名 key 分别报码", () => {
    expect(saveRevision(freshBook(), { key: "nope", text: "x", baseRevision: 1, origin: "user" }).codes).toEqual([PROMPT_UNKNOWN_KEY]);
    expect(saveRevision(freshBook(), { key: "admin.x", text: "x", baseRevision: 1, origin: "user" }).codes).toEqual([PROMPT_RESERVED_NAME]);
  });

  it("placeholder 违规不写", () => {
    const res = saveRevision(freshBook(), { key: "system.coding", text: "没有占位符", baseRevision: 1, origin: "user" });
    expect(res.codes).toEqual([PROMPT_PLACEHOLDER_MISSING]);
    expect(res.book.keys["system.coding"]!.current).toBe(1);
  });

  it("与默认相同且 current=1 → NOOP,不新增 revision", () => {
    const res = saveRevision(freshBook(), { key: "system.coding", text: BUILTINS["system.coding"], baseRevision: 1, origin: "user" });
    expect(res.codes).toEqual([PROMPT_NOOP_SAME_AS_DEFAULT]);
    expect(res.book.keys["system.coding"]!.revisions).toHaveLength(1);
  });

  it("与默认相同且 current>1 → 自动删覆盖,current 回 1,标 PRUNED", () => {
    const { book } = bookAtV2();
    const res = saveRevision(book, { key: "system.coding", text: BUILTINS["system.coding"], baseRevision: 2, origin: "user" });
    expect(res.codes).toEqual([PROMPT_NOOP_SAME_AS_DEFAULT, PROMPT_PRUNED]);
    expect(res.book.keys["system.coding"]!.current).toBe(1);
    expect(resolve(res.book, "system.coding").text).toBe(BUILTINS["system.coding"]);
  });

  it("RSI 无审批 → NEEDS_APPROVAL 且不写", () => {
    const res = saveRevision(freshBook(), { key: "system.coding", text: "{{tools}} {{lang}} rsi", baseRevision: 1, origin: "rsi" });
    expect(res.codes).toEqual([PROMPT_NEEDS_APPROVAL]);
    expect(res.book.keys["system.coding"]!.current).toBe(1);
  });

  it("RSI 带审批 → origin=rsi 落序列", () => {
    const res = saveRevision(
      freshBook(),
      { key: "system.coding", text: "{{tools}} {{lang}} rsi", baseRevision: 1, origin: "rsi", approval: { ok: true, by: "zhq" }, author: "rsi" },
      { at: 5000 },
    );
    expect(res.codes).toEqual([PROMPT_SAVED]);
    expect(res.revision).toMatchObject({ revision: 2, origin: "rsi", timestamp: 5000 });
  });

  it("base 非整数/缺失 → INVALID", () => {
    expect(saveRevision(freshBook(), { key: "system.coding", text: "{{tools}} {{lang}} x", origin: "user" }).codes).toEqual([PROMPT_INVALID]);
    expect(saveRevision(freshBook(), { key: "system.coding", text: "{{tools}} {{lang}} x", baseRevision: 1.5, origin: "user" }).codes).toEqual([PROMPT_INVALID]);
  });

  it("非法 origin(builtin / 未知值)→ INVALID", () => {
    expect(saveRevision(freshBook(), { key: "system.coding", text: "{{tools}} {{lang}} x", baseRevision: 1, origin: "builtin" }).codes).toEqual([PROMPT_INVALID]);
    expect(saveRevision(freshBook(), { key: "system.coding", text: "{{tools}} {{lang}} x", baseRevision: 1, origin: "hacker" }).codes).toEqual([PROMPT_INVALID]);
  });

  it("不改入参 book;连续保存版本号递增", () => {
    const first = freshBook();
    const snapshot = JSON.stringify(first);
    const v2 = bookAtV2(first);
    expect(JSON.stringify(first)).toBe(snapshot);
    const v3 = saveRevision(v2.book, { key: "system.coding", text: "{{tools}} {{lang}} v3", baseRevision: 2, origin: "user" }, { at: 4000 });
    expect(v3.revision!.revision).toBe(3);
    expect(v3.revision!.predecessor).toBe(2);
  });

  it("acceptDefault 之后再保存:版本号取 max+1,不复用历史号", () => {
    const v2 = bookAtV2();
    const v3 = saveRevision(v2.book, { key: "system.coding", text: "{{tools}} {{lang}} v3", baseRevision: 2, origin: "user" }, { at: 3 });
    const accepted = acceptDefault(v3.book, "system.coding");
    expect(accepted.book.keys["system.coding"]!.current).toBe(1);
    const v4 = saveRevision(accepted.book, { key: "system.coding", text: "{{tools}} {{lang}} v4", baseRevision: 1, origin: "user" }, { at: 4 });
    expect(v4.revision).toMatchObject({ revision: 4, predecessor: 1 });
    const numbers = v4.book.keys["system.coding"]!.revisions.map((rev) => rev.revision);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(resolve(v4.book, "system.coding").text).toBe("{{tools}} {{lang}} v4");
  });
});

describe("resolve 与历史回读", () => {
  it("缺省解析 current,可回读任意历史版本", () => {
    const { book } = bookAtV2();
    expect(resolve(book, "system.coding").revision).toBe(2);
    const old = resolve(book, "system.coding", { revision: 1 });
    expect(old.text).toBe(BUILTINS["system.coding"]);
    expect(old.codes).toEqual([PROMPT_RESOLVED]);
  });

  it("不存在的版本 → REVISION_NOT_FOUND", () => {
    expect(resolve(freshBook(), "system.coding", { revision: 9 }).codes).toEqual([PROMPT_REVISION_NOT_FOUND]);
  });

  it("未知 key / 空 key → 对应码", () => {
    expect(resolve(freshBook(), "nope").codes).toEqual([PROMPT_UNKNOWN_KEY]);
    expect(resolve(freshBook(), "").codes).toEqual([PROMPT_INVALID]);
  });
});

describe("会话钉扎", () => {
  it("pinSession 快照每 key current", () => {
    const { book } = bookAtV2();
    const { pins, codes } = pinSession(book, { sessionId: "s1", at: 7000 });
    expect(codes).toEqual([PROMPT_PINNED]);
    expect(pins).toEqual({ sessionId: "s1", createdAt: 7000, revisions: { "system.coding": 2, "user.summary": 1 } });
  });

  it("空 sessionId → INVALID", () => {
    expect(pinSession(freshBook(), { sessionId: "  " }).codes).toEqual([PROMPT_INVALID]);
  });

  it("钉扎后保存 v3:会话仍读 v2,默认读 v3", () => {
    const v2 = bookAtV2();
    const { pins } = pinSession(v2.book, { sessionId: "s1", at: 1 });
    const v3 = saveRevision(v2.book, { key: "system.coding", text: "{{tools}} {{lang}} v3", baseRevision: 2, origin: "user" }, { at: 5 });
    expect(resolveForSession(v3.book, pins, "system.coding")).toMatchObject({ revision: 2, text: v2.text });
    expect(resolve(v3.book, "system.coding").revision).toBe(3);
  });

  it("钉扎里没有该 key → REVISION_NOT_FOUND", () => {
    const { pins } = pinSession(freshBook(), { sessionId: "s1" });
    const book = createBook({ builtins: { ...BUILTINS, "user.new": "n" } }).book;
    expect(resolveForSession(book, pins, "user.new").codes).toEqual([PROMPT_REVISION_NOT_FOUND]);
  });

  it("非法 pins → INVALID", () => {
    expect(resolveForSession(freshBook(), null, "system.coding").codes).toEqual([PROMPT_INVALID]);
    expect(resolveForSession(freshBook(), { sessionId: "s1" }, "system.coding").codes).toEqual([PROMPT_INVALID]);
  });
});

describe("内置升级与两态收敛", () => {
  it("无覆盖时升级 status 保持 active", () => {
    const { book, codes, affected } = updateBuiltin(freshBook(), { key: "system.coding", text: "{{tools}} {{lang}} 新默认", at: 100 });
    expect(codes).toEqual([PROMPT_DEFAULT_UPDATED]);
    expect(affected).toEqual([]);
    expect(book.keys["system.coding"]!.status).toBe("active");
    expect(book.keys["system.coding"]!.builtin).toBe("{{tools}} {{lang}} 新默认");
  });

  it("有覆盖时升级 → default-updated + affected 列出覆盖版本", () => {
    const { book } = bookAtV2();
    const res = updateBuiltin(book, { key: "system.coding", text: "{{tools}} {{lang}} 新默认" });
    expect(res.book.keys["system.coding"]!.status).toBe("default-updated");
    expect(res.affected).toEqual(["system.coding@2"]);
    // 内置升级不混入序列
    expect(res.book.keys["system.coding"]!.revisions).toHaveLength(2);
    expect(res.book.keys["system.coding"]!.current).toBe(2);
  });

  it("内置升级同步 revision 1 快照(可回读)", () => {
    const { book } = bookAtV2();
    const res = updateBuiltin(book, { key: "system.coding", text: "{{tools}} {{lang}} 新默认" });
    expect(resolve(res.book, "system.coding", { revision: 1 }).text).toBe("{{tools}} {{lang}} 新默认");
  });

  it("未知 key / 空文本 → 对应码", () => {
    expect(updateBuiltin(freshBook(), { key: "nope", text: "x" }).codes).toEqual([PROMPT_UNKNOWN_KEY]);
    expect(updateBuiltin(freshBook(), { key: "system.coding", text: "  " }).codes).toEqual([PROMPT_INVALID]);
  });

  it("diffWithDefault 出 add/del/same 行", () => {
    const book = createBook({ builtins: { "system.a": "line1\nline2\nline3" } }).book;
    const v2 = saveRevision(book, { key: "system.a", text: "line1\nmine\nline3", baseRevision: 1, origin: "user" }).book;
    const res = diffWithDefault(v2, "system.a");
    expect(res.same).toBe(false);
    expect(res.lines).toEqual([
      { kind: "same", text: "line1" },
      { kind: "del", text: "mine" },
      { kind: "add", text: "line2" },
      { kind: "same", text: "line3" },
    ]);
  });

  it("diffWithDefault 无覆盖 → same=true", () => {
    const res = diffWithDefault(freshBook(), "user.summary");
    expect(res.same).toBe(true);
    expect(res.lines).toEqual([{ kind: "same", text: BUILTINS["user.summary"] }]);
  });

  it("acceptDefault 回 1 并 active", () => {
    const { book } = bookAtV2();
    const res = acceptDefault(updateBuiltin(book, { key: "system.coding", text: "{{tools}} {{lang}} 新默认" }).book, "system.coding");
    expect(res.codes).toEqual([PROMPT_PRUNED]);
    expect(res.book.keys["system.coding"]!.current).toBe(1);
    expect(res.book.keys["system.coding"]!.status).toBe("active");
    expect(resolve(res.book, "system.coding").text).toBe("{{tools}} {{lang}} 新默认");
  });

  it("keepOverride 保留我的文本,版本号不跳", () => {
    const v2 = bookAtV2();
    const upgraded = updateBuiltin(v2.book, { key: "system.coding", text: "{{tools}} {{lang}} 新默认" }).book;
    const res = keepOverride(upgraded, "system.coding");
    expect(res.codes).toEqual([]);
    expect(res.book.keys["system.coding"]!.status).toBe("active");
    expect(res.book.keys["system.coding"]!.current).toBe(2);
    expect(res.book.keys["system.coding"]!.revisions).toHaveLength(2);
    expect(resolve(res.book, "system.coding").text).toBe(v2.text);
  });

  it("acceptDefault / keepOverride 未知 key → UNKNOWN_KEY", () => {
    expect(acceptDefault(freshBook(), "nope").codes).toEqual([PROMPT_UNKNOWN_KEY]);
    expect(keepOverride(freshBook(), "nope").codes).toEqual([PROMPT_UNKNOWN_KEY]);
  });

  it("pruneRedundant 清掉与默认相同的覆盖", () => {
    const book = createBook({ builtins: { a: "x", b: "y" } }).book;
    const v2 = saveRevision(book, { key: "a", text: "x", baseRevision: 1, origin: "user" });
    // 「与默认相同」的保存会自动收回,这里直接构造残留:用 updateBuiltin 把默认改成覆盖文本
    const residual = updateBuiltin(
      saveRevision(v2.book, { key: "b", text: "b-mine", baseRevision: 1, origin: "user" }).book,
      { key: "b", text: "b-mine" },
    ).book;
    expect(residual.keys["b"]!.current).toBe(2);
    const res = pruneRedundant(residual);
    expect(res.pruned).toEqual(["b"]);
    expect(res.book.keys["b"]!.current).toBe(1);
    expect(res.book.keys["b"]!.status).toBe("active");
  });

  it("promptKeys 排序", () => {
    expect(promptKeys(freshBook())).toEqual(["system.coding", "user.summary"]);
  });
});

describe("平凡输入", () => {
  it("normalizePromptBook 丢弃畸形条目且不 throw", () => {
    const book = normalizePromptBook({
      keys: {
        good: { key: "good", builtin: "g", current: 1, status: "active", revisions: [{ revision: 1, text: "g", predecessor: null, timestamp: 0, origin: "builtin" }] },
        bad: { revisions: [] },
        worse: 42,
      },
    });
    expect(Object.keys(book.keys)).toEqual(["good"]);
    expect(normalizePromptBook(null)).toEqual({ keys: {} });
    expect(normalizePromptBook("x")).toEqual({ keys: {} });
  });

  it("current 指向不存在版本时收敛到最后一版", () => {
    const book = normalizePromptBook({
      keys: {
        k: {
          key: "k",
          builtin: "b",
          current: 99,
          status: "active",
          revisions: [
            { revision: 1, text: "b", predecessor: null, timestamp: 0, origin: "builtin" },
            { revision: 2, text: "c", predecessor: 1, timestamp: 1, origin: "user" },
          ],
        },
      },
    });
    expect(book.keys["k"]!.current).toBe(2);
  });
});
