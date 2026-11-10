/**
 * 桌面 → 远端工具路由(2026-10-27):code_sense / code_review 对 remote 项目
 * 经工作区服务通道调用(不 spawn wsl.exe / ssh 拼命令)。通道用 mock 隔离。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const channelMock = vi.fn();
vi.mock("../src/remote-channel.js", () => ({ tryChannelJson: (...a: unknown[]) => channelMock(...a) }));

import { runRemoteSense } from "../src/sense-tool.js";
import { codeReviewTool } from "../src/agent-wiring.js";
import type { RemoteWslProject } from "../src/remote-project.js";

const remote: RemoteWslProject = { kind: "wsl", distro: "Ubuntu", workspacePath: "/home/u/proj", identity: "remote:wsl:Ubuntu:/home/u/proj" };
const journal = { append: () => ({}) } as unknown as import("@lampgenie/core").Journal;

beforeEach(() => channelMock.mockReset());

describe("code_sense 远端路由", () => {
  it("经通道 sense op 调用,输出带远端标识", async () => {
    channelMock.mockResolvedValue({ ok: true, data: { stdout: "符号详情", stderr: "", exit: 0 } });
    const out = await runRemoteSense(remote, { kind: "structural", action: "symbol", target: "foo" }, "/home/u/proj");
    expect(channelMock).toHaveBeenCalledWith(remote, "sense", { argv: ["symbol", "foo", "--root", "/home/u/proj"] });
    expect(out).toContain("[远端 WSL:Ubuntu]");
    expect(out).toContain("符号详情");
  });

  it("通道未就绪/执行失败 → 明确报错(不静默本地兜底)", async () => {
    channelMock.mockResolvedValue(null);
    expect(await runRemoteSense(remote, { kind: "structural", action: "file", target: "a.ts" }, "/home/u/proj")).toContain("工作区服务未就绪");
    channelMock.mockResolvedValue({ ok: true, data: { stdout: "", stderr: "boom", exit: 2 } });
    expect(await runRemoteSense(remote, { kind: "structural", action: "file", target: "a.ts" }, "/home/u/proj")).toContain("exit 2");
    channelMock.mockResolvedValue({ ok: false, error: "组件未安装" });
    expect(await runRemoteSense(remote, { kind: "structural", action: "file", target: "a.ts" }, "/home/u/proj")).toContain("组件未安装");
  });
});

describe("code_review 远端路由", () => {
  it("经通道 review op 调用并渲染 findings(标注未跑 LLM 深审)", async () => {
    channelMock.mockResolvedValue({
      ok: true,
      data: {
        stdout: JSON.stringify({
          summary: "确定性+反模式检查(1+0 条)",
          findings: [{ severity: "warning", file: "src/a.ts", line: 3, title: "空 catch", detail: "静默吞错" }],
        }),
        stderr: "",
        exit: 0,
      },
    });
    const tool = codeReviewTool("/home/u/proj", undefined, journal, "s1", undefined, null, remote);
    const out = String(await tool.execute({}));
    expect(channelMock).toHaveBeenCalledWith(remote, "review", { target: undefined, timeout: 300_000 });
    expect(out).toContain("[远端 WSL:Ubuntu]");
    expect(out).toContain("[warning] src/a.ts:3 空 catch");
    expect(out).toContain("LLM 深审需远端凭证,未运行");
  });

  it("通道不可用 → 明确报错", async () => {
    channelMock.mockResolvedValue(null);
    const tool = codeReviewTool("/home/u/proj", undefined, journal, "s1", undefined, null, remote);
    expect(String(await tool.execute({}))).toContain("工作区服务未就绪");
  });
});
