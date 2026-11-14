/**
 * 提示词版本运行时消费( #209 运行面; v2 会话钉扎)。
 * 钉住:无书/坏书 → 回退内置;revision 1(builtin 快照)不覆盖;revision>1 的显式覆盖生效;
 * 空文本/超长守卫;保存后下一次解析立即生效(同任务内由调用点保证稳定)。
 * v2:同会话按 pins.json 的首钉版本解析——中途保存的新版只影响新会话;钉住的版本被 prune 后回落 current。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initBook, promptBookPath, promptPinsPath, saveRevision } from "../src/prompt-version-store.js";
import { MAX_PROMPT_OVERRIDE_CHARS, resolvePromptForSessionSync, resolvePromptOverrideSync } from "../src/prompt-runtime.js";

describe("resolvePromptOverrideSync", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "prompt-runtime-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("无 book / 坏 book → undefined(回退内置常量)", async () => {
    expect(resolvePromptOverrideSync(root, "system.coding")).toBeUndefined();
    const book = await initBook(root, { builtins: { "system.coding": "BASE" } });
    expect(book.ok).toBe(true);
    expect(resolvePromptOverrideSync(root, "system.coding")).toBeUndefined(); // revision 1 不覆盖
    await writeFile(promptBookPath(root), "{ broken", "utf8");
    expect(resolvePromptOverrideSync(root, "system.coding")).toBeUndefined();
  });

  it("revision>1 的显式覆盖生效;其它 key 仍回退", async () => {
    await initBook(root, { builtins: { "system.coding": "BASE", "system.coding.lite": "LITE" } });
    const saved = await saveRevision(root, {
      key: "system.coding",
      text: "CUSTOM PROMPT",
      baseRevision: 1,
      origin: "user",
    });
    expect(saved.ok).toBe(true);
    expect(saved.revision?.revision).toBe(2);
    expect(resolvePromptOverrideSync(root, "system.coding")).toBe("CUSTOM PROMPT");
    expect(resolvePromptOverrideSync(root, "system.coding.lite")).toBeUndefined();
  });

  it("覆盖文本超长 → undefined(不把异常文本灌进系统提示)", async () => {
    await initBook(root, { builtins: { "system.coding": "BASE" } });
    const saved = await saveRevision(root, {
      key: "system.coding",
      text: "x".repeat(MAX_PROMPT_OVERRIDE_CHARS + 1),
      baseRevision: 1,
      origin: "user",
    });
 // 保存侧可能有自己的长度上限:无论保存成功与否,解析侧都必须拒绝超长。
    if (saved.ok) expect(resolvePromptOverrideSync(root, "system.coding")).toBeUndefined();
    else expect(saved.codes.length).toBeGreaterThan(0);
  });
});

describe("resolvePromptForSessionSync(v2 会话钉扎)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "prompt-pin-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedOverride(text: string): Promise<void> {
    const loaded = JSON.parse(await readFile(promptBookPath(root), "utf8")) as { keys: Record<string, { current: number }> };
    await saveRevision(root, {
      key: "system.coding",
      text,
      baseRevision: loaded.keys["system.coding"]?.current ?? 1,
      origin: "user",
    });
  }

  it("首解析落钉;之后保存新版,同会话仍拿旧版、新会话拿新版", async () => {
    await initBook(root, { builtins: { "system.coding": "BASE" } });
    await seedOverride("REV2 TEXT");
 // 会话 s1 首次解析 → 拿 rev2 并落钉
    expect(resolvePromptForSessionSync(root, "s1", "system.coding")).toBe("REV2 TEXT");
    const pins = JSON.parse(await readFile(promptPinsPath(root), "utf8")) as {
      sessions: Record<string, { revisions: Record<string, number> }>;
    };
    expect(pins.sessions["s1"]?.revisions["system.coding"]).toBe(2);
 // 中途保存 rev3:同会话 s1 仍拿 rev2(不被切轴);新会话 s2 拿 rev3
    await seedOverride("REV3 TEXT");
    expect(resolvePromptForSessionSync(root, "s1", "system.coding")).toBe("REV2 TEXT");
    expect(resolvePromptForSessionSync(root, "s2", "system.coding")).toBe("REV3 TEXT");
  });

  it("无覆盖时不落钉(内置常量进程内天然稳定);覆盖出现后该会话下一次解析才钉", async () => {
    await initBook(root, { builtins: { "system.coding": "BASE" } });
    expect(resolvePromptForSessionSync(root, "s1", "system.coding")).toBeUndefined();
    await expect(readFile(promptPinsPath(root), "utf8")).rejects.toThrow(); // 未写钉文件
    await seedOverride("LATER REV");
    expect(resolvePromptForSessionSync(root, "s1", "system.coding")).toBe("LATER REV");
    const pins = JSON.parse(await readFile(promptPinsPath(root), "utf8")) as {
      sessions: Record<string, { revisions: Record<string, number> }>;
    };
    expect(pins.sessions["s1"]?.revisions["system.coding"]).toBe(2);
  });

  it("钉住的 revision 被 prune/消失 → 回落 current 并刷新钉(不留死轴)", async () => {
    await initBook(root, { builtins: { "system.coding": "BASE" } });
    await seedOverride("REV2 TEXT");
    expect(resolvePromptForSessionSync(root, "s1", "system.coding")).toBe("REV2 TEXT");
    await seedOverride("REV3 TEXT");
 // 手工把钉指向一个不存在的 revision 9:解析应回落 current(rev3)并刷新钉
    const pins = JSON.parse(await readFile(promptPinsPath(root), "utf8")) as {
      sessions: Record<string, { revisions: Record<string, number> }>;
    };
    pins.sessions["s1"]!.revisions["system.coding"] = 9;
    await writeFile(promptPinsPath(root), JSON.stringify(pins), "utf8");
    expect(resolvePromptForSessionSync(root, "s1", "system.coding")).toBe("REV3 TEXT");
    const refreshed = JSON.parse(await readFile(promptPinsPath(root), "utf8")) as {
      sessions: Record<string, { revisions: Record<string, number> }>;
    };
    expect(refreshed.sessions["s1"]?.revisions["system.coding"]).toBe(3);
  });

  it("空 sessionId → 读最新(兼容旧调用方);坏 pins 文件 → 当空表,首钉重建", async () => {
    await initBook(root, { builtins: { "system.coding": "BASE" } });
    await seedOverride("REV2 TEXT");
    expect(resolvePromptForSessionSync(root, "", "system.coding")).toBe("REV2 TEXT");
    await writeFile(promptPinsPath(root), "{ broken", "utf8");
    expect(resolvePromptForSessionSync(root, "s9", "system.coding")).toBe("REV2 TEXT");
    const pins = JSON.parse(await readFile(promptPinsPath(root), "utf8")) as {
      sessions: Record<string, { revisions: Record<string, number> }>;
    };
    expect(pins.sessions["s9"]?.revisions["system.coding"]).toBe(2);
  });
});
