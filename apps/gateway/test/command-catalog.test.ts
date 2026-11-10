/**
 * 内置命令目录(2026-10,ZCode「内置命令目录=唯一权威」)单测。
 * 覆盖:面板 25 条现役命令全在目录 / ZCode 补全 5 条 / 保留名拦截自定义同名。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_COMMANDS, RESERVED_COMMAND_NAMES, findBuiltinCommand } from "../src/command-catalog.js";
import { CommandStore } from "../src/commands-store.js";
import { parseClientMessage, ServerMessage } from "@lampgenie/protocol";

/** 面板 SLASH_COMMANDS 现役(原 24 + teamai = 25)+ r3 补 rewind/fork/mode = 28 条入目录断言。 */
const PANEL_COMMAND_NAMES = [
  "newtask", "sense", "review", "test", "wf", "exp", "addproject", "sys", "search", "side",
  "light", "dark", "theme", "theme-sand", "theme-glass", "theme-olive", "theme-plum", "theme-ink",
  "goal", "workflow", "compact", "init", "plan", "team", "teamai",
  "rewind", "fork", "mode",
];

describe("BUILTIN_COMMANDS(ZCode 内置命令目录)", () => {
  it("① 覆盖面板现有 28 条命令名(逐一断言,且都有中文描述)", () => {
    expect(PANEL_COMMAND_NAMES).toHaveLength(28);
    const names = new Set(BUILTIN_COMMANDS.map((c) => c.name));
    for (const name of PANEL_COMMAND_NAMES) {
      expect(names.has(name), `目录缺面板命令: ${name}`).toBe(true);
      const item = findBuiltinCommand(name);
      expect(item?.description.length, `描述为空: ${name}`).toBeGreaterThan(0);
      expect(item?.source).toBe("builtin");
    }
  });

  it("①b 目录无重名(source 恒为 builtin,名字小写无前缀 /)", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of BUILTIN_COMMANDS) {
      expect(c.source).toBe("builtin");
      expect(c.name).toBe(c.name.toLowerCase());
      expect(c.name.startsWith("/")).toBe(false);
    }
  });

  it("② 含 ZCode 补全的 help / skill / model / new / resume", () => {
    for (const name of ["help", "skill", "model", "new", "resume"]) {
      const item = findBuiltinCommand(name);
      expect(item, `目录缺 ZCode 命令: ${name}`).toBeTruthy();
      expect(item?.description.length).toBeGreaterThan(0);
    }
    // new 的别名语义(clear)在描述里写明
    expect(findBuiltinCommand("new")?.description).toContain("clear");
    // help 有用法行
    expect(findBuiltinCommand("help")?.usage).toBe("/help [命令名]");
    // 大小写/斜杠前缀都能查到
    expect(findBuiltinCommand("/HELP")?.name).toBe("help");
  });

  it("RESERVED_COMMAND_NAMES = 内置名全集", () => {
    expect(RESERVED_COMMAND_NAMES.size).toBe(BUILTIN_COMMANDS.length);
    for (const c of BUILTIN_COMMANDS) expect(RESERVED_COMMAND_NAMES.has(c.name)).toBe(true);
  });
});

describe("RESERVED 保留名拦截自定义同名", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gwcat-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("③ 自定义命令与内置同名 → warning 诊断 + 从 custom 列表剔除(内置优先)", () => {
    const dir = join(root, "project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "help.md"), "我自己写的 help", "utf-8");
    writeFileSync(join(dir, "deploy.md"), "部署命令", "utf-8");

    const store = new CommandStore([{ dir, priority: 20, source: "project" }]);
    const outcome = store.listWithDiagnostics();
    expect(outcome.commands.map((c) => c.name)).toEqual(["deploy"]);
    const diag = outcome.diagnostics.find((d) => d.code === "custom_command_reserved_name");
    expect(diag).toBeTruthy();
    expect(diag?.severity).toBe("warning");
    expect(diag?.commandName).toBe("help");
    expect(diag?.message).toContain("内置优先");
    // 只 warning 不报错:list() 正常返回其余命令
    expect(store.list().map((c) => c.name)).toEqual(["deploy"]);
  });

  it("保留名含子目录命名空间时同样拦截(theme:mine 不冲突,theme 冲突被拦)", () => {
    const dir = join(root, "project");
    mkdirSync(join(dir, "theme"), { recursive: true });
    writeFileSync(join(dir, "theme", "mine.md"), "我的主题扩展", "utf-8");
    mkdirSync(join(dir, "model"), { recursive: true });
    writeFileSync(join(dir, "model", "x.md"), "模型扩展", "utf-8");
    const outcome = new CommandStore([{ dir, priority: 20, source: "project" }]).listWithDiagnostics();
    // theme:mine / model:x 都不是内置名 → 保留
    expect(outcome.commands.map((c) => c.name).sort()).toEqual(["model:x", "theme:mine"]);
    expect(outcome.diagnostics).toHaveLength(0);
  });
});

describe("协议主链路(commands.catalog / commands.list.result)", () => {
  it("commands.catalog 请求可解析;catalog/list.result 载荷通过 ServerMessage 校验", () => {
    // 客户端 → 服务端
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "commands.catalog" }))).toMatchObject({
      type: "commands.catalog",
    });

    // 服务端 → 客户端:catalog(纯内置,无 body)
    const catalog = {
      v: 1,
      type: "commands.catalog.result",
      commands: BUILTIN_COMMANDS.map((c) => ({ name: c.name, description: c.description, inputHint: c.inputHint, source: "builtin" })),
    };
    const parsedCatalog = ServerMessage.safeParse(catalog);
    expect(parsedCatalog.success, JSON.stringify(parsedCatalog.error?.issues)).toBe(true);

    // 服务端 → 客户端:list.result(内置在前 + 自定义在后;除 name 全可选)
    const list = {
      v: 1,
      type: "commands.list.result",
      commands: [
        { name: "help", description: "显示命令清单与用法", source: "builtin" },
        { name: "deploy", body: "部署到预发", source: "custom", path: "/x/deploy.md" },
      ],
      diagnostics: [{ path: "/x/help.md", severity: "warning", message: "同名内置,已忽略", code: "custom_command_reserved_name" }],
    };
    const parsedList = ServerMessage.safeParse(list);
    expect(parsedList.success, JSON.stringify(parsedList.error?.issues)).toBe(true);

    // 旧客户端兼容:只有 name + body 的老载荷仍合法
    const legacy = { v: 1, type: "commands.list.result", commands: [{ name: "deploy", body: "x" }] };
    expect(ServerMessage.safeParse(legacy).success).toBe(true);
  });
});
