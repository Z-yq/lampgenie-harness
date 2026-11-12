// Git 面板同步操作面静态断言:推送/拉取按钮+勾选文件提交+git.ok 回显。
// panel.ts 是 26k 行内联脚本大文件,按既有 panel-script-syntax 模式做源码级契约锚。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANEL_SRC } from "./panel-source.js";

const src = PANEL_SRC;

describe("Git 面板同步操作面", () => {
  it("git-bar 有拉取/推送按钮且接线 git.pull/git.push", () => {
    expect(src).toContain('id="gitPullBtn"');
    expect(src).toContain('id="gitPushBtn"');
    expect(src).toContain('type: "git.pull"');
    expect(src).toContain('type: "git.push"');
  });
  it("变更行有勾选框;提交按钮按勾选集切换语义并发 files 参数", () => {
    expect(src).toContain('class="git-pick"');
    expect(src).toContain("gitPickedFiles");
    expect(src).toContain("提交选中(");
    expect(src).toMatch(/type: "git\.commit", message: msg, \.\.\.\(picked\.length \? \{ files: picked \} : \{\}\)/);
  });
  it("git.ok 对 commit/checkout/push/pull 回显服务端 detail", () => {
    expect(src).toContain('["commit", "checkout", "push", "pull"].includes(String(m.op))');
  });
  it("勾选不触发 diff(checkbox stopPropagation)", () => {
    expect(src).toMatch(/box\.onclick = \(ev\) => \{ ev\.stopPropagation\(\); gitCommitLabel\(\); \}/);
  });
});

describe("团队页全项目渲染(projectTeams)", () => {
  it("team.status.result 存 projectTeams;renderTeam 逐项目出卡;旧网关回退单卡", () => {
    expect(src).toContain("lastProjectTeams = m.projectTeams || null");
    expect(src).toContain("function renderTeam(orgs, projectTeam, projectTeams)");
    expect(src).toContain("(Array.isArray(projectTeams) && projectTeams.length) ? projectTeams : (projectTeam && projectTeam.label ? [projectTeam] : [])");
    expect(src).toContain("非 git 目录/无 origin");
  });
});

describe("看板子标签身份保护(画布形态)", () => {
  it("CanvasShell onFocus 不把 dash/issues 身份洗回 team(否则 viewLive 恒假=看板永久空板)", () => {
    expect(src).toMatch(/if \(view === "team" && \(mainView === "dash" \|\| mainView === "issues"\)\) return;/);
  });
});
