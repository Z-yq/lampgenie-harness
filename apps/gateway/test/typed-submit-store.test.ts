/**
 * typed submit 台账持久层:.genie/rsi/typed-submits.json 的 open / submit / nudge / report
 * 与整文件原子写(tmp + rename)。每个用例用独立临时根目录,绝不碰仓内 .genie。
 * 稳定码按字面量断言(TYPED_INVALID / TYPED_NOT_FOUND / TYPED_SUBMITTED / TYPED_VIOLATION /
 * TYPED_VALIDATION_FAILED / TYPED_ALREADY_SETTLED),锁的是对外契约而非实现细节。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nudgeTypedSubmit,
  openTypedSubmit,
  readTypedSubmitFile,
  reportTypedSubmits,
  submitTypedSubmit,
  TYPED_SUBMIT_REL,
  typedSubmitPath,
  writeTypedSubmitFile,
} from "../src/typed-submit-store.ts";

const NAME_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string" } },
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "typed-submit-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("typed-submit-store / 路径", () => {
  it("TYPED_SUBMIT_REL 指向 .genie/rsi/typed-submits.json", () => {
    expect(TYPED_SUBMIT_REL).toBe(join(".genie", "rsi", "typed-submits.json"));
  });

  it("typedSubmitPath 拼出根目录下的台账绝对路径", () => {
    expect(typedSubmitPath(root)).toBe(join(root, ".genie", "rsi", "typed-submits.json"));
  });

  it("空根目录读台账返回空 asks,不抛", () => {
    expect(existsSync(typedSubmitPath(root))).toBe(false);
    const file = readTypedSubmitFile(root);
    expect(file.v).toBe(1);
    expect(file.asks).toEqual({});
    expect(() => reportTypedSubmits(root)).not.toThrow();
  });
});

describe("typed-submit-store / open", () => {
  it("首次 open 成功并把 .genie/rsi 目录与台账文件建出来", () => {
    const result = openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    expect(result.ok).toBe(true);
    expect(result.entry?.state.askId).toBe("ask-1");
    expect(result.entry?.state.status).toBe("open");
    expect(result.entry?.state.attempts).toBe(0);
    expect(result.entry?.state.nudged).toBe(false);
    expect(existsSync(typedSubmitPath(root))).toBe(true);
    expect(existsSync(dirname(typedSubmitPath(root)))).toBe(true);
    expect(readTypedSubmitFile(root).asks["ask-1"]?.state.status).toBe("open");
  });

  it("重复 open 同名 ask 被拒:ask-exists + TYPED_INVALID,原状态不变", () => {
    expect(openTypedSubmit(root, "ask-1", NAME_SCHEMA as never).ok).toBe(true);
    const again = openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("ask-exists");
    expect(again.codes).toContain("TYPED_INVALID");
    expect(Object.keys(readTypedSubmitFile(root).asks)).toEqual(["ask-1"]);
  });

  it("空 askId 被拒:TYPED_INVALID", () => {
    const result = openTypedSubmit(root, "   ", NAME_SCHEMA as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ask-id-required");
    expect(result.codes).toContain("TYPED_INVALID");
    expect(existsSync(typedSubmitPath(root))).toBe(false);
  });

  it("schema 缺失被拒:TYPED_INVALID", () => {
    const result = openTypedSubmit(root, "ask-1", null as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("schema-required");
    expect(result.codes).toContain("TYPED_INVALID");
  });
});

describe("typed-submit-store / submit", () => {
  it("缺字段提交:violations 逐字 path=name/expected=string/got=undefined 且 attempts 落盘为 1", () => {
    openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    const result = submitTypedSubmit(root, "ask-1", {});
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("TYPED_VIOLATION");
    expect(result.violations?.[0]).toEqual({ path: "name", expected: "string", got: "undefined" });
    const reread = readTypedSubmitFile(root);
    expect(reread.asks["ask-1"]?.state.status).toBe("open");
    expect(reread.asks["ask-1"]?.state.attempts).toBe(1);
  });

  it("合法提交:settled 且 payload 写进文件", () => {
    openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    const result = submitTypedSubmit(root, "ask-1", { name: "张三" });
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("TYPED_SUBMITTED");
    expect(result.entry?.state.status).toBe("settled");
    const reread = readTypedSubmitFile(root);
    expect(reread.asks["ask-1"]?.state.status).toBe("settled");
    expect(reread.asks["ask-1"]?.state.payload).toEqual({ name: "张三" });
  });

  it("未知 ask 提交被拒:TYPED_NOT_FOUND", () => {
    const result = submitTypedSubmit(root, "ghost", { name: "x" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ask-not-found");
    expect(result.codes).toContain("TYPED_NOT_FOUND");
  });

  it("连续 4 次坏提交:前 3 次仍 open,第 4 次 failed 且两个码同时在", () => {
    openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    const attempts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = submitTypedSubmit(root, "ask-1", {});
      expect(result.ok).toBe(false);
      expect(result.entry?.state.status).toBe("open");
      attempts.push(result.entry?.state.attempts as number);
    }
    expect(attempts).toEqual([1, 2, 3]);
    const fourth = submitTypedSubmit(root, "ask-1", { name: 123 });
    expect(fourth.ok).toBe(false);
    expect(fourth.entry?.state.status).toBe("failed");
    expect(fourth.codes).toContain("TYPED_VIOLATION");
    expect(fourth.codes).toContain("TYPED_VALIDATION_FAILED");
    const reread = readTypedSubmitFile(root);
    expect(reread.asks["ask-1"]?.state.status).toBe("failed");
    expect(reread.asks["ask-1"]?.state.attempts).toBe(4);
  });

  it("已 settled 再提交:TYPED_ALREADY_SETTLED 且 payload 不被覆盖", () => {
    openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    expect(submitTypedSubmit(root, "ask-1", { name: "先到的" }).ok).toBe(true);
    const again = submitTypedSubmit(root, "ask-1", { name: "后来的" });
    expect(again.ok).toBe(false);
    expect(again.codes).toContain("TYPED_ALREADY_SETTLED");
    expect(readTypedSubmitFile(root).asks["ask-1"]?.state.payload).toEqual({ name: "先到的" });
  });
});

describe("typed-submit-store / nudge", () => {
  it("第一次 nudge 成功并带回文案", () => {
    openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    const result = nudgeTypedSubmit(root, "ask-1");
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("TYPED_NUDGED");
    expect(typeof result.message).toBe("string");
    expect((result.message as string).length).toBeGreaterThan(0);
    expect(result.entry?.state.nudged).toBe(true);
  });

  it("第二次 nudge:failed + ok=false", () => {
    openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    expect(nudgeTypedSubmit(root, "ask-1").ok).toBe(true);
    const second = nudgeTypedSubmit(root, "ask-1");
    expect(second.ok).toBe(false);
    expect(second.entry?.state.status).toBe("failed");
    expect(second.codes).toContain("TYPED_VALIDATION_FAILED");
    expect(readTypedSubmitFile(root).asks["ask-1"]?.state.status).toBe("failed");
  });

  it("未知 ask nudge 被拒:TYPED_NOT_FOUND", () => {
    const result = nudgeTypedSubmit(root, "ghost");
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("TYPED_NOT_FOUND");
  });
});

describe("typed-submit-store / 原子写与容错", () => {
  it("open + submit + 4 次坏提交后台账目录无 *.tmp-* 残留且文件是完整 JSON", () => {
    openTypedSubmit(root, "ask-1", NAME_SCHEMA as never);
    submitTypedSubmit(root, "ask-1", {});
    submitTypedSubmit(root, "ask-1", {});
    submitTypedSubmit(root, "ask-1", {});
    submitTypedSubmit(root, "ask-1", {});
    const left = readdirSync(dirname(typedSubmitPath(root)));
    expect(left.filter((name) => name.includes(".tmp-"))).toEqual([]);
    const parsed = JSON.parse(readFileSync(typedSubmitPath(root), "utf8"));
    expect(parsed.v).toBe(1);
    expect(Object.keys(parsed.asks)).toEqual(["ask-1"]);
  });

  it("台账文件损坏时读空台账、report 全 0,不抛", () => {
    mkdirSync(dirname(typedSubmitPath(root)), { recursive: true });
    writeFileSync(typedSubmitPath(root), "{ 这不是 JSON ", "utf8");
    let file: ReturnType<typeof readTypedSubmitFile> | undefined;
    expect(() => {
      file = readTypedSubmitFile(root);
    }).not.toThrow();
    expect(file?.asks).toEqual({});
    const report = reportTypedSubmits(root);
    expect(report.total).toBe(0);
    expect(report.open).toBe(0);
    expect(report.asks).toEqual([]);
  });

  it("writeTypedSubmitFile 返回台账路径且回读一致", () => {
    const state = openTypedSubmit(root, "ask-1", NAME_SCHEMA as never).entry?.state;
    expect(state).toBeDefined();
    const current = readTypedSubmitFile(root);
    current.asks["ask-2"] = { state: { ...state, askId: "ask-2" } as never, schema: NAME_SCHEMA as never };
    const path = writeTypedSubmitFile(root, current);
    expect(path).toBe(typedSubmitPath(root));
    expect(Object.keys(readTypedSubmitFile(root).asks).sort()).toEqual(["ask-1", "ask-2"]);
  });
});

describe("typed-submit-store / report", () => {
  it("两个 ask(settled 1 次 / failed 4 次且 nudged)的聚合计数、次数分布与 askId 升序", () => {
    openTypedSubmit(root, "b-beta", NAME_SCHEMA as never);
    expect(nudgeTypedSubmit(root, "b-beta").ok).toBe(true);
    for (let i = 0; i < 4; i += 1) submitTypedSubmit(root, "b-beta", {});
    openTypedSubmit(root, "a-alpha", NAME_SCHEMA as never);
    submitTypedSubmit(root, "a-alpha", {});
    expect(submitTypedSubmit(root, "a-alpha", { name: "ok" }).ok).toBe(true);

    const report = reportTypedSubmits(root);
    expect(report.total).toBe(2);
    expect(report.open).toBe(0);
    expect(report.settled).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.nudged).toBe(1);
    expect(report.byAttempts["1"]).toBe(1);
    expect(report.byAttempts["4"]).toBe(1);
    expect(report.asks.map((row) => row.askId)).toEqual(["a-alpha", "b-beta"]);
    expect(report.asks[0]).toEqual({ askId: "a-alpha", status: "settled", attempts: 1, nudged: false });
    expect(report.asks[1]).toEqual({ askId: "b-beta", status: "failed", attempts: 4, nudged: true });
  });
});
